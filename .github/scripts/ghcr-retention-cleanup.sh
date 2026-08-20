#!/usr/bin/env bash
#
# Enforce the GHCR retention policy for the meeet runner and artifact-compiler
# images. See docs/application-deployment.md "GHCR image retention".
#
# Policy:
#   - Per branch (main, dev, feature/*): keep the latest KEEP_PER_BRANCH
#     versions whose sha-<full-sha> tag names a commit that is an ancestor of
#     that branch. A version is kept when it is within the retention window of
#     any branch it belongs to.
#   - Release tags (v*): kept indefinitely.
#   - Untagged versions are deleted unless protected.
#   - Versions whose commit is not an ancestor of any current branch (deleted
#     or force-pushed branches) are deleted.
#   - PROTECTED_DIGESTS mirrors the digest-pinned images in the operator-owned
#     runtime .env; listed digests are never deleted. The run aborts
#     (fail-closed) when the variable is missing or malformed.
#
# Environment:
#   GHCR_OWNER         GHCR owner (lowercased by the script; default: owner of
#                      GITHUB_REPOSITORY, i.e. the repository owner in Actions)
#   PACKAGES           space-separated package names (default: meeet meeet-artifact-compiler)
#   KEEP_PER_BRANCH    versions kept per branch (default: 5)
#   PROTECTED_DIGESTS  required; newline- or space-separated sha256:<hex> digests
#   DRY_RUN            "true" prints the plan without deleting (default: true)
#
# Requires gh with a token that has packages: write and admin role on the
# packages; the GITHUB_TOKEN of the publishing repository has both.

set -euo pipefail

GHCR_OWNER="$(printf '%s' "${GHCR_OWNER:-${GITHUB_REPOSITORY:-}}" | tr '[:upper:]' '[:lower:]')"
PACKAGES="${PACKAGES:-meeet meeet-artifact-compiler}"
KEEP_PER_BRANCH="${KEEP_PER_BRANCH:-5}"
DRY_RUN="${DRY_RUN:-true}"

die() { echo "error: $*" >&2; exit 1; }

validate_inputs() {
  [[ -n "$GHCR_OWNER" ]] || die "GHCR_OWNER is empty"
  [[ "$KEEP_PER_BRANCH" =~ ^[0-9]+$ ]] || die "KEEP_PER_BRANCH must be a positive integer, got '$KEEP_PER_BRANCH'"
  (( KEEP_PER_BRANCH >= 1 )) || die "KEEP_PER_BRANCH must be at least 1"

  # Production safety guard: the protected digest list mirrors the digest-pinned
  # images in the operator-owned runtime .env. Fail closed when it is missing
  # or malformed so cleanup can never run without the guard.
  PROTECTED=()
  while IFS= read -r d; do
    [[ -n "$d" ]] && PROTECTED+=("$d")
  done < <(printf '%s\n' "${PROTECTED_DIGESTS:-}" | tr ' ' '\n')
  (( ${#PROTECTED[@]} > 0 )) || die "PROTECTED_DIGESTS is empty; set the GHCR_PROTECTED_DIGESTS repository variable to the digest pair of the runtime .env"
  for d in "${PROTECTED[@]}"; do
    [[ "$d" =~ ^sha256:[0-9a-f]{64}$ ]] || die "malformed protected digest '$d' (expected sha256:<64 hex>)"
  done
}

fetch_refs() {
  # Complete fetch of every branch and tag with full history. A commit is
  # treated as unreachable only when this fetch succeeded, so a fetch failure
  # aborts the run instead of risking over-deletion.
  git fetch --prune origin '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'
  git rev-parse --verify origin/main >/dev/null || die "origin/main not found after fetch"
  git rev-parse --verify origin/dev >/dev/null || die "origin/dev not found after fetch"

  BRANCHES=()
  while IFS= read -r ref; do
    branch="${ref#refs/remotes/origin/}"
    case "$branch" in
      main | dev | feature/*) BRANCHES+=("$branch") ;;
    esac
  done < <(git for-each-ref --format='%(refname)' refs/remotes/origin)
  (( ${#BRANCHES[@]} > 0 )) || die "no publication branches found"
}

fetch_versions() {
  local pkg="$1"
  gh api --paginate -q '.[]' "/user/packages/container/$pkg/versions?per_page=100"
}

# classify reads one version object per line on stdin and prints one plan line
# per version: id<TAB>digest<TAB>decision<TAB>reason
classify() {
  local line id digest created tags sha branches
  local -A keep=()
  local -A reasons=()
  local -A commits=()
  local -A digest_of=()
  local -A created_of=()
  local -A branch_of=()

  # Pass 1: annotate every version.
  while IFS= read -r line; do
    id=$(jq -r '.id' <<<"$line")
    digest=$(jq -r '.name' <<<"$line")
    created=$(jq -r '.created_at' <<<"$line")
    tags=$(jq -r '.metadata.container.tags | join(",")' <<<"$line")
    digest_of[$id]="$digest"

    # Production guard and release handling first.
    if [[ " ${PROTECTED[*]} " == *" $digest "* ]]; then
      keep[$id]=1
      reasons[$id]="protected digest"
      continue
    fi
    for t in $(printf '%s' "$tags" | tr ',' ' '); do
      if [[ "$t" == v* ]]; then
        keep[$id]=1
        reasons[$id]="release tag"
        continue 2
      fi
    done

    # Collect every sha-<full-sha> tag; a version is attributed to a branch
    # when any of its commits is an ancestor of that branch.
    shas=()
    IFS=',' read -r -a tag_arr <<<"$tags"
    for t in "${tag_arr[@]}"; do
      if [[ "$t" =~ ^sha-([0-9a-f]{40})$ ]]; then
        shas+=("${BASH_REMATCH[1]}")
      fi
    done

    if (( ${#shas[@]} == 0 )); then
      if [[ -z "$tags" ]]; then
        keep[$id]=0
        reasons[$id]="untagged"
      else
        keep[$id]=1
        reasons[$id]="tagged without sha tag"
      fi
      continue
    fi

    branches=""
    reachable=0
    for sha in "${shas[@]}"; do
      if git cat-file -e "$sha^{commit}" 2>/dev/null; then
        reachable=1
        for b in "${BRANCHES[@]}"; do
          if git merge-base --is-ancestor "$sha" "origin/$b" 2>/dev/null; then
            branches="$branches $b"
          fi
        done
      fi
    done
    if (( reachable == 0 )); then
      keep[$id]=0
      reasons[$id]="commit unreachable"
      continue
    fi
    if [[ -z "$branches" ]]; then
      keep[$id]=0
      reasons[$id]="not on any branch"
      continue
    fi
    commits[$id]="$sha"
    created_of[$id]="$created"
    branch_of[$id]="$branches"
    keep[$id]=2 # deferred to pass 2 (per-branch retention ranking)
  done

  # Pass 2: per-branch retention. For each branch, keep the KEEP_PER_BRANCH
  # most recently created versions whose commit is an ancestor of the branch.
  local -A kept_by_branch=()
  local -a ranked=()
  local entry n
  for b in "${BRANCHES[@]}"; do
    ranked=()
    for id in "${!commits[@]}"; do
      if [[ " ${branch_of[$id]} " == *" $b "* ]]; then
        ranked+=("${created_of[$id]}"$'\t'"$id")
      fi
    done
    if (( ${#ranked[@]} > 0 )); then
      mapfile -t ranked < <(printf '%s\n' "${ranked[@]}" | sort -r)
      n=0
      for entry in "${ranked[@]}"; do
        (( n < KEEP_PER_BRANCH )) || break
        kept_by_branch[${entry#*$'\t'}]=1
        n=$((n + 1))
      done
    fi
  done

  # Pass 3: decisions and plan output.
  for id in "${!keep[@]}"; do
    if (( keep[$id] == 2 )); then
      if [[ -n "${kept_by_branch[$id]:-}" ]]; then
        keep[$id]=1
        reasons[$id]="within retention of branch(es):${branch_of[$id]}"
      else
        keep[$id]=0
        reasons[$id]="beyond retention"
      fi
    fi
    if (( keep[$id] == 1 )); then
      printf '%s\t%s\t%s\t%s\n' "$id" "${digest_of[$id]}" "keep" "${reasons[$id]}"
    else
      printf '%s\t%s\t%s\t%s\n' "$id" "${digest_of[$id]}" "delete" "${reasons[$id]}"
    fi
  done
}

main() {
  validate_inputs
  fetch_refs

  echo "GHCR retention cleanup"
  echo "  owner: $GHCR_OWNER"
  echo "  packages: $PACKAGES"
  echo "  keep per branch: $KEEP_PER_BRANCH"
  echo "  dry run: $DRY_RUN"
  echo "  protected digests: ${PROTECTED[*]}"
  echo "  branches: ${BRANCHES[*]}"
  echo

  local pkg id digest decision reason
  local -a to_delete=()
  local failures=0
  CLEANUP_TMP="$(mktemp -d)"
  trap 'rm -rf "$CLEANUP_TMP"' EXIT

  for pkg in $PACKAGES; do
    echo "== package $pkg =="
    fetch_versions "$pkg" >"$CLEANUP_TMP/$pkg.jsonl" || die "failed to list versions of $pkg"
    classify <"$CLEANUP_TMP/$pkg.jsonl" >"$CLEANUP_TMP/$pkg.plan"
    printf '%-10s %-71s %-8s %s\n' "id" "digest" "decision" "reason"
    while IFS=$'\t' read -r id digest decision reason; do
      printf '%-10s %-71s %-8s %s\n' "$id" "$digest" "$decision" "$reason"
      if [[ "$decision" == "delete" ]]; then
        to_delete+=("$pkg:$id")
      fi
    done <"$CLEANUP_TMP/$pkg.plan"
    echo
  done

  echo "== deletion plan =="
  if (( ${#to_delete[@]} == 0 )); then
    echo "nothing to delete"
  else
    printf '%s\n' "${to_delete[@]}"
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "dry run: no deletions performed"
    return 0
  fi

  for entry in "${to_delete[@]}"; do
    pkg="${entry%%:*}"
    id="${entry#*:}"
    if gh api -X DELETE "/user/packages/container/$pkg/versions/$id" >/dev/null 2>&1; then
      echo "deleted $pkg version $id"
    else
      echo "warning: failed to delete $pkg version $id (permissions, or >5000 downloads on a public package)" >&2
      failures=$((failures + 1))
    fi
  done
  (( failures == 0 )) || die "$failures deletion(s) failed"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
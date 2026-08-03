#!/bin/sh
set -eu

manifest=/run/meeet-routing/manifest.json
attestation=/run/meeet-routing/deployment-attestation.json
identity=/run/meeet-routing/runtime-identity.env
lock_file="${MEEET_ROUTING_VERIFY_LOCK:-/run/meeet-routing/graphhopper-runtime.files.sha256}"

normalize_digest() {
  case "$1" in
    sha256:*) hex=${1#sha256:} ;;
    *) hex=$1 ;;
  esac
  if [ "${#hex}" -ne 64 ]; then
    echo "routing digest must contain 64 lowercase hex characters" >&2
    exit 1
  fi
  case "$hex" in
    *[!0-9a-f]*|'') echo "routing digest must contain 64 lowercase hex characters" >&2; exit 1 ;;
  esac
  printf 'sha256:%s' "$hex"
}

sha256_file() {
  value=$(sha256sum "$1")
  printf '%s' "${value%% *}"
}

image_digest() {
  case "$1" in
    *@sha256:*) normalize_digest "${1##*@}" ;;
    *) echo "runtime image must be repository@sha256:<64 lowercase hex>" >&2; exit 1 ;;
  esac
}

# Import is the producer of the immutable artifact.  Runtime and verifier
# lifecycles alone consume the mounted manifest, attestation, identity, lock,
# config, profiles, and graph artifact immediately before serving.
if [ "${1:-}" = "import" ]; then
  exec java -jar /opt/graphhopper/graphhopper-web.jar "$@"
fi

test -r "$manifest"
test -r "$attestation"
test -r "$identity"
test -r "$lock_file"
expected_manifest_sha256="${ROUTING_MANIFEST_SHA256:?ROUTING_MANIFEST_SHA256 is required}"
expected_attestation_sha256="${ROUTING_ATTESTATION_SHA256:?ROUTING_ATTESTATION_SHA256 is required}"
expected_identity_sha256="${ROUTING_RUNTIME_IDENTITY_SHA256:?ROUTING_RUNTIME_IDENTITY_SHA256 is required}"
expected_lock_sha256="${GRAPHHOPPER_RUNTIME_LOCK_SHA256:?GRAPHHOPPER_RUNTIME_LOCK_SHA256 is required}"
image_ref="${GRAPHHOPPER_IMAGE_REF:?GRAPHHOPPER_IMAGE_REF is required}"
image_digest_value="${GRAPHHOPPER_IMAGE_DIGEST:?GRAPHHOPPER_IMAGE_DIGEST is required}"

test "$(sha256_file "$manifest")" = "$expected_manifest_sha256"
test "$(sha256_file "$attestation")" = "$expected_attestation_sha256"
test "$(sha256_file "$identity")" = "$expected_identity_sha256"
test "$(sha256_file "$lock_file")" = "$expected_lock_sha256"
sha256sum --check "$lock_file"

. "$identity"
test "$ROUTING_IDENTITY_MANIFEST_SHA256" = "$expected_manifest_sha256"
test "$ROUTING_IDENTITY_GRAPHHOPPER_IMAGE" = "$image_ref"
test "$(image_digest "$image_ref")" = "$(normalize_digest "$image_digest_value")"
test "$ROUTING_IDENTITY_BIKE_PROFILE" = "bike"
test "$ROUTING_IDENTITY_CAR_PROFILE" = "car"
test -n "$ROUTING_IDENTITY_CONFIG_SHA256"
test -n "$ROUTING_IDENTITY_GRAPHHOPPER_GRAPH_SHA256"
test "$ROUTING_IDENTITY_GRAPHHOPPER_RELEASE" = "10.2"
case "$ROUTING_IDENTITY_GRAPHHOPPER_IMAGE_ID" in sha256:????????????????????????????????????????????????????????????????) ;; *) exit 1 ;; esac
if [ "${#ROUTING_IDENTITY_GRAPHHOPPER_REVISION}" -ne 40 ]; then exit 1; fi
case "$ROUTING_IDENTITY_GRAPHHOPPER_REVISION" in *[!0-9a-f]*|'') exit 1 ;; esac

if [ "${1:-}" = "verify-only" ]; then
  exit 0
fi

exec java -jar /opt/graphhopper/graphhopper-web.jar "$@"

#!/bin/sh
set -eu

manifest=/run/meeet-routing/manifest.json
attestation=/run/meeet-routing/deployment-attestation.json
identity=/run/meeet-routing/runtime-identity.env
lock_file="${MEEET_ROUTING_VERIFY_LOCK:-/run/meeet-routing/otp-runtime.files.sha256}"

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

test -r "$manifest"
test -r "$attestation"
test -r "$identity"
test -r "$lock_file"
expected_manifest_sha256="${ROUTING_MANIFEST_SHA256:?ROUTING_MANIFEST_SHA256 is required}"
expected_attestation_sha256="${ROUTING_ATTESTATION_SHA256:?ROUTING_ATTESTATION_SHA256 is required}"
expected_identity_sha256="${ROUTING_RUNTIME_IDENTITY_SHA256:?ROUTING_RUNTIME_IDENTITY_SHA256 is required}"
expected_lock_sha256="${OTP_RUNTIME_LOCK_SHA256:?OTP_RUNTIME_LOCK_SHA256 is required}"
image_ref="${OTP_IMAGE_REF:?OTP_IMAGE_REF is required}"
image_digest_value="${OTP_IMAGE_DIGEST:?OTP_IMAGE_DIGEST is required}"

test "$(sha256_file "$manifest")" = "$expected_manifest_sha256"
test "$(sha256_file "$attestation")" = "$expected_attestation_sha256"
test "$(sha256_file "$identity")" = "$expected_identity_sha256"
test "$(sha256_file "$lock_file")" = "$expected_lock_sha256"
sha256sum --check "$lock_file"

# This file is itself covered by the runtime lock.  It binds the mounted
# manifest, attestation, graph, config, profile, and inspected image identity
# to the values supplied by the generated runtime environment.
. "$identity"
test "$ROUTING_IDENTITY_MANIFEST_SHA256" = "$expected_manifest_sha256"
test "$ROUTING_IDENTITY_OTP_IMAGE" = "$image_ref"
test "$(image_digest "$image_ref")" = "$(normalize_digest "$image_digest_value")"
test "$ROUTING_IDENTITY_OTP_PROFILE" = "TRANSIT,WALK"
test -n "$ROUTING_IDENTITY_CONFIG_SHA256"
test -n "$ROUTING_IDENTITY_OTP_GRAPH_SHA256"
test "$ROUTING_IDENTITY_OTP_RELEASE" = "2.6.0"
case "$ROUTING_IDENTITY_OTP_IMAGE_ID" in sha256:????????????????????????????????????????????????????????????????) ;; *) exit 1 ;; esac
if [ "${#ROUTING_IDENTITY_OTP_REVISION}" -ne 40 ]; then exit 1; fi
case "$ROUTING_IDENTITY_OTP_REVISION" in *[!0-9a-f]*|'') exit 1 ;; esac

# The pinned OTP image places the shaded application at /app/otp.jar.  No
# readiness utility is executed inside the image; readiness is checked by the
# project-owned host-side actuator probe.
exec java -jar "${OTP_JAR_PATH:-/app/otp.jar}" "$@"

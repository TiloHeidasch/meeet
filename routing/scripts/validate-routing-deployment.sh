#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

python3 routing/scripts/validate-routing-config.py --root "$root"
python3 routing/scripts/validate-routing-manifest.py \
  --fixture routing/manifest/canonical-output.fixture.json
if [ -n "${ROUTING_MANIFEST_PATH:-}" ]; then
  attestation_path=${ROUTING_ATTESTATION_PATH:-$(dirname "$ROUTING_MANIFEST_PATH")/deployment-attestation.json}
  python3 routing/scripts/validate-routing-manifest.py \
    --fixture routing/manifest/canonical-output.fixture.json \
    --manifest "$ROUTING_MANIFEST_PATH" \
    --attestation "$attestation_path"
fi
env_file=${ROUTING_COMPOSE_ENV_FILE:-routing/graphhopper/versions.env.example}
case "$env_file" in
  *.example) allow_placeholders=true ;;
  *) allow_placeholders=${ROUTING_ALLOW_ENV_PLACEHOLDERS:-false} ;;
esac
if [ "$allow_placeholders" = "true" ]; then
  python3 routing/scripts/validate-routing-env.py --allow-placeholders "$env_file"
else
  python3 routing/scripts/validate-routing-env.py "$env_file"
fi

if command -v docker >/dev/null 2>&1; then
  docker compose --env-file "$env_file" -f docker-compose.routing.yml config --quiet
  echo "Docker Compose configuration validated."
else
  echo "Docker Compose validation skipped: docker executable is unavailable." >&2
  echo "Static JSON/YAML/profile validation passed; image, interpolation, mount, and command validation remain external gates." >&2
fi

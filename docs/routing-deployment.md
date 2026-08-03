# Local routing deployment

This lane provides a local/self-hosted routing foundation. It does not alter
application source, calculation code, provider selection, or UI behaviour.
Both engines are plain HTTP services for local/internal use only.

## Fixed engines and authority

| Engine | Fixed identity | Lifecycle |
| --- | --- | --- |
| OpenTripPlanner | OTP 2.6 image supplied through required `OTP_IMAGE`, including `@sha256:<digest>` | Immutable graph build, then read-only runtime |
| GraphHopper | Upstream `graphhopper/graphhopper` release `10.2`, checked out at a manifest-supplied commit | Project-owned source image, one-shot import, then read-only runtime |

`OTP_IMAGE` has no tag-only fallback. A deployment must provide the exact
`repository@sha256:<64 lowercase hex>` image reference. Bare `sha256:<digest>`
and bare 64-hex values are accepted only for digest fields and are normalized
before comparison. The generator and verifier also require the loaded image's
OCI release and 40-hex revision labels to match the pinned release/artifact.
The GraphHopper build likewise requires a verified source commit and
digest-qualified Debian/Ubuntu Maven/JDK and JRE base images.

The OTP templates use the Munich/MVV area and MVV feed ID `mvv`. MVV is
authoritative for schedule data. MVG is a separate metadata-enrichment input
and realtime provenance; the raw MVV feed does not silently incorporate MVG
enrichment. This deployment lane applies neither MVG enrichment nor realtime
overlays, so generated manifests must keep both transformations unapplied and
cannot claim live routing.

## Versioned storage and directory preparation

Run from the repository root:

```sh
mkdir -p \
  routing/inputs/versions/INPUT_VERSION/{feeds,metadata,realtime,osm} \
  routing/manifest/versions \
  routing/otp/data/graphs/versions \
  routing/otp/data/logs \
  routing/graphhopper/data/artifacts/versions \
  routing/graphhopper/data/logs
cp routing/manifest/input-inventory.example.json routing/manifest/input-inventory.json
cp routing/graphhopper/versions.env.example routing/graphhopper/versions.env
chmod 600 routing/manifest/input-inventory.json routing/graphhopper/versions.env
set -a
. routing/graphhopper/versions.env
set +a
```

Replace `INPUT_VERSION` with an immutable operator-chosen identifier and edit
the inventory and `versions.env`. Place these untracked inputs under that
versioned directory:

```text
routing/inputs/versions/INPUT_VERSION/feeds/mvv.zip
routing/inputs/versions/INPUT_VERSION/metadata/mvg.json
routing/inputs/versions/INPUT_VERSION/realtime/realtime.json
routing/inputs/versions/INPUT_VERSION/osm/munich.osm.pbf
```

The inventory also records the official boundary, its generated access
envelope, source metadata, licenses, and timestamps. Do not put credentials,
feed archives, PBFs, generated graphs, or generated manifests in Git.
The GraphHopper image runs as UID/GID `10001`; its versioned artifact parent
and log directory must be writable by that identity on hosts that enforce bind
mount ownership. OTP's graph and log directories must likewise be writable by
the user in the pinned OTP image.

## Official 15km access envelope

Generate and verify the canonical EPSG:25832 metric buffer from the tracked
official Munich application boundary. This stage requires the reproducible
tool dependencies in `routing/scripts/requirements-envelope.txt`; absence of
Shapely or pyproj is a hard verification failure. It intentionally does not
substitute a bounding box:

```sh
python3 -c 'import shapely, pyproj; print(shapely.__version__, pyproj.__version__)'
python3 routing/scripts/munich-access-envelope.py generate \
  --boundary data/official/munich-districts.json \
  --output routing/inputs/versions/INPUT_VERSION/munich-access-envelope-15km.geojson
python3 routing/scripts/munich-access-envelope.py verify \
  --boundary data/official/munich-districts.json \
  --envelope routing/inputs/versions/INPUT_VERSION/munich-access-envelope-15km.geojson
```

The generated polygon artifact declares EPSG:25832, carries the boundary
SHA-256 and a required `radiusMeters: 15000` property. Verification recomputes
the projected buffer and compares the canonical polygon geometry, not merely
its bounds. The manifest hashes both the official boundary and this derived
envelope.

## Template validation and GraphHopper model workflow

The validator checks the OTP 2.6 allow-list used here, including
`transitFeeds` entries with `type: gtfs`, the explicit `/var/opentripplanner`
paths, and only the verified nested `routingDefaults` speed/transfer fields.
It rejects the obsolete `transit` build key and unknown router fields. It also
checks wiring dependencies from the car/bike custom models
and rejects an import configuration whose `graph.encoded_values` omits one.
This is only a wiring check; generic model parsing does not certify GraphHopper
profile encoded values. The successful pinned import below is the required
validation.

```sh
python3 routing/scripts/validate-routing-config.py
sh routing/scripts/validate-routing-deployment.sh
```

The GraphHopper import is a separate one-shot service and writes only to the
versioned artifact parent. Runtime never mounts raw OSM and never mounts a
writable cache or graph location:

```sh
docker compose \
  --env-file routing/graphhopper/versions.env \
  -f docker-compose.routing.yml \
  --profile graphhopper-image-build build --no-cache --pull graphhopper-image-build
# Publish the resulting project-owned image by digest, then set GRAPHHOPPER_IMAGE
# to that exact registry/image@sha256:<64 lowercase hex> reference. The local
# build output tag is never accepted as an import or runtime identity.
python3 routing/scripts/validate-routing-env.py routing/graphhopper/versions.env
docker compose \
  --env-file routing/graphhopper/versions.env \
  -f docker-compose.routing.yml \
  --profile graphhopper-build run --rm graphhopper-import
```

The successful pinned GraphHopper import is the profile/encoded-value
validation. The static validator checks wiring only; it is not a substitute
for this import. Mutable local build tags and builder caches are intermediate
only and are rejected as runtime image identities.

OTP graph construction is also explicit and uses `--abortOnUnknownConfig`:

```sh
docker compose \
  --env-file routing/graphhopper/versions.env \
  -f docker-compose.routing.yml \
  --profile otp-build run --rm otp-graph-build
```

Do not start runtimes until both generated artifact directories are complete.

## Generate and verify the immutable manifest

The deployment contract uses one field, `contractVersion`, with value
`meeet-routing-manifest/v1` in both the application manifest and its attestation.
No second version field is emitted. Generation refuses
placeholders, hashes actual raw MVV/MVG/realtime/OSM/config/boundary/access-
envelope inputs, resolves the actual Docker image IDs, and hashes every file in
the generated OTP and GraphHopper artifacts. The output directory is immutable
and versioned; generation fails if it already exists.

`routing/manifest/canonical-output.fixture.json` is the single valid
generator-output fixture for application-contract validation. The generated
application handoff has exactly those top-level keys. Its adjacent
`deployment-attestation.json` records explicit applied
states for MVV schedule authority, MVG enrichment, realtime, the EPSG:25832
access envelope, and both successful graph imports. Unapplied MVG/realtime
transformations remain explicitly `applied: false`; an unapplied realtime input
can never produce a live manifest claim.

```sh
MANIFEST_ID=otp260-gh102-INPUT_VERSION
mkdir -p routing/manifest/versions
python3 routing/scripts/generate-routing-manifest.py \
  --inventory routing/manifest/input-inventory.json \
  --output-dir "routing/manifest/versions/$MANIFEST_ID" \
  --manifest-id "$MANIFEST_ID" \
  --generated-at 2026-07-30T00:00:00Z \
  --otp-image "$OTP_IMAGE" \
  --graphhopper-image "$GRAPHHOPPER_IMAGE"
python3 routing/scripts/validate-routing-manifest.py \
  --fixture routing/manifest/canonical-output.fixture.json \
  --manifest "routing/manifest/versions/$MANIFEST_ID/meeet-routing-manifest.json" \
  --attestation "routing/manifest/versions/$MANIFEST_ID/deployment-attestation.json"
python3 routing/scripts/verify-routing-manifest.py \
  --manifest "routing/manifest/versions/$MANIFEST_ID/meeet-routing-manifest.json" \
  --attestation "routing/manifest/versions/$MANIFEST_ID/deployment-attestation.json"
```

Manifest verification also reruns the EPSG:25832 polygon comparison; it does
not accept a bounds-only check or a missing Shapely/pyproj installation.

Use a real UTC generation instant recorded in the release manifest; the date
above is only a command shape. Docker image inspection is intentional: an
operator-entered digest claim is not accepted as evidence of the loaded image.
The generator writes runtime lock files before writing the attestation. The
attestation contains each lock hash plus every source/target runtime file
digest. `runtime.env` and `runtime-identity.env` contain the expected manifest,
attestation, identity, and lock hashes. Source `runtime.env` after the engine
build:

```sh
COMPOSE_ENV=$(mktemp)
cat routing/graphhopper/versions.env \
  "routing/manifest/versions/$MANIFEST_ID/runtime.env" > "$COMPOSE_ENV"
chmod 600 "$COMPOSE_ENV"
```

Both runtime entrypoints consume the same read-only manifest, attestation,
runtime identity, graph artifact, and runtime lock immediately before serving.
The generated manifest is the application handoff artifact. Mount it
read-only wherever the application loads routing provenance; do not replace it
with manually typed feed or graph metadata. The adjacent deployment attestation
is mounted read-only as well. The Compose manifest-verifier gate is an
additional gate, not a replacement for either runtime entrypoint.

## Start and readiness

The generated `runtime.env` must be combined with the engine build environment
as above. Start only the runtime services:

```sh
ROUTING_COMPOSE_ENV_FILE="$COMPOSE_ENV" sh routing/scripts/validate-routing-deployment.sh
docker compose --env-file "$COMPOSE_ENV" \
  -f docker-compose.routing.yml up -d otp graphhopper
python3 routing/scripts/check-routing-readiness.py
python3 routing/scripts/check-otp-plan-connection.py \
  --endpoint http://127.0.0.1:8080/otp/gtfs/v1 \
  --max-pages 2
docker compose --env-file "$COMPOSE_ENV" \
  -f docker-compose.routing.yml ps
```

The readiness checker is project-owned and runs on the host using Python's
standard HTTP client. It does not assume `wget`, `curl`, a shell, or any other
utility exists inside the OTP image. It requires OTP `GET
/otp/actuators/health` and GraphHopper `GET /health` to return JSON
`status: UP`.

The OTP Relay/GraphQL consumer endpoint is `/otp/gtfs/v1`; readiness is not a
GraphQL or planning query and must not be substituted for that endpoint.

Both published ports bind to loopback, and the Compose network is internal.
For any non-loopback deployment, place an authenticated TLS reverse proxy in
front of both services, restrict upstream access to that proxy, and do not
expose these unauthenticated HTTP endpoints directly. Local HTTP is not an
authentication boundary.

Stop services with:

```sh
docker compose --env-file "$COMPOSE_ENV" \
  -f docker-compose.routing.yml down
rm -f "$COMPOSE_ENV"
```

## CI/local validation limits

The complete CI gate is:

```sh
python3 routing/scripts/validate-routing-config.py
sh routing/scripts/validate-routing-deployment.sh
python3 routing/scripts/validate-routing-manifest.py \
  --fixture routing/manifest/canonical-output.fixture.json
python3 -m json.tool routing/manifest/input-inventory.example.json >/dev/null
python3 -m json.tool routing/otp/config/build-config.europe-berlin.json >/dev/null
python3 -m json.tool routing/otp/config/router-config.europe-berlin.json >/dev/null
git diff --check
```

When Docker is installed, `validate-routing-deployment.sh` additionally runs
`docker compose ... config --quiet`. It does not claim image builds, graph
imports, manifest image inspection, or readiness without Docker. In this
execution environment the `docker` executable is unavailable, so Compose
interpolation, image metadata, build/import commands, artifact locks inside
containers, and live readiness remain external validation gates. The pinned
Shapely/pyproj envelope toolchain is also not installed here, so envelope
generation/verification remains a failing external gate rather than a pass.

## Licenses, attribution, and result limits

OpenTripPlanner and GraphHopper are Apache-2.0 projects. OSM extracts require
ODbL attribution and any applicable share-alike notices. MVV and MVG inputs
retain the license and attribution supplied with each exact artifact; do not
redistribute them unless their terms allow it. Keep dependency notices with
images and deployment bundles.

OTP and GraphHopper calculate bounded routes for supplied points, times,
profiles, graph coverage, and configured itinerary/path limits. Their outputs
are route candidates, not an exhaustive list of reachable places or all
transit/bike/car alternatives. They do not establish POI completeness,
availability, accessibility, or data freshness beyond the frozen inputs.

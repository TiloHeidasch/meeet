# meeet

Munich-only meeting coordination for exactly two Participants. The canonical
server calculation compares planned public-transport arrivals from an
immutable MVV GTFS schedule and returns a Munich-clipped fairness surface.

## Local development

Requires Node `24.x`.

```bash
npm install
cp .env.example .env.local
npm run dev
```

## Production deployment

The one-server production deployment is exposed only through a remotely managed
Cloudflare Tunnel. See [docs/application-deployment.md](docs/application-deployment.md)
for pinned image setup, MVV artifact rotation, tunnel configuration, smoke
checks, preflight requirements, and rollback procedures. Production requires
Docker Engine 28+ (API v1.48+) and Docker Compose v2.33.0+; GHCR publishes
runner and compiler images for both `linux/amd64` and `linux/arm64`.
Authenticate to GHCR with a least-privilege read-packages credential, put the
workflow's digest-pinned `MEEET_IMAGE` and `MEEET_COMPILER_IMAGE` references in
the ignored env file, then preflight, pull both exact images, verify their
matching revision labels, and start:

```bash
npm run deploy:preflight -- deploy/production.env
docker compose --env-file deploy/production.env -f compose.production.yml pull meeet
COMPILER_IMAGE="$(node deploy/read-compiler-image.mjs deploy/production.env)"
docker pull "$COMPILER_IMAGE"
node deploy/verify-production-images.mjs deploy/production.env
docker compose --env-file deploy/production.env -f compose.production.yml pull cloudflared
docker compose --env-file deploy/production.env -f compose.production.yml up -d
```

The server does not build images; use `deploy/read-compiler-image.mjs` for
compiler runs.

The server accepts only the `meeet-meeting/v3` calculation contract. A request
contains two transit Participants, Munich origins, a whole-second
`searchStartAt`, and a selected 5%, 10%, or 15% tolerance. Responses disclose
access seeds, schedule provenance, and red/blue/fair/unclassified cells.

MVV GTFS is the only schedule/routing source. MVG is used for location search
and nearby access seeds only. The calculation does not use realtime, POIs,
walk navigation, or individual MVG journey/route calls.

## Schedule artifact

Compile the canonical MVV archive offline or explicitly as a deployment step:

```bash
npm run schedule:compile:mvv -- --input /absolute/path/feed.zip --output /absolute/path/mvv-scheduled-artifact.json
```

Set `MEEET_SCHEDULE_ARTIFACT_PATH` to the manifest. Production artifacts must
be compiled under Node 24. Scheduled calculation admits exactly one
two-participant request per process and enforces a 90-second deadline
independently of the framework budget. Configured deployments must declare the
conservative 4 GiB minimum runtime memory with `MEEET_SCHEDULED_MIN_MEMORY_GIB`.
Release still requires an external Node 24 two-participant capacity smoke within
the 90-second budget; the local artifact is not evidence for that gate.

## Validation

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
git diff --check
```

The application boundary is Munich. Map rendering and browser fixture work are
owned by the visual/client migration; server code must preserve the v3
contract and its provenance checks.

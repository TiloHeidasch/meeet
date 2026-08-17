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

The live deployment is an operator-owned Unraid Compose project, external to
this repository, at:

```text
/boot/config/plugins/compose.manager/projects/meeet
```

It has exactly `meeet` and `cloudflared` services. The external runtime `.env`
contains `TUNNEL_TOKEN`, `MEEET_IMAGE`, and `MEEET_SCHEDULE_HOST_DIR`; the
schedule directory is `/mnt/user/appdata/meeet/schedule`. There are no host
ports or local `config.yml`. Cloudflared is
`cloudflare/cloudflared:latest`, runs `tunnel run`, receives `TUNNEL_TOKEN`, and
uses the Cloudflare dashboard service `http://meeet:3000`.

The operator selects the runner image tag or digest in the external `.env`. The
runner and compiler GHCR packages must be public for unauthenticated host
pulls, or the host may use a machine account with `read:packages`.

The live Compose project does not run a compiler service. Rotate the MVV
artifact manually with the published compiler image; download the official
archive and write the manifest plus matching hash-named `.v8.bin` to
`/mnt/user/appdata/meeet/schedule`, then restart `meeet`. The complete procedure
is in [docs/application-deployment.md](docs/application-deployment.md).

[`compose.production.yml`](compose.production.yml) remains a separate,
checked-in hardened repository template. Its strict preflight, token-file
mounts, template-only image variables, and `/srv`/`/etc/meeet` paths are not
instructions for the live Unraid profile.

## Application contract

The server accepts only the `meeet-meeting/v3` calculation contract. A request
contains two transit Participants, Munich origins, a whole-second
`searchStartAt`, and a selected 5%, 10%, or 15% tolerance. Responses disclose
access seeds, schedule provenance, and red/blue/fair/unclassified cells.

MVV GTFS is the only schedule/routing source. MVG is used for location search
and nearby access seeds only. The calculation does not use realtime, POIs,
walk navigation, or individual MVG journey/route calls.

## Schedule artifact

For local or explicitly controlled compilation:

```bash
npm run schedule:compile:mvv -- \
  --input /absolute/path/mvv-feed.zip \
  --output /absolute/path/mvv-scheduled-artifact.json
```

In the production Compose project, rotation is automatic: a one-shot compiler
service fetches the latest MVV feed and compiles (or keeps) the artifact before
`meeet` starts. See the [deployment procedure](docs/application-deployment.md).

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

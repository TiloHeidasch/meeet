# Application deployment

This document distinguishes the checked-in Compose template from the live
operator-owned deployment.

## Deployment boundary

[`compose.production.yml`](../compose.production.yml) is a hardened repository
template. It is not the Compose file currently used on Unraid. In particular,
do not infer the live Unraid secret handling, image variables, resource policy,
or artifact paths from that template.

The live profile is an operator-owned configuration outside this repository:

- Unraid project directory: `/boot/config/plugins/compose.manager/projects/meeet`.
- The runtime Compose project has exactly two services: `meeet` and
  `cloudflared`.
- Its runtime `.env` has exactly these deployment values:

  ```dotenv
  TUNNEL_TOKEN=<Cloudflare tunnel token>
  MEEET_IMAGE=ghcr.io/tiloheidasch/meeet:sha-<runner-commit>
  MEEET_SCHEDULE_HOST_DIR=/mnt/user/appdata/meeet/schedule
  ```

  The operator chooses the runner tag or digest in the external Unraid `.env`;
  it is not stored in this repository.
- `MEEET_SCHEDULE_HOST_DIR` is bind-mounted read-only into the app at
  `/opt/meeet/schedule`.
- There are no published host ports. Both services share the Compose network;
  Cloudflare reaches the app by the service name `meeet` on port `3000`.
- The live `cloudflared` image is `cloudflare/cloudflared:latest`. Its command
  is `tunnel run`, and it receives the tunnel token through `TUNNEL_TOKEN`.
  There is no token-file mount and no local `config.yml`.
- In the Cloudflare dashboard, the public hostname's service is
  `http://meeet:3000`.
- The runtime Compose project does not include a compiler image or compiler
  service. CPU, memory, and other resource limits remain Unraid host policy;
  this profile prescribes none.

The tracked template's token-file mounts, `CLOUDFLARED_IMAGE`,
`CLOUDFLARED_TOKEN_FILE`, `MEEET_COMPILER_IMAGE`, `/srv`, and `/etc/meeet` are
template-only details and are not requirements for the external Unraid
deployment. Likewise, the tracked `npm run deploy:preflight` validates that
repository template; it is not a precondition for the operator-owned Compose
project.

## Image access

The runner package (`ghcr.io/tiloheidasch/meeet`) and artifact-compiler package
(`ghcr.io/tiloheidasch/meeet-artifact-compiler`) must be pullable by the Unraid
host. Public GHCR packages permit unauthenticated pulls. If the packages are
private, authenticate Docker on the host with a machine account granted
`read:packages` before pulling them.

Use the runner image tag or digest selected by the operator. Changing it or the
live `cloudflare/cloudflared:latest` image is an external Unraid configuration
change.

## MVV artifact rotation

The compiler is a manual, one-off artifact rotation. It is not part of the
runtime Compose project.

1. Before rotating, archive the active manifest and the exact `.v8.bin` payload
   named by it as one rollback pair. Then ensure
   `/mnt/user/appdata/meeet/schedule` exists and download the exact official
   MVV archive:

   ```bash
   mkdir -p /mnt/user/appdata/meeet/schedule
   curl --fail --location --retry 3 \
     'https://www.mvv-muenchen.de/fileadmin/mediapool/developer/opendata/gesamt_gtfs.zip' \
     --output /mnt/user/appdata/meeet/schedule/mvv-feed.zip
   ```

2. Select the published compiler image for the desired release. For example,
   use the matching SHA tag or digest from
   `ghcr.io/tiloheidasch/meeet-artifact-compiler`, then run it against the
   host directory:

   ```bash
   COMPILER_IMAGE='ghcr.io/tiloheidasch/meeet-artifact-compiler:sha-<compiler-commit>'
   docker pull "$COMPILER_IMAGE"
   docker run --rm \
     --volume /mnt/user/appdata/meeet/schedule/mvv-feed.zip:/input/mvv-feed.zip:ro \
     --volume /mnt/user/appdata/meeet/schedule:/output \
     "$COMPILER_IMAGE" \
     --input /input/mvv-feed.zip \
     --output /output/mvv-scheduled-artifact.json
   ```

   The output directory must contain
   `mvv-scheduled-artifact.json` and its matching hash-named `.v8.bin` payload.
   Keep the pair together; do not rename or edit the payload manually.
3. Restart `meeet` from the Unraid Compose Manager (or the external Compose
   project) after the pair has been rotated so the new schedule is loaded.

The app reads the manifest from the read-only `/opt/meeet/schedule` mount.
Schedule compilation and rotation do not require adding a service to the live
Compose file.

## SSE calculation progress

`POST /api/meeting/calculate/stream` streams truthful calculation phases as
`text/event-stream` while the scheduled meeting calculation runs. The JSON
`POST /api/meeting/calculate` endpoint remains unchanged.

The stream response sets `Cache-Control: no-cache, no-transform` and
`X-Accel-Buffering: no` so intermediaries neither cache nor buffer the
response, and the app emits `: heartbeat` comment frames while quiet so idle
connections are not closed by timeouts. The stream holds the single
calculation admission slot for up to the 90-second deadline; a browser
disconnect aborts the calculation and releases the slot exactly once, and a
disconnected stream never produces a meeting result.

The operator-owned Cloudflare Tunnel deployment requires no configuration
change: `cloudflared` forwards the stream as-is, and the app's own headers and
heartbeats handle buffering and idle timeouts. If the tunnel or edge were to
buffer the response, progress events would arrive delayed or batched; the app
cannot change external tunnel configuration.

## Local and repository-template operations

For local work, the artifact compiler can also be run with:

```bash
npm run schedule:compile:mvv -- \
  --input /absolute/path/mvv-feed.zip \
  --output /absolute/path/mvv-scheduled-artifact.json
```

Any commands that reference `compose.production.yml`, the repository
preflight, or its template-specific secret and artifact paths apply only to the
checked-in template. They must not be presented as the live Unraid procedure.

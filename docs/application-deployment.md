# Application deployment

This document distinguishes the checked-in Compose template from the live
operator-owned deployment.

## Deployment boundary

[`compose.production.yml`](../compose.production.yml) is a repository template
with three services: a one-shot `compiler` service, `meeet`, and `cloudflared`.
It is not the Compose file currently used on Unraid. The live profile is an
operator-owned configuration outside this repository; do not overwrite it, and
do not infer host-specific resource limits or artifact paths from the template.

The live profile is an operator-owned configuration outside this repository:

- Unraid project directory: `/boot/config/plugins/compose.manager/projects/meeet`.
- The runtime Compose project has three services: `compiler`, `meeet`, and
  `cloudflared`. The one-shot `compiler` runs the MVV artifact rotation before
  `meeet` starts; `meeet` waits for it with
  `condition: service_completed_successfully`, and `cloudflared` starts only
  after `meeet` reports healthy.
- Its runtime `.env` has exactly these deployment values:

  ```dotenv
  TUNNEL_TOKEN=<Cloudflare tunnel token>
  MEEET_IMAGE=ghcr.io/tiloheidasch/meeet@sha256:<runner-digest>
  MEEET_COMPILER_IMAGE=ghcr.io/tiloheidasch/meeet-artifact-compiler@sha256:<publish-workflow-digest>
  MEEET_SCHEDULE_HOST_DIR=/mnt/user/appdata/meeet/schedule
  ```

  sha tags are immutable per-commit publication conveniences; the production
  `.env` uses digest-pinned references from the workflow summary so a tag never
  moves underneath the deployment.

  The operator chooses the digest-pinned runner and compiler images in the
  external Unraid `.env`; they are not stored in this repository. The compiler
  image is selected by the operator, for example the digest-pinned value from
  the unified image publication workflow (see
  [Image publication and pairing](#image-publication-and-pairing)).
- `MEEET_SCHEDULE_HOST_DIR` is bind-mounted read-only into the app at
  `/opt/meeet/schedule`, and read-write into the compiler at `/output`.
- The tracked template uses the same shape: `cloudflared` runs
  `cloudflare/cloudflared:latest` with `command: tunnel run` and receives the
  tunnel token through `TUNNEL_TOKEN`; `meeet` runs `${MEEET_IMAGE}` and mounts
  `${MEEET_SCHEDULE_HOST_DIR}` read-only at `/opt/meeet/schedule`; `compiler`
  runs `${MEEET_COMPILER_IMAGE}` and mounts the same host directory read-write
  at `/output`; `meeet` depends on the compiler with
  `condition: service_completed_successfully`; `cloudflared` depends on `meeet`
  healthy; the healthcheck uses `start_period: 60s`.
- There are no published host ports. The services share the Compose network;
  Cloudflare reaches the app by the service name `meeet` on port `3000`.
- The live `cloudflared` image is `cloudflare/cloudflared:latest`. Its command
  is `tunnel run`, and it receives the tunnel token through `TUNNEL_TOKEN`.
  There is no token-file mount and no local `config.yml`.
- In the Cloudflare dashboard, the public hostname's service is
  `http://meeet:3000`.
- The runtime Compose project includes the compiler service described above.
  CPU, memory, and other resource limits remain Unraid host policy; this
  profile prescribes none.

The tracked template's former token-file mounts, `CLOUDFLARED_IMAGE`,
`CLOUDFLARED_TOKEN_FILE`, Compose secrets, internal networks, and resource
limits (`/srv`, `/etc/meeet`) are template-only details that have been removed
and are not requirements for the external Unraid deployment. Likewise, the
tracked `npm run deploy:preflight` validates that repository template; it is
not a precondition for the operator-owned Compose project.

Operational policy stays explicit: one admission slot for scheduled
calculation, a fixed 90-second calculation deadline, a conservative 4 GiB
minimum memory declaration, and Node 24 artifact compatibility. These are
code-enforced defaults (`DEFAULT_SCHEDULED_DEADLINE_MS` = `90_000`,
`DEFAULT_SCHEDULED_MIN_MEMORY_GIB` = `4`, scheduled concurrency `1`) and the
template relies on them.

## Image access

The runner package (`ghcr.io/tiloheidasch/meeet`) and the artifact-compiler
package (`ghcr.io/tiloheidasch/meeet-artifact-compiler`) must be pullable by
the Unraid host. The compiler image is now part of the runtime Compose project
and is pulled by the host at startup when the one-shot `compiler` service runs,
so the host must be able to pull both packages. Public GHCR packages permit
unauthenticated pulls. If the packages are private, authenticate Docker on the
host with a machine account granted `read:packages` before pulling them.

Use the digest-pinned runner and compiler images selected by the operator.
Changing them or the live `cloudflare/cloudflared:latest` image is an
external Unraid configuration change.

## Image publication and pairing

Changes flow through the promotion path `feature/<slug> → dev → main`; `main`
is the default production branch. Pushes to `main`, `dev`, and `feature/**`
branches and release tags run the unified `publish-image.yml` workflow, which
validates on Node 24 and builds and publishes the runner
(`ghcr.io/tiloheidasch/meeet`) multi-platform image (`linux/amd64`,
`linux/arm64`) on every trigger. `main` and release tags additionally publish
the compiler (`ghcr.io/tiloheidasch/meeet-artifact-compiler`).
dev and feature branch pushes publish the runner only. Every published image
carries an immutable `sha-<full-sha>` tag, OCI revision labels, provenance,
and SBOM attestation. Mutable
convenience tags are published only for `main` and `dev`. Feature builds
additionally get a branch-reference tag normalized to a valid Docker tag by
docker/metadata-action (for example `feature/18-branch-based-development`
becomes `feature-18-branch-based-development`); like every mutable tag it is
never production-eligible, and the immutable `sha-<full-sha>` tag remains the
authoritative reference. Dev and feature images never auto-deploy.

The workflow summary emits digest-pinned deployment references for both images
to pair in the operator-owned runtime `.env`:

```dotenv
MEEET_IMAGE=ghcr.io/tiloheidasch/meeet@sha256:<runner-digest>
MEEET_COMPILER_IMAGE=ghcr.io/tiloheidasch/meeet-artifact-compiler@sha256:<compiler-digest>
```

At startup the one-shot `compiler` service runs exactly that compiler image.
Because the artifact manifest records the compiler version
(`meeet-scheduled-compiler/v2`), a different compiler digest recompiles the
artifact even when the underlying feed data is unchanged, which is what makes a
new compiler revision effective for rotation.

Deployment and rollback stay operator-controlled digest selection: the digest
pairs are explicit values in the external `.env`, never automatic. To roll
back, point `MEEET_COMPILER_IMAGE` (and `MEEET_IMAGE` if the runner revision
should move with it) back at a previously archived digest pair and restart;
keep the archived manifest and `.v8.bin` rollback pair from the previous
rotation as described below.

## GHCR image retention

There is no automated deletion of GHCR images yet; automated cleanup is tracked
in follow-up issue #40 and will be designed there before any deletion runs.
Until then, retention is manual:

- Keep at least the previously archived digest pair together with its archived
  manifest and `.v8.bin` rollback pair.
- sha-tagged images accumulate per commit and may be manually pruned by the
  operator (GHCR UI or API).
- Never delete the digest-pinned image currently referenced by the live `.env`.

## MVV artifact rotation

Rotation is now automatic at `meeet` startup. The one-shot `compiler` service
mounts `MEEET_SCHEDULE_HOST_DIR` read-write at `/output` and runs the rotation
decision path before `meeet` starts; `meeet` waits for it via
`condition: service_completed_successfully` and then reads the manifest from its
read-only `/opt/meeet/schedule` mount.

The decision path is:

1. No compiled data available: compile. Fetch the latest official MVV
   Gesamt-GTFS archive and produce `mvv-scheduled-artifact.json` plus its
   hash-named `.v8.bin` payload.
2. Data present: check the latest MVV feed. If the data is out of date,
   because the feed data changed, the feed validity expired, or the artifact
   was built by a different compiler version, recompile. Otherwise keep the
   current artifact.
3. Exit 0 either way.

The compiler embeds a version (`meeet-scheduled-compiler/v2`) that is written
into the artifact manifest. An artifact carrying a different or missing compiler
version is recompiled even when the underlying data is unchanged, which keeps
rotation robust across artifact-structure changes.

Failure semantics are availability-first. If the latest feed cannot be fetched
or compiled but a usable artifact is present, the compiler keeps the current
artifact and exits 0; it fails hard only when no usable artifact exists.

Each rotation writes a new hash-named payload, so old payloads accumulate in
the schedule directory. After confirming that the new manifest and payload pair
loads, the operator may prune the old payloads while keeping at least one
archived rollback pair as before.

### Offline or backup rotation

The manual one-off compiler run below still works and is intended only for
offline or backup rotations; the normal path above is automatic. Before a
manual rotation, archive the active manifest and the exact `.v8.bin` payload
named by it as one rollback pair. Then ensure
`/mnt/user/appdata/meeet/schedule` exists and download the exact official MVV
archive:

```bash
mkdir -p /mnt/user/appdata/meeet/schedule
curl --fail --location --retry 3 \
  'https://www.mvv-muenchen.de/fileadmin/mediapool/developer/opendata/gesamt_gtfs.zip' \
  --output /mnt/user/appdata/meeet/schedule/mvv-feed.zip
```

Select the published compiler image for the desired release, for example the
matching SHA tag or digest from `ghcr.io/tiloheidasch/meeet-artifact-compiler`,
then run it against the host directory:

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

The output directory must contain `mvv-scheduled-artifact.json` and its
matching hash-named `.v8.bin` payload. Keep the pair together; do not rename or
edit the payload manually.

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

For local work, the artifact compiler supports the same two modes as the
container. Without `--input`, `npm run schedule:compile:mvv` runs the startup
rotation decision path against the given `--output`:

```bash
npm run schedule:compile:mvv -- \
  --output /absolute/path/mvv-scheduled-artifact.json
```

With `--input`, it is the offline compile from a downloaded MVV archive:

```bash
npm run schedule:compile:mvv -- \
  --input /absolute/path/mvv-feed.zip \
  --output /absolute/path/mvv-scheduled-artifact.json
```

Any commands that reference `compose.production.yml`, the repository
preflight, or its template-specific secret and artifact paths apply only to the
checked-in template. They must not be presented as the live Unraid procedure.

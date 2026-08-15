# Production application deployment

This deployment runs the Next standalone server and `cloudflared` on one host.
There are no published Docker ports and no local Cloudflare config file:
Cloudflare remotely manages the tunnel hostname and origin routing.

## Prerequisites

- Docker Engine **28 or newer** with API **v1.48 or newer**, and Docker Compose
  plugin **v2.33.0 or newer**. Compose 2.33+ is required for the explicit egress
  gateway priority used below. The server pulls prebuilt images; BuildKit is
  not required on the server.
- At least **6 GiB physical RAM** on the host, plus disk for the image and MVV
  artifact. The app itself is capped at 4 GiB and one calculation at a time.
- A host directory for the MVV manifest/payload and a root-owned,
  `65532`-group-readable tunnel token file outside Git. Create both before
  `docker compose config`.
- A Cloudflare account with permission to create a remotely managed Tunnel and
  configure its public hostname.

## Authenticate and prepare the host

The publish workflow prints immutable runner and compiler references in its
job summary. Copy those exact lowercase GHCR `@sha256` references into the
ignored env file; do not use `main`, a release tag, or `latest` as a deployment
identity:

The workflow publishes both the runner and compiler images for
`linux/amd64` and `linux/arm64`.

```bash
cp deploy/production.env.example deploy/production.env
# Use a machine-account classic PAT with only read:packages; authorize its SSO
# organization access where applicable. Configure a Docker credential helper
# first, so login stores credentials outside the repository and env file.
# GHCR_READ_PACKAGES_USER must be the PAT owner's machine-account login.
# Keep the token out of command history, deploy/production.env, Compose, and Git.
read -r -s GHCR_READ_PACKAGES_TOKEN
printf '%s' "$GHCR_READ_PACKAGES_TOKEN" | docker login ghcr.io \
  --username "$GHCR_READ_PACKAGES_USER" --password-stdin
unset GHCR_READ_PACKAGES_TOKEN
install -d -o 1001 -g 1001 -m 0750 /srv/meeet/artifacts
install -d -o root -g 65532 -m 0750 /etc/meeet/secrets
install -o root -g 65532 -m 0440 /path/to/cloudflare-tunnel-token /etc/meeet/secrets/cloudflare-tunnel-token
```

The server-side env file requires `MEEET_IMAGE`, `MEEET_COMPILER_IMAGE`,
`CLOUDFLARED_IMAGE`, `MEEET_SCHEDULE_HOST_DIR`, and
`CLOUDFLARED_TOKEN_FILE`. The first two must be lowercase
`ghcr.io/<owner>/<image>@sha256:<64 lowercase hex>` references. The
Cloudflared image must include a release tag and digest. The package must be
visible to the server's GHCR identity, or the package must grant that identity
read access; a private package with no access will fail before startup.

Do not export any deployment-controlled variables before running the preflight
or a `docker compose --env-file ...` command: exported shell values override
`--env-file` values. The preflight fails closed and tells you which names to
unset, so the env file it validates is the same input Compose will use. Run the
tracked preflight before any Compose command; it also fails closed on unpinned
images, relative host paths, an old Compose plugin, or an unavailable Docker
Engine:

```bash
npm run deploy:preflight -- deploy/production.env
```

Pull the exact runner and compiler digests before starting. Pulling by digest
also makes a missing package or insufficient GHCR permission fail explicitly:

```bash
docker compose --env-file deploy/production.env -f compose.production.yml pull meeet
COMPILER_IMAGE="$(node deploy/read-compiler-image.mjs deploy/production.env)"
docker pull "$COMPILER_IMAGE"
node deploy/verify-production-images.mjs deploy/production.env
```

## Compile and rotate the MVV artifact

Compile with the separately published `MEEET_COMPILER_IMAGE`. It was built
from the same commit and exact Node 24 digest as the runner, so no Dockerfile
build or host Node installation is needed on the server:

```bash
COMPILER_IMAGE="$(node deploy/read-compiler-image.mjs deploy/production.env)"
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1g \
  -v "/absolute/path/feed.zip:/input/mvv-feed.zip:ro" \
  -v /srv/meeet/artifacts:/output \
  "$COMPILER_IMAGE" \
  --input /input/mvv-feed.zip \
  --output /output/mvv-scheduled-artifact.json
```

The compiler writes a Node V8 payload beside the JSON manifest and publishes
the manifest last. Validate the new manifest and payload before rotation. Keep
the previous pair for rollback; never edit a payload or manifest in place.
The running app reads `/opt/meeet/schedule/mvv-scheduled-artifact.json` from a
read-only bind, and a restart is required to load a rotated artifact.

## Configure the remote tunnel

In Cloudflare Zero Trust, create a **remotely managed** Tunnel, copy its token
to the host file above, and add a Public Hostname route to service
`http://meeet:3000`. The tunnel container runs explicitly as UID/GID
`65532:65532`; the host token is therefore `root:65532` with mode `0440`.
Compose mounts the secret read-only at `/run/secrets/cloudflare_tunnel_token`;
the token is never placed in the env file, service environment, or Git. The
tunnel container is attached to the private `origin` network, so this service
name is available without exposing a host port. Do not add a local `config.yml`;
hostname routing is managed in the Cloudflare dashboard. Optionally add
Cloudflare Access, WAF rules, and rate limits before publishing the hostname.

## Start, stop, and rollback

Check interpolation and the Compose model before starting. The tunnel waits for
the app's `/api/health/ready` healthcheck. There is no local build step:

```bash
npm run deploy:preflight -- deploy/production.env
docker compose --env-file deploy/production.env -f compose.production.yml config --quiet
docker compose --env-file deploy/production.env -f compose.production.yml pull cloudflared
node deploy/verify-production-images.mjs deploy/production.env
docker compose --env-file deploy/production.env -f compose.production.yml up -d
docker compose --env-file deploy/production.env -f compose.production.yml ps
```

The app readiness check allows the first load of the roughly 892 MiB schedule
artifact: `start_period` 180 seconds, `interval` 30 seconds, `timeout` 10
seconds, and 5 retries. Each service's public egress attachment has
`gw_priority: 1`; the private `origin` network is only the tunnel-to-app link
and must not become the default route.

Stop without deleting the bind-mounted artifact or secret:

```bash
docker compose --env-file deploy/production.env -f compose.production.yml stop
```

Rollback does not stop the healthy stack first. Replace `MEEET_IMAGE` and
`MEEET_COMPILER_IMAGE` in the ignored env file with the previous published
digests, then pull and verify both images while the current app remains live:

```bash
npm run deploy:preflight -- deploy/production.env
docker compose --env-file deploy/production.env -f compose.production.yml pull meeet
COMPILER_IMAGE="$(node deploy/read-compiler-image.mjs deploy/production.env)"
docker pull "$COMPILER_IMAGE"
node deploy/verify-production-images.mjs deploy/production.env
docker compose --env-file deploy/production.env -f compose.production.yml pull cloudflared
docker compose --env-file deploy/production.env -f compose.production.yml up -d --force-recreate
```

The immutable runner digest changes the running app only at the final
`--force-recreate`; the old app remains healthy during authentication, pulls,
and label verification. Do not use `down -v`: the deployment intentionally has
no disposable data volume, and the host-side artifact and secret must remain
under operator control.

## Production smoke and resource checks

After the tunnel hostname is live, verify the readiness URL and submit two
sequential valid `meeet-meeting/v3` two-transit-participant requests. Each must
complete successfully in under 90 seconds. While the first request is active,
submit a second request concurrently; it must receive HTTP `503`, proving the
single admission gate rather than queueing work.

Also check the container health state and limits:

```bash
docker compose --env-file deploy/production.env -f compose.production.yml ps
docker inspect "$(docker compose --env-file deploy/production.env -f compose.production.yml ps -q meeet)" \
  --format '{{json .State.Health}}'
docker stats --no-stream "$(docker compose --env-file deploy/production.env -f compose.production.yml ps -q meeet)"
docker compose --env-file deploy/production.env -f compose.production.yml exec -T meeet \
  node -e 'const fs=require("node:fs"); fs.writeFileSync("/tmp/write-test", "ok"); try { fs.writeFileSync("/app/write-test", "no"); process.exit(1); } catch { process.exit(0); }'
```

The check covers readiness, the read-only root filesystem, and observed resource
usage. Confirm that only `origin`, `meeet-egress`, and `cloudflared-egress`
networks exist for this project and that `docker compose port meeet 3000` is
empty.

## Local limitations

Local static checks cannot prove GHCR package visibility or server token scope,
the Cloudflare edge hostname, remotely managed route, DNS/TLS behavior,
Access/WAF/rate limits, or tunnel egress. They also do not replace the release
smoke with the full production artifact, at least 6 GiB physical RAM, real MVG
access, and measured sequential/concurrent requests.

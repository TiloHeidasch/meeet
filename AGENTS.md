# meeet

## Product guardrails

- Keep Munich as the only supported geographic boundary.
- The canonical calculation contract is `meeet-meeting/v3` with exactly two
  transit Participants, two origins, a Search Start Time, and selected 5/10/15%
  tolerance.
- MVV GTFS is the sole schedule and transit-routing authority. MVG location and
  nearby access are seed resolution only; never add journey, route, realtime,
  POI, or pedestrian-navigation behavior to the scheduled calculation.
- Preserve station-area identity, planned service-day semantics, provenance,
  explicit no-result, and red/blue/fair/unclassified cell rules. Boarding-stop
  identity is deliberately not preserved (see `docs/adr/0003-station-level-routing-with-change-time.md`).
- Do not escalate or silently change the selected tolerance.

## Change triggers

- Changes to scheduled routing, artifacts, access seeds, or the v3 validator
  require focused scheduled tests and strict typechecking.
- Changes to the calculation endpoint must preserve v3-only rejection of old
  request shapes and the no-MVG-route guard.
- UI, client-safe response consumption, styling, and browser tests belong to
  the visual/client migration lane; do not edit them from a server lane.

## Branch and PR workflow

- The supported merge path is `feature/<slug> → dev → main`; `main` is the
  default production branch.
- PRs into `dev` and `main` must pass Node 24 tests, typecheck, and lint on the
  merge result (required check `Validate Node 24 (merge result) / validate`)
  and be up-to-date with their target.
- `dev` and `main` are protected against force pushes and deletion.

## Engineering guardrails

- Keep server-only provider credentials and schedule artifacts out of client
  bundles.
- Keep Node 24 artifact compatibility, full-feed memory capacity, API deadline,
  and concurrency limits explicit in deployment changes.
- Use TDD for contract retirement and tamper seams; run affected tests,
  `npm run lint`, `npx tsc --noEmit`, and `git diff --check` before handoff.
  Linting is a mandatory quality gate that must pass with zero errors.
- Preserve the intentional `meeet` spelling and the repository's strict
  TypeScript settings.

## Deployment boundary

- Before proposing a server change involving deployment, GHCR images, Cloudflare
  Tunnel, or schedule artifacts, read `docs/application-deployment.md`.
- The documented Unraid production profile is operator-owned and distinct from
  the tracked Compose template; do not overwrite it or infer host-specific
  resource limits.
- dev and feature branch publication builds the runner image only; the compiler
  image is published only by `publish-image.yml` on pushes to `main` and
  release tags. Production is an operator-selected digest-pinned deployment of
  a `main`-built runner image, and no dev/feature image auto-deploys.

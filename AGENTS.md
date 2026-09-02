# meeet

## Product guardrails

- Keep Munich as the only supported geographic boundary for destinations,
  surfaces, station-area candidates, markers, and territories. Participant
  ORIGINS may be anywhere in the MVV area (external-Munich) and are accepted
  globally by `meeet-meeting/v3`; an external origin is usable only when MVG
  nearby resolves to a compiled-MVV-artifact access seed, otherwise the
  calculation returns an explicit no-result.
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
- PRs into `dev` and `main` must pass the e2e gate (required check
  `E2E build, spin up, calculate`): a full application build, a schedule-artifact
  compilation, a server spin-up, and the production calculation journey (JSON
  calculate, the SSE progress stream, and station-area details via the
  returned calculation reference).
- PRs into `dev` and `main` must pass the real-feed compile gate (required
  check `Compile real MVV feed`): the production rotation path
  (`npm run schedule:compile:mvv`) must compile the live MVV Gesamt-GTFS
  archive, so compiler regressions against the real feed shape fail CI
  instead of only failing at production rotation. The operator must add this
  check to branch protection alongside the e2e gate.
- Reviews are performed by the oracle (code-review skill, both axes) as an
  advisory quality gate; the verdict never blocks merging. Branch protection
  requires no reviews on `dev` or `main`. PRs into `dev` are created and
  merged by the agent; `dev → main` promotion merges are performed manually
  by the operator through the GitHub web UI, never by an agent or CLI.
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
- Feature branch publication builds the runner image only; the compiler
  image is published by `publish-image.yml` on pushes to `main` and `dev`
  and on release tags. Production is an operator-selected digest-pinned
  deployment of a `main`-built runner image, and no dev/feature image
  auto-deploys.

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

## Compiler publication

- The artifact compiler image is published only by a deliberate, authenticated
  GitHub Actions dispatch, never by a branch push. Routine pushes build and
  publish only the backend runner.
- Trigger a compiler rebuild only after a successful push that changes the
  compiler image target, compiler/import scripts, the GTFS/artifact model, or
  their locked dependencies. App-only changes do not trigger it.
- Dispatch after such a push:
  `gh workflow run publish-compiler.yml --ref <pushed-branch> -f source_sha=<full-commit-sha>`
- The dispatch validates the given revision, runs the validation suite, and
  publishes an immutable `sha-<full-sha>` compiler image with SBOM and
  provenance. It cannot deploy an application, rotate a schedule artifact,
  alter the operator-owned deployment, or retag a production image.

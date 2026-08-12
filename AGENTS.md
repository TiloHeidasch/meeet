# meeet

## Product guardrails

- Keep Munich as the only supported geographic boundary.
- The canonical calculation contract is `meeet-meeting/v3` with exactly two
  transit Participants, two origins, a Search Start Time, and selected 5/10/15%
  tolerance.
- MVV GTFS is the sole schedule and transit-routing authority. MVG location and
  nearby access are seed resolution only; never add journey, route, realtime,
  POI, or pedestrian-navigation behavior to the scheduled calculation.
- Preserve station-area/boarding-stop identity, planned service-day semantics,
  provenance, explicit no-result, and red/blue/fair/unclassified cell rules.
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
  `npx tsc --noEmit`, and `git diff --check` before handoff.
- Preserve the intentional `meeet` spelling and the repository's strict
  TypeScript settings.

# ADR 0001 — Scheduled fairness surface

Status: accepted; this decision supersedes the earlier station-search model.

meeet calculates a two-person Munich fairness surface from an immutable MVV
GTFS schedule. The server accepts only `meeet-meeting/v3`. Each request has two
transit Participants, two Munich origins, a whole-second `searchStartAt`, and a
selected tolerance of 5%, 10%, or 15%.

MVG supplies location search and bounded nearby access seeds. It is not the
schedule or transit-routing authority. The compiled MVV artifact supplies
station areas, boarding stop points, calendars, exceptions, planned
connections, timezone rules, and provenance. No realtime, POI, pedestrian
navigation, or individual MVG journey is used to establish the surface.

For each Participant, the scheduled router returns station-area arrival
fields. Each Munich-clipped grid cell is evaluated at its center using a
geometric final station-to-center walking estimate. A cell is fair when both
elapsed planned arrivals satisfy the selected tolerance; otherwise it is red
or blue according to the faster Participant. If neither side is reachable the
cell is unclassified. A no-result response is explicit and contains only
unclassified cells.

## Consequences

- Exactly two Participants and their serialized access-seed provenance are
  required end-to-end.
- Schedule identity, feed identity, timezone, compiled identity, search start,
  tolerance, and seed counts are cross-bound in the response validator.
- The surface is a bounded planned-time approximation: cell-center final
  walking is disclosed as geometric estimation, not navigation.
- A selected tolerance is never escalated.
- Munich clipping and station-area/boarding-stop identity are enforced by the
  server contract.
- Node 24 compilation, binary-artifact compatibility, memory capacity, a
  90-second API budget, and a concurrency guard are release qualifications.

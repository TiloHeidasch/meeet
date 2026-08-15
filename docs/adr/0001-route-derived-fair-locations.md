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

For each Participant, the scheduled router returns station-area arrival fields
for the grid and final ready fields for every boarding stop. Station-area
arrival fields do not claim a boarding-stop identity; station-area markers
select the fastest eligible boarding-stop ready field with a deterministic tie
break. The response retains its Munich-clipped grid, whose cells are evaluated
at their centers using a geometric final station-to-center walking estimate,
but the client no longer renders those cells as the meeting surface. It derives
a nearest-station-area territory for every calculated station area using a
local projected coordinate system, then clips the territories to the complete
official Munich boundary, retaining holes and disconnected components. A
territory takes its nearest station area's red, blue, fair, or unclassified
classification. Only classified territories are filled; unclassified territory
is deliberately left without a red, blue, or fair surface claim.

The v3 response also exposes one station-area meeting-place candidate for
every canonical station area whose coordinate is inside the official Munich
boundary and which has at least one child boarding stop inside that boundary
participating in an imported scheduled connection. The shared-window CSA scan
retains each boarding stop's final ready time; a marker selects the fastest
eligible ready stop, breaking ties by scheduled stop ID. These markers use
boarding-stop readiness (not MVG routes), retain the selected red and blue
boarding-stop identities, and apply the same classification rules. A
no-result response is explicit and contains only unclassified cells and
station-area candidates.

## Consequences

- Exactly two Participants and their serialized access-seed provenance are
  required end-to-end.
- Schedule identity, feed identity, timezone, compiled identity, search start,
  tolerance, and seed counts are cross-bound in the response validator.
- The scheduled calculation remains a bounded planned-time approximation:
  cell-center final walking is disclosed as geometric estimation, not
  navigation.
- The grid remains a response calculation artifact. The rendered meeting
  surface is a Munich-clipped nearest-station-area territory partition, while
  station-area markers remain the meeting-place candidates.
- A selected tolerance is never escalated.
- Munich clipping and station-area/boarding-stop identity are enforced by the
  server contract.
- Node 24 compilation, binary-artifact compatibility, memory capacity, a
  90-second API budget, and a concurrency guard are release qualifications.

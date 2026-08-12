# Meeting Coordination

meeet helps exactly two Participants choose a Munich meeting destination from
planned public-transport travel times.

## Product language

**Meeting Search**: A calculation for exactly two Participants and two Munich
Participant Origins.

**Search Start Time**: The offset-aware planned instant at which both searches
begin. It is represented by `searchStartAt` and uses whole-second precision.

**Station area**: One physical transit location containing one or more GTFS
boarding stop points.

**Access seed**: A bounded origin-to-station-area access result from the MVG
nearby endpoint. Its duration is geographic walking time; timetable routing
comes only from the compiled MVV GTFS artifact.

**Planned schedule**: The immutable Europe/Berlin MVV GTFS timetable loaded
from the versioned binary schedule artifact. It supplies calendar exceptions,
stop-point connections, service-day timing, and routing provenance.

**Cell-center geometric final segment**: A surface cell is evaluated at its
center. The final station-to-center duration is a bounded geometric walking
estimate, not pedestrian navigation.

**Selected tolerance**: The Organiser selects 5%, 10%, or 15%. The selected
value is used as-is; it is never escalated or silently relaxed.

**Fair cell**: Both Participants have reachable arrival fields and their
planned elapsed times satisfy the selected tolerance.

**Red cell / blue cell**: Exactly one Participant is faster under the planned
arrival fields, or both are reachable and the difference is outside tolerance.

**Unclassified cell**: Neither Participant has a reachable arrival field.

**No-result**: An explicit response when access seeds or reachable scheduled
stations are unavailable. Every cell is then unclassified with null arrival
fields.

## Source and boundary guardrails

- Munich is the only supported geographic application boundary.
- The `meeet-meeting/v3` scheduled contract is the only meeting-calculation
  contract accepted by the server.
- MVV GTFS is the sole schedule and transit-routing source.
- MVG is used for location search and nearby access-seed resolution only. The
  canonical calculation does not call MVG journey or route endpoints.
- The calculation is planned and static: no realtime disruption data, POI
  discovery, or walk-navigation route is part of the surface claim.
- Every response contains exactly two Participants, seed provenance, selected
  tolerance, schedule provenance, and the Munich-clipped grid surface.
- Production artifacts are compiled under the pinned Node 24 engine. The
  binary bundle, routing-window memory use, 90-second API budget, and request
  concurrency limit are deployment gates.

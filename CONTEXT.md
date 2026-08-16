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

**Calculation reference**: The opaque short-lived token returned in the
`Meeet-Calculation-Ref` header of a validated v3 calculation. A station-area
detail request presents it to prove it refers to that calculation's basis.

**Calculation basis**: The small immutable server-side record behind a
calculation reference: canonical request, canonical access seeds, candidate
evidence, artifact identities, routing options, and public provenance. It is
bounded and never contains schedule data, route trees, or credentials.

**Identity-resolution fact**: A zero-duration detail segment that maps a
resolved MVG coordinate to its scheduled MVV artifact identity (station area
or boarding stop). It explains evidence without changing canonical readiness
or claiming a walk.

**Witness capture**: Request-local recording of the earliest-arrival scan's
ready and connection steps, enabled only to reconstruct a selected station
area's evidence on demand.

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
  binary bundle, routing-window memory use, 30-second API budget, and request
  concurrency limit are deployment gates.

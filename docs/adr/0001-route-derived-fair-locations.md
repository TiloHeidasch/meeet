# Route-Derived Fair Locations from MVG journeys

Status: accepted

meeet will not claim a complete geographic equal-travel-time corridor from a point-to-point routing service. The MVP instead returns a Route-Derived Fair Location Set: a finite, independently verified set of locations sourced from direct and anchor-station-constrained MVG journeys. This preserves the core benefit—comparable two-person travel times—without pretending that sparse route calls establish every location in Munich.

For the selected Arrival Time (initially one hour from search start), query the coordinate-to-coordinate MVG `GET https://www.mvg.de/api/bgw-pt/v3/routes` endpoint in both Participant-Origin directions for a direct journey and for journeys constrained through each fixed Anchor Station (`viaStationGlobalId`, `viaDwellTimeInMinutes=10`). Use arrive-by requests with every tested public transport type (`SCHIFF`, `UBAHN`, `TRAM`, `SBAHN`, `BUS`, `REGIONAL_BUS`, and `BAHN`), `routeType=LEAST_TIME`, and `changeSpeed=NORMAL`. Deduplicate returned journeys by their ordered transit-stop and line sequence, then extract only transit stops and public walking-leg endpoints, including Participant Origins, as Route Candidates; never treat arbitrary transit-polyline coordinates as meeting locations. Independently evaluate each raw candidate coordinate from both Participant Origins before merging qualifying locations. For every candidate, independently query each Participant Origin to that candidate with the same Arrival Time. Given unrounded planned journey times `a` and `b` and active tolerance `p`, retain the candidate exactly when `|a - b| <= p(a + b)`; this is equivalent to requiring each time to be within ±`p` of their mean.

The MVG journey response is authoritative for an individual Journey, including its access, egress, transfer, and walk-only legs. Fairness uses planned timetable times; live disruption information may appear only in individual route details. A displayed Fair Location is an individual marker with its source routes available for inspection; it is not connected to other markers in a way that implies an intervening area is also fair. POI discovery and selection remain outside the MVP.

## Consequences

- The source catalogue is deliberately finite: direct routes plus routes constrained through Hauptbahnhof (`de:09162:6`), Sendlinger Tor (`de:09162:50`), Universität (`de:09162:70`), Silberhornstraße (`de:09162:1170`), Rotkreuzplatz (`de:09162:190`), and Olympiazentrum (`de:09162:350`).
- Participant Origins and Route Candidates are within the City of Munich boundary. A Journey may leave that boundary when public transport requires it.
- Repeated timetable variants with the same stop-and-line sequence do not add candidates.
- A walk-only Route Pattern is identified by its ordered endpoints and direction.
- Merge candidate station areas by their stable provider station identity and walking-leg endpoints within 50 metres; retain all supporting Route Patterns.
- A Meeting Search starts at an Organiser-selected tolerance of ±5%, ±10% (default), or ±15%. If it contains no Fair Location, tolerance increases by five percentage points until one exists; finite walkable journeys ensure a solution by ±100%.
- The selected Arrival Time must be from now through the end of the following calendar day. An empty result is not a normal product outcome; provider failures remain operational errors rather than evidence that no meeting location exists.

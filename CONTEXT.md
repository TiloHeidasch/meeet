# Meeting Coordination

The domain for helping a group choose a Munich meeting destination with comparable travel times.

## Language

**Meeting Search**:
A two-person, active-browser-session search for Route-Guided Fair Locations its Participants can reach in comparable travel time.
_Avoid_: Match, query

**Participant**:
A person included in a Meeting Search; every Meeting Search has exactly two Participants, each represented by a Munich Participant Origin.
_Avoid_: User, attendee

**Participant Origin**:
The Munich map location selected by address/place search and adjustable as a map pin, from which a Participant starts travel in a Meeting Search.
_Avoid_: Home, live location

**Organiser**:
The person who creates a Meeting Search and supplies its Participants.
_Avoid_: Host, owner

**Journey**:
A Participant’s planned public-transport trip between their Participant Origin and a transit station target, including access and egress walking.
_Avoid_: Travel mode, route

**Travel-Time Tolerance**:
The permitted percentage variation between each Participant’s travel time and the Meeting Search’s mean travel time. An Organiser initially selects ±5%, ±10%, or ±15%; ±10% is the default.
_Avoid_: Slack, buffer

**Tolerance Escalation**:
The automatic increase of a Meeting Search’s Travel-Time Tolerance in five-percentage-point steps when no discovered Pattern Local Minimum meets the current tolerance.
_Avoid_: Empty result, failed search

**Effective Travel-Time Tolerance**:
The Travel-Time Tolerance actually used after any Tolerance Escalation. It is presented alongside the Organiser’s initially selected tolerance.
_Avoid_: Hidden relaxation, final tolerance

**Door-to-Door Travel Time**:
The complete time a Participant spends on a Journey, including walking, waiting, and transfers.
_Avoid_: Ride time, in-vehicle time

**Arrival Time**:
The single future time by which every Participant aims to reach a transit station target. Each Participant takes the latest feasible Journey arriving no later than this time. It initially defaults to one hour after a Meeting Search starts.
_Avoid_: Departure time, meeting time

**Planning Window**:
The period from calculation time through the end of the following calendar day, in which an Organiser may choose an Arrival Time.
_Avoid_: Booking window, planning horizon

**Anchor Station**:
A prominent Munich transit station in the fixed Anchor Station Catalogue, used to constrain a route between the two Participant Origins and broaden Route Candidate sourcing.
_Avoid_: Via, waypoint

**Anchor Station Catalogue**:
The small, fixed collection of prominent Munich transit stations that can act as Anchor Stations in a Meeting Search: Hauptbahnhof, Sendlinger Tor, Universität, Silberhornstraße, Rotkreuzplatz, and Olympiazentrum.
_Avoid_: All stations, user selection

**Route Pattern**:
An ordered sequence of transit stops and lines sourced from a direct or Anchor-Station-constrained journey, considered in one Participant-to-Participant direction.
_Avoid_: Route alternative, timetable variant

**Route Candidate**:
A Munich transit station target discovered from a direct or Anchor-Station-constrained Route Pattern between the two Participant Origins. Walking endpoints and Participant Origins are not Route Candidates.
_Avoid_: POI, suggestion

**Route-Derived Fair Location**:
A discovered transit station at an accepted local minimum of the absolute difference between the Participants’ planned Door-to-Door Travel Times on a Route Pattern, when it meets the active Travel-Time Tolerance. A local minimum is an accepted trade-off, not an absolute or global proof.
_Avoid_: Corridor, route midpoint

**Route-Guided Fair Location Search**:
A bounded, sampled/discovery search that examines direct and Anchor-Station-constrained Route Patterns in both directions and returns the union of discovered Route-Derived Fair Locations with source-pattern provenance and sampled coverage. It does not establish that skipped stations are unfair.
_Avoid_: Complete set, exhaustive search

**Pattern Local Minimum**:
The accepted station on an ordered Route Pattern where the sampled absolute difference between the Participants’ planned Door-to-Door Travel Times is locally minimized.
_Avoid_: Global optimum, proof of fairness

**Physical Transit Location**:
A station area identified as one physical location even when it appears in multiple Route Patterns or platform-level route parts.
_Avoid_: Platform, route occurrence

**Sampled Coverage**:
The disclosed set of Route Patterns and discovered station targets considered by a Route-Guided Fair Location Search. It describes what was sampled, not a completeness guarantee.
_Avoid_: Complete coverage, unfair remainder

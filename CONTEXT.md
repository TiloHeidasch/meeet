# Meeting Coordination

The domain for helping a group choose a Munich meeting destination with comparable travel times.

## Language

**Meeting Search**:
A two-person, active-browser-session search for a Route-Derived Fair Location Set its Participants can reach in comparable travel time.
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
A Participant’s scheduled public-transport trip between their Participant Origin and a Route Candidate, including access and egress walking. A Journey may be wholly walking when no public-transport segment serves the location.
_Avoid_: Travel mode, route

**Travel-Time Tolerance**:
The permitted percentage variation between each Participant’s travel time and the Meeting Search’s mean travel time. An Organiser initially selects ±5%, ±10%, or ±15%; ±10% is the default.
_Avoid_: Slack, buffer

**Tolerance Escalation**:
The automatic increase of a Meeting Search’s Travel-Time Tolerance in five-percentage-point steps until it contains at least one Route-Derived Fair Location.
_Avoid_: Empty result, failed search

**Effective Travel-Time Tolerance**:
The Travel-Time Tolerance actually used after any Tolerance Escalation. It is presented alongside the Organiser’s initially selected tolerance.
_Avoid_: Hidden relaxation, final tolerance

**Door-to-Door Travel Time**:
The complete time a Participant spends on a Journey, including walking, waiting, and transfers.
_Avoid_: Ride time, in-vehicle time

**Arrival Time**:
The single future time by which every Participant aims to reach a Route Candidate. Each Participant takes the latest feasible Journey arriving no later than this time. It initially defaults to one hour after a Meeting Search starts.
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
The unique ordered sequence of transit stops and lines in a Journey, independent of its timetable-specific departure time.
_Avoid_: Route alternative, timetable variant

**Route Candidate**:
A Munich transit stop or public walking-leg endpoint, including a Participant Origin, extracted from a direct or Anchor-Station-constrained Route Pattern between the two Participant Origins. It is evaluated independently from both Participant Origins.
_Avoid_: POI, suggestion

**Route-Derived Fair Location**:
A physical Route Candidate whose Door-to-Door Travel Times from both Participants fall within a Meeting Search’s Travel-Time Tolerance. One Fair Location merges all Route Patterns that support it.
_Avoid_: Corridor, route midpoint

**Physical Transit Location**:
A station area identified as one physical location even when it appears in multiple Route Patterns or platform-level route parts.
_Avoid_: Platform, route occurrence

**Walking Endpoint Cluster**:
A single physical Route Candidate formed by walking-leg endpoints within 50 metres of one another.
_Avoid_: Duplicate endpoint, endpoint group

**Route-Derived Fair Location Set**:
The complete collection of unique Route-Derived Fair Locations a Meeting Search presents as individual map markers, with their source routes available for inspection and without identifying a single meeting destination. Each marker reveals the Participants’ planned Door-to-Door Travel Times, their difference, and the Effective Travel-Time Tolerance.
_Avoid_: Corridor, recommendation

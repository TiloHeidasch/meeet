# Phase 1 local providers

`providers.ts` is the intentionally temporary provider boundary for the MVP.
Its canonical journey provider returns deterministic planned transit journeys
with walking endpoints and optional fixed anchor stops. Additional provider
interfaces are retained only for isolated compatibility seams and are not part
of the public calculation. The fixture does not contact external services and
contains neither MVG/MVV timetable data nor live provider data. The fixture
version is metadata only; it is not a transit schedule.

The input boundary is:

```json
{
  "participants": [
    {
      "id": "participant-1",
      "location": {
        "label": "Marienplatz",
        "latitude": 48.1374,
        "longitude": 11.5755
      },
      "mode": "transit"
    },
    {
      "id": "participant-2",
      "location": {
        "label": "Odeonsplatz",
        "latitude": 48.1421,
        "longitude": 11.5764
      },
      "mode": "transit"
    }
  ],
  "tolerancePercent": 10,
  "arrivalAt": "2026-07-25T10:00:00.000Z"
}
```

The canonical request has exactly two `transit` participants and an
`arrivalAt` instant. `tolerancePercent` is 5, 10, or 15 and defaults to 10.
The temporary official district collection is defined in
`lib/domain/boundary.ts` and remains application coverage geometry only, not a
legal or cadastral boundary.

The canonical response is discriminated by `status` and returns only finite
route-derived fair locations, route patterns, and provider metadata. Selected
venues and venue-specific routing are outside this MVP contract.
Fixture provider metadata remains `demo-static`; it is never relabelled as a
scheduled timetable. Each canonical response also records all fourteen source
queries, including queries that returned no journeys.

Run the focused tests with `npm test`, or run validation checks with
`npm run lint` and `npm run build`.

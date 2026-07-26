# Phase 1 local providers

`providers.ts` is the intentionally temporary provider boundary for the MVP.
It uses a bounded routing matrix, fixed straight-line distance calculations,
fixed average speeds and fixed food/drink demo entries. It is deterministic,
does not contact external services, and contains neither MVG/MVV timetable
data nor live routing, geocoding, or listing data. The fixture version is
metadata only; it is not a transit schedule.

The input boundary is:

```json
{
  "participants": [
    {
      "id": "optional-stable-id",
      "location": {
        "label": "Marienplatz",
        "latitude": 48.1374,
        "longitude": 11.5755
      },
      "mode": "transit"
    }
  ],
  "tolerancePercent": 10,
  "departureAt": "2026-07-25T10:00:00+02:00"
}
```

There must be 2–4 participants. `mode` is `transit`, `bike`, or `car`.
`tolerancePercent` is 5, 10, or 15 and defaults to 10. The temporary
official district collection is defined in `lib/domain/boundary.ts` and is
used for coordinate membership and grid clipping. It is application coverage
geometry only, not a legal or cadastral boundary.

The response is discriminated by `status`: `ok` includes a `MultiPolygon`
assembled from clipped cells whose center and declared clipped vertices all
passed the median ± tolerance sample rule; `no-corridor` includes a reason and
no geometry. The cell interiors are not independently routed.

Run the focused tests with `npm test`, or run validation checks with
`npm run lint` and `npm run build`.

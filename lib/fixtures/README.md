# Offline scheduled fixture

`scheduled-routing.ts` provides a deterministic, offline MVV timetable and
access-seed fixture for scheduled meeting calculations. It never contacts MVG,
MVV, or any other external service.

The fixture represents the v3 flow: exactly two transit participants, a selected
5/10/15% tolerance, and an offset-aware `searchStartAt`. Its metadata identifies
the fixture as demo data; it is not a live timetable and is not a production
service feed.

Use it for deterministic scheduled-surface tests and local development. It does
not provide journey endpoints, realtime information, walking directions, venue
recommendations, or route-discovery behavior.

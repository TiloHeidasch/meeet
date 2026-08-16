# Provider deployment contract

The canonical meeting calculation is server-side, Munich-only, and scheduled.
The browser calls `/api/meeting/calculate`; provider credentials and artifact
paths remain server-only.

## Canonical sources

- **MVV GTFS** is the sole schedule and transit-routing source. The offline
  compiler accepts the canonical MVV archive, records acquisition and feed
  provenance, and writes a Node V8 binary shared-template payload plus a JSON
  manifest.
- **MVG** supplies location search and nearby station access seeds only. The
  scheduled calculation never calls MVG journey or route endpoints.
- No realtime disruption data, POI service, pedestrian navigation, or generic
  routing matrix participates in the scheduled fairness surface.

## Runtime and artifact gates

- Production uses the pinned Node `24.x` engine. Bundles record their actual
  writer major and are rejected by a loader with a different runtime major.
- `MEEET_SCHEDULE_ARTIFACT_PATH` must point to an absolute manifest path. The
  loader validates the bounded manifest, sibling payload, hash, length,
  provenance, references, freshness, and immutable cache identity before one
  deep freeze.
- The schedule is valid only for Europe/Berlin and the Munich application
  boundary. The API requires exactly two transit Participants.
- The full-feed binary/window memory profile, 90-second API budget, and
  concurrency guard are deployment gates. A local artifact compiled under a
  different Node major is not production release evidence.

## Modes

`MEEET_PROVIDER_MODE=fixture` uses deterministic offline MVV-schedule and
nearby-access fixtures. Other deployments must configure the compiled schedule
artifact and nearby access provider explicitly. Missing or invalid schedule
configuration is an unavailable provider, never a fallback to another transit
source.

Location search remains a separate bounded MVG endpoint integration. Its
coordinates are used to resolve nearby access seeds to exact MVV station-area
or boarding-stop identities; unknown identities are excluded.

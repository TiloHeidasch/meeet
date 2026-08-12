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
- Declare numeric `MEEET_SCHEDULED_MIN_MEMORY_GIB=4` for one-at-a-time,
  two-participant full-feed requests. Configured mode rejects a missing or
  smaller declaration; fixture mode uses the deterministic 4 GiB default. This
  is a conservative Node 24 deployment minimum based on the observed 2.88 GiB
  Node 26 peak, not Node 24 capacity evidence, and does not replace the Node 24
  two-participant smoke.
- `MEEET_SCHEDULED_CONCURRENCY` is capped at exactly `1`; any other value is
  rejected. This single-request policy remains until a future explicitly
  versioned and certified capacity policy changes it. Node 24 certification is
  not implied by this configuration.

## Modes

`MEEET_PROVIDER_MODE=fixture` uses deterministic offline MVV-schedule and
nearby-access fixtures. `configured` deployments load the compiled schedule
artifact and MVG nearby-access provider explicitly. These are the only active
meeting modes; OTP/GraphHopper route-first modules are isolated historical
tooling and cannot be selected as a v3 meeting provider.

Location search remains a separate bounded MVG endpoint integration. Its
coordinates are used to resolve nearby access seeds to exact MVV station-area
or boarding-stop identities; unknown identities are excluded.

Legacy routing-gateway, geocoding, and POI endpoint/token/provenance settings
are rejected by the active v3 configuration surface rather than silently
accepted or ignored.

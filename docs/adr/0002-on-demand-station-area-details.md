# ADR 0002 — On-demand station-area details

Status: accepted.

## Decision

The v3 calculation response remains unchanged. A successful validated
`POST /api/meeting/calculate` stores a small immutable calculation basis in a
bounded process-local cache and returns its opaque `Meeet-Calculation-Ref`
header. `POST
/api/meeting/station-areas/{stationAreaId}/details` receives the same v3
request and the reference, then reconstructs only the selected boarding stop
evidence from the cached access seeds and the current matching MVV GTFS
artifact.

The basis contains the canonical request, both ordered canonical access-seed
sets, paired server-resolved candidate sets for evidence, artifact identities,
effective routing options, public schedule/access provenance, result
status/reason, and compact v3 station markers. It does not contain the
schedule artifact, grid cells, routing window, route trees, detailed routes
for other station areas, credentials, or full schedule data. The detail route
uses the same MVV-only CSA scan and a canonical-scan-first witness. It never
calls MVG journey, route, or realtime services.

An exact nearby seed retains its resolved MVG coordinate in the witness. If
that coordinate differs from the artifact boarding-stop coordinate, the
witness emits a separate zero-duration station-access identity-resolution fact
(including when the coordinates coincide) rather than silently attributing the
artifact coordinate to origin access. It carries no walking distance or
directions and never changes the canonical `searchStartAt + accessSeconds`
boarding readiness.

For a non-exact seed, the same evidence mapping is kept separate from timing:
the candidate coordinate is mapped to the artifact station-area identity with
a zero-duration fact, and only then is the canonical artifact station-area to
boarding-stop walk shown. The cached canonical seed's `accessSeconds` and the
artifact coordinate remain the sole v3 readiness inputs.

References are short-lived and bounded by both entry count and serialized
basis bytes. The current cap is 32 entries and 32 MiB of serialized basis
data, with a 15-minute TTL. A miss, expiry, process restart, or
artifact/request mismatch is visible to the caller; the server does not
re-resolve access or silently recompute a replacement basis. If the bounded
cache cannot fit a valid calculation basis, calculate still returns the valid
v3 response without a reference header; evidence is then honestly unavailable
for that response rather than turning calculation into a 500.

The cache and the scheduled concurrency-one admission gate are initialized
through typed `globalThis` symbol slots. This allows independently emitted
Next App Router bundles in one process to share the same process-local state,
while preserving fail-closed behavior across workers and restarts.

## Rationale

Embedding every station area's itinerary in the surface would multiply the
response by the number of station areas and expose route detail that most
requests do not use. On-demand reconstruction keeps the v3 payload stable and
small while retaining enough server-only state to make a requested marker's
evidence exact and reproducible. It also makes the selection explicit: marker
boarding-stop identity and arrival seconds are authoritative, and detail
validation rejects any route that does not reconcile with them.

## Consequences and trade-offs

- The process-local cache is intentionally not a durable or distributed data
  store. A restart or another application process produces a visible `410`,
  requiring a new calculation. The global registry only prevents accidental
  duplicate state inside one process; it does not coordinate workers.
- Detail latency includes materializing one current 24-hour routing window,
  but it avoids repeating MVG nearby access resolution and avoids retaining a
  full schedule in every basis entry.
- The cache has explicit TTL, entry, and byte bounds. Oversized bases fail
  closed rather than becoming an unbounded memory path; cache pressure omits
  only the detail reference, never a valid v3 result.
- Ordinary earliest-arrival routing never retains witness maps or wrapper
  objects. Witness capture is enabled only for on-demand selected-stop
  reconstruction — at most the two participant boarding stops per detail
  request — and the captured maps are request-local, never stored in the
  calculation basis or cache.
- No-result and unclassified station areas are served directly from the
  cached public marker basis. They do not acquire admission, load an artifact,
  materialize a routing window, or invoke an access provider.
- Detail requests share the existing one-request admission gate and 30-second
  deadline. They are therefore deliberately serialized with full-feed
  calculations.
- Provenance is public and limited to the installed MVV artifact and nearby
  access provider descriptors. Credentials and detailed route trees remain
  server-only.

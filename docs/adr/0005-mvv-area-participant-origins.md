# ADR 0005 — MVV-area participant origins

Status: accepted.

## Context

`meeet-meeting/v3` previously required both participant origins to lie inside
the official Munich application boundary. That rejected Organisers who start
from elsewhere in the MVV area (for example Garching, Baldham, or Herrsching)
even though those trips are part of the same planned public-transport network
the calculation already uses.

The Munich boundary remains correct for the meeting destination, the fairness
surface, station-area candidates, markers, and territories: those are
Munich-clipped application geometry. Only the participant ORIGIN should be
relaxed to the wider MVV area.

## Decision

- `meeet-meeting/v3` accepts participant origins anywhere in the MVV area
  (external-Munich). The request parser keeps finite/range validation
  (latitude -90..90, longitude -180..180, finite numbers) and still rejects
  malformed coordinates, but it no longer applies the Munich boundary check to
  origins.
- The station-area Munich boundary checks in the response validator are
  unchanged: station-area candidates, markers, and the surface stay
  Munich-clipped.
- An external origin is usable only when MVG nearby resolves to a compiled-MVV
  artifact access seed. The existing access-seed gate
  (`lib/providers/mvg-scheduled-access.ts`) already enforces this: if no nearby
  station maps to an artifact station area, no access seeds are produced and the
  calculation returns an explicit `no-result` with reason `no-access-seeds`. The
  server does not add a separate boundary check for origins.
- The v3 response discloses the origin coverage contract via
  `metadata.origins = { coverage: "globally-valid-origin/v1" }`. The server
  emits and validates this field; the client consumes it without exposing the
  origin type.
- Autocomplete (`lib/providers/mvg-locations.ts`) retains external-Munich
  ADDRESS and STATION results regardless of the Munich boundary, while POI,
  other, unknown, and missing types stay Munich-filtered. The MVG `type` field
  is case-insensitive. The `LocationSearchResult` shape is unchanged (no type
  is exposed to the client).

## Out of scope

- `lib/providers/self-hosted-routing.ts` (route-first / self-hosted routing,
  Munich-boundary limited) is untouched; it is a separate, inactive contract
  path.
- `lib/domain/route-first/request-contract.ts` (route-first request contract,
  Munich coordinate validation) is untouched for the same reason.
- Client rendering of origin markers is already unclipped; no client surface,
  marker, or territory change is part of this decision.

## Consequences

- Organisers may start a meeting search from anywhere in the MVV area; the
  result surface remains a Munich meeting destination.
- External origins that cannot reach a compiled-MVV artifact station area fail
  closed with an explicit `no-result`.
- The response validator binds `metadata.origins.coverage` so a tampered or
  missing value is rejected.
- Server docs and provenance distinguish MVV-area origins from Munich-only
  destinations.

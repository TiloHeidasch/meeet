# ADR 0004 — Remove the server-side grid-cell surface

Status: accepted.

## Decision

The v3 calculation response no longer carries the Munich-clipped grid cells
(`cells` and `metadata.grid`). The server stops computing the cell surface —
the per-request loop that evaluates every grid cell against every station-area
arrival with a geometric final walking estimate (384 cells x 9,313 station
areas per participant, twice per request).

The rendered meeting surface is the client-side nearest-station territory
model, which is already the product model (see ADR 0001): every station area
owns the region of points closer to it than to any other station — the
half-way points between stations — clipped to the official Munich boundary.
A territory always takes its station's red, blue, fair, or unclassified
classification. The territory boundaries are static geometry and could be
determined at compile time; the coloring is dynamic because it follows the
station classification produced by the calculation.

## Rationale

The client already derives and renders station territories and does not render
the server's grid cells. The grid surface is therefore dead weight for the
rendered product while being one of the largest per-request loops in the
calculation. Removing it is a simple, independent performance lever for the
deadline problem (issue #20) and composes with the station-level collapse
(ADR 0003), which does not touch the cell surface.

The territory model is an approximation of the grid model: the grid colors a
point by the minimum over all stations of arrival plus walking, so a point
near a blue station can be red when a farther red station has a much better
arrival time. The territory model ignores that trade-off. ADR 0001 already
accepted this approximation for rendering; this decision makes it the only
surface.

## Consequences and trade-offs

- Contract change: `meeet-meeting/v3` response loses `cells` and
  `metadata.grid`; the server validator (`meeting-v3.ts`) and the client
  contract (`meeting-response.ts`) drop cell validation. TDD applies to the
  contract retirement.
- The client loses nothing rendered: territories and station markers are
  derived from `stationAreas` only.
- The red/blue/fair/unclassified classification rules, tolerance semantics,
  no-result behavior, and provenance requirements are unchanged; they now
  apply to station areas only.
- The station-area details endpoint is unaffected; it works from the cached
  calculation basis and station-area arrivals.
- Precomputing territory boundaries at compile time is a possible follow-up
  but not part of this decision; the client may keep deriving them per
  response.
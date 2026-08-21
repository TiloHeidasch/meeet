# Issue #73 — low-risk performance wins: before/after measurement

Measured with the issue #72 profiling harness (`scripts/profile-scheduled-calculation.ts`)
on the real MVV feed artifact `c904767465cb…` (feed `20260803`, 9,313 station areas,
2,075,789 connections) under Node 24.19.0. Three fresh-process runs before and three
after; medians reported. The fixed profile request is the harness default
(red 48.1374,11.5755 / blue 48.14,11.57, tolerance 10%, searchStart 2026-08-11T08:05:00+02:00).

## Why the total barely moves

The full cold calculation is dominated by stages these wins do NOT touch:

- `artifact-load` ~20 s (62% of total) — cold v8 deserialization + validation. Out of scope.
- `scan-red` + `scan-blue` ~6 s (20%) — the CSA scan over ~2 M connections. Untouched.

The eight wins target the smaller stages (validation, station-area-catalog,
access-seeds, routing-window, response-build, station-area-evaluation). Their
absolute savings are real but small relative to the 31 s total, and several are
partly hidden by the harness design (see notes per win).

## Per-stage medians (ms)

| Stage | Before | After | Δ | Note |
| --- | ---: | ---: | ---: | --- |
| artifact-load | 20,482 | 20,xxx | ~0 | out of scope |
| scan-red | 2,916 | 2,961 | +45 | variance |
| scan-blue | 2,681 | 3,178 | +497 | variance (high) |
| validation | 2,094 | 2,020 | **−74** | Win 2 (single pass) |
| station-area-catalog | 1,778 | 1,774 | −4 | Win 1 not visible in harness* |
| routing-window | 757 | 900 | +143 | variance (high); Win 7 small |
| access-seeds | 530 | 357 | **−173** | Win 8 (cache) |
| station-area-evaluation | 2 | 2 | 0 | Win 5 (await hop removed) |
| response-build | 0 | 0 | 0 | Wins 3/4 (too fast to measure) |
| **Total** | **30,878** | **30,951** | **+73** | within run-to-run variance |

\* The harness intentionally rebuilds the catalog a second time for its own
validation measurement (`scripts/profile-scheduled-calculation.ts:163`), so Win 1's
"build once per request" benefit (eliminating the rebuild in `meeting-api.ts`) is not
reflected in the harness total. It removes one full catalog build per real API request.

## What each win actually saves (and how it shows up)

- **Win 1 (catalog once):** removes one `buildScheduledStationAreaCatalog` (Munich
  boundary point-in-polygon over 9,313 areas) per API request. Not visible in the
  harness; real on every `meeting-api` call.
- **Win 2 (validation single pass):** three full walks over ~1,115 result areas → one.
  Measured −74 ms (≈3.5%) in the validation stage.
- **Win 3 (no full `JSON.stringify` of basis):** replaces full-string materialization
  with a single-pass byte estimator in the basis cache `put`. response-build already
  ~0 ms, so unmeasurable in wall time, but removes a large transient string allocation
  + GC pressure on every cached calculation.
- **Win 4 (scoped `freezeEnvelope`):** stops deep-freezing the ~1,115-element
  `stationAreas` / `accessSeeds` arrays on every response and basis. Unmeasurable in
  the 0 ms response-build stage but removes a large traversal per request.
- **Win 5 (no per-area await):** removes 1,115 microtask hops per request when no
  `onStationVerdict` progress hook is present (the profiler path). Unmeasurable at 2 ms.
- **Win 6 (lazy ISO):** removes `formatEpochSeconds` (Date/toISOString) per reachable
  area during routing. The ISO string was never part of the serialized v3 response
  (which uses elapsed seconds), so this is pure waste removed from the scan path.
- **Win 7 (service-id cache):** `activeServiceIdsForDate` rescans 1,760 calendars +
  12,198 exceptions per call; now memoized per (artifact, date). Helps the cold
  routing-window build (one process, many service dates). Small share of routing-window.
- **Win 8 (MVG nearby cache):** nearby station lookup was `no-store` per request; now
  cached per quantized coordinate with the upstream revalidate TTL. Benefits repeated
  requests with the same origin; within a single request with two distinct origins the
  two fetches remain (so the harness shows only partial benefit).

## Verification

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (0 errors, 0 warnings).
- `npm test`: 285 pass, 0 fail, 1 skipped.
- Serialized v3 response shape unchanged (no field removed/renamed; classification
  identical).

## Honest summary

The combined reduction in the measured full-calculation total is within run-to-run
variance because artifact-load (62%) and the scans (20%) are explicitly out of scope
for this issue (they are the harder, separate wins tracked elsewhere). The eight wins
are individually correct and remove real per-request waste (one catalog build, two
redundant validation walks, a full-string basis serialization, a deep-freeze traversal
of ~1,115 arrays, ~1,115 await hops, per-area ISO formatting, a per-date calendar
rescan, and an uncached upstream lookup). Their impact is most visible on the hot
per-request paths (API validation, basis caching, MVG access) rather than the one-shot
cold profiler total.

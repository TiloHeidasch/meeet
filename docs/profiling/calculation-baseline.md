# Calculation profiling baseline (issue #72)

Status: baseline recorded 2026-08-20.

## Purpose

A reproducible way to measure a full scheduled meeting calculation end-to-end
on the real MVV feed, and an evidence-based picture of where the time goes.
Every later optimization ticket must land with measured before/after evidence
(ADR 0003 requires profiling before and after). The performance goal is a full
calculation below 15 s; the current baseline is ~33 s.

## How to run

The harness is `scripts/profile-scheduled-calculation.ts`. It runs one cold
calculation per process: artifact load, access seeds (live MVG nearby),
station-area catalog, routing-window materialization, both participant scans,
participant surfaces, station-area evaluation, response build, validation, and
serialization.

Requirements:

- Node major 24. The scheduled artifact is written and loaded by Node 24
  (`loadScheduledArtifact` rejects any other major). The repo's `engines`
  range is `>=24 <25`.
- The real artifact at `data/scheduled/mvv-scheduled-artifact.json` (compile
  with `npm run schedule:compile:mvv`; the directory is gitignored).
- Live MVG nearby access for seed resolution (the real calculation is
  network-dependent; see Notes).

Commands:

```sh
npm run profile:calculation            # timing + heap deltas, JSON report
npm run profile:calculation:cpu        # + profiles/cpu-calculation-*.cpuprofile
npm run profile:calculation -- --heap-snapshots   # + per-stage heap snapshots
```

Output contract: the JSON report is written to
`profiles/report-<compiledArtifactId>-<timestamp>.json` and its path is
printed to stdout; a ranked timing table goes to stderr. Exit codes:
0 = success, 1 = calculation or validation failure, 2 = unsupported Node
major. `profiles/` is gitignored.

The CPU profile covers exactly the measured window (artifact load through
serialization) via `node:inspector`, so tsx/loader startup is not included.
Heap snapshots are written at stage boundaries; snapshot write time is
reported as separate `heap-snapshot:<stage>` rows so stage timings stay clean.

## Before/after protocol

For every optimization ticket:

1. Check out the target commit, compile the real feed if the artifact is
   missing or stale (`npm run schedule:compile:mvv`), and record the
   `compiledArtifactId` from the report.
2. Run the harness at least 3 times in fresh processes and take the median of
   each stage. Use the same fixed request (see below) and the same artifact.
3. Record the ranked stage table and the total in the ticket.
4. Implement the change, then repeat steps 1-3 on the same artifact identity.
5. Attribute the win: report the per-stage delta, not just the total.

The fixed profile request is hard-coded in the harness: red
(48.1374, 11.5755) / blue (48.14, 11.57), tolerance 10%, change time medium,
`searchStartAt = 2026-08-11T08:05:00+02:00` (a weekday morning inside the
artifact's routable coverage). Changing the request invalidates the baseline
comparison.

## Current baseline (2026-08-20)

Artifact: `c904767465cb…` (feed `20260803`, service range 2026-08-01..
2026-10-31, 9,313 station areas, 2,075,789 connections). Node 24.19.0.
Median of 3 fresh-process runs.

| Stage | Median ms | Share of total | Heap delta (bytes)¹ |
| --- | ---: | ---: | ---: |
| artifact-load | 20,482 | 62.3% | — |
| scan-blue | 3,497 | 10.6% | +117,458,488 |
| scan-red | 3,032 | 9.2% | +49,898,800 |
| validation | 2,069 | 6.3% | — |
| station-area-catalog | 1,584 | 4.8% | +53,852,896 |
| routing-window | 826 | 2.5% | +227,241,896 |
| access-seeds | 580 | 1.8% | +7,028,288 |
| station-area-evaluation | 8 | 0.0% | +3,145,920 |
| response-build | 1 | 0.0% | +1,629,440 |
| participant-surfaces | 0 | 0.0% | +2,368 |
| serialization | 0 | 0.0% | — |
| **Total** | **32,857** | 100% | ~+450 MB |

¹ Representative values from one run; heap deltas are GC-dependent and vary
between runs (a stage can even show a negative delta when GC runs inside it).
Use the heap snapshots for precise per-stage memory analysis.

Run-to-run variance is dominated by artifact-load (19.5-22.1 s across the
three runs; disk-cache dependent). The response is deterministic across runs:
status `ok`, 1,115 station areas, 303,872 serialized bytes, validation
success.

Note: the ~45 s figure in issue #72 was measured on the legacy boarding-stop
artifact. The current station-level artifact (ADR 0003) measures ~33 s; the
collapse already delivered part of the expected routing-phase win.

## Ranked hotspots and expected gains

Measured with the CPU profile of the same window (34,921 samples ≈ 34.9 s,
1 ms sampling) and the per-stage heap deltas above.

### 1. Artifact load — 20.5 s (62%)

Cold deserialization of the 804 MB v8 payload plus full structural
validation and content-hash recomputation on every load. The CPU profile
attributes ~15% of the window to `artifact.ts` validation
(`isSortedUnique`, `isExactRecordArray`, `isScheduledRoutingArtifact`,
`validateFreshness`) and ~10% to `gtfs.ts` content-hash work
(`writeCanonicalJson`), with heavy V8 hash-table churn underneath.

Options and expected gains:

- Skip redundant deep structural validation on load: the manifest already
  pins `payloadSha256` and the compiled identity; re-validating every
  connection/area/trip on each cold load is the tamper seam's cost. A
  validated-on-write trust model (manifest hash + spot checks) could save
  an estimated 10-15 s. Touches the tamper seam: TDD required.
- Persist a faster load format (e.g. pre-validated, pre-frozen, or
  columnar) instead of re-deriving structure from the v8 clone. Estimated
  5-10 s.
- The server amortizes this across requests (`loadedScheduledArtifacts`
  cache); the cost is paid once per process, so the e2e gate and any
  fresh-process benchmark see it in full.

### 2. Munich boundary point-in-polygon — ~10 s (29%)

`buildScheduledStationAreaCatalog` runs `isWithinOfficialMunichBoundary` for
all 9,313 station areas, and response validation re-checks each of the 1,115
result areas. Each check walks the district polygons
(`isPointInRing`/`isPointInPolygon` in `geo.ts`); the CPU profile shows the
boundary chain (`geo.ts` + `boundary.ts` frames) at ~29% of the window.

Options and expected gains:

- Precompute Munich membership at compile time: station areas are static per
  artifact, so the boundary filter can run once in the compiler and the
  result stored in the artifact. Catalog build becomes a sort + filter, and
  validation can trust the catalog. Estimated 8-10 s saved.
- Or index the boundary (grid/bounding-box prefilter) to make each check
  O(1)-ish instead of walking every district ring. Estimated 6-8 s saved.

### 3. Participant scans — 6.5 s combined (20%)

The CSA scan over ~2 M materialized connections. The CPU profile shows
pervasive V8 `update`/hash-table samples (31% of the window overall, shared
with artifact validation); the scan stages allocate the largest per-stage
heaps after the window (+50-117 MB each).

Options and expected gains:

- Replace the per-departure-bucket `byFromArea` Map with preallocated
  arrays keyed by area index; reuse Maps/Sets across buckets instead of
  rebuilding them. Estimated 2-4 s saved.
- The routing-window cache already makes repeated scans cheap; the baseline
  is the cold path.

### 4. Validation — 2.1 s (6%)

Response validation re-validates every station area including boundary
checks (see #2) and invariant checks. Dropping the redundant boundary
re-check (trusting the catalog) is the main lever; estimated 1-2 s.

### 5. Routing-window materialization — 0.8 s (2.5%)

Merging ~2 M connections across service days plus the spatial index build.
Already cheap; the heap delta (+227 MB) is the largest single allocation and
is retained for the scan. Not a priority.

### 6. Access seeds — 0.6 s (1.8%)

Network-bound MVG nearby calls; not an optimization target (external
dependency, and the guardrails forbid substituting seed resolution).

## Profile artifacts

The 2026-08-20 baseline artifacts live in `profiles/` (gitignored):

- `cpu-calculation-2026-08-20T15-40-30.239Z.cpuprofile` — calculation-window
  CPU profile (34,921 samples).
- `heap-<stage>.heapsnapshot` — one snapshot per pipeline stage boundary
  (heap grows from ~1.2 GB after artifact load to ~1.5 GB during routing).

Analyze the CPU profile with any DevTools/`node --prof-process`-compatible
tool. Note that tsx compiles each module to a single line, so function
frames map to `file.ts:1`; aggregate by function name, not line.
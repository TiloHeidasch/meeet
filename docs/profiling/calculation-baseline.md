# Calculation profiling baseline (issues #72 and #90)

Status: historical v1 baseline recorded 2026-08-20; the harness now emits v2.

## Purpose

A reproducible way to measure a full scheduled meeting calculation on the real
MVV feed, and an evidence-based picture of where the time goes. Every later
optimization ticket must land with measured before/after evidence (ADR 0003
requires profiling before and after). The performance goal is a full
calculation below 15 s; the historical v1 baseline is ~33 s.

## How to run

The parent harness is `scripts/profile-scheduled-calculation.ts`, and its
single-sample worker is
`scripts/profile-scheduled-calculation-worker.ts`. The parent launches three
sequential, fresh Node 24 child processes. Each child loads the same artifact
path exactly once, records its `compiledArtifactId`, then measures one first
request followed immediately by one warm request against that same immutable
artifact object. Both requests are strictly validated with the catalog carried
by their own `calculateScheduledMeetingWithBasis` result.

Those three children are deliberately uninstrumented and are the only samples
used for v2 timing, stage, and heap medians. If either diagnostic flag is
requested, the parent launches one separate fourth child/pair after the timing
children. That diagnostic pair is excluded from every timing/stage/heap
aggregate and is reported only under `diagnostics`.

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
npm run profile:calculation:cpu        # + one representative child/pair CPU profile
npm run profile:calculation -- --heap-snapshots   # + one post-pair heap snapshot
```

Output contract: the aggregate JSON report is written to
`profiles/report-<compiledArtifactId[:12]>-<timestamp>.json` and its path is
printed to stdout; a ranked timing table goes to stderr. Exit codes:
0 = success, 1 = calculation, validation, or child-process failure, 2 =
unsupported Node major. `profiles/` is gitignored. The aggregate report uses
`contractVersion: "meeet-calculation-profile/v2"` and
`schema: "fresh-process-paired-first-warm/v1"`.

The request timer starts after child startup, module loading, request parsing,
and artifact loading. It ends after the calculation, strict validation, and
response serialization. Child startup and artifact load are reported
separately and are not included in first/warm request medians.

`requestTimings.firstRequestMedianMs` is the median of three true
fresh-process first requests; `warmRequestMedianMs` is the median of the three
immediately subsequent requests in those same child processes. The report also
contains the canonical parsed v3 `request`, the access-provider descriptor and
per-child `accessProviderSamples`, process IDs, artifact IDs, artifact-load
measurements, request-stage medians, validation results, and paired request
summaries. The parent rejects any sample whose artifact path/identity, parsed
request, or access-provider provenance differs from the others. The principal
v2 fields are `request`, `accessProvider`, `accessProviderSamples`,
`artifact.sampleCompiledArtifactIds`, `artifactLoad`, `requestTimings`,
`stages.firstRequest`, `stages.warmRequest`, `validation.requests`, and
`diagnostics`.

The aggregate `accessProvider` is the stable descriptor identity; its volatile
per-child provenance retrieval timestamp is represented as
`<per-child-process>`. The raw descriptors observed by each child remain in
`accessProviderSamples` for auditability.

With `--inspector-cpu`, the separate fourth diagnostic child is CPU-profiled.
That child starts `node:inspector` after artifact load and immediately before
its first request, and stops it after the warm request timer ends; CPU-profile
write I/O is outside both request measurements. The resulting profile covers
one representative diagnostic first/warm pair, not child startup or any timing
sample.

With `--heap-snapshots`, the separate fourth diagnostic child writes one
representative snapshot after its warm request has completed (and after
CPU-profile stop, if enabled). No stage or request performs snapshot I/O, so
snapshot writing cannot alter timing-sample medians.

## Before/after protocol

For every optimization ticket:

1. Check out the target commit, compile the real feed if the artifact is
   missing or stale (`npm run schedule:compile:mvv`), and record the shared
   `compiledArtifactId` from the v2 report.
2. Run the harness once. It creates three fresh Node 24 child processes and
   takes first/warm medians from paired requests in those children. Use the
   same fixed request (see below) and the same artifact path.
3. Record the v2 first/warm medians and ranked first/warm stage tables in the
   ticket.
4. Implement the change, then repeat steps 1-3 on the same artifact identity.
5. Attribute the win: report the per-stage and first/warm deltas, not just a
   single total.

The fixed profile request is hard-coded in the worker: red
(48.1374, 11.5755) / blue (48.14, 11.57), tolerance 10%, change time medium,
`searchStartAt = 2026-08-11T08:05:00+02:00` (a weekday morning inside the
artifact's routable coverage). Changing the request invalidates the baseline
comparison.

## Historical v1 single-cold-request baseline (2026-08-20)

The table below is the old v1 baseline and is retained for historical
comparison. It is not a v2 first-request or warm-request result: v1 measured a
single cold request per run in a fresh process. Do not compare its `Total`
directly to either v2 request median without accounting for the protocol
change.

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
| inter-stage overhead | 778 | 2.4% | — |
| **Total** | **32,857** | 100% | ~+450 MB |

¹ Representative values from one run; heap deltas are GC-dependent and vary
between runs (a stage can even show a negative delta when GC runs inside it).
Use the heap snapshots for precise per-stage memory analysis.

² Inter-stage overhead (hook dispatch, GC pauses, and profiler/snapshot I/O
between measured stages) is the ~778 ms (2.4%) not captured by individual
stage rows; it is shown as its own row so stage shares sum to 100%.

Run-to-run variance is dominated by artifact-load (19.5-22.1 s across the
three runs; disk-cache dependent). The response is deterministic across runs:
status `ok`, 1,115 station areas, 303,872 serialized bytes, validation
success.

Note: the ~45 s figure in issue #72 was measured on the legacy boarding-stop
artifact. The current station-level artifact (ADR 0003) measures ~33 s; the
collapse already delivered part of the expected routing-phase win.

## Ranked hotspots and expected gains

Measured with the CPU profile of a single run (34,921 samples ≈ 34.9 s,
1 ms sampling — a single run, not the 3-run median; its ~34.9 s reflects
profiler start/stop bounds plus that run's artifact-load variance versus the
32.9 s median measured window) and the per-stage heap deltas above. CPU-profile frame
attribution can overstate a hotspot's wall-clock share relative to the
per-stage timings, which bound it; hotspot #2 is corrected accordingly (see
`calculation-baseline-aggregate.json`).

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

### 2. Munich boundary point-in-polygon — ~1.7 s (5%)

`buildScheduledStationAreaCatalog` runs `isWithinOfficialMunichBoundary` for
all 9,313 station areas, and response validation re-checks each of the 1,115
result areas. Each check walks the district polygons
(`isPointInRing`/`isPointInPolygon` in `geo.ts`). The boundary check is a
subset of the catalog-build and validation stages, whose measured wall-clock
time is 1,584 ms + 2,069 ms = 3,653 ms = 11.1% of the 32,857 ms total; the
boundary-specific portion is conservatively ~5% (~1.7 s). The earlier ~29%
CPU-profile frame attribution overstated wall-clock because those frames are
sampled inside stages whose total time is only 11.1% of the run (see
`calculation-baseline-aggregate.json`).

Options and expected gains:

- Precompute Munich membership at compile time: station areas are static per
  artifact, so the boundary filter can run once in the compiler and the
  result stored in the artifact. Catalog build becomes a sort + filter, and
  validation can trust the catalog. Estimated 1-2 s saved.
- Or index the boundary (grid/bounding-box prefilter) to make each check
  O(1)-ish instead of walking every district ring. Estimated 1-2 s saved.

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

## Historical v1 profile artifacts

The 2026-08-20 v1 baseline artifacts live in `profiles/` (gitignored):

- `cpu-calculation-2026-08-20T15-40-30.239Z.cpuprofile` — calculation-window
  CPU profile (34,921 samples).
- `heap-<stage>.heapsnapshot` — one snapshot per pipeline stage boundary in
  the old v1 harness (heap grows from ~1.2 GB after artifact load to ~1.5 GB
  during routing). The v2 harness writes at most one post-pair snapshot.

Analyze the CPU profile with any DevTools/`node --prof-process`-compatible
tool. Note that tsx compiles each module to a single line, so function
frames map to `file.ts:1`; aggregate by function name, not line.

## Issue #91 schema-aware artifact freeze profile (2026-08-21)

Three fresh Node 24.19.0 child processes ran the v2 harness after replacing
generic artifact deep-freezing with schema-aware traversal. The successful
command was:

```sh
NODE_OPTIONS=--conditions=react-server npm exec --yes --package=node@24 -- node --conditions=react-server node_modules/tsx/dist/cli.mjs scripts/profile-scheduled-calculation.ts
```

The same real artifact was used for every child:

- path: `data/scheduled/mvv-scheduled-artifact.json`
- `compiledArtifactId`: `88e0e6b01a3f92900c37fd6b2992601b8600551d207e78bd843396ead691512d`
- payload: `808,821,104` bytes
- counts: `9,313` station areas and `2,075,789` connections

Raw cold-load measurements from
`profiles/report-88e0e6b01a3f-2026-08-21T14-20-37.827Z.json`:

| Sample | Child process | Artifact-load elapsed (ms) | Artifact-load heap delta (bytes) |
| ---: | ---: | ---: | ---: |
| 1 | 59992 | 13,441 | 1,107,522,968 |
| 2 | 60034 | 13,369 | 1,065,253,712 |
| 3 | 60122 | 12,048 | 1,068,943,728 |
| **Median** | — | **13,369** | **1,068,943,728** |

The aggregate report recorded Node `24.19.0`, successful strictly validated
requests, and the same compiled artifact identity in all three children.

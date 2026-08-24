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
npm run profile:calculation            # timing + memory snapshots, JSON report
npm run profile:calculation:cpu        # + profiles/cpu-calculation-*.cpuprofile
npm run profile:calculation -- --heap-snapshots   # + per-stage heap snapshots
NODE_OPTIONS=--conditions=react-server node --expose-gc --import tsx scripts/profile-scheduled-calculation.ts
```

The last form enables the optional post-GC memory measurement. The harness
does not require `--expose-gc`; without it, the measurement is reported as
unavailable.

Output contract: the JSON report is written to
`profiles/report-<compiledArtifactId[:12]>-<timestamp>.json` and its path is
printed to stdout; a ranked timing table goes to stderr. Exit codes:
0 = success, 1 = calculation or validation failure, 2 = unsupported Node
major. `profiles/` is gitignored.

The CPU profile covers the profiled window (profiler start just before artifact
load through profiler stop just after serialization) via `node:inspector`, so
tsx/loader startup is not included. It is approximately the measured window; the
small difference is profiler start/stop overhead outside the measured stages.
Heap snapshots are written at stage boundaries; snapshot write time is
reported as separate `heap-snapshot:<stage>` rows so stage timings stay clean.
When a snapshot follows a completed stage, that stage is ended before the
snapshot starts, and the next stage's start time, memory, and GC counters are
captured only after snapshot work completes. Snapshot I/O therefore cannot
extend the following normal stage span.

## Report memory and routing metadata (issue #74)

Each stage measurement includes `memoryBefore`, `memoryAfter`, and
`memoryDelta` snapshots. Every snapshot records the Node
`process.memoryUsage()` values `rss`, `heapTotal`, `heapUsed`, `external`, and
`arrayBuffers`, in bytes. The existing `heapDeltaBytes` field remains as a
backwards-readable alias for `memoryDelta.heapUsed`.

The report records the normal calculation window's `connectionCount` and
`compactTableByteLength`. The harness obtains these from the cached immutable
window after the normal timing window and CPU profile have ended, so the lookup
is not included in the total or stage timings.

It also records `coldRoutingWindowProbe` after `totalElapsedMs` is captured.
The probe clears the routing-window cache and calls
`createScheduledRoutingWindow` with its sparse
`onMaterializationCheckpoint` instrumentation callback. That callback disables
caching and samples `process.memoryUsage()` every 2,048 materialized rows and
at the before/after boundaries. The probe reports
`materializationElapsedMs`, table connection and byte counts, `memoryBefore`,
`memoryAfter`, `memoryDelta`, `peakMemory`, and the corresponding GC fields.
It is a separate allocation measurement and is never part of a normal stage or
the normal total.

`peakMemory` is the maximum observed value for each memory-usage field at
those in-process checkpoints. It is not an OS-level peak measurement and can
miss a short-lived allocation between checkpoints. The compact table's
typed-array storage is included in `external`/`arrayBuffers` and RSS.

Every normal stage row and the cold-window probe has `gcBefore`, `gcAfter`,
and `gcDelta` fields. Each contains `count` and `totalPauseMs`, collected with
Node `perf_hooks.PerformanceObserver` from `gc` performance entries. The
observer is drained at measurement boundaries and disconnected when the run
ends; no special runtime flag is required for these observations. After all
normal timings and the cold probe, the harness calls `global.gc` when
available and records `postGcMemory.before`, `postGcMemory.after`, and
`postGcMemory.delta`; without `--expose-gc` (or another runtime that provides
`global.gc`) it records `postGcMemory.available: false`. GC is optional and is
never required to run the profile.

The compact routing table uses typed-array backing stores. Those allocations
are accounted for in `external`/`arrayBuffers` and RSS, not just the V8 heap,
so heap-only deltas understate the routing-window memory footprint.

## Before/after protocol

For every optimization ticket:

1. Check out the target commit, compile the real feed if the artifact is
   missing or stale (`npm run schedule:compile:mvv`), and record the
   `compiledArtifactId` from the report.
2. Run the harness three times in fresh Node 24 processes and take the median
   of each stage. Use the same fixed request (see below) and the same artifact.
3. Record the ranked stage table and the total in the ticket.
4. Implement the change, then repeat steps 1-3 on the same artifact identity.
5. Attribute the win: report the per-stage delta, not just the total.

The existing real-feed baseline above is not refreshed by the issue #74 report
schema change. No new real-feed result or baseline is recorded here when the
artifact is unavailable locally.

The fixed profile request is hard-coded in the harness: red
(48.1374, 11.5755) / blue (48.14, 11.57), tolerance 10%, change time medium,
`searchStartAt = 2026-08-11T08:05:00+02:00` (a weekday morning inside the
artifact's routable coverage). Changing the request invalidates the baseline
comparison.

## Issue #74 measured evidence (2026-08-24)

Measured with Node 24.19.0, real MVV feed `20260803`, and compiled artifact
`4441c627e8b91ab75932664361de2b670c39d2737eedb9db990ef91dc76c3e20` (2,075,789
artifact connections). The materialized windows contained 741,295 rows.
Node 24 is required. The matched fresh-process comparison used the exact same
artifact, request/options, process setup, and explicit GC before and after
window materialization; the baseline dynamically loaded the `origin/dev`
router.

| Direct window materialization | Samples (ms) | Median (ms) |
| --- | --- | ---: |
| Baseline (`origin/dev`) | 689, 4969, 4536 | 4536 |
| Current | 182, 1568, 1955 | 1568 |

The current median is 65.4% lower. Host artifact-load and RSS variance was
high; direct window timing deliberately excludes artifact load.

Baseline post-GC retained JS heap delta samples were
`[215304824, 207250608, 207437952]` bytes (median `207437952`). The current
compact table has a fixed retained size of `11860720` bytes. Immediate current
materialization heap deltas were roughly 19.8–21.1 MB, plus `45,398,768` bytes
of temporary array buffers; `11,860,720` bytes of array buffers remained after
GC. On these measured retained-size figures, the current window representation
is 94.3% smaller than the baseline median. The current profiler probe observed
zero collections during its materialization runs and reports GC counters for
future comparisons; no GC-count comparison is inferred here.

With identical 8/8 live-resolved access seeds, paired baseline/current scans
produced the same SHA-256
`956c0ae75a89e9440d5618b9eb31eb4ced6e955cfc983d49d401298c38b51387` over sorted
predecessor details and station arrivals. Both windows had 741,295 rows.

The current full-profile cold-window probe samples were `[1083, 1296, 1588]`
ms (median 1296 ms). The normal routing-window stage samples were
`[2712, 1978, 1995]` ms (median 1995 ms); this stage is not comparable to the
direct baseline because it includes full-calculation state.

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

## Profile artifacts

The 2026-08-20 baseline artifacts live in `profiles/` (gitignored):

- `cpu-calculation-2026-08-20T15-40-30.239Z.cpuprofile` — calculation-window
  CPU profile (34,921 samples).
- `heap-<stage>.heapsnapshot` — one snapshot per pipeline stage boundary
  (heap grows from ~1.2 GB after artifact load to ~1.5 GB during routing).

Analyze the CPU profile with any DevTools/`node --prof-process`-compatible
tool. Note that tsx compiles each module to a single line, so function
frames map to `file.ts:1`; aggregate by function name, not line.

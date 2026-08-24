# Calculation profiling baseline (issues #72, #74, and #90)

Status: historical v1 baseline recorded 2026-08-20; the harness now emits v2
paired request results and post-pair routing-cache-cold diagnostics.

## Purpose

A reproducible way to measure a full scheduled meeting calculation on the real
MVV feed, and an evidence-based picture of where the time and memory go. Every
later optimization ticket must land with measured before/after evidence (ADR
0003 requires profiling before and after). The performance goal is a full
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
used for v2 timing, stage, and heap medians. After both request timers end,
each timing child records one routing-window diagnostic pair: scalar metadata
from the normal window and a callback-bearing routing-cache-cold materialization
probe. If either diagnostic flag is requested, the parent launches one separate
fourth child/pair after the timing children. That diagnostic pair is excluded
from every timing/stage/heap aggregate and is reported only under
`diagnostics`; its `routingDiagnostics` value is `null`.

Requirements:

- Node major 24. The scheduled artifact is written and loaded by Node 24
  (`loadScheduledArtifact` rejects any other major). The repo's `engines`
  range is `>=24 <25`.
- The real artifact at `data/scheduled/mvv-scheduled-artifact.json` (compile
  with `npm run schedule:compile:mvv`; the directory is gitignored).
- Live MVG nearby access for seed resolution; the real calculation is
  network-dependent.

Commands:

```sh
npm run profile:calculation            # timing + heap deltas, JSON report
npm run profile:calculation:cpu        # + one representative child/pair CPU profile
npm run profile:calculation -- --heap-snapshots   # + one post-pair heap snapshot
NODE_OPTIONS=--conditions=react-server node --conditions=react-server --expose-gc --import tsx scripts/profile-scheduled-calculation.ts
```

The direct Node form enables the optional post-GC memory measurement in the
timing workers' post-pair probes. The harness does not require `--expose-gc`;
without it, the probe reports `postGcMemory.available: false`.

Output contract: the aggregate JSON report is written to
`profiles/report-<compiledArtifactId[:12]>-<timestamp>.json` and its path is
printed to stdout; a ranked timing table goes to stderr. Exit codes:
0 = success, 1 = calculation, validation, child-process, or probe failure, 2
= unsupported Node major. `profiles/` is gitignored. The aggregate report uses
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
`routingDiagnostics`, and `diagnostics`.

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

### Post-pair routing-window diagnostics

Each timing child records `routingDiagnostics` after its first/warm pair and
after both request timers have ended. It first retains only scalar metadata
(`connectionCount` and `compactTableByteLength`) from the normal cached routing
window, then clears the routing-window cache immediately before the probe. The
probe uses the same search start and routing options as the calculation and
materializes one instrumented compact window. It is routing-cache-cold, never
fresh-process cold. The sparse
`onMaterializationCheckpoint` callback disables caching and samples Node's
`process.memoryUsage()` every 2,048 materialized rows and at the before/after
boundaries.

The probe reports `connectionCount`, `compactTableByteLength`,
`materializedConnectionCount`, `materializationElapsedMs`, full memory
snapshots (`rss`, `heapTotal`, `heapUsed`, `external`, and `arrayBuffers`),
`memoryDelta`, and per-field `peakMemory`. The peak is the maximum at those
checkpoints, not an OS-level peak, and can miss a short-lived allocation
between checkpoints. Typed-array storage is included in
`external`/`arrayBuffers` and RSS.

It also reports `gcBefore`, `gcAfter`, and `gcDelta`, collected with Node
`perf_hooks.PerformanceObserver` from `gc` entries. The observer is drained at
boundaries and disconnected when the probe ends. If `global.gc` is available,
the child performs an explicit collection before the timed window and reports
`postGcMemory.before`, `postGcMemory.after`, and `postGcMemory.delta` after it;
otherwise `postGcMemory.available` is `false`. These GC and full-memory fields
belong to the post-pair probe, not to the v2 request-stage aggregates, whose
memory contract remains the worker's `heapDeltaBytes` measurement.

The `--expose-gc` direct command is optional. When present, the parent forwards
that flag to every worker before the direct Node `--import tsx` hook. Explicit GC is used only outside
the first/warm request timers, around the post-pair probe; no timing worker
runs GC inside a request boundary. The fourth CPU/heap diagnostic worker returns
`routingDiagnostics: null` and retains its current v2 behavior.

## Before/after protocol

For every optimization ticket:

1. Check out the target commit, compile the real feed if the artifact is
   missing or stale (`npm run schedule:compile:mvv`), and record the shared
   `compiledArtifactId` from the v2 report.
2. Run the harness once. It creates three fresh Node 24 child processes and
   takes first/warm medians from paired requests in those children. Use the
   same fixed request (see below) and the same artifact path.
3. Record the v2 first/warm medians, ranked first/warm stage tables, and the
   post-pair `routingDiagnostics` values in the ticket.
4. Implement the change, then repeat steps 1-3 on the same artifact identity.
5. Attribute the win: report the per-stage, first/warm, and—when relevant—cold
   window deltas, not just a single total.

The fixed profile request is hard-coded in the worker: red
(48.1374, 11.5755) / blue (48.14, 11.57), tolerance 10%, change time medium,
`searchStartAt = 2026-08-11T08:05:00+02:00` (a weekday morning inside the
artifact's routable coverage). Changing the request invalidates the baseline
comparison.

## Historical issue #74 v1 routing diagnostics (2026-08-24)

The following real-feed measurements are retained as historical issue #74
evidence. They were measured with Node 24.19.0, real MVV feed `20260803`, and
compiled artifact
`4441c627e8b91ab75932664361de2b670c39d2737eedb9db990ef91dc76c3e20` (2,075,789
artifact connections). The materialized windows contained 741,295 rows.

The v2 harness exposes compatible current-side quantities under each timing
child's post-pair `routingDiagnostics.coldRoutingWindowProbe`, including
`materializationElapsedMs`, `compactTableByteLength`, memory snapshots, and GC
fields. The sample table below came from the matched issue #74 historical v1
fresh-process comparison, not from a v2 aggregate report; it must not be
described as the v2 first/warm median.

| Direct window materialization | Samples (ms) | Median (ms) |
| --- | --- | ---: |
| Baseline (`origin/dev`) | 689, 4969, 4536 | 4536 |
| Current | 182, 1568, 1955 | 1568 |

The current median was 65.4% lower. Host artifact-load and RSS variance was
high; direct window timing deliberately excluded artifact load. Baseline
post-GC retained JS heap delta samples were
`[215304824, 207250608, 207437952]` bytes (median `207437952`). The current
compact table had a fixed retained size of `11860720` bytes. Immediate current
materialization heap deltas were roughly 19.8–21.1 MB, plus `45,398,768` bytes
of temporary array buffers; `11,860,720` bytes of array buffers remained after
GC. On these measured retained-size figures, the current window representation
was 94.3% smaller than the baseline median. The issue #74 profiler probe
observed zero collections during its materialization runs and reported GC
counters for future comparisons; no GC-count comparison was inferred.

With identical 8/8 live-resolved access seeds, paired baseline/current scans
produced the same SHA-256
`956c0ae75a89e9440d5618b9eb31eb4ced6e955cfc983d49d401298c38b51387` over sorted
predecessor details and station arrivals. Both windows had 741,295 rows.

The historical issue #74 full-profile cold-window probe samples were
`[1083, 1296, 1588]` ms (median 1296 ms). Its normal routing-window stage
samples were `[2712, 1978, 1995]` ms (median 1995 ms); that stage is not
comparable to the direct baseline because it includes full-calculation state.
For a current v2 run, use the report's three post-pair routing-cache-cold
probes and its first/warm stage aggregates instead.

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

Run-to-run variance is dominated by artifact-load (19.5-22.1 s across the
three runs; disk-cache dependent). The response is deterministic across runs:
status `ok`, 1,115 station areas, 303,872 serialized bytes, validation
success.

Note: the ~45 s figure in issue #72 was measured on the legacy boarding-stop
artifact. The current station-level artifact (ADR 0003) measures ~33 s; the
collapse already delivered part of the expected routing-phase win.

## Historical v1 profile artifacts and hotspots

The 2026-08-20 v1 artifacts live in `profiles/` (gitignored):

- `cpu-calculation-2026-08-20T15-40-30.239Z.cpuprofile` — calculation-window
  CPU profile (34,921 samples).
- `heap-<stage>.heapsnapshot` — one snapshot per pipeline stage boundary in
  the old v1 harness (heap grows from ~1.2 GB after artifact load to ~1.5 GB
  during routing). The v2 harness writes at most one post-pair snapshot.

The historical CPU profile and stage table identify artifact load (~20.5 s,
62%), participant scans (~6.5 s combined), Munich boundary checks (~1.7 s),
validation (~2.1 s), routing-window materialization (~0.8 s), and access seeds
(~0.6 s) as the principal measured areas. Those v1 values are not v2 request
medians. Analyze profiles with a DevTools/`node --prof-process`-compatible
tool; tsx compiles each module to a single line, so aggregate frames by
function name rather than line.

## Issue #91 schema-aware artifact freeze profile (2026-08-21)

The controlled comparison used the v2 protocol with the same `package-lock.json`
dependency resolution in two isolated temporary worktrees:

- `origin/dev` baseline at merge-base `6d75b36b829993be9e50a2c47bbaab4cc1abc7ba`
- current HEAD at `cce19f597de4e2bc2d38da4be286f75b176ef80d`

Each worktree ran `npm ci --no-audit --no-fund`, then ran the identical profile
command under Node 24.19.0:

```sh
NODE_OPTIONS=--conditions=react-server npm exec --yes --package=node@24 -- node --conditions=react-server node_modules/tsx/dist/cli.mjs scripts/profile-scheduled-calculation.ts
```

The real artifact source was `data/scheduled/mvv-scheduled-artifact.json`;
byte-identical copies were used in both worktrees. Its identity and shape were:

- `compiledArtifactId`:
  `88e0e6b01a3f92900c37fd6b2992601b8600551d207e78bd843396ead691512d`
- payload: `808,821,104` bytes
- counts: `9,313` station areas and `2,075,789` connections

The unchanged aggregate reports were preserved as ignored artifacts at:

- baseline: `profiles/report-88e0e6b01a3f-2026-08-21T14-34-46.634Z.json`
- current HEAD: `profiles/report-88e0e6b01a3f-2026-08-21T14-35-51.136Z.json`

Both reports contain three fresh child-process samples, Node `24.19.0`, three
matching `sampleCompiledArtifactIds`, and successful strict validation.

Raw baseline cold-load measurements (`origin/dev`):

| Sample | Child process | Artifact-load elapsed (ms) | Artifact-load heap delta (bytes) |
| ---: | ---: | ---: | ---: |
| 1 | 67003 | 12,076 | 1,061,983,872 |
| 2 | 67050 | 11,922 | 1,115,183,608 |
| 3 | 67069 | 11,839 | 1,115,042,784 |
| **Median** | — | **11,922** | **1,115,042,784** |

Raw current-HEAD cold-load measurements:

| Sample | Child process | Artifact-load elapsed (ms) | Artifact-load heap delta (bytes) |
| ---: | ---: | ---: | ---: |
| 1 | 67121 | 12,650 | 1,078,302,256 |
| 2 | 67200 | 12,351 | 1,046,724,472 |
| 3 | 67275 | 12,382 | 1,064,955,776 |
| **Median** | — | **12,382** | **1,064,955,776** |

After-minus-before median delta: **+460 ms** elapsed and
**−50,087,008 bytes** heap delta. These are independent fresh-process median
comparisons, not paired child measurements. Artifact-load elapsed time varied
across the three samples (11,839–12,076 ms before; 12,351–12,650 ms after),
and heap deltas are GC-dependent; the delta should therefore be read with that
sample variance in mind.

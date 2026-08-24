// Profiling harness for a full scheduled meeting calculation on the real MVV
// feed (issue #72). Reports stage-by-stage elapsed times, memory snapshots, and
// GC observations for one cold calculation: artifact load, access seeds,
// station-area catalog, routing-window materialization, both participant
// scans, participant surfaces, station-area evaluation, response build,
// validation, and serialization. A separate post-total probe measures a cold
// routing-window allocation with the router's sparse materialization
// checkpoint callback.
//
// Requirements:
// - Node major 24 (the scheduled artifact is written and loaded by Node 24).
// - The real artifact at data/scheduled/mvv-scheduled-artifact.json (see
//   `npm run schedule:compile:mvv`).
// - Live MVG nearby access (the real calculation resolves access seeds over
//   the network).
//
// Usage:
//   npm run profile:calculation
//   npm run profile:calculation:cpu        # also writes profiles/cpu-calculation-*.cpuprofile
//   npm run profile:calculation -- --heap-snapshots   # also writes per-stage heap snapshots
//   NODE_OPTIONS=--conditions=react-server node --expose-gc --import tsx scripts/profile-scheduled-calculation.ts
//
// The CPU profile covers exactly the measured window (artifact load through
// serialization) via node:inspector, so tsx/loader startup is not included.
//
// Output contract: the JSON report is written to
// profiles/report-<compiledArtifactId>-<timestamp>.json and its path is
// printed to stdout; human-readable progress goes to stderr. Exit codes:
// 0 = success, 1 = calculation or validation failure, 2 = unsupported Node
// major.

import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { resolve as resolvePath } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { writeHeapSnapshot } from "node:v8";

import { loadScheduledArtifact } from "../lib/domain/scheduled-routing/artifact.ts";
import {
  calculateScheduledMeetingWithBasis,
  type ScheduledCalculationStage,
} from "../lib/domain/scheduled-routing/meeting.ts";
import {
  clearScheduledRoutingWindowCache,
  createScheduledRoutingWindow,
  DEFAULT_TRANSFER_RADIUS_METERS,
  DEFAULT_WALKING_VELOCITY_METERS_PER_SECOND,
} from "../lib/domain/scheduled-routing/router.ts";
import { CHANGE_TIME_PRESETS } from "../lib/domain/scheduled-routing/models.ts";
import { buildScheduledStationAreaCatalog } from "../lib/domain/scheduled-routing/surface.ts";
import { elapsedMs } from "../lib/log.ts";
import { MvgScheduledAccessSeedProvider } from "../lib/providers/mvg-scheduled-access.ts";
import {
  parseScheduledMeetingRequest,
  validateScheduledMeetingResponse,
  type ScheduledMeetingRequest,
} from "../lib/validation/meeting-v3.ts";

const ARTIFACT_PATH = resolvePath("data/scheduled/mvv-scheduled-artifact.json");
const PROFILES_DIR = resolvePath("profiles");

// Fixed, reproducible request inside the artifact's routable coverage bounds
// (2026-08-01T04:08:01Z .. 2026-10-30T22:59:59Z). A weekday morning keeps the
// measured service day representative of full service.
const SEARCH_START_AT = "2026-08-11T08:05:00+02:00";

const REQUEST = {
  contractVersion: "meeet-meeting/v3",
  participants: [
    { id: "red", origin: { label: "Red", latitude: 48.1374, longitude: 11.5755 }, mode: "transit" },
    { id: "blue", origin: { label: "Blue", latitude: 48.14, longitude: 11.57 }, mode: "transit" },
  ],
  tolerancePercent: 10,
  changeTimePreset: "medium",
  searchStartAt: SEARCH_START_AT,
};

interface StageMeasurement {
  readonly stage: string;
  readonly elapsedMs: number;
  readonly heapDeltaBytes: number;
  readonly memoryBefore: MemorySnapshot;
  readonly memoryAfter: MemorySnapshot;
  readonly memoryDelta: MemoryDelta;
  readonly gcBefore: GcSnapshot;
  readonly gcAfter: GcSnapshot;
  readonly gcDelta: GcDelta;
}

interface MemorySnapshot {
  readonly rss: number;
  readonly heapTotal: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
}

interface MemoryDelta {
  readonly rss: number;
  readonly heapTotal: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
}

interface GcSnapshot {
  readonly count: number;
  readonly totalPauseMs: number;
}

interface GcDelta {
  readonly count: number;
  readonly totalPauseMs: number;
}

interface StageSpan {
  readonly stage: ScheduledCalculationStage;
  readonly startedAt: number;
  readonly memoryBefore: MemorySnapshot;
  readonly gcBefore: GcSnapshot;
}

interface ColdRoutingWindowProbe {
  readonly materializationElapsedMs: number;
  readonly connectionCount: number;
  readonly compactTableByteLength: number;
  readonly materializedConnectionCount: number;
  readonly sampleIntervalConnections: number;
  readonly checkpointSampleCount: number;
  readonly memoryBefore: MemorySnapshot;
  readonly memoryAfter: MemorySnapshot;
  readonly memoryDelta: MemoryDelta;
  /** Maximum observed value per process.memoryUsage field at sampled checkpoints. */
  readonly peakMemory: MemorySnapshot;
  readonly gcBefore: GcSnapshot;
  readonly gcAfter: GcSnapshot;
  readonly gcDelta: GcDelta;
}

const COLD_ROUTING_WINDOW_SAMPLE_INTERVAL = 2_048;

function main(): void {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor !== 24) {
    console.error(`[profile] the scheduled artifact is written and loaded by Node 24; run this harness under Node 24 (current major: ${nodeMajor}).`);
    process.exitCode = 2;
    return;
  }
  const heapSnapshots = process.argv.includes("--heap-snapshots");
  const cpuProfile = process.argv.includes("--inspector-cpu");
  mkdirSync(PROFILES_DIR, { recursive: true });

  const parsed = parseScheduledMeetingRequest(REQUEST);
  if (!parsed.success) {
    console.error(`[profile] the fixed profile request failed validation: ${JSON.stringify(parsed.issues)}`);
    process.exitCode = 1;
    return;
  }

  void run(parsed.data, heapSnapshots, cpuProfile).catch((error: unknown) => {
    console.error(`[profile] harness failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
  });
}

async function run(
  request: ScheduledMeetingRequest,
  heapSnapshots: boolean,
  cpuProfile: boolean,
): Promise<void> {
  const gc = createGcCollector();
  try {
    await runProfile(request, heapSnapshots, cpuProfile, gc);
  } finally {
    gc.disconnect();
  }
}

async function runProfile(
  request: ScheduledMeetingRequest,
  heapSnapshots: boolean,
  cpuProfile: boolean,
  gc: GcCollector,
): Promise<void> {
  const measurements: StageMeasurement[] = [];
  const recordStage = (
    stage: string,
    elapsedMsValue: number,
    memoryBefore: MemorySnapshot,
    memoryAfter: MemorySnapshot,
    gcBefore: GcSnapshot,
    gcAfter: GcSnapshot,
  ): void => {
    const memoryDelta = subtractMemorySnapshots(memoryAfter, memoryBefore);
    const gcDelta = subtractGcSnapshots(gcAfter, gcBefore);
    measurements.push({
      stage,
      elapsedMs: elapsedMsValue,
      heapDeltaBytes: memoryDelta.heapUsed,
      memoryBefore,
      memoryAfter,
      memoryDelta,
      gcBefore,
      gcAfter,
      gcDelta,
    });
  };

  const profiler = cpuProfile ? await startCpuProfiler() : null;
  const artifactLoadMemoryBefore = memorySnapshot();
  const artifactLoadGcBefore = gc.snapshot();
  const artifactLoadStartedAt = performance.now();
  const artifact = loadScheduledArtifact(ARTIFACT_PATH);
  const artifactLoadElapsedMs = elapsedMs(artifactLoadStartedAt);
  const artifactLoadMemoryAfter = memorySnapshot();
  const artifactLoadGcAfter = gc.snapshot();
  recordStage("artifact-load", artifactLoadElapsedMs, artifactLoadMemoryBefore, artifactLoadMemoryAfter, artifactLoadGcBefore, artifactLoadGcAfter);
  if (heapSnapshots) {
    const snapshotMemoryBefore = memorySnapshot();
    const snapshotGcBefore = gc.snapshot();
    const snapshotStartedAt = performance.now();
    writeHeapSnapshot(resolvePath(PROFILES_DIR, "heap-artifact-load.heapsnapshot"));
    const snapshotElapsedMs = elapsedMs(snapshotStartedAt);
    const snapshotMemoryAfter = memorySnapshot();
    const snapshotGcAfter = gc.snapshot();
    recordStage("heap-snapshot:artifact-load", snapshotElapsedMs, snapshotMemoryBefore, snapshotMemoryAfter, snapshotGcBefore, snapshotGcAfter);
  }

  // One cold calculation per process: drop any routing-window cache entries so
  // the measured window materialization is the real cold path.
  clearScheduledRoutingWindowCache();

  const access = new MvgScheduledAccessSeedProvider();
  const stageSpans: StageSpan[] = [];
  const hooks = {
    async onStage(stage: ScheduledCalculationStage): Promise<void> {
      if (stageSpans.length > 0) {
        // End the previous span before taking its optional snapshot. The next
        // span is initialized below, after snapshot I/O has completed.
        const previousEndedAt = performance.now();
        const previousMemoryAfter = memorySnapshot();
        const previousGcAfter = gc.snapshot();
        const previous = stageSpans[stageSpans.length - 1];
        recordStage(
          previous.stage,
          Math.trunc(previousEndedAt - previous.startedAt),
          previous.memoryBefore,
          previousMemoryAfter,
          previous.gcBefore,
          previousGcAfter,
        );
        if (heapSnapshots) {
          const snapshotMemoryBefore = memorySnapshot();
          const snapshotGcBefore = gc.snapshot();
          const snapshotStartedAt = performance.now();
          writeHeapSnapshot(resolvePath(PROFILES_DIR, `heap-${previous.stage}.heapsnapshot`));
          const snapshotElapsedMs = elapsedMs(snapshotStartedAt);
          const snapshotMemoryAfter = memorySnapshot();
          const snapshotGcAfter = gc.snapshot();
          recordStage(`heap-snapshot:${previous.stage}`, snapshotElapsedMs, snapshotMemoryBefore, snapshotMemoryAfter, snapshotGcBefore, snapshotGcAfter);
        }
      }
      // This is deliberately after heap-snapshot work so snapshot I/O and its
      // allocations cannot pollute the following normal stage span.
      const startedAt = performance.now();
      const memoryBefore = memorySnapshot();
      const gcBefore = gc.snapshot();
      stageSpans.push({ stage, startedAt, memoryBefore, gcBefore });
    },
  };

  const calculation = await calculateScheduledMeetingWithBasis(request, { artifact, access }, undefined, hooks);
  const calculationEndedAt = performance.now();
  const memoryAfterCalculation = memorySnapshot();
  const gcAfterCalculation = gc.snapshot();
  if (stageSpans.length > 0) {
    const lastSpan = stageSpans[stageSpans.length - 1];
    recordStage(
      lastSpan.stage,
      Math.trunc(calculationEndedAt - lastSpan.startedAt),
      lastSpan.memoryBefore,
      memoryAfterCalculation,
      lastSpan.gcBefore,
      gcAfterCalculation,
    );
    if (heapSnapshots) {
      const snapshotMemoryBefore = memorySnapshot();
      const snapshotGcBefore = gc.snapshot();
      const snapshotStartedAt = performance.now();
      writeHeapSnapshot(resolvePath(PROFILES_DIR, `heap-${lastSpan.stage}.heapsnapshot`));
      const snapshotElapsedMs = elapsedMs(snapshotStartedAt);
      const snapshotMemoryAfter = memorySnapshot();
      const snapshotGcAfter = gc.snapshot();
      recordStage(`heap-snapshot:${lastSpan.stage}`, snapshotElapsedMs, snapshotMemoryBefore, snapshotMemoryAfter, snapshotGcBefore, snapshotGcAfter);
    }
  }

  const validationMemoryBefore = memorySnapshot();
  const validationGcBefore = gc.snapshot();
  const validationStartedAt = performance.now();
  const stationAreaCatalog = buildScheduledStationAreaCatalog(artifact);
  const validation = validateScheduledMeetingResponse(calculation.response, request, { stationAreaCatalog });
  const validationElapsedMs = elapsedMs(validationStartedAt);
  const validationMemoryAfter = memorySnapshot();
  const validationGcAfter = gc.snapshot();
  recordStage("validation", validationElapsedMs, validationMemoryBefore, validationMemoryAfter, validationGcBefore, validationGcAfter);

  const serializationMemoryBefore = memorySnapshot();
  const serializationGcBefore = gc.snapshot();
  const serializationStartedAt = performance.now();
  const serialized = JSON.stringify(calculation.response);
  // This is the normal calculation total. Keep it immediately after response
  // serialization and before profiler stop or any profile/report metadata I/O.
  const totalElapsedMs = elapsedMs(artifactLoadStartedAt);
  const serializationElapsedMs = elapsedMs(serializationStartedAt);
  const serializationMemoryAfter = memorySnapshot();
  const serializationGcAfter = gc.snapshot();
  recordStage("serialization", serializationElapsedMs, serializationMemoryBefore, serializationMemoryAfter, serializationGcBefore, serializationGcAfter);

  const cpuProfilePath = profiler === null ? null : await stopCpuProfiler(profiler, serialized);
  // The calculation creates this window internally. This second call is a
  // cache lookup with matching defaults and deliberately happens after all
  // normal timings and the CPU profile have ended.
  const routingWindow = (() => {
    const window = createScheduledRoutingWindow(artifact, request.searchStartAt, {
      walkingVelocityMetersPerSecond: DEFAULT_WALKING_VELOCITY_METERS_PER_SECOND,
      transferRadiusMeters: DEFAULT_TRANSFER_RADIUS_METERS,
      changeTimeSeconds: CHANGE_TIME_PRESETS[request.changeTimePreset],
    });
    // Retain only scalar metadata so the cached wrapper can become
    // unreachable before the cold allocation probe clears the cache.
    return {
      connectionCount: window.connectionCount,
      compactTableByteLength: window.compactTableByteLength,
    };
  })();
  const coldRoutingWindowProbe = measureColdRoutingWindowProbe(artifact, request, gc);
  const postGcMemory = collectPostGcMemory();
  const report = {
    contractVersion: "meeet-calculation-profile/v1",
    nodeVersion: process.versions.node,
    artifact: {
      path: ARTIFACT_PATH,
      compiledArtifactId: artifact.provenance.compiledArtifactId,
      feedId: artifact.feedId,
      serviceDateRange: artifact.serviceDateRange,
      stationAreaCount: artifact.stationAreas.length,
      connectionCount: artifact.connections.length,
    },
    request: {
      searchStartAt: request.searchStartAt,
      tolerancePercent: request.tolerancePercent,
      changeTimePreset: request.changeTimePreset,
      participants: request.participants.map((participant) => ({
        id: participant.id,
        origin: participant.origin,
      })),
    },
    accessProvider: access.descriptor,
    stages: measurements,
    totalElapsedMs,
    routingWindow: {
      connectionCount: routingWindow.connectionCount,
      compactTableByteLength: routingWindow.compactTableByteLength,
    },
    coldRoutingWindowProbe,
    postGcMemory,
    response: {
      status: calculation.response.status,
      reason: calculation.response.reason,
      stationAreaCount: calculation.response.stationAreas.length,
      serializedByteLength: new TextEncoder().encode(serialized).byteLength,
    },
    validation: { success: validation.success },
    cpuProfilePath,
  };

  const reportPath = resolvePath(PROFILES_DIR, `report-${artifact.provenance.compiledArtifactId.slice(0, 12)}-${new Date().toISOString().replaceAll(":", "-")}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${reportPath}\n`);
  printRankedTable(measurements, totalElapsedMs);

  if (!validation.success) {
    console.error(`[profile] the calculated response failed strict validation: ${JSON.stringify(validation.issues)}`);
    process.exitCode = 1;
    return;
  }
  if (calculation.response.status !== "ok") {
    console.error(`[profile] the calculation returned status ${calculation.response.status} (reason=${calculation.response.reason}); the profile request must be a successful calculation.`);
    process.exitCode = 1;
  }
}

function memorySnapshot(): MemorySnapshot {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

function subtractMemorySnapshots(after: MemorySnapshot, before: MemorySnapshot): MemoryDelta {
  return {
    rss: after.rss - before.rss,
    heapTotal: after.heapTotal - before.heapTotal,
    heapUsed: after.heapUsed - before.heapUsed,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers,
  };
}

function subtractGcSnapshots(after: GcSnapshot, before: GcSnapshot): GcDelta {
  return {
    count: after.count - before.count,
    totalPauseMs: after.totalPauseMs - before.totalPauseMs,
  };
}

interface GcCollector {
  readonly snapshot: () => GcSnapshot;
  readonly disconnect: () => void;
}

function createGcCollector(): GcCollector {
  let count = 0;
  let totalPauseMs = 0;
  const consume = (entries: readonly PerformanceEntry[]): void => {
    for (const entry of entries) {
      count += 1;
      totalPauseMs += entry.duration;
    }
  };
  const observer = new PerformanceObserver((list) => consume(list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  return {
    snapshot: () => {
      // PerformanceObserver callbacks are asynchronous. Drain entries that
      // have not reached the callback before taking every boundary snapshot.
      consume(observer.takeRecords());
      return { count, totalPauseMs };
    },
    disconnect: () => {
      consume(observer.takeRecords());
      observer.disconnect();
    },
  };
}

function maxMemorySnapshots(left: MemorySnapshot, right: MemorySnapshot): MemorySnapshot {
  return {
    rss: Math.max(left.rss, right.rss),
    heapTotal: Math.max(left.heapTotal, right.heapTotal),
    heapUsed: Math.max(left.heapUsed, right.heapUsed),
    external: Math.max(left.external, right.external),
    arrayBuffers: Math.max(left.arrayBuffers, right.arrayBuffers),
  };
}

function measureColdRoutingWindowProbe(
  artifact: Parameters<typeof createScheduledRoutingWindow>[0],
  request: ScheduledMeetingRequest,
  gc: GcCollector,
): ColdRoutingWindowProbe {
  clearScheduledRoutingWindowCache();
  const memoryBefore = memorySnapshot();
  let peakMemory = memoryBefore;
  let checkpointSampleCount = 0;
  const capturePeakSample = (sample: MemorySnapshot): void => {
    peakMemory = maxMemorySnapshots(peakMemory, sample);
    checkpointSampleCount += 1;
  };
  capturePeakSample(memoryBefore);
  const gcBefore = gc.snapshot();
  let materializedConnectionCount = 0;
  const materializationStartedAt = performance.now();
  const window = createScheduledRoutingWindow(
    artifact,
    request.searchStartAt,
    {
      walkingVelocityMetersPerSecond: DEFAULT_WALKING_VELOCITY_METERS_PER_SECOND,
      transferRadiusMeters: DEFAULT_TRANSFER_RADIUS_METERS,
      changeTimeSeconds: CHANGE_TIME_PRESETS[request.changeTimePreset],
    },
    {
      // The checkpoint callback deliberately disables the router cache, making
      // this an allocation probe rather than another normal stage timing. It
      // observes the production compact-table path without per-row objects.
      onMaterializationCheckpoint: (count) => {
        materializedConnectionCount = count;
        capturePeakSample(memorySnapshot());
      },
    },
  );
  const materializationElapsedMs = elapsedMs(materializationStartedAt);
  const memoryAfter = memorySnapshot();
  capturePeakSample(memoryAfter);
  const gcAfter = gc.snapshot();
  return {
    materializationElapsedMs,
    connectionCount: window.connectionCount,
    compactTableByteLength: window.compactTableByteLength,
    materializedConnectionCount,
    sampleIntervalConnections: COLD_ROUTING_WINDOW_SAMPLE_INTERVAL,
    checkpointSampleCount,
    memoryBefore,
    memoryAfter,
    memoryDelta: subtractMemorySnapshots(memoryAfter, memoryBefore),
    peakMemory,
    gcBefore,
    gcAfter,
    gcDelta: subtractGcSnapshots(gcAfter, gcBefore),
  };
}

type PostGcMemoryReport =
  | { readonly available: false }
  | {
      readonly available: true;
      readonly before: MemorySnapshot;
      readonly after: MemorySnapshot;
      readonly delta: MemoryDelta;
    };

function collectPostGcMemory(): PostGcMemoryReport {
  const nodeGlobal = globalThis as typeof globalThis & { gc?: () => void };
  if (typeof nodeGlobal.gc !== "function") return { available: false };
  const before = memorySnapshot();
  nodeGlobal.gc();
  const after = memorySnapshot();
  return { available: true, before, after, delta: subtractMemorySnapshots(after, before) };
}

interface CpuProfilerSession {
  readonly session: Session;
}

function startCpuProfiler(): Promise<CpuProfilerSession> {
  const session = new Session();
  session.connect();
  return new Promise((resolve, reject) => {
    session.post("Profiler.enable", (enableError) => {
      if (enableError !== null) {
        reject(enableError);
        return;
      }
      session.post("Profiler.start", (startError) => {
        if (startError !== null) {
          reject(startError);
          return;
        }
        resolve({ session });
      });
    });
  });
}

function stopCpuProfiler(profiler: CpuProfilerSession, serialized: string): Promise<string> {
  return new Promise((resolve, reject) => {
    profiler.session.post("Profiler.stop", (stopError, profile) => {
      profiler.session.disconnect();
      if (stopError !== null) {
        reject(stopError);
        return;
      }
      const profilePath = resolvePath(PROFILES_DIR, `cpu-calculation-${new Date().toISOString().replaceAll(":", "-")}.cpuprofile`);
      writeFileSync(profilePath, `${JSON.stringify(profile)}\n`);
      console.error(`[profile] cpu profile written to ${profilePath} (${serialized.length} bytes serialized response)`);
      resolve(profilePath);
    });
  });
}

function printRankedTable(measurements: readonly StageMeasurement[], totalElapsedMs: number): void {
  const ranked = [...measurements].sort((left, right) => right.elapsedMs - left.elapsedMs);
  console.error("[profile] stage timings (ranked by elapsed ms):");
  for (const measurement of ranked) {
    const share = totalElapsedMs === 0 ? 0 : (measurement.elapsedMs / totalElapsedMs) * 100;
    console.error(`[profile]   ${measurement.stage.padEnd(28)} ${String(measurement.elapsedMs).padStart(8)} ms  ${share.toFixed(1).padStart(5)}%  heapDelta=${measurement.heapDeltaBytes} bytes`);
  }
  console.error(`[profile] total: ${totalElapsedMs} ms`);
}

void main();

// Profiling harness for a full scheduled meeting calculation on the real MVV
// feed (issue #72). Reports stage-by-stage elapsed times and heap deltas for
// one cold calculation: artifact load, access seeds, station-area catalog,
// routing-window materialization, both participant scans, participant
// surfaces, station-area evaluation, response build, validation, and
// serialization.
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
import { writeHeapSnapshot } from "node:v8";

import { loadScheduledArtifact } from "../lib/domain/scheduled-routing/artifact.ts";
import {
  calculateScheduledMeetingWithBasis,
  type ScheduledCalculationStage,
} from "../lib/domain/scheduled-routing/meeting.ts";
import { clearScheduledRoutingWindowCache } from "../lib/domain/scheduled-routing/router.ts";
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
}

interface StageSpan {
  readonly stage: ScheduledCalculationStage;
  readonly startedAt: number;
  readonly heapBefore: number;
}

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
  const measurements: StageMeasurement[] = [];
  const recordStage = (stage: string, elapsedMsValue: number, heapDeltaBytes: number): void => {
    measurements.push({ stage, elapsedMs: elapsedMsValue, heapDeltaBytes });
  };

  const profiler = cpuProfile ? await startCpuProfiler() : null;
  const artifactLoadHeapBefore = process.memoryUsage().heapUsed;
  const artifactLoadStartedAt = performance.now();
  const artifact = loadScheduledArtifact(ARTIFACT_PATH);
  const artifactLoadHeapDelta = process.memoryUsage().heapUsed - artifactLoadHeapBefore;
  recordStage("artifact-load", elapsedMs(artifactLoadStartedAt), artifactLoadHeapDelta);
  if (heapSnapshots) {
    const snapshotStartedAt = performance.now();
    writeHeapSnapshot(resolvePath(PROFILES_DIR, "heap-artifact-load.heapsnapshot"));
    recordStage("heap-snapshot:artifact-load", elapsedMs(snapshotStartedAt), 0);
  }

  // One cold calculation per process: drop any routing-window cache entries so
  // the measured window materialization is the real cold path.
  clearScheduledRoutingWindowCache();

  const access = new MvgScheduledAccessSeedProvider();
  const stageSpans: StageSpan[] = [];
  const hooks = {
    async onStage(stage: ScheduledCalculationStage): Promise<void> {
      const now = performance.now();
      const heapNow = process.memoryUsage().heapUsed;
      if (stageSpans.length > 0) {
        const previous = stageSpans[stageSpans.length - 1];
        recordStage(previous.stage, Math.trunc(now - previous.startedAt), heapNow - previous.heapBefore);
        if (heapSnapshots) {
          const snapshotStartedAt = performance.now();
          writeHeapSnapshot(resolvePath(PROFILES_DIR, `heap-${previous.stage}.heapsnapshot`));
          recordStage(`heap-snapshot:${previous.stage}`, elapsedMs(snapshotStartedAt), 0);
        }
      }
      stageSpans.push({ stage, startedAt: now, heapBefore: heapNow });
    },
  };

  const calculation = await calculateScheduledMeetingWithBasis(request, { artifact, access }, undefined, hooks);
  const calculationEndedAt = performance.now();
  const heapAfterCalculation = process.memoryUsage().heapUsed;
  if (stageSpans.length > 0) {
    const lastSpan = stageSpans[stageSpans.length - 1];
    recordStage(lastSpan.stage, Math.trunc(calculationEndedAt - lastSpan.startedAt), heapAfterCalculation - lastSpan.heapBefore);
    if (heapSnapshots) {
      const snapshotStartedAt = performance.now();
      writeHeapSnapshot(resolvePath(PROFILES_DIR, `heap-${lastSpan.stage}.heapsnapshot`));
      recordStage(`heap-snapshot:${lastSpan.stage}`, elapsedMs(snapshotStartedAt), 0);
    }
  }

  const validationStartedAt = performance.now();
  const stationAreaCatalog = buildScheduledStationAreaCatalog(artifact);
  const validation = validateScheduledMeetingResponse(calculation.response, request, { stationAreaCatalog });
  recordStage("validation", elapsedMs(validationStartedAt), 0);

  const serializationStartedAt = performance.now();
  const serialized = JSON.stringify(calculation.response);
  recordStage("serialization", elapsedMs(serializationStartedAt), 0);

  const totalElapsedMs = elapsedMs(artifactLoadStartedAt);
  const cpuProfilePath = profiler === null ? null : await stopCpuProfiler(profiler, serialized);
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
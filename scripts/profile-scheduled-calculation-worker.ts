// One fresh-process sample for profile-scheduled-calculation.ts. This file is
// intentionally a separate entry point: the parent must be able to prove that
// every first request starts in a new Node 24 process, rather than merely
// clearing in-process caches.

import { writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { writeHeapSnapshot } from "node:v8";

import { loadScheduledArtifact } from "../lib/domain/scheduled-routing/artifact.ts";
import {
  calculateScheduledMeetingWithBasis,
  type ScheduledCalculationStage,
} from "../lib/domain/scheduled-routing/meeting.ts";
import { clearScheduledRoutingWindowCache } from "../lib/domain/scheduled-routing/router.ts";
import { clearScheduledStationAreaCatalogCache } from "../lib/domain/scheduled-routing/surface.ts";
import { elapsedMs } from "../lib/log.ts";
import { MvgScheduledAccessSeedProvider } from "../lib/providers/mvg-scheduled-access.ts";
import {
  parseScheduledMeetingRequest,
  validateScheduledMeetingResponse,
  type ScheduledMeetingRequest,
} from "../lib/validation/meeting-v3.ts";

const ARTIFACT_PATH = resolvePath("data/scheduled/mvv-scheduled-artifact.json");
const PROFILES_DIR = resolvePath("profiles");
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

type RequestKind = "first" | "warm";

interface StageMeasurement {
  readonly stage: string;
  readonly requestKind: RequestKind;
  readonly elapsedMs: number;
  readonly heapDeltaBytes: number;
}

interface StageSpan {
  readonly stage: ScheduledCalculationStage;
  readonly startedAt: number;
  readonly heapBefore: number;
}

interface RequestMeasurement {
  readonly sample: number;
  readonly requestKind: RequestKind;
  readonly elapsedMs: number;
  readonly calculationElapsedMs: number;
  readonly validationElapsedMs: number;
  readonly serializationElapsedMs: number;
  readonly heapDeltaBytes: number;
  readonly status: "ok" | "no-result";
  readonly reason: "no-access-seeds" | "no-reachable-stations" | null;
  readonly validationSuccess: boolean;
  readonly validationIssues: readonly unknown[] | null;
  readonly serializedByteLength: number;
  readonly stationAreaCatalogEntryCount: number;
}

interface CpuProfilerSession {
  readonly session: Session;
}

function main(): void {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor !== 24) {
    console.error(`[profile-worker] the scheduled artifact requires Node 24 (current major: ${nodeMajor}).`);
    process.exitCode = 2;
    return;
  }
  try {
    const sample = parseIntegerArgument("--sample");
    const outputPath = parseStringArgument("--output");
    const diagnostic = process.argv.includes("--diagnostic");
    const heapSnapshots = process.argv.includes("--heap-snapshots");
    const cpuProfile = process.argv.includes("--inspector-cpu");
    void run(sample, outputPath, diagnostic, heapSnapshots, cpuProfile).catch((error: unknown) => {
      console.error(`[profile-worker] failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      process.exitCode = 1;
    });
  } catch (error: unknown) {
    console.error(`[profile-worker] failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
  }
}

async function run(sample: number, outputPath: string, diagnostic: boolean, heapSnapshots: boolean, cpuProfile: boolean): Promise<void> {
  const parsed = parseScheduledMeetingRequest(REQUEST);
  if (!parsed.success) throw new Error(`The fixed profile request failed validation: ${JSON.stringify(parsed.issues)}`);

  const artifactLoadHeapBefore = process.memoryUsage().heapUsed;
  const artifactLoadStartedAt = performance.now();
  const artifact = loadScheduledArtifact(ARTIFACT_PATH);
  const artifactLoadElapsedMs = elapsedMs(artifactLoadStartedAt);
  const artifactLoadHeapDeltaBytes = process.memoryUsage().heapUsed - artifactLoadHeapBefore;

  // This child is fresh already; these explicit resets document and enforce
  // that the first request starts on the cold catalog/window path.
  clearScheduledStationAreaCatalogCache();
  clearScheduledRoutingWindowCache();
  const access = new MvgScheduledAccessSeedProvider();
  const stageMeasurements: StageMeasurement[] = [];
  const profiler = cpuProfile ? await startCpuProfiler() : null;
  const firstRequest = await runRequest(parsed.data, artifact, access, sample, "first", stageMeasurements);
  const warmRequest = await runRequest(parsed.data, artifact, access, sample, "warm", stageMeasurements);
  const cpuProfilePath = profiler === null ? null : await stopCpuProfiler(profiler);

  // Snapshot I/O happens only after both request timers have ended and after
  // the CPU profile has stopped. It cannot perturb the warm measurement.
  const heapSnapshotPath = heapSnapshots
    ? resolvePath(PROFILES_DIR, `heap-profile-sample-${sample}-${new Date().toISOString().replaceAll(":", "-")}.heapsnapshot`)
    : null;
  if (heapSnapshotPath !== null) writeHeapSnapshot(heapSnapshotPath);

  const report = {
    contractVersion: "meeet-calculation-profile-child/v2" as const,
    nodeVersion: process.versions.node,
    processId: process.pid,
    diagnostic,
    request: parsed.data,
    accessProvider: access.descriptor,
    artifact: {
      path: ARTIFACT_PATH,
      compiledArtifactId: artifact.provenance.compiledArtifactId,
      feedId: artifact.feedId,
      serviceDateRange: artifact.serviceDateRange,
      stationAreaCount: artifact.stationAreas.length,
      connectionCount: artifact.connections.length,
    },
    artifactLoad: {
      elapsedMs: artifactLoadElapsedMs,
      heapDeltaBytes: artifactLoadHeapDeltaBytes,
    },
    firstRequest,
    warmRequest,
    stages: stageMeasurements,
    cpuProfilePath,
    heapSnapshotPath,
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  const requests = [firstRequest, warmRequest];
  const failedValidation = requests.find((request) => !request.validationSuccess);
  if (failedValidation !== undefined) {
    console.error(`[profile-worker] ${failedValidation.requestKind} request failed strict validation: ${JSON.stringify(failedValidation.validationIssues)}`);
    process.exitCode = 1;
    return;
  }
  const failedStatus = requests.find((request) => request.status !== "ok");
  if (failedStatus !== undefined) {
    console.error(`[profile-worker] ${failedStatus.requestKind} request returned status ${failedStatus.status} (reason=${failedStatus.reason}).`);
    process.exitCode = 1;
  }
}

async function runRequest(
  request: ScheduledMeetingRequest,
  artifact: NonNullable<Parameters<typeof calculateScheduledMeetingWithBasis>[1]["artifact"]>,
  access: MvgScheduledAccessSeedProvider,
  sample: number,
  requestKind: RequestKind,
  stageMeasurements: StageMeasurement[],
): Promise<RequestMeasurement> {
  const requestHeapBefore = process.memoryUsage().heapUsed;
  const stageSpans: StageSpan[] = [];
  const recordStage = (stage: string, startedAt: number, heapBefore: number, endedAt: number, heapAfter: number): void => {
    stageMeasurements.push({
      stage,
      requestKind,
      elapsedMs: Math.trunc(endedAt - startedAt),
      heapDeltaBytes: heapAfter - heapBefore,
    });
  };
  const finishLastStage = (endedAt: number, heapAfter: number): void => {
    const lastSpan = stageSpans[stageSpans.length - 1];
    if (lastSpan !== undefined) recordStage(lastSpan.stage, lastSpan.startedAt, lastSpan.heapBefore, endedAt, heapAfter);
  };
  const hooks = {
    async onStage(stage: ScheduledCalculationStage): Promise<void> {
      const now = performance.now();
      const heapNow = process.memoryUsage().heapUsed;
      const previous = stageSpans[stageSpans.length - 1];
      if (previous !== undefined) finishLastStage(now, heapNow);
      stageSpans.push({ stage, startedAt: now, heapBefore: heapNow });
    },
  };

  // No snapshot I/O occurs after this timer starts. Stage hooks only collect
  // scalar timestamps/heap and do not perform disk work.
  const requestStartedAt = performance.now();
  const calculationStartedAt = performance.now();
  const calculation = await calculateScheduledMeetingWithBasis(request, { artifact, access }, undefined, hooks);
  const calculationElapsedMs = elapsedMs(calculationStartedAt);
  finishLastStage(performance.now(), process.memoryUsage().heapUsed);

  const validationStartedAt = performance.now();
  const validation = validateScheduledMeetingResponse(calculation.response, request, {
    stationAreaCatalog: calculation.stationAreaCatalog,
  });
  const validationElapsedMs = elapsedMs(validationStartedAt);

  const serializationStartedAt = performance.now();
  const serialized = JSON.stringify(calculation.response);
  const serializationElapsedMs = elapsedMs(serializationStartedAt);
  const requestElapsedMs = elapsedMs(requestStartedAt);
  const serializedByteLength = new TextEncoder().encode(serialized).byteLength;

  return {
    sample,
    requestKind,
    elapsedMs: requestElapsedMs,
    calculationElapsedMs,
    validationElapsedMs,
    serializationElapsedMs,
    heapDeltaBytes: process.memoryUsage().heapUsed - requestHeapBefore,
    status: calculation.response.status,
    reason: calculation.response.reason,
    validationSuccess: validation.success,
    validationIssues: validation.success ? null : validation.issues,
    serializedByteLength,
    stationAreaCatalogEntryCount: calculation.stationAreaCatalog.entries.length,
  };
}

function parseIntegerArgument(name: string): number {
  const value = parseStringArgument(name);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parseStringArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required.`);
  return value;
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

function stopCpuProfiler(profiler: CpuProfilerSession): Promise<string> {
  return new Promise((resolve, reject) => {
    profiler.session.post("Profiler.stop", (stopError, profile) => {
      profiler.session.disconnect();
      if (stopError !== null) {
        reject(stopError);
        return;
      }
      const profilePath = resolvePath(PROFILES_DIR, `cpu-calculation-sample-${new Date().toISOString().replaceAll(":", "-")}.cpuprofile`);
      writeFileSync(profilePath, `${JSON.stringify(profile)}\n`);
      console.error(`[profile-worker] cpu profile written to ${profilePath}`);
      resolve(profilePath);
    });
  });
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && resolvePath(entrypoint) === resolvePath(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) void main();

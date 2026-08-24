import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";

import {
  aggregateProfile,
  buildWorkerLaunch,
  collectProfileSamples,
  EXPECTED_CALCULATION_STAGES,
  ROUTING_WINDOW_SAMPLE_INTERVAL_CONNECTIONS,
  validateChildProfileReport,
  type ChildProfileReport,
  type ChildRunRequest,
  type RoutingDiagnostics,
  type StageMeasurement,
} from "../scripts/profile-scheduled-calculation-protocol.ts";
import { hasExposeGc } from "../scripts/profile-scheduled-calculation.ts";
import {
  FIXTURE_SCHEDULED_ACCESS_PROVIDER,
  FIXTURE_SCHEDULED_ARTIFACT,
} from "../lib/fixtures/scheduled-routing.ts";
import { createScheduledRoutingWindow } from "../lib/domain/scheduled-routing/router.ts";
import { parseScheduledMeetingRequest, type ScheduledMeetingRequest } from "../lib/validation/meeting-v3.ts";

const REQUEST = {
  contractVersion: "meeet-meeting/v3",
  participants: [
    { id: "red", origin: { label: "Red", latitude: 48.1374, longitude: 11.5755 }, mode: "transit" },
    { id: "blue", origin: { label: "Blue", latitude: 48.14, longitude: 11.57 }, mode: "transit" },
  ],
  tolerancePercent: 10,
  changeTimePreset: "medium",
  searchStartAt: "2026-08-11T08:05:00+02:00",
};

test("profile protocol smoke test uses fresh timing children and excludes diagnostics from v2 medians", () => {
  const parsed = parseScheduledMeetingRequest(REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) throw new Error("Fixture profile request unexpectedly failed validation.");

  const launches: ChildRunRequest[] = [];
  const collection = collectProfileSamples({
    cpuProfile: true,
    heapSnapshots: false,
    runChild(request) {
      launches.push(request);
      return fixtureChildReport(parsed.data, request, 10_000 + request.sample);
    },
  });

  assert.deepEqual(launches, [
    { sample: 1, diagnostic: false, cpuProfile: false, heapSnapshots: false },
    { sample: 2, diagnostic: false, cpuProfile: false, heapSnapshots: false },
    { sample: 3, diagnostic: false, cpuProfile: false, heapSnapshots: false },
    { sample: 4, diagnostic: true, cpuProfile: true, heapSnapshots: false },
  ]);
  assert.deepEqual(collection.timingSamples.map((sample) => sample.report.processId), [10_001, 10_002, 10_003]);
  assert.equal(collection.diagnosticSample?.report.processId, 10_004);

  const aggregate = aggregateProfile(collection);
  assert.equal(aggregate.contractVersion, "meeet-calculation-profile/v2");
  assert.equal(aggregate.requestTimings.sampleCount, 3);
  assert.equal(aggregate.requestTimings.firstRequestMedianMs, 12);
  assert.equal(aggregate.requestTimings.warmRequestMedianMs, 7);
  assert.equal(aggregate.stages.firstRequest.every((stage) => stage.sampleCount === 3), true);
  assert.equal(aggregate.stages.warmRequest.every((stage) => stage.sampleCount === 3), true);
  assert.deepEqual(aggregate.routingDiagnostics.map((diagnostics) => diagnostics.coldRoutingWindowProbe.processId), [10_001, 10_002, 10_003]);
  const fixtureProbe = collection.timingSamples[0]?.report.routingDiagnostics?.coldRoutingWindowProbe;
  assert.equal(fixtureProbe?.sampleIntervalConnections, ROUTING_WINDOW_SAMPLE_INTERVAL_CONNECTIONS);
  assert.equal(fixtureProbe?.checkpointSampleCount, Math.floor((fixtureProbe?.materializedConnectionCount ?? 0) / ROUTING_WINDOW_SAMPLE_INTERVAL_CONNECTIONS) + 3);
  assert.equal(aggregate.diagnostics?.sample, 4);
  assert.equal(aggregate.diagnostics?.cpuProfilePath !== null, true);
  assert.equal(collection.diagnosticSample?.report.routingDiagnostics, null);
  assert.deepEqual(aggregate.artifact.sampleCompiledArtifactIds, [
    FIXTURE_SCHEDULED_ARTIFACT.provenance.compiledArtifactId,
    FIXTURE_SCHEDULED_ARTIFACT.provenance.compiledArtifactId,
    FIXTURE_SCHEDULED_ARTIFACT.provenance.compiledArtifactId,
  ]);
  assert.deepEqual(aggregate.request, parsed.data);
  assert.equal(aggregate.accessProvider.name, FIXTURE_SCHEDULED_ACCESS_PROVIDER.descriptor.name);

  const launch = buildWorkerLaunch({
    nodePath: "/node",
    workerPath: "/repo/scripts/profile-scheduled-calculation-worker.ts",
    outputPath: "/tmp/sample.json",
    request: { sample: 4, diagnostic: true, cpuProfile: true, heapSnapshots: true },
  });
  assert.equal(launch.command, "/node");
  assert.deepEqual(launch.args, [
    "--conditions=react-server",
    "--import",
    "tsx",
    "/repo/scripts/profile-scheduled-calculation-worker.ts",
    "--sample",
    "4",
    "--output",
    "/tmp/sample.json",
    "--diagnostic",
    "--inspector-cpu",
    "--heap-snapshots",
  ]);
  const gcLaunch = buildWorkerLaunch({
    nodePath: "/node",
    workerPath: "/repo/scripts/profile-scheduled-calculation-worker.ts",
    outputPath: "/tmp/sample.json",
    request: { sample: 1, diagnostic: false, cpuProfile: false, heapSnapshots: false },
    exposeGc: true,
  });
  assert.deepEqual(gcLaunch.args.slice(0, 4), [
    "--conditions=react-server",
    "--expose-gc",
    "--import",
    "tsx",
  ]);
  assert.equal(gcLaunch.args[4], "/repo/scripts/profile-scheduled-calculation-worker.ts");
});

test("profile worker launch executes a TypeScript worker with forwarded arguments and GC", () => {
  const temporaryDirectory = mkdtempSync(resolvePath(tmpdir(), "meeet-profile-launch-"));
  const workerPath = resolvePath(temporaryDirectory, "worker.ts");
  const outputPath = resolvePath(temporaryDirectory, "worker-report.json");
  writeFileSync(workerPath, `
import { writeFileSync } from "node:fs";

const nodeGlobal = globalThis as typeof globalThis & { gc?: () => void };
const language: "typescript" = "typescript";
const sampleIndex = process.argv.indexOf("--sample");
const outputIndex = process.argv.indexOf("--output");
const sample: number = Number(process.argv[sampleIndex + 1]);
const output = process.argv[outputIndex + 1];
if (!Number.isSafeInteger(sample) || output === undefined) throw new Error("worker arguments were not forwarded");
writeFileSync(output, JSON.stringify({ language, sample, output, gc: typeof nodeGlobal.gc === "function" }));
`);
  try {
    const launch = buildWorkerLaunch({
      nodePath: process.execPath,
      workerPath,
      outputPath,
      request: { sample: 17, diagnostic: false, cpuProfile: false, heapSnapshots: false },
      exposeGc: true,
    });
    const result = spawnSync(launch.command, [...launch.args], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=react-server`.trim() },
      stdio: ["ignore", "ignore", "pipe"],
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), {
      language: "typescript",
      sample: 17,
      output: outputPath,
      gc: true,
    });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("profile GC forwarding follows the parent runtime capability and stays before the import hook", () => {
  const nodeGlobal = globalThis as typeof globalThis & { gc?: () => void };
  const gcAvailable = typeof nodeGlobal.gc === "function";
  const launch = buildWorkerLaunch({
    nodePath: "/node",
    workerPath: "/repo/scripts/profile-scheduled-calculation-worker.ts",
    outputPath: "/tmp/sample.json",
    request: { sample: 1, diagnostic: false, cpuProfile: false, heapSnapshots: false },
    exposeGc: hasExposeGc(),
  });
  const gcFlagIndex = launch.args.indexOf("--expose-gc");
  const importIndex = launch.args.indexOf("--import");
  assert.equal(gcFlagIndex >= 0, gcAvailable);
  assert.equal(gcFlagIndex < 0 || gcFlagIndex < importIndex, true);
  assert.equal(launch.args[importIndex + 1], "tsx");
});

test("profile probe report accepts checkpoint events from an actual routing-window producer", () => {
  const parsed = parseScheduledMeetingRequest(REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) throw new Error("Fixture profile request unexpectedly failed validation.");

  const sourceConnection = FIXTURE_SCHEDULED_ARTIFACT.connections[0];
  if (sourceConnection === undefined) throw new Error("Fixture schedule unexpectedly has no connections.");
  const connectionCount = ROUTING_WINDOW_SAMPLE_INTERVAL_CONNECTIONS + 2;
  const checkpointArtifact = {
    ...FIXTURE_SCHEDULED_ARTIFACT,
    connections: Array.from({ length: connectionCount }, (_, index) => ({
      ...sourceConnection,
      id: `profile-checkpoint-${index}`,
    })),
  };
  const checkpointEvents: number[] = [];
  const window = createScheduledRoutingWindow(checkpointArtifact, parsed.data.searchStartAt, {}, {
    onMaterializationCheckpoint: (count) => checkpointEvents.push(count),
  });

  // The callback producer, rather than the protocol formula, supplies these
  // events. The report also includes the worker's initial and final memory
  // samples around the callback-bearing routing-window invocation.
  assert.equal(window.connectionCount, connectionCount);
  assert.deepEqual(checkpointEvents, [ROUTING_WINDOW_SAMPLE_INTERVAL_CONNECTIONS, connectionCount]);
  const report = fixtureChildReport(parsed.data, { sample: 1, diagnostic: false, cpuProfile: false, heapSnapshots: false }, 40_001);
  const diagnostics = report.routingDiagnostics;
  if (diagnostics === null) throw new Error("Fixture timing report unexpectedly has no routing diagnostics.");
  const actualReport = {
    ...report,
    artifact: { ...report.artifact, connectionCount: window.connectionCount },
    routingDiagnostics: {
      routingWindow: {
        connectionCount: window.connectionCount,
        compactTableByteLength: window.compactTableByteLength,
      },
      coldRoutingWindowProbe: {
        ...diagnostics.coldRoutingWindowProbe,
        connectionCount: window.connectionCount,
        compactTableByteLength: window.compactTableByteLength,
        materializedConnectionCount: window.connectionCount,
        checkpointSampleCount: 1 + checkpointEvents.length + 1,
      },
    },
  };
  assert.doesNotThrow(() => validateChildProfileReport(actualReport));
});

test("profile protocol rejects unstable provenance and process reuse", () => {
  const parsed = parseScheduledMeetingRequest(REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.throws(() => collectProfileSamples({
    cpuProfile: false,
    heapSnapshots: false,
    runChild(request) {
      return fixtureChildReport(parsed.data, request, 20_000 + request.sample, request.sample === 2 ? "tampered-artifact" : undefined);
    },
  }), /artifact, request, or access-provider provenance/);

  assert.throws(() => collectProfileSamples({
    cpuProfile: false,
    heapSnapshots: false,
    runChild(request) {
      return fixtureChildReport(parsed.data, request, 20_001);
    },
  }), /distinct child processes/);
});

test("profile protocol rejects malformed reports and incomplete stage sets", () => {
  const parsed = parseScheduledMeetingRequest(REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.throws(() => collectProfileSamples({
    cpuProfile: false,
    heapSnapshots: false,
    runChild(request) {
      const report = fixtureChildReport(parsed.data, request, 30_000 + request.sample);
      return request.sample === 2 ? { ...report, stages: report.stages.slice(0, -1) } : report;
    },
  }), /malformed/);
  assert.throws(() => collectProfileSamples({
    cpuProfile: false,
    heapSnapshots: false,
    runChild(request) {
      const report = fixtureChildReport(parsed.data, request, 31_000 + request.sample);
      return request.sample === 1 ? { ...report, request: { ...report.request, tolerancePercent: 5 } } : report;
    },
  }), /malformed|provenance/);
  assert.throws(() => collectProfileSamples({
    cpuProfile: false,
    heapSnapshots: false,
    runChild(request) {
      const report = fixtureChildReport(parsed.data, request, 32_000 + request.sample);
      if (request.sample !== 2 || report.routingDiagnostics === null) return report;
      return {
        ...report,
        routingDiagnostics: {
          ...report.routingDiagnostics,
          coldRoutingWindowProbe: {
            ...report.routingDiagnostics.coldRoutingWindowProbe,
            materializedConnectionCount: report.routingDiagnostics.coldRoutingWindowProbe.materializedConnectionCount + 1,
          },
        },
      };
    },
  }), /malformed/);
  assert.throws(() => collectProfileSamples({
    cpuProfile: false,
    heapSnapshots: false,
    runChild(request) {
      const report = fixtureChildReport(parsed.data, request, 33_000 + request.sample);
      if (request.sample !== 2 || report.routingDiagnostics === null) return report;
      return {
        ...report,
        routingDiagnostics: {
          ...report.routingDiagnostics,
          coldRoutingWindowProbe: {
            ...report.routingDiagnostics.coldRoutingWindowProbe,
            sampleIntervalConnections: 1_024,
          },
        },
      };
    },
  }), /malformed/);
  assert.throws(() => collectProfileSamples({
    cpuProfile: false,
    heapSnapshots: false,
    runChild(request) {
      const report = fixtureChildReport(parsed.data, request, 34_000 + request.sample);
      if (request.sample !== 2 || report.routingDiagnostics === null) return report;
      return {
        ...report,
        routingDiagnostics: {
          ...report.routingDiagnostics,
          coldRoutingWindowProbe: {
            ...report.routingDiagnostics.coldRoutingWindowProbe,
            checkpointSampleCount: report.routingDiagnostics.coldRoutingWindowProbe.checkpointSampleCount + 1,
          },
        },
      };
    },
  }), /malformed/);
});

function fixtureChildReport(
  request: ScheduledMeetingRequest,
  run: ChildRunRequest,
  processId: number,
  artifactId = FIXTURE_SCHEDULED_ARTIFACT.provenance.compiledArtifactId,
): ChildProfileReport {
  const firstRequest = requestMeasurement(run.sample, "first", run.diagnostic ? 1_000 : 12);
  const warmRequest = requestMeasurement(run.sample, "warm", run.diagnostic ? 900 : 7);
  const stages: StageMeasurement[] = EXPECTED_CALCULATION_STAGES.flatMap((stage, index) => [
    { stage, requestKind: "first" as const, elapsedMs: run.diagnostic ? 1_000 + index : index, heapDeltaBytes: index },
    { stage, requestKind: "warm" as const, elapsedMs: run.diagnostic ? 900 + index : index, heapDeltaBytes: index },
  ]);
  return {
    contractVersion: "meeet-calculation-profile-child/v2",
    nodeVersion: "24.19.0",
    processId,
    diagnostic: run.diagnostic,
    request,
    accessProvider: FIXTURE_SCHEDULED_ACCESS_PROVIDER.descriptor,
    artifact: {
      path: "/fixture/scheduled-artifact.json",
      compiledArtifactId: artifactId,
      feedId: FIXTURE_SCHEDULED_ARTIFACT.feedId,
      serviceDateRange: FIXTURE_SCHEDULED_ARTIFACT.serviceDateRange,
      stationAreaCount: FIXTURE_SCHEDULED_ARTIFACT.stationAreas.length,
      connectionCount: FIXTURE_SCHEDULED_ARTIFACT.connections.length,
    },
    artifactLoad: { elapsedMs: 4, heapDeltaBytes: 100 },
    firstRequest,
    warmRequest,
    stages,
    routingDiagnostics: run.diagnostic ? null : fixtureRoutingDiagnostics(request, processId),
    cpuProfilePath: run.cpuProfile ? "/profiles/diagnostic.cpuprofile" : null,
    heapSnapshotPath: run.heapSnapshots ? "/profiles/diagnostic.heapsnapshot" : null,
  };
}

function fixtureRoutingDiagnostics(request: ScheduledMeetingRequest, processId: number): RoutingDiagnostics {
  const connectionCount = FIXTURE_SCHEDULED_ARTIFACT.connections.length;
  const compactTableByteLength = connectionCount * 4 * Uint32Array.BYTES_PER_ELEMENT;
  const memory = { rss: 100, heapTotal: 80, heapUsed: 60, external: 20, arrayBuffers: 10 };
  return {
    routingWindow: { connectionCount, compactTableByteLength },
    coldRoutingWindowProbe: {
      processId,
      nodeVersion: "24.19.0",
      artifactPath: "/fixture/scheduled-artifact.json",
      compiledArtifactId: FIXTURE_SCHEDULED_ARTIFACT.provenance.compiledArtifactId,
      searchStartAt: request.searchStartAt,
      materializationElapsedMs: 2,
      connectionCount,
      compactTableByteLength,
      materializedConnectionCount: connectionCount,
      sampleIntervalConnections: ROUTING_WINDOW_SAMPLE_INTERVAL_CONNECTIONS,
      checkpointSampleCount: Math.floor(connectionCount / ROUTING_WINDOW_SAMPLE_INTERVAL_CONNECTIONS) + 3,
      memoryBefore: memory,
      memoryAfter: memory,
      memoryDelta: { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
      peakMemory: memory,
      gcBefore: { count: 1, totalPauseMs: 2 },
      gcAfter: { count: 1, totalPauseMs: 2 },
      gcDelta: { count: 0, totalPauseMs: 0 },
      postGcMemory: { available: false },
    },
  };
}

function requestMeasurement(sample: number, requestKind: "first" | "warm", elapsedMs: number) {
  return {
    sample,
    requestKind,
    elapsedMs,
    calculationElapsedMs: elapsedMs,
    validationElapsedMs: 1,
    serializationElapsedMs: 1,
    heapDeltaBytes: 100,
    status: "ok" as const,
    reason: null,
    validationSuccess: true,
    validationIssues: null,
    serializedByteLength: 100,
    stationAreaCatalogEntryCount: 3,
  };
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateProfile,
  buildWorkerLaunch,
  collectProfileSamples,
  EXPECTED_CALCULATION_STAGES,
  type ChildProfileReport,
  type ChildRunRequest,
  type StageMeasurement,
} from "../scripts/profile-scheduled-calculation-protocol.ts";
import {
  FIXTURE_SCHEDULED_ACCESS_PROVIDER,
  FIXTURE_SCHEDULED_ARTIFACT,
} from "../lib/fixtures/scheduled-routing.ts";
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
  assert.equal(aggregate.diagnostics?.sample, 4);
  assert.equal(aggregate.diagnostics?.cpuProfilePath !== null, true);
  assert.deepEqual(aggregate.artifact.sampleCompiledArtifactIds, [
    FIXTURE_SCHEDULED_ARTIFACT.provenance.compiledArtifactId,
    FIXTURE_SCHEDULED_ARTIFACT.provenance.compiledArtifactId,
    FIXTURE_SCHEDULED_ARTIFACT.provenance.compiledArtifactId,
  ]);
  assert.deepEqual(aggregate.request, parsed.data);
  assert.equal(aggregate.accessProvider.name, FIXTURE_SCHEDULED_ACCESS_PROVIDER.descriptor.name);

  const launch = buildWorkerLaunch({
    nodePath: "/node",
    tsxCliPath: "/repo/node_modules/tsx/dist/cli.mjs",
    workerPath: "/repo/scripts/profile-scheduled-calculation-worker.ts",
    outputPath: "/tmp/sample.json",
    request: { sample: 4, diagnostic: true, cpuProfile: true, heapSnapshots: true },
  });
  assert.equal(launch.command, "/node");
  assert.deepEqual(launch.args, [
    "--conditions=react-server",
    "/repo/node_modules/tsx/dist/cli.mjs",
    "/repo/scripts/profile-scheduled-calculation-worker.ts",
    "--sample",
    "4",
    "--output",
    "/tmp/sample.json",
    "--diagnostic",
    "--inspector-cpu",
    "--heap-snapshots",
  ]);
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
});

function fixtureChildReport(
  request: ScheduledMeetingRequest,
  run: ChildRunRequest,
  processId: number,
  artifactId = FIXTURE_SCHEDULED_ARTIFACT.provenance.compiledArtifactId,
): ChildProfileReport {
  const firstRequest = requestMeasurement(run.sample, "first", 12);
  const warmRequest = requestMeasurement(run.sample, "warm", 7);
  const stages: StageMeasurement[] = EXPECTED_CALCULATION_STAGES.flatMap((stage, index) => [
    { stage, requestKind: "first" as const, elapsedMs: index, heapDeltaBytes: index },
    { stage, requestKind: "warm" as const, elapsedMs: index, heapDeltaBytes: index },
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
    cpuProfilePath: run.cpuProfile ? "/profiles/diagnostic.cpuprofile" : null,
    heapSnapshotPath: run.heapSnapshots ? "/profiles/diagnostic.heapsnapshot" : null,
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

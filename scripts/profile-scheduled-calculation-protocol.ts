import type { ProviderDescriptor } from "../lib/domain/types.ts";
import type { ScheduledMeetingRequest } from "../lib/validation/meeting-v3.ts";

export const PROFILE_SAMPLE_COUNT = 3;
export const ROUTING_WINDOW_SAMPLE_INTERVAL_CONNECTIONS = 2_048;
export const EXPECTED_CALCULATION_STAGES = [
  "access-seeds",
  "station-area-catalog",
  "routing-window",
  "participant-scans",
  "participant-surfaces",
  "station-area-evaluation",
  "response-build",
] as const;

type RequestKind = "first" | "warm";

export interface MemorySnapshot {
  readonly rss: number;
  readonly heapTotal: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
}

export interface MemoryDelta {
  readonly rss: number;
  readonly heapTotal: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
}

export interface GcSnapshot {
  readonly count: number;
  readonly totalPauseMs: number;
}

export interface GcDelta {
  readonly count: number;
  readonly totalPauseMs: number;
}

export interface PostGcMemoryReport {
  readonly available: boolean;
  readonly before?: MemorySnapshot;
  readonly after?: MemorySnapshot;
  readonly delta?: MemoryDelta;
}

export interface ColdRoutingWindowProbe {
  readonly processId: number;
  readonly nodeVersion: string;
  readonly artifactPath: string;
  readonly compiledArtifactId: string;
  readonly searchStartAt: string;
  readonly materializationElapsedMs: number;
  readonly connectionCount: number;
  readonly compactTableByteLength: number;
  readonly materializedConnectionCount: number;
  readonly sampleIntervalConnections: number;
  readonly checkpointSampleCount: number;
  readonly memoryBefore: MemorySnapshot;
  readonly memoryAfter: MemorySnapshot;
  readonly memoryDelta: MemoryDelta;
  readonly peakMemory: MemorySnapshot;
  readonly gcBefore: GcSnapshot;
  readonly gcAfter: GcSnapshot;
  readonly gcDelta: GcDelta;
  readonly postGcMemory: PostGcMemoryReport;
}

export interface RoutingDiagnostics {
  /** Scalar metadata from the normal, cacheable routing-window call. */
  readonly routingWindow: {
    readonly connectionCount: number;
    readonly compactTableByteLength: number;
  };
  /** Callback-bearing materialization is deliberately routing-cache-cold. */
  readonly coldRoutingWindowProbe: ColdRoutingWindowProbe;
}

export interface RequestMeasurement {
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

export interface StageMeasurement {
  readonly stage: string;
  readonly requestKind: RequestKind;
  readonly elapsedMs: number;
  readonly heapDeltaBytes: number;
}

export interface ChildProfileReport {
  readonly contractVersion: "meeet-calculation-profile-child/v2";
  readonly nodeVersion: string;
  readonly processId: number;
  readonly diagnostic: boolean;
  readonly request: ScheduledMeetingRequest;
  readonly accessProvider: ProviderDescriptor;
  readonly artifact: {
    readonly path: string;
    readonly compiledArtifactId: string;
    readonly feedId: string;
    readonly serviceDateRange: { readonly firstDate: string; readonly lastDate: string };
    readonly stationAreaCount: number;
    readonly connectionCount: number;
  };
  readonly artifactLoad: {
    readonly elapsedMs: number;
    readonly heapDeltaBytes: number;
  };
  readonly firstRequest: RequestMeasurement;
  readonly warmRequest: RequestMeasurement;
  readonly stages: readonly StageMeasurement[];
  readonly routingDiagnostics: RoutingDiagnostics | null;
  readonly cpuProfilePath: string | null;
  readonly heapSnapshotPath: string | null;
}

export interface ChildRunRequest {
  readonly sample: number;
  readonly diagnostic: boolean;
  readonly cpuProfile: boolean;
  readonly heapSnapshots: boolean;
}

export interface ChildLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly request: ChildRunRequest;
  readonly outputPath: string;
}

export interface ProfileSample {
  readonly sample: number;
  readonly report: ChildProfileReport;
}

export interface ProfileCollection {
  readonly timingSamples: readonly ProfileSample[];
  readonly diagnosticSample: ProfileSample | null;
}

export interface AggregateProfileReport {
  readonly contractVersion: "meeet-calculation-profile/v2";
  readonly schema: "fresh-process-paired-first-warm/v1";
  readonly semantics: {
    readonly sampleCount: number;
    readonly childProcessPerSample: true;
    readonly artifactLoadPerChild: true;
    readonly requestTimer: string;
    readonly firstRequest: string;
    readonly warmRequest: string;
  };
  readonly nodeVersion: string;
  readonly request: ScheduledMeetingRequest;
  readonly accessProvider: ProviderDescriptor;
  readonly accessProviderSamples: readonly ProviderDescriptor[];
  readonly artifact: ChildProfileReport["artifact"] & { readonly sampleCompiledArtifactIds: readonly string[] };
  readonly requestTimings: {
    readonly sampleCount: number;
    readonly firstRequestMedianMs: number;
    readonly warmRequestMedianMs: number;
    readonly firstRequest: RequestAggregate;
    readonly warmRequest: RequestAggregate;
    readonly samples: readonly unknown[];
  };
  readonly artifactLoad: {
    readonly sampleCount: number;
    readonly medianElapsedMs: number;
    readonly medianHeapDeltaBytes: number;
  };
  readonly stages: {
    readonly firstRequest: readonly StageAggregate[];
    readonly warmRequest: readonly StageAggregate[];
  };
  readonly routingDiagnostics: readonly RoutingDiagnostics[];
  readonly response: {
    readonly status: "ok" | "no-result";
    readonly reason: "no-access-seeds" | "no-reachable-stations" | null;
    readonly stationAreaCount: number;
    readonly serializedByteLength: number;
  };
  readonly validation: {
    readonly success: boolean;
    readonly requests: readonly unknown[];
  };
  readonly diagnostics: {
    readonly sample: number;
    readonly childProcessId: number;
    readonly nodeVersion: string;
    readonly compiledArtifactId: string;
    readonly cpuProfilePath: string | null;
    readonly heapSnapshotPath: string | null;
    readonly firstRequest: RequestMeasurement;
    readonly warmRequest: RequestMeasurement;
  } | null;
}

export interface RequestAggregate {
  readonly sampleCount: number;
  readonly medianElapsedMs: number;
  readonly medianCalculationElapsedMs: number;
  readonly medianValidationElapsedMs: number;
  readonly medianSerializationElapsedMs: number;
  readonly medianHeapDeltaBytes: number;
}

export interface StageAggregate {
  readonly stage: string;
  readonly sampleCount: number;
  readonly medianElapsedMs: number;
  readonly medianHeapDeltaBytes: number;
}

export function buildWorkerLaunch(options: {
  readonly nodePath: string;
  readonly workerPath: string;
  readonly outputPath: string;
  readonly request: ChildRunRequest;
  readonly exposeGc?: boolean;
}): ChildLaunch {
  const args = ["--conditions=react-server"];
  if (options.exposeGc === true) args.push("--expose-gc");
  args.push("--import", "tsx", options.workerPath, "--sample", String(options.request.sample), "--output", options.outputPath);
  if (options.request.diagnostic) args.push("--diagnostic");
  if (options.request.cpuProfile) args.push("--inspector-cpu");
  if (options.request.heapSnapshots) args.push("--heap-snapshots");
  return { command: options.nodePath, args, request: options.request, outputPath: options.outputPath };
}

export function collectProfileSamples(options: {
  readonly cpuProfile: boolean;
  readonly heapSnapshots: boolean;
  readonly runChild: (request: ChildRunRequest) => unknown;
}): ProfileCollection {
  const timingSamples: ProfileSample[] = [];
  for (let sample = 1; sample <= PROFILE_SAMPLE_COUNT; sample += 1) {
    const request: ChildRunRequest = { sample, diagnostic: false, cpuProfile: false, heapSnapshots: false };
    const report = validateChildProfileReport(options.runChild(request));
    validateSampleReport(report, request);
    timingSamples.push({ sample, report });
  }
  const diagnosticSample = options.cpuProfile || options.heapSnapshots
    ? (() => {
        const request: ChildRunRequest = {
          sample: PROFILE_SAMPLE_COUNT + 1,
          diagnostic: true,
          cpuProfile: options.cpuProfile,
          heapSnapshots: options.heapSnapshots,
        };
        const report = validateChildProfileReport(options.runChild(request));
        validateSampleReport(report, request);
        return { sample: request.sample, report };
      })()
    : null;
  const allSamples = diagnosticSample === null ? timingSamples : [...timingSamples, diagnosticSample];
  validateStableEvidence(allSamples);
  return { timingSamples, diagnosticSample };
}

export function validateChildProfileReport(value: unknown): ChildProfileReport {
  if (!isRecord(value) || value.contractVersion !== "meeet-calculation-profile-child/v2" ||
    typeof value.nodeVersion !== "string" || Number(value.nodeVersion.split(".")[0]) !== 24 ||
    !isPositiveSafeInteger(value.processId) || typeof value.diagnostic !== "boolean" ||
    !isCanonicalRequest(value.request) || !isAccessProviderDescriptor(value.accessProvider) ||
    !isArtifact(value.artifact) || !isArtifactLoad(value.artifactLoad) ||
    !isRequestMeasurement(value.firstRequest) || !isRequestMeasurement(value.warmRequest) ||
    !isStageList(value.stages) || !isNullableRoutingDiagnostics(value.routingDiagnostics) ||
    !isNullableString(value.cpuProfilePath) || !isNullableString(value.heapSnapshotPath)) {
    throw new Error("The profiling child report is malformed.");
  }
  return value as unknown as ChildProfileReport;
}

export function aggregateProfile(collection: ProfileCollection): AggregateProfileReport {
  const samples = collection.timingSamples;
  if (samples.length !== PROFILE_SAMPLE_COUNT) throw new Error("Exactly three timing samples are required for v2 aggregation.");
  const representative = samples[0];
  if (representative === undefined) throw new Error("The profiling collection is empty.");
  const firstRequests = samples.map((sample) => sample.report.firstRequest);
  const warmRequests = samples.map((sample) => sample.report.warmRequest);
  const allRequests = [...firstRequests, ...warmRequests];
  const report: AggregateProfileReport = {
    contractVersion: "meeet-calculation-profile/v2",
    schema: "fresh-process-paired-first-warm/v1",
    semantics: {
      sampleCount: PROFILE_SAMPLE_COUNT,
      childProcessPerSample: true,
      artifactLoadPerChild: true,
      requestTimer: "after-child-startup-and-artifact-load-through-strict-validation-and-response-serialization",
      firstRequest: "first-calculation-after-artifact-load-in-a-fresh-child-process",
      warmRequest: "immediately-subsequent-calculation-in-the-same-child-and-with-the-same-artifact-object",
    },
    nodeVersion: representative.report.nodeVersion,
    request: representative.report.request,
    accessProvider: canonicalizeAccessProviderDescriptor(representative.report.accessProvider),
    accessProviderSamples: samples.map((sample) => sample.report.accessProvider),
    artifact: {
      ...representative.report.artifact,
      sampleCompiledArtifactIds: samples.map((sample) => sample.report.artifact.compiledArtifactId),
    },
    requestTimings: {
      sampleCount: PROFILE_SAMPLE_COUNT,
      firstRequestMedianMs: median(firstRequests.map((request) => request.elapsedMs)),
      warmRequestMedianMs: median(warmRequests.map((request) => request.elapsedMs)),
      firstRequest: aggregateRequests(firstRequests),
      warmRequest: aggregateRequests(warmRequests),
      samples: samples.map((sample) => ({
        sample: sample.sample,
        childProcessId: sample.report.processId,
        nodeVersion: sample.report.nodeVersion,
        compiledArtifactId: sample.report.artifact.compiledArtifactId,
        artifactLoad: sample.report.artifactLoad,
        firstRequest: sample.report.firstRequest,
        warmRequest: sample.report.warmRequest,
      })),
    },
    artifactLoad: {
      sampleCount: samples.length,
      medianElapsedMs: median(samples.map((sample) => sample.report.artifactLoad.elapsedMs)),
      medianHeapDeltaBytes: median(samples.map((sample) => sample.report.artifactLoad.heapDeltaBytes)),
    },
    stages: {
      firstRequest: aggregateStages(samples, "first"),
      warmRequest: aggregateStages(samples, "warm"),
    },
    routingDiagnostics: samples.map((sample) => {
      const routingDiagnostics = sample.report.routingDiagnostics;
      if (routingDiagnostics === null) throw new Error(`Timing sample ${sample.sample} is missing routing diagnostics.`);
      return routingDiagnostics;
    }),
    response: {
      status: representative.report.warmRequest.status,
      reason: representative.report.warmRequest.reason,
      stationAreaCount: representative.report.warmRequest.stationAreaCatalogEntryCount,
      serializedByteLength: representative.report.warmRequest.serializedByteLength,
    },
    validation: {
      success: allRequests.every((request) => request.validationSuccess),
      requests: allRequests.map((request) => ({
        sample: request.sample,
        requestKind: request.requestKind,
        success: request.validationSuccess,
        issues: request.validationIssues,
      })),
    },
    diagnostics: collection.diagnosticSample === null ? null : {
      sample: collection.diagnosticSample.sample,
      childProcessId: collection.diagnosticSample.report.processId,
      nodeVersion: collection.diagnosticSample.report.nodeVersion,
      compiledArtifactId: collection.diagnosticSample.report.artifact.compiledArtifactId,
      cpuProfilePath: collection.diagnosticSample.report.cpuProfilePath,
      heapSnapshotPath: collection.diagnosticSample.report.heapSnapshotPath,
      firstRequest: collection.diagnosticSample.report.firstRequest,
      warmRequest: collection.diagnosticSample.report.warmRequest,
    },
  };
  return report;
}

export function canonicalizeAccessProviderDescriptor(descriptor: ProviderDescriptor): ProviderDescriptor {
  return {
    ...descriptor,
    provenance: {
      ...descriptor.provenance,
      retrievedAt: "<per-child-process>",
    },
  };
}

function validateSampleReport(report: ChildProfileReport, request: ChildRunRequest): void {
  if (report.diagnostic !== request.diagnostic ||
    report.firstRequest.sample !== request.sample || report.firstRequest.requestKind !== "first" ||
    report.warmRequest.sample !== request.sample || report.warmRequest.requestKind !== "warm") {
    throw new Error(`Profiling child ${request.sample} did not produce the requested first/warm pair.`);
  }
  if (request.cpuProfile !== (report.cpuProfilePath !== null) ||
    request.heapSnapshots !== (report.heapSnapshotPath !== null)) {
    throw new Error(`Profiling child ${request.sample} diagnostic routing does not match its report.`);
  }
  if (request.diagnostic !== (report.routingDiagnostics === null)) {
    throw new Error(`Profiling child ${request.sample} routing diagnostics do not match its timing role.`);
  }
  if (report.routingDiagnostics !== null) {
    const probe = report.routingDiagnostics.coldRoutingWindowProbe;
    if (probe.processId !== report.processId || probe.artifactPath !== report.artifact.path || probe.compiledArtifactId !== report.artifact.compiledArtifactId ||
      probe.nodeVersion !== report.nodeVersion || probe.searchStartAt !== report.request.searchStartAt) {
      throw new Error(`Profiling child ${request.sample} disagrees on artifact, request, or access-provider provenance.`);
    }
  }
  if (!report.firstRequest.validationSuccess || !report.warmRequest.validationSuccess ||
    report.firstRequest.status !== "ok" || report.warmRequest.status !== "ok") {
    throw new Error(`Profiling child ${request.sample} did not produce successful strictly validated requests.`);
  }
}

function validateStableEvidence(samples: readonly ProfileSample[]): void {
  const first = samples[0];
  if (first === undefined) throw new Error("No profiling samples were produced.");
  const artifactId = first.report.artifact.compiledArtifactId;
  const artifactPath = first.report.artifact.path;
  const requestIdentity = stableSerialize(first.report.request);
  const providerIdentity = stableSerialize(canonicalizeAccessProviderDescriptor(first.report.accessProvider));
  const processIds = new Set<number>();
  for (const sample of samples) {
    processIds.add(sample.report.processId);
    if (sample.report.artifact.compiledArtifactId !== artifactId || sample.report.artifact.path !== artifactPath ||
      stableSerialize(sample.report.request) !== requestIdentity ||
      stableSerialize(canonicalizeAccessProviderDescriptor(sample.report.accessProvider)) !== providerIdentity) {
      throw new Error(`Profiling child ${sample.sample} disagrees on artifact, request, or access-provider provenance.`);
    }
  }
  if (processIds.size !== samples.length) throw new Error("Profiling samples did not run in distinct child processes.");
}

function isCanonicalRequest(value: unknown): value is ScheduledMeetingRequest {
  if (!isRecord(value) || value.contractVersion !== "meeet-meeting/v3" || !Array.isArray(value.participants) || value.participants.length !== 2 ||
    !isTolerance(value.tolerancePercent) || !isChangePreset(value.changeTimePreset) || typeof value.searchStartAt !== "string" || value.searchStartAt === "") return false;
  return value.participants.every((participant) => isRecord(participant) && typeof participant.id === "string" && participant.id !== "" && participant.mode === "transit" &&
    isRecord(participant.origin) && typeof participant.origin.label === "string" && Number.isFinite(participant.origin.latitude) && Number.isFinite(participant.origin.longitude));
}

function isAccessProviderDescriptor(value: unknown): value is ProviderDescriptor {
  if (!isRecord(value) || typeof value.name !== "string" || !isDeployment(value.deployment) || !isDataKind(value.dataKind) || typeof value.liveData !== "boolean" ||
    typeof value.asOf !== "string" || typeof value.notes !== "string" || !isRecord(value.provenance)) return false;
  const provenance = value.provenance;
  return provenance.role === "access" && typeof provenance.provider === "string" && isDeployment(provenance.deployment) && isDataKind(provenance.dataKind) &&
    provenance.liveData === false && (provenance.sourceUrl === null || typeof provenance.sourceUrl === "string") &&
    (provenance.license === null || (isRecord(provenance.license) && typeof provenance.license.name === "string" && typeof provenance.license.url === "string")) &&
    typeof provenance.attribution === "string" && typeof provenance.version === "string" && typeof provenance.retrievedAt === "string" &&
    typeof provenance.notes === "string" && provenance.feeds === null && value.liveData === false && value.dataKind === provenance.dataKind &&
    value.deployment === provenance.deployment && value.asOf === provenance.version && value.notes === provenance.notes;
}

function isArtifact(value: unknown): value is ChildProfileReport["artifact"] {
  return isRecord(value) && typeof value.path === "string" && value.path !== "" && typeof value.compiledArtifactId === "string" && value.compiledArtifactId !== "" &&
    typeof value.feedId === "string" && value.feedId !== "" && isRecord(value.serviceDateRange) && typeof value.serviceDateRange.firstDate === "string" &&
    typeof value.serviceDateRange.lastDate === "string" && isSafeCount(value.stationAreaCount) && isSafeCount(value.connectionCount);
}

function isArtifactLoad(value: unknown): value is ChildProfileReport["artifactLoad"] {
  return isRecord(value) && isNonNegativeFinite(value.elapsedMs) && Number.isFinite(value.heapDeltaBytes);
}

function isRequestMeasurement(value: unknown): value is RequestMeasurement {
  return isRecord(value) && isPositiveSafeInteger(value.sample) && (value.requestKind === "first" || value.requestKind === "warm") &&
    isNonNegativeFinite(value.elapsedMs) && isNonNegativeFinite(value.calculationElapsedMs) && isNonNegativeFinite(value.validationElapsedMs) &&
    isNonNegativeFinite(value.serializationElapsedMs) && Number.isFinite(value.heapDeltaBytes) && (value.status === "ok" || value.status === "no-result") &&
    (value.reason === null || value.reason === "no-access-seeds" || value.reason === "no-reachable-stations") && typeof value.validationSuccess === "boolean" &&
    (value.validationIssues === null || Array.isArray(value.validationIssues)) && isSafeCount(value.serializedByteLength) && isSafeCount(value.stationAreaCatalogEntryCount);
}

function isStageList(value: unknown): value is readonly StageMeasurement[] {
  if (!Array.isArray(value) || value.length !== EXPECTED_CALCULATION_STAGES.length * 2) return false;
  const seen = new Set<string>();
  for (const stage of value) {
    if (!isRecord(stage) || typeof stage.stage !== "string" || !EXPECTED_CALCULATION_STAGES.includes(stage.stage as typeof EXPECTED_CALCULATION_STAGES[number]) ||
      (stage.requestKind !== "first" && stage.requestKind !== "warm") || !isNonNegativeFinite(stage.elapsedMs) || !Number.isFinite(stage.heapDeltaBytes)) return false;
    const key = `${stage.requestKind}:${stage.stage}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return seen.size === EXPECTED_CALCULATION_STAGES.length * 2;
}

function isNullableRoutingDiagnostics(value: unknown): value is RoutingDiagnostics | null {
  return value === null || isRoutingDiagnostics(value);
}

function isRoutingDiagnostics(value: unknown): value is RoutingDiagnostics {
  if (!isRecord(value) || !isRoutingWindowMetadata(value.routingWindow) || !isColdRoutingWindowProbe(value.coldRoutingWindowProbe)) return false;
  const probe = value.coldRoutingWindowProbe;
  return probe.connectionCount === value.routingWindow.connectionCount &&
    probe.compactTableByteLength === value.routingWindow.compactTableByteLength;
}

function isRoutingWindowMetadata(value: unknown): value is RoutingDiagnostics["routingWindow"] {
  return isRecord(value) && isSafeCount(value.connectionCount) && isSafeCount(value.compactTableByteLength) &&
    value.compactTableByteLength === value.connectionCount * 4 * Uint32Array.BYTES_PER_ELEMENT;
}

function isColdRoutingWindowProbe(value: unknown): value is ColdRoutingWindowProbe {
  if (!isRecord(value) || !isPositiveSafeInteger(value.processId) || typeof value.nodeVersion !== "string" ||
    typeof value.artifactPath !== "string" || value.artifactPath === "" || typeof value.compiledArtifactId !== "string" || value.compiledArtifactId === "" ||
    typeof value.searchStartAt !== "string" || value.searchStartAt === "" || !isNonNegativeFinite(value.materializationElapsedMs) ||
    !isSafeCount(value.connectionCount) || !isSafeCount(value.compactTableByteLength) || !isSafeCount(value.materializedConnectionCount) ||
    !isPositiveSafeInteger(value.sampleIntervalConnections) || !isPositiveSafeInteger(value.checkpointSampleCount) ||
    !isMemorySnapshot(value.memoryBefore) || !isMemorySnapshot(value.memoryAfter) || !isMemoryDelta(value.memoryDelta) ||
    !isMemorySnapshot(value.peakMemory) || !isGcSnapshot(value.gcBefore) || !isGcSnapshot(value.gcAfter) || !isGcDelta(value.gcDelta) ||
    !isPostGcMemoryReport(value.postGcMemory)) return false;
  if (value.compactTableByteLength !== value.connectionCount * 4 * Uint32Array.BYTES_PER_ELEMENT ||
    value.materializedConnectionCount !== value.connectionCount ||
    value.sampleIntervalConnections !== ROUTING_WINDOW_SAMPLE_INTERVAL_CONNECTIONS ||
    value.checkpointSampleCount !== expectedRoutingWindowCheckpointSampleCount(value.materializedConnectionCount) ||
    !memoryDeltaMatches(value.memoryDelta, value.memoryAfter, value.memoryBefore) ||
    !gcDeltaMatches(value.gcDelta, value.gcAfter, value.gcBefore) ||
    !peakAtLeast(value.peakMemory, value.memoryBefore) || !peakAtLeast(value.peakMemory, value.memoryAfter)) return false;
  return true;
}

function expectedRoutingWindowCheckpointSampleCount(materializedConnectionCount: number): number {
  // The producer records one sample before materialization, one at every
  // interval, one unconditionally when the table is finished, and one final
  // memory sample after materialization.
  return Math.floor(materializedConnectionCount / ROUTING_WINDOW_SAMPLE_INTERVAL_CONNECTIONS) + 3;
}

function isMemorySnapshot(value: unknown): value is MemorySnapshot {
  return isRecord(value) && isNonNegativeFinite(value.rss) && isNonNegativeFinite(value.heapTotal) &&
    isNonNegativeFinite(value.heapUsed) && isNonNegativeFinite(value.external) && isNonNegativeFinite(value.arrayBuffers);
}

function isMemoryDelta(value: unknown): value is MemoryDelta {
  return isRecord(value) && isFiniteNumber(value.rss) && isFiniteNumber(value.heapTotal) && isFiniteNumber(value.heapUsed) &&
    isFiniteNumber(value.external) && isFiniteNumber(value.arrayBuffers);
}

function isGcSnapshot(value: unknown): value is GcSnapshot {
  return isRecord(value) && isSafeCount(value.count) && isNonNegativeFinite(value.totalPauseMs);
}

function isGcDelta(value: unknown): value is GcDelta {
  return isRecord(value) && isSafeCount(value.count) && isNonNegativeFinite(value.totalPauseMs);
}

function isPostGcMemoryReport(value: unknown): value is PostGcMemoryReport {
  if (!isRecord(value) || typeof value.available !== "boolean") return false;
  if (!value.available) return value.before === undefined && value.after === undefined && value.delta === undefined;
  return isMemorySnapshot(value.before) && isMemorySnapshot(value.after) && isMemoryDelta(value.delta) &&
    memoryDeltaMatches(value.delta, value.after, value.before);
}

function memoryDeltaMatches(delta: MemoryDelta, after: MemorySnapshot, before: MemorySnapshot): boolean {
  return delta.rss === after.rss - before.rss && delta.heapTotal === after.heapTotal - before.heapTotal &&
    delta.heapUsed === after.heapUsed - before.heapUsed && delta.external === after.external - before.external &&
    delta.arrayBuffers === after.arrayBuffers - before.arrayBuffers;
}

function gcDeltaMatches(delta: GcDelta, after: GcSnapshot, before: GcSnapshot): boolean {
  return delta.count === after.count - before.count && delta.totalPauseMs === after.totalPauseMs - before.totalPauseMs;
}

function peakAtLeast(peak: MemorySnapshot, sample: MemorySnapshot): boolean {
  return peak.rss >= sample.rss && peak.heapTotal >= sample.heapTotal && peak.heapUsed >= sample.heapUsed &&
    peak.external >= sample.external && peak.arrayBuffers >= sample.arrayBuffers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTolerance(value: unknown): value is 5 | 10 | 15 {
  return value === 5 || value === 10 || value === 15;
}

function isChangePreset(value: unknown): value is "quick" | "medium" | "long" {
  return value === "quick" || value === "medium" || value === "long";
}

function isDeployment(value: unknown): boolean {
  return value === "fixture" || value === "self-hosted" || value === "managed" || value === "unknown";
}

function isDataKind(value: unknown): boolean {
  return value === "demo-static" || value === "scheduled" || value === "access" || value === "live" || value === "unknown";
}

function aggregateRequests(requests: readonly RequestMeasurement[]): RequestAggregate {
  return {
    sampleCount: requests.length,
    medianElapsedMs: median(requests.map((request) => request.elapsedMs)),
    medianCalculationElapsedMs: median(requests.map((request) => request.calculationElapsedMs)),
    medianValidationElapsedMs: median(requests.map((request) => request.validationElapsedMs)),
    medianSerializationElapsedMs: median(requests.map((request) => request.serializationElapsedMs)),
    medianHeapDeltaBytes: median(requests.map((request) => request.heapDeltaBytes)),
  };
}

function aggregateStages(samples: readonly ProfileSample[], requestKind: RequestKind): readonly StageAggregate[] {
  return EXPECTED_CALCULATION_STAGES.map((stage) => {
    const values = samples.flatMap((sample) => sample.report.stages.filter((candidate) => candidate.stage === stage && candidate.requestKind === requestKind));
    return { stage, sampleCount: values.length, medianElapsedMs: median(values.map((value) => value.elapsedMs)), medianHeapDeltaBytes: median(values.map((value) => value.heapDeltaBytes)) };
  });
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Cannot calculate a median without samples.");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) throw new Error("Median sample indexing failed.");
  return sorted.length % 2 === 0 ? (lower + upper) / 2 : upper;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

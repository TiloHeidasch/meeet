import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { Rational } from "./rational.ts";
import type { RouteFirstClientSubmission } from "./request-contract.ts";
import { canonicalClientSubmissionKey } from "./request-contract.ts";
import { routeFirstClientSubmissionFingerprint } from "./fingerprint.ts";
import { sameSnapshot, validateSnapshot, type RouteSnapshotIdentity } from "./models.ts";
import type { RouteFirstMeetingServiceResult, RouteFirstMeetingCompleteResult, RouteFirstMeetingNoEligibleTargetResult, RouteFirstParticipantCorridor } from "./meeting-service.ts";
import type { EnumerationCertificate } from "./enumeration.ts";
import {
  assertRouteFirstClientJobEnvelope,
  ROUTE_FIRST_CLIENT_COORDINATE_REFERENCE,
  type RouteFirstClientAdmittedLandmark,
  type RouteFirstClientCertificate,
  type RouteFirstClientComponent,
  type RouteFirstClientCoordinate,
  type RouteFirstClientCorridor,
  type RouteFirstClientCorridorInterval,
  type RouteFirstClientEnumerationEvidence,
  type RouteFirstClientFairRegion,
  type RouteFirstClientFamily,
  type RouteFirstClientJourney,
  type RouteFirstClientJobEnvelope,
  type RouteFirstClientJobStatus,
  type RouteFirstClientLandmarkEvaluation,
  type RouteFirstClientProvenance,
  type RouteFirstClientResult,
  type RouteFirstClientSnapshot,
} from "./client-contract.ts";

export const ROUTE_FIRST_JOB_CONTRACT_VERSION = "route-first-job/v1" as const;
export const ROUTE_FIRST_RUNTIME_PERSISTENCE = "in-memory-process" as const;
export const ROUTE_FIRST_ACTIVATION = "blocked-until-durable-provider" as const;

export interface RouteFirstJobStoreOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly maxConcurrentFills?: number;
  readonly maxFillDurationMs?: number;
  readonly maxWorkUnits?: bigint;
  readonly now?: () => number;
  readonly jobIdFactory?: () => string;
}

export interface RouteFirstJobFillContext {
  readonly signal: AbortSignal;
  deadlineAt: number;
  readonly workBudget: bigint;
  readonly requestId: string;
  readonly jobId: string;
}

export type RouteFirstJobFill = (context: RouteFirstJobFillContext, submission: RouteFirstClientSubmission) => Promise<RouteFirstMeetingServiceResult> | RouteFirstMeetingServiceResult;

export interface RouteFirstInternalJobEnvelope {
  readonly contractVersion: typeof ROUTE_FIRST_JOB_CONTRACT_VERSION;
  readonly jobId: string;
  readonly status: RouteFirstClientJobStatus;
  readonly durable: false;
  readonly runtimePersistence: typeof ROUTE_FIRST_RUNTIME_PERSISTENCE;
  readonly activation: typeof ROUTE_FIRST_ACTIVATION;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly snapshot: RouteSnapshotIdentity;
  readonly result?: RouteFirstMeetingServiceResult;
}

interface MutableJob {
  readonly jobId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly cacheKey: string;
  submission?: RouteFirstClientSubmission;
  readonly participantIds: readonly string[];
  readonly participantModes: readonly string[];
  readonly departureAt: string;
  readonly tolerancePercent: string;
  readonly requestFingerprint: string;
  readonly snapshot: RouteSnapshotIdentity;
  readonly createdAt: number;
  readonly expiresAt: number;
  deadlineAt: number;
  status: RouteFirstClientJobStatus;
  result?: unknown;
  fill?: RouteFirstJobFill;
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  deadlineResolve?: () => void;
}

function requireOpaque(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) throw new Error(`${label} is invalid.`);
}

function stableSerialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${value.length}:${value}`;
  if (typeof value === "number" || typeof value === "boolean") return `${typeof value}:${String(value)}`;
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${stableSerialize(key)}:${stableSerialize(object[key])}`).join(",")}}`;
  }
  return `${typeof value}:unsupported`;
}

export function routeFirstRequestCacheKey(
  submission: RouteFirstClientSubmission,
  snapshot: RouteSnapshotIdentity,
  cacheScope: string,
): string {
  return createHash("sha256").update(stableSerialize({
    submission: JSON.parse(canonicalClientSubmissionKey(submission)) as unknown,
    snapshot,
    cacheScope,
  })).digest("base64url");
}

function defaultJobId(): string { return randomBytes(32).toString("base64url"); }
function defaultRequestId(): string { return randomBytes(24).toString("base64url"); }

function statusForResult(result: RouteFirstMeetingServiceResult): RouteFirstClientJobStatus { return result.status; }
function clientSnapshot(snapshot: RouteSnapshotIdentity): RouteFirstClientSnapshot { return { ...snapshot }; }

function clientCertificate(certificate: EnumerationCertificate): RouteFirstClientCertificate {
  return {
    complete: certificate.complete,
    statesVisited: certificate.statesVisited.toString(),
    edgeTransitions: certificate.edgeTransitions.toString(),
    pathsEmitted: certificate.pathsEmitted.toString(),
    maxSimplePathStateBound: certificate.maxSimplePathStateBound.toString(),
    workBudget: certificate.workBudget?.toString() ?? null,
    workUnits: certificate.workUnits.toString(),
    parallelEdgeFactor: certificate.parallelEdgeFactor.toString(),
    graphFingerprint: certificate.graphFingerprint,
    policyFingerprint: certificate.policyFingerprint,
    snapshotFingerprint: certificate.snapshotFingerprint,
    originVertexIds: [...certificate.originVertexIds],
    targetVertexIds: [...certificate.targetVertexIds],
  };
}

function clientProvenance(result: RouteFirstMeetingServiceResult): RouteFirstClientProvenance {
  return {
    contractVersion: "route-first-meeting-service/v1",
    requestId: result.provenance.requestId,
    departureContext: result.provenance.departureContext,
    snapshot: clientSnapshot(result.provenance.snapshot),
    routingSnapshots: result.provenance.routingSnapshots.map((entry) => ({ source: entry.source, snapshot: clientSnapshot(entry.snapshot) })),
    calculationCompleteness: result.provenance.calculationCompleteness,
    participantIds: [...result.provenance.participantIds],
    participantModes: [...result.provenance.participantModes],
    tolerancePercent: result.provenance.tolerancePercent,
    requestFingerprint: result.provenance.requestFingerprint,
    policyFingerprints: result.provenance.policyFingerprints.map((entry) => ({ ...entry })),
  };
}

function clientEnumerations(result: RouteFirstMeetingServiceResult): readonly RouteFirstClientEnumerationEvidence[] {
  return result.enumerations.map((entry) => ({ participantId: entry.participantId, status: entry.status, certificate: entry.certificate ? clientCertificate(entry.certificate) : null }));
}

function coordinate(value: { readonly xMm: bigint | Rational; readonly yMm: bigint | Rational }): RouteFirstClientCoordinate {
  return { xMm: value.xMm.toString(), yMm: value.yMm.toString() };
}

function clientJourney(journey: RouteFirstMeetingCompleteResult["journeys"][number]): RouteFirstClientJourney {
  return {
    id: journey.id,
    participantId: journey.participantId,
    snapshot: clientSnapshot(journey.snapshot),
    requestContext: { ...journey.requestContext, snapshot: clientSnapshot(journey.requestContext.snapshot) },
    path: { vertexIds: [...journey.path.vertexIds], edgeIds: [...journey.path.edgeIds] },
    timingModel: journey.timingModel,
    occurrences: journey.occurrences.map((occurrence) => ({ ...occurrence, tau: occurrence.tau.toString(), coordinate: coordinate(occurrence.coordinate) })),
    segments: journey.segments.map((segment) => ({ ...segment, departureTau: segment.departureTau.toString(), arrivalTau: segment.arrivalTau.toString(), distanceMm: segment.distanceMm.toString(), geometry: segment.geometry.map(coordinate) })),
  };
}

function clientInterval(interval: { readonly label: "exact-temporal-corridor" | "ambiguity-envelope"; readonly startTau: Rational; readonly endTau: Rational; readonly tolerancePercent: Rational }): RouteFirstClientCorridorInterval {
  return { label: interval.label, startTau: interval.startTau.toString(), endTau: interval.endTau.toString(), tolerancePercent: interval.tolerancePercent.toString() };
}

function clientCorridor(entry: RouteFirstParticipantCorridor): RouteFirstClientCorridor {
  return {
    participantId: entry.participantId,
    journeyId: entry.journeyId,
    midpoint: { tau: entry.corridor.midpoint.tau.toString(), midpointTau: entry.corridor.midpoint.midpointTau.toString(), pathDuration: entry.corridor.midpoint.pathDuration.toString(), segmentId: entry.corridor.midpoint.segmentId, fraction: entry.corridor.midpoint.fraction.toString(), coordinate: { xMm: entry.corridor.midpoint.coordinate.x.toString(), yMm: entry.corridor.midpoint.coordinate.y.toString() } },
    exact: clientInterval(entry.corridor.exact),
    ambiguityEnvelope: entry.corridor.ambiguityEnvelope ? clientInterval(entry.corridor.ambiguityEnvelope) : null,
    constituentCorridors: entry.corridor.constituentCorridors.map(clientInterval),
    directionalGeometry: [...entry.directionalGeometry],
    envelopeGeometry: [...entry.envelopeGeometry],
    alternateJourneyIds: [...entry.alternateJourneyIds],
  };
}

function clientFairRegion(result: RouteFirstMeetingCompleteResult | RouteFirstMeetingNoEligibleTargetResult, index: number): RouteFirstClientFairRegion {
  const region = result.fairRegions[index]!;
  const geometry = result.fairRegionGeometry[index]!;
  return {
    edgeId: region.edgeId,
    participantIds: [...region.participantIds],
    snapshot: clientSnapshot(region.snapshot),
    scope: { kind: region.scope.kind, participantIds: [...region.scope.participantIds] },
    kind: region.kind,
    tolerancePercent: region.tolerancePercent.toString(),
    intervals: region.intervals.map((interval) => ({ start: interval.start.toString(), end: interval.end.toString() })),
    points: region.points.map((point) => point.toString()),
    geometry: { start: { ...geometry.start }, end: { ...geometry.end } },
  };
}

function clientComponent(component: RouteFirstMeetingCompleteResult["components"][number]): RouteFirstClientComponent {
  return { id: component.id, snapshot: clientSnapshot(component.snapshot), participantIds: [...component.participantIds], kind: component.kind, edgeIntervals: component.edgeIntervals.map((entry) => ({ edgeId: entry.edgeId, interval: { start: entry.interval.start.toString(), end: entry.interval.end.toString() } })), vertexIds: [...component.vertexIds], endpointCoordinates: component.endpointCoordinates.map((point) => ({ xMm: point.x.toString(), yMm: point.y.toString() })) };
}

function clientFamilies(result: RouteFirstMeetingCompleteResult): readonly RouteFirstClientFamily[] {
  return result.families.map((family) => ({ snapshot: clientSnapshot(family.snapshot), contextKey: family.contextKey, skeletonKey: family.skeletonKey, geometryKey: family.geometryKey, participantIds: [...family.participantIds], pathKeys: [...family.pathKeys], targetEdgeIds: [...family.targetEdgeIds], eligibleComponents: family.eligibleComponents.map(clientComponent) }));
}

function clientLandmarkEvaluation(value: { readonly organicComponentCount: number; readonly minimumOrganicComponentDiversity: number; readonly evaluated: boolean; readonly landmarkIds: readonly string[] }): RouteFirstClientLandmarkEvaluation {
  return { organicComponentCount: value.organicComponentCount, minimumOrganicComponentDiversity: value.minimumOrganicComponentDiversity, evaluated: value.evaluated, landmarkIds: [...value.landmarkIds] };
}

function clientLandmarks(result: RouteFirstMeetingCompleteResult | RouteFirstMeetingNoEligibleTargetResult): readonly RouteFirstClientAdmittedLandmark[] {
  return result.admittedLandmarks.map((landmark) => ({ id: landmark.id, kind: landmark.kind, snapshot: clientSnapshot(landmark.snapshot), participantIds: [...landmark.participantIds], vertexId: landmark.vertexId, scope: landmark.scope }));
}

const failureMessages: Readonly<Record<string, string>> = {
  "invalid-request": "The route-first request is invalid.",
  "noncanonical-request": "The route-first request is not canonical.",
  "provider-error": "The route-first provider failed.",
  "non-enumerating-result": "The route-first provider returned no usable enumeration.",
  "certificate-invalid": "The route-first certificate is invalid.",
  "snapshot-mismatch": "The route-first snapshot provenance does not match.",
  "policy-mismatch": "The route-first policy provenance does not match.",
  "request-mismatch": "The route-first result does not match the request.",
  "journey-invalid": "The route-first journey is invalid.",
  "profile-invalid": "The route-first target profile is invalid.",
  "topology-invalid": "The route-first target topology is invalid.",
  "service-error": "The route-first service failed.",
};

export function toRouteFirstClientResult(result: RouteFirstMeetingServiceResult): RouteFirstClientResult {
  const base = { provenance: clientProvenance(result), enumerations: clientEnumerations(result) };
  if (result.status === "complete" || result.status === "no-eligible-target") {
    return {
      ...base,
      status: result.status,
      coordinateReference: { ...ROUTE_FIRST_CLIENT_COORDINATE_REFERENCE },
      journeys: result.journeys.map(clientJourney),
      corridors: result.corridors.map(clientCorridor),
      fairRegion: clientFairRegion(result, 0),
      fairRegions: result.fairRegions.map((_region, index) => clientFairRegion(result, index)),
      components: result.components.map(clientComponent) as RouteFirstClientComponent[],
      families: result.status === "complete" ? clientFamilies(result) : [],
      landmarkEvaluation: clientLandmarkEvaluation(result.landmarkEvaluation),
      admittedLandmarks: clientLandmarks(result),
    } as RouteFirstClientResult;
  }
  if (result.status === "incomplete") return { ...base, status: result.status, participantId: result.participantId, reason: result.reason };
  if (result.status === "unavailable") return { ...base, status: result.status, participantId: result.participantId, reason: "Route-first calculation is unavailable." };
  return { ...base, status: "failed", code: result.code, message: failureMessages[result.code] ?? failureMessages["service-error"]! };
}

function internalResultMatches(result: unknown, job: MutableJob, expectedStatus?: RouteFirstClientJobStatus): result is RouteFirstMeetingServiceResult {
  if (!result || typeof result !== "object") return false;
  const typed = result as RouteFirstMeetingServiceResult;
  if (expectedStatus && typed.status !== expectedStatus) return false;
  if (!("provenance" in typed) || !typed.provenance || typed.provenance.requestId !== job.requestId || !sameSnapshot(typed.provenance.snapshot, job.snapshot) || typed.provenance.requestFingerprint !== job.requestFingerprint) return false;
  if (typed.provenance.participantIds.length !== job.participantIds.length || typed.provenance.participantIds.some((value, index) => value !== job.participantIds[index]) || typed.provenance.participantModes.some((value, index) => value !== job.participantModes[index]) || typed.provenance.tolerancePercent !== job.tolerancePercent) return false;
  try {
    assertRouteFirstClientJobEnvelope({ contractVersion: ROUTE_FIRST_JOB_CONTRACT_VERSION, jobId: job.jobId, status: typed.status, durable: false, runtimePersistence: ROUTE_FIRST_RUNTIME_PERSISTENCE, activation: ROUTE_FIRST_ACTIVATION, expiresAt: job.expiresAt, snapshot: clientSnapshot(job.snapshot), result: toRouteFirstClientResult(typed) }, { jobId: job.jobId, snapshot: clientSnapshot(job.snapshot) });
    return true;
  } catch { return false; }
}

export class RouteFirstJobStore {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly maxConcurrentFills: number;
  readonly maxFillDurationMs: number;
  readonly maxWorkUnits: bigint;
  private readonly now: () => number;
  private readonly jobIdFactory: () => string;
  private readonly jobs = new Map<string, MutableJob>();
  private readonly cacheIndex = new Map<string, string>();
  private readonly queue: MutableJob[] = [];
  private activeFills = 0;

  constructor(options: RouteFirstJobStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 15 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 256;
    this.maxConcurrentFills = options.maxConcurrentFills ?? 2;
    this.maxFillDurationMs = options.maxFillDurationMs ?? Math.min(this.ttlMs, 15_000);
    this.maxWorkUnits = options.maxWorkUnits ?? BigInt(1_000_000);
    this.now = options.now ?? Date.now;
    this.jobIdFactory = options.jobIdFactory ?? defaultJobId;
    if (![this.ttlMs, this.maxEntries, this.maxConcurrentFills, this.maxFillDurationMs].every((value) => Number.isInteger(value) && value > 0) || this.maxWorkUnits <= BigInt(0)) throw new Error("Route-first job store limits are invalid.");
  }

  submit(sessionId: string, submission: RouteFirstClientSubmission, snapshot: RouteSnapshotIdentity, cacheScope: string, fill: RouteFirstJobFill): RouteFirstInternalJobEnvelope {
    requireOpaque(sessionId, "Route-first session id");
    validateSnapshot(snapshot);
    if (typeof cacheScope !== "string" || cacheScope.length === 0 || cacheScope.length > 256 || cacheScope.trim() !== cacheScope || /\s/.test(cacheScope)) throw new Error("Route-first cache scope is invalid.");
    const now = this.now();
    this.evictExpired();
    const cacheKey = `${sessionId}:${routeFirstRequestCacheKey(submission, snapshot, cacheScope)}`;
    const existingJobId = this.cacheIndex.get(cacheKey);
    const existing = existingJobId ? this.jobs.get(existingJobId) : undefined;
    if (existing && existing.expiresAt > now) return this.toInternalEnvelope(existing);
    if (existing) this.remove(existing);
    let jobId = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.jobIdFactory();
      if (/^[A-Za-z0-9_-]{32,128}$/.test(candidate) && !this.jobs.has(candidate)) { jobId = candidate; break; }
    }
    if (!jobId) throw new Error("Route-first job id allocation failed.");
    let requestId = defaultRequestId();
    while ([...this.jobs.values()].some((job) => job.requestId === requestId)) requestId = defaultRequestId();
    const createdAt = now;
    const job: MutableJob = {
      jobId,
      requestId,
      sessionId,
      cacheKey,
      submission,
      participantIds: Object.freeze(submission.participants.map((participant) => participant.participantId)),
      participantModes: Object.freeze(submission.participants.map((participant) => participant.mode)),
      departureAt: submission.departureAt,
      tolerancePercent: submission.tolerancePercent,
      requestFingerprint: routeFirstClientSubmissionFingerprint(submission),
      snapshot,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      deadlineAt: 0,
      status: "queued",
      fill,
    };
    this.jobs.set(job.jobId, job);
    this.cacheIndex.set(cacheKey, job.jobId);
    this.queue.push(job);
    this.enforceMaxEntries(job);
    void this.drain();
    return this.toInternalEnvelope(job);
  }

  get(sessionId: string, jobId: string): RouteFirstInternalJobEnvelope | null {
    requireOpaque(sessionId, "Route-first session id");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(jobId)) return null;
    this.evictExpired();
    const job = this.jobs.get(jobId);
    if (!job || job.sessionId !== sessionId) return null;
    return this.toInternalEnvelope(job);
  }

  toClientEnvelope(envelope: RouteFirstInternalJobEnvelope): RouteFirstClientJobEnvelope {
    const clientEnvelope: RouteFirstClientJobEnvelope = {
      contractVersion: ROUTE_FIRST_JOB_CONTRACT_VERSION,
      jobId: envelope.jobId,
      status: envelope.status,
      durable: false,
      runtimePersistence: ROUTE_FIRST_RUNTIME_PERSISTENCE,
      activation: ROUTE_FIRST_ACTIVATION,
      expiresAt: envelope.expiresAt,
      snapshot: clientSnapshot(envelope.snapshot),
      ...(envelope.result ? { result: toRouteFirstClientResult(envelope.result) } : {}),
    };
    return assertRouteFirstClientJobEnvelope(clientEnvelope, { jobId: envelope.jobId, snapshot: clientSnapshot(envelope.snapshot) });
  }

  /** Test-only corruption hook used to exercise deep cached-payload validation. */
  replaceCachedPayloadForTesting(sessionId: string, jobId: string, payload: unknown): void {
    const job = this.jobs.get(jobId);
    if (!job || job.sessionId !== sessionId) throw new Error("Job not found.");
    job.result = payload;
  }

  private async drain(): Promise<void> {
    while (this.activeFills < this.maxConcurrentFills) {
      const job = this.queue.shift();
      if (!job) return;
      if (this.jobs.get(job.jobId) !== job || job.status !== "queued") continue;
      this.activeFills += 1;
      void this.runFill(job).finally(() => { this.activeFills -= 1; void this.drain(); });
    }
  }

  private async runFill(job: MutableJob): Promise<void> {
    if (this.jobs.get(job.jobId) !== job || job.status !== "queued") return;
    if (this.now() >= job.expiresAt) {
      this.expireJob(job);
      return;
    }
    const fill = job.fill;
    const submission = job.submission;
    if (!fill || !submission) {
      this.expireJob(job);
      return;
    }
    job.deadlineAt = this.now() + this.maxFillDurationMs;
    job.status = "running";
    const controller = new AbortController();
    job.controller = controller;
    const remaining = Math.max(0, Math.min(job.deadlineAt, job.expiresAt) - this.now());
    let resolveDeadline!: () => void;
    const deadline = new Promise<"expired">((resolve) => {
      resolveDeadline = () => resolve("expired");
      job.timer = setTimeout(() => {
        this.expireJob(job);
        resolve("expired");
      }, remaining);
    });
    job.deadlineResolve = resolveDeadline;
    if (typeof job.timer === "object" && "unref" in job.timer && typeof job.timer.unref === "function") job.timer.unref();
    try {
      const work = Promise.resolve().then(() => fill({ signal: controller.signal, deadlineAt: job.deadlineAt, workBudget: this.maxWorkUnits, requestId: job.requestId, jobId: job.jobId }, submission)).then((result) => ({ kind: "result" as const, result }), () => ({ kind: "error" as const }));
      const outcome = await Promise.race([work, deadline.then(() => ({ kind: "expired" as const }))]);
      if (outcome.kind === "expired") return;
      if (outcome.kind === "error") throw new Error("Route-first fill failed.");
      const result = outcome.result;
      if (this.jobs.get(job.jobId) !== job || (job.status as RouteFirstClientJobStatus) === "expired" || controller.signal.aborted) return;
      if (!internalResultMatches(result, job, statusForResult(result))) {
        job.status = "failed";
        job.result = this.cacheFailure(job);
      } else {
        job.result = result;
        job.status = statusForResult(result);
      }
    } catch {
      if (this.jobs.get(job.jobId) !== job || job.status === "expired") return;
      job.status = "failed";
      job.result = this.cacheFailure(job);
    } finally {
      if (job.timer) clearTimeout(job.timer);
      job.timer = undefined;
      job.deadlineResolve = undefined;
      job.controller = undefined;
      job.fill = undefined;
      job.submission = undefined;
    }
  }

  private cacheFailure(job: MutableJob): RouteFirstMeetingServiceResult {
    return {
      status: "failed",
      provenance: {
        contractVersion: "route-first-meeting-service/v1",
        requestId: job.requestId,
        departureContext: job.departureAt,
        snapshot: job.snapshot,
        routingSnapshots: [{ source: "MVG", snapshot: job.snapshot }],
        calculationCompleteness: "failed",
        participantIds: job.participantIds,
        participantModes: job.participantModes as RouteFirstMeetingServiceResult["provenance"]["participantModes"],
        tolerancePercent: job.tolerancePercent,
        requestFingerprint: job.requestFingerprint,
        policyFingerprints: [],
      },
      code: "service-error",
      message: "Cached route-first result failed validation.",
      enumerations: [],
    };
  }

  private toInternalEnvelope(job: MutableJob): RouteFirstInternalJobEnvelope {
    if (["complete", "incomplete", "unavailable", "no-eligible-target", "failed"].includes(job.status) && !internalResultMatches(job.result, job, job.status)) {
      job.status = "failed";
      job.result = this.cacheFailure(job);
    }
    return {
      contractVersion: ROUTE_FIRST_JOB_CONTRACT_VERSION,
      jobId: job.jobId,
      status: job.status,
      durable: false,
      runtimePersistence: ROUTE_FIRST_RUNTIME_PERSISTENCE,
      activation: ROUTE_FIRST_ACTIVATION,
      createdAt: job.createdAt,
      expiresAt: job.expiresAt,
      snapshot: job.snapshot,
      ...((job.status === "complete" || job.status === "incomplete" || job.status === "unavailable" || job.status === "no-eligible-target" || job.status === "failed") && job.result && internalResultMatches(job.result, job, job.status) ? { result: job.result } : {}),
    };
  }

  private evictExpired(): void {
    const now = this.now();
    for (const job of this.jobs.values()) {
      const deadlineReached = job.status === "running" && job.deadlineAt > 0 && job.deadlineAt <= now;
      if (job.status !== "expired" && (job.expiresAt <= now || deadlineReached)) this.expireJob(job);
    }
  }

  private expireJob(job: MutableJob): void {
    if (this.jobs.get(job.jobId) !== job || job.status === "expired") return;
    job.status = "expired";
    job.result = undefined;
    job.submission = undefined;
    job.fill = undefined;
    job.deadlineResolve?.();
    job.deadlineResolve = undefined;
    job.controller?.abort();
    if (job.timer) clearTimeout(job.timer);
    job.timer = undefined;
    if (this.cacheIndex.get(job.cacheKey) === job.jobId) this.cacheIndex.delete(job.cacheKey);
  }

  private enforceMaxEntries(protectedJob: MutableJob): void {
    while (this.jobs.size > this.maxEntries) {
      const candidates = [...this.jobs.values()].filter((job) => job !== protectedJob);
      const oldest = candidates.sort((left, right) => left.createdAt - right.createdAt || left.jobId.localeCompare(right.jobId))[0];
      if (!oldest) return;
      this.remove(oldest);
    }
  }

  private remove(job: MutableJob): void {
    job.controller?.abort();
    job.submission = undefined;
    job.fill = undefined;
    job.deadlineResolve?.();
    job.deadlineResolve = undefined;
    if (job.timer) clearTimeout(job.timer);
    this.jobs.delete(job.jobId);
    if (this.cacheIndex.get(job.cacheKey) === job.jobId) this.cacheIndex.delete(job.cacheKey);
  }
}

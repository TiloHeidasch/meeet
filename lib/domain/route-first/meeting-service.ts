import type { RouteFirstEnumerationProvider } from "../providers.ts";
import {
  canonicalId,
  normalizeRouteJourney,
  normalizeTargetTopology,
  sameSnapshot,
  type AccessibleTargetInterval,
  type AccessibleTargetVertex,
  type FairVertexEvidence,
  type MeetingTargetTopology,
  type RouteEnumerationInput,
  type RouteJourney,
  type RouteSnapshotIdentity,
  validateSnapshot,
} from "./models.ts";
import {
  canonicalEnumerationPolicyKey,
  canonicalRouteSnapshotKey,
  canonicalEnumeratedRoutePathKey,
  verifyEnumerationCertificate,
  type EnumerationCertificate,
  type EnumeratedRoutePath,
  type RouteEnumerationResult,
} from "./enumeration.ts";
import { exactTemporalCorridor, type CompleteAlternateRegionCertificate, type ExactTemporalCorridor, type RouteFamilyRequestContext } from "./corridor.ts";
import { allParticipantToleranceRegion, type FairRegion, type TargetTimeProfile } from "./fairness.ts";
import {
  constructFairEligibleComponents,
  type EligibleTargetComponent,
} from "./topology.ts";
import type { MeaningfulRouteFamily } from "./families.ts";
import { Rational, type RationalInput } from "./rational.ts";
import { parseRouteFirstClientSubmission, type RouteFirstClientSubmission } from "./request-contract.ts";
import { routeFirstClientSubmissionFingerprint } from "./fingerprint.ts";

export type RouteFirstMeetingMode = "transit" | "bike" | "car";
export type RouteFirstRoutingSnapshotSource = "MVG" | "MVV" | "OSM";
export type RouteFirstCalculationCompleteness = "complete" | "incomplete" | "unavailable" | "failed";
export type RouteFirstMeetingEnumerationProvider = RouteFirstEnumerationProvider;

export const MAX_ROUTE_FIRST_JOURNEYS = 256;
export const MAX_ROUTE_FIRST_TARGET_EDGES = 256;
export const MAX_ROUTE_FIRST_FAMILIES = 64;
export const MAX_ROUTE_FIRST_LANDMARKS = 128;
export const MAX_ROUTE_FIRST_GRAPH_VERTICES = 512;
export const MAX_ROUTE_FIRST_GRAPH_EDGES = 2_048;
export const MAX_ROUTE_FIRST_JOURNEY_OCCURRENCES = 512;
export const MAX_ROUTE_FIRST_PROFILE_SEGMENTS = 512;
export const MAX_ROUTE_FIRST_LEGAL_INTERVALS = 512;
export const MAX_ROUTE_FIRST_AGGREGATE_WORK = BigInt(4_000_000);

export interface RouteFirstMeetingParticipant {
  readonly participantId: string;
  readonly origin: { readonly latitude: number; readonly longitude: number };
  readonly originVertexId: string;
  readonly destinationVertexId: string;
  readonly mode: RouteFirstMeetingMode;
}

export interface RouteFirstRoutingSnapshotProvenance {
  readonly source: RouteFirstRoutingSnapshotSource;
  readonly snapshot: RouteSnapshotIdentity;
}

export interface RouteFirstEnumerationJob {
  readonly participantId: string;
  readonly input: RouteEnumerationInput;
}

export interface RouteFirstEligibilityInput {
  readonly topology: MeetingTargetTopology;
  readonly accessibleIntervals: readonly AccessibleTargetInterval[];
  readonly accessibleVertices: readonly AccessibleTargetVertex[];
  readonly fairVertexEvidence?: readonly FairVertexEvidence[];
}

export interface RouteFirstFamilyContext {
  readonly contextKey: string;
  readonly skeletonKey: string;
  readonly geometryKey: string;
  readonly participantIds: readonly string[];
  readonly pathKeys: readonly string[];
  readonly targetEdgeIds: readonly string[];
}

export interface RouteFirstConditionalLandmark {
  readonly id: string;
  readonly kind: "conditional-landmark";
  readonly evidence: FairVertexEvidence;
}

export interface RouteFirstMeetingRequest {
  readonly requestId: string;
  readonly clientSubmission: RouteFirstClientSubmission;
  readonly departureAt: string;
  readonly departureContext: string;
  readonly tolerancePercent: RationalInput;
  readonly snapshot: RouteSnapshotIdentity;
  readonly routingSnapshots: readonly RouteFirstRoutingSnapshotProvenance[];
  readonly participants: readonly RouteFirstMeetingParticipant[];
  readonly enumerationJobs: readonly RouteFirstEnumerationJob[];
  readonly journeys: readonly RouteJourney[];
  readonly targetProfiles: readonly TargetTimeProfile[];
  readonly eligibility: RouteFirstEligibilityInput;
  readonly familyContexts: readonly RouteFirstFamilyContext[];
  readonly alternateEvidence?: readonly RouteFirstAlternateEvidence[];
  readonly organicComponentDiversityMinimum?: number;
  readonly conditionalLandmarks?: readonly RouteFirstConditionalLandmark[];
}

export interface RouteFirstMeetingProvenance {
  readonly contractVersion: "route-first-meeting-service/v1";
  readonly requestId: string;
  readonly departureContext: string;
  readonly snapshot: RouteSnapshotIdentity;
  readonly routingSnapshots: readonly RouteFirstRoutingSnapshotProvenance[];
  readonly calculationCompleteness: RouteFirstCalculationCompleteness;
  readonly participantIds: readonly string[];
  readonly participantModes: readonly RouteFirstMeetingMode[];
  readonly tolerancePercent: string;
  readonly requestFingerprint: string;
  readonly policyFingerprints: readonly { readonly participantId: string; readonly policyFingerprint: string; readonly snapshotFingerprint: string }[];
}

export interface RouteFirstEnumerationEvidence {
  readonly participantId: string;
  readonly status: "complete" | "incomplete" | "unavailable";
  readonly certificate: EnumerationCertificate | null;
}

export interface RouteFirstParticipantCorridor {
  readonly participantId: string;
  readonly journeyId: string;
  readonly corridor: ExactTemporalCorridor;
  readonly directionalGeometry: readonly { readonly xMm: string; readonly yMm: string }[];
  readonly envelopeGeometry: readonly { readonly xMm: string; readonly yMm: string }[];
  readonly alternateJourneyIds: readonly string[];
}

export interface RouteFirstAlternateEvidence {
  readonly journeyId: string;
  readonly context: RouteFamilyRequestContext;
  readonly alternates: readonly CompleteAlternateRegionCertificate[];
}

export interface RouteFirstFairRegionGeometry {
  readonly edgeId: string;
  readonly start: { readonly xMm: string; readonly yMm: string };
  readonly end: { readonly xMm: string; readonly yMm: string };
}

export interface RouteFirstAdmittedLandmark {
  readonly id: string;
  readonly kind: "conditional-landmark";
  readonly snapshot: RouteSnapshotIdentity;
  readonly participantIds: readonly string[];
  readonly vertexId: string;
  readonly scope: "all-participants";
}

export interface RouteFirstMeetingFamily extends MeaningfulRouteFamily {
  readonly participantIds: readonly string[];
  readonly pathKeys: readonly string[];
  readonly targetEdgeIds: readonly string[];
}

export interface RouteFirstLandmarkEvaluation {
  readonly organicComponentCount: number;
  readonly minimumOrganicComponentDiversity: number;
  readonly evaluated: boolean;
  readonly landmarkIds: readonly string[];
}

export type RouteFirstMeetingFailureCode =
  | "invalid-request"
  | "noncanonical-request"
  | "provider-error"
  | "non-enumerating-result"
  | "certificate-invalid"
  | "snapshot-mismatch"
  | "policy-mismatch"
  | "request-mismatch"
  | "journey-invalid"
  | "profile-invalid"
  | "topology-invalid"
  | "service-error";

export type RouteFirstMeetingIncompleteReason = "work-budget-exhausted" | "missing-coverage";

export interface RouteFirstMeetingCompleteResult {
  readonly status: "complete";
  readonly provenance: RouteFirstMeetingProvenance;
  readonly enumerations: readonly RouteFirstEnumerationEvidence[];
  readonly journeys: readonly RouteJourney[];
  readonly corridors: readonly RouteFirstParticipantCorridor[];
  readonly fairRegion: FairRegion;
  readonly fairRegions: readonly FairRegion[];
  readonly fairRegionGeometry: readonly RouteFirstFairRegionGeometry[];
  readonly components: readonly EligibleTargetComponent[];
  readonly families: readonly RouteFirstMeetingFamily[];
  readonly landmarkEvaluation: RouteFirstLandmarkEvaluation;
  readonly admittedLandmarks: readonly RouteFirstAdmittedLandmark[];
}

export interface RouteFirstMeetingNoEligibleTargetResult {
  readonly status: "no-eligible-target";
  readonly provenance: RouteFirstMeetingProvenance;
  readonly enumerations: readonly RouteFirstEnumerationEvidence[];
  readonly journeys: readonly RouteJourney[];
  readonly corridors: readonly RouteFirstParticipantCorridor[];
  readonly fairRegion: FairRegion;
  readonly fairRegions: readonly FairRegion[];
  readonly fairRegionGeometry: readonly RouteFirstFairRegionGeometry[];
  readonly components: readonly [];
  readonly families: readonly [];
  readonly landmarkEvaluation: RouteFirstLandmarkEvaluation;
  readonly admittedLandmarks: readonly RouteFirstAdmittedLandmark[];
}

export interface RouteFirstMeetingIncompleteResult {
  readonly status: "incomplete";
  readonly provenance: RouteFirstMeetingProvenance;
  readonly participantId: string;
  readonly reason: RouteFirstMeetingIncompleteReason;
  readonly enumerations: readonly RouteFirstEnumerationEvidence[];
}

export interface RouteFirstMeetingUnavailableResult {
  readonly status: "unavailable";
  readonly provenance: RouteFirstMeetingProvenance;
  readonly participantId: string;
  readonly reason: string;
  readonly enumerations: readonly RouteFirstEnumerationEvidence[];
}

export interface RouteFirstMeetingFailedResult {
  readonly status: "failed";
  readonly provenance: RouteFirstMeetingProvenance;
  readonly code: RouteFirstMeetingFailureCode;
  readonly message: string;
  readonly participantId?: string;
  readonly enumerations: readonly RouteFirstEnumerationEvidence[];
}

export type RouteFirstMeetingServiceResult =
  | RouteFirstMeetingCompleteResult
  | RouteFirstMeetingNoEligibleTargetResult
  | RouteFirstMeetingIncompleteResult
  | RouteFirstMeetingUnavailableResult
  | RouteFirstMeetingFailedResult;

export interface RouteFirstMeetingRequestIdentity {
  readonly requestId: string;
  readonly clientSubmission: RouteFirstClientSubmission;
  readonly snapshot: RouteSnapshotIdentity;
  readonly routingSnapshots: readonly RouteFirstRoutingSnapshotProvenance[];
}

export interface RouteFirstMeetingService {
  evaluate(input: RouteFirstMeetingRequest): RouteFirstMeetingServiceResult;
}

/** Provider enumeration plus the certificate verifier's independent re-enumeration. */
export function routeFirstRequiredWorkBudget(input: RouteFirstMeetingRequest): bigint | null {
  if (!input.enumerationJobs.length) return null;
  let participantBudget = BigInt(0);
  for (const job of input.enumerationJobs) {
    const budget = job.input.policy.workBudget;
    if (budget === undefined || budget < BigInt(1)) return null;
    participantBudget += budget;
  }
  let required = participantBudget * BigInt(2);
  for (const alternateEvidence of input.alternateEvidence ?? []) {
    if (!Array.isArray(alternateEvidence.alternates)) return null;
    for (const alternate of alternateEvidence.alternates) {
      const budget = alternate.enumerationInput?.policy?.workBudget;
      if (budget === undefined || budget < BigInt(1)) return null;
      // Each alternate certificate is independently re-enumerated by the
      // corridor verifier. Charge it here before a store can admit the job.
      required += budget;
    }
  }
  return required;
}

/** Store-owned admission gate; an assembled policy may never exceed the job budget. */
export function routeFirstRequestWithinWorkBudget(input: RouteFirstMeetingRequest, workBudget: bigint): boolean {
  if (workBudget < BigInt(1)) return false;
  const required = routeFirstRequiredWorkBudget(input);
  return required !== null && required <= workBudget;
}

class RouteFirstServiceBoundaryError extends Error {
  readonly code: RouteFirstMeetingFailureCode;
  readonly coverage: boolean;

  constructor(code: RouteFirstMeetingFailureCode, message: string, coverage = false) {
    super(message);
    this.name = "RouteFirstServiceBoundaryError";
    this.code = code;
    this.coverage = coverage;
  }
}

function requireCanonicalId(value: unknown, label: string): asserts value is string {
  try {
    canonicalId(value, label);
  } catch (error) {
    throw new RouteFirstServiceBoundaryError("noncanonical-request", error instanceof Error ? error.message : `${label} is invalid.`);
  }
}

function requireSortedUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
    throw new RouteFirstServiceBoundaryError("noncanonical-request", `${label} must be sorted and unique.`);
  }
}

function requireSnapshot(left: RouteSnapshotIdentity, right: RouteSnapshotIdentity, code: RouteFirstMeetingFailureCode, message: string): void {
  try {
    validateSnapshot(left);
    validateSnapshot(right);
  } catch (error) {
    throw new RouteFirstServiceBoundaryError("noncanonical-request", error instanceof Error ? error.message : "Snapshot is invalid.");
  }
  if (!sameSnapshot(left, right)) throw new RouteFirstServiceBoundaryError(code, message);
}

function pathMatchesJourney(path: { readonly vertexIds: readonly string[]; readonly edgeIds: readonly string[] }, journey: RouteJourney): boolean {
  return path.vertexIds.length === journey.path.vertexIds.length && path.edgeIds.length === journey.path.edgeIds.length &&
    path.vertexIds.every((vertexId, index) => vertexId === journey.path.vertexIds[index]) &&
    path.edgeIds.every((edgeId, index) => edgeId === journey.path.edgeIds[index]);
}

function sameTrustedJourney(left: RouteJourney, right: RouteJourney): boolean {
  return left.id === right.id && left.participantId === right.participantId && sameSnapshot(left.snapshot, right.snapshot) &&
    left.requestContext.participantId === right.requestContext.participantId && left.requestContext.originVertexId === right.requestContext.originVertexId &&
    left.requestContext.destinationVertexId === right.requestContext.destinationVertexId && left.requestContext.departureContext === right.requestContext.departureContext &&
    pathMatchesJourney(left.path, right) && left.occurrences.length === right.occurrences.length && left.segments.length === right.segments.length &&
    left.occurrences.every((occurrence, index) => {
      const expected = right.occurrences[index]!;
      return occurrence.occurrenceIndex === expected.occurrenceIndex && occurrence.kind === expected.kind && occurrence.tau.equals(expected.tau) && occurrence.coordinate.equals(expected.coordinate);
    }) && left.segments.every((segment, index) => {
      const expected = right.segments[index]!;
      return segment.id === expected.id && segment.fromOccurrenceIndex === expected.fromOccurrenceIndex && segment.toOccurrenceIndex === expected.toOccurrenceIndex && segment.departureTau.equals(expected.departureTau) && segment.arrivalTau.equals(expected.arrivalTau) && segment.distanceMm.equals(expected.distanceMm) && segment.mode === expected.mode && segment.geometry.length === expected.geometry.length && segment.geometry.every((point, pointIndex) => point.equals(expected.geometry[pointIndex]!));
    });
}

function makeProvenance(input: RouteFirstMeetingRequest, completeness: RouteFirstCalculationCompleteness): RouteFirstMeetingProvenance {
  return Object.freeze({
    contractVersion: "route-first-meeting-service/v1" as const,
    requestId: input.requestId,
    departureContext: input.departureContext,
    snapshot: input.snapshot,
    routingSnapshots: Object.freeze([...input.routingSnapshots]),
    calculationCompleteness: completeness,
    participantIds: Object.freeze(input.participants.map((participant) => participant.participantId)),
    participantModes: Object.freeze(input.participants.map((participant) => participant.mode)),
    tolerancePercent: Rational.from(input.tolerancePercent).toString(),
    requestFingerprint: routeFirstClientSubmissionFingerprint(input.clientSubmission),
    policyFingerprints: Object.freeze(input.enumerationJobs.map((job) => ({ participantId: job.participantId, policyFingerprint: canonicalEnumerationPolicyKey(job.input.policy), snapshotFingerprint: canonicalRouteSnapshotKey(job.input.policy.snapshot) }))),
  });
}

export function unavailableRouteFirstMeetingResult(
  identity: RouteFirstMeetingRequestIdentity,
  reason = "Route-first calculation is unavailable.",
): RouteFirstMeetingUnavailableResult {
  return Object.freeze({
    status: "unavailable" as const,
    provenance: Object.freeze({
      contractVersion: "route-first-meeting-service/v1" as const,
      requestId: identity.requestId,
      departureContext: identity.clientSubmission.departureAt,
      snapshot: identity.snapshot,
      routingSnapshots: Object.freeze([...identity.routingSnapshots]),
      calculationCompleteness: "unavailable" as const,
      participantIds: Object.freeze(identity.clientSubmission.participants.map((participant) => participant.participantId)),
      participantModes: Object.freeze(identity.clientSubmission.participants.map((participant) => participant.mode)),
      tolerancePercent: identity.clientSubmission.tolerancePercent,
      requestFingerprint: routeFirstClientSubmissionFingerprint(identity.clientSubmission),
      policyFingerprints: Object.freeze([]),
    }),
    participantId: identity.clientSubmission.participants[0]?.participantId ?? "unavailable",
    reason: reason.trim() ? reason : "Route-first calculation is unavailable.",
    enumerations: Object.freeze([]),
  });
}

function failed(
  input: RouteFirstMeetingRequest,
  code: RouteFirstMeetingFailureCode,
  message: string,
  enumerations: readonly RouteFirstEnumerationEvidence[] = [],
  participantId?: string,
): RouteFirstMeetingFailedResult {
  return Object.freeze({
    status: "failed" as const,
    provenance: makeProvenance(input, "failed"),
    code,
    message,
    ...(participantId === undefined ? {} : { participantId }),
    enumerations: Object.freeze([...enumerations]),
  });
}

function coverageError(code: RouteFirstMeetingFailureCode, message: string): RouteFirstServiceBoundaryError {
  return new RouteFirstServiceBoundaryError(code, message, true);
}

function pathCoverageKey(participantId: string, path: EnumeratedRoutePath): string {
  return `${participantId}:${canonicalEnumeratedRoutePathKey(path)}`;
}

function participantModeAllowed(mode: RouteFirstMeetingMode): readonly string[] {
  return mode === "transit"
    ? ["transit", "walk", "wait", "dwell"]
    : mode === "bike"
      ? ["bike", "walk", "wait", "dwell"]
      : ["car", "walk", "wait", "dwell"];
}

function validateJourneyAgainstTrustedGraph(journey: RouteJourney, graph: RouteEnumerationInput["graph"], participantId: string): void {
  const vertices = new Map(graph.vertices.map((vertex) => [vertex.id, vertex]));
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]));
  if (journey.path.vertexIds.length !== journey.occurrences.length || journey.path.edgeIds.length !== journey.segments.length) throw coverageError("journey-invalid", `Journey ${journey.id} does not map legs to certified graph edges.`);
  for (const [index, vertexId] of journey.path.vertexIds.entries()) {
    const vertex = vertices.get(vertexId);
    if (!vertex || !vertex.coordinate.equals(journey.occurrences[index]!.coordinate)) throw coverageError("journey-invalid", `Journey ${journey.id} occurrence ${index} is not bound to graph vertex coordinates.`);
  }
  let totalDuration = Rational.zero();
  let totalDistance = Rational.zero();
  for (const [index, edgeId] of journey.path.edgeIds.entries()) {
    const edge = edges.get(edgeId);
    const segment = journey.segments[index]!;
    if (!edge || edge.fromVertexId !== journey.path.vertexIds[index] || edge.toVertexId !== journey.path.vertexIds[index + 1] || edge.mode !== segment.mode || !edge.duration.equals(segment.arrivalTau.subtract(segment.departureTau)) || !edge.distanceMm.equals(segment.distanceMm)) {
      throw coverageError("journey-invalid", `Journey ${journey.id} leg ${index} is not bound to certified graph edge timing or distance.`);
    }
    if (!segment.geometry[0]!.equals(vertices.get(edge.fromVertexId)!.coordinate) || !segment.geometry[segment.geometry.length - 1]!.equals(vertices.get(edge.toVertexId)!.coordinate)) throw coverageError("journey-invalid", `Journey ${journey.id} leg ${index} geometry is not graph-bound.`);
    totalDuration = totalDuration.add(edge.duration);
    totalDistance = totalDistance.add(edge.distanceMm);
  }
  if (!totalDuration.equals(journey.occurrences[journey.occurrences.length - 1]!.tau.subtract(journey.occurrences[0]!.tau)) || totalDistance.compare(0) < 0) throw coverageError("journey-invalid", `Journey ${journey.id} totals do not match certified graph edges for ${participantId}.`);
}

function validateRequest(input: RouteFirstMeetingRequest): Rational {
  requireCanonicalId(input.requestId, "route-first requestId");
  requireCanonicalId(input.departureContext, "route-first departureContext");
  if (!input.clientSubmission || input.departureAt !== input.clientSubmission.departureAt || input.departureContext !== input.departureAt) {
    throw coverageError("request-mismatch", "Trusted route-first request is not bound to its client submission.");
  }
  try {
    const normalizedSubmission = parseRouteFirstClientSubmission(input.clientSubmission);
    if (routeFirstClientSubmissionFingerprint(normalizedSubmission) !== routeFirstClientSubmissionFingerprint(input.clientSubmission)) throw new Error("Client submission is not canonical.");
  } catch (error) {
    throw coverageError("invalid-request", error instanceof Error ? error.message : "Client submission is invalid.");
  }
  try {
    validateSnapshot(input.snapshot);
  } catch (error) {
    throw new RouteFirstServiceBoundaryError("noncanonical-request", error instanceof Error ? error.message : "Request snapshot is invalid.");
  }
  let tolerance: Rational;
  try {
    tolerance = Rational.from(input.tolerancePercent);
  } catch (error) {
    throw new RouteFirstServiceBoundaryError("invalid-request", error instanceof Error ? error.message : "Tolerance is invalid.");
  }
  if (tolerance.isNegative() || tolerance.compare(100) > 0) throw new RouteFirstServiceBoundaryError("invalid-request", "Route-first tolerance must be within [0, 100].");
  if (!Array.isArray(input.routingSnapshots) || input.routingSnapshots.length === 0 || input.routingSnapshots.length > 3) {
    throw new RouteFirstServiceBoundaryError("invalid-request", "At least one and at most three routing snapshot sources are required.");
  }
  const sourceOrder: readonly RouteFirstRoutingSnapshotSource[] = ["MVG", "MVV", "OSM"];
  const sources = input.routingSnapshots.map((entry) => entry.source);
  const sourceRanks = sources.map((source) => sourceOrder.indexOf(source));
  if (new Set(sources).size !== sources.length || sourceRanks.some((rank, index) => rank < 0 || (index > 0 && sourceRanks[index - 1]! >= rank))) {
    throw new RouteFirstServiceBoundaryError("noncanonical-request", "Routing snapshot provenance must use unique canonical MVG/MVV/OSM order.");
  }
  for (const entry of input.routingSnapshots) requireSnapshot(entry.snapshot, input.snapshot, "snapshot-mismatch", "Routing snapshot provenance does not match the request snapshot.");

  if (!Array.isArray(input.participants) || input.participants.length < 2 || input.participants.length > 4) {
    throw new RouteFirstServiceBoundaryError("invalid-request", "Route-first meetings require 2 to 4 participants.");
  }
  const participantIds = input.participants.map((participant) => participant.participantId);
  requireSortedUnique(participantIds, "Participant ids");
  for (const participant of input.participants) {
    requireCanonicalId(participant.participantId, "participantId");
    requireCanonicalId(participant.originVertexId, "originVertexId");
    requireCanonicalId(participant.destinationVertexId, "destinationVertexId");
    if (!["transit", "bike", "car"].includes(participant.mode)) throw new RouteFirstServiceBoundaryError("invalid-request", `Participant ${participant.participantId} has an unsupported travel mode.`);
    if (participant.originVertexId === participant.destinationVertexId) throw new RouteFirstServiceBoundaryError("invalid-request", `Participant ${participant.participantId} has identical origin and destination.`);
    const submitted = input.clientSubmission.participants.find((candidate) => candidate.participantId === participant.participantId);
    if (!submitted || submitted.mode !== participant.mode || submitted.origin.latitude !== participant.origin.latitude || submitted.origin.longitude !== participant.origin.longitude) {
      throw coverageError("request-mismatch", `Participant ${participant.participantId} is not bound to the client submission.`);
    }
  }
  if (input.clientSubmission.participants.length !== input.participants.length || input.clientSubmission.participants.some((participant, index) => participant.participantId !== participantIds[index])) {
    throw coverageError("request-mismatch", "Trusted participants do not cover the client participant set.");
  }
  if (!Array.isArray(input.enumerationJobs) || input.enumerationJobs.length !== input.participants.length) {
    throw new RouteFirstServiceBoundaryError("request-mismatch", "Every participant requires one route enumeration job.");
  }
  const jobs = input.enumerationJobs.map((job) => job.participantId);
  requireSortedUnique(jobs, "Enumeration job participant ids");
  if (jobs.some((participantId, index) => participantId !== participantIds[index])) throw new RouteFirstServiceBoundaryError("request-mismatch", "Enumeration jobs do not cover the canonical participant set.");
  let aggregateGraphWork = BigInt(0);
  for (const job of input.enumerationJobs) {
    const participant = input.participants.find((candidate) => candidate.participantId === job.participantId)!;
    if (job.input.graph.vertices.length === 0 || job.input.graph.vertices.length > MAX_ROUTE_FIRST_GRAPH_VERTICES || job.input.graph.edges.length > MAX_ROUTE_FIRST_GRAPH_EDGES || job.input.graph.vertices.length * Math.max(1, job.input.graph.edges.length) > MAX_ROUTE_FIRST_AGGREGATE_WORK) {
      throw coverageError("request-mismatch", `Enumeration graph for ${job.participantId} exceeds the trusted aggregate bound.`);
    }
    aggregateGraphWork += BigInt(job.input.graph.vertices.length) * BigInt(Math.max(1, job.input.graph.edges.length));
    if (aggregateGraphWork > MAX_ROUTE_FIRST_AGGREGATE_WORK) throw coverageError("request-mismatch", "Trusted participant graphs exceed the aggregate work bound.");
    const origins = job.input.originVertexIds;
    const targets = job.input.targetVertexIds;
    if (origins.length !== 1 || targets.length !== 1 || origins[0] !== participant.originVertexId || targets[0] !== participant.destinationVertexId) {
      throw new RouteFirstServiceBoundaryError("request-mismatch", `Enumeration request for ${job.participantId} does not match its origin/destination context.`);
    }
    requireSnapshot(job.input.policy.snapshot, input.snapshot, "snapshot-mismatch", `Enumeration request for ${job.participantId} has a mismatched snapshot.`);
    const allowedModes: readonly string[] = job.input.policy.allowedModes ?? [];
    if (job.input.policy.workBudget === undefined || job.input.policy.workBudget < BigInt(1) || job.input.policy.workBudget > MAX_ROUTE_FIRST_AGGREGATE_WORK) {
      throw coverageError("policy-mismatch", `Enumeration policy for ${job.participantId} lacks a bounded work budget.`);
    }
    if (!allowedModes.includes(participant.mode) || allowedModes.some((mode, index) => index > 0 && allowedModes[index - 1]! > mode)) {
      throw new RouteFirstServiceBoundaryError("policy-mismatch", `Enumeration policy for ${job.participantId} does not bind its travel mode.`);
    }
  }
  const requiredWorkBudget = routeFirstRequiredWorkBudget(input);
  if (requiredWorkBudget === null || requiredWorkBudget > MAX_ROUTE_FIRST_AGGREGATE_WORK) throw coverageError("policy-mismatch", "Participant policies plus certificate verification exceed the aggregate work bound.");
  if (!Array.isArray(input.journeys) || input.journeys.length === 0 || input.journeys.length > MAX_ROUTE_FIRST_JOURNEYS) throw coverageError("request-mismatch", "Every certified route path requires a bounded complete journey set.");
  const journeyKeys = new Set<string>();
  let aggregateJourneyWork = BigInt(0);
  for (const journeyInput of input.journeys) {
    let journey: RouteJourney;
    try {
      journey = normalizeRouteJourney(journeyInput);
    } catch (error) {
      throw coverageError("journey-invalid", error instanceof Error ? error.message : `Journey ${journeyInput.id} is invalid.`);
    }
    const participant = input.participants.find((candidate) => candidate.participantId === journey.participantId)!;
    if (journey.occurrences.length > MAX_ROUTE_FIRST_JOURNEY_OCCURRENCES || journey.segments.length > MAX_ROUTE_FIRST_JOURNEY_OCCURRENCES) throw coverageError("journey-invalid", `Journey ${journey.id} exceeds the trusted timing bound.`);
    aggregateJourneyWork += BigInt(journey.occurrences.length) * BigInt(Math.max(1, journey.segments.length));
    if (aggregateJourneyWork > MAX_ROUTE_FIRST_AGGREGATE_WORK) throw coverageError("journey-invalid", "Trusted journeys exceed the aggregate timing/geometry bound.");
    const journeyKey = pathCoverageKey(journey.participantId, {
      vertexIds: journey.path.vertexIds,
      edgeIds: journey.path.edgeIds,
      duration: journey.segments.reduce((total, segment) => total.add(segment.arrivalTau.subtract(segment.departureTau)), Rational.zero()),
      distanceMm: journey.segments.reduce((total, segment) => total.add(segment.distanceMm), Rational.zero()),
      loopless: true,
    });
    if (journeyKeys.has(journeyKey)) throw coverageError("request-mismatch", `Journey ${journey.id} is duplicated.`);
    journeyKeys.add(journeyKey);
    if (!sameSnapshot(journey.snapshot, input.snapshot) || journey.requestContext.departureContext !== input.departureContext ||
      journey.requestContext.originVertexId !== participant.originVertexId || journey.requestContext.destinationVertexId !== participant.destinationVertexId) {
      throw coverageError("request-mismatch", `Journey ${journey.id} is not bound to the meeting request.`);
    }
    const allowedModes = new Set(participantModeAllowed(participant.mode));
    if (journey.segments.some((segment) => !allowedModes.has(segment.mode))) {
      throw new RouteFirstServiceBoundaryError("request-mismatch", `Journey ${journey.id} contains a mode that is not allowed for ${participant.mode}.`);
    }
    const journeyJob = input.enumerationJobs.find((job) => job.participantId === journey.participantId);
    if (!journeyJob) throw coverageError("journey-invalid", `Journey ${journey.id} has no trusted graph job.`);
    validateJourneyAgainstTrustedGraph(journey, journeyJob.input.graph, journey.participantId);
  }
  if (!Array.isArray(input.targetProfiles) || input.targetProfiles.length > MAX_ROUTE_FIRST_TARGET_EDGES * 4) throw coverageError("profile-invalid", "Target time profiles are missing or exceed the bound.");
  let topology: MeetingTargetTopology;
  try {
    topology = normalizeTargetTopology(input.eligibility.topology);
  } catch (error) {
    throw coverageError("topology-invalid", error instanceof Error ? error.message : "Eligibility topology is invalid.");
  }
  requireSnapshot(topology.snapshot, input.snapshot, "snapshot-mismatch", "Eligibility topology has a mismatched snapshot.");
  if (topology.vertices.length > MAX_ROUTE_FIRST_TARGET_EDGES || input.eligibility.accessibleIntervals.length > MAX_ROUTE_FIRST_TARGET_EDGES * 4 || input.eligibility.accessibleVertices.length > MAX_ROUTE_FIRST_TARGET_EDGES * 4) {
    throw coverageError("topology-invalid", "Trusted target topology or accessibility evidence exceeds its bound.");
  }
  if (topology.edges.some((edge) => edge.legalIntervals.length > MAX_ROUTE_FIRST_LEGAL_INTERVALS) || topology.edges.reduce((total, edge) => total + edge.legalIntervals.length, 0) > Number(MAX_ROUTE_FIRST_AGGREGATE_WORK)) throw coverageError("topology-invalid", "Target edge legal intervals exceed the trusted bound.");
  requireSortedUnique(topology.vertices.map((vertex) => vertex.id), "Topology vertex ids");
  requireSortedUnique(topology.edges.map((edge) => edge.id), "Topology edge ids");
  if (topology.edges.length === 0 || topology.edges.length > MAX_ROUTE_FIRST_TARGET_EDGES) throw coverageError("topology-invalid", "Trusted target topology contains no bounded target edge set.");
  const targetEdgeIds = topology.edges.filter((edge) => edge.meetingEligible).map((edge) => edge.id);
  if (targetEdgeIds.length === 0) throw coverageError("topology-invalid", "Trusted target topology contains no relevant target edges.");
  const expectedProfileKeys = new Set(targetEdgeIds.flatMap((edgeId) => participantIds.map((participantId) => `${participantId}:${edgeId}`)));
  if (input.targetProfiles.length !== expectedProfileKeys.size) throw coverageError("profile-invalid", "Target profiles do not cover every participant and relevant target edge.");
  const seenProfileKeys = new Set<string>();
  let aggregateProfileWork = BigInt(0);
  for (const profile of input.targetProfiles) {
    if (profile.segments.length === 0 || profile.segments.length > MAX_ROUTE_FIRST_PROFILE_SEGMENTS || (profile.stationaryOccurrences?.length ?? 0) > MAX_ROUTE_FIRST_PROFILE_SEGMENTS) throw coverageError("profile-invalid", `Target profile ${profile.participantId}:${profile.edgeId} exceeds the trusted profile bound.`);
    aggregateProfileWork += BigInt(profile.segments.length + (profile.stationaryOccurrences?.length ?? 0));
    if (aggregateProfileWork > MAX_ROUTE_FIRST_AGGREGATE_WORK) throw coverageError("profile-invalid", "Trusted profiles exceed the aggregate timing bound.");
    requireSnapshot(profile.snapshot, input.snapshot, "snapshot-mismatch", `Target profile for ${profile.participantId} has a mismatched snapshot.`);
    const key = `${profile.participantId}:${profile.edgeId}`;
    if (!expectedProfileKeys.has(key) || seenProfileKeys.has(key)) throw coverageError("profile-invalid", `Target profile ${key} is outside the trusted target-edge coverage.`);
    seenProfileKeys.add(key);
  }
  if (seenProfileKeys.size !== expectedProfileKeys.size) throw coverageError("profile-invalid", "Target profiles are incomplete.");
  for (const participantId of participantIds) for (const edgeId of targetEdgeIds) {
    if (!input.eligibility.accessibleIntervals.some((item) => item.participantId === participantId && item.edgeId === edgeId)) {
      throw coverageError("topology-invalid", `Accessibility coverage is missing for ${participantId}:${edgeId}.`);
    }
  }
  if (input.organicComponentDiversityMinimum !== undefined && (!Number.isInteger(input.organicComponentDiversityMinimum) || input.organicComponentDiversityMinimum < 1)) {
    throw new RouteFirstServiceBoundaryError("invalid-request", "Organic component diversity minimum must be a positive integer.");
  }
  if (input.familyContexts.length === 0 || input.familyContexts.length > MAX_ROUTE_FIRST_FAMILIES) throw coverageError("request-mismatch", "Certified route families are missing or exceed the bound.");
  const familyPathKeys = new Set<string>();
  let aggregateFamilyWork = BigInt(0);
  for (const family of input.familyContexts) {
    requireCanonicalId(family.contextKey, "family contextKey");
    requireCanonicalId(family.skeletonKey, "family skeletonKey");
    requireCanonicalId(family.geometryKey, "family geometryKey");
    if (family.participantIds.length !== participantIds.length || family.participantIds.some((id, index) => id !== participantIds[index])) throw coverageError("request-mismatch", `Family ${family.contextKey} has incomplete participant coverage.`);
    if (family.pathKeys.length > MAX_ROUTE_FIRST_JOURNEYS) throw coverageError("request-mismatch", `Family ${family.contextKey} exceeds the certified path bound.`);
    aggregateFamilyWork += BigInt(family.pathKeys.length) * BigInt(Math.max(1, family.targetEdgeIds.length));
    if (aggregateFamilyWork > MAX_ROUTE_FIRST_AGGREGATE_WORK) throw coverageError("request-mismatch", "Certified families exceed the aggregate path/edge bound.");
    requireSortedUnique(family.pathKeys, `Family ${family.contextKey} path keys`);
    requireSortedUnique(family.targetEdgeIds, `Family ${family.contextKey} target edges`);
    if (family.targetEdgeIds.length !== targetEdgeIds.length || family.targetEdgeIds.some((edgeId, index) => edgeId !== targetEdgeIds[index])) throw coverageError("request-mismatch", `Family ${family.contextKey} does not cover every relevant target edge.`);
    for (const pathKey of family.pathKeys) {
      if (familyPathKeys.has(pathKey)) throw coverageError("request-mismatch", `Certified route path ${pathKey} belongs to multiple families.`);
      familyPathKeys.add(pathKey);
    }
  }
  if (familyPathKeys.size === 0) throw coverageError("request-mismatch", "Certified route families contain no paths.");
  return tolerance;
}

function validateProviderResult(input: RouteEnumerationInput, result: unknown): RouteEnumerationResult {
  if (!result || typeof result !== "object" || !("status" in result) || !["complete", "incomplete", "unavailable"].includes(result.status as string)) {
    throw new RouteFirstServiceBoundaryError("non-enumerating-result", "Enumeration provider returned a non-enumerating result.");
  }
  const typedResult = result as RouteEnumerationResult;
  if ((typedResult.status === "complete" || typedResult.status === "incomplete") && typedResult.paths.length > MAX_ROUTE_FIRST_JOURNEYS) {
    throw new RouteFirstServiceBoundaryError("non-enumerating-result", "Enumeration provider exceeded the bounded path limit.");
  }
  if (typedResult.status === "unavailable" && (!Array.isArray(typedResult.paths) || typedResult.paths.length !== 0 || typedResult.certificate !== null || typeof typedResult.reason !== "string" || !typedResult.reason.trim())) {
    throw new RouteFirstServiceBoundaryError("non-enumerating-result", "Enumeration provider returned a malformed unavailable result.");
  }
  if (typedResult.status === "incomplete" && typedResult.reason !== "work-budget-exhausted") {
    throw new RouteFirstServiceBoundaryError("non-enumerating-result", "Enumeration provider returned a malformed incomplete result.");
  }
  if (typedResult.status === "complete" || typedResult.status === "incomplete") {
    if (typedResult.certificate.policyFingerprint !== canonicalEnumerationPolicyKey(input.policy)) {
      throw new RouteFirstServiceBoundaryError("policy-mismatch", "Enumeration certificate policy provenance does not match the request policy.");
    }
    if (typedResult.certificate.snapshotFingerprint !== canonicalRouteSnapshotKey(input.policy.snapshot)) {
      throw new RouteFirstServiceBoundaryError("snapshot-mismatch", "Enumeration certificate snapshot provenance does not match the request snapshot.");
    }
    try {
      verifyEnumerationCertificate(input, typedResult);
    } catch (error) {
      throw new RouteFirstServiceBoundaryError("certificate-invalid", error instanceof Error ? error.message : "Enumeration certificate is invalid.");
    }
  }
  return typedResult;
}

function evidence(participantId: string, result: RouteEnumerationResult): RouteFirstEnumerationEvidence {
  return Object.freeze({
    participantId,
    status: result.status,
    certificate: result.certificate,
  });
}

function validateConditionalLandmarks(
  input: RouteFirstMeetingRequest,
  participantIds: readonly string[],
): readonly RouteFirstConditionalLandmark[] {
  const landmarks = input.conditionalLandmarks ?? [];
  if (landmarks.length > MAX_ROUTE_FIRST_LANDMARKS) throw new RouteFirstServiceBoundaryError("topology-invalid", "Conditional landmark evidence exceeds its bound.");
  const ids = landmarks.map((landmark) => landmark.id);
  requireSortedUnique(ids, "Conditional landmark ids");
  for (const landmark of landmarks) {
    requireCanonicalId(landmark.id, "conditional landmark id");
    if (landmark.kind !== "conditional-landmark" || landmark.evidence.scope !== "all-participants" ||
      landmark.evidence.participantIds.length !== participantIds.length || landmark.evidence.participantIds.some((id, index) => id !== participantIds[index])) {
      throw new RouteFirstServiceBoundaryError("topology-invalid", `Conditional landmark ${landmark.id} has invalid participant scope.`);
    }
    requireSnapshot(landmark.evidence.snapshot, input.snapshot, "snapshot-mismatch", `Conditional landmark ${landmark.id} has a mismatched snapshot.`);
  }
  return landmarks;
}

function wireCoordinate(value: { readonly xMm: bigint; readonly yMm: bigint }): { readonly xMm: string; readonly yMm: string } {
  return { xMm: value.xMm.toString(), yMm: value.yMm.toString() };
}

function journeyGeometry(journey: RouteJourney): readonly { readonly xMm: string; readonly yMm: string }[] {
  const points: { xMm: string; yMm: string }[] = [];
  for (const segment of journey.segments) for (const point of segment.geometry) {
    const value = wireCoordinate(point);
    const previous = points[points.length - 1];
    if (!previous || previous.xMm !== value.xMm || previous.yMm !== value.yMm) points.push(value);
  }
  return Object.freeze(points);
}

function incomplete(
  input: RouteFirstMeetingRequest,
  reason: RouteFirstMeetingIncompleteReason,
  enumerations: readonly RouteFirstEnumerationEvidence[] = [],
  participantId = input.participants[0]?.participantId ?? "coverage",
): RouteFirstMeetingIncompleteResult {
  return Object.freeze({ status: "incomplete" as const, provenance: makeProvenance(input, "incomplete"), participantId, reason, enumerations: Object.freeze([...enumerations]) });
}

export function runRouteFirstMeetingService(
  input: RouteFirstMeetingRequest,
  provider: RouteFirstEnumerationProvider,
): RouteFirstMeetingServiceResult {
  const emptyEvidence: readonly RouteFirstEnumerationEvidence[] = [];
  try {
    const tolerance = validateRequest(input);
    if (!provider || typeof provider.enumerateRoutes !== "function") return failed(input, "provider-error", "Route-first enumeration provider is unavailable.");
    const participants = input.participants;
    const participantIds = participants.map((participant) => participant.participantId);
    const enumerationEvidence: RouteFirstEnumerationEvidence[] = [];
    const enumerationResults = new Map<string, RouteEnumerationResult>();
    for (const job of input.enumerationJobs) {
      let rawResult: unknown;
      try {
        rawResult = provider.enumerateRoutes(job.input);
      } catch (error) {
        return failed(input, "provider-error", error instanceof Error ? error.message : `Enumeration provider failed for ${job.participantId}.`, enumerationEvidence, job.participantId);
      }
      let result: RouteEnumerationResult;
      try {
        result = validateProviderResult(job.input, rawResult);
      } catch (error) {
        const boundaryError = error instanceof RouteFirstServiceBoundaryError ? error : new RouteFirstServiceBoundaryError("certificate-invalid", error instanceof Error ? error.message : "Enumeration result is invalid.");
        return failed(input, boundaryError.code, boundaryError.message, enumerationEvidence, job.participantId);
      }
      enumerationEvidence.push(evidence(job.participantId, result));
      enumerationResults.set(job.participantId, result);
      if (result.status === "incomplete") {
        return Object.freeze({ status: "incomplete" as const, provenance: makeProvenance(input, "incomplete"), participantId: job.participantId, reason: result.reason, enumerations: Object.freeze([...enumerationEvidence]) });
      }
      if (result.status === "unavailable") {
        return Object.freeze({ status: "unavailable" as const, provenance: makeProvenance(input, "unavailable"), participantId: job.participantId, reason: result.reason, enumerations: Object.freeze([...enumerationEvidence]) });
      }
      if (result.paths.length === 0) return failed(input, "non-enumerating-result", `Enumeration provider returned no route paths for ${job.participantId}.`, enumerationEvidence, job.participantId);
    }

    let normalizedJourneys: readonly RouteJourney[];
    try {
      normalizedJourneys = input.journeys.map((journey) => normalizeRouteJourney(journey));
    } catch (error) {
      return incomplete(input, "missing-coverage", enumerationEvidence);
    }
    const certifiedPathKeys = new Set<string>();
    const pathKeyByJourneyId = new Map<string, string>();
    const journeyByPathKey = new Map<string, RouteJourney>();
    for (const journey of normalizedJourneys) {
      const result = enumerationResults.get(journey.participantId);
      if (!result || result.status !== "complete") {
        return incomplete(input, "missing-coverage", enumerationEvidence, journey.participantId);
      }
      const matching = result.paths.filter((path) => pathMatchesJourney(path, journey));
      if (matching.length !== 1) {
        return incomplete(input, "missing-coverage", enumerationEvidence, journey.participantId);
      }
      const pathKey = pathCoverageKey(journey.participantId, matching[0]!);
      certifiedPathKeys.add(pathKey);
      pathKeyByJourneyId.set(journey.id, pathKey);
      journeyByPathKey.set(pathKey, journey);
    }
    let expectedPathCount = 0;
    for (const job of input.enumerationJobs) {
      const result = enumerationResults.get(job.participantId);
      if (!result || result.status !== "complete") return incomplete(input, "missing-coverage", enumerationEvidence, job.participantId);
      const participantJourneys = normalizedJourneys.filter((journey) => journey.participantId === job.participantId);
      expectedPathCount += result.paths.length;
      const expected = result.paths.map((path) => pathCoverageKey(job.participantId, path));
      if (expected.length === 0 || participantJourneys.length !== result.paths.length || expected.some((key) => !certifiedPathKeys.has(key))) {
        return incomplete(input, "missing-coverage", enumerationEvidence, job.participantId);
      }
    }
    if (certifiedPathKeys.size !== expectedPathCount) return incomplete(input, "missing-coverage", enumerationEvidence);
    const alternateByJourney = new Map<string, RouteFirstAlternateEvidence>();
    const alternateEvidence = input.alternateEvidence ?? [];
    if (alternateEvidence.length > MAX_ROUTE_FIRST_JOURNEYS) return incomplete(input, "missing-coverage", enumerationEvidence);
    for (const evidence of alternateEvidence) {
      requireCanonicalId(evidence.journeyId, "alternate primary journeyId");
      if (alternateByJourney.has(evidence.journeyId) || !normalizedJourneys.some((journey) => journey.id === evidence.journeyId) || evidence.alternates.length === 0 || evidence.alternates.length > MAX_ROUTE_FIRST_JOURNEYS) {
        return incomplete(input, "missing-coverage", enumerationEvidence);
      }
      requireSortedUnique(evidence.alternates.map((alternate) => alternate.journey.id), `Alternate journeys for ${evidence.journeyId}`);
      if (evidence.alternates.some((alternate) => alternate.journey.id === evidence.journeyId)) return incomplete(input, "missing-coverage", enumerationEvidence);
      alternateByJourney.set(evidence.journeyId, evidence);
    }
    const applicableAlternateJourneyIds = new Map<string, readonly string[]>();
    for (const family of input.familyContexts) {
      const byParticipant = new Map<string, string[]>();
      for (const pathKey of family.pathKeys) {
        const separator = pathKey.indexOf(":");
        const participantId = separator > 0 ? pathKey.slice(0, separator) : "";
        const journeys = byParticipant.get(participantId) ?? [];
        journeys.push(pathKey);
        byParticipant.set(participantId, journeys);
      }
      for (const [participantId, pathKeys] of byParticipant) {
        if (pathKeys.length < 2) continue;
        for (const pathKey of pathKeys) {
          const primaryJourney = journeyByPathKey.get(pathKey);
          if (!primaryJourney || primaryJourney.participantId !== participantId) return incomplete(input, "missing-coverage", enumerationEvidence, participantId);
          const requiredAlternates = pathKeys.filter((candidate) => candidate !== pathKey).map((candidate) => journeyByPathKey.get(candidate)?.id).filter((idValue): idValue is string => idValue !== undefined).sort();
          applicableAlternateJourneyIds.set(primaryJourney.id, requiredAlternates);
        }
      }
    }
    if (applicableAlternateJourneyIds.size > 0) {
      for (const [primaryJourneyId, requiredAlternates] of applicableAlternateJourneyIds) {
        const evidence = alternateByJourney.get(primaryJourneyId);
        if (!evidence || evidence.context.familyKey !== input.familyContexts.find((family) => family.pathKeys.includes(pathKeyByJourneyId.get(primaryJourneyId) ?? ""))?.contextKey) return incomplete(input, "missing-coverage", enumerationEvidence);
        const suppliedAlternates = evidence.alternates.map((alternate) => alternate.journey.id).sort();
        if (suppliedAlternates.length !== requiredAlternates.length || suppliedAlternates.some((idValue, index) => idValue !== requiredAlternates[index])) return incomplete(input, "missing-coverage", enumerationEvidence);
        const primaryJourney = normalizedJourneys.find((journey) => journey.id === primaryJourneyId)!;
        if (evidence.context.request.participantId !== primaryJourney.participantId || evidence.context.request.originVertexId !== primaryJourney.requestContext.originVertexId || evidence.context.request.destinationVertexId !== primaryJourney.requestContext.destinationVertexId || evidence.context.request.departureContext !== input.departureContext || !sameSnapshot(evidence.context.request.snapshot, input.snapshot) || canonicalEnumerationPolicyKey(evidence.context.policy) !== canonicalEnumerationPolicyKey(input.enumerationJobs.find((job) => job.participantId === primaryJourney.participantId)!.input.policy)) return incomplete(input, "missing-coverage", enumerationEvidence);
        const primaryJob = input.enumerationJobs.find((job) => job.participantId === primaryJourney.participantId)!;
        const primaryResult = enumerationResults.get(primaryJourney.participantId);
        const primaryGraphFingerprint = primaryResult?.status === "complete" ? primaryResult.certificate.graphFingerprint : "";
        for (const alternate of evidence.alternates) {
          const alternatePathKey = pathKeyByJourneyId.get(alternate.journey.id);
          const trustedAlternateJourney = alternatePathKey ? journeyByPathKey.get(alternatePathKey) : undefined;
          if (!alternatePathKey || !requiredAlternates.includes(alternate.journey.id) || alternate.journey.participantId !== primaryJourney.participantId || !trustedAlternateJourney || !sameTrustedJourney(alternate.journey, trustedAlternateJourney) || alternate.enumerationInput.policy.policyId !== primaryJob.input.policy.policyId || canonicalEnumerationPolicyKey(alternate.enumerationInput.policy) !== canonicalEnumerationPolicyKey(primaryJob.input.policy) || alternate.enumeration.certificate.graphFingerprint !== primaryGraphFingerprint) return incomplete(input, "missing-coverage", enumerationEvidence);
        }
      }
      if ([...alternateByJourney.keys()].some((journeyId) => !applicableAlternateJourneyIds.has(journeyId))) return incomplete(input, "missing-coverage", enumerationEvidence);
    } else if (alternateByJourney.size > 0) {
      return incomplete(input, "missing-coverage", enumerationEvidence);
    }
    let corridors: RouteFirstParticipantCorridor[];
    try {
      corridors = normalizedJourneys.map((journey) => {
        const evidence = alternateByJourney.get(journey.id);
        const corridor = evidence
          ? exactTemporalCorridor(journey, tolerance, { context: evidence.context, alternates: evidence.alternates })
          : exactTemporalCorridor(journey, tolerance);
        const alternateJourneyIds = evidence?.alternates.map((alternate) => alternate.journey.id) ?? [];
        return Object.freeze({
          participantId: journey.participantId,
          journeyId: journey.id,
          corridor,
          directionalGeometry: journeyGeometry(journey),
          envelopeGeometry: Object.freeze(evidence ? evidence.alternates.flatMap((alternate) => journeyGeometry(alternate.journey)) : []),
          alternateJourneyIds: Object.freeze(alternateJourneyIds),
        });
      });
    } catch (error) {
      if (alternateByJourney.size > 0) return incomplete(input, "missing-coverage", enumerationEvidence);
      return failed(input, "journey-invalid", error instanceof Error ? error.message : "Journey corridor calculation failed.", enumerationEvidence);
    }
    const topology = normalizeTargetTopology(input.eligibility.topology);
    const relevantEdges = topology.edges.filter((edge) => edge.meetingEligible);
    const fairRegions: FairRegion[] = [];
    try {
      for (const edge of relevantEdges) {
        const profiles = input.targetProfiles.filter((profile) => profile.edgeId === edge.id);
        fairRegions.push(allParticipantToleranceRegion(profiles, tolerance));
      }
    } catch (error) {
      return incomplete(input, "missing-coverage", enumerationEvidence);
    }
    const fairRegionGeometry: RouteFirstFairRegionGeometry[] = relevantEdges.map((edge) => ({ edgeId: edge.id, start: wireCoordinate(edge.start), end: wireCoordinate(edge.end) }));
    const eligibilityInput = {
      topology: input.eligibility.topology,
      participantIds,
      fairRegions,
      accessibleIntervals: input.eligibility.accessibleIntervals,
      accessibleVertices: input.eligibility.accessibleVertices,
      fairVertexEvidence: input.eligibility.fairVertexEvidence,
    };
    let components: readonly EligibleTargetComponent[];
    try {
      components = constructFairEligibleComponents(eligibilityInput);
    } catch (error) {
      return failed(input, "topology-invalid", error instanceof Error ? error.message : "Eligibility topology is invalid.", enumerationEvidence);
    }
    const minimumOrganicDiversity = input.organicComponentDiversityMinimum ?? 2;
    let landmarkEvaluation: RouteFirstLandmarkEvaluation = Object.freeze({ organicComponentCount: components.length, minimumOrganicComponentDiversity: minimumOrganicDiversity, evaluated: false, landmarkIds: Object.freeze([]) });
    if (components.length < minimumOrganicDiversity) {
      let landmarks: readonly RouteFirstConditionalLandmark[];
      try {
        landmarks = validateConditionalLandmarks(input, participantIds);
        components = constructFairEligibleComponents({ ...eligibilityInput, fairVertexEvidence: [...(eligibilityInput.fairVertexEvidence ?? []), ...landmarks.map((landmark) => landmark.evidence)] });
      } catch (error) {
        return failed(input, error instanceof RouteFirstServiceBoundaryError ? error.code : "topology-invalid", "Conditional landmark evidence is invalid.", enumerationEvidence);
      }
      landmarkEvaluation = Object.freeze({ organicComponentCount: landmarkEvaluation.organicComponentCount, minimumOrganicComponentDiversity: minimumOrganicDiversity, evaluated: true, landmarkIds: Object.freeze(landmarks.map((landmark) => landmark.id)) });
    }
    const familyPathUnion = new Set(input.familyContexts.flatMap((family) => family.pathKeys));
    if (familyPathUnion.size !== certifiedPathKeys.size || [...certifiedPathKeys].some((key) => !familyPathUnion.has(key))) {
      return incomplete(input, "missing-coverage", enumerationEvidence);
    }
    const families: RouteFirstMeetingFamily[] = input.familyContexts.map((family) => Object.freeze({
      snapshot: input.snapshot,
      contextKey: family.contextKey,
      skeletonKey: family.skeletonKey,
      geometryKey: family.geometryKey,
      participantIds: Object.freeze([...family.participantIds]),
      pathKeys: Object.freeze([...family.pathKeys]),
      targetEdgeIds: Object.freeze([...family.targetEdgeIds]),
      eligibleComponents: Object.freeze([...components]),
    }));
    const admittedLandmarks: RouteFirstAdmittedLandmark[] = [];
    const landmarkIds = new Set(landmarkEvaluation.landmarkIds);
    for (const landmark of input.conditionalLandmarks ?? []) {
      if (landmarkIds.has(landmark.id) && components.some((component) => component.vertexIds.includes(landmark.evidence.vertexId))) {
        admittedLandmarks.push(Object.freeze({ id: landmark.id, kind: landmark.kind, snapshot: landmark.evidence.snapshot, participantIds: Object.freeze([...landmark.evidence.participantIds]), vertexId: landmark.evidence.vertexId, scope: landmark.evidence.scope }));
      }
    }
    const fairRegion = fairRegions[0]!;
    const shared = { provenance: makeProvenance(input, "complete"), enumerations: Object.freeze([...enumerationEvidence]), journeys: Object.freeze([...normalizedJourneys]), corridors: Object.freeze(corridors), fairRegion, fairRegions: Object.freeze(fairRegions), fairRegionGeometry: Object.freeze(fairRegionGeometry), landmarkEvaluation, admittedLandmarks: Object.freeze(admittedLandmarks) };
    if (components.length === 0) return Object.freeze({ status: "no-eligible-target" as const, ...shared, components: Object.freeze([]) as readonly [], families: Object.freeze([]) as readonly [] });
    return Object.freeze({ status: "complete" as const, ...shared, components: Object.freeze([...components]), families: Object.freeze(families) });
  } catch (error) {
    if (error instanceof RouteFirstServiceBoundaryError) return error.coverage ? incomplete(input, "missing-coverage", emptyEvidence) : failed(input, error.code, error.message, emptyEvidence);
    return failed(input, "service-error", error instanceof Error ? error.message : "Route-first meeting service failed.", emptyEvidence);
  }
}

export function createRouteFirstMeetingService(provider: RouteFirstMeetingEnumerationProvider): RouteFirstMeetingService {
  return Object.freeze({ evaluate: (input: RouteFirstMeetingRequest) => runRouteFirstMeetingService(input, provider) });
}

import { Rational } from "./rational.ts";
import { canonicalRouteSnapshotKey } from "./enumeration.ts";

export type RouteFirstClientJobStatus = "queued" | "running" | "complete" | "incomplete" | "unavailable" | "no-eligible-target" | "failed" | "expired";
type RouteFirstClientMode = "transit" | "bike" | "car";

export interface RouteFirstClientSnapshot {
  readonly contractVersion: string;
  readonly manifestId: string;
  readonly graphDigest: string;
  readonly inputDigest: string;
}

export interface RouteFirstClientRoutingSnapshot {
  readonly source: "MVG" | "MVV" | "OSM";
  readonly snapshot: RouteFirstClientSnapshot;
}

export interface RouteFirstClientProvenance {
  readonly contractVersion: "route-first-meeting-service/v1";
  readonly requestId: string;
  readonly departureContext: string;
  readonly snapshot: RouteFirstClientSnapshot;
  readonly routingSnapshots: readonly RouteFirstClientRoutingSnapshot[];
  readonly calculationCompleteness: "complete" | "incomplete" | "unavailable" | "failed";
  readonly participantIds: readonly string[];
  readonly participantModes: readonly RouteFirstClientMode[];
  readonly tolerancePercent: string;
  readonly requestFingerprint: string;
  readonly policyFingerprints: readonly { readonly participantId: string; readonly policyFingerprint: string; readonly snapshotFingerprint: string }[];
}

export interface RouteFirstClientCertificate {
  readonly complete: boolean;
  readonly statesVisited: string;
  readonly edgeTransitions: string;
  readonly pathsEmitted: string;
  readonly maxSimplePathStateBound: string;
  readonly workBudget: string | null;
  readonly workUnits: string;
  readonly parallelEdgeFactor: string;
  readonly graphFingerprint: string;
  readonly policyFingerprint: string;
  readonly snapshotFingerprint: string;
  readonly originVertexIds: readonly string[];
  readonly targetVertexIds: readonly string[];
}

export interface RouteFirstClientEnumerationEvidence {
  readonly participantId: string;
  readonly status: "complete" | "incomplete" | "unavailable";
  readonly certificate: RouteFirstClientCertificate | null;
}

export interface RouteFirstClientCoordinate {
  readonly xMm: string;
  readonly yMm: string;
}

export const ROUTE_FIRST_CLIENT_COORDINATE_REFERENCE = Object.freeze({
  crs: "EPSG:25832",
  unit: "millimetre",
} as const);

export type RouteFirstClientCoordinateReference = typeof ROUTE_FIRST_CLIENT_COORDINATE_REFERENCE;

export interface RouteFirstClientJourneyOccurrence {
  readonly occurrenceIndex: number;
  readonly coordinate: RouteFirstClientCoordinate;
  readonly tau: string;
  readonly kind: "departure" | "arrival" | "vertex" | "wait" | "dwell";
}

export interface RouteFirstClientJourneySegment {
  readonly id: string;
  readonly fromOccurrenceIndex: number;
  readonly toOccurrenceIndex: number;
  readonly departureTau: string;
  readonly arrivalTau: string;
  readonly distanceMm: string;
  readonly mode: "walk" | "transit" | "bike" | "car" | "wait" | "dwell";
  readonly geometry: readonly RouteFirstClientCoordinate[];
  readonly timingModel: "piecewise-linear";
}

export interface RouteFirstClientJourney {
  readonly id: string;
  readonly participantId: string;
  readonly snapshot: RouteFirstClientSnapshot;
  readonly requestContext: {
    readonly participantId: string;
    readonly originVertexId: string;
    readonly destinationVertexId: string;
    readonly departureContext: string;
    readonly snapshot: RouteFirstClientSnapshot;
  };
  readonly path: { readonly vertexIds: readonly string[]; readonly edgeIds: readonly string[] };
  readonly timingModel: "piecewise-linear";
  readonly occurrences: readonly RouteFirstClientJourneyOccurrence[];
  readonly segments: readonly RouteFirstClientJourneySegment[];
}

export interface RouteFirstClientCorridorInterval {
  readonly label: "exact-temporal-corridor" | "ambiguity-envelope";
  readonly startTau: string;
  readonly endTau: string;
  readonly tolerancePercent: string;
}

export interface RouteFirstClientCorridor {
  readonly participantId: string;
  readonly journeyId: string;
  readonly midpoint: { readonly tau: string; readonly midpointTau: string; readonly pathDuration: string; readonly segmentId: string; readonly fraction: string; readonly coordinate: RouteFirstClientCoordinate };
  readonly exact: RouteFirstClientCorridorInterval;
  readonly ambiguityEnvelope: RouteFirstClientCorridorInterval | null;
  readonly constituentCorridors: readonly RouteFirstClientCorridorInterval[];
  readonly directionalGeometry: readonly RouteFirstClientCoordinate[];
  readonly envelopeGeometry: readonly RouteFirstClientCoordinate[];
  readonly alternateJourneyIds: readonly string[];
}

export interface RouteFirstClientFairRegion {
  readonly edgeId: string;
  readonly participantIds: readonly string[];
  readonly snapshot: RouteFirstClientSnapshot;
  readonly scope: { readonly kind: "pair" | "all-participants"; readonly participantIds: readonly string[] };
  readonly kind: "exact" | "tolerance";
  readonly tolerancePercent: string;
  readonly intervals: readonly { readonly start: string; readonly end: string }[];
  readonly points: readonly string[];
  readonly geometry: { readonly start: RouteFirstClientCoordinate; readonly end: RouteFirstClientCoordinate };
}

export interface RouteFirstClientComponent {
  readonly id: string;
  readonly snapshot: RouteFirstClientSnapshot;
  readonly participantIds: readonly string[];
  readonly kind: "connected-component";
  readonly edgeIntervals: readonly { readonly edgeId: string; readonly interval: { readonly start: string; readonly end: string } }[];
  readonly vertexIds: readonly string[];
  readonly endpointCoordinates: readonly RouteFirstClientCoordinate[];
}

export interface RouteFirstClientFamily {
  readonly snapshot: RouteFirstClientSnapshot;
  readonly contextKey: string;
  readonly skeletonKey: string;
  readonly geometryKey: string;
  readonly participantIds: readonly string[];
  readonly pathKeys: readonly string[];
  readonly targetEdgeIds: readonly string[];
  readonly eligibleComponents: readonly RouteFirstClientComponent[];
}

export interface RouteFirstClientLandmarkEvaluation {
  readonly organicComponentCount: number;
  readonly minimumOrganicComponentDiversity: number;
  readonly evaluated: boolean;
  readonly landmarkIds: readonly string[];
}

export interface RouteFirstClientAdmittedLandmark {
  readonly id: string;
  readonly kind: "conditional-landmark";
  readonly snapshot: RouteFirstClientSnapshot;
  readonly participantIds: readonly string[];
  readonly vertexId: string;
  readonly scope: "all-participants";
}

interface RouteFirstClientResultBase {
  readonly provenance: RouteFirstClientProvenance;
  readonly enumerations: readonly RouteFirstClientEnumerationEvidence[];
}

export interface RouteFirstClientCompleteResult extends RouteFirstClientResultBase {
  readonly status: "complete";
  readonly coordinateReference: RouteFirstClientCoordinateReference;
  readonly journeys: readonly RouteFirstClientJourney[];
  readonly corridors: readonly RouteFirstClientCorridor[];
  readonly fairRegion: RouteFirstClientFairRegion;
  readonly fairRegions: readonly RouteFirstClientFairRegion[];
  readonly components: readonly RouteFirstClientComponent[];
  readonly families: readonly RouteFirstClientFamily[];
  readonly landmarkEvaluation: RouteFirstClientLandmarkEvaluation;
  readonly admittedLandmarks: readonly RouteFirstClientAdmittedLandmark[];
}

export interface RouteFirstClientNoEligibleTargetResult extends RouteFirstClientResultBase {
  readonly status: "no-eligible-target";
  readonly coordinateReference: RouteFirstClientCoordinateReference;
  readonly journeys: readonly RouteFirstClientJourney[];
  readonly corridors: readonly RouteFirstClientCorridor[];
  readonly fairRegion: RouteFirstClientFairRegion;
  readonly fairRegions: readonly RouteFirstClientFairRegion[];
  readonly components: readonly [];
  readonly families: readonly [];
  readonly landmarkEvaluation: RouteFirstClientLandmarkEvaluation;
  readonly admittedLandmarks: readonly RouteFirstClientAdmittedLandmark[];
}

export interface RouteFirstClientIncompleteResult extends RouteFirstClientResultBase {
  readonly status: "incomplete";
  readonly participantId: string;
  readonly reason: "work-budget-exhausted" | "missing-coverage";
}

export interface RouteFirstClientUnavailableResult extends RouteFirstClientResultBase {
  readonly status: "unavailable";
  readonly participantId: string;
  readonly reason: "Route-first calculation is unavailable.";
}

export interface RouteFirstClientFailedResult extends RouteFirstClientResultBase {
  readonly status: "failed";
  readonly code: "invalid-request" | "noncanonical-request" | "provider-error" | "non-enumerating-result" | "certificate-invalid" | "snapshot-mismatch" | "policy-mismatch" | "request-mismatch" | "journey-invalid" | "profile-invalid" | "topology-invalid" | "service-error";
  readonly message: string;
}

export type RouteFirstClientResult =
  | RouteFirstClientCompleteResult
  | RouteFirstClientNoEligibleTargetResult
  | RouteFirstClientIncompleteResult
  | RouteFirstClientUnavailableResult
  | RouteFirstClientFailedResult;

export interface RouteFirstClientJobEnvelope {
  readonly contractVersion: "route-first-job/v1";
  readonly jobId: string;
  readonly status: RouteFirstClientJobStatus;
  readonly durable: false;
  readonly runtimePersistence: "in-memory-process";
  readonly activation: "blocked-until-durable-provider";
  readonly expiresAt: number;
  readonly snapshot: RouteFirstClientSnapshot;
  readonly result?: RouteFirstClientResult;
}

const MAX_CLIENT_ARRAY = 256;
const ID_PATTERN = /^\S{1,128}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) throw new Error(`${label} contains an unknown field.`);
}

function stringValue(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value) throw new Error(`${label} is invalid.`);
  return value;
}

function id(value: unknown, label: string): string {
  const result = stringValue(value, label, 128);
  if (!ID_PATTERN.test(result)) throw new Error(`${label} is not canonical.`);
  return result;
}

function decimal(value: unknown, label: string, nonNegative = true): string {
  const result = stringValue(value, label, 128);
  if (!/^-?\d+$/.test(result)) throw new Error(`${label} is not a decimal integer.`);
  const parsed = BigInt(result);
  if (nonNegative && parsed < BigInt(0)) throw new Error(`${label} is negative.`);
  return result;
}

function rational(value: unknown, label: string): string {
  const result = stringValue(value, label, 256);
  try {
    const normalized = Rational.from(result).toString();
    if (normalized !== result) throw new Error("not normalized");
  } catch {
    throw new Error(`${label} is not a normalized rational.`);
  }
  return result;
}

function snapshot(value: unknown, label: string): void {
  const source = record(value);
  if (!source) throw new Error(`${label} is invalid.`);
  exactKeys(source, ["contractVersion", "manifestId", "graphDigest", "inputDigest"], label);
  for (const key of ["contractVersion", "manifestId", "graphDigest", "inputDigest"]) stringValue(source[key], `${label}.${key}`);
}

function sameSnapshot(left: unknown, right: unknown): boolean {
  const a = record(left);
  const b = record(right);
  return !!a && !!b && a.contractVersion === b.contractVersion && a.manifestId === b.manifestId && a.graphDigest === b.graphDigest && a.inputDigest === b.inputDigest;
}

function coordinate(value: unknown, label: string): void {
  const source = record(value);
  if (!source) throw new Error(`${label} is invalid.`);
  exactKeys(source, ["xMm", "yMm"], label);
  rational(source.xMm, `${label}.xMm`);
  rational(source.yMm, `${label}.yMm`);
}

function coordinateReference(value: unknown, label: string): void {
  const source = record(value);
  if (!source) throw new Error(`${label} is invalid.`);
  exactKeys(source, ["crs", "unit"], label);
  if (source.crs !== "EPSG:25832" || source.unit !== "millimetre") throw new Error(`${label} is not the route-first projected millimetre reference.`);
}

function boundedArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_CLIENT_ARRAY) throw new Error(`${label} is outside its bound.`);
  return value;
}

function sortedIds(values: readonly unknown[], label: string): string[] {
  const result = values.map((value, index) => id(value, `${label}[${index}]`));
  if (new Set(result).size !== result.length || result.some((value, index) => index > 0 && result[index - 1]! >= value)) throw new Error(`${label} is not sorted and unique.`);
  return result;
}

function sortedStrings(values: readonly unknown[], label: string): string[] {
  const result = values.map((value, index) => stringValue(value, `${label}[${index}]`, 4096));
  if (new Set(result).size !== result.length || result.some((value, index) => index > 0 && result[index - 1]! >= value)) throw new Error(`${label} is not sorted and unique.`);
  return result;
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableValue(object[key])}`).join(",")}}`;
}

function assertRationalEqual(actual: unknown, expected: Rational, label: string): void {
  if (Rational.from(rational(actual, label)).compare(expected) !== 0) throw new Error(`${label} does not match its certified recomputation.`);
}

function assertCoordinateEqual(actual: unknown, expectedX: Rational, expectedY: Rational, label: string): void {
  const point = record(actual);
  if (!point || Rational.from(rational(point.xMm, `${label}.xMm`)).compare(expectedX) !== 0 || Rational.from(rational(point.yMm, `${label}.yMm`)).compare(expectedY) !== 0) throw new Error(`${label} does not match its certified recomputation.`);
}

function recomputeClientCorridor(journey: RouteFirstClientJourney, tolerancePercent: string): {
  readonly midpoint: { readonly tau: Rational; readonly midpointTau: Rational; readonly pathDuration: Rational; readonly segmentId: string; readonly fraction: Rational; readonly x: Rational; readonly y: Rational };
  readonly exact: { readonly start: Rational; readonly end: Rational };
} {
  const start = Rational.from(journey.occurrences[0]!.tau);
  const end = Rational.from(journey.occurrences[journey.occurrences.length - 1]!.tau);
  const duration = end.subtract(start);
  const midpointTau = start.add(duration.divide(2));
  const segmentIndex = journey.segments.findIndex((segment) => midpointTau.compare(segment.arrivalTau) <= 0);
  const index = segmentIndex < 0 ? journey.segments.length - 1 : segmentIndex;
  const segment = journey.segments[index]!;
  const departure = Rational.from(segment.departureTau);
  const arrival = Rational.from(segment.arrivalTau);
  const fraction = midpointTau.subtract(departure).divide(arrival.subtract(departure));
  const from = journey.occurrences[index]!.coordinate;
  const to = journey.occurrences[index + 1]!.coordinate;
  const x = Rational.from(from.xMm).add(Rational.from(to.xMm).subtract(Rational.from(from.xMm)).multiply(fraction));
  const y = Rational.from(from.yMm).add(Rational.from(to.yMm).subtract(Rational.from(from.yMm)).multiply(fraction));
  const margin = duration.multiply(Rational.from(tolerancePercent)).divide(200);
  const exactStart = midpointTau.subtract(margin).compare(start) < 0 ? start : midpointTau.subtract(margin);
  const exactEnd = midpointTau.add(margin).compare(end) > 0 ? end : midpointTau.add(margin);
  return { midpoint: { tau: midpointTau, midpointTau, pathDuration: duration, segmentId: segment.id, fraction, x, y }, exact: { start: exactStart, end: exactEnd } };
}

function canonicalField(value: string): string { return `${value.length}:${value}`; }
function canonicalArray(values: readonly string[]): string { return `[${values.map(canonicalField).join("")}]`; }
function canonicalTuple(values: readonly string[]): string { return `(${values.map(canonicalField).join("")})`; }
export function canonicalRouteFirstClientJourneyPathKey(journey: RouteFirstClientJourney): string {
  const duration = journey.segments.reduce((total, segment) => total.add(Rational.from(segment.arrivalTau).subtract(Rational.from(segment.departureTau))), Rational.zero());
  const distance = journey.segments.reduce((total, segment) => total.add(Rational.from(segment.distanceMm)), Rational.zero());
  return `${journey.participantId}:${canonicalTuple([canonicalArray([...journey.path.vertexIds]), canonicalArray([...journey.path.edgeIds]), duration.toString(), distance.toString()])}`;
}

function clientJourneyGeometry(journey: RouteFirstClientJourney): readonly RouteFirstClientCoordinate[] {
  const points: RouteFirstClientCoordinate[] = [];
  for (const segment of journey.segments) for (const point of segment.geometry) {
    const previous = points[points.length - 1];
    if (!previous || previous.xMm !== point.xMm || previous.yMm !== point.yMm) points.push(point);
  }
  return points;
}

function validateProvenance(value: unknown): RouteFirstClientProvenance {
  const source = record(value);
  if (!source || source.contractVersion !== "route-first-meeting-service/v1") throw new Error("Result provenance is invalid.");
  exactKeys(source, ["contractVersion", "requestId", "departureContext", "snapshot", "routingSnapshots", "calculationCompleteness", "participantIds", "participantModes", "tolerancePercent", "requestFingerprint", "policyFingerprints"], "provenance");
  const participantIds = sortedIds(boundedArray(source.participantIds, "provenance.participantIds"), "provenance.participantIds");
  const modes = boundedArray(source.participantModes, "provenance.participantModes");
  if (modes.length !== participantIds.length || modes.some((mode) => mode !== "transit" && mode !== "bike" && mode !== "car")) throw new Error("Provenance modes are invalid.");
  stringValue(source.requestId, "provenance.requestId");
  stringValue(source.departureContext, "provenance.departureContext");
  stringValue(source.requestFingerprint, "provenance.requestFingerprint", 4096);
  rational(source.tolerancePercent, "provenance.tolerancePercent");
  const policies = boundedArray(source.policyFingerprints, "provenance.policyFingerprints");
  if (policies.length > participantIds.length) throw new Error("Policy provenance exceeds participant coverage.");
  for (const policy of policies) {
    const item = record(policy);
    if (!item) throw new Error("Policy provenance is invalid.");
    exactKeys(item, ["participantId", "policyFingerprint", "snapshotFingerprint"], "policy provenance");
    id(item.participantId, "policy provenance participantId");
    stringValue(item.policyFingerprint, "policy provenance fingerprint");
    if (item.snapshotFingerprint !== canonicalRouteSnapshotKey(source.snapshot as RouteFirstClientSnapshot)) throw new Error("Policy snapshot provenance is not bound.");
  }
  const policyIds = policies.map((policy) => (record(policy)?.participantId));
  if (policyIds.some((value, index) => value !== participantIds[index])) throw new Error("Policy provenance participants are not canonical.");
  snapshot(source.snapshot, "provenance.snapshot");
  const routing = boundedArray(source.routingSnapshots, "provenance.routingSnapshots");
  if (routing.length === 0 || routing.length > 3) throw new Error("Routing provenance is invalid.");
  let previousSourceRank = -1;
  for (const entry of routing) {
    const item = record(entry);
    if (!item || !["MVG", "MVV", "OSM"].includes(item.source as string)) throw new Error("Routing provenance source is invalid.");
    exactKeys(item, ["source", "snapshot"], "routing provenance");
    const sourceRank = ["MVG", "MVV", "OSM"].indexOf(item.source as string);
    if (sourceRank <= previousSourceRank) throw new Error("Routing provenance order is not canonical.");
    previousSourceRank = sourceRank;
    snapshot(item.snapshot, "routing provenance snapshot");
    if (!sameSnapshot(item.snapshot, source.snapshot)) throw new Error("Routing provenance snapshot is not bound.");
  }
  if (!["complete", "incomplete", "unavailable", "failed"].includes(source.calculationCompleteness as string)) throw new Error("Provenance completeness is invalid.");
  return source as unknown as RouteFirstClientProvenance;
}

function validateCertificate(value: unknown, expectedSnapshot: unknown): void {
  const source = record(value);
  if (!source || typeof source.complete !== "boolean") throw new Error("Enumeration certificate is invalid.");
  exactKeys(source, ["complete", "statesVisited", "edgeTransitions", "pathsEmitted", "maxSimplePathStateBound", "workBudget", "workUnits", "parallelEdgeFactor", "graphFingerprint", "policyFingerprint", "snapshotFingerprint", "originVertexIds", "targetVertexIds"], "certificate");
  const counters = new Map<string, bigint>();
  for (const key of ["statesVisited", "edgeTransitions", "pathsEmitted", "maxSimplePathStateBound", "workUnits", "parallelEdgeFactor"]) counters.set(key, BigInt(decimal(source[key], `certificate.${key}`)));
  if (source.workBudget !== null && source.workBudget !== undefined) decimal(source.workBudget, "certificate.workBudget");
  for (const key of ["graphFingerprint", "policyFingerprint", "snapshotFingerprint"]) stringValue(source[key], `certificate.${key}`);
  if (!Array.isArray(source.originVertexIds) || !Array.isArray(source.targetVertexIds)) throw new Error("Certificate path bounds are invalid.");
  sortedIds(source.originVertexIds, "certificate.originVertexIds");
  sortedIds(source.targetVertexIds, "certificate.targetVertexIds");
  if (counters.get("parallelEdgeFactor")! < BigInt(1) || counters.get("workUnits")! !== counters.get("statesVisited")! + counters.get("edgeTransitions")! || counters.get("pathsEmitted")! > counters.get("statesVisited")! || counters.get("statesVisited")! > counters.get("maxSimplePathStateBound")!) throw new Error("Enumeration certificate counters are inconsistent.");
  if (!source.complete && (source.workBudget === null || source.workBudget === undefined || counters.get("workUnits")! !== BigInt(decimal(source.workBudget, "certificate.workBudget")))) throw new Error("Incomplete certificate budget counters are inconsistent.");
  if (source.workBudget !== null && source.workBudget !== undefined && counters.get("workUnits")! > BigInt(decimal(source.workBudget, "certificate.workBudget"))) throw new Error("Certificate work exceeds its budget.");
  if (source.snapshotFingerprint !== undefined && typeof source.snapshotFingerprint !== "string") throw new Error("Certificate snapshot is invalid.");
  if (source.snapshotFingerprint !== canonicalRouteSnapshotKey(expectedSnapshot as RouteFirstClientSnapshot)) throw new Error("Certificate snapshot provenance is not bound.");
}

function validateJourney(value: unknown, expectedSnapshot: unknown, participantIds: readonly string[], expectedDepartureContext: string): RouteFirstClientJourney {
  const source = record(value);
  if (!source) throw new Error("Journey is invalid.");
  exactKeys(source, ["id", "participantId", "snapshot", "requestContext", "path", "timingModel", "occurrences", "segments"], "journey");
  id(source.id, "journey.id");
  const participantId = id(source.participantId, "journey.participantId");
  if (!participantIds.includes(participantId)) throw new Error("Journey participant is not bound.");
  snapshot(source.snapshot, "journey.snapshot");
  if (!sameSnapshot(source.snapshot, expectedSnapshot)) throw new Error("Journey snapshot is not bound.");
  const context = record(source.requestContext);
  if (!context || context.participantId !== participantId) throw new Error("Journey request context is invalid.");
  exactKeys(context, ["participantId", "originVertexId", "destinationVertexId", "departureContext", "snapshot"], "journey requestContext");
  id(context.originVertexId, "journey originVertexId");
  id(context.destinationVertexId, "journey destinationVertexId");
  stringValue(context.departureContext, "journey departureContext");
  if (context.departureContext !== expectedDepartureContext) throw new Error("Journey departure context is not bound to provenance.");
  snapshot(context.snapshot, "journey context snapshot");
  if (!sameSnapshot(context.snapshot, expectedSnapshot)) throw new Error("Journey context snapshot is not bound.");
  const path = record(source.path);
  if (!path) throw new Error("Journey path is invalid.");
  exactKeys(path, ["vertexIds", "edgeIds"], "journey path");
  const vertices = boundedArray(path.vertexIds, "journey.path.vertexIds").map((value, index) => id(value, `journey.path.vertexIds[${index}]`));
  const edges = boundedArray(path.edgeIds, "journey.path.edgeIds").map((value, index) => id(value, `journey.path.edgeIds[${index}]`));
  if (vertices.length < 2 || edges.length !== vertices.length - 1) throw new Error("Journey path coverage is invalid.");
  if (new Set(vertices).size !== vertices.length) throw new Error("Journey path must be loopless.");
  if (source.timingModel !== "piecewise-linear") throw new Error("Journey timing model is invalid.");
  const occurrences = boundedArray(source.occurrences, "journey.occurrences");
  const segments = boundedArray(source.segments, "journey.segments");
  if (occurrences.length < 2 || segments.length !== occurrences.length - 1) throw new Error("Journey timing coverage is invalid.");
  occurrences.forEach((entry, index) => {
    const item = record(entry);
    if (!item || item.occurrenceIndex !== index) throw new Error("Journey occurrence index is invalid.");
    exactKeys(item, ["occurrenceIndex", "coordinate", "tau", "kind"], `journey occurrence ${index}`);
    if (!["departure", "arrival", "vertex", "wait", "dwell"].includes(item.kind as string)) throw new Error("Journey occurrence kind is invalid.");
    coordinate(item.coordinate, `journey.occurrences[${index}].coordinate`);
    rational(item.tau, `journey.occurrences[${index}].tau`);
    if (index > 0 && Rational.from(item.tau as string).compare(Rational.from((occurrences[index - 1] as Record<string, unknown>).tau as string)) <= 0) throw new Error("Journey occurrence times are not monotonic.");
  });
  segments.forEach((entry, index) => {
    const item = record(entry);
    if (!item || item.fromOccurrenceIndex !== index || item.toOccurrenceIndex !== index + 1 || item.timingModel !== "piecewise-linear") throw new Error("Journey segment coverage is invalid.");
    exactKeys(item, ["id", "fromOccurrenceIndex", "toOccurrenceIndex", "departureTau", "arrivalTau", "distanceMm", "mode", "geometry", "timingModel"], `journey segment ${index}`);
    if (!["walk", "transit", "bike", "car", "wait", "dwell"].includes(item.mode as string)) throw new Error("Journey segment mode is invalid.");
    id(item.id, `journey.segments[${index}].id`);
    for (const key of ["departureTau", "arrivalTau", "distanceMm"]) rational(item[key], `journey.segments[${index}].${key}`);
    const geometry = boundedArray(item.geometry, `journey.segments[${index}].geometry`);
    if (geometry.length !== 2) throw new Error("Journey segment geometry must contain exactly its two occurrence endpoints.");
    geometry.forEach((point, pointIndex) => coordinate(point, `journey.segments[${index}].geometry[${pointIndex}]`));
    const from = record(occurrences[index])?.coordinate;
    const to = record(occurrences[index + 1])?.coordinate;
    const first = record(geometry[0]);
    const last = record(geometry[geometry.length - 1]);
    if (!first || !last || !from || !to || first.xMm !== (from as Record<string, unknown>).xMm || first.yMm !== (from as Record<string, unknown>).yMm || last.xMm !== (to as Record<string, unknown>).xMm || last.yMm !== (to as Record<string, unknown>).yMm) throw new Error("Journey segment geometry is not occurrence-bound.");
    const departureTau = Rational.from(item.departureTau as string);
    const arrivalTau = Rational.from(item.arrivalTau as string);
    const distance = Rational.from(item.distanceMm as string);
    if (departureTau.compare(Rational.from((record(occurrences[index]) as Record<string, unknown>).tau as string)) !== 0 || arrivalTau.compare(Rational.from((record(occurrences[index + 1]) as Record<string, unknown>).tau as string)) !== 0 || arrivalTau.compare(departureTau) <= 0 || distance.isNegative()) throw new Error("Journey segment timing or distance is not occurrence-bound.");
    const fromPoint = record(geometry[0]);
    const toPoint = record(geometry[geometry.length - 1]);
    const stationary = fromPoint?.xMm === toPoint?.xMm && fromPoint?.yMm === toPoint?.yMm;
    const allStationary = stationary && geometry.every((point) => { const candidate = record(point); return candidate?.xMm === fromPoint?.xMm && candidate?.yMm === fromPoint?.yMm; });
    if ((item.mode === "wait" || item.mode === "dwell") && (!allStationary || !distance.isZero())) throw new Error("Wait/dwell segments must be stationary and zero-distance.");
    if (item.mode !== "wait" && item.mode !== "dwell" && distance.isZero() && !stationary) throw new Error("Moving zero-distance segments are invalid.");
  });
  return source as unknown as RouteFirstClientJourney;
}

function validateResult(value: unknown, expectedStatus: RouteFirstClientJobStatus): void {
  const result = record(value);
  if (!result || result.status !== expectedStatus) throw new Error("Job result status is invalid.");
  const fields: Record<string, readonly string[]> = {
    incomplete: ["status", "provenance", "enumerations", "participantId", "reason"],
    unavailable: ["status", "provenance", "enumerations", "participantId", "reason"],
    failed: ["status", "provenance", "enumerations", "code", "message"],
    complete: ["status", "provenance", "enumerations", "coordinateReference", "journeys", "corridors", "fairRegion", "fairRegions", "components", "families", "landmarkEvaluation", "admittedLandmarks"],
    "no-eligible-target": ["status", "provenance", "enumerations", "coordinateReference", "journeys", "corridors", "fairRegion", "fairRegions", "components", "families", "landmarkEvaluation", "admittedLandmarks"],
  };
  exactKeys(result, fields[expectedStatus] ?? [], "job result");
  const provenance = validateProvenance(result.provenance);
  const enumerations = boundedArray(result.enumerations, "result.enumerations");
  if ((expectedStatus === "complete" || expectedStatus === "no-eligible-target") && enumerations.length !== provenance.participantIds.length) throw new Error("Enumeration coverage is incomplete.");
  if (enumerations.length > provenance.participantIds.length) throw new Error("Enumeration evidence exceeds participant coverage.");
  const enumerationIds = sortedIds(enumerations.map((entry) => record(entry)?.participantId), "result.enumerations participantIds");
  if (enumerationIds.some((value, index) => value !== provenance.participantIds[index])) throw new Error("Enumeration participants are not bound.");
  const policyProvenance = new Map<string, string>(boundedArray(provenance.policyFingerprints, "provenance.policyFingerprints").map((entry) => { const item = record(entry)!; return [item.participantId as string, item.policyFingerprint as string]; }));
  if ((expectedStatus === "complete" || expectedStatus === "no-eligible-target") && policyProvenance.size !== provenance.participantIds.length) throw new Error("Complete result policy provenance is incomplete.");
  for (const entry of enumerations) {
    const item = record(entry);
    if (!item || !["complete", "incomplete", "unavailable"].includes(item.status as string)) throw new Error("Enumeration evidence is invalid.");
    exactKeys(item, ["participantId", "status", "certificate"], "enumeration evidence");
    if (item.certificate === null) {
      if (item.status !== "unavailable") throw new Error("Complete enumeration evidence requires a certificate.");
    } else {
      validateCertificate(item.certificate, provenance.snapshot);
      const certificate = record(item.certificate);
      if (!certificate || certificate.complete !== (item.status === "complete")) throw new Error("Enumeration certificate completeness is not bound.");
      if (policyProvenance.get(item.participantId as string) !== certificate.policyFingerprint) throw new Error("Enumeration policy certificate is not bound.");
    }
  }
  if (expectedStatus === "incomplete") {
    if (!id(result.participantId, "incomplete participantId") || !["work-budget-exhausted", "missing-coverage"].includes(result.reason as string)) throw new Error("Incomplete result is invalid.");
    if (provenance.calculationCompleteness !== "incomplete") throw new Error("Incomplete provenance is invalid.");
    return;
  }
  if (expectedStatus === "unavailable") {
    if (!id(result.participantId, "unavailable participantId") || result.reason !== "Route-first calculation is unavailable.") throw new Error("Unavailable result is invalid.");
    if (provenance.calculationCompleteness !== "unavailable") throw new Error("Unavailable provenance is invalid.");
    return;
  }
  if (expectedStatus === "failed") {
    if (!["invalid-request", "noncanonical-request", "provider-error", "non-enumerating-result", "certificate-invalid", "snapshot-mismatch", "policy-mismatch", "request-mismatch", "journey-invalid", "profile-invalid", "topology-invalid", "service-error"].includes(result.code as string)) throw new Error("Failure code is invalid.");
    stringValue(result.message, "failure message", 128);
    if (provenance.calculationCompleteness !== "failed") throw new Error("Failure provenance is invalid.");
    return;
  }
  if (provenance.calculationCompleteness !== "complete") throw new Error("Complete result provenance is invalid.");
  coordinateReference(result.coordinateReference, "result.coordinateReference");
  const journeys = boundedArray(result.journeys, "result.journeys").map((journey) => validateJourney(journey, provenance.snapshot, provenance.participantIds, provenance.departureContext));
  if (journeys.length < provenance.participantIds.length) throw new Error("Journey coverage is incomplete.");
  for (const entry of enumerations) {
    const evidence = record(entry);
    const certificate = evidence?.certificate ? record(evidence.certificate) : null;
    if (certificate && evidence?.status === "complete" && BigInt(certificate.pathsEmitted as string) !== BigInt(journeys.filter((journey) => journey.participantId === evidence.participantId).length)) throw new Error("Enumeration certificate path count is not bound to journeys.");
  }
  const journeyIds = journeys.map((journey) => journey.id);
  if (new Set(journeyIds).size !== journeyIds.length) throw new Error("Journey ids are duplicated.");
  const corridors = boundedArray(result.corridors, "result.corridors");
  if (corridors.length !== journeys.length) throw new Error("Corridor coverage is incomplete.");
  for (const corridor of corridors) {
    const item = record(corridor);
    if (!item || !provenance.participantIds.includes(item.participantId as string) || !journeyIds.includes(item.journeyId as string)) throw new Error("Corridor binding is invalid.");
    exactKeys(item, ["participantId", "journeyId", "midpoint", "exact", "ambiguityEnvelope", "constituentCorridors", "directionalGeometry", "envelopeGeometry", "alternateJourneyIds"], "corridor");
    id(item.participantId, "corridor participantId");
    id(item.journeyId, "corridor journeyId");
    const journey = journeys.find((candidate) => candidate.id === item.journeyId);
    if (!journey || journey.participantId !== item.participantId) throw new Error("Corridor participant binding is invalid.");
    const midpoint = record(item.midpoint);
    if (!midpoint || typeof midpoint.segmentId !== "string") throw new Error("Corridor midpoint is invalid.");
    exactKeys(midpoint, ["tau", "midpointTau", "pathDuration", "segmentId", "fraction", "coordinate"], "corridor midpoint");
    rational(midpoint.tau, "corridor midpoint tau");
    rational(midpoint.midpointTau, "corridor midpoint midpointTau");
    rational(midpoint.pathDuration, "corridor midpoint pathDuration");
    rational(midpoint.fraction, "corridor midpoint fraction");
    coordinate(midpoint.coordinate, "corridor midpoint");
    const recomputed = recomputeClientCorridor(journey, provenance.tolerancePercent);
    assertRationalEqual(midpoint.tau, recomputed.midpoint.tau, "corridor midpoint tau");
    assertRationalEqual(midpoint.midpointTau, recomputed.midpoint.midpointTau, "corridor midpoint midpointTau");
    assertRationalEqual(midpoint.pathDuration, recomputed.midpoint.pathDuration, "corridor midpoint pathDuration");
    if (midpoint.segmentId !== recomputed.midpoint.segmentId) throw new Error("Corridor midpoint segment is not bound.");
    assertRationalEqual(midpoint.fraction, recomputed.midpoint.fraction, "corridor midpoint fraction");
    assertCoordinateEqual(midpoint.coordinate, recomputed.midpoint.x, recomputed.midpoint.y, "corridor midpoint coordinate");
    const exact = record(item.exact);
    if (!exact) throw new Error("Corridor exact interval is missing.");
    assertRationalEqual(exact.startTau, recomputed.exact.start, "corridor exact startTau");
    assertRationalEqual(exact.endTau, recomputed.exact.end, "corridor exact endTau");
    const alternateJourneyIds = sortedIds(boundedArray(item.alternateJourneyIds, "corridor alternateJourneyIds"), "corridor alternateJourneyIds");
    const constituent = boundedArray(item.constituentCorridors, "corridor constituentCorridors");
    if (constituent.length !== alternateJourneyIds.length + 1) throw new Error("Corridor constituent coverage is incomplete.");
    for (const [alternateIndex, alternateJourneyId] of alternateJourneyIds.entries()) {
      const alternateJourney = journeys.find((candidate) => candidate.id === alternateJourneyId);
      if (!alternateJourney) throw new Error("Corridor alternate journey is not present.");
      if (alternateJourney.participantId !== item.participantId) throw new Error("Corridor alternate participant is not bound.");
      const alternateExact = recomputeClientCorridor(alternateJourney, provenance.tolerancePercent).exact;
      const constituentInterval = record(constituent[alternateIndex + 1]);
      if (!constituentInterval) throw new Error("Corridor constituent interval is invalid.");
      assertRationalEqual(constituentInterval.startTau, alternateExact.start, "alternate corridor startTau");
      assertRationalEqual(constituentInterval.endTau, alternateExact.end, "alternate corridor endTau");
    }
    if (item.ambiguityEnvelope !== null) {
      const envelope = record(item.ambiguityEnvelope);
      if (!envelope) throw new Error("Corridor ambiguity envelope is invalid.");
      const allIntervals = [recomputed.exact, ...alternateJourneyIds.map((idValue) => recomputeClientCorridor(journeys.find((candidate) => candidate.id === idValue)!, provenance.tolerancePercent).exact)];
      const envelopeStart = allIntervals.reduce((left, right) => left.start.compare(right.start) < 0 ? left : right).start;
      const envelopeEnd = allIntervals.reduce((left, right) => left.end.compare(right.end) > 0 ? left : right).end;
      assertRationalEqual(envelope.startTau, envelopeStart, "corridor ambiguity startTau");
      assertRationalEqual(envelope.endTau, envelopeEnd, "corridor ambiguity endTau");
    }
    for (const interval of [item.exact, item.ambiguityEnvelope, ...((item.constituentCorridors as unknown[]) ?? [])]) {
      if (interval === null || interval === undefined) continue;
      const part = record(interval);
      if (!part || !["exact-temporal-corridor", "ambiguity-envelope"].includes(part.label as string)) throw new Error("Corridor interval is invalid.");
      exactKeys(part, ["label", "startTau", "endTau", "tolerancePercent"], "corridor interval");
      if (part.tolerancePercent !== provenance.tolerancePercent) throw new Error("Corridor tolerance is not bound.");
      rational(part.startTau, "corridor startTau");
      rational(part.endTau, "corridor endTau");
      rational(part.tolerancePercent, "corridor tolerance");
    }
    const directionalGeometry = boundedArray(item.directionalGeometry, "corridor directionalGeometry");
    directionalGeometry.forEach((point, index) => coordinate(point, `corridor directionalGeometry[${index}]`));
    if (stableValue(directionalGeometry) !== stableValue(clientJourneyGeometry(journey))) throw new Error("Corridor directional geometry is not journey-bound.");
    const envelopeGeometry = boundedArray(item.envelopeGeometry, "corridor envelopeGeometry");
    envelopeGeometry.forEach((point, index) => coordinate(point, `corridor envelopeGeometry[${index}]`));
    if (item.ambiguityEnvelope === null && (alternateJourneyIds.length !== 0 || (item.envelopeGeometry as unknown[]).length !== 0)) throw new Error("Corridor envelope geometry lacks certified alternates.");
    if (item.ambiguityEnvelope !== null && (alternateJourneyIds.length === 0 || (item.envelopeGeometry as unknown[]).length < 2)) throw new Error("Corridor ambiguity envelope is incomplete.");
    const expectedEnvelopeGeometry = alternateJourneyIds.flatMap((alternateJourneyId) => clientJourneyGeometry(journeys.find((candidate) => candidate.id === alternateJourneyId)!));
    if (stableValue(envelopeGeometry) !== stableValue(expectedEnvelopeGeometry)) throw new Error("Corridor envelope geometry is not alternate-bound.");
  }
  const regions = boundedArray(result.fairRegions, "result.fairRegions");
  if (regions.length === 0 || !result.fairRegion) throw new Error("Fair-region coverage is incomplete.");
  const regionEdgeIds: string[] = [];
  for (const region of regions) {
    const item = record(region);
    if (!item || !provenance.participantIds.every((participantId) => (item.participantIds as unknown[]).includes(participantId))) throw new Error("Fair-region participant binding is invalid.");
    exactKeys(item, ["edgeId", "participantIds", "snapshot", "scope", "kind", "tolerancePercent", "intervals", "points", "geometry"], "fair-region");
    id(item.edgeId, "fair-region edgeId");
    regionEdgeIds.push(item.edgeId as string);
    if (stableValue(item.participantIds) !== stableValue(provenance.participantIds)) throw new Error("Fair-region participant ordering is not bound.");
    if (stableValue((record(item.scope) ?? {}).participantIds) !== stableValue(provenance.participantIds)) throw new Error("Fair-region scope is not bound.");
    if (item.tolerancePercent !== provenance.tolerancePercent) throw new Error("Fair-region tolerance is not bound.");
    if (item.kind !== "exact" && item.kind !== "tolerance") throw new Error("Fair-region kind is invalid.");
    const tolerance = Rational.from(rational(item.tolerancePercent, "fair-region tolerance"));
    if (tolerance.isNegative() || tolerance.compare(100) > 0) throw new Error("Fair-region tolerance is outside its bound.");
    const scope = record(item.scope);
    if (!scope) throw new Error("Fair-region scope is invalid.");
    exactKeys(scope, ["kind", "participantIds"], "fair-region scope");
    if (scope.kind !== "pair" && scope.kind !== "all-participants") throw new Error("Fair-region scope kind is invalid.");
    snapshot(item.snapshot, "fair-region snapshot");
    if (!sameSnapshot(item.snapshot, provenance.snapshot)) throw new Error("Fair-region snapshot is not bound.");
    let previousEnd = Rational.zero();
    boundedArray(item.intervals, "fair-region intervals").forEach((interval) => { const part = record(interval); if (!part) throw new Error("Fair-region interval is invalid."); exactKeys(part, ["start", "end"], "fair-region interval"); const start = Rational.from(rational(part.start, "fair-region start")); const end = Rational.from(rational(part.end, "fair-region end")); if (start.isNegative() || end.compare(1) > 0 || start.compare(end) > 0 || start.compare(previousEnd) < 0) throw new Error("Fair-region intervals are not bounded or ordered."); previousEnd = end; });
    boundedArray(item.points, "fair-region points").forEach((point) => { const value = Rational.from(rational(point, "fair-region point")); if (value.isNegative() || value.compare(1) > 0) throw new Error("Fair-region point is outside its bound."); });
    const geometry = record(item.geometry);
    if (!geometry) throw new Error("Fair-region geometry is missing.");
    exactKeys(geometry, ["start", "end"], "fair-region geometry");
    coordinate(geometry.start, "fair-region geometry.start");
    coordinate(geometry.end, "fair-region geometry.end");
  }
  const firstRegion = record(result.fairRegion);
  const firstListedRegion = record(regions[0]);
  if (!firstRegion || !firstListedRegion || firstRegion.edgeId !== firstListedRegion.edgeId || !sameSnapshot(firstRegion.snapshot, provenance.snapshot) || stableValue(firstRegion) !== stableValue(firstListedRegion)) throw new Error("Primary fair region is not bound to fair-region coverage.");
  if (new Set(regionEdgeIds).size !== regionEdgeIds.length) throw new Error("Fair-region edge coverage is duplicated.");
  const fairRegionEdgeSet = new Set(regionEdgeIds);
  const components = boundedArray(result.components, "result.components");
  if (expectedStatus === "complete" && components.length === 0) throw new Error("Complete result has no eligible components.");
  const topLevelComponentVertexIds = new Set<string>();
  for (const component of components) {
    const item = record(component);
    if (!item || item.kind !== "connected-component") throw new Error("Component is invalid.");
    exactKeys(item, ["id", "snapshot", "participantIds", "kind", "edgeIntervals", "vertexIds", "endpointCoordinates"], "component");
    id(item.id, "component.id");
    snapshot(item.snapshot, "component.snapshot");
    if (!sameSnapshot(item.snapshot, provenance.snapshot)) throw new Error("Component snapshot is not bound.");
    const componentParticipants = sortedIds(boundedArray(item.participantIds, "component.participantIds"), "component.participantIds");
    if (stableValue(componentParticipants) !== stableValue(provenance.participantIds)) throw new Error("Component participants are not bound.");
    sortedIds(boundedArray(item.vertexIds, "component.vertexIds"), "component.vertexIds").forEach((vertexId) => topLevelComponentVertexIds.add(vertexId));
    boundedArray(item.edgeIntervals, "component.edgeIntervals").forEach((edgeInterval) => { const part = record(edgeInterval); if (!part) throw new Error("Component edge interval is invalid."); exactKeys(part, ["edgeId", "interval"], "component edge interval"); id(part.edgeId, "component edgeId"); if (!fairRegionEdgeSet.has(part.edgeId as string)) throw new Error("Component edge is not bound to a certified fair region."); const interval = record(part.interval); if (!interval) throw new Error("Component interval is invalid."); exactKeys(interval, ["start", "end"], "component interval"); const start = Rational.from(rational(interval.start, "component interval start")); const end = Rational.from(rational(interval.end, "component interval end")); if (start.isNegative() || end.compare(1) > 0 || start.compare(end) > 0) throw new Error("Component interval is outside its bound."); });
    boundedArray(item.endpointCoordinates, "component.endpointCoordinates").forEach((point) => coordinate(point, "component endpoint"));
  }
  const families = boundedArray(result.families, "result.families");
  if (expectedStatus === "complete" && families.length === 0) throw new Error("Complete result has no certified families.");
  if (expectedStatus === "no-eligible-target" && (components.length !== 0 || families.length !== 0)) throw new Error("No-target result contains eligible topology.");
  const topComponentKeys = components.map((component) => stableValue(component)).sort();
  const familyPathUnion = new Set<string>();
  const familyEdgeUnion = new Set<string>();
  for (const family of families) {
    const item = record(family);
    if (!item) throw new Error("Family is invalid.");
    exactKeys(item, ["snapshot", "contextKey", "skeletonKey", "geometryKey", "participantIds", "pathKeys", "targetEdgeIds", "eligibleComponents"], "family");
    snapshot(item.snapshot, "family.snapshot");
    if (!sameSnapshot(item.snapshot, provenance.snapshot)) throw new Error("Family snapshot is not bound.");
    for (const key of ["contextKey", "skeletonKey", "geometryKey"]) id(item[key], `family.${key}`);
    const familyParticipants = sortedIds(boundedArray(item.participantIds, "family.participantIds"), "family.participantIds");
    if (stableValue(familyParticipants) !== stableValue(provenance.participantIds)) throw new Error("Family participants are not bound.");
    sortedStrings(boundedArray(item.pathKeys, "family.pathKeys"), "family.pathKeys");
    const familyPaths = sortedStrings(boundedArray(item.pathKeys, "family.pathKeys"), "family.pathKeys");
    familyPaths.forEach((pathKey) => { if (familyPathUnion.has(pathKey)) throw new Error("Family path coverage is duplicated."); familyPathUnion.add(pathKey); });
    const familyEdges = sortedIds(boundedArray(item.targetEdgeIds, "family.targetEdgeIds"), "family.targetEdgeIds");
    familyEdges.forEach((edgeId) => familyEdgeUnion.add(edgeId));
    if (familyEdges.length !== regionEdgeIds.length || familyEdges.some((edgeId, index) => edgeId !== regionEdgeIds[index])) throw new Error("Family target-edge coverage is not bound.");
    const nestedKeys: string[] = [];
    for (const nested of boundedArray(item.eligibleComponents, "family.eligibleComponents")) {
      const component = record(nested);
      if (!component || !sameSnapshot(component.snapshot, provenance.snapshot) || component.kind !== "connected-component") throw new Error("Family component is not bound.");
      exactKeys(component, ["id", "snapshot", "participantIds", "kind", "edgeIntervals", "vertexIds", "endpointCoordinates"], "family component");
      id(component.id, "family component.id");
      sortedIds(boundedArray(component.participantIds, "family component.participantIds"), "family component.participantIds");
      sortedIds(boundedArray(component.vertexIds, "family component.vertexIds"), "family component.vertexIds");
      boundedArray(component.edgeIntervals, "family component.edgeIntervals").forEach((edgeInterval) => { const part = record(edgeInterval); if (!part) throw new Error("Family edge interval is invalid."); exactKeys(part, ["edgeId", "interval"], "family edge interval"); id(part.edgeId, "family edgeInterval.edgeId"); if (!fairRegionEdgeSet.has(part.edgeId as string) || !familyEdges.includes(part.edgeId as string)) throw new Error("Family component edge is not bound to its certified fair-region and family edge sets."); const interval = record(part.interval); if (!interval) throw new Error("Family edge interval bounds are invalid."); exactKeys(interval, ["start", "end"], "family component interval"); const start = Rational.from(rational(interval.start, "family edgeInterval.start")); const end = Rational.from(rational(interval.end, "family edgeInterval.end")); if (start.isNegative() || end.compare(1) > 0 || start.compare(end) > 0) throw new Error("Family component interval is outside its bound."); });
      boundedArray(component.endpointCoordinates, "family component.endpointCoordinates").forEach((point) => coordinate(point, "family component endpoint"));
      nestedKeys.push(stableValue(nested));
    }
    nestedKeys.sort();
    if (nestedKeys.length !== topComponentKeys.length || nestedKeys.some((key, index) => key !== topComponentKeys[index])) throw new Error("Family components do not equal top-level components.");
  }
  if (expectedStatus === "complete" && familyPathUnion.size < journeys.length) throw new Error("Family path coverage is incomplete.");
  if (expectedStatus === "complete") {
    const expectedPathKeys = journeys.map(canonicalRouteFirstClientJourneyPathKey).sort();
    if (familyPathUnion.size !== expectedPathKeys.length || expectedPathKeys.some((pathKey) => !familyPathUnion.has(pathKey))) throw new Error("Family paths are not bound to certified journeys.");
  }
  if (expectedStatus === "complete" && familyEdgeUnion.size !== regionEdgeIds.length) throw new Error("Family edge coverage is incomplete.");
  for (const component of components) {
    const item = record(component)!;
    for (const edgeInterval of boundedArray(item.edgeIntervals, "component.edgeIntervals")) {
      const edge = record(edgeInterval);
      if (edge && !familyEdgeUnion.has(edge.edgeId as string)) throw new Error("Component edge is not bound to a certified family edge set.");
    }
  }
  const landmarkEvaluation = record(result.landmarkEvaluation);
  if (!landmarkEvaluation || typeof landmarkEvaluation.organicComponentCount !== "number" || !Number.isInteger(landmarkEvaluation.organicComponentCount) || landmarkEvaluation.organicComponentCount < 0 || typeof landmarkEvaluation.minimumOrganicComponentDiversity !== "number" || !Number.isInteger(landmarkEvaluation.minimumOrganicComponentDiversity) || landmarkEvaluation.minimumOrganicComponentDiversity < 1 || typeof landmarkEvaluation.evaluated !== "boolean") throw new Error("Landmark evaluation is invalid.");
  exactKeys(landmarkEvaluation, ["organicComponentCount", "minimumOrganicComponentDiversity", "evaluated", "landmarkIds"], "landmark evaluation");
  const evaluatedLandmarkIds = sortedIds(boundedArray(landmarkEvaluation.landmarkIds, "landmarkEvaluation.landmarkIds"), "landmarkEvaluation.landmarkIds");
  if (!landmarkEvaluation.evaluated && evaluatedLandmarkIds.length > 0) throw new Error("Unevaluated landmark results must not contain evaluated landmark ids.");
  const admittedIds: string[] = [];
  for (const landmark of boundedArray(result.admittedLandmarks, "result.admittedLandmarks")) {
    const item = record(landmark);
    if (!item || item.kind !== "conditional-landmark" || item.scope !== "all-participants") throw new Error("Admitted landmark provenance is invalid.");
    exactKeys(item, ["id", "kind", "snapshot", "participantIds", "vertexId", "scope"], "admitted landmark");
    id(item.id, "landmark.id");
    admittedIds.push(item.id as string);
    snapshot(item.snapshot, "landmark.snapshot");
    if (!sameSnapshot(item.snapshot, provenance.snapshot)) throw new Error("Landmark snapshot is not bound.");
    const landmarkParticipants = sortedIds(boundedArray(item.participantIds, "landmark.participantIds"), "landmark.participantIds");
    if (stableValue(landmarkParticipants) !== stableValue(provenance.participantIds)) throw new Error("Landmark participants are not bound.");
    id(item.vertexId, "landmark.vertexId");
    if (!topLevelComponentVertexIds.has(item.vertexId as string)) throw new Error("Admitted landmark vertex is not bound to an eligible top-level component.");
  }
  if (new Set(admittedIds).size !== admittedIds.length || admittedIds.some((idValue) => !evaluatedLandmarkIds.includes(idValue))) throw new Error("Admitted landmark provenance is not bound to evaluation.");
  if (!landmarkEvaluation.evaluated && admittedIds.length > 0) throw new Error("Unevaluated landmark results must not contain admitted landmark ids.");
}

export function assertRouteFirstClientCompleteResult(value: unknown): RouteFirstClientCompleteResult {
  validateResult(value, "complete");
  return value as RouteFirstClientCompleteResult;
}

export interface RouteFirstClientEnvelopeExpectations {
  readonly jobId?: string;
  readonly snapshot?: RouteFirstClientSnapshot;
}

export function assertRouteFirstClientJobEnvelope(value: unknown, expectations: RouteFirstClientEnvelopeExpectations = {}): RouteFirstClientJobEnvelope {
  const envelope = record(value);
  if (!envelope || envelope.contractVersion !== "route-first-job/v1" || typeof envelope.jobId !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(envelope.jobId) ||
    !["queued", "running", "complete", "incomplete", "unavailable", "no-eligible-target", "failed", "expired"].includes(envelope.status as string) ||
    envelope.durable !== false || envelope.runtimePersistence !== "in-memory-process" || envelope.activation !== "blocked-until-durable-provider" || typeof envelope.expiresAt !== "number" || !Number.isSafeInteger(envelope.expiresAt)) throw new Error("Route-first job envelope is invalid.");
  exactKeys(envelope, ["contractVersion", "jobId", "status", "durable", "runtimePersistence", "activation", "expiresAt", "snapshot", "result"], "job envelope");
  try {
    if (JSON.stringify(value).length > 2 * 1024 * 1024) throw new Error("Route-first client envelope exceeds its size bound.");
  } catch (error) {
    if (error instanceof Error && error.message.includes("size bound")) throw error;
    throw new Error("Route-first client envelope is not JSON-safe.");
  }
  if (expectations.jobId !== undefined && expectations.jobId !== envelope.jobId) throw new Error("Route-first job id is not bound.");
  snapshot(envelope.snapshot, "job snapshot");
  if (expectations.snapshot && !sameSnapshot(envelope.snapshot, expectations.snapshot)) throw new Error("Route-first job snapshot is not bound.");
  if (["complete", "incomplete", "unavailable", "no-eligible-target", "failed"].includes(envelope.status as string)) {
    if (!envelope.result) throw new Error("Terminal job envelope is missing its result.");
    const resultRecord = record(envelope.result);
    const resultProvenance = resultRecord ? record(resultRecord.provenance) : null;
    if (!resultProvenance || !sameSnapshot(resultProvenance.snapshot, envelope.snapshot)) throw new Error("Job result snapshot is not bound to its envelope.");
    validateResult(envelope.result, envelope.status as RouteFirstClientJobStatus);
  } else if ("result" in envelope) throw new Error("Non-terminal jobs must not contain results.");
  return value as RouteFirstClientJobEnvelope;
}

export function isRouteFirstClientJobEnvelope(value: unknown): value is RouteFirstClientJobEnvelope {
  try { assertRouteFirstClientJobEnvelope(value); return true; } catch { return false; }
}

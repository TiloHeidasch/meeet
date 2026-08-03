import { ProjectedCoordinateMm, isProjectedCoordinateMm } from "./geometry.ts";
import { Rational } from "./rational.ts";

export type RouteFirstMode = "walk" | "transit" | "bike" | "car" | "wait" | "dwell";

export interface RouteSnapshotIdentity {
  readonly contractVersion: string;
  readonly manifestId: string;
  readonly graphDigest: string;
  readonly inputDigest: string;
}

export interface JourneyOccurrence {
  readonly occurrenceIndex: number;
  readonly coordinate: ProjectedCoordinateMm;
  readonly tau: Rational;
  readonly kind: "departure" | "arrival" | "vertex" | "wait" | "dwell";
}

export interface TimedPathSegment {
  readonly id: string;
  readonly fromOccurrenceIndex: number;
  readonly toOccurrenceIndex: number;
  readonly departureTau: Rational;
  readonly arrivalTau: Rational;
  readonly distanceMm: Rational;
  readonly mode: RouteFirstMode;
  readonly geometry: readonly ProjectedCoordinateMm[];
  readonly timingModel: "piecewise-linear";
}

export interface RoutePathReference {
  readonly vertexIds: readonly string[];
  readonly edgeIds: readonly string[];
}

export interface RouteJourneyRequestContext {
  readonly participantId: string;
  readonly originVertexId: string;
  readonly destinationVertexId: string;
  readonly departureContext: string;
  readonly snapshot: RouteSnapshotIdentity;
}

export interface RouteJourney {
  readonly id: string;
  readonly participantId: string;
  readonly snapshot: RouteSnapshotIdentity;
  readonly requestContext: RouteJourneyRequestContext;
  readonly path: RoutePathReference;
  readonly timingModel: "piecewise-linear";
  readonly occurrences: readonly JourneyOccurrence[];
  readonly segments: readonly TimedPathSegment[];
}

export interface RouteGraphVertex {
  readonly id: string;
  readonly coordinate: ProjectedCoordinateMm;
}

export interface RouteGraphEdge {
  readonly id: string;
  readonly fromVertexId: string;
  readonly toVertexId: string;
  readonly mode: RouteFirstMode;
  readonly duration: Rational;
  readonly distanceMm: Rational;
}

export interface RouteGraph {
  readonly vertices: readonly RouteGraphVertex[];
  readonly edges: readonly RouteGraphEdge[];
}

export interface RouteEnumerationPolicy {
  readonly policyId: string;
  readonly snapshot: RouteSnapshotIdentity;
  readonly maxHops?: number;
  readonly maxDuration?: Rational;
  readonly allowedModes?: readonly RouteFirstMode[];
  readonly workBudget?: bigint;
}

export interface RouteEnumerationInput {
  readonly graph: RouteGraph;
  readonly originVertexIds: readonly string[];
  readonly targetVertexIds: readonly string[];
  readonly policy: RouteEnumerationPolicy;
}

export interface ExactInterval {
  readonly start: Rational;
  readonly end: Rational;
}

export interface TargetVertex {
  readonly id: string;
  readonly coordinate: ProjectedCoordinateMm;
  readonly meetingEligible: boolean;
}

export interface TargetEdge {
  readonly id: string;
  readonly fromVertexId: string;
  readonly toVertexId: string;
  readonly start: ProjectedCoordinateMm;
  readonly end: ProjectedCoordinateMm;
  readonly accessClass: "pedestrian" | "transit-only" | "vehicle-only";
  readonly meetingEligible: boolean;
  readonly legalIntervals: readonly ExactInterval[];
}

export interface MeetingTargetTopology {
  readonly snapshot: RouteSnapshotIdentity;
  readonly vertices: readonly TargetVertex[];
  readonly edges: readonly TargetEdge[];
}

export interface AccessibleTargetInterval {
  readonly snapshot: RouteSnapshotIdentity;
  readonly participantId: string;
  readonly edgeId: string;
  readonly interval: ExactInterval;
}

export interface AccessibleTargetVertex {
  readonly snapshot: RouteSnapshotIdentity;
  readonly participantId: string;
  readonly vertexId: string;
}

export interface FairVertexEvidence {
  readonly snapshot: RouteSnapshotIdentity;
  readonly participantIds: readonly string[];
  readonly vertexId: string;
  readonly scope: "all-participants";
}

function canonicalId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /\s/.test(value)) {
    throw new Error(`${label} must be a canonical non-empty identifier.`);
  }
}

function exactRational(value: unknown, label: string): asserts value is Rational {
  if (!(value instanceof Rational)) throw new Error(`${label} must be a normalized Rational.`);
}

function validateSnapshot(snapshot: RouteSnapshotIdentity): void {
  if (!snapshot || typeof snapshot !== "object") throw new Error("Route snapshot identity is required.");
  canonicalId(snapshot.contractVersion, "snapshot contractVersion");
  canonicalId(snapshot.manifestId, "snapshot manifestId");
  canonicalId(snapshot.graphDigest, "snapshot graphDigest");
  canonicalId(snapshot.inputDigest, "snapshot inputDigest");
}

function validateInterval(interval: ExactInterval, label: string): void {
  exactRational(interval.start, `${label}.start`);
  exactRational(interval.end, `${label}.end`);
  if (interval.start.isNegative() || interval.end.compare(1) > 0 || interval.start.compare(interval.end) > 0) {
    throw new Error(`${label} must be an ordered interval within [0, 1].`);
  }
}

function validateJourneyContext(context: RouteJourneyRequestContext, journey: RouteJourney): void {
  canonicalId(context.participantId, "journey request participantId");
  canonicalId(context.originVertexId, "journey request originVertexId");
  canonicalId(context.destinationVertexId, "journey request destinationVertexId");
  canonicalId(context.departureContext, "journey request departureContext");
  validateSnapshot(context.snapshot);
  if (context.participantId !== journey.participantId || !sameSnapshot(context.snapshot, journey.snapshot)) {
    throw new Error("Journey request context is not bound to its participant or snapshot.");
  }
}

function validatePathReference(path: RoutePathReference, context: RouteJourneyRequestContext): void {
  if (!Array.isArray(path.vertexIds) || !Array.isArray(path.edgeIds) || path.vertexIds.length < 2 || path.edgeIds.length !== path.vertexIds.length - 1 ||
    new Set(path.vertexIds).size !== path.vertexIds.length || path.vertexIds[0] !== context.originVertexId ||
    path.vertexIds[path.vertexIds.length - 1] !== context.destinationVertexId) {
    throw new Error("Journey path reference is incomplete, looped, or outside its request context.");
  }
  path.vertexIds.forEach((id) => canonicalId(id, "journey path vertexId"));
  path.edgeIds.forEach((id) => canonicalId(id, "journey path edgeId"));
}

export function normalizeRouteJourney(input: RouteJourney): RouteJourney {
  canonicalId(input.id, "journey id");
  canonicalId(input.participantId, "journey participantId");
  validateSnapshot(input.snapshot);
  validateJourneyContext(input.requestContext, input);
  validatePathReference(input.path, input.requestContext);
  if (input.timingModel !== "piecewise-linear") throw new Error("Journey timing must declare piecewise-linear exactness.");
  if (!Array.isArray(input.occurrences) || input.occurrences.length < 2) throw new Error("Journey occurrences must be complete.");
  if (input.segments.length !== input.occurrences.length - 1) throw new Error("Journey segments must cover every occurrence interval.");
  const segmentIds = new Set<string>();
  for (const [index, occurrence] of input.occurrences.entries()) {
    if (occurrence.occurrenceIndex !== index || !isProjectedCoordinateMm(occurrence.coordinate)) {
      throw new Error("Journey occurrences must be indexed exact projected coordinates.");
    }
    if (!["departure", "arrival", "vertex", "wait", "dwell"].includes(occurrence.kind)) {
      throw new Error(`Occurrence ${index} has an invalid kind.`);
    }
    exactRational(occurrence.tau, `occurrence ${index} tau`);
    if (index > 0 && occurrence.tau.compare(input.occurrences[index - 1]!.tau) <= 0) {
      throw new Error("Journey tau must be strictly monotonic.");
    }
  }
  for (const [index, segment] of input.segments.entries()) {
    canonicalId(segment.id, `segment ${index} id`);
    if (segmentIds.has(segment.id)) throw new Error(`Journey segment ${segment.id} is duplicated.`);
    segmentIds.add(segment.id);
    if (!["walk", "transit", "bike", "car", "wait", "dwell"].includes(segment.mode)) {
      throw new Error(`Journey segment ${segment.id} has an invalid mode.`);
    }
    if (segment.fromOccurrenceIndex !== index || segment.toOccurrenceIndex !== index + 1) {
      throw new Error("Journey segments must be ordered and occurrence-indexed.");
    }
    exactRational(segment.departureTau, `segment ${index} departureTau`);
    exactRational(segment.arrivalTau, `segment ${index} arrivalTau`);
    exactRational(segment.distanceMm, `segment ${index} distanceMm`);
    if (segment.departureTau.compare(input.occurrences[index]!.tau) !== 0 ||
      segment.arrivalTau.compare(input.occurrences[index + 1]!.tau) !== 0 ||
      segment.arrivalTau.compare(segment.departureTau) <= 0 || segment.distanceMm.isNegative() ||
      segment.timingModel !== "piecewise-linear" || segment.geometry.length !== 2 ||
      segment.geometry.some((coordinate) => !isProjectedCoordinateMm(coordinate))) {
      throw new Error(`Journey segment ${segment.id} has incomplete or unaligned piecewise timing.`);
    }
    const from = input.occurrences[index]!.coordinate;
    const to = input.occurrences[index + 1]!.coordinate;
    if (!segment.geometry[0]!.equals(from) || !segment.geometry[segment.geometry.length - 1]!.equals(to)) {
      throw new Error(`Journey segment ${segment.id} geometry does not cover its occurrences.`);
    }
    if ((segment.mode === "wait" || segment.mode === "dwell") &&
      (!from.equals(to) || !segment.distanceMm.isZero())) {
      throw new Error(`${segment.mode} segments must preserve a stationary exact occurrence.`);
    }
    if (segment.mode !== "wait" && segment.mode !== "dwell" && segment.distanceMm.isZero() && !from.equals(to)) {
      throw new Error(`Journey segment ${segment.id} has zero distance between distinct coordinates.`);
    }
  }
  return Object.freeze({
    ...input,
    requestContext: Object.freeze({ ...input.requestContext }),
    path: Object.freeze({ vertexIds: Object.freeze([...input.path.vertexIds]), edgeIds: Object.freeze([...input.path.edgeIds]) }),
    occurrences: Object.freeze([...input.occurrences]),
    segments: Object.freeze([...input.segments]),
  });
}

export function normalizeTargetTopology(input: MeetingTargetTopology): MeetingTargetTopology {
  validateSnapshot(input.snapshot);
  const vertices = new Map<string, TargetVertex>();
  for (const vertex of input.vertices) {
    canonicalId(vertex.id, "target vertex id");
    if (!isProjectedCoordinateMm(vertex.coordinate) || vertices.has(vertex.id)) throw new Error("Target vertices must be unique exact coordinates.");
    vertices.set(vertex.id, vertex);
  }
  const edges = new Map<string, TargetEdge>();
  for (const edge of input.edges) {
    canonicalId(edge.id, "target edge id");
    if (edges.has(edge.id) || edge.fromVertexId === edge.toVertexId || !vertices.has(edge.fromVertexId) || !vertices.has(edge.toVertexId)) {
      throw new Error(`Target edge ${edge.id} is incomplete or looped.`);
    }
    if (!isProjectedCoordinateMm(edge.start) || !isProjectedCoordinateMm(edge.end) ||
      !edge.start.equals(vertices.get(edge.fromVertexId)!.coordinate) || !edge.end.equals(vertices.get(edge.toVertexId)!.coordinate)) {
      throw new Error(`Target edge ${edge.id} geometry does not match its vertices.`);
    }
    if (!["pedestrian", "transit-only", "vehicle-only"].includes(edge.accessClass)) throw new Error(`Target edge ${edge.id} has an invalid access class.`);
    let previousInterval: ExactInterval | null = null;
    for (const [index, interval] of edge.legalIntervals.entries()) {
      validateInterval(interval, `target edge ${edge.id} interval ${index}`);
      if (previousInterval && interval.start.compare(previousInterval.end) <= 0) {
        throw new Error(`Target edge ${edge.id} legal intervals must be sorted and disjoint.`);
      }
      previousInterval = interval;
    }
    if (edge.accessClass !== "pedestrian" && edge.meetingEligible) throw new Error(`Ineligible target edge ${edge.id} cannot be meeting eligible.`);
    if (!edge.meetingEligible && edge.legalIntervals.length > 0) throw new Error(`Ineligible target edge ${edge.id} cannot expose legal intervals.`);
    edges.set(edge.id, edge);
  }
  return Object.freeze({ ...input, vertices: Object.freeze([...vertices.values()]), edges: Object.freeze([...edges.values()]) });
}

export function sameSnapshot(left: RouteSnapshotIdentity, right: RouteSnapshotIdentity): boolean {
  return left.contractVersion === right.contractVersion && left.manifestId === right.manifestId &&
    left.graphDigest === right.graphDigest && left.inputDigest === right.inputDigest;
}

export { canonicalId, exactRational, validateInterval, validateSnapshot };

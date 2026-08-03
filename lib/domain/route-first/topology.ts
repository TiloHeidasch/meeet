import { interpolateCoordinate, type ExactPoint } from "./geometry.ts";
import {
  canonicalId,
  type AccessibleTargetInterval,
  type AccessibleTargetVertex,
  type ExactInterval,
  type FairVertexEvidence,
  type MeetingTargetTopology,
  normalizeTargetTopology,
  sameSnapshot,
  validateSnapshot,
  validateInterval,
} from "./models.ts";
import type { FairRegion } from "./fairness.ts";
import { Rational } from "./rational.ts";

export interface ComponentEdgeInterval {
  readonly edgeId: string;
  readonly interval: ExactInterval;
}

export interface EligibleTargetComponent {
  readonly id: string;
  readonly snapshot: MeetingTargetTopology["snapshot"];
  readonly participantIds: readonly string[];
  readonly kind: "connected-component";
  readonly edgeIntervals: readonly ComponentEdgeInterval[];
  readonly vertexIds: readonly string[];
  readonly endpointCoordinates: readonly ExactPoint[];
}

export interface FairEligibleTopologyInput {
  readonly topology: MeetingTargetTopology;
  readonly participantIds: readonly string[];
  readonly fairRegions: readonly FairRegion[];
  readonly accessibleIntervals: readonly AccessibleTargetInterval[];
  readonly accessibleVertices: readonly AccessibleTargetVertex[];
  readonly fairVertexEvidence?: readonly FairVertexEvidence[];
}

function intersect(left: ExactInterval, right: ExactInterval): ExactInterval | null {
  const start = left.start.compare(right.start) > 0 ? left.start : right.start;
  const end = left.end.compare(right.end) < 0 ? left.end : right.end;
  return start.compare(end) <= 0 ? { start, end } : null;
}

function canonicalizeIntervals(intervals: readonly ExactInterval[]): ExactInterval[] {
  const sorted = [...intervals].sort((left, right) => left.start.compare(right.start));
  const result: ExactInterval[] = [];
  for (const interval of sorted) {
    validateInterval(interval, "target interval");
    const previous = result[result.length - 1];
    if (previous && interval.start.compare(previous.end) <= 0) {
      result[result.length - 1] = { start: previous.start, end: interval.end.compare(previous.end) > 0 ? interval.end : previous.end };
    } else result.push(interval);
  }
  return result;
}

function intersectAll(intervalGroups: readonly (readonly ExactInterval[])[]): ExactInterval[] {
  let result: ExactInterval[] = [{ start: Rational.zero(), end: Rational.one() }];
  for (const group of intervalGroups) {
    const next: ExactInterval[] = [];
    for (const left of result) for (const right of group) {
      const intersection = intersect(left, right);
      if (intersection) next.push(intersection);
    }
    result = canonicalizeIntervals(next);
  }
  return result;
}

function intervalKey(interval: ExactInterval): string {
  return `${interval.start.toString()}..${interval.end.toString()}`;
}

function canonicalField(value: string): string {
  return `${value.length}:${value}`;
}

function canonicalTuple(values: readonly string[]): string {
  return `(${values.map(canonicalField).join("")})`;
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameParticipantIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((participantId, index) => participantId === right[index]);
}

function canonicalArray(values: readonly string[]): string {
  return `[${values.map((value) => `${value.length}:${value}`).join("")}]`;
}

function topologyStructuralKeyParts(participantIds: readonly string[], edgeIntervals: readonly ComponentEdgeInterval[], vertexIds: readonly string[]): string {
  const edges = edgeIntervals.map((interval) => canonicalTuple([interval.edgeId, interval.interval.start.toString(), interval.interval.end.toString()]));
  return canonicalTuple([canonicalArray(participantIds), canonicalArray(edges), canonicalArray(vertexIds)]);
}

export function canonicalTopologyStructuralKey(component: EligibleTargetComponent): string {
  const normalized = normalizeEligibleTargetComponent(component);
  return topologyStructuralKeyParts(normalized.participantIds, normalized.edgeIntervals, normalized.vertexIds);
}

export function normalizeEligibleTargetComponent(input: EligibleTargetComponent): EligibleTargetComponent {
  canonicalId(input.id, "route component id");
  validateSnapshot(input.snapshot);
  if (input.kind !== "connected-component" || (input.edgeIntervals.length === 0 && input.vertexIds.length === 0)) {
    throw new Error(`Route component ${input.id} is not a structured eligible topology component.`);
  }
  const participantIds = [...input.participantIds].sort(compareCanonical);
  if (participantIds.length < 2 || new Set(participantIds).size !== participantIds.length || participantIds.some((id) => !id.trim())) {
    throw new Error(`Route component ${input.id} has non-canonical participant provenance.`);
  }
  const edgeIntervals = [...input.edgeIntervals].map((edgeInterval) => {
    canonicalId(edgeInterval.edgeId, "route component edgeId");
    validateInterval(edgeInterval.interval, `route component ${input.id} interval`);
    return Object.freeze({ edgeId: edgeInterval.edgeId, interval: Object.freeze({ start: edgeInterval.interval.start, end: edgeInterval.interval.end }) });
  }).sort((left, right) => compareCanonical(
    canonicalTuple([left.edgeId, left.interval.start.toString(), left.interval.end.toString()]),
    canonicalTuple([right.edgeId, right.interval.start.toString(), right.interval.end.toString()]),
  ));
  const edgeKeys = edgeIntervals.map((edgeInterval) => canonicalTuple([edgeInterval.edgeId, edgeInterval.interval.start.toString(), edgeInterval.interval.end.toString()]));
  if (new Set(edgeKeys).size !== edgeKeys.length) throw new Error(`Route component ${input.id} has duplicate edge multiplicity.`);
  const vertexIds = [...input.vertexIds].sort(compareCanonical);
  vertexIds.forEach((vertexId) => canonicalId(vertexId, "route component vertexId"));
  if (new Set(vertexIds).size !== vertexIds.length) {
    throw new Error(`Route component ${input.id} vertex multiplicity is not canonical.`);
  }
  if (input.endpointCoordinates.some((point) => !(point.x instanceof Rational) || !(point.y instanceof Rational))) {
    throw new Error(`Route component ${input.id} has non-exact endpoint coordinates.`);
  }
  return Object.freeze({ ...input, participantIds: Object.freeze(participantIds), edgeIntervals: Object.freeze(edgeIntervals), vertexIds: Object.freeze(vertexIds), endpointCoordinates: Object.freeze([...input.endpointCoordinates]) });
}

export function compareEligibleTargetComponents(left: EligibleTargetComponent, right: EligibleTargetComponent): number {
  return compareCanonical(canonicalTopologyStructuralKey(normalizeEligibleTargetComponent(left)), canonicalTopologyStructuralKey(normalizeEligibleTargetComponent(right)));
}

function endpointVertexIds(edge: { fromVertexId: string; toVertexId: string }, interval: ExactInterval): string[] {
  const ids: string[] = [];
  if (interval.start.isZero()) ids.push(edge.fromVertexId);
  if (interval.end.equals(1)) ids.push(edge.toVertexId);
  return ids;
}

export function constructFairEligibleComponents(input: FairEligibleTopologyInput): readonly EligibleTargetComponent[] {
  const topology = normalizeTargetTopology(input.topology);
  const participants = [...input.participantIds];
  if (participants.length < 2 || new Set(participants).size !== participants.length || participants.some((id) => !id.trim()) ||
    participants.some((id, index) => index > 0 && participants[index - 1]! > id)) {
    throw new Error("At least two distinct participants are required for accessibility intersection.");
  }
  const participantSet = new Set(participants);
  const edgeById = new Map(topology.edges.map((edge) => [edge.id, edge]));
  const vertexById = new Map(topology.vertices.map((vertex) => [vertex.id, vertex]));
  const accessibility = new Map<string, Map<string, ExactInterval[]>>();
  for (const item of input.accessibleIntervals) {
    validateSnapshot(item.snapshot);
    if (!sameSnapshot(item.snapshot, topology.snapshot) || !participantSet.has(item.participantId) || !edgeById.has(item.edgeId)) throw new Error("Accessibility interval references an unknown participant, edge, or snapshot.");
    validateInterval(item.interval, "accessibility interval");
    const byEdge = accessibility.get(item.participantId) ?? new Map<string, ExactInterval[]>();
    byEdge.set(item.edgeId, canonicalizeIntervals([...(byEdge.get(item.edgeId) ?? []), item.interval]));
    accessibility.set(item.participantId, byEdge);
  }
  for (const participantId of participants) {
    if (!accessibility.has(participantId) && !input.accessibleVertices.some((vertex) => vertex.participantId === participantId)) {
      throw new Error(`Accessibility is missing for participant ${participantId}.`);
    }
  }
  const accessibleVertices = new Map<string, Set<string>>();
  for (const item of input.accessibleVertices) {
    validateSnapshot(item.snapshot);
    if (!sameSnapshot(item.snapshot, topology.snapshot) || !participantSet.has(item.participantId) || !vertexById.has(item.vertexId)) throw new Error("Accessibility vertex references an unknown participant, vertex, or snapshot.");
    const vertices = accessibleVertices.get(item.vertexId) ?? new Set<string>();
    vertices.add(item.participantId);
    accessibleVertices.set(item.vertexId, vertices);
  }
  const fairByEdge = new Map<string, FairRegion>();
  for (const region of input.fairRegions) {
    validateSnapshot(region.snapshot);
    if (!sameSnapshot(region.snapshot, topology.snapshot) || region.scope.kind !== "all-participants" ||
      !sameParticipantIds(region.participantIds, participants) || !sameParticipantIds(region.scope.participantIds, participants) ||
      !edgeById.has(region.edgeId)) throw new Error("Fair region references an unknown edge, participant scope, or snapshot.");
    const existing = fairByEdge.get(region.edgeId);
    const intervals = canonicalizeIntervals([
      ...(existing?.intervals ?? []),
      ...region.intervals,
      ...region.points.map((point) => ({ start: point, end: point })),
    ]);
    fairByEdge.set(region.edgeId, { ...region, intervals });
  }
  const fairVertices = new Set<string>();
  for (const evidence of input.fairVertexEvidence ?? []) {
    validateSnapshot(evidence.snapshot);
    if (!sameSnapshot(evidence.snapshot, topology.snapshot) || evidence.scope !== "all-participants" ||
      !sameParticipantIds(evidence.participantIds, participants) || !vertexById.has(evidence.vertexId) ||
      fairVertices.has(evidence.vertexId)) throw new Error("Fair vertex evidence is unbound, duplicated, or references an unknown target vertex.");
    if (!vertexById.get(evidence.vertexId)!.meetingEligible) throw new Error("Fair vertex evidence references an ineligible target vertex.");
    fairVertices.add(evidence.vertexId);
  }
  const fragments: Array<{ edgeId: string; interval: ExactInterval; vertexIds: string[] }> = [];
  for (const edge of topology.edges) {
    if (!edge.meetingEligible) continue;
    const fair = fairByEdge.get(edge.id);
    if (!fair) continue;
    const accessibleGroups = participants.map((participantId) => accessibility.get(participantId)?.get(edge.id) ?? []);
    if (accessibleGroups.some((group) => group.length === 0)) continue;
    const available = intersectAll(accessibleGroups);
    const legal = canonicalizeIntervals(edge.legalIntervals);
    const fairIntervals = canonicalizeIntervals(fair.intervals);
    const edgeIntervals: ExactInterval[] = [];
    for (const fairInterval of fairIntervals) for (const legalInterval of legal) for (const availableInterval of available) {
      const first = intersect(fairInterval, legalInterval);
      const result = first ? intersect(first, availableInterval) : null;
      if (result) edgeIntervals.push(result);
    }
    for (const interval of canonicalizeIntervals(edgeIntervals)) {
      const endpointIds = endpointVertexIds(edge, interval);
      if (endpointIds.some((vertexId) => vertexById.get(vertexId)?.meetingEligible !== true)) continue;
      fragments.push({ edgeId: edge.id, interval, vertexIds: endpointIds });
    }
  }
  const vertexFragments = [...fairVertices].filter((vertexId) => vertexById.get(vertexId)?.meetingEligible &&
    accessibleVertices.get(vertexId)?.size === participants.length).map((vertexId) => ({ vertexId }));
  const parent = fragments.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
  const union = (left: number, right: number): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  for (let left = 0; left < fragments.length; left += 1) for (let right = left + 1; right < fragments.length; right += 1) {
    const shared = fragments[left]!.vertexIds.filter((vertexId) => fragments[right]!.vertexIds.includes(vertexId));
    if (shared.length > 0) union(left, right);
  }
  const groups = new Map<number, typeof fragments>();
  for (const [index, fragment] of fragments.entries()) {
    const group = groups.get(find(index)) ?? [];
    group.push(fragment);
    groups.set(find(index), group);
  }
  const components: EligibleTargetComponent[] = [...groups.values()].map((group) => {
    const edgeIntervals = group.sort((left, right) => compareCanonical(`${left.edgeId}:${intervalKey(left.interval)}`, `${right.edgeId}:${intervalKey(right.interval)}`))
      .map((fragment) => Object.freeze({ edgeId: fragment.edgeId, interval: Object.freeze(fragment.interval) }));
    const vertexIds = [...new Set([...group.flatMap((fragment) => fragment.vertexIds), ...vertexFragments.filter((vertex) => group.some((fragment) => fragment.vertexIds.includes(vertex.vertexId))).map((vertex) => vertex.vertexId)])].sort();
    const endpointCoordinates = vertexIds.map((vertexId) => pointForVertex(vertexById.get(vertexId)!));
    const id = `component:${canonicalTuple([
      ...edgeIntervals.map((interval) => canonicalTuple([interval.edgeId, interval.interval.start.toString(), interval.interval.end.toString()])),
      ...vertexIds.map((vertexId) => canonicalTuple([vertexId])),
    ])}`;
    return normalizeEligibleTargetComponent({ id, snapshot: topology.snapshot, participantIds: Object.freeze([...participants]), kind: "connected-component", edgeIntervals: Object.freeze(edgeIntervals), vertexIds: Object.freeze(vertexIds), endpointCoordinates: Object.freeze(endpointCoordinates) });
  });
  const connectedVertices = new Set(components.flatMap((component) => component.vertexIds));
  for (const { vertexId } of vertexFragments) {
    if (connectedVertices.has(vertexId)) continue;
    const vertex = vertexById.get(vertexId)!;
    components.push(normalizeEligibleTargetComponent({
      id: `component:vertex:${vertexId}`,
      snapshot: topology.snapshot,
      participantIds: Object.freeze([...participants]),
      kind: "connected-component" as const,
      edgeIntervals: Object.freeze([]),
      vertexIds: Object.freeze([vertexId]),
      endpointCoordinates: Object.freeze([pointForVertex(vertex)]),
    }));
  }
  return Object.freeze(components.sort((left, right) => compareEligibleTargetComponents(left, right) || compareCanonical(left.id, right.id)));
}

function pointForVertex(vertex: { coordinate: import("./geometry.ts").ProjectedCoordinateMm }): ExactPoint {
  return interpolateCoordinate(vertex.coordinate, vertex.coordinate, Rational.zero());
}

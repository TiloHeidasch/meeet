import { Rational } from "./rational.ts";
import { isProjectedCoordinateMm } from "./geometry.ts";
import {
  canonicalId,
  type RouteEnumerationInput,
  type RouteEnumerationPolicy,
  type RouteGraph,
  type RouteGraphEdge,
  type RouteGraphVertex,
  validateSnapshot,
} from "./models.ts";

export interface EnumeratedRoutePath {
  readonly vertexIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly duration: Rational;
  readonly distanceMm: Rational;
  readonly loopless: true;
}

export interface EnumerationCertificate {
  readonly complete: boolean;
  readonly statesVisited: bigint;
  readonly edgeTransitions: bigint;
  readonly pathsEmitted: bigint;
  readonly maxSimplePathStateBound: bigint;
  readonly workBudget: bigint | null;
  readonly workUnits: bigint;
  readonly parallelEdgeFactor: bigint;
  readonly graphFingerprint: string;
  readonly policyFingerprint: string;
  readonly snapshotFingerprint: string;
  readonly originVertexIds: readonly string[];
  readonly targetVertexIds: readonly string[];
}

export interface CompleteRouteEnumeration {
  readonly status: "complete";
  readonly paths: readonly EnumeratedRoutePath[];
  readonly certificate: EnumerationCertificate;
}

export interface IncompleteRouteEnumeration {
  readonly status: "incomplete";
  readonly paths: readonly EnumeratedRoutePath[];
  readonly certificate: EnumerationCertificate;
  readonly reason: "work-budget-exhausted";
}

export interface UnavailableRouteEnumeration {
  readonly status: "unavailable";
  readonly paths: readonly [];
  readonly certificate: null;
  readonly reason: string;
}

export type RouteEnumerationResult = CompleteRouteEnumeration | IncompleteRouteEnumeration | UnavailableRouteEnumeration;

function validateGraph(graph: RouteGraph): { vertices: Map<string, RouteGraphVertex>; edges: Map<string, RouteGraphEdge> } {
  if (graph.vertices.length === 0) throw new Error("Route graph must contain vertices.");
  const vertices = new Map<string, RouteGraphVertex>();
  for (const vertex of graph.vertices) {
    canonicalId(vertex.id, "graph vertex id");
    if (vertices.has(vertex.id) || !isProjectedCoordinateMm(vertex.coordinate)) throw new Error(`Duplicate or invalid graph vertex ${vertex.id}.`);
    vertices.set(vertex.id, vertex);
  }
  const edges = new Map<string, RouteGraphEdge>();
  for (const edge of graph.edges) {
    canonicalId(edge.id, "graph edge id");
    if (edges.has(edge.id) || edge.fromVertexId === edge.toVertexId ||
      !vertices.has(edge.fromVertexId) || !vertices.has(edge.toVertexId)) {
      throw new Error(`Graph edge ${edge.id} is incomplete or looped.`);
    }
    if (!(edge.duration instanceof Rational) || edge.duration.isNegative() ||
      !(edge.distanceMm instanceof Rational) || edge.distanceMm.isNegative()) {
      throw new Error(`Graph edge ${edge.id} has invalid exact distance or duration.`);
    }
    if (!["walk", "transit", "bike", "car", "wait", "dwell"].includes(edge.mode)) throw new Error(`Graph edge ${edge.id} has an invalid mode.`);
    edges.set(edge.id, edge);
  }
  return { vertices, edges };
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validatePolicy(policy: RouteEnumerationPolicy, vertexCount: number): Required<Pick<RouteEnumerationPolicy, "maxHops">> {
  canonicalId(policy.policyId, "enumeration policyId");
  validateSnapshot(policy.snapshot);
  const maxHops = policy.maxHops ?? Math.max(0, vertexCount - 1);
  if (!Number.isInteger(maxHops) || maxHops < 0 || maxHops > Math.max(0, vertexCount - 1)) {
    throw new Error("Enumeration maxHops must be a finite loopless graph bound.");
  }
  if (policy.maxDuration !== undefined && (!(policy.maxDuration instanceof Rational) || policy.maxDuration.isNegative())) {
    throw new Error("Enumeration maxDuration must be a non-negative Rational.");
  }
  if (policy.workBudget !== undefined && (typeof policy.workBudget !== "bigint" || policy.workBudget < BigInt(1))) throw new Error("Enumeration workBudget must be a positive bigint.");
  if (policy.allowedModes) {
    const modes = new Set(policy.allowedModes);
    if (modes.size !== policy.allowedModes.length || policy.allowedModes.some((mode, index) => index > 0 && policy.allowedModes![index - 1]! > mode)) {
      throw new Error("Enumeration allowedModes must be canonical and unique.");
    }
  }
  return { maxHops };
}

function simplePathStateBound(vertexCount: number, starts: number, maxHops: number, parallelEdgeFactor: bigint): bigint {
  let permutations = BigInt(1);
  let total = BigInt(0);
  for (let hops = 0; hops <= maxHops; hops += 1) {
    total += permutations * parallelEdgeFactor ** BigInt(hops);
    permutations *= BigInt(Math.max(0, vertexCount - 1 - hops));
  }
  return total * BigInt(starts);
}

function snapshotFingerprint(snapshot: RouteEnumerationPolicy["snapshot"]): string {
  return canonicalTuple([snapshot.contractVersion, snapshot.manifestId, snapshot.graphDigest, snapshot.inputDigest]);
}

export function canonicalRouteSnapshotKey(snapshot: RouteEnumerationPolicy["snapshot"]): string {
  return snapshotFingerprint(snapshot);
}

function graphFingerprint(graph: RouteGraph): string {
  const vertices = [...graph.vertices].sort((left, right) => compareCanonical(left.id, right.id))
    .map((vertex) => canonicalTuple([vertex.id, vertex.coordinate.xMm.toString(), vertex.coordinate.yMm.toString()]));
  const edges = [...graph.edges].sort((left, right) => compareCanonical(left.id, right.id))
    .map((edge) => canonicalTuple([edge.id, edge.fromVertexId, edge.toVertexId, edge.mode, edge.duration.toString(), edge.distanceMm.toString()]));
  return canonicalTuple([canonicalArray(vertices), canonicalArray(edges)]);
}

function policyFingerprint(policy: RouteEnumerationPolicy): string {
  return canonicalTuple([
    policy.policyId,
    policy.maxHops === undefined ? "default" : String(policy.maxHops),
    policy.maxDuration?.toString() ?? "none",
    policy.allowedModes === undefined ? "all" : canonicalArray(policy.allowedModes),
    policy.workBudget?.toString() ?? "none",
  ]);
}

export function canonicalEnumerationPolicyKey(policy: RouteEnumerationPolicy): string {
  return policyFingerprint(policy);
}

function canonicalField(value: string): string {
  return `${value.length}:${value}`;
}

function canonicalArray(values: readonly string[]): string {
  return `[${values.map(canonicalField).join("")}]`;
}

function canonicalTuple(values: readonly string[]): string {
  return `(${values.map(canonicalField).join("")})`;
}

function parallelEdgeFactor(graph: RouteGraph): bigint {
  const counts = new Map<string, bigint>();
  for (const edge of graph.edges) {
    const key = `${edge.fromVertexId}>${edge.toVertexId}`;
    counts.set(key, (counts.get(key) ?? BigInt(0)) + BigInt(1));
  }
  return [...counts.values()].reduce((maximum, count) => count > maximum ? count : maximum, BigInt(1));
}

function validateEnumeratedPath(
  path: EnumeratedRoutePath,
  vertices: Map<string, RouteGraphVertex>,
  edges: Map<string, RouteGraphEdge>,
  origins: ReadonlySet<string>,
  targets: ReadonlySet<string>,
  policy: RouteEnumerationPolicy,
  maxHops: number,
): void {
  if (path.loopless !== true || path.vertexIds.length === 0 || path.edgeIds.length !== path.vertexIds.length - 1 ||
    !origins.has(path.vertexIds[0]!) || !targets.has(path.vertexIds[path.vertexIds.length - 1]!) ||
    new Set(path.vertexIds).size !== path.vertexIds.length || path.edgeIds.length > maxHops ||
    !(path.duration instanceof Rational) || path.duration.isNegative() ||
    !(path.distanceMm instanceof Rational) || path.distanceMm.isNegative()) {
    throw new Error("Route enumeration certificate contains an invalid or non-loopless path.");
  }
  let duration = Rational.zero();
  let distanceMm = Rational.zero();
  for (const [index, edgeId] of path.edgeIds.entries()) {
    const edge = edges.get(edgeId);
    const fromVertexId = path.vertexIds[index]!;
    const toVertexId = path.vertexIds[index + 1]!;
    if (!vertices.has(fromVertexId) || !vertices.has(toVertexId) || !edge || edge.fromVertexId !== fromVertexId || edge.toVertexId !== toVertexId ||
      (policy.allowedModes !== undefined && !policy.allowedModes.includes(edge.mode))) {
      throw new Error("Route enumeration certificate contains an illegal edge transition.");
    }
    duration = duration.add(edge.duration);
    distanceMm = distanceMm.add(edge.distanceMm);
  }
  if (!path.duration.equals(duration) || !path.distanceMm.equals(distanceMm) ||
    (policy.maxDuration !== undefined && duration.compare(policy.maxDuration) > 0)) {
    throw new Error("Route enumeration certificate contains an incorrect path duration or distance.");
  }
}

function enumeratedPathKey(path: EnumeratedRoutePath): string {
  return canonicalTuple([
    canonicalArray(path.vertexIds),
    canonicalArray(path.edgeIds),
    path.duration.toString(),
    path.distanceMm.toString(),
  ]);
}

export function canonicalEnumeratedRoutePathKey(path: EnumeratedRoutePath): string {
  return enumeratedPathKey(path);
}

export function unavailableRouteEnumeration(reason: string): UnavailableRouteEnumeration {
  if (!reason.trim()) throw new Error("Unavailable enumeration requires a reason.");
  return Object.freeze({ status: "unavailable", paths: Object.freeze([]) as readonly [], certificate: null, reason });
}

export function enumerateLooplessRoutes(input: RouteEnumerationInput): RouteEnumerationResult {
  const { vertices, edges } = validateGraph(input.graph);
  const { maxHops } = validatePolicy(input.policy, vertices.size);
  const starts = [...input.originVertexIds].sort();
  const targetVertexIds = [...input.targetVertexIds].sort();
  const targets = new Set(targetVertexIds);
  if (starts.length === 0 || new Set(starts).size !== starts.length || starts.some((id) => !vertices.has(id)) || targetVertexIds.length === 0 || targets.size !== targetVertexIds.length || [...targets].some((id) => !vertices.has(id))) {
    throw new Error("Enumeration origins and targets must reference graph vertices.");
  }
  const allowedModes = input.policy.allowedModes ? new Set(input.policy.allowedModes) : null;
  const adjacency = new Map<string, RouteGraphEdge[]>();
  for (const edge of edges.values()) {
    const list = adjacency.get(edge.fromVertexId) ?? [];
    list.push(edge);
    adjacency.set(edge.fromVertexId, list);
  }
  for (const list of adjacency.values()) list.sort((left, right) => compareCanonical(left.id, right.id));
  const paths: EnumeratedRoutePath[] = [];
  let statesVisited = BigInt(0);
  let edgeTransitions = BigInt(0);
  let workUnits = BigInt(0);
  let stopped = false;
  const workBudget = input.policy.workBudget ?? null;

  const visit = (vertexId: string, vertexIds: readonly string[], edgeIds: readonly string[], duration: Rational, distanceMm: Rational): void => {
    if (stopped) return;
    if (workBudget !== null && workUnits >= workBudget) {
      stopped = true;
      return;
    }
    workUnits += BigInt(1);
    statesVisited += BigInt(1);
    if (targets.has(vertexId)) {
      paths.push(Object.freeze({ vertexIds: Object.freeze([...vertexIds]), edgeIds: Object.freeze([...edgeIds]), duration, distanceMm, loopless: true }));
      return;
    }
    if (edgeIds.length >= maxHops) return;
    for (const edge of adjacency.get(vertexId) ?? []) {
      if (workBudget !== null && workUnits >= workBudget) {
        stopped = true;
        return;
      }
      workUnits += BigInt(1);
      edgeTransitions += BigInt(1);
      if (allowedModes && !allowedModes.has(edge.mode)) continue;
      if (vertexIds.includes(edge.toVertexId)) continue;
      const nextDuration = duration.add(edge.duration);
      if (input.policy.maxDuration && nextDuration.compare(input.policy.maxDuration) > 0) continue;
      visit(edge.toVertexId, [...vertexIds, edge.toVertexId], [...edgeIds, edge.id], nextDuration, distanceMm.add(edge.distanceMm));
      if (stopped) return;
    }
  };
  for (const start of starts) {
    visit(start, [start], [], Rational.zero(), Rational.zero());
    if (stopped) break;
  }
  const certificate: EnumerationCertificate = Object.freeze({
    complete: !stopped,
    statesVisited,
    edgeTransitions,
    pathsEmitted: BigInt(paths.length),
    maxSimplePathStateBound: simplePathStateBound(vertices.size, starts.length, maxHops, parallelEdgeFactor(input.graph)),
    workBudget,
    workUnits,
    parallelEdgeFactor: parallelEdgeFactor(input.graph),
    graphFingerprint: graphFingerprint(input.graph),
    policyFingerprint: policyFingerprint(input.policy),
    snapshotFingerprint: snapshotFingerprint(input.policy.snapshot),
    originVertexIds: Object.freeze([...starts]),
    targetVertexIds: Object.freeze([...targetVertexIds]),
  });
  if (stopped) return Object.freeze({ status: "incomplete", paths: Object.freeze(paths), certificate, reason: "work-budget-exhausted" });
  return Object.freeze({ status: "complete", paths: Object.freeze(paths), certificate });
}

export function verifyEnumerationCertificate(input: RouteEnumerationInput, result: CompleteRouteEnumeration | IncompleteRouteEnumeration): void {
  const { vertices, edges } = validateGraph(input.graph);
  const { maxHops } = validatePolicy(input.policy, vertices.size);
  const certificate = result.certificate;
  const origins = [...input.originVertexIds].sort();
  const targets = [...input.targetVertexIds].sort();
  const originSet = new Set(origins);
  const targetSet = new Set(targets);
  if (origins.length === 0 || new Set(origins).size !== origins.length || origins.some((id) => !vertices.has(id)) ||
    targets.length === 0 || new Set(targets).size !== targets.length || targets.some((id) => !vertices.has(id))) {
    throw new Error("Enumeration origins and targets must reference graph vertices.");
  }
  if (!["complete", "incomplete"].includes(result.status)) throw new Error("Route enumeration certificate status is invalid.");
  const seenPaths = new Set<string>();
  for (const path of result.paths) {
    validateEnumeratedPath(path, vertices, edges, originSet, targetSet, input.policy, maxHops);
    const key = enumeratedPathKey(path);
    if (seenPaths.has(key)) throw new Error("Route enumeration certificate contains a duplicate path.");
    seenPaths.add(key);
  }
  const nonNegativeCounters = [certificate.statesVisited, certificate.edgeTransitions, certificate.pathsEmitted, certificate.maxSimplePathStateBound, certificate.workUnits, certificate.parallelEdgeFactor];
  if (nonNegativeCounters.some((counter) => typeof counter !== "bigint" || counter < BigInt(0))) throw new Error("Route enumeration certificate counters must be non-negative bigints.");
  const expectedBudget = input.policy.workBudget ?? null;
  const independentlyEnumerated = enumerateLooplessRoutes(input);
  if (independentlyEnumerated.status !== result.status ||
    canonicalArray(independentlyEnumerated.paths.map(enumeratedPathKey)) !== canonicalArray(result.paths.map(enumeratedPathKey)) ||
    independentlyEnumerated.certificate.complete !== certificate.complete ||
    independentlyEnumerated.certificate.statesVisited !== certificate.statesVisited ||
    independentlyEnumerated.certificate.edgeTransitions !== certificate.edgeTransitions ||
    independentlyEnumerated.certificate.pathsEmitted !== certificate.pathsEmitted ||
    independentlyEnumerated.certificate.maxSimplePathStateBound !== certificate.maxSimplePathStateBound ||
    independentlyEnumerated.certificate.workBudget !== certificate.workBudget ||
    independentlyEnumerated.certificate.workUnits !== certificate.workUnits ||
    independentlyEnumerated.certificate.parallelEdgeFactor !== certificate.parallelEdgeFactor) {
    throw new Error("Route enumeration certificate does not match an independently recomputed bounded enumeration.");
  }
  if (certificate.graphFingerprint !== graphFingerprint(input.graph) ||
    certificate.policyFingerprint !== policyFingerprint(input.policy) ||
    certificate.snapshotFingerprint !== snapshotFingerprint(input.policy.snapshot) ||
    canonicalArray(certificate.originVertexIds) !== canonicalArray(origins) ||
    canonicalArray(certificate.targetVertexIds) !== canonicalArray(targets) ||
    certificate.complete !== (result.status === "complete") ||
    certificate.pathsEmitted !== BigInt(result.paths.length) ||
    certificate.parallelEdgeFactor !== parallelEdgeFactor(input.graph) ||
    certificate.maxSimplePathStateBound !== simplePathStateBound(vertices.size, origins.length, maxHops, parallelEdgeFactor(input.graph)) ||
    certificate.workUnits !== certificate.statesVisited + certificate.edgeTransitions ||
    certificate.workBudget !== expectedBudget ||
    certificate.statesVisited > certificate.maxSimplePathStateBound ||
    (result.status === "incomplete" && (certificate.workBudget === null || certificate.workUnits !== certificate.workBudget))) {
    throw new Error("Route enumeration certificate does not bind to the requested graph, policy, snapshot, or bounds.");
  }
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  Rational,
  allParticipantExactRegion,
  allParticipantToleranceRegion,
  canonicalRouteComponentKey,
  canonicalJourneyMidpoint,
  compareMeaningfulRouteFamilies,
  constructFairEligibleComponents,
  enumerateLooplessRoutes,
  exactTemporalCorridor,
  normalizeRouteJourney,
  normalizeTargetTopology,
  pairExactMidpointRegion,
  projectedCoordinateMm,
  rationalMedian,
  unavailableRouteEnumeration,
  verifyEnumerationCertificate,
  type AffineTimeSegment,
  type MeetingTargetTopology,
  type RouteEnumerationInput,
  type RouteJourney,
  type RouteSnapshotIdentity,
  type TargetTimeProfile,
} from "../lib/domain/route-first/index.ts";

const SNAPSHOT: RouteSnapshotIdentity = {
  contractVersion: "route-first-test/v1",
  manifestId: "manifest-test",
  graphDigest: "graph-test",
  inputDigest: "input-test",
};

const C0 = projectedCoordinateMm(0, 0);
const C1 = projectedCoordinateMm(1_000, 0);

test("route-first rational arithmetic and projected millimetre primitives stay exact", () => {
  const value = Rational.from("9007199254740993/7").add("1/7");
  assert.equal(value.toString(), "9007199254740994/7");
  assert.equal(Rational.from("-3/2").floor(), BigInt(-2));
  assert.equal(Rational.from("-3/2").ceil(), BigInt(-1));
  assert.equal(projectedCoordinateMm("900719925474099312345", "2").key(), "900719925474099312345,2");
  assert.throws(() => Rational.from("1/0"), /Invalid exact rational|denominator/);
});

function journeyFixture(): RouteJourney {
  return {
    id: "journey-a",
    participantId: "participant-a",
    snapshot: SNAPSHOT,
    requestContext: {
      participantId: "participant-a",
      originVertexId: "A",
      destinationVertexId: "T",
      departureContext: "departure:test",
      snapshot: SNAPSHOT,
    },
    path: { vertexIds: ["A", "B", "T"], edgeIds: ["a-b", "b-t"] },
    timingModel: "piecewise-linear",
    occurrences: [
      { occurrenceIndex: 0, coordinate: C0, tau: Rational.zero(), kind: "departure" },
      { occurrenceIndex: 1, coordinate: C0, tau: Rational.from(2), kind: "dwell" },
      { occurrenceIndex: 2, coordinate: C1, tau: Rational.from(5), kind: "arrival" },
    ],
    segments: [
      {
        id: "dwell-0",
        fromOccurrenceIndex: 0,
        toOccurrenceIndex: 1,
        departureTau: Rational.zero(),
        arrivalTau: Rational.from(2),
        distanceMm: Rational.zero(),
        mode: "dwell",
        geometry: [C0, C0],
        timingModel: "piecewise-linear",
      },
      {
        id: "walk-1",
        fromOccurrenceIndex: 1,
        toOccurrenceIndex: 2,
        departureTau: Rational.from(2),
        arrivalTau: Rational.from(5),
        distanceMm: Rational.from(1_000),
        mode: "walk",
        geometry: [C0, C1],
        timingModel: "piecewise-linear",
      },
    ],
  };
}

test("occurrence-indexed journeys preserve repeated coordinates, dwell, and cumulative midpoint time", () => {
  const journey = normalizeRouteJourney(journeyFixture());
  const midpoint = canonicalJourneyMidpoint(journey);
  assert.equal(journey.occurrences[0]?.coordinate.key(), journey.occurrences[1]?.coordinate.key());
  assert.equal(midpoint.segmentId, "walk-1");
  assert.equal(midpoint.midpointTau.toString(), "5/2");
  assert.equal(midpoint.coordinate.x.toString(), "500/3");
  const corridor = exactTemporalCorridor(journey, 10);
  assert.deepEqual([corridor.exact.startTau.toString(), corridor.exact.endTau.toString()], ["9/4", "11/4"]);
  assert.equal(corridor.ambiguityEnvelope, null);
  const alternateInput = graphInput();
  const alternateEnumeration = enumerateLooplessRoutes(alternateInput);
  assert.equal(alternateEnumeration.status, "complete");
  if (alternateEnumeration.status !== "complete") return;
  const family = {
    familyKey: "alternate-family",
    request: journey.requestContext,
    policy: alternateInput.policy,
  } as const;
  const certifiedPath = alternateEnumeration.paths.find((path) => path.edgeIds.join(",") === "a-b,b-t");
  assert.ok(certifiedPath);
  const certified = exactTemporalCorridor(journey, 10, {
    context: family,
    alternates: [{
      complete: true,
      family,
      enumerationInput: alternateInput,
      enumeration: alternateEnumeration,
      path: certifiedPath,
      journey,
    }],
  });
  assert.deepEqual([certified.ambiguityEnvelope?.startTau.toString(), certified.ambiguityEnvelope?.endTau.toString()], ["9/4", "11/4"]);
  assert.equal(certified.constituentCorridors.length, 2);
  assert.throws(() => exactTemporalCorridor(journey, 10, {
    context: { ...family, request: { ...family.request, participantId: "unrelated-participant" } },
    alternates: [{ complete: true, family, enumerationInput: alternateInput, enumeration: alternateEnumeration, path: certifiedPath, journey }],
  }), /unrelated|provenance/);
  assert.throws(() => exactTemporalCorridor(journey, 10, {
    context: family,
    alternates: [{ complete: true, family: { ...family, familyKey: "unrelated-family" }, enumerationInput: alternateInput, enumeration: alternateEnumeration, path: certifiedPath, journey }],
  }), /provenance/);
  assert.throws(() => exactTemporalCorridor(journey, 10, {
    context: family,
    alternates: [{ complete: true, family, enumerationInput: alternateInput, enumeration: alternateEnumeration, path: { ...certifiedPath, edgeIds: ["a-c", "c-t"] }, journey }],
  }), /path|provenance/);
  const unaligned = journeyFixture();
  (unaligned.segments[1] as { geometry: readonly typeof C0[] }).geometry = [C0, projectedCoordinateMm(500, 0), C1];
  assert.throws(() => normalizeRouteJourney(unaligned), /unaligned/);
});

function graphInput(workBudget?: bigint): RouteEnumerationInput {
  return {
    graph: {
      vertices: ["A", "B", "C", "T"].map((id, index) => ({ id, coordinate: projectedCoordinateMm(index, 0) })),
      edges: [
        { id: "a-b", fromVertexId: "A", toVertexId: "B", mode: "walk", duration: Rational.from(1), distanceMm: Rational.from(10) },
        { id: "a-c", fromVertexId: "A", toVertexId: "C", mode: "walk", duration: Rational.from(2), distanceMm: Rational.from(20) },
        { id: "b-c", fromVertexId: "B", toVertexId: "C", mode: "walk", duration: Rational.from(1), distanceMm: Rational.from(10) },
        { id: "b-t", fromVertexId: "B", toVertexId: "T", mode: "transit", duration: Rational.from(2), distanceMm: Rational.from(20) },
        { id: "c-t", fromVertexId: "C", toVertexId: "T", mode: "transit", duration: Rational.from(1), distanceMm: Rational.from(10) },
      ],
    },
    originVertexIds: ["A"],
    targetVertexIds: ["T"],
    policy: {
      policyId: "all-loopless",
      snapshot: SNAPSHOT,
      allowedModes: ["transit", "walk"],
      ...(workBudget === undefined ? {} : { workBudget }),
    },
  };
}

test("loopless enumeration is complete, deterministic, finite, and certifies work", () => {
  const result = enumerateLooplessRoutes(graphInput());
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.paths.map((path) => path.edgeIds), [
    ["a-b", "b-c", "c-t"],
    ["a-b", "b-t"],
    ["a-c", "c-t"],
    ["a-c", "c-t"],
  ].filter((path, index, all) => index === all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(path))));
  assert.equal(result.certificate.complete, true);
  assert.ok(result.certificate.maxSimplePathStateBound >= result.certificate.statesVisited);
  assert.equal(result.certificate.pathsEmitted, BigInt(result.paths.length));
  assert.equal(result.certificate.workUnits, result.certificate.statesVisited + result.certificate.edgeTransitions);
  const baseParallelInput = graphInput();
  const parallelInput = { ...baseParallelInput, graph: { ...baseParallelInput.graph, edges: [...baseParallelInput.graph.edges, { id: "b-t-parallel", fromVertexId: "B", toVertexId: "T", mode: "transit" as const, duration: Rational.from(3), distanceMm: Rational.from(30) }] } };
  const parallelResult = enumerateLooplessRoutes(parallelInput);
  assert.equal(parallelResult.status, "complete");
  if (parallelResult.status === "complete") assert.equal(parallelResult.certificate.parallelEdgeFactor, BigInt(2));
  assert.throws(() => verifyEnumerationCertificate({ ...graphInput(), targetVertexIds: ["C"] }, result), /certificate/);
  assert.throws(() => enumerateLooplessRoutes({ ...graphInput(), policy: { ...graphInput().policy, workBudget: 1 as unknown as bigint } }), /workBudget/);
  const incomplete = enumerateLooplessRoutes(graphInput(BigInt(1)));
  assert.equal(incomplete.status, "incomplete");
  if (result.status === "complete") {
    assert.doesNotThrow(() => verifyEnumerationCertificate(graphInput(), result));
    const tamperedPath = { ...result, paths: [{ ...result.paths[0]!, duration: Rational.from(999) }, ...result.paths.slice(1)] };
    assert.throws(() => verifyEnumerationCertificate(graphInput(), tamperedPath), /duration/);
  }
});

test("enumeration rejects non-loopless graph input and has an honest unavailable result", () => {
  assert.throws(() => enumerateLooplessRoutes({
    ...graphInput(),
    graph: { ...graphInput().graph, edges: [{ ...graphInput().graph.edges[0]!, fromVertexId: "A", toVertexId: "A" }] },
  }), /looped/);
  const unavailable = unavailableRouteEnumeration("engine not available");
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.certificate, null);
});

function profile(participantId: string, values: readonly [number, number, number, number], participantIds: readonly string[]): TargetTimeProfile {
  const segments: AffineTimeSegment[] = [
    { edgeId: "edge", startParam: Rational.zero(), endParam: Rational.from("1/2"), startTime: Rational.from(values[0]), endTime: Rational.from(values[1]), occurrenceIndex: 0 },
    { edgeId: "edge", startParam: Rational.from("1/2"), endParam: Rational.one(), startTime: Rational.from(values[2]), endTime: Rational.from(values[3]), occurrenceIndex: 1 },
  ];
  return { participantId, participantIds: [...participantIds].sort(), snapshot: SNAPSHOT, edgeId: "edge", timingModel: "piecewise-linear", segments };
}

test("median, pair roots, equality intervals, and all-participant distinction remain exact", () => {
  assert.equal(rationalMedian([]).toString(), "0");
  assert.equal(rationalMedian([Rational.zero(), Rational.from(2)]).toString(), "1");
  const roots = pairExactMidpointRegion(profile("a", [0, 2, 2, 0], ["a", "b"]), profile("b", [1, 1, 1, 1], ["a", "b"]));
  assert.deepEqual(roots.points.map((point) => point.toString()), ["1/4", "3/4"]);
  const equalityInterval = pairExactMidpointRegion(profile("a", [3, 3, 3, 3], ["a", "b"]), profile("b", [3, 3, 3, 3], ["a", "b"]));
  assert.deepEqual(equalityInterval.intervals.map((interval) => [interval.start.toString(), interval.end.toString()]), [["0", "1"]]);
  const all = allParticipantExactRegion([
    profile("a", [0, 1, 1, 2], ["a", "b", "c", "d"]),
    profile("b", [0, 1, 1, 2], ["a", "b", "c", "d"]),
    profile("c", [2, 1, 1, 0], ["a", "b", "c", "d"]),
    profile("d", [0, 1, 1, 2], ["a", "b", "c", "d"]),
  ]);
  assert.deepEqual(all.points.map((point) => point.toString()), ["1/2"]);
  const tolerance = allParticipantToleranceRegion([
    profile("a", [100, 100, 100, 100], ["a", "b"]),
    profile("b", [90, 90, 90, 90], ["a", "b"]),
  ], 10);
  assert.deepEqual(tolerance.intervals.map((interval) => [interval.start.toString(), interval.end.toString()]), [["0", "1"]]);
  assert.equal(roots.scope.kind, "pair");
  assert.equal(all.scope.kind, "all-participants");
  assert.throws(() => allParticipantExactRegion([
    profile("a", [1, 1, 1, 1], ["a", "b", "c"]),
    profile("b", [1, 1, 1, 1], ["a", "b", "c"]),
  ]), /bijection/);
  assert.throws(() => pairExactMidpointRegion(
    profile("a", [1, 1, 1, 1], ["a", "b", "c"]),
    profile("b", [1, 1, 1, 1], ["a", "b", "c"]),
  ), /bijection/);
  const mismatchedProfile = { ...profile("b", [1, 1, 1, 1], ["a", "b"]), snapshot: { ...SNAPSHOT, manifestId: "other-manifest" } };
  assert.throws(() => pairExactMidpointRegion(profile("a", [1, 1, 1, 1], ["a", "b"]), mismatchedProfile), /snapshot/);
  const stationary = {
    ...profile("stationary-a", [2, 2, 2, 2], ["stationary-a", "stationary-b"]),
    stationaryOccurrences: [{ participantId: "stationary-a", edgeId: "edge", param: Rational.from("1/2"), startTime: Rational.from(2), endTime: Rational.from(3), occurrenceIndex: 8, kind: "dwell" as const }],
  };
  const stationaryRegion = pairExactMidpointRegion(stationary, profile("stationary-b", [2, 2, 2, 2], ["stationary-a", "stationary-b"]));
  assert.deepEqual(stationaryRegion.stationaryOccurrences.map((occurrence) => occurrence.participantId), ["stationary-a"]);
  assert.throws(() => allParticipantExactRegion([]), /At least (one|two)/);
  assert.throws(() => allParticipantExactRegion([profile("same", [1, 1, 1, 1], ["same", "other"]), profile("same", [1, 1, 1, 1], ["same", "other"])]), /distinct participant/);
  const badProfile = profile("bad", [1, 1, 1, 1], ["bad", "other"]);
  const shiftedProfile = { ...badProfile, segments: [{ ...badProfile.segments[0]!, startParam: Rational.from("1/4") }, badProfile.segments[1]!] };
  assert.throws(() => allParticipantExactRegion([shiftedProfile, profile("other", [1, 1, 1, 1], ["bad", "other"])]), /start at zero/);
  const discontinuousProfile = { ...badProfile, segments: [{ ...badProfile.segments[0]! }, { ...badProfile.segments[1]!, startTime: Rational.from(2) }] };
  assert.throws(() => allParticipantExactRegion([discontinuousProfile, profile("other-2", [1, 1, 1, 1], ["bad", "other-2"])]), /ordered/);
});

test("all-participant tolerance preserves full 3- and 4-participant scope across crossing cuts", () => {
  const three = allParticipantToleranceRegion([
    profile("a", [100, 100, 100, 100], ["a", "b", "c"]),
    profile("b", [100, 100, 100, 100], ["a", "b", "c"]),
    profile("c", [80, 100, 100, 120], ["a", "b", "c"]),
  ], 10);
  assert.deepEqual(three.intervals.map((interval) => [interval.start.toString(), interval.end.toString()]), [["1/4", "3/4"]]);
  assert.deepEqual(three.points.map((point) => point.toString()), []);
  assert.deepEqual(three.participantIds, ["a", "b", "c"]);
  assert.deepEqual(three.scope, { kind: "all-participants", participantIds: ["a", "b", "c"] });
  assert.deepEqual(three.snapshot, SNAPSHOT);

  const four = allParticipantToleranceRegion([
    profile("a", [100, 100, 100, 100], ["a", "b", "c", "d"]),
    profile("b", [100, 100, 100, 100], ["a", "b", "c", "d"]),
    profile("c", [100, 100, 100, 100], ["a", "b", "c", "d"]),
    profile("d", [80, 85, 85, 90], ["a", "b", "c", "d"]),
  ], 10);
  assert.deepEqual(four.intervals.map((interval) => [interval.start.toString(), interval.end.toString()]), []);
  assert.deepEqual(four.points.map((point) => point.toString()), ["1"]);
  assert.deepEqual(four.participantIds, ["a", "b", "c", "d"]);
  assert.deepEqual(four.scope, { kind: "all-participants", participantIds: ["a", "b", "c", "d"] });
  assert.deepEqual(four.snapshot, SNAPSHOT);
});

function topologyFixture(): MeetingTargetTopology {
  return {
    snapshot: SNAPSHOT,
    vertices: [
      { id: "v0", coordinate: C0, meetingEligible: true },
      { id: "v1", coordinate: C1, meetingEligible: true },
    ],
    edges: [{
      id: "edge",
      fromVertexId: "v0",
      toVertexId: "v1",
      start: C0,
      end: C1,
      accessClass: "pedestrian",
      meetingEligible: true,
      legalIntervals: [{ start: Rational.zero(), end: Rational.one() }],
    }],
  };
}

test("legal topology splits fair components at inaccessible gaps and preserves labels", () => {
  const topology = normalizeTargetTopology(topologyFixture());
  const components = constructFairEligibleComponents({
    topology,
    participantIds: ["a", "b"],
    accessibleIntervals: [
      { snapshot: SNAPSHOT, participantId: "a", edgeId: "edge", interval: { start: Rational.zero(), end: Rational.one() } },
      { snapshot: SNAPSHOT, participantId: "b", edgeId: "edge", interval: { start: Rational.zero(), end: Rational.one() } },
    ],
    accessibleVertices: [],
    fairRegions: [{ snapshot: SNAPSHOT, participantIds: ["a", "b"], scope: { kind: "all-participants", participantIds: ["a", "b"] }, edgeId: "edge", kind: "exact", tolerancePercent: Rational.zero(), intervals: [
      { start: Rational.zero(), end: Rational.from("1/4") },
      { start: Rational.from("3/4"), end: Rational.one() },
    ], points: [], stationaryOccurrences: [] }],
  });
  assert.deepEqual(components.map((component) => component.id), ["component:(16:(4:edge1:03:1/4)6:(2:v0))", "component:(16:(4:edge3:3/41:1)6:(2:v1))"]);
  const accessibleSplit = constructFairEligibleComponents({
    topology,
    participantIds: ["a", "b"],
    accessibleIntervals: [
      { snapshot: SNAPSHOT, participantId: "a", edgeId: "edge", interval: { start: Rational.zero(), end: Rational.from("1/2") } },
      { snapshot: SNAPSHOT, participantId: "b", edgeId: "edge", interval: { start: Rational.zero(), end: Rational.one() } },
    ],
    accessibleVertices: [],
    fairRegions: [{ snapshot: SNAPSHOT, participantIds: ["a", "b"], scope: { kind: "all-participants", participantIds: ["a", "b"] }, edgeId: "edge", kind: "exact", tolerancePercent: Rational.zero(), intervals: [{ start: Rational.zero(), end: Rational.one() }], points: [], stationaryOccurrences: [] }],
  });
  assert.deepEqual(accessibleSplit.map((component) => component.id), ["component:(16:(4:edge1:03:1/2)6:(2:v0))"]);
  const connectedTopology: MeetingTargetTopology = {
    ...topology,
    vertices: [...topology.vertices, { id: "v2", coordinate: projectedCoordinateMm(2_000, 0), meetingEligible: true }],
    edges: [...topology.edges, { id: "edge-2", fromVertexId: "v1", toVertexId: "v2", start: C1, end: projectedCoordinateMm(2_000, 0), accessClass: "pedestrian", meetingEligible: true, legalIntervals: [{ start: Rational.zero(), end: Rational.one() }] }],
  };
  const connected = constructFairEligibleComponents({
    topology: normalizeTargetTopology(connectedTopology),
    participantIds: ["a", "b"],
    fairRegions: [
      { snapshot: SNAPSHOT, participantIds: ["a", "b"], scope: { kind: "all-participants", participantIds: ["a", "b"] }, edgeId: "edge", kind: "exact", tolerancePercent: Rational.zero(), intervals: [{ start: Rational.zero(), end: Rational.one() }], points: [], stationaryOccurrences: [] },
      { snapshot: SNAPSHOT, participantIds: ["a", "b"], scope: { kind: "all-participants", participantIds: ["a", "b"] }, edgeId: "edge-2", kind: "exact", tolerancePercent: Rational.zero(), intervals: [{ start: Rational.zero(), end: Rational.one() }], points: [], stationaryOccurrences: [] },
    ],
    accessibleIntervals: [
      { snapshot: SNAPSHOT, participantId: "a", edgeId: "edge", interval: { start: Rational.zero(), end: Rational.one() } },
      { snapshot: SNAPSHOT, participantId: "b", edgeId: "edge", interval: { start: Rational.zero(), end: Rational.one() } },
      { snapshot: SNAPSHOT, participantId: "a", edgeId: "edge-2", interval: { start: Rational.zero(), end: Rational.one() } },
      { snapshot: SNAPSHOT, participantId: "b", edgeId: "edge-2", interval: { start: Rational.zero(), end: Rational.one() } },
    ],
    accessibleVertices: [],
  });
  assert.equal(connected.length, 1);
  assert.deepEqual(connected[0]?.vertexIds, ["v0", "v1", "v2"]);
  assert.equal(connected[0]?.edgeIntervals.length, 2);
  const fairVertexOnly = constructFairEligibleComponents({
    topology,
    participantIds: ["a", "b"],
    fairRegions: [],
    accessibleIntervals: [],
    accessibleVertices: [
      { snapshot: SNAPSHOT, participantId: "a", vertexId: "v0" },
      { snapshot: SNAPSHOT, participantId: "b", vertexId: "v0" },
    ],
    fairVertexEvidence: [{ snapshot: SNAPSHOT, participantIds: ["a", "b"], vertexId: "v0", scope: "all-participants" }],
  });
  assert.deepEqual(fairVertexOnly.map((component) => component.vertexIds), [["v0"]]);
  assert.deepEqual(fairVertexOnly[0]?.participantIds, ["a", "b"]);
  assert.throws(() => constructFairEligibleComponents({
    topology,
    participantIds: ["a", "b"],
    fairRegions: [],
    accessibleIntervals: [],
    accessibleVertices: [
      { snapshot: { ...SNAPSHOT, manifestId: "other" }, participantId: "a", vertexId: "v0" },
      { snapshot: SNAPSHOT, participantId: "b", vertexId: "v0" },
    ],
    fairVertexEvidence: [{ snapshot: SNAPSHOT, participantIds: ["a", "b"], vertexId: "v0", scope: "all-participants" }],
  }), /snapshot/);
  assert.throws(() => constructFairEligibleComponents({
    topology,
    participantIds: ["a", "b"],
    fairRegions: [{ snapshot: SNAPSHOT, participantIds: ["a", "b"], scope: { kind: "pair", participantIds: ["a", "b"] }, edgeId: "edge", kind: "exact", tolerancePercent: Rational.zero(), intervals: [{ start: Rational.zero(), end: Rational.one() }], points: [], stationaryOccurrences: [] }],
    accessibleIntervals: [
      { snapshot: SNAPSHOT, participantId: "a", edgeId: "edge", interval: { start: Rational.zero(), end: Rational.one() } },
      { snapshot: SNAPSHOT, participantId: "b", edgeId: "edge", interval: { start: Rational.zero(), end: Rational.one() } },
    ],
    accessibleVertices: [],
  }), /scope/);
  const ineligibleEndpointTopology = normalizeTargetTopology({
    ...topology,
    vertices: [{ ...topology.vertices[0]!, meetingEligible: false }, topology.vertices[1]!],
  });
  assert.deepEqual(constructFairEligibleComponents({
    topology: ineligibleEndpointTopology,
    participantIds: ["a", "b"],
    fairRegions: [{ snapshot: SNAPSHOT, participantIds: ["a", "b"], scope: { kind: "all-participants", participantIds: ["a", "b"] }, edgeId: "edge", kind: "exact", tolerancePercent: Rational.zero(), intervals: [{ start: Rational.zero(), end: Rational.one() }], points: [], stationaryOccurrences: [] }],
    accessibleIntervals: [
      { snapshot: SNAPSHOT, participantId: "a", edgeId: "edge", interval: { start: Rational.zero(), end: Rational.one() } },
      { snapshot: SNAPSHOT, participantId: "b", edgeId: "edge", interval: { start: Rational.zero(), end: Rational.one() } },
    ],
    accessibleVertices: [],
  }), []);
  assert.throws(() => constructFairEligibleComponents({ topology, participantIds: ["a", "b"], fairRegions: [], accessibleIntervals: [], accessibleVertices: [] }), /Accessibility is missing/);
  assert.throws(() => normalizeTargetTopology({ ...topology, edges: [{ ...topology.edges[0]!, meetingEligible: false }] }), /[Ii]neligible/);
  assert.throws(() => normalizeTargetTopology({ ...topology, edges: [{ ...topology.edges[0]!, accessClass: "vehicle-only", meetingEligible: true }] }), /meeting eligible/);
  const invalidJourney = journeyFixture();
  (invalidJourney.occurrences[1] as { tau: unknown }).tau = 2;
  assert.throws(() => normalizeRouteJourney(invalidJourney), /Rational/);
});

test("parallel target edges survive canonical topology normalization and family round-trip", () => {
  const topology = topologyFixture();
  const parallelTopology = normalizeTargetTopology({
    ...topology,
    edges: [...topology.edges, { ...topology.edges[0]!, id: "edge-parallel" }],
  });
  const fairRegions = ["edge", "edge-parallel"].map((edgeId) => ({
    snapshot: SNAPSHOT,
    participantIds: ["a", "b"],
    scope: { kind: "all-participants" as const, participantIds: ["a", "b"] },
    edgeId,
    kind: "exact" as const,
    tolerancePercent: Rational.zero(),
    intervals: [{ start: Rational.zero(), end: Rational.one() }],
    points: [],
    stationaryOccurrences: [],
  }));
  const accessibleIntervals = ["edge", "edge-parallel"].flatMap((edgeId) => [
    { snapshot: SNAPSHOT, participantId: "a", edgeId, interval: { start: Rational.zero(), end: Rational.one() } },
    { snapshot: SNAPSHOT, participantId: "b", edgeId, interval: { start: Rational.zero(), end: Rational.one() } },
  ]);
  const components = constructFairEligibleComponents({ topology: parallelTopology, participantIds: ["a", "b"], fairRegions, accessibleIntervals, accessibleVertices: [] });
  assert.equal(components.length, 1);
  assert.equal(components[0]?.edgeIntervals.length, 2);
  const reversed = { ...components[0]!, edgeIntervals: [...components[0]!.edgeIntervals].reverse() };
  assert.equal(canonicalRouteComponentKey(components[0]!), canonicalRouteComponentKey(reversed));
  const family = { snapshot: SNAPSHOT, contextKey: "ctx", skeletonKey: "skeleton", geometryKey: "geometry", eligibleComponents: components };
  assert.equal(compareMeaningfulRouteFamilies(family, { ...family, eligibleComponents: [reversed] }).equal, true);
});

test("meaningful family equality uses deterministic component multisets, not lossy clusters", () => {
  const left = {
    snapshot: SNAPSHOT,
    contextKey: "ctx", skeletonKey: "skeleton", geometryKey: "geometry",
    eligibleComponents: [
      { id: "left-a", snapshot: SNAPSHOT, participantIds: ["a", "b"], kind: "connected-component", edgeIntervals: [{ edgeId: "edge", interval: { start: Rational.zero(), end: Rational.from("1/2") } }], vertexIds: [], endpointCoordinates: [] },
      { id: "left-b", snapshot: SNAPSHOT, participantIds: ["a", "b"], kind: "connected-component", edgeIntervals: [{ edgeId: "edge", interval: { start: Rational.zero(), end: Rational.from("1/2") } }], vertexIds: [], endpointCoordinates: [] },
    ],
  } as const;
  const right = {
    snapshot: SNAPSHOT,
    contextKey: "ctx", skeletonKey: "skeleton", geometryKey: "geometry",
    eligibleComponents: [
      { id: "right-z", snapshot: SNAPSHOT, participantIds: ["a", "b"], kind: "connected-component", edgeIntervals: [{ edgeId: "edge", interval: { start: Rational.zero(), end: Rational.from("1/2") } }], vertexIds: [], endpointCoordinates: [] },
      { id: "right-a", snapshot: SNAPSHOT, participantIds: ["a", "b"], kind: "connected-component", edgeIntervals: [{ edgeId: "edge", interval: { start: Rational.zero(), end: Rational.from("1/2") } }], vertexIds: [], endpointCoordinates: [] },
    ],
  } as const;
  const equal = compareMeaningfulRouteFamilies(left, right);
  assert.equal(equal.equal, true);
  assert.equal(equal.matching.length, 2);
  const multiplicityMismatch = compareMeaningfulRouteFamilies(left, { ...right, eligibleComponents: [right.eligibleComponents[0]!] });
  assert.equal(multiplicityMismatch.reason, "component-multiset-mismatch");
  const mismatchedSnapshot = { ...right, eligibleComponents: [{ ...right.eligibleComponents[0]!, snapshot: { ...SNAPSHOT, manifestId: "other-manifest" } }, right.eligibleComponents[1]!] };
  assert.throws(() => compareMeaningfulRouteFamilies(left, mismatchedSnapshot), /mismatched snapshot/);
  assert.deepEqual(equal.diversityClusters, []);
});

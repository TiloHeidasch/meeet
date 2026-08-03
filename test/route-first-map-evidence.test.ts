import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRouteFirstClientCompleteResult,
  canonicalRouteFirstClientJourneyPathKey,
  ROUTE_FIRST_CLIENT_COORDINATE_REFERENCE,
  type RouteFirstClientCompleteResult,
  type RouteFirstClientCoordinate,
  type RouteFirstClientFamily,
  type RouteFirstClientJourney,
} from "../lib/domain/route-first/client-contract.ts";
import { canonicalRouteSnapshotKey } from "../lib/domain/route-first/enumeration.ts";
import { Rational } from "../lib/domain/route-first/rational.ts";
import { buildRouteFirstMapEvidence, type RouteFirstMapFamilySelection } from "../lib/client/route-first-map-evidence.ts";

const SNAPSHOT = { contractVersion: "route-first-map-test/v1", manifestId: "map-manifest", graphDigest: "map-graph", inputDigest: "map-input" };
const START = { xMm: "691603219", yMm: "5334752222" };
const TARGET = { xMm: "691604219", yMm: "5334752222" };
const FAIR_END = { xMm: "691604719", yMm: "5334752222" };
const DEPARTURE = "2026-08-03T10:00:00.000Z";

function coordinate(xMm: string, yMm: string): RouteFirstClientCoordinate { return { xMm, yMm }; }

function journey(id: string, participantId: "a" | "b", edgeId: string, start: RouteFirstClientCoordinate, end: RouteFirstClientCoordinate, multiSegment = false): RouteFirstClientJourney {
  const segmentId = `${id}-segment`;
  const middle = coordinate(Rational.from(start.xMm).add(Rational.from(end.xMm).subtract(Rational.from(start.xMm)).divide(2)).toString(), Rational.from(start.yMm).add(Rational.from(end.yMm).subtract(Rational.from(start.yMm)).divide(2)).toString());
  return {
    id,
    participantId,
    snapshot: SNAPSHOT,
    requestContext: { participantId, originVertexId: "origin", destinationVertexId: "target", departureContext: DEPARTURE, snapshot: SNAPSHOT },
    path: { vertexIds: ["origin", "target"], edgeIds: [edgeId] },
    timingModel: "piecewise-linear",
    occurrences: multiSegment ? [
      { occurrenceIndex: 0, coordinate: start, tau: "0", kind: "departure" },
      { occurrenceIndex: 1, coordinate: middle, tau: "5", kind: "vertex" },
      { occurrenceIndex: 2, coordinate: end, tau: "10", kind: "arrival" },
    ] : [
      { occurrenceIndex: 0, coordinate: start, tau: "0", kind: "departure" },
      { occurrenceIndex: 1, coordinate: end, tau: "10", kind: "arrival" },
    ],
    segments: multiSegment ? [
      { id: `${segmentId}-0`, fromOccurrenceIndex: 0, toOccurrenceIndex: 1, departureTau: "0", arrivalTau: "5", distanceMm: "500", mode: participantId === "a" ? "transit" : "bike", geometry: [start, middle], timingModel: "piecewise-linear" },
      { id: `${segmentId}-1`, fromOccurrenceIndex: 1, toOccurrenceIndex: 2, departureTau: "5", arrivalTau: "10", distanceMm: "500", mode: participantId === "a" ? "transit" : "bike", geometry: [middle, end], timingModel: "piecewise-linear" },
    ] : [{ id: segmentId, fromOccurrenceIndex: 0, toOccurrenceIndex: 1, departureTau: "0", arrivalTau: "10", distanceMm: "1000", mode: participantId === "a" ? "transit" : "bike", geometry: [start, end], timingModel: "piecewise-linear" }],
  };
}

function certificate(participantId: "a" | "b", pathsEmitted: string): RouteFirstClientCompleteResult["enumerations"][number]["certificate"] {
  const emitted = BigInt(pathsEmitted);
  return {
    complete: true,
    statesVisited: emitted.toString(),
    edgeTransitions: "0",
    pathsEmitted,
    maxSimplePathStateBound: emitted.toString(),
    workBudget: null,
    workUnits: emitted.toString(),
    parallelEdgeFactor: "1",
    graphFingerprint: "map-graph-fingerprint",
    policyFingerprint: `policy-${participantId}`,
    snapshotFingerprint: canonicalRouteSnapshotKey(SNAPSHOT),
    originVertexIds: ["origin"],
    targetVertexIds: ["target"],
  };
}

function corridor(journeyValue: RouteFirstClientJourney, alternateJourneyIds: readonly string[] = [], alternateJourney?: RouteFirstClientJourney): RouteFirstClientCompleteResult["corridors"][number] {
  const midpointTau = Rational.from("5");
  const midpointSegmentIndex = journeyValue.segments.findIndex((segment) => midpointTau.compare(Rational.from(segment.arrivalTau)) <= 0);
  const midpointSegment = journeyValue.segments[midpointSegmentIndex < 0 ? journeyValue.segments.length - 1 : midpointSegmentIndex]!;
  const midpointFrom = journeyValue.occurrences[midpointSegment.fromOccurrenceIndex]!.coordinate;
  const midpointTo = journeyValue.occurrences[midpointSegment.toOccurrenceIndex]!.coordinate;
  const midpointFraction = midpointTau.subtract(Rational.from(midpointSegment.departureTau)).divide(Rational.from(midpointSegment.arrivalTau).subtract(Rational.from(midpointSegment.departureTau)));
  const midpoint = coordinate(Rational.from(midpointFrom.xMm).add(Rational.from(midpointTo.xMm).subtract(Rational.from(midpointFrom.xMm)).multiply(midpointFraction)).toString(), Rational.from(midpointFrom.yMm).add(Rational.from(midpointTo.yMm).subtract(Rational.from(midpointFrom.yMm)).multiply(midpointFraction)).toString());
  const exact = { label: "exact-temporal-corridor" as const, startTau: "9/2", endTau: "11/2", tolerancePercent: "10" };
  const flatten = (value: RouteFirstClientJourney): readonly RouteFirstClientCoordinate[] => value.segments.flatMap((segment, index) => segment.geometry.filter((_point, pointIndex) => index === 0 || pointIndex > 0));
  return {
    participantId: journeyValue.participantId,
    journeyId: journeyValue.id,
    midpoint: { tau: "5", midpointTau: "5", pathDuration: "10", segmentId: midpointSegment.id, fraction: midpointFraction.toString(), coordinate: midpoint },
    exact,
    ambiguityEnvelope: alternateJourneyIds.length > 0 ? { label: "ambiguity-envelope", startTau: "9/2", endTau: "11/2", tolerancePercent: "10" } : null,
    constituentCorridors: [exact, ...(alternateJourneyIds.length > 0 ? [exact] : [])],
    directionalGeometry: flatten(journeyValue),
    envelopeGeometry: alternateJourney ? flatten(alternateJourney) : [],
    alternateJourneyIds,
  };
}

function component(zeroWidth = false) {
  return {
    id: "component-1",
    snapshot: SNAPSHOT,
    participantIds: ["a", "b"],
    kind: "connected-component" as const,
    edgeIntervals: [{ edgeId: "target-edge", interval: { start: zeroWidth ? "0" : "0", end: zeroWidth ? "0" : "1" } }],
    vertexIds: ["target"],
    endpointCoordinates: [TARGET],
  };
}

function family(pathKeys: readonly string[], index: number, nestedComponent: ReturnType<typeof component>): RouteFirstClientFamily {
  return { snapshot: SNAPSHOT, contextKey: `context-${index}`, skeletonKey: `skeleton-${index}`, geometryKey: `geometry-${index}`, participantIds: ["a", "b"], pathKeys, targetEdgeIds: ["target-edge"], eligibleComponents: [nestedComponent] };
}

function fixture(options: { readonly outside?: boolean; readonly alternate?: boolean; readonly unsafeFair?: boolean; readonly rational?: boolean; readonly multiSegment?: boolean; readonly zeroWidthComponent?: boolean } = {}): RouteFirstClientCompleteResult {
  const start = options.outside ? coordinate("0", "0") : START;
  const rationalStart = options.rational && !options.outside ? coordinate("1383206439/2", "5334752222") : start;
  const target = options.outside ? coordinate("1000", "0") : options.rational ? coordinate("1383208439/2", "5334752222") : TARGET;
  const fairEnd = options.unsafeFair ? coordinate("0", "0") : FAIR_END;
  const primary = journey("journey-a", "a", "edge-a", rationalStart, target, options.multiSegment);
  const bike = journey("journey-b", "b", "edge-b", rationalStart, target, options.multiSegment);
  const alternate = journey("journey-a-alt", "a", "edge-a-alt", rationalStart, coordinate("691605219", "5334752222"), options.multiSegment);
  const journeys = options.alternate ? [...([primary, alternate, bike])] : [primary, bike];
  const pathKeys = journeys.map(canonicalRouteFirstClientJourneyPathKey).sort();
  const nested = component(options.zeroWidthComponent);
  const regions = [{ edgeId: "target-edge", participantIds: ["a", "b"], snapshot: SNAPSHOT, scope: { kind: "all-participants" as const, participantIds: ["a", "b"] }, kind: "tolerance" as const, tolerancePercent: "10", intervals: [{ start: "0", end: "1" }], points: ["1/2"], geometry: { start: target, end: fairEnd } }];
  const alternateJourney = journeys.find((item) => item.id === "journey-a-alt");
  const corridors = journeys.map((item) => corridor(item, options.alternate && (item.id === "journey-a" || item.id === "journey-a-alt") ? [item.id === "journey-a" ? "journey-a-alt" : "journey-a"] : [], options.alternate && item.id === "journey-a" ? alternateJourney : options.alternate && item.id === "journey-a-alt" ? primary : undefined));
  const families = options.alternate ? [family(pathKeys, 0, nested)] : [family([canonicalRouteFirstClientJourneyPathKey(primary)], 0, nested), family([canonicalRouteFirstClientJourneyPathKey(bike)], 1, nested)];
  return {
    status: "complete",
    coordinateReference: { ...ROUTE_FIRST_CLIENT_COORDINATE_REFERENCE },
    provenance: {
      contractVersion: "route-first-meeting-service/v1",
      requestId: "map-request",
      departureContext: DEPARTURE,
      snapshot: SNAPSHOT,
      routingSnapshots: [{ source: "MVG", snapshot: SNAPSHOT }],
      calculationCompleteness: "complete",
      participantIds: ["a", "b"],
      participantModes: ["transit", "bike"],
      tolerancePercent: "10",
      requestFingerprint: "map-request-fingerprint",
      policyFingerprints: [
        { participantId: "a", policyFingerprint: "policy-a", snapshotFingerprint: canonicalRouteSnapshotKey(SNAPSHOT) },
        { participantId: "b", policyFingerprint: "policy-b", snapshotFingerprint: canonicalRouteSnapshotKey(SNAPSHOT) },
      ],
    },
    enumerations: [
      { participantId: "a", status: "complete", certificate: certificate("a", options.alternate ? "2" : "1") },
      { participantId: "b", status: "complete", certificate: certificate("b", "1") },
    ],
    journeys,
    corridors,
    fairRegion: regions[0]!,
    fairRegions: regions,
    components: [nested],
    families,
    landmarkEvaluation: { organicComponentCount: 1, minimumOrganicComponentDiversity: 2, evaluated: false, landmarkIds: [] },
    admittedLandmarks: [],
  };
}

function selection(familyValue: RouteFirstClientFamily, familyIndex: number): RouteFirstMapFamilySelection {
  return { familyIndex, contextKey: familyValue.contextKey, skeletonKey: familyValue.skeletonKey, geometryKey: familyValue.geometryKey };
}

test("projects exact EPSG:25832 integer millimetres to a Munich WGS84 control point", () => {
  const value = fixture({ rational: true });
  const result = assertRouteFirstClientCompleteResult(value);
  const evidence = buildRouteFirstMapEvidence(result, selection(result.families[0]!, 0));
  const route = evidence.lines.find((line) => line.source === "directional-route");
  assert.ok(route);
  assert.equal(evidence.sourceCoordinateReference.crs, "EPSG:25832");
  assert.equal(evidence.sourceCoordinateReference.unit, "millimetre");
  assert.ok(Math.abs(route.geometry.coordinates[0]![0] - 11.57549) < 0.0001);
  assert.ok(Math.abs(route.geometry.coordinates[0]![1] - 48.13715) < 0.0001);
});

test("requires the literal projected coordinate reference", () => {
  const invalid = { ...fixture(), coordinateReference: { crs: "EPSG:4326", unit: "degree" } };
  assert.throws(() => buildRouteFirstMapEvidence(invalid, selection(fixture().families[0]!, 0)));
});

test("rejects malformed or out-of-Munich geometry without emitting it", () => {
  const invalid = { ...fixture(), coordinateReference: { ...ROUTE_FIRST_CLIENT_COORDINATE_REFERENCE, unit: "metre" } };
  assert.throws(() => buildRouteFirstMapEvidence(invalid, selection(fixture().families[0]!, 0)));
  const outside = fixture({ outside: true });
  assert.throws(() => buildRouteFirstMapEvidence(outside, selection(outside.families[0]!, 0)));
});

test("rejects injected interior segment geometry", () => {
  const value = fixture();
  const journeyValue = value.journeys[0]!;
  const invalid = {
    ...value,
    journeys: value.journeys.map((journeyValue, index) => index === 0 ? { ...journeyValue, segments: journeyValue.segments.map((segment) => ({ ...segment, geometry: [segment.geometry[0]!, { xMm: "691603719", yMm: "5334752222" }, segment.geometry[1]!] })) } : journeyValue),
  };
  assert.equal(journeyValue.segments[0]!.geometry.length, 2);
  assert.throws(() => assertRouteFirstClientCompleteResult(invalid));
});

test("maps only the selected family paths and keeps alternate paths separate", () => {
  const partitioned = fixture();
  const selected = buildRouteFirstMapEvidence(partitioned, selection(partitioned.families[0]!, 0));
  assert.ok(selected.lines.every((line) => line.familyPathKey === partitioned.families[0]!.pathKeys[0] || line.source === "fair-region"));
  assert.equal(selected.selectedJourneys.length, 1);
  const alternates = fixture({ alternate: true });
  const alternateEvidence = buildRouteFirstMapEvidence(alternates, selection(alternates.families[0]!, 0));
  assert.equal(alternateEvidence.lines.filter((line) => line.source === "directional-route").length, 2);
  assert.equal(alternateEvidence.lines.filter((line) => line.source === "alternate-route").length, 1);
  assert.equal(new Set(alternateEvidence.lines.filter((line) => line.source !== "fair-region").map((line) => line.journeyId)).size, 6 / 2);
  assert.deepEqual(alternateEvidence.selectedJourneys.filter((journeyValue) => journeyValue.participantId === "a").map((journeyValue) => journeyValue.role).sort(), ["alternate", "primary"]);
});

test("uses clipped exact directional corridors rather than whole journey geometry", () => {
  const value = fixture();
  const evidence = buildRouteFirstMapEvidence(value, selection(value.families[0]!, 0));
  const route = evidence.lines.find((line) => line.source === "directional-route")!;
  const corridorLine = evidence.lines.find((line) => line.source === "corridor")!;
  assert.notDeepEqual(corridorLine.geometry.coordinates[0], route.geometry.coordinates[0]);
  assert.notDeepEqual(corridorLine.geometry.coordinates[1], route.geometry.coordinates[1]);
});

test("extracts rational exact corridors across multiple segments with interior occurrences", () => {
  const value = fixture({ multiSegment: true, rational: true });
  const evidence = buildRouteFirstMapEvidence(value, selection(value.families[0]!, 0));
  const corridorLine = evidence.lines.find((line) => line.source === "corridor");
  assert.ok(corridorLine);
  assert.equal(corridorLine.geometry.coordinates.length, 3);
});

test("fails closed when a selected journey loses its certified corridor", () => {
  const value = fixture();
  const missing = { ...value, corridors: value.corridors.slice(1) };
  assert.throws(() => buildRouteFirstMapEvidence(missing, selection(value.families[0]!, 0)));
});

test("ignores raw fair-region points and renders eligible zero-width components", () => {
  const value = fixture({ zeroWidthComponent: true });
  const evidence = buildRouteFirstMapEvidence(value, selection(value.families[0]!, 0));
  assert.equal(evidence.points.some((point) => point.source === "fair-region-point"), true);
  const isolatedRegion = { ...value.fairRegion, intervals: [], points: ["0"] };
  const isolated = { ...value, fairRegion: isolatedRegion, fairRegions: [isolatedRegion] };
  assert.equal(buildRouteFirstMapEvidence(isolated, selection(isolated.families[0]!, 0)).points.some((point) => point.source === "fair-region-point"), true);
  const noSelectedComponent = { ...isolated, components: isolated.components.map((component) => ({ ...component, edgeIntervals: [] })), families: isolated.families.map((family) => ({ ...family, eligibleComponents: family.eligibleComponents.map((component) => ({ ...component, edgeIntervals: [] })) })) };
  assert.equal(buildRouteFirstMapEvidence(noSelectedComponent, selection(noSelectedComponent.families[0]!, 0)).points.some((point) => point.source === "fair-region-point"), false);
  const unboundPoint = { ...value, fairRegion: { ...value.fairRegion, intervals: [], points: [] }, fairRegions: [{ ...value.fairRegions[0]!, intervals: [], points: [] }] };
  assert.equal(buildRouteFirstMapEvidence(unboundPoint, selection(unboundPoint.families[0]!, 0)).points.some((point) => point.source === "fair-region-point"), false);
});

test("omits unsafe fair geometry and never emits unbound landmark points", () => {
  const value = fixture({ unsafeFair: true });
  const evidence = buildRouteFirstMapEvidence(value, selection(value.families[0]!, 0));
  assert.equal(evidence.lines.some((line) => line.source === "fair-region"), false);
  assert.equal(evidence.points.some((point) => point.source === "fair-region-point"), false);
  assert.equal(evidence.points.some((point) => (point.source as string).includes("landmark")), false);
});

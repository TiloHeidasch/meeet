import {
  assertRouteFirstClientJobEnvelope,
  canonicalRouteFirstClientJourneyPathKey,
  type RouteFirstClientCompleteResult,
  type RouteFirstClientCoordinate,
  type RouteFirstClientCorridor,
  type RouteFirstClientEnumerationEvidence,
  type RouteFirstClientFamily,
  type RouteFirstClientJobEnvelope,
  type RouteFirstClientJobStatus,
  type RouteFirstClientJourney,
  type RouteFirstClientResult,
  type RouteFirstClientSnapshot,
} from "@/lib/domain/route-first/client-contract";
import { canonicalRouteSnapshotKey } from "@/lib/domain/route-first/enumeration";
import { Rational } from "@/lib/domain/route-first/rational";

export const ROUTE_FIRST_FIXTURE_JOB_ID = "R".repeat(43);
export const ROUTE_FIRST_FIXTURE_SNAPSHOT: RouteFirstClientSnapshot = {
  contractVersion: "route-first-browser-fixture/v1",
  manifestId: "route-first-browser-fixture",
  graphDigest: "route-first-browser-graph",
  inputDigest: "route-first-browser-input",
};

const PARTICIPANTS = ["participant-1", "participant-2"] as const;
const MODES = ["transit", "bike"] as const;
const C0: RouteFirstClientCoordinate = { xMm: "691000000", yMm: "5335000000" };
const CM: RouteFirstClientCoordinate = { xMm: "691500000", yMm: "5335000000" };
const C1: RouteFirstClientCoordinate = { xMm: "692000000", yMm: "5335000000" };

function coordinateAt(
  start: RouteFirstClientCoordinate,
  end: RouteFirstClientCoordinate,
  fraction: string,
): RouteFirstClientCoordinate {
  const t = Rational.from(fraction);
  return {
    xMm: Rational.from(start.xMm).add(Rational.from(end.xMm).subtract(Rational.from(start.xMm)).multiply(t)).toString(),
    yMm: Rational.from(start.yMm).add(Rational.from(end.yMm).subtract(Rational.from(start.yMm)).multiply(t)).toString(),
  };
}

function journeyFor(
  participantIndex: 0 | 1,
  variant: "direct" | "alternate",
): RouteFirstClientJourney {
  const participantId = PARTICIPANTS[participantIndex];
  const mode = MODES[participantIndex];
  const alternate = variant === "alternate";
  const coordinates = alternate ? [C0, CM, C1] : [C0, C1];
  const taus = alternate ? ["0", "4", "10"] : ["0", "10"];
  const vertices = alternate ? ["origin", "midpoint", "target"] : ["origin", "target"];
  const edgeIds = alternate
    ? [`${participantId}-first`, `${participantId}-last`]
    : [`${participantId}-direct`];
  const segmentModes = alternate ? ["walk" as const, mode] : [mode];
  const distances = alternate ? ["500000", "500000"] : ["1000000"];

  return {
    id: `${participantId}-${variant}-journey`,
    participantId,
    snapshot: ROUTE_FIRST_FIXTURE_SNAPSHOT,
    requestContext: {
      participantId,
      originVertexId: "origin",
      destinationVertexId: "target",
      departureContext: "2026-08-03T10:00:00.000Z",
      snapshot: ROUTE_FIRST_FIXTURE_SNAPSHOT,
    },
    path: { vertexIds: vertices, edgeIds },
    timingModel: "piecewise-linear",
    occurrences: coordinates.map((coordinate, index) => ({
      occurrenceIndex: index,
      coordinate,
      tau: taus[index]!,
      kind: index === 0 ? "departure" : index === coordinates.length - 1 ? "arrival" : "vertex",
    })),
    segments: coordinates.slice(0, -1).map((coordinate, index) => ({
      id: `${participantId}-${variant}-segment-${index}`,
      fromOccurrenceIndex: index,
      toOccurrenceIndex: index + 1,
      departureTau: taus[index]!,
      arrivalTau: taus[index + 1]!,
      distanceMm: distances[index]!,
      mode: segmentModes[index]!,
      geometry: [coordinate, coordinates[index + 1]!] as readonly RouteFirstClientCoordinate[],
      timingModel: "piecewise-linear" as const,
    })),
  };
}

function corridorFor(journey: RouteFirstClientJourney): RouteFirstClientCorridor {
  const segmentIndex = journey.segments.findIndex((segment) => Rational.from(segment.arrivalTau).compare("5") >= 0);
  const segment = journey.segments[segmentIndex]!;
  const segmentStart = Rational.from(segment.departureTau);
  const segmentEnd = Rational.from(segment.arrivalTau);
  const fraction = Rational.from("5").subtract(segmentStart).divide(segmentEnd.subtract(segmentStart));
  const from = journey.occurrences[segmentIndex]!.coordinate;
  const to = journey.occurrences[segmentIndex + 1]!.coordinate;
  const midpoint = coordinateAt(from, to, fraction.toString());
  const directionalGeometry = journey.segments.flatMap((item, index) => index === 0 ? [...item.geometry] : [item.geometry[1]!]);
  const exact = {
    label: "exact-temporal-corridor" as const,
    startTau: "9/2",
    endTau: "11/2",
    tolerancePercent: "10",
  };
  return {
    participantId: journey.participantId,
    journeyId: journey.id,
    midpoint: {
      tau: "5",
      midpointTau: "5",
      pathDuration: "10",
      segmentId: segment.id,
      fraction: fraction.toString(),
      coordinate: midpoint,
    },
    exact,
    ambiguityEnvelope: null,
    constituentCorridors: [exact],
    directionalGeometry,
    envelopeGeometry: [],
    alternateJourneyIds: [],
  };
}

function enumerationFor(participantId: string, policyFingerprint: string): RouteFirstClientEnumerationEvidence {
  const certificate = {
    complete: true,
    statesVisited: "2",
    edgeTransitions: "0",
    pathsEmitted: "2",
    maxSimplePathStateBound: "2",
    workBudget: null,
    workUnits: "2",
    parallelEdgeFactor: "1",
    graphFingerprint: "route-first-browser-graph-fingerprint",
    policyFingerprint,
    snapshotFingerprint: canonicalRouteSnapshotKey(ROUTE_FIRST_FIXTURE_SNAPSHOT),
    originVertexIds: ["origin"],
    targetVertexIds: ["target"],
  };
  return { participantId, status: "complete", certificate };
}

function familyFor(
  index: 0 | 1,
  journeys: readonly RouteFirstClientJourney[],
  component: RouteFirstClientCompleteResult["components"][number],
): RouteFirstClientFamily {
  const variant = index === 0 ? "direct" : "alternate";
  const pathKeys = journeys
    .filter((journey) => journey.id.endsWith(`${variant}-journey`))
    .map(canonicalRouteFirstClientJourneyPathKey)
    .sort();
  return {
    snapshot: ROUTE_FIRST_FIXTURE_SNAPSHOT,
    contextKey: `browser-family-${index + 1}-context`,
    skeletonKey: `browser-family-${index + 1}-skeleton`,
    geometryKey: `browser-family-${index + 1}-geometry`,
    participantIds: [...PARTICIPANTS],
    pathKeys,
    targetEdgeIds: ["target-edge"],
    eligibleComponents: [component],
  };
}

function completeResult(): RouteFirstClientCompleteResult {
  const journeys = [
    journeyFor(0, "direct"),
    journeyFor(0, "alternate"),
    journeyFor(1, "direct"),
    journeyFor(1, "alternate"),
  ];
  const fairRegion = {
    edgeId: "target-edge",
    participantIds: [...PARTICIPANTS],
    snapshot: ROUTE_FIRST_FIXTURE_SNAPSHOT,
    scope: { kind: "all-participants" as const, participantIds: [...PARTICIPANTS] },
    kind: "tolerance" as const,
    tolerancePercent: "10",
    intervals: [{ start: "0", end: "1" }],
    points: [],
    geometry: { start: C0, end: C1 },
  };
  const component = {
    id: "browser-component",
    snapshot: ROUTE_FIRST_FIXTURE_SNAPSHOT,
    participantIds: [...PARTICIPANTS],
    kind: "connected-component" as const,
    edgeIntervals: [{ edgeId: "target-edge", interval: { start: "0", end: "1" } }],
    vertexIds: ["origin", "target"],
    endpointCoordinates: [C0, C1],
  };
  const result: RouteFirstClientCompleteResult = {
    status: "complete",
    coordinateReference: { crs: "EPSG:25832", unit: "millimetre" },
    journeys,
    corridors: journeys.map(corridorFor),
    fairRegion,
    fairRegions: [fairRegion],
    components: [component],
    families: [familyFor(0, journeys, component), familyFor(1, journeys, component)],
    landmarkEvaluation: {
      organicComponentCount: 1,
      minimumOrganicComponentDiversity: 1,
      evaluated: false,
      landmarkIds: [],
    },
    admittedLandmarks: [],
    provenance: {
      contractVersion: "route-first-meeting-service/v1",
      requestId: "browser-route-first-request",
      departureContext: "2026-08-03T10:00:00.000Z",
      snapshot: ROUTE_FIRST_FIXTURE_SNAPSHOT,
      routingSnapshots: [{ source: "MVG", snapshot: ROUTE_FIRST_FIXTURE_SNAPSHOT }],
      calculationCompleteness: "complete",
      participantIds: [...PARTICIPANTS],
      participantModes: [...MODES],
      tolerancePercent: "10",
      requestFingerprint: "browser-route-first-request-fingerprint",
      policyFingerprints: PARTICIPANTS.map((participantId, index) => ({
        participantId,
        policyFingerprint: `browser-policy-${index + 1}`,
        snapshotFingerprint: canonicalRouteSnapshotKey(ROUTE_FIRST_FIXTURE_SNAPSHOT),
      })),
    },
    enumerations: [
      enumerationFor(PARTICIPANTS[0], "browser-policy-1"),
      enumerationFor(PARTICIPANTS[1], "browser-policy-2"),
    ],
  };
  assertRouteFirstClientJobEnvelope(envelopeFor("complete", result));
  return result;
}

export const ROUTE_FIRST_COMPLETE_RESULT = completeResult();

function nonCompleteResult(status: "incomplete" | "unavailable" | "failed"): RouteFirstClientResult {
  const provenance = {
    contractVersion: "route-first-meeting-service/v1" as const,
    requestId: "browser-route-first-request",
    departureContext: "2026-08-03T10:00:00.000Z",
    snapshot: ROUTE_FIRST_FIXTURE_SNAPSHOT,
    routingSnapshots: [{ source: "MVG" as const, snapshot: ROUTE_FIRST_FIXTURE_SNAPSHOT }],
    calculationCompleteness: status,
    participantIds: [...PARTICIPANTS],
    participantModes: [...MODES],
    tolerancePercent: "10",
    requestFingerprint: "browser-route-first-request-fingerprint",
    policyFingerprints: [],
  };
  if (status === "incomplete") return { status, provenance, enumerations: [], participantId: PARTICIPANTS[0], reason: "missing-coverage" };
  if (status === "unavailable") return { status, provenance, enumerations: [], participantId: PARTICIPANTS[0], reason: "Route-first calculation is unavailable." };
  return { status, provenance, enumerations: [], code: "service-error", message: "The route-first service failed." };
}

function noEligibleTargetResult(): RouteFirstClientResult {
  return {
    ...ROUTE_FIRST_COMPLETE_RESULT,
    status: "no-eligible-target",
    components: [],
    families: [],
  };
}

function envelopeFor(
  status: RouteFirstClientJobStatus,
  result?: RouteFirstClientResult,
): RouteFirstClientJobEnvelope {
  const envelope = {
    contractVersion: "route-first-job/v1" as const,
    jobId: ROUTE_FIRST_FIXTURE_JOB_ID,
    status,
    durable: false as const,
    runtimePersistence: "in-memory-process" as const,
    activation: "blocked-until-durable-provider" as const,
    expiresAt: 4_000_000_000_000,
    snapshot: ROUTE_FIRST_FIXTURE_SNAPSHOT,
    ...(result ? { result } : {}),
  };
  return assertRouteFirstClientJobEnvelope(envelope);
}

export function routeFirstFixtureEnvelope(status: RouteFirstClientJobStatus): RouteFirstClientJobEnvelope {
  if (status === "complete") return envelopeFor(status, ROUTE_FIRST_COMPLETE_RESULT);
  if (status === "incomplete" || status === "unavailable" || status === "failed") return envelopeFor(status, nonCompleteResult(status));
  if (status === "no-eligible-target") return envelopeFor(status, noEligibleTargetResult());
  return envelopeFor(status);
}

import assert from "node:assert/strict";
import test from "node:test";

import { calculateMeeting, MEETING_CALCULATION_DEADLINE_MS, MVG_ANCHOR_STATIONS, ProviderUnavailableError } from "../lib/domain/meeting.ts";
import { handleMeetingPost } from "../lib/domain/meeting-api.ts";
import type {
  CoordinateJourney,
  CoordinateJourneyRequest,
  MeetingCalculationResponse,
  LocationCoordinate,
} from "../lib/domain/types.ts";
import type { MeetingProviders } from "../lib/domain/providers.ts";
import { fixtureProviders } from "../lib/fixtures/providers.ts";
import { parseMeetingCalculationInput } from "../lib/validation/meeting.ts";
import { validateMeetingCalculationResponse } from "../lib/client/meeting-response.ts";
import { MVG_DIRECT_ROUTES_URL, MvgDirectRoutingProvider, parseMvgCoordinateJourneys } from "../lib/providers/mvg-direct.ts";
import type { FetchImplementation } from "../lib/providers/http.ts";
import {
  RIESSER_BUS_OVERLAP_MIXED_COORDINATE_ROUTES,
  RIESSER_COORDINATE_ROUTE,
  RIESSER_HBF_COORDINATE_ROUTE,
  RIESSER_MIXED_COORDINATE_ROUTES,
} from "./mvg-riesser-route-fixture.ts";
import { POST as calculatePost } from "../app/api/meeting/calculate/route.ts";
import * as calculateRoute from "../app/api/meeting/calculate/route.ts";

interface ExpectedSearchCoverage {
  method: string;
  exhaustive: false;
  evaluatedStationOccurrenceCount: number;
  discoveredLocalMinimumOccurrenceCount: number;
  termination: "local-minima-discovered" | "no-transit-station-targets";
  patterns: Array<{
    routePatternId: string;
    eligibleStationOccurrenceCount: number;
    startTransitStopIndex: number | null;
    evaluatedTransitStopIndexes: number[];
    discoveredLocalMinimumTransitStopIndexes: number[];
    termination: "local-minima-discovered" | "no-transit-station-targets";
  }>;
}

type ExpectedResponse = (MeetingCalculationResponse & {
  searchCoverage: ExpectedSearchCoverage;
  reason?: "no-transit-station-targets";
}) & { status: "ok" | "no-result" };

const NOW = new Date("2026-07-25T08:00:00.000Z");
const ARRIVAL = "2026-07-25T10:00:00.000Z";
const FIRST = { latitude: 48.1374, longitude: 11.5755 };
const SECOND = { latitude: 48.145, longitude: 11.58 };
const TARGET_COORDINATES: Record<string, LocationCoordinate> = {
  "origin-target": FIRST,
  a: { latitude: 48.1401, longitude: 11.5601 },
  b: { latitude: 48.1411, longitude: 11.5611 },
  c: { latitude: 48.1421, longitude: 11.5621 },
  d: { latitude: 48.1431, longitude: 11.5631 },
  e: { latitude: 48.1441, longitude: 11.5641 },
  fair: { latitude: 48.1451, longitude: 11.5651 },
};

test("canonical input still requires two transit participants and arrive-by time", () => {
  const participant = (id: string) => ({ id, mode: "transit", location: { ...FIRST, label: id } });
  assert.equal(parseMeetingCalculationInput({ participants: [participant("a"), participant("b")] }, NOW).success, false);
  assert.equal(parseMeetingCalculationInput({ participants: [participant("a"), participant("b")], arrivalAt: ARRIVAL, tolerancePercent: 10 }, NOW).success, true);
  assert.equal(parseMeetingCalculationInput({ participants: [participant("a"), { ...participant("b"), mode: "bike" }], arrivalAt: ARRIVAL, tolerancePercent: 10 }, NOW).success, false);
  assert.equal(parseMeetingCalculationInput({ participants: [participant("a"), participant("b"), participant("c")], arrivalAt: ARRIVAL, tolerancePercent: 10 }, NOW).success, false);
});

test("source discovery keeps the direct and six-anchor contract in both directions", async () => {
  const calls: CoordinateJourneyRequest[] = [];
  const provider = testProvider({ calls, targets: ["a", "b", "c"] });
  const result = await calculateMeeting(input(), provider);

  assert.ok(calls.length > 14);
  assert.deepEqual(calls.slice(0, 14).map((call) => call.viaStationGlobalId ?? "direct"), [
    "direct",
    ...MVG_ANCHOR_STATIONS.map((anchor) => anchor.id),
    "direct",
    ...MVG_ANCHOR_STATIONS.map((anchor) => anchor.id),
  ]);
  assert.ok(calls.slice(0, 14).every((call) => call.arrivalAt === ARRIVAL));
  assert.ok(calls.slice(1, 7).every((call) => call.viaDwellTimeInMinutes === 10));
  assert.equal(result.sourceQueries.length, 14);
  assert.equal(result.sourceQueries.filter((query) => query.direction === "participant-1-to-participant-2").length, 7);
  assert.equal(result.sourceQueries.filter((query) => query.direction === "participant-2-to-participant-1").length, 7);
});

test("only in-boundary transit stations become targets; origins and walking endpoints do not", async () => {
  const result = await calculateMeeting(input(), testProvider({ targets: ["a", "b", "c"] }));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.ok(result.fairLocations.length > 0);
  assert.ok(result.fairLocations.every((location) => location.kind === "station"));
  assert.ok(result.fairLocations.every((location) => location.physicalIdentity.startsWith("station:")));
  assert.ok(result.routePatterns.every((pattern) => pattern.transitStops.some((stop) => stop.stationGlobalId === "origin-station")));
  assert.equal(validateMeetingCalculationResponse(result).success, true);
});

test("a stable transit station at a participant origin remains an eligible target", async () => {
  const result = await calculateMeeting(input(), testProvider({ targets: ["origin-target"], includeOriginTarget: true, bothDirections: true }));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.ok(result.fairLocations.some((location) => location.physicalIdentity === "station:origin-target"));
  assert.equal(validateMeetingCalculationResponse(result).success, true);
});

test("selected verification Journey inspection data retains participant and Physical Transit Location detail for a Route-Derived Fair Location", async () => {
  const result = await calculateMeeting(input(), testProvider({ targets: ["a", "b"] }));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const location = result.fairLocations.find((candidate) => candidate.physicalIdentity === "station:b");
  assert.ok(location);
  const first = location!.journeys[0]!;
  const second = location!.journeys[1]!;
  assert.equal(first.participantId, "one");
  assert.equal(second.participantId, "two");
  assert.deepEqual(first.origin, { stationGlobalId: null, coordinate: FIRST });
  assert.deepEqual(second.origin, { stationGlobalId: null, coordinate: SECOND });
  assert.deepEqual(first.destination, { stationGlobalId: "b", coordinate: TARGET_COORDINATES.b });
  assert.deepEqual(second.destination, { stationGlobalId: "b", coordinate: TARGET_COORDINATES.b });
  assert.equal(first.parts.length, 3);
  assert.equal(second.parts.length, 3);
  assert.equal(first.parts[1]!.line?.identity, "verification-line");
  assert.equal(second.parts[1]!.line?.identity, "verification-line");
  assert.deepEqual(first.parts.at(-1)!.to.coordinate, TARGET_COORDINATES.b);
  assert.deepEqual(second.parts.at(-1)!.to.coordinate, TARGET_COORDINATES.b);
  assert.equal(first.plannedDurationMilliseconds, 600_000);
  assert.equal(second.plannedDurationMilliseconds, 600_000);
  assert.equal(first.source, "test-verification");
  assert.equal(second.source, "test-verification");
});

test("Route-Derived Fair Location ranking uses exact maximum Journey duration rather than rounded minutes", async () => {
  const result = await calculateMeeting(input(), testProvider({
    targets: ["a"],
    reverseTargets: ["b"],
    bothDirections: true,
    durations: {
      a: [600_000, 600_999],
      b: [600_000, 600_001],
    },
  }));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.fairLocations.map((location) => location.physicalIdentity), ["station:b", "station:a"]);
});

test("Route-Derived Fair Location ranking breaks exact Journey duration ties by Physical Transit Location identity", async () => {
  const result = await calculateMeeting(input(), testProvider({
    targets: ["b"],
    reverseTargets: ["a"],
    bothDirections: true,
    durations: {
      a: [600_000, 600_000],
      b: [600_000, 600_000],
    },
  }));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.fairLocations.map((location) => location.physicalIdentity), ["station:a", "station:b"]);
});

test("starts at the arithmetic middle and descends only in the source-guided direction", async () => {
  const durations = durationTable([100, 80, 30, 10, 40]);
  const result = await calculateMeeting(input(), testProvider({ targets: ["a", "b", "c", "d", "e"], durations })) as unknown as ExpectedResponse;
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const coverage = result.searchCoverage.patterns.find((entry) => entry.eligibleStationOccurrenceCount === 5)!;
  assert.equal(coverage.startTransitStopIndex, 3);
  assert.deepEqual(coverage.evaluatedTransitStopIndexes, [3, 4, 5]);
  assert.deepEqual(coverage.discoveredLocalMinimumTransitStopIndexes, [4]);
  assert.equal(result.fairLocations[0]!.physicalIdentity, "station:d");
});

test("a slower source participant directs descent backward", async () => {
  const durations = durationTable([10, 20, 100, 80, 90], true);
  const result = await calculateMeeting(input(), testProvider({ targets: ["a", "b", "c", "d", "e"], durations })) as unknown as ExpectedResponse;
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const coverage = result.searchCoverage.patterns.find((entry) => entry.eligibleStationOccurrenceCount === 5)!;
  assert.equal(coverage.startTransitStopIndex, 3);
  assert.deepEqual(coverage.evaluatedTransitStopIndexes, [3, 2, 1]);
  assert.deepEqual(coverage.discoveredLocalMinimumTransitStopIndexes, [1]);
});

test("when the preferred boundary rises, the opposite adjacent station can reveal the actual local minimum", async () => {
  const durations = durationTable([20, 10, 30, 40, 50]);
  const result = await calculateMeeting(input(), testProvider({ targets: ["a", "b", "c", "d", "e"], durations })) as unknown as ExpectedResponse;
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const coverage = result.searchCoverage.patterns.find((entry) => entry.eligibleStationOccurrenceCount === 5)!;
  assert.deepEqual(coverage.evaluatedTransitStopIndexes, [3, 4, 2, 1]);
  assert.deepEqual(coverage.discoveredLocalMinimumTransitStopIndexes, [2]);
  assert.equal(result.fairLocations[0]!.physicalIdentity, "station:b");
});

test("discovers an entire final equal-difference plateau without claiming the global minimum", async () => {
  const durations = durationTable([20, 20, 30, 30, 80]);
  const result = await calculateMeeting(input(), testProvider({ targets: ["a", "b", "c", "d", "e"], durations })) as unknown as ExpectedResponse;
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const coverage = result.searchCoverage.patterns.find((entry) => entry.eligibleStationOccurrenceCount === 5)!;
  assert.deepEqual(coverage.evaluatedTransitStopIndexes, [3, 4, 5, 2, 1]);
  assert.deepEqual(coverage.discoveredLocalMinimumTransitStopIndexes, [1, 2]);
  assert.equal(result.fairLocations.some((location) => location.physicalIdentity === "station:a"), true);
});

test("stationless source patterns return an explicit successful no-result", async () => {
  const result = await calculateMeeting(input(), testProvider({ targets: [] })) as unknown as ExpectedResponse;
  assert.equal(result.status, "no-result");
  if (result.status !== "no-result") return;
  assert.equal(result.reason, "no-transit-station-targets");
  assert.deepEqual(result.fairLocations, []);
  assert.equal(result.routePatterns.length > 0, true);
  assert.equal(result.searchCoverage.termination, "no-transit-station-targets");
  assert.equal(validateMeetingCalculationResponse(result).success, true);
});

test("tolerance escalation considers every discovered minimum before selecting a tolerance", async () => {
  const durations = {
    a: [600_000, 720_000],
    b: [600_000, 720_000],
    c: [600_000, 720_000],
    d: [600_000, 720_000],
    e: [3_000_000, 3_120_000],
  } as const;
  const result = await calculateMeeting({ ...input(), tolerancePercent: 5 }, testProvider({ targets: ["a", "b", "c", "d", "e"], durations })) as unknown as ExpectedResponse;
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.requestSnapshot.effectiveTolerancePercent, 5);
  assert.deepEqual(result.fairLocations.map((location) => location.physicalIdentity), ["station:e"]);
  assert.equal(result.searchCoverage.discoveredLocalMinimumOccurrenceCount, 5);
});

test("exact participant-coordinate memoization is reused and budget failure is operational, never partial", async () => {
  let calls = 0;
  const provider = testProvider({ targets: ["a", "b", "a"], calls: undefined, onCall: () => { calls += 1; } });
  const result = await calculateMeeting({ ...input(), participants: [participant("one", FIRST), participant("two", FIRST)] }, provider);
  assert.equal(result.status, "ok");
  assert.equal(calls, 18); // fourteen source calls plus two exact coordinates per participant

  await assert.rejects(
    calculateMeeting(input(), testProvider({ targets: ["a", "b", "c"] }), undefined, { maxCandidateVerificationRequests: 1 }),
    ProviderUnavailableError,
  );
});

test("structural de-duplication is directional and retains direct/anchor provenance", async () => {
  const result = await calculateMeeting(input(), testProvider({ targets: ["a", "b"], bothDirections: true }));
  assert.equal(result.routePatterns.length, 2);
  assert.equal(new Set(result.routePatterns.map((pattern) => pattern.provenance[0]!.direction)).size, 2);
  assert.ok(result.routePatterns.every((pattern) => new Set(pattern.provenance.map((entry) => entry.searchKind)).size === 2));
  assert.ok(result.routePatterns.every((pattern) => pattern.provenance.length === 7));
  assert.ok(result.routePatterns.every((pattern) => pattern.transitStops.map((stop) => stop.stationGlobalId).includes("a")));
});

test("pattern searches use bounded concurrency and retain deterministic route-pattern coverage order", async () => {
  let activeVerificationCalls = 0;
  let maxActiveVerificationCalls = 0;
  const result = await calculateMeeting(input(), testProvider({
    targets: ["a", "b", "c", "d", "e"],
    reverseTargets: ["fair", "d", "e"],
    bothDirections: true,
    verificationDelayMs: 20,
    onVerification: () => {
      activeVerificationCalls += 1;
      maxActiveVerificationCalls = Math.max(maxActiveVerificationCalls, activeVerificationCalls);
      return () => { activeVerificationCalls -= 1; };
    },
  }));
  assert.equal(result.status, "ok");
  assert.equal(maxActiveVerificationCalls, 4);
  assert.ok(maxActiveVerificationCalls <= 4);
  assert.deepEqual(result.searchCoverage.patterns.map((entry) => entry.routePatternId), result.routePatterns.map((pattern) => pattern.id));
});

test("the calculation route exports the full sampled-search runtime budget", () => {
  assert.equal(MEETING_CALCULATION_DEADLINE_MS, 90_000);
  assert.equal((calculateRoute as unknown as { maxDuration?: number }).maxDuration, 90);
});

test("coverage validates raw indexes across a collapsed transfer-boundary duplicate", async () => {
  const result = await calculateMeeting(input(), testProvider({ targets: ["a", "b"], durations: durationTable([30, 10]), duplicateHandoff: true }));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const coverage = result.searchCoverage.patterns.find((entry) => entry.eligibleStationOccurrenceCount === 2)!;
  assert.deepEqual(coverage.evaluatedTransitStopIndexes, [1, 3]);
  assert.equal(validateMeetingCalculationResponse(result).success, true);
});

test("v2 client validation accepts ok and no-result coverage and rejects coverage or legacy tampering", async () => {
  const ok = await calculateMeeting(input(), testProvider({ targets: ["a", "b", "c"] })) as unknown as ExpectedResponse;
  assert.equal(validateMeetingCalculationResponse(ok).success, true);
  const coverageTampered = clone(ok) as unknown as ExpectedResponse;
  if (coverageTampered.status === "ok") coverageTampered.searchCoverage.patterns[0]!.evaluatedTransitStopIndexes.push(999);
  assert.equal(validateMeetingCalculationResponse(coverageTampered).success, false);
  const oldField = clone(ok) as unknown as Record<string, unknown>;
  oldField.area = {};
  assert.equal(validateMeetingCalculationResponse(oldField).success, false);

  const noResult = await calculateMeeting(input(), testProvider({ targets: [] })) as unknown as ExpectedResponse;
  assert.equal(validateMeetingCalculationResponse(noResult).success, true);
  const noResultTampered = clone(noResult) as unknown as Record<string, unknown>;
  noResultTampered.reason = "provider-failure";
  assert.equal(validateMeetingCalculationResponse(noResultTampered).success, false);
});

test("client validation binds no-result status to no-transit-station coverage", async () => {
  const ok = await calculateMeeting(input(), testProvider({ targets: ["a", "b", "c"] })) as unknown as ExpectedResponse;
  const relabeled = clone(ok) as unknown as Record<string, unknown>;
  relabeled.status = "no-result";
  relabeled.reason = "no-transit-station-targets";
  relabeled.fairLocations = [];
  assert.equal(validateMeetingCalculationResponse(relabeled).success, false);
});

test("client validation binds every route-pattern transit stop to its exact part coordinate", async () => {
  const result = await calculateMeeting(input(), testProvider({ targets: ["a", "b", "c"] })) as unknown as ExpectedResponse;
  const tampered = clone(result) as unknown as {
    routePatterns: Array<{ transitStops: Array<{ coordinate: { latitude: number; longitude: number } }> }>;
  };
  tampered.routePatterns[0]!.transitStops[0]!.coordinate = { latitude: 47.1, longitude: 10.2 };
  assert.equal(validateMeetingCalculationResponse(tampered).success, false);
});

test("client validation requires every fair-location source pattern to support its discovered minimum", async () => {
  const result = await calculateMeeting(input(), testProvider({
    targets: ["a", "b", "c"],
    reverseTargets: ["fair", "d", "e"],
    bothDirections: true,
  })) as unknown as ExpectedResponse;
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const tampered = clone(result) as unknown as {
    fairLocations: Array<{ sourceRoutePatternIds: string[] }>;
    routePatterns: Array<{ id: string }>;
  };
  const firstLocation = tampered.fairLocations[0]!;
  const unrelatedPattern = tampered.routePatterns.find((pattern) => !firstLocation.sourceRoutePatternIds.includes(pattern.id));
  assert.ok(unrelatedPattern);
  firstLocation.sourceRoutePatternIds.push(unrelatedPattern!.id);
  assert.equal(validateMeetingCalculationResponse(tampered).success, false);
});

test("merged stable stations validate when a source pattern uses a different platform coordinate", async () => {
  const result = await calculateMeeting(input(), testProvider({
    targets: ["a", "b", "c"],
    reverseTargets: ["a", "b", "c"],
    bothDirections: true,
  })) as unknown as ExpectedResponse;
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const tampered = clone(result) as unknown as {
    fairLocations: Array<{ physicalIdentity: string; coordinate: { latitude: number; longitude: number }; sourceRoutePatternIds: string[] }>;
    routePatterns: Array<{ id: string; transitStops: Array<{ stationGlobalId: string; coordinate: { latitude: number; longitude: number } }>; parts: Array<Record<string, unknown>> }>;
    searchCoverage: { patterns: Array<{ routePatternId: string; discoveredLocalMinimumTransitStopIndexes: number[] }> };
  };
  const location = tampered.fairLocations.find((entry) => entry.physicalIdentity === "station:a")!;
  assert.equal(location.sourceRoutePatternIds.length, 2);
  const shiftedPattern = tampered.routePatterns.find((pattern) => pattern.id === location.sourceRoutePatternIds[1])!;
  const shiftedCoverage = tampered.searchCoverage.patterns.find((entry) => entry.routePatternId === shiftedPattern.id)!;
  const stationIndex = shiftedCoverage.discoveredLocalMinimumTransitStopIndexes.find((index) => shiftedPattern.transitStops[index]!.stationGlobalId === "a")!;
  const shiftedCoordinate = { latitude: location.coordinate.latitude + 0.002, longitude: location.coordinate.longitude + 0.002 };
  shiftedPattern.transitStops[stationIndex]!.coordinate = shiftedCoordinate;
  for (const part of shiftedPattern.parts) {
    for (const endpointKey of ["from", "to"]) {
      const endpoint = part[endpointKey];
      if (endpoint && typeof endpoint === "object" && "stationGlobalId" in endpoint && (endpoint as { stationGlobalId?: unknown }).stationGlobalId === "a") {
        (endpoint as unknown as { coordinate: { latitude: number; longitude: number } }).coordinate = shiftedCoordinate;
      }
    }
    const intermediateStops = part.intermediateStops;
    if (Array.isArray(intermediateStops)) for (const endpoint of intermediateStops) {
      if (endpoint && typeof endpoint === "object" && "stationGlobalId" in endpoint && (endpoint as { stationGlobalId?: unknown }).stationGlobalId === "a") {
        (endpoint as unknown as { coordinate: { latitude: number; longitude: number } }).coordinate = shiftedCoordinate;
      }
    }
  }
  assert.equal(validateMeetingCalculationResponse(tampered).success, true);
});

test("client validation still rejects invented fair coordinates and unknown source pattern ids", async () => {
  const result = await calculateMeeting(input(), testProvider({ targets: ["a", "b", "c"] })) as unknown as ExpectedResponse;
  const inventedCoordinate = clone(result) as unknown as { fairLocations: Array<{ coordinate: { latitude: number; longitude: number } }> };
  inventedCoordinate.fairLocations[0]!.coordinate = { latitude: 48.19, longitude: 11.69 };
  assert.equal(validateMeetingCalculationResponse(inventedCoordinate).success, false);
  const unknownSource = clone(result) as unknown as { fairLocations: Array<{ sourceRoutePatternIds: string[] }> };
  unknownSource.fairLocations[0]!.sourceRoutePatternIds = ["unknown-pattern"];
  assert.equal(validateMeetingCalculationResponse(unknownSource).success, false);
});

test("calculation API exposes v2 coverage and rejects legacy fields", async () => {
  const response = await handleMeetingPost(jsonRequest({
    participants: [participant("one", FIRST), participant("two", SECOND)],
    arrivalAt: new Date(Date.now() + 3_600_000).toISOString(),
    tolerancePercent: 10,
  }), fixtureProviders);
  assert.equal(response.status, 200);
  const payload = await response.json() as Record<string, unknown>;
  assert.equal(payload.contractVersion, "meeet-meeting/v2");
  assert.equal(typeof payload.searchCoverage, "object");
  assert.equal(Object.hasOwn(payload, "corridor"), false);
  assert.equal(Object.hasOwn(payload, "pois"), false);
});

test("MVG coordinate provider keeps the fixed arrive-by contract and walking parts", async () => {
  const seen: URL[] = [];
  const fetchImplementation: FetchImplementation = async (input) => {
    const url = new URL(String(input));
    seen.push(url);
    return Response.json([rawMvgJourney()]);
  };
  const provider = new MvgDirectRoutingProvider(fetchImplementation);
  const response = await provider.getCoordinateJourneys({ origin: FIRST, destination: SECOND, arrivalAt: ARRIVAL, viaStationGlobalId: MVG_ANCHOR_STATIONS[0].id, viaDwellTimeInMinutes: 10 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.pathname, new URL(MVG_DIRECT_ROUTES_URL).pathname);
  assert.equal(seen[0]!.searchParams.get("routingDateTime"), ARRIVAL);
  assert.equal(seen[0]!.searchParams.get("routingDateTimeIsArrival"), "true");
  assert.equal(seen[0]!.searchParams.get("transportTypes"), "SCHIFF,UBAHN,TRAM,SBAHN,BUS,REGIONAL_BUS,BAHN");
  assert.equal(seen[0]!.searchParams.get("routeType"), "LEAST_TIME");
  assert.equal(seen[0]!.searchParams.get("viaDwellTimeInMinutes"), "10");
  assert.equal(response.journeys[0]!.parts[0]!.kind, "walking");
  assert.equal(response.journeys[0]!.parts.at(-1)!.kind, "walking");
});

test("MVG parser preserves safe station ordering and rejects malformed or disconnected routes", () => {
  const request = { origin: { latitude: 48.1142399, longitude: 11.5151298 }, destination: { latitude: 48.104635, longitude: 11.5616351 }, arrivalAt: "2026-08-09T14:59:00.000Z" };
  const journeys = parseMvgCoordinateJourneys(RIESSER_MIXED_COORDINATE_ROUTES, request);
  assert.equal(journeys.length, 4);
  assert.ok(journeys.every((journey) => Date.parse(journey.plannedArrivalAt) <= Date.parse(request.arrivalAt)));
  const malformed = JSON.parse(JSON.stringify(RIESSER_COORDINATE_ROUTE)) as { parts: Array<{ from: Record<string, unknown> }> };
  malformed.parts[1]!.from.stationGlobalId = "  ";
  assert.throws(() => parseMvgCoordinateJourneys([malformed], request), /invalid station identity/);
  const disconnected = JSON.parse(JSON.stringify(RIESSER_COORDINATE_ROUTE)) as { parts: Array<{ from: Record<string, unknown> }> };
  disconnected.parts[1]!.from.latitude = 48.12;
  disconnected.parts[1]!.from.stationGlobalId = "de:09162:other-station";
  assert.throws(() => parseMvgCoordinateJourneys([disconnected], request), /continuous/);
});

test("MVG normalizes blank outer walking identities but rejects blank transit identities", () => {
  const request = { origin: { latitude: 48.1142399, longitude: 11.5151298 }, destination: { latitude: 48.104635, longitude: 11.5616351 }, arrivalAt: "2026-08-09T14:59:00.000Z" };
  const route = cloneRoute(RIESSER_COORDINATE_ROUTE);
  route.parts[0]!.from.stationGlobalId = "   ";
  route.parts.at(-1)!.to!.stationGlobalId = "\t";
  const parsed = parseMvgCoordinateJourneys([route], request)[0]!;
  assert.equal(parsed.parts[0]!.from.stationGlobalId, null);
  assert.equal(parsed.parts.at(-1)!.to.stationGlobalId, null);

  const transitBlank = cloneRoute(RIESSER_COORDINATE_ROUTE);
  transitBlank.parts[1]!.from.stationGlobalId = " ";
  assert.throws(() => parseMvgCoordinateJourneys([transitBlank], request), /invalid station identity/);
});

test("MVG accepts exactly one minute walking-transit overlap and rejects larger or transit overlap", () => {
  const request = { origin: { latitude: 48.1142399, longitude: 11.5151298 }, destination: { latitude: 48.104635, longitude: 11.5616351 }, arrivalAt: "2026-08-09T14:59:00.000Z" };
  const accepted = parseMvgCoordinateJourneys([RIESSER_COORDINATE_ROUTE], request)[0]!;
  assert.equal(accepted.parts[1]!.plannedDepartureAt, "2026-08-09T14:45:00.000Z");

  const larger = cloneRoute(RIESSER_COORDINATE_ROUTE);
  larger.parts[1]!.from.plannedDeparture = "2026-08-09T14:43:00.000Z";
  assert.throws(() => parseMvgCoordinateJourneys([larger], request), /no temporally feasible/);

  const transitOverlap = cloneRoute(RIESSER_HBF_COORDINATE_ROUTE);
  transitOverlap.parts[2]!.from.plannedDeparture = "2026-08-09T14:39:00.000Z";
  assert.throws(() => parseMvgCoordinateJourneys([transitOverlap], request), /no temporally feasible/);
});

test("MVG binds anonymous outer walking endpoints exactly and retains the one-metre guard", () => {
  const request = { origin: { latitude: 48.1142399, longitude: 11.5151298 }, destination: { latitude: 48.104635, longitude: 11.5616351 }, arrivalAt: "2026-08-09T14:59:00.000Z" };
  const parsed = parseMvgCoordinateJourneys([RIESSER_COORDINATE_ROUTE], request)[0]!;
  assert.deepEqual(parsed.parts[0]!.from.coordinate, request.origin);
  assert.deepEqual(parsed.parts.at(-1)!.to.coordinate, request.destination);

  const identifiedOuter = cloneRoute(RIESSER_COORDINATE_ROUTE);
  identifiedOuter.parts[0]!.from.stationGlobalId = "de:09162:anonymous-origin";
  assert.throws(() => parseMvgCoordinateJourneys([identifiedOuter], request), /not bound/);
});

test("MVG stable station identity preserves continuity across platform coordinate shifts", () => {
  const request = { origin: { latitude: 48.1142399, longitude: 11.5151298 }, destination: { latitude: 48.104635, longitude: 11.5616351 }, arrivalAt: "2026-08-09T14:59:00.000Z" };
  const journey = parseMvgCoordinateJourneys([RIESSER_HBF_COORDINATE_ROUTE], request)[0]!;
  assert.equal(journey.parts[1]!.to.stationGlobalId, journey.parts[2]!.from.stationGlobalId);
  assert.notDeepEqual(journey.parts[1]!.to.coordinate, journey.parts[2]!.from.coordinate);
});

test("MVG filters individually infeasible alternatives but fails malformed response rows", () => {
  const request = { origin: { latitude: 48.1142399, longitude: 11.5151298 }, destination: { latitude: 48.104635, longitude: 11.5616351 }, arrivalAt: "2026-08-09T14:59:00.000Z" };
  assert.equal(parseMvgCoordinateJourneys(RIESSER_BUS_OVERLAP_MIXED_COORDINATE_ROUTES, request).length, 4);

  const malformedShape = cloneRoute(RIESSER_COORDINATE_ROUTE);
  delete malformedShape.parts[1]!.to;
  assert.throws(() => parseMvgCoordinateJourneys([...RIESSER_MIXED_COORDINATE_ROUTES.slice(0, 1), malformedShape], request));
  const malformedCoordinate = cloneRoute(RIESSER_COORDINATE_ROUTE);
  malformedCoordinate.parts[1]!.from.latitude = "not-a-coordinate";
  assert.throws(() => parseMvgCoordinateJourneys([...RIESSER_MIXED_COORDINATE_ROUTES.slice(0, 1), malformedCoordinate], request));
  const malformedIdentity = cloneRoute(RIESSER_COORDINATE_ROUTE);
  malformedIdentity.parts[1]!.from.stationGlobalId = "  ";
  assert.throws(() => parseMvgCoordinateJourneys([...RIESSER_MIXED_COORDINATE_ROUTES.slice(0, 1), malformedIdentity], request), /invalid station identity/);
});

test("domain continuity accepts stable platform shifts but rejects displaced differing or missing identities", async () => {
  const accepted = await calculateMeeting(input(), testProvider({ targets: ["a", "b"], duplicateHandoff: true, sourceMutation: "stable-platform-shift" }));
  assert.equal(accepted.status, "ok");
  await assert.rejects(calculateMeeting(input(), testProvider({ targets: ["a", "b"], duplicateHandoff: true, sourceMutation: "different-platform" })), ProviderUnavailableError);
  await assert.rejects(calculateMeeting(input(), testProvider({ targets: ["a", "b"], duplicateHandoff: true, sourceMutation: "missing-platform" })), ProviderUnavailableError);
});

test("MVG preserves repeated loop occurrences and precise station handoffs", () => {
  const first = { latitude: 48.14, longitude: 11.56 };
  const second = { latitude: 48.141, longitude: 11.561 };
  const loop = { latitude: 48.142, longitude: 11.562 };
  const payload = [{ parts: [
    rawPart("", "s1", FIRST, first, "FUSS", "2026-07-25T09:00:00.000Z", "2026-07-25T09:01:00.000Z"),
    { ...rawPart("s1", "s2", first, second, "BUS", "2026-07-25T09:01:00.000Z", "2026-07-25T09:03:00.000Z"), intermediateStops: [{ stationGlobalId: "loop", ...loop }, { stationGlobalId: "s1", ...first }] },
    rawPart("s2", "s1", second, first, "TRAM", "2026-07-25T09:03:00.000Z", "2026-07-25T09:05:00.000Z"),
    rawPart("s1", "", first, SECOND, "FUSS", "2026-07-25T09:05:00.000Z", "2026-07-25T09:10:00.000Z"),
  ] }];
  const journey = parseMvgCoordinateJourneys(payload, { origin: FIRST, destination: SECOND, arrivalAt: ARRIVAL })[0]!;
  assert.deepEqual(journey.parts.find((part) => part.kind === "transit")!.intermediateStops.map((stop) => stop.stationGlobalId), ["loop", "s1"]);
  assert.deepEqual(journey.transitStops.map((stop) => stop.stationGlobalId), ["s1", "loop", "s1", "s2", "s2", "s1"]);
});

test("the exported API accepts the sanitized Rießerseestraße fixture response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => Response.json(adaptRiesserRoute(new URL(String(input))))) as typeof fetch;
  try {
    const response = await calculatePost(new Request("http://localhost/api/meeting/calculate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participants: [
          { id: "riesser", mode: "transit", location: { label: "Rießerseestraße 2", latitude: 48.1142399, longitude: 11.5151298 } },
          { id: "schoen", mode: "transit", location: { label: "Schönstraße 80a", latitude: 48.104635, longitude: 11.5616351 } },
        ],
        arrivalAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        tolerancePercent: 10,
      }),
    }));
    assert.equal(response.status, 200);
    const body = await response.json() as { contractVersion?: string; status?: string };
    assert.equal(body.contractVersion, "meeet-meeting/v2");
    assert.ok(body.status === "ok" || body.status === "no-result");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function input() {
  return {
    participants: [participant("one", FIRST), participant("two", SECOND)] as [ReturnType<typeof participant>, ReturnType<typeof participant>],
    arrivalAt: ARRIVAL,
    tolerancePercent: 10 as const,
  };
}

function participant(id: string, coordinate: LocationCoordinate) {
  return { id, mode: "transit" as const, location: { ...coordinate, label: id } };
}

interface ProviderOptions {
  targets: readonly string[];
  durations?: Record<string, readonly [number, number]>;
  bothDirections?: boolean;
  includeOriginTarget?: boolean;
  duplicateHandoff?: boolean;
  sourceMutation?: "stable-platform-shift" | "different-platform" | "missing-platform";
  reverseTargets?: readonly string[];
  verificationDelayMs?: number;
  onVerification?: () => (() => void) | void;
  calls?: CoordinateJourneyRequest[];
  onCall?: () => void;
}

function testProvider(options: ProviderOptions): MeetingProviders {
  const calls = options.calls;
  return {
    ...fixtureProviders,
    journey: {
      descriptor: fixtureProviders.routing.descriptor,
      async getCoordinateJourneys(request: CoordinateJourneyRequest) {
        calls?.push(request);
        options.onCall?.();
        const isParticipantOrigin = request.destination.latitude === FIRST.latitude || request.destination.latitude === SECOND.latitude;
        const isOriginTargetVerification = options.includeOriginTarget === true && request.origin.latitude === FIRST.latitude && targetForCoordinate(request.destination) === "origin-target";
        if (!request.viaStationGlobalId && (!isParticipantOrigin || isOriginTargetVerification)) {
          const releaseVerification = options.onVerification?.();
          if (options.verificationDelayMs) await new Promise((resolve) => setTimeout(resolve, options.verificationDelayMs));
          const target = targetForCoordinate(request.destination);
          const index = options.targets.indexOf(target);
          const pair = options.durations?.[target] ?? [600_000, 600_000];
          const participantIndex = request.origin.latitude === FIRST.latitude ? 0 : 1;
          const duration = pair[participantIndex];
          releaseVerification?.();
          return { journeys: [verificationJourney(request, target, duration)], source: "test-verification" };
        }
        if (isParticipantOrigin && !options.bothDirections && request.origin.latitude === SECOND.latitude) return { journeys: [], source: "test-source" };
        const reverse = options.bothDirections === true && request.origin.latitude === SECOND.latitude;
        const sourceTargets = reverse && options.reverseTargets ? options.reverseTargets : options.targets;
        let journey = sourceJourney(request, sourceTargets, reverse, options.duplicateHandoff === true);
        if (options.sourceMutation) journey = mutateSourceJourney(journey, options.sourceMutation);
        return { journeys: [journey], source: "test-source" };
      },
    },
  };
}

function durationTable(differences: readonly number[], reverse = false): Record<string, readonly [number, number]> {
  const ids = ["a", "b", "c", "d", "e"];
  return Object.fromEntries(ids.slice(0, differences.length).map((id, index) => {
    const difference = differences[index]!;
    return [id, reverse ? [600_000 + difference, 600_000] : [600_000, 600_000 + difference]];
  })) as Record<string, readonly [number, number]>;
}

function sourceJourney(request: CoordinateJourneyRequest, targets: readonly string[], reverse: boolean, duplicateHandoff = false): CoordinateJourney {
  const routeTargets = reverse ? [...targets].reverse() : [...targets];
  const anchorEndpoints = MVG_ANCHOR_STATIONS.map((anchor) => ({ stationGlobalId: anchor.id, coordinate: { latitude: 47, longitude: 10 } }));
  const sourceOriginStation = { stationGlobalId: "origin-station", coordinate: { latitude: 47, longitude: 10 } };
  const sourceDestinationStation = { stationGlobalId: "destination-station", coordinate: { latitude: 47, longitude: 10.1 } };
  const stops = [
    sourceOriginStation,
    ...routeTargets.map((id) => ({ stationGlobalId: id, coordinate: TARGET_COORDINATES[id]! })),
    ...anchorEndpoints,
    sourceDestinationStation,
  ];
  const arrival = Date.parse(request.arrivalAt);
  const departure = arrival - 600_000;
  const transitStart = departure + 60_000;
  const transitEnd = arrival - 60_000;
  const origin = { stationGlobalId: null, coordinate: request.origin };
  const destination = { stationGlobalId: null, coordinate: request.destination };
  const transitHandoff = transitStart + Math.floor((transitEnd - transitStart) / 2);
  const transitPart = (from: CoordinateJourney["parts"][number]["from"], to: CoordinateJourney["parts"][number]["to"], intermediateStops: readonly CoordinateJourney["parts"][number]["from"][], departure: number, arrivalTime: number) => ({
    kind: "transit" as const,
    from,
    to,
    intermediateStops,
    line: { identity: "test-line", type: "BUS" },
    plannedDepartureAt: new Date(departure).toISOString(),
    plannedArrivalAt: new Date(arrivalTime).toISOString(),
  });
  const transitParts = duplicateHandoff
    ? [
        transitPart(stops[0]!, stops[1]!, [], transitStart, transitHandoff),
        transitPart(stops[1]!, stops.at(-1)!, stops.slice(2, -1), transitHandoff, transitEnd),
      ]
    : [transitPart(stops[0]!, stops.at(-1)!, stops.slice(1, -1), transitStart, transitEnd)];
  const transitStops = transitParts.flatMap((part) => [part.from, ...part.intermediateStops, part.to]);
  return {
    transitStops,
    parts: [
      { kind: "walking", from: origin, to: stops[0]!, intermediateStops: [], line: null, plannedDepartureAt: new Date(departure).toISOString(), plannedArrivalAt: new Date(transitStart).toISOString() },
      ...transitParts,
      { kind: "walking", from: stops.at(-1)!, to: destination, intermediateStops: [], line: null, plannedDepartureAt: new Date(transitEnd).toISOString(), plannedArrivalAt: new Date(arrival).toISOString() },
    ],
    plannedDepartureAt: new Date(departure).toISOString(),
    plannedArrivalAt: new Date(arrival).toISOString(),
    plannedDurationMilliseconds: 600_000,
  };
}

function mutateSourceJourney(journey: CoordinateJourney, mutation: NonNullable<ProviderOptions["sourceMutation"]>): CoordinateJourney {
  const parts = [...journey.parts];
  const handoff = parts.find((part, index) => index > 0 && part.kind === "transit" && parts[index - 1]?.kind === "transit");
  if (!handoff || handoff.kind !== "transit") return journey;
  const changedEndpoint = {
    ...handoff.from,
    coordinate: { latitude: handoff.from.coordinate.latitude + 0.002, longitude: handoff.from.coordinate.longitude + 0.002 },
    ...(mutation === "different-platform" ? { stationGlobalId: "different-platform" } : {}),
    ...(mutation === "missing-platform" ? { stationGlobalId: null } : {}),
  };
  const handoffIndex = parts.indexOf(handoff);
  parts[handoffIndex] = { ...handoff, from: changedEndpoint };
  return { ...journey, parts };
}

function verificationJourney(request: CoordinateJourneyRequest, target: string, duration: number): CoordinateJourney {
  const arrival = Date.parse(request.arrivalAt);
  const departure = arrival - duration;
  const station = { stationGlobalId: `target:${target}`, coordinate: request.destination };
  const originStation = { stationGlobalId: "verification-origin", coordinate: request.origin };
  const transitDeparture = departure + 60_000;
  const transitArrival = arrival - 60_000;
  return {
    transitStops: [originStation, station],
    parts: [
      { kind: "walking", from: { stationGlobalId: null, coordinate: request.origin }, to: originStation, intermediateStops: [], line: null, plannedDepartureAt: new Date(departure).toISOString(), plannedArrivalAt: new Date(transitDeparture).toISOString() },
      { kind: "transit", from: originStation, to: station, intermediateStops: [], line: { identity: "verification-line", type: "BUS" }, plannedDepartureAt: new Date(transitDeparture).toISOString(), plannedArrivalAt: new Date(transitArrival).toISOString() },
      { kind: "walking", from: station, to: { stationGlobalId: null, coordinate: request.destination }, intermediateStops: [], line: null, plannedDepartureAt: new Date(transitArrival).toISOString(), plannedArrivalAt: new Date(arrival).toISOString() },
    ],
    plannedDepartureAt: new Date(departure).toISOString(),
    plannedArrivalAt: new Date(arrival).toISOString(),
    plannedDurationMilliseconds: duration,
  };
}

function targetForCoordinate(coordinate: LocationCoordinate): string {
  return Object.entries(TARGET_COORDINATES).find(([, value]) => value.latitude === coordinate.latitude && value.longitude === coordinate.longitude)?.[0] ?? "unknown";
}

function cloneRoute(value: unknown): {
  parts: Array<{
    from: Record<string, unknown>;
    to?: Record<string, unknown>;
    line: Record<string, unknown>;
    intermediateStops?: unknown[];
  }>;
} {
  return JSON.parse(JSON.stringify(value)) as {
    parts: Array<{
      from: Record<string, unknown>;
      to?: Record<string, unknown>;
      line: Record<string, unknown>;
      intermediateStops?: unknown[];
    }>;
  };
}

function clone(value: MeetingCalculationResponse): MeetingCalculationResponse {
  return JSON.parse(JSON.stringify(value)) as MeetingCalculationResponse;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/meeting/calculate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function rawMvgJourney(): Record<string, unknown> {
  const anchor = MVG_ANCHOR_STATIONS[0].id;
  return {
    parts: [
      rawPart("", "origin-stop", FIRST, { latitude: 48.14, longitude: 11.57 }, "FUSS", "2026-07-25T09:20:00.000Z", "2026-07-25T09:25:00.000Z"),
      rawPart("origin-stop", anchor, { latitude: 48.14, longitude: 11.57 }, { latitude: 48.1402, longitude: 11.5586 }, "BUS", "2026-07-25T09:25:00.000Z", "2026-07-25T09:45:00.000Z"),
      rawPart(anchor, "destination-stop", { latitude: 48.1402, longitude: 11.5586 }, SECOND, "BUS", "2026-07-25T09:45:00.000Z", "2026-07-25T09:55:00.000Z"),
      rawPart("destination-stop", "", SECOND, SECOND, "FUSS", "2026-07-25T09:55:00.000Z", "2026-07-25T10:00:00.000Z"),
    ],
  };
}

function rawPart(fromId: string, toId: string, fromCoordinate: LocationCoordinate, toCoordinate: LocationCoordinate, transportType: string, departure: string, arrival: string): Record<string, unknown> {
  return { from: { ...(fromId ? { stationGlobalId: fromId } : {}), ...fromCoordinate, plannedDeparture: departure }, to: { ...(toId ? { stationGlobalId: toId } : {}), ...toCoordinate, plannedDeparture: arrival }, line: { transportType } };
}

function adaptRiesserRoute(url: URL): unknown[] {
  const handoffId = url.searchParams.get("viaStationGlobalId") ?? "fixture-origin";
  const capturedRoutes = handoffId === "de:09162:6" ? [riesserDomainNormalizedRoute()] : RIESSER_BUS_OVERLAP_MIXED_COORDINATE_ROUTES;
  return capturedRoutes.map((capturedRoute) => {
    const route = JSON.parse(JSON.stringify(capturedRoute)) as { parts: Array<{ from: Record<string, unknown>; to: Record<string, unknown> }> };
    route.parts[0]!.to.stationGlobalId = handoffId;
    route.parts[1]!.from.stationGlobalId = handoffId;
    return route;
  });
}

function riesserDomainNormalizedRoute(): unknown {
  const route = JSON.parse(JSON.stringify(RIESSER_HBF_COORDINATE_ROUTE)) as { parts: Array<{ from: Record<string, unknown>; to: Record<string, unknown> }> };
  route.parts[2]!.from.stationGlobalId = "de:09162:1150-platform";
  route.parts[2]!.from.latitude = 48.1400005;
  route.parts[2]!.from.longitude = 11.5600005;
  return route;
}

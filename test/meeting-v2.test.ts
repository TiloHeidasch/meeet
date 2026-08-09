import assert from "node:assert/strict";
import test from "node:test";

import { calculateMeeting, MVG_ANCHOR_STATIONS, ProviderUnavailableError } from "../lib/domain/meeting.ts";
import { handleMeetingPost } from "../lib/domain/meeting-api.ts";
import type { CoordinateJourney, CoordinateJourneyRequest, MeetingCalculationResponse } from "../lib/domain/types.ts";
import type { MeetingProviders } from "../lib/domain/providers.ts";
import { fixtureProviders } from "../lib/fixtures/providers.ts";
import { parseMeetingCalculationInput } from "../lib/validation/meeting.ts";
import { validateMeetingCalculationResponse } from "../lib/domain/response.ts";
import { MVG_DIRECT_ROUTES_URL, MvgDirectRoutingProvider, parseMvgCoordinateJourneys } from "../lib/providers/mvg-direct.ts";
import type { FetchImplementation } from "../lib/providers/http.ts";

const NOW = new Date("2026-07-25T08:00:00.000Z");
const ARRIVAL = "2026-07-25T10:00:00.000Z";
const FIRST = { latitude: 48.1374, longitude: 11.5755 };
const SECOND = { latitude: 48.145, longitude: 11.58 };

test("canonical request validation requires exactly two transit participants and an arrival window", () => {
  const participant = (id: string) => ({ id, mode: "transit", location: { ...FIRST, label: id } });
  assert.equal(parseMeetingCalculationInput({ participants: [participant("a"), participant("b")] }, NOW).success, false);
  assert.equal(parseMeetingCalculationInput({ participants: [participant("a"), participant("b")], arrivalAt: ARRIVAL, tolerancePercent: 10 }, NOW).success, true);
  assert.equal(parseMeetingCalculationInput({ participants: [participant("a"), { ...participant("b"), mode: "bike" }], arrivalAt: ARRIVAL, tolerancePercent: 10 }, NOW).success, false);
  assert.equal(parseMeetingCalculationInput({ participants: [participant("a"), participant("b"), participant("c")], arrivalAt: ARRIVAL, tolerancePercent: 10 }, NOW).success, false);
  assert.equal(parseMeetingCalculationInput({ participants: [participant("a"), participant("b")], arrivalAt: "2026-07-24T10:00:00.000Z", tolerancePercent: 10 }, NOW).success, false);
});

test("calculation API exposes v2 only and rejects legacy departure semantics", async () => {
  const body = {
    participants: [participant("one", FIRST), participant("two", SECOND)],
    arrivalAt: new Date(Date.now() + 3_600_000).toISOString(),
    tolerancePercent: 10,
  };
  const valid = await handleMeetingPost(jsonRequest(body), fixtureProviders);
  assert.equal(valid.status, 200);
  const payload = await valid.json() as Record<string, unknown>;
  assert.equal(payload.contractVersion, "meeet-meeting/v2");
  assert.equal(payload.status, "ok");
  assert.equal(Object.hasOwn(payload, "corridor"), false);
  assert.equal(Object.hasOwn(payload, "meetingPoint"), false);
  assert.equal(Object.hasOwn(payload, "pois"), false);
  const legacy = await handleMeetingPost(jsonRequest({ ...body, arrivalAt: undefined, departureAt: ARRIVAL }), fixtureProviders);
  assert.equal(legacy.status, 400);
  assert.equal((await legacy.json() as { error: { code: string } }).error.code, "INVALID_REQUEST");
});

test("canonical calculation makes fourteen source calls and returns only the finite fair-location DTO", async () => {
  const calls: CoordinateJourneyRequest[] = [];
  const journeyProvider = {
    descriptor: fixtureProviders.routing.descriptor,
    async getCoordinateJourneys(request: CoordinateJourneyRequest) {
      calls.push(request);
      return {
        journeys: [mockJourney(request)],
        source: "injected-mvg",
      };
    },
  };
  const providers: MeetingProviders = { ...fixtureProviders, journey: journeyProvider };
  const result = await calculateMeeting({
    participants: [participant("one", FIRST), participant("two", SECOND)],
    arrivalAt: ARRIVAL,
    tolerancePercent: 10,
  }, providers);

  assert.equal(calls.length >= 14, true);
  assert.deepEqual(calls.slice(0, 14).map((call) => call.viaStationGlobalId ?? "direct"), [
    "direct",
    ...MVG_ANCHOR_STATIONS.map((anchor) => anchor.id),
    "direct",
    ...MVG_ANCHOR_STATIONS.map((anchor) => anchor.id),
  ]);
  assert.ok(calls.slice(0, 14).every((call) => call.arrivalAt === ARRIVAL));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(validateMeetingCalculationResponse(result).success, true);
  assert.equal(Object.hasOwn(result, "corridor"), false);
  assert.equal(Object.hasOwn(result, "meetingPoint"), false);
  assert.equal(Object.hasOwn(result, "pois"), false);
  assert.equal(result.routePatterns.length > 0, true);
  assert.equal(result.fairLocations.length > 0, true);
});

test("source-query provenance covers both directions and preserves empty direct or anchor queries", async () => {
  let sourceCall = 0;
  const journeyProvider = {
    descriptor: fixtureProviders.routing.descriptor,
    async getCoordinateJourneys(request: CoordinateJourneyRequest) {
      sourceCall += 1;
      if (sourceCall === 1) return { journeys: [], source: "injected-mvg" };
      return { journeys: [mockJourney(request)], source: "injected-mvg" };
    },
  };
  const result = await calculateMeeting({ participants: [participant("one", FIRST), participant("two", SECOND)], arrivalAt: ARRIVAL, tolerancePercent: 10 }, { ...fixtureProviders, journey: journeyProvider });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.sourceQueries.length, 14);
  assert.equal(result.sourceQueries.filter((query) => query.direction === "participant-1-to-participant-2").length, 7);
  assert.equal(result.sourceQueries.filter((query) => query.direction === "participant-2-to-participant-1").length, 7);
  assert.equal(result.sourceQueries.filter((query) => query.searchKind === "direct").length, 2);
  assert.equal(result.sourceQueries.filter((query) => query.searchKind === "anchor").length, 12);
  assert.equal(result.sourceQueries.some((query) => query.journeyCount === 0), true);
  assert.equal(result.sourceQueries.filter((query) => query.searchKind === "anchor").every((query) => query.viaDwellTimeInMinutes === 10), true);
  assert.equal(validateMeetingCalculationResponse(result).success, true);
  const missing = JSON.parse(JSON.stringify(result)) as MeetingCalculationResponse;
  missing.sourceQueries = missing.sourceQueries.slice(1);
  assert.equal(validateMeetingCalculationResponse(missing).success, false);
});

test("duplicate timetable variants reuse one pattern candidate set and stay within the verification budget", async () => {
  let calls = 0;
  const journeyProvider = {
    descriptor: fixtureProviders.routing.descriptor,
    async getCoordinateJourneys(request: CoordinateJourneyRequest) {
      calls += 1;
      if (calls <= 14) return { journeys: [mockJourney(request, 600_000), mockJourney(request, 300_000)], source: "injected-mvg" };
      return { journeys: [mockJourney(request)], source: "injected-mvg" };
    },
  };
  const result = await calculateMeeting({ participants: [participant("one", FIRST), participant("two", SECOND)], arrivalAt: ARRIVAL, tolerancePercent: 10 }, { ...fixtureProviders, journey: journeyProvider }, undefined, { maxCandidateVerificationRequests: 70 });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.routePatterns.length, 7);
  assert.equal(result.routePatterns.every((pattern) => pattern.provenance.length === 2 && new Set(pattern.provenance.map((entry) => entry.direction)).size === 2), true);
  assert.equal(calls, 74);
});

test("walk-only patterns remain direction-specific even when both origins coincide", async () => {
  const journeyProvider = {
    descriptor: fixtureProviders.routing.descriptor,
    async getCoordinateJourneys(request: CoordinateJourneyRequest) {
      return {
        journeys: [request.viaStationGlobalId ? mockJourney(request) : mockWalkOnlyJourney(request)],
        source: "injected-mvg",
      };
    },
  };
  const sameOrigin = participant("one", FIRST);
  const otherSameOrigin = participant("two", FIRST);
  const result = await calculateMeeting({ participants: [sameOrigin, otherSameOrigin], arrivalAt: ARRIVAL, tolerancePercent: 10 }, { ...fixtureProviders, journey: journeyProvider });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const walkOnlyPatterns = result.routePatterns.filter((pattern) => pattern.kind === "walk-only");
  assert.equal(walkOnlyPatterns.length, 2);
  assert.deepEqual(walkOnlyPatterns.map((pattern) => pattern.provenance.map((entry) => entry.direction)), [
    ["participant-1-to-participant-2"],
    ["participant-2-to-participant-1"],
  ]);
});

test("fairness uses planned integer milliseconds and escalates without returning a partial set", async () => {
  const journeyProvider = {
    descriptor: fixtureProviders.routing.descriptor,
    async getCoordinateJourneys(request: CoordinateJourneyRequest) {
      const duration = request.origin.latitude === FIRST.latitude ? 1_000 : 1_120;
      return { journeys: [mockJourney(request, duration)], source: "injected-mvg" };
    },
  };
  const result = await calculateMeeting({
    participants: [participant("one", FIRST), participant("two", SECOND)],
    arrivalAt: ARRIVAL,
    tolerancePercent: 5,
  }, { ...fixtureProviders, journey: journeyProvider });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.ok(result.fairLocations.length > 0);
  assert.ok(result.fairLocations.every((location) => location.selectedTolerancePercent === 5 && location.effectiveTolerancePercent === 10));
  assert.ok(result.fairLocations.every((location) => location.differenceMilliseconds === 120));
});

test("MVG coordinate provider uses the fixed arrive-by contract and retains walking parts", async () => {
  const seen: URL[] = [];
  const fetchImplementation: FetchImplementation = async (input) => {
    const url = new URL(String(input));
    seen.push(url);
    return Response.json([rawMvgJourney()]);
  };
  const provider = new MvgDirectRoutingProvider(fetchImplementation);
  const response = await provider.getCoordinateJourneys({
    origin: FIRST,
    destination: SECOND,
    arrivalAt: ARRIVAL,
    viaStationGlobalId: MVG_ANCHOR_STATIONS[0].id,
    viaDwellTimeInMinutes: 10,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].pathname, new URL(MVG_DIRECT_ROUTES_URL).pathname);
  assert.equal(seen[0].searchParams.get("originLatitude"), String(FIRST.latitude));
  assert.equal(seen[0].searchParams.get("originLongitude"), String(FIRST.longitude));
  assert.equal(seen[0].searchParams.get("destinationLatitude"), String(SECOND.latitude));
  assert.equal(seen[0].searchParams.get("destinationLongitude"), String(SECOND.longitude));
  assert.equal(seen[0].searchParams.get("routingDateTime"), ARRIVAL);
  assert.equal(seen[0].searchParams.get("routingDateTimeIsArrival"), "true");
  assert.equal(seen[0].searchParams.get("transportTypes"), "SCHIFF,UBAHN,TRAM,SBAHN,BUS,REGIONAL_BUS,BAHN");
  assert.equal(seen[0].searchParams.get("routeType"), "LEAST_TIME");
  assert.equal(seen[0].searchParams.get("changeSpeed"), "NORMAL");
  assert.equal(seen[0].searchParams.get("viaStationGlobalId"), MVG_ANCHOR_STATIONS[0].id);
  assert.equal(seen[0].searchParams.get("viaDwellTimeInMinutes"), "10");
  assert.equal(response.journeys[0].parts[0].kind, "walking");
  assert.equal(response.journeys[0].parts.at(-1)?.kind, "walking");
  assert.equal(response.journeys[0].plannedDurationMilliseconds, 2_400_000);
});

test("MVG coordinate provider does not begin upstream work for an already-aborted signal", async () => {
  let fetchCalls = 0;
  const controller = new AbortController();
  controller.abort();
  const provider = new MvgDirectRoutingProvider(async () => {
    fetchCalls += 1;
    return Response.json([]);
  });
  await assert.rejects(
    provider.getCoordinateJourneys({ origin: FIRST, destination: SECOND, arrivalAt: ARRIVAL, signal: controller.signal }),
  );
  assert.equal(fetchCalls, 0);
});

test("MVG accepts a bounded empty coordinate result for an individual source query", async () => {
  const provider = new MvgDirectRoutingProvider(async () => Response.json([]));
  const result = await provider.getCoordinateJourneys({ origin: FIRST, destination: SECOND, arrivalAt: ARRIVAL });
  assert.deepEqual(result.journeys, []);
});

test("MVG retains malformed-safe intermediate transit stops as candidate source data", async () => {
  const fetchImplementation: FetchImplementation = async () => {
    const payload = rawMvgJourney() as { parts: Array<Record<string, unknown>> };
    payload.parts[1]!.intermediateStops = [{
      stationGlobalId: "intermediate-stop",
      latitude: 48.139,
      longitude: 11.565,
    }];
    return Response.json([payload]);
  };
  const provider = new MvgDirectRoutingProvider(fetchImplementation);
  const response = await provider.getCoordinateJourneys({
    origin: FIRST,
    destination: SECOND,
    arrivalAt: ARRIVAL,
    viaStationGlobalId: MVG_ANCHOR_STATIONS[0].id,
    viaDwellTimeInMinutes: 10,
  });
  assert.ok(response.journeys[0]!.transitStops.some((stop) => stop.stationGlobalId === "intermediate-stop"));
});

test("MVG preserves per-part intermediate stop order and repeated loop occurrences", () => {
  const first = { latitude: 48.14, longitude: 11.56 };
  const second = { latitude: 48.141, longitude: 11.561 };
  const loop = { latitude: 48.142, longitude: 11.562 };
  const payload = [{
    parts: [
      rawPart("", "s1", FIRST, first, "FUSS", "2026-07-25T09:00:00.000Z", "2026-07-25T09:01:00.000Z"),
      {
        ...rawPart("s1", "s2", first, second, "BUS", "2026-07-25T09:01:00.000Z", "2026-07-25T09:03:00.000Z"),
        intermediateStops: [
          { stationGlobalId: "loop", ...loop },
          { stationGlobalId: "s1", ...first },
        ],
      },
      rawPart("s2", "s1", second, first, "TRAM", "2026-07-25T09:03:00.000Z", "2026-07-25T09:05:00.000Z"),
      rawPart("s1", "", first, SECOND, "FUSS", "2026-07-25T09:05:00.000Z", "2026-07-25T09:10:00.000Z"),
    ],
  }];
  const journey = parseMvgCoordinateJourneys(payload, { origin: FIRST, destination: SECOND, arrivalAt: "2026-07-25T10:00:00.000Z" })[0]!;
  const transitPart = journey.parts.find((part) => part.kind === "transit")! as CoordinateJourney["parts"][number] & { intermediateStops: readonly { stationGlobalId: string | null }[] };
  assert.deepEqual(transitPart.intermediateStops.map((stop) => stop.stationGlobalId), ["loop", "s1"]);
  assert.deepEqual(journey.transitStops.map((stop) => stop.stationGlobalId), ["s1", "loop", "s1", "s2", "s2", "s1"]);
});

test("MVG location labels ignore blank or oversized provider names", () => {
  const payload = rawMvgJourney() as { parts: Array<Record<string, unknown>> };
  payload.parts[1]!.from = { ...(payload.parts[1]!.from as Record<string, unknown>), name: "   " };
  payload.parts[1]!.to = { ...(payload.parts[1]!.to as Record<string, unknown>), name: "x".repeat(513) };
  const journey = parseMvgCoordinateJourneys([payload], { origin: FIRST, destination: SECOND, arrivalAt: ARRIVAL })[0]!;
  assert.equal(journey.parts[1]!.from.label, undefined);
  assert.equal(journey.parts[1]!.to.label, undefined);
});

test("candidate verification rejects journeys not bound to the requested coordinates", async () => {
  const journeyProvider = {
    descriptor: fixtureProviders.routing.descriptor,
    async getCoordinateJourneys(request: CoordinateJourneyRequest) {
      const journey = mockJourney(request);
      journey.parts[0]!.from.coordinate = { latitude: 48.2, longitude: 11.7 };
      return { journeys: [journey], source: "fake-provider" };
    },
  };
  await assert.rejects(
    calculateMeeting({ participants: [participant("one", FIRST), participant("two", SECOND)], arrivalAt: ARRIVAL, tolerancePercent: 10 }, { ...fixtureProviders, journey: journeyProvider }),
    ProviderUnavailableError,
  );
});

test("coordinate binding rejects a distinct point beyond tight equivalence even inside the 50m merge radius", async () => {
  const journeyProvider = {
    descriptor: fixtureProviders.routing.descriptor,
    async getCoordinateJourneys(request: CoordinateJourneyRequest) {
      const journey = mockJourney(request);
      if (request.origin.latitude === FIRST.latitude && request.origin.longitude === FIRST.longitude) {
        journey.parts[0]!.from.coordinate = { latitude: FIRST.latitude, longitude: FIRST.longitude + 0.00002 };
      }
      return { journeys: [journey], source: "fake-provider" };
    },
  };
  await assert.rejects(
    calculateMeeting({ participants: [participant("one", FIRST), participant("two", SECOND)], arrivalAt: ARRIVAL, tolerancePercent: 10 }, { ...fixtureProviders, journey: journeyProvider }),
    ProviderUnavailableError,
  );
});

test("an origin and a walking endpoint at one physical coordinate share one verified marker", async () => {
  const journeyProvider = {
    descriptor: fixtureProviders.routing.descriptor,
    async getCoordinateJourneys(request: CoordinateJourneyRequest) {
      return { journeys: [mockWalkingJourney(request)], source: "fake-provider" };
    },
  };
  const result = await calculateMeeting({ participants: [participant("one", FIRST), participant("two", SECOND)], arrivalAt: ARRIVAL, tolerancePercent: 10 }, { ...fixtureProviders, journey: journeyProvider });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const atFirst = result.fairLocations.filter((location) => location.coordinate.latitude === FIRST.latitude && location.coordinate.longitude === FIRST.longitude && location.kind !== "station");
  assert.equal(atFirst.length, 1);
  assert.equal(atFirst[0]!.sourceRoutePatternIds.length, result.routePatterns.length);
});

test("fair locations expose provider stop names and readable walking/origin labels", async () => {
  const journeyProvider = {
    descriptor: fixtureProviders.routing.descriptor,
    async getCoordinateJourneys(request: CoordinateJourneyRequest) {
      const journey = mockWalkingJourney(request);
      for (const part of journey.parts) {
        if (part.from.stationGlobalId) part.from.label = part.from.stationGlobalId === "injected-origin" ? "Marienplatz" : "Odeonsplatz";
        if (part.to.stationGlobalId) part.to.label = part.to.stationGlobalId === "injected-origin" ? "Marienplatz" : "Odeonsplatz";
      }
      return { journeys: [journey], source: "named-provider" };
    },
  };
  const result = await calculateMeeting({ participants: [participant("one", FIRST), participant("two", SECOND)], arrivalAt: ARRIVAL, tolerancePercent: 10 }, { ...fixtureProviders, journey: journeyProvider });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.fairLocations.some((location) => location.label === "Marienplatz" || location.label === "Odeonsplatz"), true);
  assert.equal(result.fairLocations.filter((location) => location.kind === "origin").every((location) => location.label === "one" || location.label === "two"), true);
  assert.equal(validateMeetingCalculationResponse(result).success, true);
});

test("calculation sanitizes blank or oversized provider endpoint labels before client validation", async () => {
  const journeyProvider = {
    descriptor: fixtureProviders.routing.descriptor,
    async getCoordinateJourneys(request: CoordinateJourneyRequest) {
      const journey = mockJourney(request);
      journey.parts[0]!.from.label = "   ";
      journey.parts[0]!.to.label = "x".repeat(513);
      return { journeys: [journey], source: "unsafe-label-provider" };
    },
  };
  const result = await calculateMeeting({ participants: [participant("one", FIRST), participant("two", SECOND)], arrivalAt: ARRIVAL, tolerancePercent: 10 }, { ...fixtureProviders, journey: journeyProvider });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.fairLocations.every((location) => location.label.trim().length > 0 && location.label.length <= 512), true);
  assert.equal(validateMeetingCalculationResponse(result).success, true);
});

test("client validation rejects fairness, tolerance, journey identity, and source-pattern tampering", async () => {
  const result = await calculateMeeting({ participants: [participant("one", FIRST), participant("two", SECOND)], arrivalAt: ARRIVAL, tolerancePercent: 10 }, fixtureProviders);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const tampered = JSON.parse(JSON.stringify(result)) as MeetingCalculationResponse;
  const location = tampered.fairLocations[0];
  location.differenceMilliseconds += 1;
  assert.equal(validateMeetingCalculationResponse(tampered).success, false);
  const tolerance = JSON.parse(JSON.stringify(result)) as MeetingCalculationResponse;
  tolerance.fairLocations[0].effectiveTolerancePercent = 5;
  assert.equal(validateMeetingCalculationResponse(tolerance).success, false);
  const identity = JSON.parse(JSON.stringify(result)) as MeetingCalculationResponse;
  identity.fairLocations[0].journeys[1].participantId = identity.fairLocations[0].journeys[0].participantId;
  assert.equal(validateMeetingCalculationResponse(identity).success, false);
  const source = JSON.parse(JSON.stringify(result)) as MeetingCalculationResponse;
  source.fairLocations[0].sourceRoutePatternIds = ["unknown-pattern"];
  assert.equal(validateMeetingCalculationResponse(source).success, false);
  const query = JSON.parse(JSON.stringify(result)) as MeetingCalculationResponse;
  query.sourceQueries.find((entry) => entry.searchKind === "anchor")!.viaDwellTimeInMinutes = 5 as 10;
  assert.equal(validateMeetingCalculationResponse(query).success, false);
  const label = JSON.parse(JSON.stringify(result)) as MeetingCalculationResponse;
  delete (label.fairLocations[0] as Partial<typeof label.fairLocations[0]>).label;
  assert.equal(validateMeetingCalculationResponse(label).success, false);
});

test("client validation rejects disagreeing duplicated routing and boundary provenance", async () => {
  const result = await calculateMeeting({ participants: [participant("one", FIRST), participant("two", SECOND)], arrivalAt: ARRIVAL, tolerancePercent: 10 }, fixtureProviders);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const boundary = JSON.parse(JSON.stringify(result)) as MeetingCalculationResponse;
  boundary.metadata.provenance.boundary.attribution = "tampered boundary attribution";
  assert.equal(validateMeetingCalculationResponse(boundary).success, false);
  const routing = JSON.parse(JSON.stringify(result)) as MeetingCalculationResponse;
  routing.metadata.provenance.routing.notes = "tampered routing provenance";
  assert.equal(validateMeetingCalculationResponse(routing).success, false);
});

test("v2 client validation rejects invalid deployment enums, fixture-scheduled metadata, null boundary licences, and missing intermediate stops", async () => {
  const result = await calculateMeeting({ participants: [participant("one", FIRST), participant("two", SECOND)], arrivalAt: ARRIVAL, tolerancePercent: 10 }, fixtureProviders);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const invalidDeployment = cloneUntypedResponse(result);
  setRoutingMetadata(invalidDeployment, "not-a-deployment", "scheduled");
  assert.equal(validateMeetingCalculationResponse(invalidDeployment).success, false);
  const fixtureScheduled = cloneUntypedResponse(result);
  setRoutingMetadata(fixtureScheduled, "fixture", "scheduled");
  assert.equal(validateMeetingCalculationResponse(fixtureScheduled).success, false);
  const nullLicense = cloneUntypedResponse(result);
  nullLicense.metadata.boundary.license = null;
  nullLicense.metadata.provenance.boundary.license = null;
  assert.equal(validateMeetingCalculationResponse(nullLicense).success, false);
  const missingIntermediateStops = cloneUntypedResponse(result);
  delete missingIntermediateStops.routePatterns[0]!.parts[0]!.intermediateStops;
  assert.equal(validateMeetingCalculationResponse(missingIntermediateStops).success, false);
});

test("missing tolerance defaults to ten while invalid supplied tolerance remains invalid", () => {
  const body = { participants: [participant("one", FIRST), participant("two", SECOND)], arrivalAt: ARRIVAL };
  const parsed = parseMeetingCalculationInput(body, NOW);
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.tolerancePercent, 10);
  assert.equal(parseMeetingCalculationInput({ ...body, tolerancePercent: 12 }, NOW).success, false);
});

test("fixture canonical metadata remains demo-static and validates without scheduled rewriting", async () => {
  const result = await calculateMeeting({ participants: [participant("one", FIRST), participant("two", SECOND)], arrivalAt: ARRIVAL, tolerancePercent: 10 }, fixtureProviders);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.metadata.routing.dataKind, "demo-static");
  assert.equal(result.metadata.routing.provenance.dataKind, "demo-static");
  assert.equal(validateMeetingCalculationResponse(result).success, true);
});

test("latest feasible planned arrival-by journey is selected and deadline/budget exceedance fails operationally", async () => {
  const provider = {
    descriptor: fixtureProviders.routing.descriptor,
    async getCoordinateJourneys(request: CoordinateJourneyRequest) {
      const early = mockJourney(request, 600_000);
      const late = mockJourney(request, 300_000);
      return { journeys: [early, late], source: "fake-provider" };
    },
  };
  const selected = await calculateMeeting({ participants: [participant("one", FIRST), participant("two", SECOND)], arrivalAt: ARRIVAL, tolerancePercent: 10 }, { ...fixtureProviders, journey: provider });
  assert.equal(selected.status, "ok");
  if (selected.status === "ok") assert.equal(selected.fairLocations[0]!.journeys[0]!.plannedDurationMilliseconds, 300_000);
  const slowProvider = {
    descriptor: fixtureProviders.routing.descriptor,
    async getCoordinateJourneys(request: CoordinateJourneyRequest) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { journeys: [mockJourney(request)], source: "fake-provider" };
    },
  };
  await assert.rejects(
    calculateMeeting({ participants: [participant("one", FIRST), participant("two", SECOND)], arrivalAt: ARRIVAL, tolerancePercent: 10 }, { ...fixtureProviders, journey: slowProvider }, undefined, { deadlineMs: 1 }),
    ProviderUnavailableError,
  );
  await assert.rejects(
    calculateMeeting({ participants: [participant("one", FIRST), participant("two", SECOND)], arrivalAt: ARRIVAL, tolerancePercent: 10 }, { ...fixtureProviders, journey: provider }, undefined, { maxCandidateVerificationRequests: 1 }),
    ProviderUnavailableError,
  );
});

test("an already-aborted caller fails before the calculation provider is invoked", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const journeyProvider = {
    descriptor: fixtureProviders.routing.descriptor,
    async getCoordinateJourneys() {
      calls += 1;
      return { journeys: [], source: "should-not-run" };
    },
  };
  await assert.rejects(
    calculateMeeting({ participants: [participant("one", FIRST), participant("two", SECOND)], arrivalAt: ARRIVAL, tolerancePercent: 10 }, { ...fixtureProviders, journey: journeyProvider }, controller.signal),
    ProviderUnavailableError,
  );
  assert.equal(calls, 0);
});

function participant(id: string, coordinate: { latitude: number; longitude: number }) {
  return { id, mode: "transit" as const, location: { ...coordinate, label: id } };
}

interface UntypedResponse {
  metadata: {
    routing: Record<string, unknown>;
    boundary: Record<string, unknown>;
    provenance: {
      routing: Record<string, unknown>;
      boundary: Record<string, unknown>;
    };
  };
  routePatterns: Array<{ parts: Array<Record<string, unknown>> }>;
}

function cloneUntypedResponse(response: MeetingCalculationResponse): UntypedResponse {
  return JSON.parse(JSON.stringify(response)) as UntypedResponse;
}

function setRoutingMetadata(response: UntypedResponse, deployment: string, dataKind: string): void {
  for (const routing of [response.metadata.routing, response.metadata.provenance.routing]) {
    routing.deployment = deployment;
    routing.dataKind = dataKind;
    routing.retrievedAt = "2026-07-25T08:00:00.000Z";
  }
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/meeting/calculate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockJourney(request: CoordinateJourneyRequest, durationMilliseconds = 600_000): CoordinateJourney {
  const arrival = Date.parse(request.arrivalAt);
  const departure = arrival - durationMilliseconds;
  const anchor = request.viaStationGlobalId ?? "injected-stop";
  const endpoint = (stationGlobalId: string | null, coordinate: { latitude: number; longitude: number }) => ({ stationGlobalId, coordinate });
  const start = endpoint("injected-origin", request.origin);
  const via = endpoint(anchor, { latitude: 48.14, longitude: 11.57 });
  const destination = endpoint("injected-destination", request.destination);
  const transitDeparture = departure;
  const transitArrival = arrival;
  const transitPart = {
    kind: "transit" as const,
    from: start,
    to: via,
    intermediateStops: [],
    line: { identity: "injected-line", type: "BUS" },
    plannedDepartureAt: new Date(transitDeparture).toISOString(),
    plannedArrivalAt: new Date(departure + durationMilliseconds / 2).toISOString(),
  };
  const secondTransitPart = {
    ...transitPart,
    from: via,
    to: destination,
    plannedDepartureAt: new Date(departure + durationMilliseconds / 2).toISOString(),
    plannedArrivalAt: new Date(transitArrival).toISOString(),
  };
  return {
    transitStops: [start, via, destination],
    parts: [
      transitPart,
      secondTransitPart,
    ],
    plannedDepartureAt: new Date(departure).toISOString(),
    plannedArrivalAt: new Date(arrival).toISOString(),
    plannedDurationMilliseconds: durationMilliseconds,
  };
}

function mockWalkOnlyJourney(request: CoordinateJourneyRequest, durationMilliseconds = 600_000): CoordinateJourney {
  const arrival = Date.parse(request.arrivalAt);
  const departure = arrival - durationMilliseconds;
  return {
    transitStops: [],
    parts: [{
      kind: "walking",
      from: { stationGlobalId: null, coordinate: request.origin },
      to: { stationGlobalId: null, coordinate: request.destination },
      intermediateStops: [],
      line: null,
      plannedDepartureAt: new Date(departure).toISOString(),
      plannedArrivalAt: new Date(arrival).toISOString(),
    }],
    plannedDepartureAt: new Date(departure).toISOString(),
    plannedArrivalAt: new Date(arrival).toISOString(),
    plannedDurationMilliseconds: durationMilliseconds,
  };
}

function mockWalkingJourney(request: CoordinateJourneyRequest, durationMilliseconds = 600_000): CoordinateJourney {
  const base = mockJourney(request, durationMilliseconds);
  const first = base.parts[0]!;
  const last = base.parts.at(-1)!;
  return {
    ...base,
    parts: [
      {
        kind: "walking",
        from: { stationGlobalId: null, coordinate: request.origin },
        to: first.from,
        intermediateStops: [],
        line: null,
        plannedDepartureAt: base.plannedDepartureAt,
        plannedArrivalAt: first.plannedDepartureAt,
      },
      ...base.parts,
      {
        kind: "walking",
        from: last.to,
        to: { stationGlobalId: null, coordinate: request.destination },
        intermediateStops: [],
        line: null,
        plannedDepartureAt: last.plannedArrivalAt,
        plannedArrivalAt: base.plannedArrivalAt,
      },
    ],
  };
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

function rawPart(
  fromId: string,
  toId: string,
  fromCoordinate: { latitude: number; longitude: number },
  toCoordinate: { latitude: number; longitude: number },
  transportType: string,
  departure: string,
  arrival: string,
): Record<string, unknown> {
  return {
    from: { ...(fromId ? { stationGlobalId: fromId } : {}), ...fromCoordinate, plannedDeparture: departure },
    to: { ...(toId ? { stationGlobalId: toId } : {}), ...toCoordinate, plannedDeparture: arrival },
    line: { transportType },
  };
}

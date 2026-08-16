import assert from "node:assert/strict";
import test from "node:test";

import {
  handleMeetingPost,
  handleStationAreaDetailsPost,
} from "../lib/domain/meeting-api.ts";
import {
  InMemoryStationAreaCalculationBasisCache,
  stationAreaCalculationBasisCache,
} from "../lib/domain/station-area-details-cache.ts";
import { getOrCreateProcessValue } from "../lib/domain/process-registry.ts";
import { scheduledCalculationAdmission, ScheduledCalculationAdmission } from "../lib/domain/scheduled-admission.ts";
import {
  createScheduledRoutingWindow,
  haversineDistanceMeters,
  routeScheduledEarliestArrivals,
  routeScheduledSelectedBoardingStop,
} from "../lib/domain/scheduled-routing/router.ts";
import { calculateScheduledMeetingWithBasis } from "../lib/domain/scheduled-routing/meeting.ts";
import {
  FIXTURE_SCHEDULED_ACCESS_PROVIDER,
  FIXTURE_SCHEDULED_ARTIFACT,
} from "../lib/fixtures/scheduled-routing.ts";
import { parseScheduledMeetingRequest, type ScheduledMeetingStationAreaDto } from "../lib/validation/meeting-v3.ts";
import { validateStationAreaDetailsResponse } from "../lib/validation/station-area-details-v1.ts";
import type { MeetingProviders, ScheduledAccessSeedCandidate } from "../lib/domain/providers.ts";
import { walkingSeconds } from "../lib/domain/scheduled-routing/router.ts";
import type { ScheduledRoutingArtifact } from "../lib/domain/scheduled-routing/models.ts";

const REQUEST = {
  contractVersion: "meeet-meeting/v3",
  participants: [
    { id: "red", origin: { label: "Red", latitude: 48.1374, longitude: 11.5755 }, mode: "transit" },
    { id: "blue", origin: { label: "Blue", latitude: 48.1400, longitude: 11.5700 }, mode: "transit" },
  ],
  tolerancePercent: 10,
  searchStartAt: "2026-08-11T08:05:00+02:00",
} as const;

const PROVIDERS: MeetingProviders = {
  scheduledArtifact: FIXTURE_SCHEDULED_ARTIFACT,
  scheduledAccess: FIXTURE_SCHEDULED_ACCESS_PROVIDER,
};

type MutableDetail = {
  stationArea: ScheduledMeetingStationAreaDto;
  participants: Array<{
    status: string;
    unavailableReason: string | null;
    terminal: { boardingStopId: string | null; totalSeconds: number | null; arrivalAt: string | null };
    segments: Array<{ kind: string; [key: string]: unknown }>;
  }>;
  basis: Record<string, unknown>;
};

test("global symbol registry resolves the same cache and admission across route-bundle seams", () => {
  const cacheFromSecondBundle = getOrCreateProcessValue(
    Symbol.for("meeet.station-area-calculation-basis-cache/v1"),
    () => new InMemoryStationAreaCalculationBasisCache(),
    (value: unknown): value is typeof stationAreaCalculationBasisCache => typeof value === "object" && value !== null && typeof (value as { get?: unknown }).get === "function" && typeof (value as { put?: unknown }).put === "function",
  );
  const admissionFromSecondBundle = getOrCreateProcessValue(
    Symbol.for("meeet.scheduled-calculation-admission/v1"),
    () => new ScheduledCalculationAdmission(),
    (value: unknown): value is typeof scheduledCalculationAdmission => typeof value === "object" && value !== null && typeof (value as { tryAcquire?: unknown }).tryAcquire === "function",
  );
  assert.strictEqual(cacheFromSecondBundle, stationAreaCalculationBasisCache);
  assert.strictEqual(admissionFromSecondBundle, scheduledCalculationAdmission);
});

function calculateRequest(cache: InMemoryStationAreaCalculationBasisCache, providers: MeetingProviders = PROVIDERS): Promise<Response> {
  return handleMeetingPost(new Request("https://meeet.test/api/meeting/calculate", {
    method: "POST",
    body: JSON.stringify(REQUEST),
  }), providers, { basisCache: cache });
}

async function detailsRequest(
  reference: string,
  cache: InMemoryStationAreaCalculationBasisCache,
  stationAreaId = "fixture-c",
  body: unknown = REQUEST,
  providers: MeetingProviders | (() => MeetingProviders) = PROVIDERS,
  options: Parameters<typeof handleStationAreaDetailsPost>[3] = {},
): Promise<Response> {
  return handleStationAreaDetailsPost(new Request("https://meeet.test/api/meeting/station-areas/details", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Meeet-Calculation-Ref": reference },
  }), stationAreaId, providers, { ...options, basisCache: cache });
}

test("selected boarding-stop witness is scan-first, deterministic, and reconciles walk/wait/transit", async () => {
  const parsed = parseScheduledMeetingRequest(REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const window = createScheduledRoutingWindow(FIXTURE_SCHEDULED_ARTIFACT, parsed.data.searchStartAt, { walkingVelocityMetersPerSecond: 1.4, transferRadiusMeters: 250 });
  const candidates = await FIXTURE_SCHEDULED_ACCESS_PROVIDER.resolveAccessSeeds({ origin: parsed.data.participants[0].origin, schedule: FIXTURE_SCHEDULED_ARTIFACT });
  const canonicalSeeds = candidates.map((candidate) => ({ stationAreaId: candidate.stationAreaId, ...(candidate.boardingStopId === undefined ? {} : { boardingStopId: candidate.boardingStopId }), accessSeconds: candidate.accessSeconds }));
  const ordinaryAllocations: string[] = [];
  const ordinary = routeScheduledEarliestArrivals(FIXTURE_SCHEDULED_ARTIFACT, candidates.map((candidate) => ({ stationAreaId: candidate.stationAreaId, accessSeconds: candidate.accessSeconds })), parsed.data.searchStartAt, { walkingVelocityMetersPerSecond: 1.4, transferRadiusMeters: 250, onWitnessAllocation: (kind) => ordinaryAllocations.push(kind) }, window);
  assert.equal(ordinary.boardingStopArrivals.find((arrival) => arrival.boardingStopId === "fixture-c-stop")?.elapsedSeconds, 1_800);
  assert.deepEqual(ordinaryAllocations, []);
  const witnessAllocations: string[] = [];
  const first = routeScheduledSelectedBoardingStop(FIXTURE_SCHEDULED_ARTIFACT, canonicalSeeds, "fixture-c-stop", parsed.data.searchStartAt, { walkingVelocityMetersPerSecond: 1.4, transferRadiusMeters: 250, origin: parsed.data.participants[0].origin }, window, candidates);
  const second = routeScheduledSelectedBoardingStop(FIXTURE_SCHEDULED_ARTIFACT, canonicalSeeds, "fixture-c-stop", parsed.data.searchStartAt, { walkingVelocityMetersPerSecond: 1.4, transferRadiusMeters: 250, origin: parsed.data.participants[0].origin }, window, candidates);
  assert.deepEqual(second, first);
  assert.equal(first?.totalSeconds, 1_800);
  assert.deepEqual(first?.segments.map((segment) => segment.kind), ["walk", "identity-resolution", "walk", "wait", "transit"]);
  assert.equal(first?.segments.reduce((total, segment) => total + segment.durationSeconds, 0), 1_800);
  const selectedSeed = candidates.find((candidate) => candidate.stationAreaId === "fixture-b");
  assert.deepEqual(first?.segments[0]?.kind === "walk" ? first.segments[0].to : null, selectedSeed?.coordinate);
  assert.equal(first?.segments[2]?.kind === "walk" ? first.segments[2].durationSeconds : null, 0);
  assert.deepEqual(first?.segments[2]?.kind === "walk" ? first.segments[2].from : null, selectedSeed?.coordinate);
  routeScheduledSelectedBoardingStop(FIXTURE_SCHEDULED_ARTIFACT, canonicalSeeds, "fixture-c-stop", parsed.data.searchStartAt, { walkingVelocityMetersPerSecond: 1.4, transferRadiusMeters: 250, origin: parsed.data.participants[0].origin, onWitnessAllocation: (kind) => witnessAllocations.push(kind) }, window, candidates);
  assert.deepEqual(witnessAllocations, ["ready-map", "connection-map"]);
  const transit = first?.segments.find((segment) => segment.kind === "transit");
  assert.equal(transit?.source, "mvv-gtfs");
  assert.equal(transit?.from.boardingStopId, "fixture-b-stop");
  assert.equal(transit?.to.boardingStopId, "fixture-c-stop");
  const calculation = await calculateScheduledMeetingWithBasis(parsed.data, { artifact: FIXTURE_SCHEDULED_ARTIFACT, access: FIXTURE_SCHEDULED_ACCESS_PROVIDER });
  const marker = calculation.response.stationAreas.find((area) => area.stationAreaId === "fixture-c");
  assert.equal(marker?.redBoardingStopId, first?.boardingStopId);
  assert.equal(marker?.redArrivalSeconds, first?.totalSeconds);
});

test("exact divergent seed coordinates use a consistent origin walk and identity bridge", async () => {
  const parsed = parseScheduledMeetingRequest(REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const base = await FIXTURE_SCHEDULED_ACCESS_PROVIDER.resolveAccessSeeds({ origin: parsed.data.participants[0].origin, schedule: FIXTURE_SCHEDULED_ARTIFACT });
  const baseSeed = base.find((candidate) => candidate.stationAreaId === "fixture-a");
  if (baseSeed === undefined) throw new Error("Fixture access seed missing.");
  const divergentCoordinate = { latitude: 48.1374, longitude: 11.5745 };
  const divergentSeed: ScheduledAccessSeedCandidate = {
    ...baseSeed,
    boardingStopId: "fixture-a-stop",
    coordinate: divergentCoordinate,
    accessSeconds: walkingSeconds(parsed.data.participants[0].origin, divergentCoordinate, 1.4),
    provenance: { ...baseSeed.provenance, distanceMeters: 1, walkingSeconds: walkingSeconds(parsed.data.participants[0].origin, divergentCoordinate, 1.4) },
  };
  const route = routeScheduledSelectedBoardingStop(FIXTURE_SCHEDULED_ARTIFACT, [{ stationAreaId: divergentSeed.stationAreaId, boardingStopId: divergentSeed.boardingStopId, accessSeconds: divergentSeed.accessSeconds }], "fixture-a-stop", parsed.data.searchStartAt, { walkingVelocityMetersPerSecond: 1.4, transferRadiusMeters: 250, origin: parsed.data.participants[0].origin }, undefined, [divergentSeed]);
  assert.ok(route);
  const originAccess = route.segments[0];
  const identityBridge = route.segments[1];
  assert.equal(originAccess?.kind, "walk");
  assert.deepEqual(originAccess?.kind === "walk" ? originAccess.to : null, divergentCoordinate);
  assert.equal(originAccess?.kind === "walk" ? originAccess.distanceMeters : null, haversineDistanceMeters(parsed.data.participants[0].origin, divergentCoordinate));
  assert.equal(identityBridge?.kind, "identity-resolution");
  assert.equal(identityBridge?.kind === "identity-resolution" ? identityBridge.purpose : null, "station-access");
  assert.deepEqual(identityBridge?.kind === "identity-resolution" ? identityBridge.from : null, divergentCoordinate);
  assert.equal(identityBridge?.kind === "identity-resolution" && identityBridge.target === "boarding-stop" && "boardingStopId" in identityBridge.to ? identityBridge.to.boardingStopId : null, "fixture-a-stop");
  assert.deepEqual(identityBridge?.kind === "identity-resolution" ? identityBridge.toCoordinate : null, FIXTURE_SCHEDULED_ARTIFACT.boardingStops.find((stop) => stop.id === "fixture-a-stop")!.coordinate);
  assert.equal(identityBridge?.kind === "identity-resolution" ? identityBridge.durationSeconds : null, 0);
  assert.equal(identityBridge?.kind === "identity-resolution" ? "distanceMeters" in identityBridge : false, false);
  assert.equal(route.segments.reduce((total, segment) => total + segment.durationSeconds, 0), route.totalSeconds);

  const divergentProvider: MeetingProviders = {
    scheduledArtifact: FIXTURE_SCHEDULED_ARTIFACT,
    scheduledAccess: {
      ...FIXTURE_SCHEDULED_ACCESS_PROVIDER,
      async resolveAccessSeeds(input): Promise<readonly ScheduledAccessSeedCandidate[]> {
        const accessSeconds = walkingSeconds(input.origin, divergentCoordinate, 1.4);
        return [{ ...divergentSeed, seedId: `divergent:${input.origin.latitude}:${input.origin.longitude}`, accessSeconds, provenance: { ...divergentSeed.provenance, walkingSeconds: accessSeconds } }];
      },
    },
  };
  const cache = new InMemoryStationAreaCalculationBasisCache({ referenceFactory: () => "divergent-reference" });
  const calculation = await calculateRequest(cache, divergentProvider);
  assert.equal(calculation.status, 200);
  const reference = calculation.headers.get("Meeet-Calculation-Ref");
  assert.ok(reference);
  const calculationBody = await calculation.clone().json() as { stationAreas: Array<{ stationAreaId: string; redBoardingStopId: string | null; redArrivalSeconds: number | null }> };
  const divergentMarker = calculationBody.stationAreas.find((area) => area.stationAreaId === "fixture-a");
  assert.equal(divergentMarker?.redBoardingStopId, "fixture-a-stop");
  assert.equal(divergentMarker?.redArrivalSeconds, divergentSeed.accessSeconds);
  const detail = await detailsRequest(reference, cache, "fixture-a", REQUEST, divergentProvider);
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as { participants: Array<{ terminal: { totalSeconds: number | null }; segments: Array<{ kind: string; from?: { latitude: number; longitude: number }; to?: { boardingStopId: string }; distanceMeters?: number; durationSeconds?: number }> }> };
  const detailAccess = detailBody.participants[0]?.segments[0];
  const detailBridge = detailBody.participants[0]?.segments[1];
  assert.deepEqual(detailAccess?.to, divergentCoordinate);
  assert.deepEqual(detailBridge?.from, divergentCoordinate);
  assert.equal(detailBridge?.to?.boardingStopId, "fixture-a-stop");
  assert.deepEqual((detailBridge as { toCoordinate?: { latitude: number; longitude: number } }).toCoordinate, FIXTURE_SCHEDULED_ARTIFACT.boardingStops.find((stop) => stop.id === "fixture-a-stop")!.coordinate);
  assert.equal(detailBridge?.durationSeconds, 0);
  assert.equal(detailBridge && "distanceMeters" in detailBridge, false);
  assert.equal(detailBody.participants[0]?.terminal.totalSeconds, divergentSeed.accessSeconds);
  assert.equal(detailBody.participants[0]?.segments.some((segment) => segment.kind === "transit"), false);
});

test("non-exact provider coordinates cannot change canonical readiness, marker classification, or detail totals", async () => {
  const createBoundaryProvider = (shifted: boolean, calls: { count: number }): MeetingProviders => ({
    scheduledArtifact: FIXTURE_SCHEDULED_ARTIFACT,
    scheduledAccess: {
      ...FIXTURE_SCHEDULED_ACCESS_PROVIDER,
      async resolveAccessSeeds(input): Promise<readonly ScheduledAccessSeedCandidate[]> {
        calls.count += 1;
        const area = input.schedule.stationAreas.find((candidate) => candidate.id === "fixture-a");
        if (area === undefined) throw new Error("Fixture boundary area missing.");
        const accessSeconds = input.origin.latitude < 48.139 ? 299 : 330;
        const coordinate = shifted ? { latitude: area.coordinate.latitude, longitude: area.coordinate.longitude + 0.005 } : area.coordinate;
        return [{
          seedId: `boundary:${input.origin.latitude}:${shifted ? "shifted" : "canonical"}`,
          mvgStationId: area.id,
          stationAreaId: area.id,
          coordinate,
          accessSeconds,
          provenance: {
            source: "fixture-static",
            endpoint: "fixture-boundary-access",
            distanceMeters: haversineDistanceMeters(input.origin, coordinate),
            walkingSeconds: accessSeconds,
            note: "Deterministic access-only regression fixture.",
          },
        }];
      },
    },
  });
  const canonicalCalls = { count: 0 };
  const shiftedCalls = { count: 0 };
  const canonicalCache = new InMemoryStationAreaCalculationBasisCache({ referenceFactory: () => "canonical-boundary-reference" });
  const shiftedCache = new InMemoryStationAreaCalculationBasisCache({ referenceFactory: () => "shifted-boundary-reference" });
  const canonicalResponse = await calculateRequest(canonicalCache, createBoundaryProvider(false, canonicalCalls));
  const shiftedResponse = await calculateRequest(shiftedCache, createBoundaryProvider(true, shiftedCalls));
  assert.equal(canonicalResponse.status, 200);
  assert.equal(shiftedResponse.status, 200);
  assert.equal(canonicalCalls.count, 2);
  assert.equal(shiftedCalls.count, 2);
  const canonicalBody = await canonicalResponse.json() as { stationAreas: readonly Record<string, unknown>[] };
  const shiftedBody = await shiftedResponse.json() as { stationAreas: readonly Record<string, unknown>[] };
  assert.deepEqual(shiftedBody.stationAreas, canonicalBody.stationAreas);
  const boundaryMarker = shiftedBody.stationAreas.find((candidate) => candidate.stationAreaId === "fixture-a");
  assert.deepEqual(boundaryMarker, {
    stationAreaId: "fixture-a",
    name: "Fixture A",
    coordinate: { latitude: 48.1374, longitude: 11.5755 },
    redBoardingStopId: "fixture-a-stop",
    blueBoardingStopId: "fixture-a-stop",
    classification: "fair",
    redArrivalSeconds: 299,
    blueArrivalSeconds: 330,
    fasterParticipant: "red",
    withinSelectedTolerance: true,
  });
  const reference = shiftedResponse.headers.get("Meeet-Calculation-Ref");
  assert.equal(reference, "shifted-boundary-reference");
  const cachedBasis = shiftedCache.get(reference!);
  assert.ok(cachedBasis);
  assert.equal("coordinate" in cachedBasis.canonicalAccessSeeds[0][0]!, false);
  assert.notDeepEqual(cachedBasis.accessSeedCandidates[0][0]?.coordinate, cachedBasis.canonicalAccessSeeds[0][0]);
  const detail = await detailsRequest(reference!, shiftedCache, "fixture-a", REQUEST, createBoundaryProvider(true, shiftedCalls));
  assert.equal(detail.status, 200);
  assert.equal(shiftedCalls.count, 2);
  const detailBody = await detail.json() as { stationArea: Record<string, unknown>; participants: Array<{ terminal: { boardingStopId: string | null; totalSeconds: number | null }; segments: readonly { kind: string }[] }> };
  assert.deepEqual(detailBody.stationArea, boundaryMarker);
  assert.deepEqual(detailBody.participants.map((participant) => [participant.terminal.boardingStopId, participant.terminal.totalSeconds]), [["fixture-a-stop", 299], ["fixture-a-stop", 330]]);
  assert.ok(detailBody.participants.every((participant) => participant.segments.some((segment) => segment.kind === "identity-resolution")));
});

test("calculate emits a bounded opaque reference and details reuse cached seeds without MVG resolution", async () => {
  let now = 0;
  const cache = new InMemoryStationAreaCalculationBasisCache({ now: () => now, referenceFactory: () => "test-reference" });
  const calculate = await calculateRequest(cache);
  assert.equal(calculate.status, 200);
  const reference = calculate.headers.get("Meeet-Calculation-Ref");
  assert.equal(reference, "test-reference");
  let accessCalls = 0;
  const noMvgProviders: MeetingProviders = {
    scheduledArtifact: FIXTURE_SCHEDULED_ARTIFACT,
    scheduledAccess: {
      ...FIXTURE_SCHEDULED_ACCESS_PROVIDER,
      async resolveAccessSeeds() {
        accessCalls += 1;
        throw new Error("detail must not resolve access seeds");
      },
    },
  };
  const detail = await detailsRequest(reference!, cache, "fixture-c", REQUEST, noMvgProviders);
  assert.equal(detail.status, 200);
  assert.equal(accessCalls, 0);
  const detailBody = await detail.json() as { contractVersion: string; stationArea: { redArrivalSeconds: number | null }; participants: Array<{ segments: unknown[] }> };
  assert.equal(detailBody.contractVersion, "meeet-station-area-details/v1");
  assert.equal(detailBody.stationArea.redArrivalSeconds, 1_800);
  assert.ok(detailBody.participants[0]?.segments.length);
  now = 15 * 60_000 - 1;
  const stillValid = await detailsRequest(reference!, cache, "fixture-c");
  assert.equal(stillValid.status, 200);
  now = 15 * 60_000;
  const expired = await detailsRequest(reference!, cache);
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).error.code, "CALCULATION_REF_EXPIRED");
});

test("cache pressure never converts a valid v3 calculation into an error", async () => {
  const limitedCache = new InMemoryStationAreaCalculationBasisCache({ maxBytes: 1, referenceFactory: () => "never-stored" });
  const response = await calculateRequest(limitedCache);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Meeet-Calculation-Ref"), null);
  assert.equal((await response.json()).contractVersion, "meeet-meeting/v3");
});

test("detail rejects v3 request/reference and artifact mismatches, admission, and deadline visibly", async () => {
  const cache = new InMemoryStationAreaCalculationBasisCache({ referenceFactory: () => `ref-${Math.random()}` });
  const calculate = await calculateRequest(cache);
  const reference = calculate.headers.get("Meeet-Calculation-Ref")!;
  const mismatched = { ...REQUEST, tolerancePercent: 5 };
  const mismatch = await detailsRequest(reference, cache, "fixture-c", mismatched);
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).error.code, "CALCULATION_REF_MISMATCH");
  const legacy = await detailsRequest(reference, cache, "fixture-c", { arrivalAt: REQUEST.searchStartAt });
  assert.equal(legacy.status, 400);
  assert.equal((await legacy.json()).error.code, "INVALID_REQUEST");
  const artifactMismatch = await detailsRequest(reference, cache, "fixture-c", REQUEST, { ...PROVIDERS, scheduledArtifact: { ...FIXTURE_SCHEDULED_ARTIFACT, feedId: "different-feed" } });
  assert.equal(artifactMismatch.status, 409);
  const occupied = new (await import("../lib/domain/scheduled-admission.ts")).ScheduledCalculationAdmission();
  const release = occupied.tryAcquire();
  assert.ok(release);
  try {
    const unavailable = await detailsRequest(reference, cache, "fixture-c", REQUEST, PROVIDERS, { admission: occupied });
    assert.equal(unavailable.status, 503);
  } finally {
    release();
  }
  const deadline = await detailsRequest(reference, cache, "fixture-c", REQUEST, PROVIDERS, { deadlineMs: 0, now: () => 1 });
  assert.equal(deadline.status, 503);
});

test("strict detail validator rejects marker, total/segments, transit source, and tolerance tampering", async () => {
  const cache = new InMemoryStationAreaCalculationBasisCache({ referenceFactory: () => "tamper-reference" });
  const calculate = await calculateRequest(cache);
  const reference = calculate.headers.get("Meeet-Calculation-Ref")!;
  const response = await detailsRequest(reference, cache);
  assert.equal(response.status, 200);
  const valid = await response.json() as MutableDetail;
  const parsed = parseScheduledMeetingRequest(REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const context = { request: parsed.data, selectedMarker: valid.stationArea, artifactIdentity: { feedId: FIXTURE_SCHEDULED_ARTIFACT.feedId, timeZone: FIXTURE_SCHEDULED_ARTIFACT.timeZone, scheduleContentHash: FIXTURE_SCHEDULED_ARTIFACT.provenance.contentHash, compiledArtifactId: FIXTURE_SCHEDULED_ARTIFACT.provenance.compiledArtifactId }, selectedBoardingStops: { red: { boardingStopId: "fixture-c-stop", coordinate: FIXTURE_SCHEDULED_ARTIFACT.boardingStops.find((stop) => stop.id === "fixture-c-stop")!.coordinate }, blue: { boardingStopId: "fixture-c-stop", coordinate: FIXTURE_SCHEDULED_ARTIFACT.boardingStops.find((stop) => stop.id === "fixture-c-stop")!.coordinate } } };
  assert.equal(validateStationAreaDetailsResponse(valid, context).success, true);
  const tamper = (mutate: (copy: MutableDetail) => void) => {
    const copy = structuredClone(valid) as MutableDetail;
    mutate(copy);
    assert.equal(validateStationAreaDetailsResponse(copy, context).success, false);
  };
  tamper((copy) => { (copy.stationArea as { redBoardingStopId: string | null }).redBoardingStopId = "wrong-stop"; });
  tamper((copy) => { copy.participants[0].status = "unavailable"; });
  tamper((copy) => { copy.participants[0].unavailableReason = "station-area-unclassified"; });
  tamper((copy) => { copy.participants[0].terminal.arrivalAt = null; });
  tamper((copy) => { copy.participants[0].terminal.boardingStopId = "wrong-stop"; });
  tamper((copy) => { copy.participants[0]!.terminal.totalSeconds = (copy.participants[0]!.terminal.totalSeconds ?? 0) + 1; });
  tamper((copy) => { copy.participants[0].segments.pop(); });
  tamper((copy) => { const transit = copy.participants[0]!.segments.find((segment) => segment.kind === "transit"); if (!transit) throw new Error("Transit segment missing from fixture."); transit.source = "mvg-route"; });
  tamper((copy) => { const transit = copy.participants[0]!.segments.find((segment) => segment.kind === "transit"); if (!transit) throw new Error("Transit segment missing from fixture."); (transit.to as Record<string, unknown>).boardingStopId = "wrong-final-stop"; });
  tamper((copy) => { copy.basis.selectedTolerancePercent = 5; });
});

test("no-result and unclassified detail responses are explicit unavailable details", async () => {
  const cache = new InMemoryStationAreaCalculationBasisCache({ referenceFactory: () => `no-result-${Math.random()}` });
  const noSeeds: MeetingProviders = { ...PROVIDERS, scheduledAccess: { ...FIXTURE_SCHEDULED_ACCESS_PROVIDER, resolveAccessSeeds: async () => [] } };
  const calculate = await calculateRequest(cache, noSeeds);
  const reference = calculate.headers.get("Meeet-Calculation-Ref")!;
  let factoryCalls = 0;
  const detail = await detailsRequest(reference, cache, "fixture-a", REQUEST, () => { factoryCalls += 1; throw new Error("unavailable detail must not load providers"); });
  assert.equal(detail.status, 200);
  assert.equal(factoryCalls, 0);
  const body = await detail.json();
  assert.equal(body.status, "no-result");
  assert.ok(body.participants.every((participant: { status: string; segments: unknown[]; terminal: { totalSeconds: number | null }; unavailableReason: string | null }) => participant.status === "unavailable" && participant.segments.length === 0 && participant.terminal.totalSeconds === null && participant.unavailableReason));
  const unknown = await detailsRequest(reference, cache, "missing-area", REQUEST, () => { factoryCalls += 1; throw new Error("unknown area must not load providers"); });
  assert.equal(unknown.status, 404);
  assert.equal(factoryCalls, 0);
});

test("ok surfaces expose cached unclassified markers as explicit unavailable details without route work", async () => {
  const unreachableArea = {
    id: "fixture-unclassified",
    name: "Fixture Unclassified",
    coordinate: { latitude: 48.15, longitude: 11.65 },
    boardingStopIds: ["fixture-unclassified-stop"],
    parentStationId: null,
  } as const;
  const unreachableStop = {
    id: "fixture-unclassified-stop",
    name: "Fixture Unclassified platform",
    coordinate: unreachableArea.coordinate,
    stationAreaId: unreachableArea.id,
  } as const;
  const unreachableConnection = {
    ...FIXTURE_SCHEDULED_ARTIFACT.connections[0]!,
    id: "fixture-unclassified-connection",
    tripId: "fixture-unclassified-trip",
    fromStopId: unreachableStop.id,
    toStopId: unreachableStop.id,
    fromStationAreaId: unreachableArea.id,
    toStationAreaId: unreachableArea.id,
    fromStopSequence: 1,
    toStopSequence: 2,
    departureTimeSeconds: 40 * 60,
    arrivalTimeSeconds: 41 * 60,
  } as const;
  const artifact = {
    ...FIXTURE_SCHEDULED_ARTIFACT,
    stationAreas: [...FIXTURE_SCHEDULED_ARTIFACT.stationAreas, unreachableArea],
    boardingStops: [...FIXTURE_SCHEDULED_ARTIFACT.boardingStops, unreachableStop],
    connections: [...FIXTURE_SCHEDULED_ARTIFACT.connections, unreachableConnection],
  } satisfies ScheduledRoutingArtifact;
  let accessCalls = 0;
  const providers: MeetingProviders = {
    scheduledArtifact: artifact,
    scheduledAccess: {
      ...FIXTURE_SCHEDULED_ACCESS_PROVIDER,
      async resolveAccessSeeds(input): Promise<readonly ScheduledAccessSeedCandidate[]> {
        accessCalls += 1;
        const seeds = await FIXTURE_SCHEDULED_ACCESS_PROVIDER.resolveAccessSeeds(input);
        return seeds.filter((seed) => seed.stationAreaId === "fixture-a");
      },
    },
  };
  const cache = new InMemoryStationAreaCalculationBasisCache({ referenceFactory: () => "ok-unclassified-reference" });
  const calculation = await calculateRequest(cache, providers);
  assert.equal(calculation.status, 200);
  assert.equal(accessCalls, 2);
  const calculationBody = await calculation.json() as {
    contractVersion: string;
    status: string;
    stationAreas: Array<Record<string, unknown>>;
    metadata: { schedule: Record<string, unknown>; accessProvider: Record<string, unknown> };
  };
  assert.equal(calculationBody.contractVersion, "meeet-meeting/v3");
  assert.equal(calculationBody.status, "ok");
  const marker = calculationBody.stationAreas.find((candidate) => candidate.stationAreaId === unreachableArea.id);
  assert.deepEqual(marker, {
    stationAreaId: unreachableArea.id,
    name: unreachableArea.name,
    coordinate: unreachableArea.coordinate,
    redBoardingStopId: null,
    blueBoardingStopId: null,
    classification: "unclassified",
    redArrivalSeconds: null,
    blueArrivalSeconds: null,
    fasterParticipant: null,
    withinSelectedTolerance: false,
  });
  const reference = calculation.headers.get("Meeet-Calculation-Ref");
  assert.equal(reference, "ok-unclassified-reference");
  const detail = await detailsRequest(reference!, cache, unreachableArea.id, REQUEST, providers);
  assert.equal(detail.status, 200);
  assert.equal(accessCalls, 2);
  const detailBody = await detail.json() as {
    contractVersion: string;
    status: string;
    reason: string | null;
    stationArea: Record<string, unknown>;
    participants: Array<{ id: string; color: string; status: string; unavailableReason: string | null; terminal: { boardingStopId: string | null; totalSeconds: number | null; arrivalAt: string | null }; segments: readonly unknown[] }>;
    basis: { contractVersion: string; searchStartAt: string; selectedTolerancePercent: number; deterministicSelectionPolicy: string; schedule: Record<string, unknown>; accessProvider: Record<string, unknown> };
  };
  assert.equal(detailBody.contractVersion, "meeet-station-area-details/v1");
  assert.equal(detailBody.status, "ok");
  assert.equal(detailBody.reason, null);
  assert.deepEqual(detailBody.stationArea, marker);
  assert.equal(detailBody.basis.contractVersion, "meeet-meeting/v3");
  assert.equal(detailBody.basis.searchStartAt, REQUEST.searchStartAt.replace("+02:00", ".000Z").replace("08:05", "06:05"));
  assert.equal(detailBody.basis.selectedTolerancePercent, REQUEST.tolerancePercent);
  assert.equal(detailBody.basis.deterministicSelectionPolicy, "earliest-arrival/canonical-scan-first/v1");
  assert.deepEqual(detailBody.basis.schedule, calculationBody.metadata.schedule);
  assert.deepEqual(detailBody.basis.accessProvider, calculationBody.metadata.accessProvider);
  assert.deepEqual(detailBody.participants.map((participant) => [participant.id, participant.color, participant.status, participant.unavailableReason, participant.terminal, participant.segments]), [
    ["red", "red", "unavailable", "station-area-unclassified", { boardingStopId: null, totalSeconds: null, arrivalAt: null }, []],
    ["blue", "blue", "unavailable", "station-area-unclassified", { boardingStopId: null, totalSeconds: null, arrivalAt: null }, []],
  ]);
});

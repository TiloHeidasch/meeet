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
  FIXTURE_SCHEDULED_ACCESS_PROVIDER,
  FIXTURE_SCHEDULED_ARTIFACT,
} from "../lib/fixtures/scheduled-routing.ts";
import { parseScheduledMeetingRequest, type ScheduledMeetingStationAreaDto } from "../lib/validation/meeting-v3.ts";
import { validateStationAreaDetailsResponse } from "../lib/validation/station-area-details-v1.ts";
import type { MeetingProviders } from "../lib/domain/providers.ts";
import type { ScheduledRoutingArtifact } from "../lib/domain/scheduled-routing/models.ts";

const REQUEST = {
  contractVersion: "meeet-meeting/v3",
  participants: [
    { id: "red", origin: { label: "Red", latitude: 48.1374, longitude: 11.5755 }, mode: "transit" },
    { id: "blue", origin: { label: "Blue", latitude: 48.1400, longitude: 11.5700 }, mode: "transit" },
  ],
  tolerancePercent: 10,
  changeTimePreset: "medium",
  searchStartAt: "2026-08-11T08:05:00+02:00",
} as const;

const PROVIDERS: MeetingProviders = {
  scheduledArtifact: FIXTURE_SCHEDULED_ARTIFACT,
  scheduledAccess: FIXTURE_SCHEDULED_ACCESS_PROVIDER,
};

type MutableDetail = {
  stationArea: {
    stationAreaId: string;
    name: string;
    coordinate: { latitude: number; longitude: number };
    classification: string;
    redArrivalSeconds: number | null;
    blueArrivalSeconds: number | null;
    fasterParticipant: string | null;
    withinSelectedTolerance: boolean;
  };
  participants: Array<{
    status: string;
    unavailableReason: string | null;
    terminal: { totalSeconds: number | null; arrivalAt: string | null };
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

test("details assemble terminal totals and arrival instants from the cached marker without route work", async () => {
  const cache = new InMemoryStationAreaCalculationBasisCache({ referenceFactory: () => "marker-reference" });
  const calculate = await calculateRequest(cache);
  assert.equal(calculate.status, 200);
  const reference = calculate.headers.get("Meeet-Calculation-Ref");
  assert.equal(reference, "marker-reference");
  const calculationBody = await calculate.clone().json() as { stationAreas: Array<{ stationAreaId: string; redArrivalSeconds: number | null; blueArrivalSeconds: number | null }> };
  const marker = calculationBody.stationAreas.find((area) => area.stationAreaId === "fixture-c");
  assert.equal(marker?.redArrivalSeconds, 1_800);
  assert.equal(marker?.blueArrivalSeconds, 1_800);
  let accessCalls = 0;
  const noMvgProviders: MeetingProviders = {
    ...PROVIDERS,
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
  const detailBody = await detail.json() as {
    contractVersion: string;
    stationArea: { redArrivalSeconds: number | null };
    participants: Array<{ status: string; terminal: { totalSeconds: number | null; arrivalAt: string | null } }>;
    basis: { changeTimeSeconds: number };
  };
  assert.equal(detailBody.contractVersion, "meeet-station-area-details/v1");
  assert.equal(detailBody.stationArea.redArrivalSeconds, 1_800);
  assert.equal(detailBody.participants[0]?.status, "available");
  assert.equal(detailBody.participants[0]?.terminal.totalSeconds, 1_800);
  assert.equal(detailBody.participants[0]?.terminal.arrivalAt, "2026-08-11T06:35:00.000Z");
  assert.equal(detailBody.participants[1]?.terminal.totalSeconds, 1_800);
  assert.equal(detailBody.participants[1]?.terminal.arrivalAt, "2026-08-11T06:35:00.000Z");
  assert.equal(detailBody.basis.changeTimeSeconds, 300);
});

test("details reuse cached canonical seeds and never re-resolve access", async () => {
  let accessCalls = 0;
  const providers: MeetingProviders = {
    ...PROVIDERS,
    scheduledAccess: {
      ...FIXTURE_SCHEDULED_ACCESS_PROVIDER,
      async resolveAccessSeeds(input) {
        accessCalls += 1;
        return FIXTURE_SCHEDULED_ACCESS_PROVIDER.resolveAccessSeeds(input);
      },
    },
  };
  const cache = new InMemoryStationAreaCalculationBasisCache({ referenceFactory: () => "reuse-reference" });
  const calculate = await calculateRequest(cache, providers);
  assert.equal(calculate.status, 200);
  assert.equal(accessCalls, 2);
  const reference = calculate.headers.get("Meeet-Calculation-Ref");
  assert.ok(reference);
  const detail = await detailsRequest(reference!, cache, "fixture-c", REQUEST, providers);
  assert.equal(detail.status, 200);
  assert.equal(accessCalls, 2);
  const detailBody = await detail.json() as { participants: Array<{ terminal: { totalSeconds: number | null } }> };
  assert.equal(detailBody.participants[0]?.terminal.totalSeconds, 1_800);
});

test("non-exact provider coordinates cannot change canonical readiness, marker classification, or detail totals", async () => {
  const createBoundaryProvider = (shifted: boolean, calls: { count: number }): MeetingProviders => ({
    scheduledArtifact: FIXTURE_SCHEDULED_ARTIFACT,
    scheduledAccess: {
      ...FIXTURE_SCHEDULED_ACCESS_PROVIDER,
      async resolveAccessSeeds(input): Promise<readonly import("../lib/domain/providers.ts").ScheduledAccessSeedCandidate[]> {
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
            distanceMeters: 1,
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
    mode: "bus",
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
  const detailBody = await detail.json() as { stationArea: Record<string, unknown>; participants: Array<{ terminal: { totalSeconds: number | null } }> };
  assert.deepEqual(detailBody.stationArea, boundaryMarker);
  assert.deepEqual(detailBody.participants.map((participant) => participant.terminal.totalSeconds), [299, 330]);
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
  const detailBody = await detail.json() as { contractVersion: string; stationArea: { redArrivalSeconds: number | null }; participants: Array<{ terminal: { totalSeconds: number | null } }> };
  assert.equal(detailBody.contractVersion, "meeet-station-area-details/v1");
  assert.equal(detailBody.stationArea.redArrivalSeconds, 1_800);
  assert.equal(detailBody.participants[0]?.terminal.totalSeconds, 1_800);
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

test("strict detail validator rejects marker, terminal, basis, and tolerance tampering", async () => {
  const cache = new InMemoryStationAreaCalculationBasisCache({ referenceFactory: () => "tamper-reference" });
  const calculate = await calculateRequest(cache);
  const reference = calculate.headers.get("Meeet-Calculation-Ref")!;
  const response = await detailsRequest(reference, cache);
  assert.equal(response.status, 200);
  const valid = await response.json() as MutableDetail;
  const parsed = parseScheduledMeetingRequest(REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const context = { request: parsed.data, selectedMarker: valid.stationArea as ScheduledMeetingStationAreaDto, artifactIdentity: { feedId: FIXTURE_SCHEDULED_ARTIFACT.feedId, timeZone: FIXTURE_SCHEDULED_ARTIFACT.timeZone, scheduleContentHash: FIXTURE_SCHEDULED_ARTIFACT.provenance.contentHash, compiledArtifactId: FIXTURE_SCHEDULED_ARTIFACT.provenance.compiledArtifactId } };
  assert.equal(validateStationAreaDetailsResponse(valid, context).success, true);
  const tamper = (mutate: (copy: MutableDetail) => void) => {
    const copy = structuredClone(valid) as MutableDetail;
    mutate(copy);
    assert.equal(validateStationAreaDetailsResponse(copy, context).success, false);
  };
  tamper((copy) => { copy.stationArea.redArrivalSeconds = (copy.stationArea.redArrivalSeconds ?? 0) + 1; });
  tamper((copy) => { copy.participants[0].status = "unavailable"; });
  tamper((copy) => { copy.participants[0].unavailableReason = "station-area-unclassified"; });
  tamper((copy) => { copy.participants[0].terminal.arrivalAt = null; });
  tamper((copy) => { copy.participants[0]!.terminal.totalSeconds = (copy.participants[0]!.terminal.totalSeconds ?? 0) + 1; });
  tamper((copy) => { copy.basis.selectedTolerancePercent = 5; });
  tamper((copy) => { copy.basis.changeTimeSeconds = 600; });
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
  assert.ok(body.participants.every((participant: { status: string; terminal: { totalSeconds: number | null }; unavailableReason: string | null }) => participant.status === "unavailable" && participant.terminal.totalSeconds === null && participant.unavailableReason));
  const unknown = await detailsRequest(reference, cache, "missing-area", REQUEST, () => { factoryCalls += 1; throw new Error("unknown area must not load providers"); });
  assert.equal(unknown.status, 404);
  assert.equal(factoryCalls, 0);
});

test("ok surfaces expose cached unclassified markers as explicit unavailable details without route work", async () => {
  const unreachableArea = {
    id: "fixture-unclassified",
    name: "Fixture Unclassified",
    coordinate: { latitude: 48.15, longitude: 11.65 },
    mode: "bus",
  } as const;
  const unreachableConnection = {
    ...FIXTURE_SCHEDULED_ARTIFACT.connections[0]!,
    id: "fixture-unclassified-connection",
    tripId: "fixture-unclassified-trip",
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
    connections: [...FIXTURE_SCHEDULED_ARTIFACT.connections, unreachableConnection],
  } satisfies ScheduledRoutingArtifact;
  let accessCalls = 0;
  const providers: MeetingProviders = {
    scheduledArtifact: artifact,
    scheduledAccess: {
      ...FIXTURE_SCHEDULED_ACCESS_PROVIDER,
      async resolveAccessSeeds(input): Promise<readonly import("../lib/domain/providers.ts").ScheduledAccessSeedCandidate[]> {
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
    mode: "bus",
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
    participants: Array<{ id: string; color: string; status: string; unavailableReason: string | null; terminal: { totalSeconds: number | null; arrivalAt: string | null } }>;
    basis: { contractVersion: string; searchStartAt: string; selectedTolerancePercent: number; changeTimeSeconds: number; deterministicSelectionPolicy: string; schedule: Record<string, unknown>; accessProvider: Record<string, unknown> };
  };
  assert.equal(detailBody.contractVersion, "meeet-station-area-details/v1");
  assert.equal(detailBody.status, "ok");
  assert.equal(detailBody.reason, null);
  assert.deepEqual(detailBody.stationArea, marker);
  assert.equal(detailBody.basis.contractVersion, "meeet-meeting/v3");
  assert.equal(detailBody.basis.searchStartAt, REQUEST.searchStartAt.replace("+02:00", ".000Z").replace("08:05", "06:05"));
  assert.equal(detailBody.basis.selectedTolerancePercent, REQUEST.tolerancePercent);
  assert.equal(detailBody.basis.changeTimeSeconds, 300);
  assert.equal(detailBody.basis.deterministicSelectionPolicy, "earliest-arrival/canonical-scan-first/v1");
  assert.deepEqual(detailBody.basis.schedule, calculationBody.metadata.schedule);
  assert.deepEqual(detailBody.basis.accessProvider, calculationBody.metadata.accessProvider);
  assert.deepEqual(detailBody.participants.map((participant) => [participant.id, participant.color, participant.status, participant.unavailableReason, participant.terminal]), [
    ["red", "red", "unavailable", "station-area-unclassified", { totalSeconds: null, arrivalAt: null }],
    ["blue", "blue", "unavailable", "station-area-unclassified", { totalSeconds: null, arrivalAt: null }],
  ]);
});
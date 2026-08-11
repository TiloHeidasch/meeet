import assert from "node:assert/strict";
import test from "node:test";

import { validateMeetingCalculationResponse } from "../lib/domain/response.ts";
import type { GeoJsonLineString } from "../lib/domain/types.ts";

const FIXTURE_ARRIVAL = "2026-07-25T10:00:00.000Z";
const FIXTURE_ORIGINS = {
  one: { latitude: 48.1374, longitude: 11.5755 },
  two: { latitude: 48.145, longitude: 11.58 },
} as const;
const FIXTURE_TARGETS = {
  slow: { id: "station:fair-slow", coordinate: { latitude: 48.1461, longitude: 11.5661 } },
  fast: { id: "station:fair-fast", coordinate: { latitude: 48.1451, longitude: 11.5651 } },
} as const;

const VALID_V2_RESPONSE = createValidV2Response();

test("response validation accepts detailed Journey inspection data for Route-Derived Fair Locations with Sampled Coverage", () => {
  const result = validateMeetingCalculationResponse(cloneFixture());
  assert.equal(result.success, true);
});

test("response validation accepts valid Journey part geometry and rejects invalid geometry", () => {
  const valid = cloneFixture();
  valid.fairLocations[0]!.journeys[0]!.parts[0]!.geometry = {
    type: "LineString",
    coordinates: [[11.5755, 48.1374], [11.5756, 48.1375]],
  };
  assert.equal(validateMeetingCalculationResponse(valid).success, true);

  const invalid = cloneFixture();
  invalid.fairLocations[0]!.journeys[0]!.parts[0]!.geometry = {
    type: "LineString",
    coordinates: [[11.5755, 48.1374], [181, 48.1375]],
  };
  assert.equal(validateMeetingCalculationResponse(invalid).success, false);
});

test("Route-Derived Fair Location Journey tuples preserve snapshot participant order", () => {
  const reversed = cloneFixture();
  reversed.fairLocations.forEach((location) => location.journeys.reverse());
  assert.equal(validateMeetingCalculationResponse(reversed).success, false);
});

test("Route-Derived Fair Location Journeys require exactly one detailed Journey per snapshot participant", () => {
  const missingOrigin = cloneFixture();
  delete (missingOrigin.fairLocations[0]!.journeys[0] as Record<string, unknown>).origin;
  assert.equal(validateMeetingCalculationResponse(missingOrigin).success, false);

  const duplicate = cloneFixture();
  duplicate.fairLocations[0]!.journeys[1]!.participantId = "one";
  assert.equal(validateMeetingCalculationResponse(duplicate).success, false);

  const mismatched = cloneFixture();
  mismatched.fairLocations[0]!.journeys[1]!.participantId = "not-in-snapshot";
  assert.equal(validateMeetingCalculationResponse(mismatched).success, false);
});

test("detailed Journey origins and destinations bind to the Physical Transit Location", () => {
  const wrongOrigin = cloneFixture();
  wrongOrigin.fairLocations[0]!.journeys[0]!.origin.coordinate = { latitude: 48.138, longitude: 11.5755 };
  assert.equal(validateMeetingCalculationResponse(wrongOrigin).success, false);

  const wrongDestination = cloneFixture();
  wrongDestination.fairLocations[0]!.journeys[0]!.destination.coordinate = { latitude: 48.149, longitude: 11.5661 };
  assert.equal(validateMeetingCalculationResponse(wrongDestination).success, false);

  const wrongFinalPart = cloneFixture();
  const finalPart = wrongFinalPart.fairLocations[0]!.journeys[0]!.parts.at(-1)!;
  finalPart.to.coordinate = { latitude: 48.149, longitude: 11.5661 };
  assert.equal(validateMeetingCalculationResponse(wrongFinalPart).success, false);
});

test("final detailed Journey part endpoints use the shared 100m Fair Location binding policy", () => {
  const withinTolerance = cloneFixture();
  const validFinalPart = withinTolerance.fairLocations[0]!.journeys[0]!.parts.at(-1)!;
  validFinalPart.to.coordinate = { latitude: 48.1466, longitude: 11.5661 };
  assert.equal(validateMeetingCalculationResponse(withinTolerance).success, true);

  const beyondTolerance = cloneFixture();
  const invalidFinalPart = beyondTolerance.fairLocations[0]!.journeys[0]!.parts.at(-1)!;
  invalidFinalPart.to.coordinate = { latitude: 48.149, longitude: 11.5661 };
  assert.equal(validateMeetingCalculationResponse(beyondTolerance).success, false);
});

test("detailed Journey destination identities must match a colocated Physical Transit Location", () => {
  const nullDestinationIdentity = cloneFixture();
  nullDestinationIdentity.fairLocations[0]!.journeys[0]!.destination.stationGlobalId = null;
  assert.equal(validateMeetingCalculationResponse(nullDestinationIdentity).success, false);

  const wrongDestinationIdentity = cloneFixture();
  wrongDestinationIdentity.fairLocations[0]!.journeys[0]!.destination.stationGlobalId = "fair-fast";
  assert.equal(validateMeetingCalculationResponse(wrongDestinationIdentity).success, false);
});

test("detailed Journey parts preserve timing and connectivity", () => {
  const invalidPart = cloneFixture();
  invalidPart.fairLocations[0]!.journeys[0]!.parts[1]!.line = null;
  assert.equal(validateMeetingCalculationResponse(invalidPart).success, false);

  const incoherent = cloneFixture();
  incoherent.fairLocations[0]!.journeys[0]!.parts[1]!.plannedDepartureAt = "2026-07-25T09:40:30.000Z";
  assert.equal(validateMeetingCalculationResponse(incoherent).success, false);
});

test("Route-Derived Fair Location ordering uses exact duration and Physical Transit Location identity ties", () => {
  const unordered = cloneFixture();
  unordered.fairLocations[1] = fairLocation(FIXTURE_TARGETS.fast, "route-pattern:fixture", [1_080_000, 1_080_000]);
  const result = validateMeetingCalculationResponse(unordered);
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.issues.some((item) => item.code === "non_canonical_order"));
});

function cloneFixture(): typeof VALID_V2_RESPONSE {
  return JSON.parse(JSON.stringify(VALID_V2_RESPONSE)) as typeof VALID_V2_RESPONSE;
}

function createValidV2Response() {
  const boundary = {
    name: "OFFICIAL_MUNICH_STADTBEZIRKE_APPLICATION_COLLECTION",
    sourceUrl: "https://geoportal.muenchen.de/boundary",
    metadataUrl: "https://geoportal.muenchen.de/metadata",
    retrievedAt: "2026-07-26T07:59:12.816Z",
    contentHash: "472a20d0a34a3abbc06292985c2640fdbddd05131595356ef8a2aa271d372f97",
    metadataContentHash: "95b5f2b510794b4329a767dc1ed4b02c1ae2681dcb501cc48b0dd0fa7317db0d",
    districtCount: 25,
    license: { name: "DL-DE-BY-2.0", url: "https://www.govdata.de/dl-de/by-2-0" },
    attribution: "Landeshauptstadt München",
    legalBoundary: false,
  };
  const routingProvenance = {
    role: "routing",
    provider: "local-fixture",
    deployment: "fixture",
    dataKind: "demo-static",
    liveData: false,
    sourceUrl: null,
    license: null,
    attribution: "Local fixture",
    version: "fixture-v2",
    retrievedAt: "fixture-static",
    notes: "Self-contained validator fixture.",
    feeds: null,
  };
  const patternId = "route-pattern:fixture";
  const originStop = endpoint("station:origin", FIXTURE_ORIGINS.one);
  const fastStop = endpoint("fair-fast", FIXTURE_TARGETS.fast.coordinate);
  const slowStop = endpoint("fair-slow", FIXTURE_TARGETS.slow.coordinate);
  const routePattern = {
    id: patternId,
    kind: "transit",
    transitStops: [originStop, fastStop, slowStop],
    lines: [{ identity: "fixture-line", type: "BUS" }],
    parts: [
      journeyPart("walking", anonymous(FIXTURE_ORIGINS.one), originStop, "2026-07-25T09:30:00.000Z", "2026-07-25T09:35:00.000Z"),
      journeyPart("transit", originStop, slowStop, "2026-07-25T09:35:00.000Z", "2026-07-25T09:55:00.000Z", [fastStop]),
      journeyPart("walking", slowStop, anonymous(FIXTURE_ORIGINS.two), "2026-07-25T09:55:00.000Z", FIXTURE_ARRIVAL),
    ],
    provenance: [{ direction: "participant-1-to-participant-2", searchKind: "direct", anchorStationGlobalId: null }],
  };
  const searchCoverage = {
    method: "midpoint-directed-local-minimum/v1",
    exhaustive: false,
    evaluatedStationOccurrenceCount: 2,
    discoveredLocalMinimumOccurrenceCount: 2,
    termination: "local-minima-discovered",
    patterns: [{
      routePatternId: patternId,
      eligibleStationOccurrenceCount: 3,
      startTransitStopIndex: 1,
      evaluatedTransitStopIndexes: [1, 2],
      discoveredLocalMinimumTransitStopIndexes: [1, 2],
      termination: "local-minima-discovered",
    }],
  };
  const metadata = {
    routing: {
      name: "local-fixture-routing",
      deployment: "fixture",
      dataKind: "demo-static",
      liveData: false,
      asOf: FIXTURE_ARRIVAL,
      notes: "Self-contained validator fixture.",
      provenance: routingProvenance,
    },
    boundary,
    provenance: { routing: routingProvenance, boundary },
  };
  return {
    contractVersion: "meeet-meeting/v2",
    status: "ok",
    requestSnapshot: {
      participants: [
        { id: "one", location: { ...FIXTURE_ORIGINS.one, label: "First origin" }, mode: "transit" },
        { id: "two", location: { ...FIXTURE_ORIGINS.two, label: "Second origin" }, mode: "transit" },
      ],
      arrivalAt: FIXTURE_ARRIVAL,
      selectedTolerancePercent: 10,
      effectiveTolerancePercent: 10,
      timeZone: "Europe/Berlin",
    },
    fairLocations: [
      fairLocation(FIXTURE_TARGETS.slow, patternId, [1_080_000, 1_080_000]),
      fairLocation(FIXTURE_TARGETS.fast, patternId, [1_200_000, 1_260_000]),
    ],
    routePatterns: [routePattern],
    sourceQueries: sourceQueries(),
    metadata,
    searchCoverage,
  };
}

function fairLocation(
  target: { id: string; coordinate: { latitude: number; longitude: number } },
  patternId: string,
  durations: readonly [number, number],
) {
  return {
    id: target.id,
    label: target.id,
    kind: "station",
    physicalIdentity: target.id,
    coordinate: target.coordinate,
    journeys: [
      detailedJourney("one", FIXTURE_ORIGINS.one, target, durations[0]),
      detailedJourney("two", FIXTURE_ORIGINS.two, target, durations[1]),
    ],
    differenceMilliseconds: Math.abs(durations[0] - durations[1]),
    selectedTolerancePercent: 10,
    effectiveTolerancePercent: 10,
    sourceRoutePatternIds: [patternId],
  };
}

function detailedJourney(
  participantId: string,
  origin: { latitude: number; longitude: number },
  target: { id: string; coordinate: { latitude: number; longitude: number } },
  durationMilliseconds: number,
) {
  const departure = new Date(Date.parse(FIXTURE_ARRIVAL) - durationMilliseconds).toISOString();
  const transitDeparture = new Date(Date.parse(FIXTURE_ARRIVAL) - durationMilliseconds + 60_000).toISOString();
  const transitArrival = new Date(Date.parse(FIXTURE_ARRIVAL) - 60_000).toISOString();
  const originStop = endpoint(`station:origin:${participantId}`, origin);
  const targetStop = endpoint(target.id, target.coordinate);
  return {
    participantId,
    mode: "transit",
    plannedDepartureAt: departure,
    plannedArrivalAt: FIXTURE_ARRIVAL,
    plannedDurationMilliseconds: durationMilliseconds,
    source: "local-fixture-routing",
    origin: anonymous(origin),
    destination: endpoint(target.id.slice("station:".length), target.coordinate),
    parts: [
      journeyPart("walking", anonymous(origin), originStop, departure, transitDeparture),
      journeyPart("transit", originStop, targetStop, transitDeparture, transitArrival),
      journeyPart("walking", targetStop, anonymous(target.coordinate), transitArrival, FIXTURE_ARRIVAL),
    ],
  };
}

function sourceQueries() {
  const anchors = ["de:09162:6", "de:09162:50", "de:09162:70", "de:09162:1170", "de:09162:190", "de:09162:350"];
  return [
    ["participant-1-to-participant-2", "one", "two"],
    ["participant-2-to-participant-1", "two", "one"],
  ].flatMap(([direction, originParticipantId, destinationParticipantId]) => [
    {
      direction,
      searchKind: "direct",
      originParticipantId,
      destinationParticipantId,
      anchorStationGlobalId: null,
      viaDwellTimeInMinutes: null,
      arrivalAt: FIXTURE_ARRIVAL,
      journeyCount: 1,
      source: "local-fixture-routing",
    },
    ...anchors.map((anchorStationGlobalId) => ({
      direction,
      searchKind: "anchor",
      originParticipantId,
      destinationParticipantId,
      anchorStationGlobalId,
      viaDwellTimeInMinutes: 10,
      arrivalAt: FIXTURE_ARRIVAL,
      journeyCount: 1,
      source: "local-fixture-routing",
    })),
  ]);
}

function journeyPart(
  kind: "transit" | "walking",
  from: FixtureEndpoint,
  to: FixtureEndpoint,
  plannedDepartureAt: string,
  plannedArrivalAt: string,
  intermediateStops: readonly FixtureEndpoint[] = [],
  geometry: GeoJsonLineString | null = null,
) {
  return {
    kind,
    from,
    to,
    intermediateStops,
    line: kind === "transit" ? { identity: "fixture-line", type: "BUS" } : null,
    geometry,
    plannedDepartureAt,
    plannedArrivalAt,
  };
}

type FixtureEndpoint = { stationGlobalId: string | null; coordinate: { latitude: number; longitude: number } };

function endpoint(stationGlobalId: string | null, coordinate: { latitude: number; longitude: number }): FixtureEndpoint {
  return { stationGlobalId, coordinate };
}

function anonymous(coordinate: { latitude: number; longitude: number }): FixtureEndpoint {
  return endpoint(null, coordinate);
}

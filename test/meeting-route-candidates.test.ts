import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateMeeting,
  InvalidRoutingRequestError,
} from "../lib/domain/meeting.ts";
import type { MeetingProviders, RouteAlternativeProvider } from "../lib/domain/providers.ts";
import { FULL_ROUTING_PROVIDER_CAPABILITIES } from "../lib/domain/providers.ts";
import { isPointInGeoJsonGeometry } from "../lib/domain/geo.ts";
import type {
  LocationCoordinate,
  RouteAlternativeDiscoveryResult,
  RouteStationReference,
  RoutingMatrixRequest,
  RoutingMatrixResponse,
} from "../lib/domain/types.ts";
import { fixtureProviders } from "../lib/fixtures/providers.ts";
import { parseMvgRouteAlternatives } from "../lib/providers/mvg-direct.ts";
import { validateMeetingCalculationResponse } from "../lib/domain/response.ts";

const DEPARTURE = "2026-07-25T08:00:00.000Z";
const FIRST_ORIGIN: LocationCoordinate = { latitude: 48.1374, longitude: 11.5755 };
const SECOND_ORIGIN: LocationCoordinate = { latitude: 48.145, longitude: 11.58 };

test("route alternatives and hubs become one bounded matrix search ranked by verified variance", async () => {
  let alternativeCalls = 0;
  let matrixCalls = 0;
  let observedDestinationCount = 0;
  let observedPoiGeometry: Parameters<typeof isPointInGeoJsonGeometry>[1] | undefined;
  const providers = createRouteCandidateProviders({
    alternatives: async (request) => {
      alternativeCalls += 1;
      assert.equal(request.departureAt, DEPARTURE);
      return isFirstOrigin(request.origin)
        ? discoveryResult("a-station", "b-station", FIRST_ORIGIN, SECOND_ORIGIN, "mid-a")
        : discoveryResult("b-station", "a-station", SECOND_ORIGIN, FIRST_ORIGIN, "mid-b");
    },
    matrix: async (request) => {
      matrixCalls += 1;
      observedDestinationCount = request.destinations.length;
      return candidateMatrix(request, [10, 11]);
    },
    poi: async (geometry) => {
      observedPoiGeometry = geometry;
      return [
        poi("inside", [11.56667, 48.13333]),
        poi("outside", [11.52, 48.17]),
      ];
    },
  });

  const result = await calculateMeeting(
    {
      participants: [participant("one", FIRST_ORIGIN), participant("two", SECOND_ORIGIN)],
      tolerancePercent: 10,
      departureAt: DEPARTURE,
    },
    providers,
  );

  assert.equal(alternativeCalls, 2);
  assert.equal(matrixCalls, 1);
  assert.equal(observedDestinationCount, 5);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.meetingPoint.latitude, 48.13333);
  assert.equal(result.meetingPoint.longitude, 11.56667);
  assert.equal(result.candidates?.[0]?.id, "munich-hub:sendlinger-tor");
  assert.ok((result.candidates?.length ?? 0) <= 10);
  assert.equal(result.corridor.properties.kind, "route-candidate-search-area");
  assert.equal(result.corridor.properties.bufferRadiusMeters, 350);
  assert.match(result.corridor.properties.geometryGuarantee, /not independently routed/);
  assert.ok(observedPoiGeometry);
  assert.equal(result.pois.some((item) => item.id === "inside"), true);
  assert.equal(result.pois.some((item) => item.id === "outside"), false);
  const validation = validateMeetingCalculationResponse(result);
  assert.equal(validation.success, true, JSON.stringify(validation));
});

test("additional participants filter otherwise-valid route candidates", async () => {
  const providers = createRouteCandidateProviders({
    alternatives: async (request) => isFirstOrigin(request.origin)
      ? discoveryResult("a-station", "b-station", FIRST_ORIGIN, SECOND_ORIGIN, "mid-a")
      : discoveryResult("b-station", "a-station", SECOND_ORIGIN, FIRST_ORIGIN, "mid-b"),
    matrix: async (request) => candidateMatrix(request, [10, 11, 30]),
  });
  const result = await calculateMeeting(
    {
      participants: [
        participant("one", FIRST_ORIGIN),
        participant("two", SECOND_ORIGIN),
        participant("three", { latitude: 48.15, longitude: 11.55 }),
      ],
      tolerancePercent: 10,
      departureAt: DEPARTURE,
    },
    providers,
  );
  assert.equal(result.status, "no-corridor");
  if (result.status === "no-corridor") {
    assert.equal(result.reason.code, "NO_COMPARABLE_ROUTE_CANDIDATE");
    assert.equal(validateMeetingCalculationResponse(result).success, true);
  }
});

test("route-candidate anchor mode failures happen before alternative or geocoding calls", async () => {
  let geocodingCalls = 0;
  let alternativeCalls = 0;
  const providers = createRouteCandidateProviders({
    alternatives: async () => {
      alternativeCalls += 1;
      throw new Error("must not run");
    },
    matrix: async () => candidateMatrix({
      participants: [],
      destinations: [],
      departureAt: DEPARTURE,
    }, []),
  });
  providers.geocoding = {
    ...providers.geocoding,
    resolveLocation: async (location) => {
      geocodingCalls += 1;
      return { ...location, source: "test" };
    },
  };
  await assert.rejects(
    calculateMeeting(
      {
        participants: [
          { ...participant("one", FIRST_ORIGIN), mode: "bike" },
          participant("two", SECOND_ORIGIN),
        ],
        tolerancePercent: 10,
        departureAt: DEPARTURE,
      },
      providers,
    ),
    (error: unknown) =>
      error instanceof InvalidRoutingRequestError &&
      error.issues[0]?.code === "route_candidate_anchor_mode_unsupported",
  );
  assert.equal(geocodingCalls, 0);
  assert.equal(alternativeCalls, 0);
});

test("route-candidate response validation rejects missing verified-candidate data", async () => {
  const providers = createRouteCandidateProviders({
    alternatives: async (request) => isFirstOrigin(request.origin)
      ? discoveryResult("a-station", "b-station", FIRST_ORIGIN, SECOND_ORIGIN, "mid-a")
      : discoveryResult("b-station", "a-station", SECOND_ORIGIN, FIRST_ORIGIN, "mid-b"),
    matrix: async (request) => candidateMatrix(request, [10, 10]),
  });
  const result = await calculateMeeting(
    {
      participants: [participant("one", FIRST_ORIGIN), participant("two", SECOND_ORIGIN)],
      tolerancePercent: 10,
      departureAt: DEPARTURE,
    },
    providers,
  );
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const withoutCandidates = { ...result } as Record<string, unknown>;
  delete withoutCandidates.candidates;
  assert.equal(validateMeetingCalculationResponse(withoutCandidates).success, false);
});

test("route-candidate response validation rejects ranking and selected-result tampering", async () => {
  const providers = createRouteCandidateProviders({
    alternatives: async (request) => isFirstOrigin(request.origin)
      ? discoveryResult("a-station", "b-station", FIRST_ORIGIN, SECOND_ORIGIN, "mid-a")
      : discoveryResult("b-station", "a-station", SECOND_ORIGIN, FIRST_ORIGIN, "mid-b"),
    matrix: async (request) => candidateMatrix(request, [10, 11]),
  });
  const result = await calculateMeeting(
    {
      participants: [participant("one", FIRST_ORIGIN), participant("two", SECOND_ORIGIN)],
      tolerancePercent: 10,
      departureAt: DEPARTURE,
    },
    providers,
  );
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  const valid = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  const validCandidates = valid.candidates as Array<Record<string, unknown>>;
  assert.ok(validCandidates.length >= 2);
  assert.equal(validateMeetingCalculationResponse(valid).success, true);

  assertRejectedResponse(valid, (response) => {
    const candidates = response.candidates as Array<Record<string, unknown>>;
    candidates[0].normalizedSpread = 1;
    candidates[1].normalizedSpread = 0;
  }, "invalid_order");

  assertRejectedResponse(valid, (response) => {
    const candidates = response.candidates as Array<Record<string, unknown>>;
    candidates[0].normalizedSpread = 0;
    candidates[1].normalizedSpread = 0;
    candidates[0].maxTravelMinutes = 2;
    candidates[1].maxTravelMinutes = 1;
  }, "invalid_order");

  assertRejectedResponse(valid, (response) => {
    const candidates = response.candidates as Array<Record<string, unknown>>;
    candidates[0].normalizedSpread = 0;
    candidates[1].normalizedSpread = 0;
    candidates[0].maxTravelMinutes = 1;
    candidates[1].maxTravelMinutes = 1;
    candidates[0].id = "z-tampered-first";
    candidates[1].id = "a-tampered-second";
  }, "invalid_order");

  assertRejectedResponse(valid, (response) => {
    const meetingPoint = response.meetingPoint as Record<string, unknown>;
    meetingPoint.longitude = (meetingPoint.longitude as number) + 0.001;
  }, "mismatched_selection");

  assertRejectedResponse(valid, (response) => {
    const travelTimes = response.travelTimes as Array<Record<string, unknown>>;
    travelTimes[0].minutes = (travelTimes[0].minutes as number) + 1;
  }, "mismatched_selection");

  assertRejectedResponse(valid, (response) => {
    const travelTimeRange = response.travelTimeRange as Record<string, unknown>;
    travelTimeRange.targetMinutes = (travelTimeRange.targetMinutes as number) + 1;
  }, "mismatched_selection");
});

test("client-safe response validation preserves valid sample-grid responses", async () => {
  const result = await calculateMeeting(
    {
      participants: [participant("one", FIRST_ORIGIN), participant("two", FIRST_ORIGIN)],
      tolerancePercent: 10,
      departureAt: DEPARTURE,
    },
    fixtureProviders,
  );
  assert.equal(result.status, "ok");
  assert.equal(validateMeetingCalculationResponse(result).success, true);
});

function assertRejectedResponse(
  valid: Record<string, unknown>,
  mutate: (response: Record<string, unknown>) => void,
  code: string,
): void {
  const tampered = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
  mutate(tampered);
  const validation = validateMeetingCalculationResponse(tampered);
  assert.equal(validation.success, false);
  if (!validation.success) {
    assert.ok(validation.issues.some((issue) => issue.code === code));
  }
}

function createRouteCandidateProviders(options: {
  alternatives: RouteAlternativeProvider["discoverRouteAlternatives"];
  matrix: (request: RoutingMatrixRequest) => Promise<RoutingMatrixResponse>;
  poi?: (geometry: Parameters<typeof isPointInGeoJsonGeometry>[1]) => Promise<readonly ReturnType<typeof poi>[]>;
}): MeetingProviders {
  return {
    ...fixtureProviders,
    geocoding: fixtureProviders.geocoding,
    routeAlternatives: {
      descriptor: fixtureProviders.routing.descriptor,
      discoverRouteAlternatives: options.alternatives,
    },
    routing: {
      ...fixtureProviders.routing,
      capabilities: FULL_ROUTING_PROVIDER_CAPABILITIES,
      getTravelTimeMatrix: options.matrix,
    },
    poi: {
      ...fixtureProviders.poi,
      findFoodAndDrink: options.poi ?? (async () => []),
    },
  };
}

function discoveryResult(
  originId: string,
  destinationId: string,
  originCoordinate: LocationCoordinate,
  destinationCoordinate: LocationCoordinate,
  midpointId: string,
): RouteAlternativeDiscoveryResult {
  const origin = station(originId, originCoordinate);
  const destination = station(destinationId, destinationCoordinate);
  const alternatives = parseMvgRouteAlternatives(
    [{
      parts: [
        {
          from: { stationGlobalId: originId, ...originCoordinate },
          to: {
            stationGlobalId: midpointId,
            latitude: midpointId === "mid-a" ? 48.14 : 48.14,
            longitude: midpointId === "mid-a" ? 11.57 : 11.58,
            plannedDeparture: "2026-07-25T08:10:00.000Z",
          },
          line: { transportType: "BUS", name: `${midpointId}-line` },
        },
        {
          from: {
            stationGlobalId: midpointId,
            latitude: 48.14,
            longitude: midpointId === "mid-a" ? 11.57 : 11.58,
          },
          to: {
            stationGlobalId: destinationId,
            ...destinationCoordinate,
            plannedDeparture: "2026-07-25T08:30:00.000Z",
          },
          line: { transportType: "BUS", name: `${midpointId}-line` },
        },
      ],
    }],
    origin,
    destination,
    DEPARTURE,
  );
  return {
    originStation: origin,
    destinationStation: destination,
    alternatives,
  };
}

function candidateMatrix(
  request: RoutingMatrixRequest,
  defaultMinutes: readonly number[],
): RoutingMatrixResponse {
  const travelTimes = request.participants.flatMap((participant, participantIndex) =>
    request.destinations.map((destination) => {
      const minutes = destination.id === "munich-hub:odeonsplatz"
        ? defaultMinutes[participantIndex] + (participantIndex === 0 ? 10 : 20)
        : destination.id === "munich-hub:sendlinger-tor"
        ? participantIndex < 2 ? 10 : defaultMinutes[participantIndex]
        : destination.id.startsWith("route-station:")
        ? defaultMinutes[participantIndex] + 1
        : defaultMinutes[participantIndex];
      return {
        participantId: participant.participantId,
        destinationId: destination.id,
        mode: participant.mode,
        status: "ok" as const,
        minutes,
        source: "route-candidate-test",
      };
    }),
  );
  return {
    contractVersion: "meeet-routing-gateway/v1",
    departureAt: request.departureAt,
    travelTimes,
  };
}

function participant(id: string, location: LocationCoordinate) {
  return { id, location: { ...location, label: id }, mode: "transit" as const };
}

function station(id: string, coordinate: LocationCoordinate): RouteStationReference {
  return { id, coordinate };
}

function isFirstOrigin(coordinate: LocationCoordinate): boolean {
  return coordinate.latitude === FIRST_ORIGIN.latitude && coordinate.longitude === FIRST_ORIGIN.longitude;
}

function poi(id: string, coordinates: [number, number]) {
  return {
    id,
    name: id,
    category: "food" as const,
    coordinates,
    source: "test",
  };
}

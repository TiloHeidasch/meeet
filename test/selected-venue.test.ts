import assert from "node:assert/strict";
import test from "node:test";

import { handleSelectedVenueRoutesPost } from "../lib/domain/selected-venue.ts";
import type { MeetingProviders } from "../lib/domain/providers.ts";
import {
  validateSelectedVenueRouteResponse,
} from "../lib/domain/selected-venue-response.ts";
import type {
  RouteAlternative,
  RoutePart,
  RouteStationReference,
} from "../lib/domain/types.ts";
import { fixtureProviders } from "../lib/fixtures/providers.ts";

const DEPARTURE = "2026-07-25T08:00:00.000Z";
const FIRST_ORIGIN = { latitude: 48.1374, longitude: 11.5755 };
const SECOND_ORIGIN = { latitude: 48.145, longitude: 11.58 };
const VENUE = {
  id: "fixture-viktualienmarkt",
  name: "Viktualienmarkt",
  category: "food",
  coordinates: [11.5753, 48.1351],
  source: "test-poi",
};

test("selected venue routes return one summary leg per participant", async () => {
  const response = await handleSelectedVenueRoutesPost(jsonRequest({
    selectedPoi: VENUE,
    participants: [
      participant("one", FIRST_ORIGIN, "bike"),
      participant("two", SECOND_ORIGIN, "car"),
    ],
    departureAt: DEPARTURE,
  }), fixtureProviders);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(validateSelectedVenueRouteResponse(body).success, true);
  assert.equal(body.legs.length, 2);
  assert.ok(body.legs.every((leg: { status: string; geometry: unknown; durationMinutes: unknown }) =>
    leg.status === "summary" && leg.geometry === null && typeof leg.durationMinutes === "number"));
});

test("selected venue routes project the earliest transit alternative and stop geometry", async () => {
  const alternativeProvider = {
    descriptor: fixtureProviders.routing.descriptor,
    discoverRouteAlternatives: async () => ({
      originStation: station("origin", FIRST_ORIGIN),
      destinationStation: station("destination", { latitude: 48.1352, longitude: 11.5754 }),
      alternatives: [
        transitAlternative("late", "08:40:00.000Z"),
        transitAlternative("early", "08:25:00.000Z"),
      ],
    }),
  };
  const providers: MeetingProviders = {
    ...fixtureProviders,
    routeAlternatives: alternativeProvider,
  };
  const response = await handleSelectedVenueRoutesPost(jsonRequest({
    selectedPoi: VENUE,
    participants: [
      participant("one", FIRST_ORIGIN, "transit"),
      participant("two", SECOND_ORIGIN, "bike"),
    ],
    departureAt: DEPARTURE,
  }), providers);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.legs[0].status, "detailed");
  assert.equal(body.legs[0].steps[0].toStopId, "early-destination");
  assert.equal(body.legs[0].geometry.type, "LineString");
  assert.equal(body.legs[1].status, "summary");
  assert.equal(body.legs[1].geometry, null);
});

test("selected venue route provider failures become a 503 response", async () => {
  const providers: MeetingProviders = {
    ...fixtureProviders,
    routeAlternatives: {
      descriptor: fixtureProviders.routing.descriptor,
      discoverRouteAlternatives: async () => {
        throw new Error("upstream failed");
      },
    },
  };
  const response = await handleSelectedVenueRoutesPost(jsonRequest({
    selectedPoi: VENUE,
    participants: [
      participant("one", FIRST_ORIGIN, "transit"),
      participant("two", SECOND_ORIGIN, "transit"),
    ],
    departureAt: DEPARTURE,
  }), providers);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "PROVIDER_UNAVAILABLE");
});

function participant(
  id: string,
  coordinate: { latitude: number; longitude: number },
  mode: "transit" | "bike" | "car",
) {
  return {
    id,
    location: { ...coordinate, label: id },
    mode,
  };
}

function station(id: string, coordinate: { latitude: number; longitude: number }): RouteStationReference {
  return { id, coordinate };
}

function transitAlternative(id: string, arrival: string): RouteAlternative {
  const from = station("early-origin", FIRST_ORIGIN);
  const to = station(`${id}-destination`, { latitude: 48.1352, longitude: 11.5754 });
  const part: RoutePart = {
    from,
    to,
    plannedDepartureAt: "2026-07-25T08:05:00.000Z",
    plannedArrivalAt: `2026-07-25T${arrival}`,
    effectiveDepartureAt: "2026-07-25T08:05:00.000Z",
    effectiveArrivalAt: `2026-07-25T${arrival}`,
    line: { identity: "U3", type: "UBAHN" },
  };
  return {
    providerItineraryId: id,
    origin: from,
    destination: to,
    parts: [part],
    plannedDepartureAt: part.plannedDepartureAt,
    plannedArrivalAt: part.plannedArrivalAt,
    effectiveDepartureAt: part.effectiveDepartureAt,
    effectiveArrivalAt: part.effectiveArrivalAt,
    usedRealtime: false,
    itineraryIdentity: id,
    structuralPathIdentity: id,
  };
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/meeting/venue-routes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

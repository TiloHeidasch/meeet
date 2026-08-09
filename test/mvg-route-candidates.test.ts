import assert from "node:assert/strict";
import test from "node:test";

import type { RouteStationReference } from "../lib/domain/types.ts";
import {
  deriveRouteCandidates,
  routeItineraryIdentity,
  routeStructuralPathIdentity,
  selectRouteMidpointCandidate,
} from "../lib/domain/route-candidates.ts";
import type { FetchImplementation } from "../lib/providers/http.ts";
import {
  MVG_DIRECT_MAX_ROUTE_ALTERNATIVES,
  MVG_DIRECT_MAX_ROUTE_PARTS,
  MVG_DIRECT_NEARBY_URL,
  MVG_DIRECT_ROUTES_URL,
  MvgDirectRoutingProvider,
  parseMvgRouteAlternatives,
} from "../lib/providers/mvg-direct.ts";

const READY = "2026-07-25T08:00:00.000Z";
const ORIGIN = station("origin", { latitude: 48.1374, longitude: 11.5755 });
const DESTINATION = station("destination", { latitude: 48.145, longitude: 11.58 });

test("route alternatives retain distinct paths and collapse exact duplicate rows", () => {
  const bus = route("bus", [
    part("origin", "bus-change", "2026-07-25T08:10:00.000Z", "BUS"),
    part("bus-change", "destination", "2026-07-25T08:30:00.000Z", "BUS"),
  ]);
  const sbahn = route("sbahn", [
    part("origin", "rail-change", "2026-07-25T08:12:00.000Z", "SBAHN"),
    part("rail-change", "destination", "2026-07-25T08:32:00.000Z", "SBAHN"),
  ]);
  const ubahn = route("ubahn", [
    part("origin", "u-change", "2026-07-25T08:11:00.000Z", "UBAHN"),
    part("u-change", "destination", "2026-07-25T08:31:00.000Z", "UBAHN"),
  ]);
  const alternatives = parseMvgRouteAlternatives(
    [bus, bus, sbahn, ubahn],
    ORIGIN,
    DESTINATION,
    READY,
  );

  assert.equal(alternatives.length, 3);
  assert.deepEqual(
    new Set(alternatives.map((alternative) => alternative.parts[0].line.type)),
    new Set(["BUS", "SBAHN", "UBAHN"]),
  );
  assert.ok(alternatives.every((alternative) =>
    alternative.itineraryIdentity.includes("plannedDepartureAt") &&
    alternative.structuralPathIdentity.includes("parts"),
  ));
  assert.notEqual(
    alternatives[0].itineraryIdentity,
    alternatives[1].structuralPathIdentity,
  );
  assert.equal(
    routeItineraryIdentity(alternatives[0]),
    alternatives[0].itineraryIdentity,
  );
  assert.equal(
    routeStructuralPathIdentity(alternatives[0]),
    alternatives[0].structuralPathIdentity,
  );
});

test("same provider itinerary identity with conflicting timing fails closed", () => {
  const first = route("conflict", [
    part("origin", "change", "2026-07-25T08:10:00.000Z", "BUS"),
    part("change", "destination", "2026-07-25T08:30:00.000Z", "BUS"),
  ]);
  const conflicting = route("conflict", [
    part("origin", "change", "2026-07-25T08:10:00.000Z", "BUS"),
    part("change", "destination", "2026-07-25T08:31:00.000Z", "BUS"),
  ]);
  assert.throws(
    () => parseMvgRouteAlternatives(
      [first, conflicting],
      ORIGIN,
      DESTINATION,
      READY,
    ),
    /conflicting itinerary timing/,
  );
});

test("provider IDs remain conflict-tracked through exact timed deduplication", () => {
  const providerA = route("provider-a", [
    part("origin", "change", "2026-07-25T08:10:00.000Z", "BUS"),
    part("change", "destination", "2026-07-25T08:30:00.000Z", "BUS"),
  ]);
  const providerBExact = route("provider-b", [
    part("origin", "change", "2026-07-25T08:10:00.000Z", "BUS"),
    part("change", "destination", "2026-07-25T08:30:00.000Z", "BUS"),
  ]);
  const providerBConflict = route("provider-b", [
    part("origin", "change", "2026-07-25T08:10:00.000Z", "BUS"),
    part("change", "destination", "2026-07-25T08:31:00.000Z", "BUS"),
  ]);
  assert.throws(
    () => parseMvgRouteAlternatives(
      [providerA, providerBExact, providerBConflict],
      ORIGIN,
      DESTINATION,
      READY,
    ),
    /conflicting itinerary timing/,
  );
});

test("no-ID alternatives with one structural path retain different timetables", () => {
  const earlier = route(null, [
    part("origin", "change", "2026-07-25T08:10:00.000Z", "BUS"),
    part("change", "destination", "2026-07-25T08:30:00.000Z", "BUS"),
  ]);
  const later = route(null, [
    part("origin", "change", "2026-07-25T08:15:00.000Z", "BUS"),
    part("change", "destination", "2026-07-25T08:35:00.000Z", "BUS"),
  ]);
  const alternatives = parseMvgRouteAlternatives(
    [earlier, later, earlier],
    ORIGIN,
    DESTINATION,
    READY,
  );
  assert.equal(alternatives.length, 2);
  assert.equal(alternatives[0].structuralPathIdentity, alternatives[1].structuralPathIdentity);
  assert.notEqual(alternatives[0].itineraryIdentity, alternatives[1].itineraryIdentity);
});

test("no-ID alternatives with matching planned timing retain different effective timing", () => {
  const scheduled = route(null, [
    part("origin", "change", "2026-07-25T08:10:00.000Z", "BUS"),
    part("change", "destination", "2026-07-25T08:30:00.000Z", "BUS"),
  ]);
  const realtime = route(null, [
    part("origin", "change", "2026-07-25T08:10:00.000Z", "BUS"),
    part("change", "destination", "2026-07-25T08:30:00.000Z", "BUS", {}, {
      realTime: true,
      arrivalDelayInMinutes: 5,
    }),
  ]);
  const alternatives = parseMvgRouteAlternatives(
    [scheduled, realtime, scheduled],
    ORIGIN,
    DESTINATION,
    READY,
  );
  assert.equal(alternatives.length, 2);
  assert.equal(alternatives[0].itineraryIdentity, alternatives[1].itineraryIdentity);
  assert.notEqual(alternatives[0].effectiveArrivalAt, alternatives[1].effectiveArrivalAt);
});

test("overlapping parts and invalid negative effective arrivals fail closed", () => {
  const overlap = route(null, [
    part("origin", "change", "2026-07-25T08:20:00.000Z", "BUS"),
    part("change", "destination", "2026-07-25T08:40:00.000Z", "BUS", {}, {
      fromPlannedDeparture: "2026-07-25T08:15:00.000Z",
    }),
  ]);
  assert.throws(
    () => parseMvgRouteAlternatives([overlap], ORIGIN, DESTINATION, READY),
    /overlapping parts/,
  );

  const plannedArrivalBeforeDeparture = route(null, [
    part("origin", "destination", "2026-07-25T08:20:00.000Z", "BUS", {}, {
      fromPlannedDeparture: "2026-07-25T08:30:00.000Z",
      realTime: true,
      arrivalDelayInMinutes: 20,
    }),
  ]);
  assert.throws(
    () => parseMvgRouteAlternatives([plannedArrivalBeforeDeparture], ORIGIN, DESTINATION, READY),
    /reversed planned timestamps/,
  );

  const negativeEffectiveArrival = route(null, [
    part("origin", "change", "2026-07-25T08:20:00.000Z", "BUS"),
    part("change", "destination", "2026-07-25T08:30:00.000Z", "BUS", {}, {
      fromPlannedDeparture: "2026-07-25T08:20:00.000Z",
      realTime: true,
      arrivalDelayInMinutes: -15,
    }),
  ]);
  assert.throws(
    () => parseMvgRouteAlternatives([negativeEffectiveArrival], ORIGIN, DESTINATION, READY),
    /effective arrival/,
  );
});

test("malformed alternatives are rejected while pedestrian-only alternatives are ignored", () => {
  const pedestrian = route("walk", [
    part("origin", "destination", "2026-07-25T08:20:00.000Z", "FOOT"),
  ]);
  assert.deepEqual(
    parseMvgRouteAlternatives([pedestrian], ORIGIN, DESTINATION, READY),
    [],
  );
  assert.throws(
    () => parseMvgRouteAlternatives(
      [{ parts: [{ from: { stationGlobalId: "origin" }, to: { stationGlobalId: "destination", plannedDeparture: "invalid" } }] }],
      ORIGIN,
      DESTINATION,
      READY,
    ),
    /transit line|timestamp/,
  );
  assert.throws(
    () => parseMvgRouteAlternatives(
      [route("broken", [
        part("origin", "change-a", "2026-07-25T08:10:00.000Z", "BUS"),
        part("change-b", "destination", "2026-07-25T08:30:00.000Z", "BUS"),
      ])],
      ORIGIN,
      DESTINATION,
      READY,
    ),
    /not continuous/,
  );
  assert.throws(
    () => parseMvgRouteAlternatives(
      Array.from({ length: MVG_DIRECT_MAX_ROUTE_ALTERNATIVES + 1 }, () => pedestrian),
      ORIGIN,
      DESTINATION,
      READY,
    ),
    /alternative limit/,
  );
  assert.throws(
    () => parseMvgRouteAlternatives(
      [route("too-many-parts", Array.from({ length: MVG_DIRECT_MAX_ROUTE_PARTS + 1 }, (_, index) =>
        part(index === 0 ? "origin" : `station-${index - 1}`, `station-${index}`, `2026-07-25T08:${String(index + 1).padStart(2, "0")}:00.000Z`, "BUS"),
      ))],
      ORIGIN,
      DESTINATION,
      READY,
    ),
    /parts array/,
  );
});

test("midpoint candidates use actual endpoint coordinates and skip missing midpoint endpoints", () => {
  const alternative = parseMvgRouteAlternatives(
    [route("midpoint", [
      part("origin", "midpoint", "2026-07-25T08:10:00.000Z", "BUS", {
        from: ORIGIN.coordinate!,
        to: { latitude: 48.14, longitude: 11.57 },
      }),
      part("midpoint", "destination", "2026-07-25T08:30:00.000Z", "BUS", {
        from: { latitude: 48.14, longitude: 11.57 },
        to: DESTINATION.coordinate!,
      }),
    ])],
    ORIGIN,
    DESTINATION,
    READY,
  )[0];
  assert.ok(alternative);
  const candidate = selectRouteMidpointCandidate(alternative);
  assert.deepEqual(candidate?.coordinate, { latitude: 48.14, longitude: 11.57 });
  assert.notDeepEqual(candidate?.coordinate, {
    latitude: (ORIGIN.coordinate!.latitude + DESTINATION.coordinate!.latitude) / 2,
    longitude: (ORIGIN.coordinate!.longitude + DESTINATION.coordinate!.longitude) / 2,
  });

  const missingMidpoint = parseMvgRouteAlternatives(
    [route("missing-midpoint", [
      part("origin", "midpoint", "2026-07-25T08:10:00.000Z", "BUS", {
        from: ORIGIN.coordinate!,
      }),
      part("midpoint", "destination", "2026-07-25T08:30:00.000Z", "BUS", {
        to: DESTINATION.coordinate!,
      }),
    ])],
    ORIGIN,
    DESTINATION,
    READY,
  )[0];
  assert.equal(selectRouteMidpointCandidate(missingMidpoint), null);
  assert.equal(deriveRouteCandidates([alternative, alternative]).length, 1);
});

test("direct alternative discovery looks up both endpoints and keeps routes uncached", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const fetchImplementation: FetchImplementation = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.pathname === new URL(MVG_DIRECT_NEARBY_URL).pathname) {
      const isOrigin = url.searchParams.get("latitude") === "48.137";
      return Response.json({ stations: [{
        globalId: isOrigin ? "origin" : "destination",
        latitude: isOrigin ? ORIGIN.coordinate!.latitude : DESTINATION.coordinate!.latitude,
        longitude: isOrigin ? ORIGIN.coordinate!.longitude : DESTINATION.coordinate!.longitude,
      }] });
    }
    assert.equal(url.pathname, new URL(MVG_DIRECT_ROUTES_URL).pathname);
    assert.equal(url.searchParams.has("via"), false);
    assert.equal(url.searchParams.has("offset"), false);
    assert.equal(url.searchParams.has("page"), false);
    return Response.json([route("provider-route", [
      part("origin", "change", "2026-07-25T08:10:00.000Z", "BUS", {
        from: ORIGIN.coordinate!,
        to: { latitude: 48.14, longitude: 11.57 },
      }),
      part("change", "destination", "2026-07-25T08:30:00.000Z", "BUS", {
        from: { latitude: 48.14, longitude: 11.57 },
        to: DESTINATION.coordinate!,
      }),
    ])]);
  };
  const provider = new MvgDirectRoutingProvider(
    { matrixDeadlineMs: 1_000 },
    fetchImplementation,
  );
  const request = {
    origin: ORIGIN.coordinate!,
    destination: DESTINATION.coordinate!,
    departureAt: READY,
  };
  const result = await provider.discoverRouteAlternatives(request);
  await provider.discoverRouteAlternatives(request);

  assert.equal(result.alternatives.length, 1);
  assert.equal(result.originStation?.id, "origin");
  assert.equal(result.destinationStation?.id, "destination");
  assert.equal(requests.filter(({ url }) => url.pathname === new URL(MVG_DIRECT_ROUTES_URL).pathname).length, 2);
  assert.equal(requests.filter(({ url }) => url.pathname === new URL(MVG_DIRECT_NEARBY_URL).pathname).length, 4);
  assert.ok(requests.every(({ init }) => init?.cache === "no-store" && init.next === undefined && init.redirect === "error"));
});

function station(id: string, coordinate: { latitude: number; longitude: number }): RouteStationReference {
  return { id, coordinate };
}

function route(id: string | null, parts: readonly Record<string, unknown>[]): Record<string, unknown> {
  return id === null ? { parts } : { id, parts };
}

function part(
  from: string,
  to: string,
  plannedArrival: string,
  transportType: string,
  coordinates: {
    from?: { latitude: number; longitude: number };
    to?: { latitude: number; longitude: number };
  } = {},
  options: {
    fromPlannedDeparture?: string;
    realTime?: boolean;
    arrivalDelayInMinutes?: number;
  } = {},
): Record<string, unknown> {
  return {
    from: {
      stationGlobalId: from,
      ...(options.fromPlannedDeparture === undefined
        ? {}
        : { plannedDeparture: options.fromPlannedDeparture }),
      ...(coordinates.from ?? {}),
    },
    to: {
      stationGlobalId: to,
      plannedDeparture: plannedArrival,
      ...(options.arrivalDelayInMinutes === undefined
        ? {}
        : { arrivalDelayInMinutes: options.arrivalDelayInMinutes }),
      ...(coordinates.to ?? {}),
    },
    line: {
      transportType,
      name: `${transportType}-line`,
    },
    ...(options.realTime === undefined ? {} : { realTime: options.realTime }),
  };
}

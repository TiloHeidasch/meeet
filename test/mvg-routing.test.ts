import assert from "node:assert/strict";
import test from "node:test";

import { calculateMeeting, MVG_ANCHOR_STATIONS } from "../lib/domain/meeting.ts";
import type { MeetingProviders } from "../lib/domain/providers.ts";
import type { FetchImplementation } from "../lib/providers/http.ts";
import { HttpProviderError } from "../lib/providers/http.ts";
import { fixtureProviders } from "../lib/fixtures/providers.ts";
import { createMeetingProviders } from "../lib/providers/factory.ts";
import {
  MVG_DIRECT_NEARBY_URL,
  MVG_DIRECT_ROUTES_URL,
  MvgDirectRoutingProvider,
  parseMvgCoordinateJourneys,
} from "../lib/providers/mvg-direct.ts";
import {
  ProviderConfigurationError,
  readProviderConfig,
} from "../lib/providers/config.ts";
import { handleMeetingPost } from "../lib/domain/meeting-api.ts";
import { validateMeetingCalculationResponse } from "../lib/domain/response.ts";
import {
  REICHENBACH_MVG_SNAPPED_ORIGIN,
  REICHENBACH_PARTICIPANT_ONE_TO_TARGET_ROUTE,
  REICHENBACH_PARTICIPANT_ONE_TO_TWO_ROUTE,
  REICHENBACH_PARTICIPANT_TWO,
  REICHENBACH_PARTICIPANT_TWO_TO_ONE_ROUTE,
  REICHENBACH_PARTICIPANT_TWO_TO_TARGET_ROUTE,
  REICHENBACH_REQUESTED_ORIGIN,
  REICHENBACH_TARGET,
} from "./mvg-riesser-route-fixture.ts";

const DEPARTURE = "2026-07-25T08:00:00.000Z";
const A = { latitude: 48.1374, longitude: 11.5755 };

test("direct mode composes fixtures with capped transit routing and rejects endpoint config", () => {
  const config = readProviderConfig({
    MEEET_PROVIDER_MODE: "mvg-direct-transit",
  });
  assert.equal(config.mode, "mvg-direct-transit");
  assert.equal(config.routingGatewayUrl, null);
  assert.equal(config.routingGatewayToken, null);
  assert.throws(
    () =>
      readProviderConfig({
        MEEET_PROVIDER_MODE: "mvg-direct-transit",
        MEEET_ROUTING_GATEWAY_URL: "https://must-not-be-used.example/matrix",
      }),
    ProviderConfigurationError,
  );
  assert.throws(
    () =>
      readProviderConfig({
        MEEET_PROVIDER_MODE: "mvg-direct-transit",
        MEEET_POI_SOURCE_URL: "https://must-not-be-used.example/poi",
      }),
    ProviderConfigurationError,
  );
  assert.throws(
    () =>
      readProviderConfig({
        MEEET_PROVIDER_MODE: "mvg-direct-transit",
        MEEET_PROVIDER_DEPLOYMENT: "self-hosted",
      }),
    ProviderConfigurationError,
  );
  assert.equal(
    readProviderConfig({
      MEEET_PROVIDER_MODE: "mvg-direct-transit",
      MEEET_PROVIDER_TIMEOUT_MS: "1000",
    }).timeoutMs,
    1000,
  );

  const providers = createMeetingProviders({ MEEET_PROVIDER_MODE: "mvg-direct-transit" });
  assert.strictEqual(providers.geocoding, fixtureProviders.geocoding);
  assert.strictEqual(providers.poi, fixtureProviders.poi);
  assert.notStrictEqual(providers.routing, fixtureProviders.routing);
  assert.strictEqual(providers.journey, providers.routing);
  assert.strictEqual(providers.routeAlternatives, providers.routing);
  assert.deepEqual(providers.routing.capabilities, {
    supportedModes: ["transit"],
    maxParticipants: 4,
    maxDestinations: 19,
    maxMatrixEntries: 76,
  });
});

test("direct domain capabilities reject bike before geocoding or fetch", async () => {
  let geocodingCalls = 0;
  let fetchCalls = 0;
  const direct = new MvgDirectRoutingProvider(async () => {
    fetchCalls += 1;
    return Response.json({ stations: [] });
  });
  const providers: MeetingProviders = {
    geocoding: {
      ...fixtureProviders.geocoding,
      resolveLocation: async (location) => {
        geocodingCalls += 1;
        return { ...location, source: "test" };
      },
    },
    routing: direct,
    poi: fixtureProviders.poi,
  };
  const response = await handleMeetingPost(
    jsonRequest({
      participants: [participant("one", "bike"), participant("two", "transit")],
      departureAt: DEPARTURE,
    }),
    providers,
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_REQUEST");
  assert.equal(geocodingCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("MVG walking pathPolyline decodes E5 coordinates in GeoJSON order", () => {
  const origin = { latitude: 48.13331, longitude: 11.5765 };
  const destination = { latitude: 48.1334, longitude: 11.5766 };
  const payload = [{ parts: [{
    from: { ...origin, plannedDeparture: "2026-07-25T08:00:00.000Z" },
    to: { ...destination, plannedDeparture: "2026-07-25T08:03:00.000Z" },
    line: { transportType: "FUSS" },
    pathPolyline: "e`xdHc`teAGIII",
  }] }];
  const journey = parseMvgCoordinateJourneys(payload, {
    origin,
    destination,
    arrivalAt: "2026-07-25T08:03:00.000Z",
    participantOriginEndpoint: "origin",
  })[0]!;

  assert.deepEqual(journey.parts[0]!.geometry, {
    type: "LineString",
    coordinates: [[11.5765, 48.13331], [11.57655, 48.13335], [11.5766, 48.1334]],
  });
});

test("malformed or endpoint-mismatched MVG path geometry degrades to null", () => {
  const origin = { latitude: 48.13331, longitude: 11.5765 };
  const destination = { latitude: 48.1334, longitude: 11.5766 };
  const basePart = {
    from: { ...origin, plannedDeparture: "2026-07-25T08:00:00.000Z" },
    to: { ...destination, plannedDeparture: "2026-07-25T08:03:00.000Z" },
    line: { transportType: "FUSS" },
    pathPolyline: "e`xdHc`teAGIII",
  };
  const malformed = parseMvgCoordinateJourneys([{ parts: [{ ...basePart, pathPolyline: "~" }] }], {
    origin,
    destination,
    arrivalAt: "2026-07-25T08:03:00.000Z",
    participantOriginEndpoint: "origin",
  });
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0]!.parts[0]!.geometry, null);

  const mismatchedOrigin = { latitude: 48.1355, longitude: 11.5765 };
  const mismatchedDestination = { latitude: 48.1356, longitude: 11.5766 };
  const mismatched = parseMvgCoordinateJourneys([{ parts: [{
    ...basePart,
    from: { ...mismatchedOrigin, plannedDeparture: basePart.from.plannedDeparture },
    to: { ...mismatchedDestination, plannedDeparture: basePart.to.plannedDeparture },
  }] }], {
    origin: mismatchedOrigin,
    destination: mismatchedDestination,
    arrivalAt: "2026-07-25T08:03:00.000Z",
    participantOriginEndpoint: "origin",
  });
  assert.equal(mismatched.length, 1);
  assert.equal(mismatched[0]!.parts[0]!.geometry, null);
});

test("MVG permits a nearby anonymous first participant-origin snap and keeps destination strict", () => {
  const origin = { latitude: 48.1374, longitude: 11.5755 };
  const destination = { latitude: 48.145, longitude: 11.58 };
  const request = { origin, destination, arrivalAt: "2026-07-25T08:25:00.000Z", participantOriginEndpoint: "origin" as const };
  const route = {
    parts: [
      {
        from: { latitude: origin.latitude + 0.00007, longitude: origin.longitude, plannedDeparture: "2026-07-25T08:00:00.000Z" },
        to: { stationGlobalId: "origin-station", latitude: 48.138, longitude: 11.576, plannedDeparture: "2026-07-25T08:05:00.000Z" },
        line: { transportType: "FUSS" },
      },
      {
        from: { stationGlobalId: "origin-station", latitude: 48.138, longitude: 11.576, plannedDeparture: "2026-07-25T08:05:00.000Z" },
        to: { stationGlobalId: "destination-station", latitude: 48.144, longitude: 11.579, plannedDeparture: "2026-07-25T08:20:00.000Z" },
        line: { transportType: "BUS" },
      },
      {
        from: { stationGlobalId: "destination-station", latitude: 48.144, longitude: 11.579, plannedDeparture: "2026-07-25T08:20:00.000Z" },
        to: { latitude: destination.latitude, longitude: destination.longitude, plannedDeparture: "2026-07-25T08:25:00.000Z" },
        line: { transportType: "FUSS" },
      },
    ],
  };
  const parsed = parseMvgCoordinateJourneys([route], request)[0]!;
  assert.deepEqual(parsed.parts[0]!.from.coordinate, origin);
  assert.deepEqual(parsed.parts.at(-1)!.to.coordinate, destination);

  const tooFar = structuredClone(route);
  tooFar.parts[0]!.from.latitude = origin.latitude + 0.0012;
  assert.throws(() => parseMvgCoordinateJourneys([tooFar], request), /not bound/);

  const tooFarDestination = structuredClone(route);
  tooFarDestination.parts.at(-1)!.to.longitude = destination.longitude + 0.002;
  assert.throws(() => parseMvgCoordinateJourneys([tooFarDestination], request), /not bound/);

  const identified = structuredClone(route);
  identified.parts[0]!.from.stationGlobalId = "anonymous-origin-station";
  const identifiedParsed = parseMvgCoordinateJourneys([identified], request)[0]!;
  assert.equal(identifiedParsed.parts[0]!.from.stationGlobalId, "anonymous-origin-station");
  assert.deepEqual(identifiedParsed.parts[0]!.from.coordinate, {
    latitude: origin.latitude + 0.00007,
    longitude: origin.longitude,
  });

  const transitAnonymous = structuredClone(route);
  (transitAnonymous.parts[1]!.from as Record<string, unknown>).stationGlobalId = null;
  assert.throws(() => parseMvgCoordinateJourneys([transitAnonymous], request), /invalid station identity/);
});

test("MVG binds only a declared final participant origin while keeping the other endpoint strict", () => {
  const origin = { latitude: 48.1374, longitude: 11.5755 };
  const destination = { latitude: 48.145, longitude: 11.58 };
  const request = {
    origin,
    destination,
    arrivalAt: "2026-07-25T08:25:00.000Z",
    participantOriginEndpoint: "destination" as const,
  };
  const route = {
    parts: [
      {
        from: { ...origin, plannedDeparture: "2026-07-25T08:00:00.000Z" },
        to: { stationGlobalId: "origin-station", latitude: 48.138, longitude: 11.576, plannedDeparture: "2026-07-25T08:05:00.000Z" },
        line: { transportType: "FUSS" },
      },
      {
        from: { stationGlobalId: "origin-station", latitude: 48.138, longitude: 11.576, plannedDeparture: "2026-07-25T08:05:00.000Z" },
        to: { stationGlobalId: "destination-station", latitude: 48.144, longitude: 11.579, plannedDeparture: "2026-07-25T08:20:00.000Z" },
        line: { transportType: "BUS" },
      },
      {
        from: { stationGlobalId: "destination-station", latitude: 48.144, longitude: 11.579, plannedDeparture: "2026-07-25T08:20:00.000Z" },
        to: { stationGlobalId: "", latitude: destination.latitude, longitude: destination.longitude + 0.00005, plannedDeparture: "2026-07-25T08:25:00.000Z" },
        line: { transportType: "FUSS" },
      },
    ],
  };
  const parsed = parseMvgCoordinateJourneys([route], request)[0]!;
  assert.deepEqual(parsed.parts.at(-1)!.to.coordinate, destination);

  const originParsed = parseMvgCoordinateJourneys([route], { ...request, participantOriginEndpoint: "origin" })[0]!;
  assert.equal(originParsed.parts.at(-1)!.to.stationGlobalId, null);
  assert.deepEqual(originParsed.parts.at(-1)!.to.coordinate, {
    latitude: destination.latitude,
    longitude: destination.longitude + 0.00005,
  });
});

test("direct provider enforces destination and matrix caps", async () => {
  let calls = 0;
  const provider = new MvgDirectRoutingProvider(async () => {
    calls += 1;
    return Response.json({ stations: [] });
  });
  await assert.rejects(
    provider.getTravelTimeMatrix({
      departureAt: DEPARTURE,
      participants: [
        { participantId: "one", origin: A, mode: "transit" },
        { participantId: "two", origin: A, mode: "transit" },
      ],
      destinations: Array.from({ length: 20 }, (_, index) => ({
        id: `d${index}`,
        coordinate: A,
        sampleKind: "center" as const,
      })),
    }),
    /19 destinations/,
  );
  assert.equal(calls, 0);
});

test("direct routing uses fixed encoded URLs, nearest station snapping, planned fallback, and walking", async () => {
  const requests: URL[] = [];
  const fetchImplementation: FetchImplementation = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname === MVG_DIRECT_NEARBY_URL.replace("https://www.mvg.de", "")) {
      const latitude = Number(url.searchParams.get("latitude"));
      const longitude = Number(url.searchParams.get("longitude"));
      return Response.json({
        stations: [
          { globalId: "far", latitude: latitude + 0.01, longitude },
          { globalId: `station-${latitude}`, latitude, longitude: longitude + 0.0001 },
        ],
      });
    }
    assert.equal(url.pathname, MVG_DIRECT_ROUTES_URL.replace("https://www.mvg.de", ""));
    assert.equal(url.searchParams.get("routingDateTimeIsArrival"), "false");
    assert.equal(
      url.searchParams.get("transportTypes"),
      "SCHIFF,UBAHN,TRAM,SBAHN,BUS,REGIONAL_BUS,BAHN",
    );
    assert.equal(url.searchParams.get("routingDateTime"), "2026-07-25T08:00:48.000Z");
    return Response.json([
      mvgRoute(url, "2026-07-25T08:35:00.000+00:00"),
      mvgRoute(url, "2026-07-25T08:20:00.000+00:00"),
    ]);
  };
  const provider = new MvgDirectRoutingProvider(fetchImplementation);
  const response = await provider.getTravelTimeMatrix({
    departureAt: DEPARTURE,
    participants: [{ participantId: "one", origin: A, mode: "transit" }],
    destinations: [
      {
        id: "destination",
        coordinate: { latitude: A.latitude + 0.0001, longitude: A.longitude },
        sampleKind: "center",
      },
    ],
  });
  assert.equal(response.travelTimes[0].status, "ok");
  assert.ok((response.travelTimes[0].minutes ?? 0) >= 20);
  assert.ok((response.travelTimes[0].minutes ?? 0) < 21);
  assert.deepEqual(response.timing, { dataKind: "scheduled", liveData: false });
  assert.equal(requests.length, 3);
  assert.equal(requests[0].origin, "https://www.mvg.de");
  assert.ok(requests.every((request) => request.pathname.startsWith("/api/bgw-pt/v3/")));
});

test("route alternatives with a valid shape but a neighboring endpoint do not discard matching alternatives", async () => {
  const provider = new MvgDirectRoutingProvider(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/nearby")) {
      const latitude = Number(url.searchParams.get("latitude"));
      const longitude = Number(url.searchParams.get("longitude"));
      return Response.json({ stations: [{ globalId: `station-${longitude}`, latitude, longitude }] });
    }
    const neighboring = mvgRoute(url, "2026-07-25T08:10:00.000+00:00");
    neighboring.parts[0].to.stationGlobalId = "neighboring-station";
    return Response.json([
      neighboring,
      mvgRoute(url, "2026-07-25T08:20:00.000+00:00"),
    ]);
  });
  const response = await provider.getTravelTimeMatrix({
    departureAt: DEPARTURE,
    participants: [{ participantId: "one", origin: A, mode: "transit" }],
    destinations: [{ id: "d", coordinate: { ...A, longitude: A.longitude + 0.001 }, sampleKind: "center" }],
  });
  assert.equal(response.travelTimes[0].status, "ok");
  assert.equal(response.travelTimes[0].minutes, 20.8);
});

test("a valid final-part realtime arrival delay changes duration and marks the matrix live", async () => {
  const provider = new MvgDirectRoutingProvider(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/nearby")) {
      const latitude = Number(url.searchParams.get("latitude"));
      const longitude = Number(url.searchParams.get("longitude"));
      return Response.json({ stations: [{ globalId: `station-${longitude}`, latitude, longitude }] });
    }
    return Response.json([
      mvgRoute(url, "2026-07-25T08:20:00.000+00:00", "BUS", {
        realTime: true,
        arrivalDelayInMinutes: 10,
      }),
    ]);
  });
  const response = await provider.getTravelTimeMatrix({
    departureAt: DEPARTURE,
    participants: [{ participantId: "one", origin: A, mode: "transit" }],
    destinations: [{ id: "d", coordinate: { ...A, longitude: A.longitude + 0.001 }, sampleKind: "center" }],
  });
  assert.equal(response.travelTimes[0].minutes, 30.8);
  assert.deepEqual(response.timing, { dataKind: "live", liveData: true });
});

test("a realtime alternative that is not selected keeps request metadata scheduled", async () => {
  const provider = new MvgDirectRoutingProvider(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/nearby")) {
      const latitude = Number(url.searchParams.get("latitude"));
      const longitude = Number(url.searchParams.get("longitude"));
      return Response.json({ stations: [{ globalId: `station-${longitude}`, latitude, longitude }] });
    }
    return Response.json([
      mvgRoute(url, "2026-07-25T08:20:00.000+00:00"),
      mvgRoute(url, "2026-07-25T08:10:00.000+00:00", "BUS", {
        realTime: true,
        arrivalDelayInMinutes: 20,
      }),
    ]);
  });
  const response = await provider.getTravelTimeMatrix({
    departureAt: DEPARTURE,
    participants: [{ participantId: "one", origin: A, mode: "transit" }],
    destinations: [{ id: "d", coordinate: { ...A, longitude: A.longitude + 0.001 }, sampleKind: "center" }],
  });
  assert.equal(response.travelTimes[0].minutes, 20.8);
  assert.deepEqual(response.timing, { dataKind: "scheduled", liveData: false });
});

test("empty nearby and route responses are unreachable, while same stations skip routes", async () => {
  let routeCalls = 0;
  const provider = new MvgDirectRoutingProvider(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/nearby")) {
      if (url.searchParams.get("longitude") === "11.577") {
        return Response.json({ stations: [] });
      }
      return Response.json({ stations: [{ globalId: "same", latitude: A.latitude, longitude: A.longitude }] });
    }
    routeCalls += 1;
    return Response.json([]);
  });
  const unreachable = await provider.getTravelTimeMatrix({
    departureAt: DEPARTURE,
    participants: [{ participantId: "one", origin: A, mode: "transit" }],
    destinations: [{ id: "empty", coordinate: { ...A, longitude: A.longitude + 0.001 }, sampleKind: "center" }],
  });
  assert.equal(unreachable.travelTimes[0].status, "unreachable");
  assert.equal(routeCalls, 0);

  const same = await provider.getTravelTimeMatrix({
    departureAt: DEPARTURE,
    participants: [{ participantId: "one", origin: A, mode: "transit" }],
    destinations: [{ id: "same", coordinate: A, sampleKind: "center" }],
  });
  assert.equal(same.travelTimes[0].status, "ok");
  assert.equal(same.travelTimes[0].minutes, 0);
  assert.equal(routeCalls, 0);
});

test("direct route parsing accepts only the captured parts shape and ignores pedestrian-only alternatives", async () => {
  const provider = new MvgDirectRoutingProvider(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/nearby")) {
      const latitude = Number(url.searchParams.get("latitude"));
      const longitude = Number(url.searchParams.get("longitude"));
      return Response.json({ stations: [{ globalId: `station-${longitude}`, latitude, longitude }] });
    }
    return Response.json([
      mvgRoute(url, "2026-07-25T08:10:00.000+00:00", "FUSS"),
    ]);
  });
  const pedestrian = await provider.getTravelTimeMatrix({
    departureAt: DEPARTURE,
    participants: [{ participantId: "one", origin: A, mode: "transit" }],
    destinations: [{ id: "d", coordinate: { ...A, longitude: A.longitude + 0.001 }, sampleKind: "center" }],
  });
  assert.equal(pedestrian.travelTimes[0].status, "unreachable");

  const malformed = new MvgDirectRoutingProvider(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/nearby")) {
      const latitude = Number(url.searchParams.get("latitude"));
      const longitude = Number(url.searchParams.get("longitude"));
      return Response.json({ stations: [{ globalId: `station-${longitude}`, latitude, longitude }] });
    }
    return Response.json({ routes: [] });
  });
  await assert.rejects(
    malformed.getTravelTimeMatrix({
      departureAt: DEPARTURE,
      participants: [{ participantId: "one", origin: A, mode: "transit" }],
      destinations: [{ id: "d", coordinate: { ...A, longitude: A.longitude + 0.001 }, sampleKind: "center" }],
    }),
  );
});

test("malformed, HTTP, and oversized upstream responses fail instead of becoming unreachable", async () => {
  for (const response of [
    Response.json({ stations: null }),
    Response.json({ error: "rate limited" }, { status: 429 }),
    Response.json({ error: "server error" }, { status: 503 }),
    new Response("not-json"),
  ]) {
    const provider = new MvgDirectRoutingProvider(async () => response);
    await assert.rejects(
      provider.getTravelTimeMatrix({
        departureAt: DEPARTURE,
        participants: [{ participantId: "one", origin: A, mode: "transit" }],
        destinations: [{ id: "d", coordinate: A, sampleKind: "center" }],
      }),
    );
  }
});

test("direct GETs reject genuine oversized responses and redirects", async () => {
  const oversized = new MvgDirectRoutingProvider(async () =>
    new Response("x".repeat(512 * 1024 + 1), {
      headers: { "content-type": "application/json" },
    }),
  );
  await assert.rejects(
    oversized.getTravelTimeMatrix({
      departureAt: DEPARTURE,
      participants: [{ participantId: "one", origin: A, mode: "transit" }],
      destinations: [{ id: "d", coordinate: A, sampleKind: "center" }],
    }),
    (error: unknown) =>
      error instanceof HttpProviderError && error.kind === "response-too-large",
  );

  const redirected = new MvgDirectRoutingProvider(
    (async () => ({
      ok: true,
      url: "https://redirect.example.test/api/bgw-pt/v3/stations/nearby",
      headers: new Headers(),
      body: Response.json({ stations: [] }).body,
    })) as unknown as FetchImplementation,
  );
  await assert.rejects(
    redirected.getTravelTimeMatrix({
      departureAt: DEPARTURE,
      participants: [{ participantId: "one", origin: A, mode: "transit" }],
      destinations: [{ id: "d", coordinate: A, sampleKind: "center" }],
    }),
    (error: unknown) => error instanceof HttpProviderError && error.kind === "http",
  );
});

test("direct matrix failure and deadline cancel queued work", async () => {
  let calls = 0;
  let active = 0;
  const failing = new MvgDirectRoutingProvider(async (input) => {
    calls += 1;
    active += 1;
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    const url = new URL(String(input));
    if (url.pathname.endsWith("/nearby")) {
      const latitude = Number(url.searchParams.get("latitude"));
      const longitude = Number(url.searchParams.get("longitude"));
      return Response.json({ stations: [{ globalId: `${latitude}:${longitude}`, latitude, longitude }] });
    }
    if (url.searchParams.get("originStationGlobalId")?.startsWith("48.137")) {
      return Response.json({ error: "failure" }, { status: 503 });
    }
    return Response.json([mvgRoute(url, "2026-07-25T08:30:00.000+00:00")]);
  });
  await assert.rejects(
    failing.getTravelTimeMatrix({
      departureAt: DEPARTURE,
      participants: [{ participantId: "one", origin: A, mode: "transit" }],
      destinations: Array.from({ length: 19 }, (_, index) => ({
        id: `d${index}`,
        coordinate: { latitude: A.latitude, longitude: A.longitude + (index + 1) * 0.0001 },
        sampleKind: "center" as const,
      })),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(calls < 39);
  assert.equal(active, 0);

  let deadlineFetches = 0;
  const deadline = new MvgDirectRoutingProvider(
    {
      timeoutMs: 1_000,
      maxResponseBytes: 128 * 1024,
      matrixDeadlineMs: 20,
    },
    (async (_input, init) => {
      deadlineFetches += 1;
      await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      throw new Error("unreachable");
    }) as FetchImplementation,
  );
  await assert.rejects(
    deadline.getTravelTimeMatrix({
      departureAt: DEPARTURE,
      participants: [{ participantId: "one", origin: A, mode: "transit" }],
      destinations: [{ id: "d", coordinate: A, sampleKind: "center" }],
    }),
  );
  assert.equal(deadlineFetches, 1);
});

test("direct request-local deduplication and concurrency stay within 99 calls and four active calls", async () => {
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const provider = new MvgDirectRoutingProvider(async (input) => {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    const url = new URL(String(input));
    if (url.pathname.endsWith("/nearby")) {
      const latitude = Number(url.searchParams.get("latitude"));
      const longitude = Number(url.searchParams.get("longitude"));
      return Response.json({ stations: [{ globalId: `${latitude}:${longitude}`, latitude, longitude }] });
    }
    return Response.json([mvgRoute(url, "2026-07-25T08:30:00.000+00:00")]);
  });
  const response = await provider.getTravelTimeMatrix({
    departureAt: DEPARTURE,
    participants: Array.from({ length: 4 }, (_, index) => ({
      participantId: `p${index}`,
      origin: { latitude: A.latitude + index * 0.0001, longitude: A.longitude },
      mode: "transit" as const,
    })),
    destinations: Array.from({ length: 19 }, (_, index) => ({
      id: `d${index}`,
      coordinate: { latitude: A.latitude, longitude: A.longitude + (index + 1) * 0.0001 },
      sampleKind: "center" as const,
    })),
  });
  assert.equal(response.travelTimes.length, 76);
  assert.ok(calls < 99);
  assert.ok(maximumActive <= 4);
});

test("the four-request limiter is shared by concurrent direct calculations", async () => {
  let active = 0;
  let maximumActive = 0;
  const fetchImplementation: FetchImplementation = async (input, init) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 3);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      }, { once: true });
    });
    active -= 1;
    const url = new URL(String(input));
    if (url.pathname.endsWith("/nearby")) {
      const latitude = Number(url.searchParams.get("latitude"));
      const longitude = Number(url.searchParams.get("longitude"));
      return Response.json({ stations: [{ globalId: `${latitude}:${longitude}`, latitude, longitude }] });
    }
    return Response.json([mvgRoute(url, "2026-07-25T08:20:00.000+00:00")]);
  };
  const request = (id: string) =>
    new MvgDirectRoutingProvider(fetchImplementation).getTravelTimeMatrix({
      departureAt: DEPARTURE,
      participants: [{ participantId: id, origin: A, mode: "transit" }],
      destinations: [{ id: `${id}-destination`, coordinate: { ...A, longitude: A.longitude + 0.001 }, sampleKind: "center" }],
    });
  await Promise.all([request("one"), request("two")]);
  assert.ok(maximumActive > 1);
  assert.ok(maximumActive <= 4);
});

test("incoming caller abort cancels active MVG fetches and queued matrix work", async () => {
  let fetchCalls = 0;
  let activeFetches = 0;
  let abortedFetches = 0;
  const fetchImplementation: FetchImplementation = async (input, init) => {
    fetchCalls += 1;
    activeFetches += 1;
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        activeFetches -= 1;
        callback();
      };
      const abort = () => {
        abortedFetches += 1;
        finish(() => reject(new Error("caller aborted")));
      };
      init?.signal?.addEventListener("abort", abort, { once: true });
      setTimeout(() => {
        finish(() => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/nearby")) {
            const latitude = Number(url.searchParams.get("latitude"));
            const longitude = Number(url.searchParams.get("longitude"));
            resolve(Response.json({ stations: [{ globalId: "station", latitude, longitude }] }));
          } else {
            resolve(Response.json([]));
          }
        });
      }, 100);
    });
  };
  const caller = new AbortController();
  const provider = new MvgDirectRoutingProvider(fetchImplementation);
  const matrix = provider.getTravelTimeMatrix({
    departureAt: DEPARTURE,
    participants: [{ participantId: "one", origin: A, mode: "transit" }],
    destinations: Array.from({ length: 19 }, (_, index) => ({
      id: `d${index}`,
      coordinate: { latitude: A.latitude, longitude: A.longitude + (index + 1) * 0.0001 },
      sampleKind: "center" as const,
    })),
    signal: caller.signal,
  });
  setTimeout(() => caller.abort(), 10);
  await assert.rejects(matrix);
  assert.ok(fetchCalls <= 4);
  assert.ok(abortedFetches > 0);
  assert.equal(activeFetches, 0);
});

test("canonical fixture results preserve demo attribution without legacy area fields", async () => {
  const result = await calculateMeeting({
    arrivalAt: DEPARTURE,
    tolerancePercent: 10,
    participants: [participant("one", "transit"), participant("two", "transit")],
  }, fixtureProviders);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.metadata.routing.dataKind, "demo-static");
  assert.equal(result.metadata.routing.liveData, false);
  assert.equal(validateMeetingCalculationResponse(result).success, true);
  assert.equal(Object.hasOwn(result, "corridor"), false);
  assert.equal(Object.hasOwn(result, "pois"), false);
});

test("the Reichenbachstraße to Rotkreuzplatz MVG API request completes parser and domain validation", async () => {
  const meetingInput = {
    participants: [
      {
        id: "participant-1",
        mode: "transit" as const,
        location: {
          label: "Reichenbachstraße 1",
          ...REICHENBACH_REQUESTED_ORIGIN,
        },
      },
      {
        id: "participant-2",
        mode: "transit" as const,
        location: {
          label: "Rotkreuzplatz",
          ...REICHENBACH_PARTICIPANT_TWO,
        },
      },
    ] as const,
    arrivalAt: "2026-08-10T09:10:00.000Z",
    tolerancePercent: 10 as const,
  };
  const requestedUrls: URL[] = [];
  const anchorPayloadSizes: number[] = [];
  const provider = new MvgDirectRoutingProvider((async (requestInput) => {
    const url = new URL(String(requestInput));
    requestedUrls.push(url);
    const payload = sanitizedReichenbachFixture(url);
    if (url.searchParams.has("viaStationGlobalId")) anchorPayloadSizes.push(payload.length);
    return Response.json(payload);
  }) as FetchImplementation);
  const providerResult = await provider.getCoordinateJourneys({
    origin: meetingInput.participants[0].location,
    destination: meetingInput.participants[1].location,
    arrivalAt: meetingInput.arrivalAt,
    participantOriginEndpoint: "origin",
  });
  assert.deepEqual(providerResult.journeys[0]!.parts[0]!.from.coordinate, {
    ...REICHENBACH_REQUESTED_ORIGIN,
  });
  const meetingDomainJourneyProvider = {
    descriptor: provider.descriptor,
    getCoordinateJourneys: async (request: Parameters<MvgDirectRoutingProvider["getCoordinateJourneys"]>[0]) => {
      const result = await provider.getCoordinateJourneys(request);
      const snapFirst = request.participantOriginEndpoint === "origin" && sameCoordinate(request.origin, REICHENBACH_REQUESTED_ORIGIN);
      const snapFinal = request.participantOriginEndpoint === "destination" && sameCoordinate(request.destination, REICHENBACH_REQUESTED_ORIGIN);
      if (!snapFirst && !snapFinal) return result;
      return {
        ...result,
        journeys: result.journeys.map((journey) => ({
          ...journey,
          parts: journey.parts.map((part, index) => ({
            ...part,
            ...(snapFirst && index === 0 ? { from: { ...part.from, coordinate: REICHENBACH_MVG_SNAPPED_ORIGIN } } : {}),
            ...(snapFinal && index === journey.parts.length - 1 ? { to: { ...part.to, coordinate: REICHENBACH_MVG_SNAPPED_ORIGIN } } : {}),
          })),
        })),
      };
    },
  };
  const response = await withFixedCurrentTime(() => handleMeetingPost(
    jsonRequest(meetingInput),
    {
      ...fixtureProviders,
      routing: provider,
      journey: meetingDomainJourneyProvider,
    },
  ));
  assert.equal(response.status, 200);
  const responseBody = await response.json() as { status?: string; fairLocations?: unknown[] };
  assert.equal(responseBody.status, "ok");
  assert.ok((responseBody.fairLocations?.length ?? 0) > 0);
  assert.equal(validateMeetingCalculationResponse(responseBody).success, true);
  const anchorRequests = requestedUrls.filter((url) => url.searchParams.has("viaStationGlobalId"));
  assert.equal(anchorRequests.length, MVG_ANCHOR_STATIONS.length * 2);
  assert.ok(anchorPayloadSizes.every((size) => size > 0));
  assert.deepEqual(
    new Set(anchorRequests.map((url) => url.searchParams.get("viaStationGlobalId"))),
    new Set(MVG_ANCHOR_STATIONS.map((anchor) => anchor.id)),
  );
});

function participant(id: string, mode: "transit" | "bike" | "car") {
  return { id, location: { ...A, label: "Marienplatz" }, mode };
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/meeting/calculate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Sanitized BGW PT v3 captured-shape fixture: routes are bare arrays of parts. */
function mvgRoute(
  url: URL,
  plannedDeparture: string,
  transportType = "BUS",
  realtime?: { realTime: boolean; arrivalDelayInMinutes?: number },
) {
  return {
    parts: [
      {
        from: { stationGlobalId: url.searchParams.get("originStationGlobalId") },
        to: {
          stationGlobalId: url.searchParams.get("destinationStationGlobalId"),
          plannedDeparture,
          ...(realtime?.arrivalDelayInMinutes === undefined
            ? {}
            : { arrivalDelayInMinutes: realtime.arrivalDelayInMinutes }),
        },
        line: { transportType },
        ...(realtime?.realTime === undefined ? {} : { realTime: realtime.realTime }),
      },
    ],
  };
}

function sanitizedReichenbachFixture(url: URL): readonly unknown[] {
  const origin = {
    latitude: Number(url.searchParams.get("originLatitude")),
    longitude: Number(url.searchParams.get("originLongitude")),
  };
  const destination = {
    latitude: Number(url.searchParams.get("destinationLatitude")),
    longitude: Number(url.searchParams.get("destinationLongitude")),
  };
  const isParticipantOneOrigin = sameCoordinate(origin, REICHENBACH_REQUESTED_ORIGIN) || sameCoordinate(origin, REICHENBACH_MVG_SNAPPED_ORIGIN);
  const isParticipantTwoOrigin = sameCoordinate(origin, REICHENBACH_PARTICIPANT_TWO);
  const isParticipantOneDestination = sameCoordinate(destination, REICHENBACH_REQUESTED_ORIGIN) || sameCoordinate(destination, REICHENBACH_MVG_SNAPPED_ORIGIN);
  const isParticipantTwoDestination = sameCoordinate(destination, REICHENBACH_PARTICIPANT_TWO);
  const isTargetDestination = sameCoordinate(destination, REICHENBACH_TARGET);
  if (isParticipantOneOrigin && isParticipantTwoDestination) return [REICHENBACH_PARTICIPANT_ONE_TO_TWO_ROUTE];
  if (isParticipantTwoOrigin && isParticipantOneDestination) return [REICHENBACH_PARTICIPANT_TWO_TO_ONE_ROUTE];
  if (isParticipantOneOrigin && isTargetDestination) return [REICHENBACH_PARTICIPANT_ONE_TO_TARGET_ROUTE];
  if (isParticipantTwoOrigin && isTargetDestination) return [REICHENBACH_PARTICIPANT_TWO_TO_TARGET_ROUTE];
  return [];
}

function sameCoordinate(first: { latitude: number; longitude: number }, second: { latitude: number; longitude: number }): boolean {
  return first.latitude === second.latitude && first.longitude === second.longitude;
}

async function withFixedCurrentTime<T>(callback: () => Promise<T>): Promise<T> {
  const NativeDate = globalThis.Date;
  const fixedNow = NativeDate.parse("2026-08-10T08:00:00.000Z");
  class FixedDate extends NativeDate {
    constructor(value?: string | number | Date) {
      super(value === undefined ? fixedNow : value instanceof NativeDate ? value.getTime() : value);
    }

    static now(): number {
      return fixedNow;
    }
  }
  globalThis.Date = FixedDate as unknown as DateConstructor;
  try {
    return await callback();
  } finally {
    globalThis.Date = NativeDate;
  }
}

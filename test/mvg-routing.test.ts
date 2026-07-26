import assert from "node:assert/strict";
import test from "node:test";

import { calculateMeeting } from "../lib/domain/meeting.ts";
import { createBoundedMunichGrid, DIRECT_MVG_GRID_PROFILE } from "../lib/domain/grid.ts";
import type { MeetingProviders, RoutingProvider } from "../lib/domain/providers.ts";
import type { FetchImplementation } from "../lib/providers/http.ts";
import { HttpProviderError } from "../lib/providers/http.ts";
import { fixtureProviders } from "../lib/fixtures/providers.ts";
import { createMeetingProviders } from "../lib/providers/factory.ts";
import {
  MVG_DIRECT_NEARBY_URL,
  MVG_DIRECT_ROUTES_URL,
  MvgDirectRoutingProvider,
} from "../lib/providers/mvg-direct.ts";
import {
  ProviderConfigurationError,
  readProviderConfig,
} from "../lib/providers/config.ts";
import { handleMeetingPost } from "../lib/domain/meeting-api.ts";
import { validateMeetingCalculationResponse } from "../lib/domain/response.ts";

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
    assert.equal(url.searchParams.get("routingDateTime"), "2026-07-25T08:00:06.000Z");
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
  assert.equal(response.travelTimes[0].minutes, 30);
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
  assert.equal(response.travelTimes[0].minutes, 20);
  assert.deepEqual(response.timing, { dataKind: "scheduled", liveData: false });
});

test("empty nearby and route responses are unreachable, while same stations skip routes", async () => {
  let routeCalls = 0;
  const provider = new MvgDirectRoutingProvider(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/nearby")) {
      if (url.searchParams.get("longitude") === String(A.longitude + 0.001)) {
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
    new Response("x".repeat(128 * 1024 + 1), {
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
    if (url.searchParams.get("originStationGlobalId")?.startsWith("48.1374")) {
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
  assert.equal(calls, 99);
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

test("direct mode selects a complete 2x2 corridor and exposes accepted direct provenance", async () => {
  const direct = new MvgDirectRoutingProvider(async () => Response.json({ stations: [] }));
  const routing: RoutingProvider = {
    descriptor: direct.descriptor,
    capabilities: direct.capabilities,
    getTravelTimeMatrix: async (request) => ({
      ...(await fixtureProviders.routing.getTravelTimeMatrix(request)),
      timing: { dataKind: "scheduled" as const, liveData: false },
    }),
  };
  const providers: MeetingProviders = { ...fixtureProviders, routing };
  const result = await calculateMeeting(
    {
      departureAt: DEPARTURE,
      tolerancePercent: 10,
      participants: [participant("one", "transit"), participant("two", "transit")],
    },
    providers,
  );
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.corridor.properties.gridColumns, 2);
  assert.equal(result.corridor.properties.gridRows, 2);
  assert.equal(result.metadata.source.label, "Unofficial MVG routing (realtime when supplied; planned time fallback) + fixture coordinate resolution/static POIs");
  assert.equal(result.metadata.source.dataKind, "scheduled");
  assert.equal(result.metadata.source.liveData, false);
  assert.equal(result.metadata.providers.routing.dataKind, "scheduled");
  assert.equal(result.metadata.provenance.routing.dataKind, "scheduled");
  assert.equal(result.metadata.provenance.routing.feeds, null);
  assert.equal(validateMeetingCalculationResponse(result).success, true);
  const mutated = JSON.parse(JSON.stringify(result)) as {
    metadata: {
      providers: { routing: { dataKind: string; liveData: boolean } };
      provenance: {
        routing: {
          dataKind: string;
          liveData: boolean;
          sourceUrl: string;
          license: unknown;
          feeds: unknown;
          retrievedAt: string;
        };
      };
    };
  };
  mutated.metadata.providers.routing.dataKind = "live";
  mutated.metadata.providers.routing.liveData = true;
  mutated.metadata.provenance.routing.dataKind = "live";
  mutated.metadata.provenance.routing.liveData = true;
  mutated.metadata.provenance.routing.sourceUrl = "https://example.test/fake";
  mutated.metadata.provenance.routing.license = { name: "Fake", url: "https://example.test/license" };
  mutated.metadata.provenance.routing.feeds = {};
  mutated.metadata.provenance.routing.retrievedAt = "request-time";
  assert.equal(validateMeetingCalculationResponse(mutated).success, false);
  assert.equal(createBoundedMunichGrid(DIRECT_MVG_GRID_PROFILE).destinations.length, 19);
});

test("meeting metadata reflects live matrix timing without mutating the provider descriptor", async () => {
  const direct = new MvgDirectRoutingProvider(async () => Response.json({ stations: [] }));
  const routing: RoutingProvider = {
    descriptor: direct.descriptor,
    capabilities: direct.capabilities,
    getTravelTimeMatrix: async (request) => ({
      ...(await fixtureProviders.routing.getTravelTimeMatrix(request)),
      timing: { dataKind: "live" as const, liveData: true },
    }),
  };
  const result = await calculateMeeting(
    {
      departureAt: DEPARTURE,
      tolerancePercent: 10,
      participants: [participant("one", "transit"), participant("two", "transit")],
    },
    { ...fixtureProviders, routing },
  );
  assert.equal(result.metadata.source.dataKind, "live");
  assert.equal(result.metadata.source.liveData, true);
  assert.equal(result.metadata.providers.routing.dataKind, "live");
  assert.equal(result.metadata.providers.routing.liveData, true);
  assert.equal(result.metadata.provenance.routing.dataKind, "live");
  assert.equal(result.metadata.provenance.routing.liveData, true);
  assert.equal(validateMeetingCalculationResponse(result).success, true);

  const mismatched = JSON.parse(JSON.stringify(result)) as {
    metadata: {
      providers: { routing: { dataKind: string; liveData: boolean } };
      provenance: { routing: { dataKind: string; liveData: boolean } };
    };
  };
  mismatched.metadata.providers.routing.liveData = false;
  mismatched.metadata.provenance.routing.liveData = false;
  assert.equal(validateMeetingCalculationResponse(mismatched).success, false);

  assert.equal(direct.descriptor.dataKind, "scheduled");
  assert.equal(direct.descriptor.liveData, false);
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

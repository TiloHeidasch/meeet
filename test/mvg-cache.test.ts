import assert from "node:assert/strict";
import test from "node:test";

import { GET } from "../app/api/locations/search/route.ts";
import {
  MVG_LOCATION_SEARCH_MAX_RESPONSE_BYTES,
  MVG_LOCATION_SEARCH_TIMEOUT_MS,
  parseMvgLocationSearchResults,
  runMvgLocationCacheFill,
  searchMvgLocations,
} from "../lib/providers/mvg-locations.ts";
import {
  createHttpJsonClient,
  raceWithAbort,
  type FetchImplementation,
  HttpProviderError,
} from "../lib/providers/http.ts";
import {
  MVG_DIRECT_NEARBY_URL,
  MVG_UPSTREAM_REVALIDATE_SECONDS,
  MvgDirectRoutingProvider,
  runMvgDirectCacheFill,
} from "../lib/providers/mvg-direct.ts";

const A = { latitude: 48.1374, longitude: 11.5755 };

test("MVG location search parsing filters, deduplicates, bounds, and caps results", () => {
  const payload = {
    locations: [
      { name: "Marienplatz", latitude: A.latitude, longitude: A.longitude },
      { name: "Marienplatz", latitude: A.latitude, longitude: A.longitude },
      { name: "Outside Munich", latitude: 52.52, longitude: 13.405 },
      { name: "Invalid coordinates", latitude: Infinity, longitude: A.longitude },
      ...Array.from({ length: 25 }, (_, index) => ({
        name: `Munich result ${index}`,
        latitude: A.latitude + (index + 1) * 0.00001,
        longitude: A.longitude,
      })),
    ],
  };

  const results = parseMvgLocationSearchResults(payload);
  assert.equal(results.length, 20);
  assert.deepEqual(results[0], {
    label: "Marienplatz",
    latitude: A.latitude,
    longitude: A.longitude,
  });
  assert.equal(new Set(results.map((result) => JSON.stringify(result))).size, 20);
  assert.throws(() => parseMvgLocationSearchResults({ locations: null }));
});

test("MVG location search uses the fixed endpoint and no-store raw upstream fetch", async () => {
  assert.equal(MVG_UPSTREAM_REVALIDATE_SECONDS, 24 * 60 * 60);
  assert.equal(MVG_LOCATION_SEARCH_TIMEOUT_MS, 4_000);
  assert.equal(MVG_LOCATION_SEARCH_MAX_RESPONSE_BYTES, 512 * 1024);
  let observedUrl: URL | undefined;
  let observedInit: RequestInit | undefined;
  const fetchImplementation: FetchImplementation = async (input, init) => {
    observedUrl = new URL(String(input));
    observedInit = init;
    return Response.json({
      locations: [{ name: "Marienplatz", latitude: A.latitude, longitude: A.longitude }],
    });
  };

  const results = await searchMvgLocations("  Marienplatz  ", fetchImplementation);
  assert.equal(results[0]?.label, "Marienplatz");
  assert.ok(results.every((result) =>
    Number.isFinite(result.latitude) &&
    Number.isFinite(result.longitude) &&
    result.latitude >= -90 &&
    result.latitude <= 90 &&
    result.longitude >= -180 &&
    result.longitude <= 180,
  ));
  assert.equal(observedUrl?.origin, "https://www.mvg.de");
  assert.equal(observedUrl?.pathname, "/api/bgw-pt/v3/locations");
  assert.equal(observedUrl?.searchParams.get("query"), "Marienplatz");
  assert.equal(observedInit?.cache, "no-store");
  assert.equal(observedInit?.next, undefined);
  assert.equal(observedInit?.redirect, "error");
});

test("location search rejects blank and overlong queries before upstream access", async () => {
  let calls = 0;
  const fetchImplementation: FetchImplementation = async () => {
    calls += 1;
    return Response.json({ locations: [] });
  };
  await assert.rejects(() => searchMvgLocations("   ", fetchImplementation));
  await assert.rejects(() => searchMvgLocations("x".repeat(81), fetchImplementation));
  assert.equal(calls, 0);

  const response = await GET(new Request("http://localhost/api/locations/search?q="));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: { code: "INVALID_QUERY", message: "Enter a short location search query." },
  });
});

test("location search hides upstream failures behind a generic response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json(
      { error: "secret upstream diagnostic" },
      { status: 502 },
    )) as typeof fetch;
  try {
    const response = await GET(
      new Request("http://localhost/api/locations/search?q=Marienplatz"),
    );
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.equal(body.includes("secret upstream diagnostic"), false);
    assert.deepEqual(JSON.parse(body), {
      error: {
        code: "LOCATION_SEARCH_UNAVAILABLE",
        message: "Location search is temporarily unavailable.",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("nearby MVG requests use a shared cache bucket and no-store raw fetch", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const fetchImplementation: FetchImplementation = async (input, init) => {
    requests.push({ url: new URL(String(input)), init });
    return Response.json({ stations: [] });
  };
  const provider = new MvgDirectRoutingProvider(fetchImplementation);
  const nearbyCoordinate = { latitude: 48.13745, longitude: 11.57555 };
  const response = await provider.getTravelTimeMatrix({
    departureAt: "2026-07-25T08:00:00.000Z",
    participants: [{ participantId: "one", origin: nearbyCoordinate, mode: "transit" }],
    destinations: [{ id: "destination", coordinate: A, sampleKind: "center" }],
  });

  assert.equal(response.travelTimes[0]?.status, "unreachable");
  const nearbyRequests = requests.filter(({ url }) => url.toString().startsWith(MVG_DIRECT_NEARBY_URL));
  assert.equal(nearbyRequests.length, 2);
  assert.equal(
    new Set(nearbyRequests.map(({ url }) => `${url.searchParams.get("latitude")}:${url.searchParams.get("longitude")}`)).size,
    1,
  );
  assert.ok(nearbyRequests.every(({ init }) =>
    init?.cache === "no-store" && init.next === undefined && init.redirect === "error",
  ));
  assert.equal(requests.some(({ url }) => url.pathname.endsWith("/routes")), false);
});

test("location cache fills share the limiter and retain active slots after caller abort", async () => {
  let started = 0;
  let fifthStarted = false;
  const releaseFills: Array<() => void> = [];
  const fill = (name: string, signal: AbortSignal) => runMvgLocationCacheFill(async () => {
    started += 1;
    if (started <= 4) {
      return new Promise<Array<{ label: string; latitude: number; longitude: number }>>((resolve) => {
        releaseFills.push(() => resolve([{
          label: name,
          latitude: A.latitude,
          longitude: A.longitude,
        }]));
      });
    }
    fifthStarted = true;
    return [{ label: name, latitude: A.latitude, longitude: A.longitude }];
  }, signal);
  const callers = Array.from({ length: 5 }, () => new AbortController());
  const fills = callers.map((caller, index) => fill(`limiter-regression-${index}`, caller.signal));

  await expectActive(() => started, 4);
  callers[0]?.abort();
  await assert.rejects(
    fills[0],
    (error: unknown) =>
      error instanceof HttpProviderError && error.kind === "aborted",
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fifthStarted, false);

  releaseFills.forEach((release) => release());
  const results = await Promise.allSettled(fills);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(started, 5);
  assert.equal(fifthStarted, true);
});

test("MVG routes do not receive a Next cache option", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const fetchImplementation: FetchImplementation = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.pathname.endsWith("/nearby")) {
      const latitude = Number(url.searchParams.get("latitude"));
      const longitude = Number(url.searchParams.get("longitude"));
      return Response.json({ stations: [{ globalId: `${latitude}:${longitude}`, latitude, longitude }] });
    }
    return Response.json([{
      parts: [{
        from: { stationGlobalId: url.searchParams.get("originStationGlobalId") },
        to: {
          stationGlobalId: url.searchParams.get("destinationStationGlobalId"),
          plannedDeparture: "2026-07-25T08:20:00.000+00:00",
        },
        line: { transportType: "BUS" },
      }],
    }]);
  };
  const provider = new MvgDirectRoutingProvider(fetchImplementation);
  await provider.getTravelTimeMatrix({
    departureAt: "2026-07-25T08:00:00.000Z",
    participants: [{ participantId: "one", origin: A, mode: "transit" }],
    destinations: [{ id: "destination", coordinate: { ...A, longitude: A.longitude + 0.001 }, sampleKind: "center" }],
  });
  const routeRequest = requests.find(({ url }) => url.pathname.endsWith("/routes"));
  assert.ok(routeRequest);
  assert.equal(routeRequest.init?.cache, "no-store");
  assert.equal(routeRequest.init?.next, undefined);
});

test("declared oversized location responses cancel their body before failing", async () => {
  let canceled = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
    },
  });
  const response = new Response(stream, {
    headers: { "content-length": String(512 * 1024 + 1) },
  });
  const body = response.body;
  assert.ok(body);
  const cancel = body.cancel.bind(body);
  body.cancel = async (reason) => {
    canceled += 1;
    return cancel(reason);
  };

  await assert.rejects(
    searchMvgLocations("Marienplatz", async () => response),
    (error: unknown) =>
      error instanceof HttpProviderError && error.kind === "response-too-large",
  );
  assert.equal(canceled, 1);
});

test("caller abort races a cache fill without canceling the shared promise", async () => {
  let resolveFill: ((value: string) => void) | undefined;
  const fill = new Promise<string>((resolve) => {
    resolveFill = resolve;
  });
  const caller = new AbortController();
  const result = raceWithAbort(fill, caller.signal);
  caller.abort();
  await assert.rejects(
    result,
    (error: unknown) =>
      error instanceof HttpProviderError && error.kind === "aborted",
  );
  resolveFill?.("validated");
  assert.equal(await fill, "validated");
});

test("HTTP early failures cancel response bodies without masking the primary error", async () => {
  const cases: Array<{
    name: string;
    response: Response;
    canceled: () => number;
    expectedKind: HttpProviderError["kind"];
  }> = [
    createTrackedResponse({ status: 503, url: "https://www.mvg.de/api/test" }, "http"),
    createTrackedResponse({ status: 200, url: "https://redirect.example.test/api/test" }, "redirect"),
    createTrackedResponse(
      {
        status: 200,
        url: "https://www.mvg.de/api/test",
        headers: { "content-length": "100" },
      },
      "oversized",
    ),
  ].map(({ response, canceled, expectedKind, name }) => ({
    name,
    response,
    canceled,
    expectedKind,
  }));

  for (const testCase of cases) {
    const client = createHttpJsonClient(
      "https://www.mvg.de/api/test",
      { timeoutMs: 1_000, maxResponseBytes: 10 },
      null,
      async () => testCase.response,
    );
    await assert.rejects(
      client.getJson(),
      (error: unknown) =>
        error instanceof HttpProviderError && error.kind === testCase.expectedKind,
      testCase.name,
    );
    assert.equal(testCase.canceled(), 1, testCase.name);
  }

  const cleanupFailure = createTrackedResponse(
    { status: 503, url: "https://www.mvg.de/api/test" },
    "cleanup failure",
    true,
  );
  const client = createHttpJsonClient(
    "https://www.mvg.de/api/test",
    { timeoutMs: 1_000, maxResponseBytes: 10 },
    null,
    async () => cleanupFailure.response,
  );
  await assert.rejects(
    client.getJson(),
    (error: unknown) =>
      error instanceof HttpProviderError && error.kind === "http",
  );
  assert.equal(cleanupFailure.canceled(), 1);
});

test("aborted production-style cache fills retain four limiter slots until settlement", async () => {
  let active = 0;
  let maximumActive = 0;
  let started = 0;
  let releaseFill: (() => void) | undefined;
  const fillReleased = new Promise<void>((resolve) => {
    releaseFill = resolve;
  });
  const callers = Array.from({ length: 4 }, () => new AbortController());
  const fills = callers.map((caller) =>
    runMvgDirectCacheFill(async () => {
      active += 1;
      started += 1;
      maximumActive = Math.max(maximumActive, active);
      await fillReleased;
      active -= 1;
      return "filled";
    }, caller.signal),
  );
  const fillResultsPromise = Promise.allSettled(fills);

  await expectActive(() => active, 4);
  callers.forEach((caller) => caller.abort());
  let fifthStarted = false;
  const fifth = runMvgDirectCacheFill(async () => {
    fifthStarted = true;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    active -= 1;
    return "fifth";
  }, new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fifthStarted, false);
  releaseFill?.();
  const fillResults = await fillResultsPromise;
  assert.ok(fillResults.every((result) =>
    result.status === "rejected" &&
    result.reason instanceof HttpProviderError &&
    result.reason.kind === "aborted",
  ));
  assert.equal(await fifth, "fifth");
  assert.equal(started, 4);
  assert.ok(maximumActive <= 4);
});

test("configured direct HTTP honors effective timeout and response-size limits", async () => {
  const limited = new MvgDirectRoutingProvider(
    { timeoutMs: 1_000, maxResponseBytes: 32 },
    async () => new Response("x".repeat(100), { headers: { "content-type": "application/json" } }),
  );
  await assert.rejects(
    limited.getTravelTimeMatrix({
      departureAt: "2026-07-25T08:00:00.000Z",
      participants: [{ participantId: "one", origin: A, mode: "transit" }],
      destinations: [{ id: "destination", coordinate: A, sampleKind: "center" }],
    }),
    (error: unknown) =>
      error instanceof HttpProviderError && error.kind === "response-too-large",
  );

  const timedOut = new MvgDirectRoutingProvider(
    { timeoutMs: 5, maxResponseBytes: 1_024, matrixDeadlineMs: 1_000 },
    async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  );
  await assert.rejects(
    timedOut.getTravelTimeMatrix({
      departureAt: "2026-07-25T08:00:00.000Z",
      participants: [{ participantId: "one", origin: A, mode: "transit" }],
      destinations: [{ id: "destination", coordinate: A, sampleKind: "center" }],
    }),
    (error: unknown) =>
      error instanceof HttpProviderError && error.kind === "timeout",
  );
});

function createTrackedResponse(
  options: { status: number; url: string; headers?: Record<string, string> },
  name: string,
  rejectCancellation = false,
): { name: string; response: Response; canceled: () => number; expectedKind: HttpProviderError["kind"] } {
  let canceled = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
      controller.close();
    },
  });
  const nativeResponse = new Response(stream, { headers: options.headers });
  const body = nativeResponse.body;
  assert.ok(body);
  const cancel = body.cancel.bind(body);
  body.cancel = async (reason) => {
    canceled += 1;
    if (rejectCancellation) throw new Error("cleanup failed");
    return cancel(reason);
  };
  const status = options.status;
  return {
    name,
    response: {
      ok: status >= 200 && status < 300,
      status,
      url: options.url,
      headers: nativeResponse.headers,
      body,
    } as unknown as Response,
    canceled: () => canceled,
    expectedKind: status < 200 || status >= 300 || options.url !== "https://www.mvg.de/api/test"
      ? "http"
      : "response-too-large",
  };
}

async function expectActive(actual: () => number, expected: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (actual() === expected) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 1_000) {
        reject(new Error(`Expected ${expected} active fills, got ${actual()}.`));
        return;
      }
      setTimeout(check, 1);
    };
    check();
  });
}

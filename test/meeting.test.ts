import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { POST } from "../app/api/meeting/calculate/route.ts";
import { isPointInGeoJsonGeometry } from "../lib/domain/geo.ts";
import {
  clipPolygonToOfficialMunichBoundary,
  isWithinOfficialMunichBoundary,
  OFFICIAL_MUNICH_BOUNDARY,
  OFFICIAL_MUNICH_BOUNDARY_BOUNDS,
  OFFICIAL_MUNICH_BOUNDARY_MANIFEST,
} from "../lib/domain/boundary.ts";
import { createBoundedMunichGrid } from "../lib/domain/grid.ts";
import {
  calculateComparableTravelTimeRange,
  calculateMeeting,
} from "../lib/domain/meeting.ts";
import { handleMeetingPost, MAX_MEETING_REQUEST_BODY_BYTES } from "../lib/domain/meeting-api.ts";
import type { MeetingProviders } from "../lib/domain/providers.ts";
import type { LocationCoordinate } from "../lib/domain/types.ts";
import { fixtureProviders } from "../lib/fixtures/providers.ts";
import {
  GatewayRoutingProvider,
  HttpPoiProvider,
} from "../lib/providers/adapters.ts";
import {
  ProviderConfigurationError,
  readProviderConfig,
} from "../lib/providers/config.ts";
import { createMeetingProviders } from "../lib/providers/factory.ts";
import {
  createHttpJsonClient,
  type FetchImplementation,
  HttpProviderError,
} from "../lib/providers/http.ts";
import { validateMeetingCalculationResponse } from "../lib/domain/response.ts";

// API tests use deterministic providers; the production no-mode default is direct MVG.
process.env.MEEET_PROVIDER_MODE = "fixture";

const MARIENPLATZ: LocationCoordinate = {
  latitude: 48.1374,
  longitude: 11.5755,
};
const FIXED_DEPARTURE_AT = "2026-07-25T08:00:00.000Z";

test("travel-time tolerance math uses a median target and ± percentage window", () => {
  const comparable = calculateComparableTravelTimeRange([20, 21, 19], 10);
  assert.equal(comparable.targetMinutes, 20);
  assert.equal(comparable.lowerMinutes, 18);
  assert.equal(comparable.upperMinutes, 22);
  assert.equal(comparable.isComparable, true);

  const notComparable = calculateComparableTravelTimeRange([20, 25], 10);
  assert.equal(notComparable.isComparable, false);
});

test("official boundary asset has 25 districts and rejects an out-of-area point", () => {
  assert.equal(OFFICIAL_MUNICH_BOUNDARY.type, "FeatureCollection");
  assert.equal(OFFICIAL_MUNICH_BOUNDARY.features.length, 25);
  assert.deepEqual(
    OFFICIAL_MUNICH_BOUNDARY.features.map((feature) => feature.properties.districtNumber),
    Array.from({ length: 25 }, (_, index) => String(index + 1).padStart(2, "0")),
  );
  assert.equal(OFFICIAL_MUNICH_BOUNDARY_MANIFEST.districtCount, 25);
  assert.equal(OFFICIAL_MUNICH_BOUNDARY_MANIFEST.legalBoundary, false);
  assert.match(OFFICIAL_MUNICH_BOUNDARY_MANIFEST.rawContentHash, /^[a-f0-9]{64}$/);
  assert.match(OFFICIAL_MUNICH_BOUNDARY_MANIFEST.normalizedContentHash, /^[a-f0-9]{64}$/);
  assert.match(OFFICIAL_MUNICH_BOUNDARY_MANIFEST.metadataContentHash, /^[a-f0-9]{64}$/);
  assert.equal(
    sha256File("data/official/munich-stadtbezirke.raw.geojson"),
    OFFICIAL_MUNICH_BOUNDARY_MANIFEST.rawContentHash,
  );
  assert.equal(
    sha256File("data/official/munich-districts.json"),
    OFFICIAL_MUNICH_BOUNDARY_MANIFEST.normalizedContentHash,
  );
  assert.equal(isWithinOfficialMunichBoundary(MARIENPLATZ), true);
  assert.equal(
    isWithinOfficialMunichBoundary({ latitude: 52.52, longitude: 13.405 }),
    false,
  );
});

test("the bounded grid is made of cells with declared center and clipped-vertex samples", () => {
  const grid = createBoundedMunichGrid();
  assert.ok(grid.cells.length > 0);
  assert.ok(grid.cells.length <= 168);
  assert.ok(grid.destinations.length <= 400);
  for (const cell of grid.cells) {
    assert.ok(cell.sampleDestinationIds.length >= 5);
    assert.ok(cell.vertices.length >= 4);
    assert.ok(isWithinOfficialMunichBoundary(cell.center));
    assert.ok(cell.vertices.every(isWithinOfficialMunichBoundary));
    assert.ok(cell.geometry.coordinates.length > 0);
  }
});

test("grid-cell clipping uses the official boundary instead of the old envelope", () => {
  const centerLatitude =
    (OFFICIAL_MUNICH_BOUNDARY_BOUNDS.minLatitude +
      OFFICIAL_MUNICH_BOUNDARY_BOUNDS.maxLatitude) /
    2;
  const clipped = clipPolygonToOfficialMunichBoundary({
    type: "Polygon",
    coordinates: [
      [
        [OFFICIAL_MUNICH_BOUNDARY_BOUNDS.minLongitude - 0.02, centerLatitude - 0.01],
        [OFFICIAL_MUNICH_BOUNDARY_BOUNDS.minLongitude + 0.02, centerLatitude - 0.01],
        [OFFICIAL_MUNICH_BOUNDARY_BOUNDS.minLongitude + 0.02, centerLatitude + 0.01],
        [OFFICIAL_MUNICH_BOUNDARY_BOUNDS.minLongitude - 0.02, centerLatitude + 0.01],
        [OFFICIAL_MUNICH_BOUNDARY_BOUNDS.minLongitude - 0.02, centerLatitude - 0.01],
      ],
    ],
  });
  assert.ok(clipped.coordinates.length > 0);
  for (const polygon of clipped.coordinates) {
    for (const [longitude, latitude] of polygon[0]) {
      assert.ok(isWithinOfficialMunichBoundary({ latitude, longitude }));
    }
  }
});

test("known fixture scenario returns only cells whose center and vertices pass", async () => {
  const participants = [participant("one", "transit"), participant("two", "transit")];
  const result = await calculateMeeting(
    { participants, tolerancePercent: 10, departureAt: FIXED_DEPARTURE_AT },
    fixtureProviders,
  );

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.corridor.geometry.type, "MultiPolygon");
  assert.equal(result.corridor.properties.approximation, "sample-grid");
  assert.equal(result.corridor.properties.verification, "center-and-clipped-vertices");
  assert.ok(result.corridor.properties.cellCount > 0);
  assert.ok(result.pois.some((poi) => poi.id === "fixture-viktualienmarkt"));
  assert.equal(result.metadata.source.deployment, "fixture");
  assert.equal(result.metadata.source.dataKind, "demo-static");
  assert.equal(result.metadata.source.liveData, false);
  assert.match(
    result.corridor.properties.geometryGuarantee,
    /cell interiors are not independently routed/,
  );

  const grid = createBoundedMunichGrid();
  const matrix = await fixtureProviders.routing.getTravelTimeMatrix({
    participants: participants.map((item) => ({
      participantId: item.id,
      origin: item.location,
      mode: item.mode,
    })),
    destinations: grid.destinations,
    departureAt: FIXED_DEPARTURE_AT,
  });
  const timesByDestination = new Map<string, number[]>();
  for (const time of matrix.travelTimes) {
    assert.equal(time.status, "ok");
    assert.notEqual(time.minutes, null);
    const times = timesByDestination.get(time.destinationId) ?? [];
    times.push(time.minutes as number);
    timesByDestination.set(time.destinationId, times);
  }
  assert.equal(result.corridor.properties.cellCount, grid.cells.length);
  for (const polygon of result.corridor.geometry.coordinates) {
    const ring = polygon[0];
    assert.ok(ring.length >= 4);
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    for (const [longitude, latitude] of ring) {
      assert.ok(isWithinOfficialMunichBoundary({ latitude, longitude }));
    }
  }
  for (const cell of grid.cells) {
    for (const destinationId of cell.sampleDestinationIds) {
      const times = timesByDestination.get(destinationId);
      assert.ok(times);
      assert.equal(calculateComparableTravelTimeRange(times, 10).isComparable, true);
    }
  }
});

test("unreachable matrix samples exclude a cell without making the provider unavailable", async () => {
  const grid = createBoundedMunichGrid();
  const unreachableDestinationId = grid.cells[0].sampleDestinationIds[0];
  const routing = {
    ...fixtureProviders.routing,
    getTravelTimeMatrix: async (request: Parameters<typeof fixtureProviders.routing.getTravelTimeMatrix>[0]) => {
      const response = await fixtureProviders.routing.getTravelTimeMatrix(request);
      return {
        ...response,
        travelTimes: response.travelTimes.map((cell) =>
          cell.destinationId === unreachableDestinationId && cell.participantId === "one"
            ? { ...cell, status: "unreachable" as const, minutes: null }
            : cell,
        ),
      };
    },
  };
  const result = await calculateMeeting(
    {
      participants: [participant("one", "transit"), participant("two", "transit")],
      tolerancePercent: 10,
      departureAt: FIXED_DEPARTURE_AT,
    },
    { ...fixtureProviders, routing },
  );
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.ok(result.corridor.properties.cellCount < grid.cells.length);
  }
});

test("client-safe response validation rejects malformed GeoJSON and provenance", async () => {
  const response = await POST(
    jsonRequest({
      participants: [participant("one", "transit"), participant("two", "transit")],
      departureAt: FIXED_DEPARTURE_AT,
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(validateMeetingCalculationResponse(body).success, true);

  const malformed = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const corridor = malformed.corridor as { geometry: { coordinates: unknown[][][][] } };
  const firstRing = corridor.geometry.coordinates[0][0];
  firstRing[firstRing.length - 1] = [firstRing[0][0] as number, (firstRing[0][1] as number) + 0.001];
  const malformedResult = validateMeetingCalculationResponse(malformed);
  assert.equal(malformedResult.success, false);

  const provenance = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const metadata = provenance.metadata as { provenance: { routing: { dataKind: string; feeds: unknown } } };
  metadata.provenance.routing.dataKind = "scheduled";
  metadata.provenance.routing.feeds = null;
  const provenanceResult = validateMeetingCalculationResponse(provenance);
  assert.equal(provenanceResult.success, false);
});

test("routing is requested once as a bounded matrix with shared departure and modes", async () => {
  let calls = 0;
  const routing = {
    ...fixtureProviders.routing,
    getTravelTimeMatrix: async (request: Parameters<typeof fixtureProviders.routing.getTravelTimeMatrix>[0]) => {
      calls += 1;
      assert.equal(request.departureAt, FIXED_DEPARTURE_AT);
      assert.deepEqual(
        request.participants.map((participant) => participant.mode),
        ["transit", "bike", "car"],
      );
      assert.ok(request.destinations.length <= 400);
      assert.ok(request.destinations.length * request.participants.length <= 1600);
      return fixtureProviders.routing.getTravelTimeMatrix(request);
    },
  };
  const result = await calculateMeeting(
    {
      participants: [
        participant("one", "transit"),
        participant("two", "bike"),
        participant("three", "car"),
      ],
      tolerancePercent: 15,
      departureAt: FIXED_DEPARTURE_AT,
    },
    { ...fixtureProviders, routing },
  );
  assert.equal(calls, 1);
  assert.ok(result.status === "ok" || result.status === "no-corridor");
});

test("provider factory defaults to direct MVG and keeps explicit fixtures deterministic", async () => {
  const fallback = createMeetingProviders({});
  assert.strictEqual(fallback.geocoding, fixtureProviders.geocoding);
  assert.equal(fallback.routing.descriptor.name, "mvg-direct-routing");
  assert.equal(readProviderConfig({}).mode, "mvg-direct-transit");
  const fixture = createMeetingProviders({ MEEET_PROVIDER_MODE: "fixture" });
  assert.strictEqual(fixture.routing, fixtureProviders.routing);
  const configured = createMeetingProviders({ MEEET_PROVIDER_MODE: "configured" });
  const response = await handleMeetingPost(
    jsonRequest({
      participants: [participant("one", "transit"), participant("two", "transit")],
      departureAt: FIXED_DEPARTURE_AT,
    }),
    configured,
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "PROVIDER_NOT_CONFIGURED");
  assert.throws(
    () => readProviderConfig({ MEEET_ROUTING_GATEWAY_URL: "not-a-url" }),
    ProviderConfigurationError,
  );
  assert.throws(
    () =>
      readProviderConfig({
        MEEET_PROVIDER_MODE: "configured",
        MEEET_PROVIDER_DEPLOYMENT: "fixture",
      }),
    ProviderConfigurationError,
  );
  assert.throws(
    () =>
      readProviderConfig({
        MEEET_ROUTING_GATEWAY_URL: "https://gateway.example.test/matrix",
      }),
    ProviderConfigurationError,
  );
});

test("routing gateway contract validates one shared request without external calls", async () => {
  const config = readProviderConfig({
    MEEET_PROVIDER_MODE: "configured",
    MEEET_ROUTING_GATEWAY_URL: "https://gateway.example.test/matrix",
    MEEET_ROUTING_GATEWAY_TOKEN: "test-token",
    ...routingFeedEnvironment(),
  });
  let capturedPayload: unknown;
  let capturedAuthorization: string | null = null;
  const mockFetch: FetchImplementation = async (_input, init) => {
    capturedPayload = JSON.parse(String(init?.body));
    capturedAuthorization = new Headers(init?.headers).get("authorization");
    return Response.json({
      contractVersion: "meeet-routing-gateway/v1",
      departureAt: FIXED_DEPARTURE_AT,
      travelTimes: [
        {
          participantId: "one",
          destinationId: "destination-1",
          mode: "transit",
          status: "ok",
          minutes: 12,
          source: "gateway-test",
        },
      ],
    });
  };
  const provider = new GatewayRoutingProvider(config, mockFetch);
  const response = await provider.getTravelTimeMatrix({
    departureAt: FIXED_DEPARTURE_AT,
    participants: [
      { participantId: "one", origin: MARIENPLATZ, mode: "transit" },
    ],
    destinations: [
      {
        id: "destination-1",
        coordinate: MARIENPLATZ,
        sampleKind: "center",
      },
    ],
  });
  assert.equal(response.travelTimes[0].minutes, 12);
  assert.equal(capturedAuthorization, "Bearer test-token");
  assert.deepEqual(
    (capturedPayload as { timeZone: string }).timeZone,
    "Europe/Berlin",
  );
  assert.equal(
    (capturedPayload as { departureAt: string }).departureAt,
    FIXED_DEPARTURE_AT,
  );
});

test("configured gateway shape and HTTP response-size failures are rejected", async () => {
  const config = readProviderConfig({
    MEEET_PROVIDER_MODE: "configured",
    MEEET_ROUTING_GATEWAY_URL: "https://gateway.example.test/matrix",
    ...routingFeedEnvironment(),
  });
  const invalidGateway = new GatewayRoutingProvider(
    config,
    async () =>
      Response.json({
        contractVersion: "meeet-routing-gateway/v1",
        departureAt: FIXED_DEPARTURE_AT,
        travelTimes: [],
      }),
  );
  await assert.rejects(
    invalidGateway.getTravelTimeMatrix({
      departureAt: FIXED_DEPARTURE_AT,
      participants: [
        { participantId: "one", origin: MARIENPLATZ, mode: "transit" },
      ],
      destinations: [
        { id: "destination-1", coordinate: MARIENPLATZ, sampleKind: "center" },
      ],
    }),
    /bounded matrix/,
  );

  const oversizedClient = createHttpJsonClient(
    "https://gateway.example.test/matrix",
    { timeoutMs: 1_000, maxResponseBytes: 8 },
    null,
    (async () => new Response("123456789")) as FetchImplementation,
  );
  await assert.rejects(
    oversizedClient.postJson({}),
    (error: unknown) =>
      error instanceof HttpProviderError && error.kind === "response-too-large",
  );
});

test("configured HTTP rejects redirects/protocol violations and duplicate POIs", async () => {
  assert.throws(
    () => readProviderConfig({ MEEET_POI_ENDPOINT: "http://poi.example.test" }),
    ProviderConfigurationError,
  );
  const developmentConfig = readProviderConfig({
    NODE_ENV: "development",
    MEEET_ALLOW_HTTP_PROVIDER_ENDPOINTS: "true",
    MEEET_POI_ENDPOINT: "http://127.0.0.1",
    ...sourceEnvironment("MEEET_POI"),
  });
  assert.equal(developmentConfig.poiUrl, "http://127.0.0.1/");

  const redirectClient = createHttpJsonClient(
    "https://gateway.example.test/matrix",
    { timeoutMs: 1_000, maxResponseBytes: 1024 },
    null,
    (async () => ({
      ok: true,
      url: "https://redirected.example.test/matrix",
      headers: new Headers(),
      body: new Response(JSON.stringify({})).body,
    })) as unknown as FetchImplementation,
  );
  await assert.rejects(
    redirectClient.postJson({}),
    (error: unknown) => error instanceof HttpProviderError && error.kind === "http",
  );

  const poiConfig = readProviderConfig({
    MEEET_PROVIDER_MODE: "configured",
    MEEET_POI_ENDPOINT: "https://poi.example.test/food",
    ...sourceEnvironment("MEEET_POI"),
  });
  const poiProvider = new HttpPoiProvider(
    poiConfig,
    (async () =>
      Response.json({
        contractVersion: "meeet-poi/v1",
        source: {
          name: "MEEET_POI source",
          url: "https://sources.example.test/MEEET_POI",
          license: {
            name: "CC BY 4.0",
            url: "https://sources.example.test/MEEET_POI-license",
          },
          attribution: "MEEET_POI attribution",
          version: "MEEET_POI-v1",
          retrievedAt: FIXED_DEPARTURE_AT,
        },
        pois: [
          {
            id: "duplicate",
            name: "One",
            category: "food",
            coordinates: [11.5755, 48.1374],
          },
          {
            id: "duplicate",
            name: "Two",
            category: "drink",
            coordinates: [11.5756, 48.1375],
          },
        ],
      })) as FetchImplementation,
  );
  await assert.rejects(
    poiProvider.findFoodAndDrink({
      type: "MultiPolygon",
      coordinates: [],
    }),
    /duplicate ids/,
  );
});

test("non-boundary provider licences are accepted while invalid boundary licence is rejected by the DTO", async () => {
  const geocodingConfig = readProviderConfig({
    MEEET_GEOCODING_ENDPOINT: "https://geocoder.example.test/resolve",
    ...sourceEnvironment("MEEET_GEOCODING"),
  });
  assert.equal(geocodingConfig.geocodingSource?.license.name, "CC BY 4.0");
  const poiConfig = readProviderConfig({
    MEEET_POI_ENDPOINT: "https://poi.example.test/places",
    ...sourceEnvironment("MEEET_POI"),
  });
  assert.equal(poiConfig.poiSource?.license.name, "CC BY 4.0");

  const response = await POST(
    jsonRequest({
      participants: [participant("one", "transit"), participant("two", "transit")],
      departureAt: FIXED_DEPARTURE_AT,
    }),
  );
  const body = JSON.parse(JSON.stringify(await response.json())) as Record<string, unknown>;
  const metadata = body.metadata as { boundary: { license: { name: string } } };
  metadata.boundary.license.name = "CC BY 4.0";
  assert.equal(validateMeetingCalculationResponse(body).success, false);
});

test("POI containment has positive and negative cases", async () => {
  const positive = await fixtureProviders.poi.findFoodAndDrink({
    type: "Polygon",
    coordinates: [
      [
        [11.56, 48.12],
        [11.6, 48.12],
        [11.6, 48.15],
        [11.56, 48.15],
        [11.56, 48.12],
      ],
    ],
  });
  const negative = await fixtureProviders.poi.findFoodAndDrink({
    type: "Polygon",
    coordinates: [
      [
        [11.4, 48.2],
        [11.42, 48.2],
        [11.42, 48.21],
        [11.4, 48.21],
        [11.4, 48.2],
      ],
    ],
  });

  assert.ok(positive.length > 0);
  assert.equal(negative.length, 0);
  for (const poi of positive) {
    assert.equal(
      isPointInGeoJsonGeometry(poi.coordinates, {
        type: "Polygon",
        coordinates: [
          [
            [11.56, 48.12],
            [11.6, 48.12],
            [11.6, 48.15],
            [11.56, 48.15],
            [11.56, 48.12],
          ],
        ],
      }),
      true,
    );
  }
});

test("API supports 2, 3, and 4 participants", async () => {
  for (const count of [2, 3, 4]) {
    const response = await POST(
      jsonRequest({
        participants: Array.from({ length: count }, (_, index) =>
          participant(`p${index + 1}`, "transit"),
        ),
        departureAt: FIXED_DEPARTURE_AT,
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(body.requestSnapshot.participants.length, count);
    assert.equal(body.travelTimes.length, count);
  }
});

test("API resolves supplied departure instants and defaults missing ones", async () => {
  const supplied = await POST(
    jsonRequest({
      participants: [participant("one", "transit"), participant("two", "transit")],
      departureAt: "2026-07-25T10:00:00+02:00",
    }),
  );
  assert.equal(supplied.status, 200);
  const suppliedBody = await supplied.json();
  assert.equal(suppliedBody.requestSnapshot.departureAt, FIXED_DEPARTURE_AT);
  assert.equal(suppliedBody.requestSnapshot.timeZone, "Europe/Berlin");

  const before = Date.now();
  const defaulted = await POST(
    jsonRequest({
      participants: [participant("one", "transit"), participant("two", "transit")],
    }),
  );
  const after = Date.now();
  assert.equal(defaulted.status, 200);
  const defaultedBody = await defaulted.json();
  const resolvedTime = Date.parse(defaultedBody.requestSnapshot.departureAt);
  assert.ok(resolvedTime >= before - 1000 && resolvedTime <= after + 1000);
  assert.equal(defaultedBody.requestSnapshot.timeZone, "Europe/Berlin");

  const invalid = await POST(
    jsonRequest({
      participants: [participant("one", "transit"), participant("two", "transit")],
      departureAt: "2026-07-25",
    }),
  );
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "INVALID_REQUEST");
});

test("API returns a discriminated no-corridor response", async () => {
  const response = await POST(
    jsonRequest({
      tolerancePercent: 5,
      departureAt: FIXED_DEPARTURE_AT,
      participants: [
        participantAt("a", 48.1234, 11.486, "transit"),
        participantAt("b", 48.1257, 11.605, "bike"),
        participantAt("c", 48.1508, 11.582, "car"),
        participantAt("d", 48.1402, 11.5586, "transit"),
      ],
    }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "no-corridor");
  assert.equal(body.reason.code, "NO_COMPARABLE_GRID_CELL");
  assert.equal(body.corridor, undefined);
  assert.equal(body.requestSnapshot.timeZone, "Europe/Berlin");
});

test("API errors distinguish malformed, invalid, and too-large requests", async () => {
  const malformed = await POST(
    new Request("http://localhost/api/meeting/calculate", {
      method: "POST",
      body: "{not-json",
    }),
  );
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "MALFORMED_JSON");

  const invalid = await POST(
    jsonRequest({
      participants: [{ ...participant("one", "transit"), mode: "walk" }],
      tolerancePercent: 12,
    }),
  );
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "INVALID_REQUEST");

  const tooLarge = await POST(
    new Request("http://localhost/api/meeting/calculate", {
      method: "POST",
      body: "x".repeat(MAX_MEETING_REQUEST_BODY_BYTES + 1),
    }),
  );
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error.code, "REQUEST_TOO_LARGE");
});

test("provider failures return 503 without exposing origins", async () => {
  const unavailableProviders: MeetingProviders = {
    ...fixtureProviders,
    routing: {
      ...fixtureProviders.routing,
      getTravelTimeMatrix: async () => {
        throw new Error("provider is down");
      },
    },
  };
  const response = await handleMeetingPost(
    jsonRequest({
      participants: [participant("one", "transit"), participant("two", "transit")],
      departureAt: FIXED_DEPARTURE_AT,
    }),
    unavailableProviders,
  );
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(JSON.stringify(body).includes("48.1374"), false);
});

test("resolved locations are checked against the official Munich boundary", async () => {
  const outOfBoundsProviders: MeetingProviders = {
    ...fixtureProviders,
    geocoding: {
      ...fixtureProviders.geocoding,
      resolveLocation: async (location) => ({
        ...location,
        latitude: OFFICIAL_MUNICH_BOUNDARY_BOUNDS.maxLatitude + 1,
        source: "test-geocoder",
      }),
    },
  };
  const response = await handleMeetingPost(
    jsonRequest({
      participants: [participant("one", "transit"), participant("two", "transit")],
      departureAt: FIXED_DEPARTURE_AT,
    }),
    outOfBoundsProviders,
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "INVALID_REQUEST");
  assert.equal(
    body.error.issues[0].code,
    "resolved_location_outside_official_munich_boundary",
  );
});

function participant(id: string, mode: "transit" | "bike" | "car") {
  return { id, location: { ...MARIENPLATZ, label: "Marienplatz" }, mode };
}

function participantAt(
  id: string,
  latitude: number,
  longitude: number,
  mode: "transit" | "bike" | "car",
) {
  return { id, location: { latitude, longitude, label: id }, mode };
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/meeting/calculate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function routingFeedEnvironment() {
  return {
    MEEET_ROUTING_MVG_SOURCE_URL: "https://feeds.example.test/mvg.zip",
    MEEET_ROUTING_MVG_LICENSE: "MVG deployment licence",
    MEEET_ROUTING_MVG_LICENSE_URL: "https://feeds.example.test/mvg-license",
    MEEET_ROUTING_MVG_ATTRIBUTION: "MVG deployment attribution",
    MEEET_ROUTING_MVG_VERSION: "mvg-fixture-feed-v1",
    MEEET_ROUTING_MVG_RETRIEVED_AT: FIXED_DEPARTURE_AT,
    MEEET_ROUTING_MVV_SOURCE_URL: "https://feeds.example.test/mvv.zip",
    MEEET_ROUTING_MVV_LICENSE: "MVV deployment licence",
    MEEET_ROUTING_MVV_LICENSE_URL: "https://feeds.example.test/mvv-license",
    MEEET_ROUTING_MVV_ATTRIBUTION: "MVV deployment attribution",
    MEEET_ROUTING_MVV_VERSION: "mvv-fixture-feed-v1",
    MEEET_ROUTING_MVV_RETRIEVED_AT: FIXED_DEPARTURE_AT,
  };
}

function sourceEnvironment(prefix: "MEEET_GEOCODING" | "MEEET_POI") {
  return {
    [`${prefix}_SOURCE_NAME`]: `${prefix} source`,
    [`${prefix}_SOURCE_URL`]: `https://sources.example.test/${prefix}`,
    [`${prefix}_LICENSE`]: "CC BY 4.0",
    [`${prefix}_LICENSE_URL`]: `https://sources.example.test/${prefix}-license`,
    [`${prefix}_ATTRIBUTION`]: `${prefix} attribution`,
    [`${prefix}_VERSION`]: `${prefix}-v1`,
    [`${prefix}_RETRIEVED_AT`]: FIXED_DEPARTURE_AT,
  };
}

function sha256File(relativePath: string): string {
  return createHash("sha256")
    .update(readFileSync(new URL(`../${relativePath}`, import.meta.url)))
    .digest("hex");
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isCanonicalUtcInstant, validateRoutingSnapshot } from "../lib/domain/routing-snapshot.ts";
import type { FetchImplementation } from "../lib/providers/http.ts";
import {
  createMeetingProviders,
  createSelfHostedRoutingAdapters,
} from "../lib/providers/factory.ts";
import {
  ProviderConfigurationError,
  readProviderConfig,
} from "../lib/providers/config.ts";
import type { GeoJsonMultiPolygon, GeoJsonPolygon } from "../lib/domain/types.ts";
import {
  GraphHopperRoutingProvider,
  OtpGraphqlRoutingProvider,
  OTP_PAGE_SIZE,
  isLineStringWithinRoutingAccessEnvelope,
  isPointInRoutingAccessEnvelope,
} from "../lib/providers/self-hosted-routing.ts";

const GRAPH_HASH = "b".repeat(64);
const GRAPHHOPPER_HASH = "e".repeat(64);
const OTP_IMAGE_HASH = "f".repeat(64);
const DEPARTURE = "2026-07-25T08:00:00.000Z";
const ORIGIN = { latitude: 48.1374, longitude: 11.5755 };
const DESTINATION = { latitude: 48.145, longitude: 11.58 };

test("self-hosted config loads a generated manifest and exposes an unavailable calculation foundation", () => {
  const fixture = manifestFixture();
  try {
    const config = readProviderConfig(selfHostedEnvironment(fixture.path));
    assert.equal(config.mode, "self-hosted-routing");
    assert.equal(config.selfHostedRouting?.manifestPath, fixture.path);
    assert.equal(config.selfHostedRouting?.snapshot.contractVersion, "meeet-routing-manifest/v1");
    assert.deepEqual(Object.keys(config.selfHostedRouting?.snapshot ?? {}).sort(), [
      "accessEnvelope",
      "artifacts",
      "config",
      "contractVersion",
      "engine",
      "engines",
      "feeds",
      "generatedAt",
      "manifestId",
      "officialBoundary",
      "osm",
      "profiles",
      "realtime",
    ]);
    assert.equal(config.selfHostedRouting?.snapshot.artifacts.graph.contentHash, GRAPH_HASH);
    assert.equal(config.selfHostedRouting?.snapshot.artifacts.input.id, "routing-inputs/example");
    assert.equal(config.selfHostedRouting?.snapshot.accessEnvelope.extentKm, 15);
    assert.equal(config.selfHostedRouting?.snapshot.engines.otp.digest, `sha256:${OTP_IMAGE_HASH}`);
    assert.equal(config.selfHostedRouting?.snapshot.feeds.find((feed) => feed.name === "MVV")?.role, "authoritative-schedule");

    const providers = createMeetingProviders(selfHostedEnvironment(fixture.path));
    const routing = providers.routing;
    assert.ok(routing);
    assert.equal(routing.descriptor.name, "self-hosted-route-first-foundation");
    assert.equal(providers.routingFoundation?.state, "configured-foundation");
    assert.equal(providers.routingFoundation?.calculationAvailable, false);
    assert.equal(providers.routingFoundation?.applicationState.mvv.applied, true);
    assert.equal(providers.routingFoundation?.applicationState.mvg.applied, false);
    assert.equal(providers.routingFoundation?.applicationState.realtime.applied, false);
    assert.deepEqual(routing.capabilities.supportedModes, []);
    assert.equal(routing.descriptor.liveData, false);
    assert.equal(providers.routingSnapshot?.manifestId, "example-manifest");

    const adapters = createSelfHostedRoutingAdapters(config);
    assert.equal(adapters.transit.descriptor.engine, "otp");
    assert.equal(adapters.bikeCar.descriptor.engine, "graphhopper");
    assert.equal(adapters.transit.descriptor.snapshot.engine, "otp");
    assert.equal(adapters.transit.descriptor.snapshot.graphArtifact.id, "otp-graph");
    assert.equal(adapters.bikeCar.descriptor.snapshot.engine, "graphhopper");
    assert.equal(adapters.bikeCar.descriptor.snapshot.graphArtifact.id, "graphhopper-artifact");
  } finally {
    fixture.cleanup();
  }
});

test("manifest validation rejects operator-tampered provenance and envelope identity", () => {
  const fixture = manifestFixture();
  try {
    const manifest = JSON.parse(readFileSync(fixture.path, "utf8")) as Record<string, unknown>;
    (manifest.engines as Record<string, Record<string, unknown>>).otp.digest = "sha256:not-a-digest";
    (manifest.accessEnvelope as Record<string, unknown>).extentKm = 12;
    const result = validateRoutingSnapshot(manifest);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.issues.some((issue) => issue.code === "invalid_digest"));
      assert.ok(result.issues.some((issue) => issue.code === "invalid_value"));
    }
  } finally {
    fixture.cleanup();
  }
});

test("access-envelope point containment is polygon based and boundary inclusive", () => {
  const envelope: GeoJsonPolygon = {
    type: "Polygon" as const,
    coordinates: [[
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ], [
      [3, 3],
      [7, 3],
      [7, 7],
      [3, 7],
      [3, 3],
    ]],
  };
  assert.equal(isPointInRoutingAccessEnvelope([0, 5], envelope), true);
  assert.equal(isPointInRoutingAccessEnvelope([5, 5], envelope), false);
  assert.equal(isPointInRoutingAccessEnvelope([2, 2], envelope), true);
  assert.equal(isPointInRoutingAccessEnvelope([11, 5], envelope), false);
});

test("access-envelope validation rejects segments through holes, concavities, and disconnected polygons", () => {
  const concave: GeoJsonPolygon = {
    type: "Polygon",
    coordinates: [[
      [0, 0], [4, 0], [4, 4], [3, 4], [3, 1], [1, 1], [1, 4], [0, 4], [0, 0],
    ]],
  };
  const holed: GeoJsonPolygon = {
    type: "Polygon",
    coordinates: [
      [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
      [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]],
    ],
  };
  const disconnected: GeoJsonMultiPolygon = {
    type: "MultiPolygon",
    coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      [[[3, 0], [4, 0], [4, 1], [3, 1], [3, 0]]],
    ],
  };
  const crossingLine = (from: [number, number], to: [number, number]) => ({
    type: "LineString" as const,
    coordinates: [from, to],
  });

  assert.equal(isLineStringWithinRoutingAccessEnvelope(crossingLine([0.5, 3.5], [3.5, 3.5]), concave), false);
  assert.equal(isLineStringWithinRoutingAccessEnvelope(crossingLine([0.5, 2], [3.5, 2]), holed), false);
  assert.equal(isLineStringWithinRoutingAccessEnvelope(crossingLine([0.2, 0.2], [0.8, 0.8]), disconnected), true);
  assert.equal(isLineStringWithinRoutingAccessEnvelope(crossingLine([0.5, 0.5], [3.5, 0.5]), disconnected), false);
});

test("departure instants use the canonical UTC contract", () => {
  assert.equal(isCanonicalUtcInstant("2026-07-25T08:00:00.000Z"), true);
  assert.equal(isCanonicalUtcInstant("2026-07-25T08:00:00Z"), true);
  assert.equal(isCanonicalUtcInstant("2026-02-31T08:00:00.000Z"), false);
  assert.equal(isCanonicalUtcInstant("2026-07-25T08:00:00+00:00"), false);
});

test("self-hosted configuration requires a manifest and permits HTTP only on loopback development endpoints", () => {
  const fixture = manifestFixture();
  try {
    const missingManifest = selfHostedEnvironment(join(fixture.directory, "missing.json"));
    assert.throws(() => readProviderConfig(missingManifest), ProviderConfigurationError);
    assert.throws(
      () => readProviderConfig(selfHostedEnvironment(fixture.path, { MEEET_ROUTING_MVG_ATTRIBUTION: "operator claim" })),
      /manifest|environment claims/,
    );

    const nonLoopback = selfHostedEnvironment(fixture.path, {
      MEEET_ALLOW_HTTP_PROVIDER_ENDPOINTS: "true",
      NODE_ENV: "development",
      MEEET_OTP_GRAPHQL_URL: "http://10.0.0.5/otp/gtfs/v1",
    });
    assert.throws(() => readProviderConfig(nonLoopback), /loopback/);

    const loopback = selfHostedEnvironment(fixture.path, {
      MEEET_ALLOW_HTTP_PROVIDER_ENDPOINTS: "true",
      NODE_ENV: "development",
      MEEET_OTP_GRAPHQL_URL: "http://127.0.0.1/otp/gtfs/v1",
      MEEET_GRAPHHOPPER_URL: "http://localhost/route",
    });
    assert.equal(readProviderConfig(loopback).selfHostedRouting?.otpGraphqlUrl, "http://127.0.0.1/otp/gtfs/v1");
  } finally {
    fixture.cleanup();
  }
});

test("routing integration gate variables do not alter application provider mode", () => {
  assert.equal(readProviderConfig({ MEEET_ROUTING_INTEGRATION_REQUIRED: "false" }).mode, "configured");
});

test("OTP 2.6 Relay planConnection parses paginated edges, routing errors, and exact geometry/timing", async () => {
  const fixture = manifestFixture();
  try {
    let calls = 0;
    const fetchImplementation: FetchImplementation = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        variables: {
          origin: unknown;
          destination: unknown;
          dateTime: unknown;
          modes: unknown;
          first: number;
          after: string | null;
        };
      };
      assert.deepEqual(body.variables.origin, {
        label: "origin",
        location: { coordinate: ORIGIN },
      });
      assert.deepEqual(body.variables.destination, {
        label: "destination",
        location: { coordinate: DESTINATION },
      });
      assert.deepEqual(body.variables.dateTime, { earliestDeparture: DEPARTURE });
      assert.deepEqual(body.variables.modes, {
        transit: {
          access: ["WALK"],
          egress: ["WALK"],
          transfer: ["WALK"],
          transit: [
            { mode: "BUS" },
            { mode: "TRAM" },
            { mode: "SUBWAY" },
            { mode: "RAIL" },
            { mode: "GONDOLA" },
            { mode: "FERRY" },
          ],
        },
        transitOnly: true,
      });
      assert.equal(body.variables.first, OTP_PAGE_SIZE);
      calls += 1;
      const firstPage = body.variables.after === null;
      return Response.json({
        data: {
          planConnection: {
            edges: [{
              cursor: firstPage ? "cursor-1" : "cursor-2",
              node: otpItinerary(firstPage ? "2026-07-25T08:30:00.000Z" : "2026-07-25T08:35:00.000Z"),
            }],
            pageInfo: {
              hasNextPage: firstPage,
              endCursor: firstPage ? "cursor-1" : null,
            },
            routingErrors: [],
          },
        },
      });
    };
    const config = readProviderConfig(selfHostedEnvironment(fixture.path));
    const provider = new OtpGraphqlRoutingProvider(config, fetchImplementation);
    const result = await provider.route({ origin: ORIGIN, destination: DESTINATION, departureAt: DEPARTURE, mode: "transit" });
    assert.equal(calls, 2);
    assert.equal(result.exhaustive, false);
    assert.equal(result.routes.length, 2);
    assert.equal(result.snapshot.engine, "otp");
    assert.equal(result.snapshot.graphArtifact.id, "otp-graph");
    assert.deepEqual(result.routes[0].steps.map((step) => step.mode), ["walk", "wait", "transit"]);
    assert.equal(result.routes[0].steps[0]?.arrivalAt, "2026-07-25T08:05:00.000Z");
    assert.equal(result.routes[0].steps[1]?.kind, "wait");
    assert.equal(result.routes[0].steps[1]?.durationMilliseconds, 300_000);
    assert.equal(result.routes[0].steps.filter((step) => step.kind === "leg")
      .reduce((total, step) => total + step.durationMilliseconds, 0), 1_500_000);
    assert.equal(result.routes[0].durationMilliseconds, 1_800_000);
    assert.equal(result.routes[0].durationSeconds, 1_800);
    assert.equal(result.routes[0].geometry?.coordinates.length, 3);
  } finally {
    fixture.cleanup();
  }
});

test("OTP timing rejects overlapping legs and missing leg geometry", async () => {
  const fixture = manifestFixture();
  try {
    const config = readProviderConfig(selfHostedEnvironment(fixture.path));
    const request = { origin: ORIGIN, destination: DESTINATION, departureAt: DEPARTURE, mode: "transit" as const };
    const overlapping = otpItinerary("2026-07-25T08:30:00.000Z");
    const overlappingLegs = overlapping.legs as Array<Record<string, unknown>>;
    (overlappingLegs[1]?.start as Record<string, unknown>).scheduledTime = "2026-07-25T08:04:00.000Z";
    overlappingLegs[1]!.duration = 1_560;
    const overlappingProvider = new OtpGraphqlRoutingProvider(config, async () => Response.json({
      data: { planConnection: { edges: [{ node: overlapping }], pageInfo: { hasNextPage: false, endCursor: null }, routingErrors: [] } },
    }));
    await assert.rejects(overlappingProvider.route(request), /overlap|out of order/);

    const missingGeometry = otpItinerary("2026-07-25T08:30:00.000Z");
    const missingGeometryLegs = missingGeometry.legs as Array<Record<string, unknown>>;
    missingGeometryLegs[0]!.legGeometry = null;
    const missingGeometryProvider = new OtpGraphqlRoutingProvider(config, async () => Response.json({
      data: { planConnection: { edges: [{ node: missingGeometry }], pageInfo: { hasNextPage: false, endCursor: null }, routingErrors: [] } },
    }));
    await assert.rejects(missingGeometryProvider.route(request), /leg geometry/);
  } finally {
    fixture.cleanup();
  }
});

test("OTP timestamps reject epoch or malformed scalars and incomplete realtime estimates", async () => {
  const fixture = manifestFixture();
  try {
    const config = readProviderConfig(selfHostedEnvironment(fixture.path));
    const request = { origin: ORIGIN, destination: DESTINATION, departureAt: DEPARTURE, mode: "transit" as const };
    const providerFor = (node: Record<string, unknown>) => new OtpGraphqlRoutingProvider(config, async () => Response.json({
      data: { planConnection: { edges: [{ node }], pageInfo: { hasNextPage: false, endCursor: null }, routingErrors: [] } },
    }));

    const epochTimestamp = otpItinerary("2026-07-25T08:30:00.000Z");
    epochTimestamp.start = Date.parse(DEPARTURE);
    await assert.rejects(providerFor(epochTimestamp).route(request), /RFC3339 OffsetDateTime/);

    const malformedTimestamp = otpItinerary("2026-07-25T08:30:00.000Z");
    malformedTimestamp.end = "2026-07-25 08:30:00";
    await assert.rejects(providerFor(malformedTimestamp).route(request), /RFC3339 OffsetDateTime/);

    const incompleteEstimate = otpItinerary("2026-07-25T08:30:00.000Z");
    const legs = incompleteEstimate.legs as Array<Record<string, unknown>>;
    (legs[0]!.end as Record<string, unknown>).estimated = {};
    await assert.rejects(providerFor(incompleteEstimate).route(request), /estimated time is required/);
  } finally {
    fixture.cleanup();
  }
});

test("GraphHopper /route preserves integer milliseconds and rejects broken path geometry", async () => {
  const fixture = manifestFixture();
  try {
    const fetchImplementation: FetchImplementation = async () => Response.json({
      paths: [{
        distance: 1_250,
        time: 600_001,
        points: {
          type: "LineString",
          coordinates: [[ORIGIN.longitude, ORIGIN.latitude], [11.58, 48.14], [DESTINATION.longitude, DESTINATION.latitude]],
        },
        instructions: [
          { text: "Continue", time: 300_000, interval: [0, 1] },
          { text: "Arrive", time: 300_001, interval: [1, 2] },
        ],
      }],
    });
    const config = readProviderConfig(selfHostedEnvironment(fixture.path));
    const provider = new GraphHopperRoutingProvider(config, fetchImplementation);
    const result = await provider.route({ origin: ORIGIN, destination: DESTINATION, departureAt: DEPARTURE, mode: "bike" });
    assert.equal(result.routes[0].durationMilliseconds, 600_001);
    assert.equal(result.routes[0].durationSeconds, null);
    assert.equal(result.routes[0].steps[1].departureAt, "2026-07-25T08:05:00.000Z");
    assert.equal(result.snapshot.engine, "graphhopper");
    assert.equal(result.snapshot.graphArtifact.id, "graphhopper-artifact");

    await assert.rejects(
      provider.route({ origin: ORIGIN, destination: DESTINATION, departureAt: "2026-07-25T08:00:00+00:00", mode: "bike" }),
      /canonical UTC departure instant/,
    );

    const incompleteInstructions = new GraphHopperRoutingProvider(config, async () => Response.json({
      paths: [{
        distance: 100,
        time: 1_000,
        points: { type: "LineString", coordinates: [[ORIGIN.longitude, ORIGIN.latitude], [11.58, 48.14], [DESTINATION.longitude, DESTINATION.latitude]] },
        instructions: [{ text: "Only part of the path", time: 1_000, interval: [0, 1] }],
      }],
    }));
    await assert.rejects(
      incompleteInstructions.route({ origin: ORIGIN, destination: DESTINATION, departureAt: DEPARTURE, mode: "bike" }),
      /final path coordinate/,
    );

    const broken = new GraphHopperRoutingProvider(config, async () => Response.json({
      paths: [{
        distance: 100,
        time: 1_000,
        points: { type: "LineString", coordinates: [[11.2, 48.1], [11.3, 48.2]] },
      }],
    }));
    await assert.rejects(
      broken.route({ origin: ORIGIN, destination: DESTINATION, departureAt: DEPARTURE, mode: "car" }),
      /access envelope|endpoint tolerance/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("self-hosted adapters fail closed on GraphQL routing errors, malformed payloads, and response limits", async () => {
  const fixture = manifestFixture();
  try {
    const config = readProviderConfig(selfHostedEnvironment(fixture.path, { MEEET_PROVIDER_MAX_RESPONSE_BYTES: "16384" }));
    const routingError = new OtpGraphqlRoutingProvider(config, async () => Response.json({
      data: { planConnection: { edges: [], pageInfo: { hasNextPage: false, endCursor: null }, routingErrors: [{ code: "NO_PATH" }] } },
    }));
    await assert.rejects(
      routingError.route({ origin: ORIGIN, destination: DESTINATION, departureAt: DEPARTURE, mode: "transit" }),
      /routingErrors/,
    );
    const oversized = new GraphHopperRoutingProvider(config, async () => new Response("x".repeat(20_000)));
    await assert.rejects(
      oversized.route({ origin: ORIGIN, destination: DESTINATION, departureAt: DEPARTURE, mode: "car" }),
      /response-size|response exceeds/i,
    );
  } finally {
    fixture.cleanup();
  }
});

test(
  "REQUIRED pinned OTP 2.6 gate introspects the live schema and executes paginated planConnection",
  {
    skip: process.env.MEEET_ROUTING_INTEGRATION_OTP_URL
      ? false
      : process.env.MEEET_ROUTING_INTEGRATION_REQUIRED === "true"
        ? false
        : "MEEET_ROUTING_INTEGRATION_OTP_URL is not configured",
  },
  async () => {
    const endpoint = process.env.MEEET_ROUTING_INTEGRATION_OTP_URL;
    if (!endpoint) {
      assert.fail("REQUIRED OTP integration gate did not run: configure MEEET_ROUTING_INTEGRATION_OTP_URL.");
    }
    const schemaResponse = await postOtp(endpoint, OTP_INTROSPECTION_QUERY);
    assertNoGraphqlErrors(schemaResponse);
    const schema = schemaResponse.data?.__schema as {
      queryType?: { fields?: Array<{ name?: string; args?: Array<{ name?: string; type?: unknown }> }> };
    } | undefined;
    const planConnection = schema?.queryType?.fields?.find((field) => field.name === "planConnection");
    assert.ok(planConnection, "pinned OTP schema must expose planConnection");
    const argumentTypes = new Map((planConnection.args ?? []).map((argument) => [argument.name, typeRefString(argument.type)]));
    assert.equal(argumentTypes.get("origin"), "PlanLabeledLocationInput!");
    assert.equal(argumentTypes.get("destination"), "PlanLabeledLocationInput!");
    assert.equal(argumentTypes.get("dateTime"), "PlanDateTimeInput");
    assert.equal(argumentTypes.get("modes"), "PlanModesInput");
    assert.equal(argumentTypes.get("first"), "Int");
    assert.equal(argumentTypes.get("after"), "String");

    const types = (schemaResponse.data?.__schema as {
      types?: Array<{ name?: string; inputFields?: Array<{ name?: string; type?: unknown }> }>;
    } | undefined)?.types ?? [];
    assert.deepEqual(inputFieldNames(types, "PlanLabeledLocationInput"), ["label", "location"]);
    assert.deepEqual(inputFieldNames(types, "PlanDateTimeInput"), ["earliestDeparture", "latestArrival"]);
    assert.equal(inputFieldType(types, "PlanDateTimeInput", "earliestDeparture"), "OffsetDateTime");
    assert.equal(inputFieldType(types, "PlanDateTimeInput", "latestArrival"), "OffsetDateTime");
    assert.deepEqual(inputFieldNames(types, "PlanModesInput"), ["direct", "directOnly", "transit", "transitOnly"]);
    assert.deepEqual(inputFieldNames(types, "PlanTransitModesInput"), ["access", "egress", "transfer", "transit"]);
    assert.equal(inputFieldType(types, "PlanModesInput", "transit"), "PlanTransitModesInput");

    const fixture = manifestFixture();
    try {
      let calls = 0;
      const afterValues: Array<string | null> = [];
      const endpointUrl = new URL(endpoint);
      const fetchImplementation: FetchImplementation = async (input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          variables?: {
            origin?: unknown;
            destination?: unknown;
            dateTime?: unknown;
            modes?: unknown;
            after?: string | null;
          };
        };
        assert.deepEqual(body.variables?.origin, {
          label: "origin",
          location: { coordinate: ORIGIN },
        });
        assert.deepEqual(body.variables?.destination, {
          label: "destination",
          location: { coordinate: DESTINATION },
        });
        assert.deepEqual(body.variables?.dateTime, { earliestDeparture: "2026-08-01T08:00:00.000Z" });
        assert.deepEqual(body.variables?.modes, {
          transit: {
            access: ["WALK"],
            egress: ["WALK"],
            transfer: ["WALK"],
            transit: [
              { mode: "BUS" },
              { mode: "TRAM" },
              { mode: "SUBWAY" },
              { mode: "RAIL" },
              { mode: "GONDOLA" },
              { mode: "FERRY" },
            ],
          },
          transitOnly: true,
        });
        afterValues.push(body.variables?.after ?? null);
        calls += 1;
        return fetch(input, init);
      };
      const config = readProviderConfig(selfHostedEnvironment(fixture.path, {
        MEEET_OTP_GRAPHQL_URL: endpoint,
        ...(endpointUrl.protocol === "http:"
          ? { MEEET_ALLOW_HTTP_PROVIDER_ENDPOINTS: "true", NODE_ENV: "development" }
          : {}),
      }));
      const provider = new OtpGraphqlRoutingProvider(config, fetchImplementation);
      const result = await provider.route({
        origin: ORIGIN,
        destination: DESTINATION,
        departureAt: "2026-08-01T08:00:00.000Z",
        mode: "transit",
      });
      assert.ok(result.routes.length > 0, "the imported fixture graph must yield parsed OTP routes");
      assert.equal(result.snapshot.engine, "otp");
      assert.equal(result.snapshot.graphArtifact.id, "otp-graph");
      assert.ok(calls >= 1, "the application provider must execute planConnection");
      assert.equal(afterValues[0], null);
      if (calls > 1) assert.equal(typeof afterValues[1], "string");
    } finally {
      fixture.cleanup();
    }
  },
);

const OTP_INTROSPECTION_QUERY = `
  query InspectPlanConnection {
    __schema {
      queryType {
        fields {
          name
          args { name type { kind name ofType { kind name ofType { kind name } } } }
        }
      }
      types {
        name
        inputFields { name type { kind name ofType { kind name ofType { kind name } } } }
      }
    }
  }
`;

async function postOtp(
  endpoint: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data?: Record<string, unknown>; errors?: unknown[] }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
  });
  assert.equal(response.ok, true);
  return await response.json() as { data?: Record<string, unknown>; errors?: unknown[] };
}

function assertNoGraphqlErrors(response: { errors?: unknown[] }): void {
  assert.deepEqual(response.errors ?? [], []);
}

function typeRefString(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const type = value as { kind?: string; name?: string; ofType?: unknown };
  if (type.kind === "NON_NULL") return `${typeRefString(type.ofType)}!`;
  if (type.kind === "LIST") return `[${typeRefString(type.ofType)}]`;
  return type.name ?? "";
}

function inputFieldNames(
  types: Array<{ name?: string; inputFields?: Array<{ name?: string; type?: unknown }> }>,
  name: string,
): string[] {
  const type = types.find((candidate) => candidate.name === name);
  return (type?.inputFields ?? []).map((field) => field.name ?? "").sort();
}

function inputFieldType(
  types: Array<{ name?: string; inputFields?: Array<{ name?: string; type?: unknown }> }>,
  typeName: string,
  fieldName: string,
): string {
  const type = types.find((candidate) => candidate.name === typeName);
  const field = type?.inputFields?.find((candidate) => candidate.name === fieldName);
  return typeRefString(field?.type);
}

function otpItinerary(endTime: string): Record<string, unknown> {
  const midpoint = { lat: 48.138, lon: 11.576 };
  const transitStart = "2026-07-25T08:10:00.000Z";
  const transitDuration = (Date.parse(endTime) - Date.parse(transitStart)) / 1_000;
  const totalDuration = (Date.parse(endTime) - Date.parse(DEPARTURE)) / 1_000;
  return {
    start: DEPARTURE,
    end: endTime,
    duration: totalDuration,
    legs: [
      {
        mode: "WALK",
        start: { scheduledTime: DEPARTURE, estimated: null },
        end: { scheduledTime: "2026-07-25T08:05:00.000Z", estimated: { time: "2026-07-25T08:05:00.000Z" } },
        duration: 300,
        from: { lat: ORIGIN.latitude, lon: ORIGIN.longitude },
        to: midpoint,
        legGeometry: { points: encodePolyline([[ORIGIN.longitude, ORIGIN.latitude], [midpoint.lon, midpoint.lat]]) },
      },
      {
        mode: "SUBWAY",
        start: { scheduledTime: transitStart, estimated: null },
        end: { scheduledTime: endTime, estimated: null },
        duration: transitDuration,
        from: { lat: midpoint.lat, lon: midpoint.lon, gtfsId: "mvg-origin" },
        to: { lat: DESTINATION.latitude, lon: DESTINATION.longitude, gtfsId: "mvg-destination" },
        route: { gtfsId: "MVG:U3", shortName: "U3", mode: "SUBWAY" },
        legGeometry: { points: encodePolyline([[midpoint.lon, midpoint.lat], [DESTINATION.longitude, DESTINATION.latitude]]) },
      },
    ],
  };
}

function manifestFixture(): { path: string; directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "meeet-routing-manifest-"));
  const path = join(directory, "meeet-routing-manifest.json");
  const envelopePath = join(directory, "munich-access-envelope-15km.geojson");
  const envelopeBytes = JSON.stringify({
    type: "FeatureCollection",
    crs: { type: "name", properties: { name: "EPSG:25832" } },
    features: [{
      type: "Feature",
      properties: { kind: "official-munich-access-envelope", radiusMeters: 15_000 },
      geometry: {
        type: "Polygon",
        coordinates: [[[680_000, 5_320_000], [710_000, 5_320_000], [710_000, 5_350_000], [680_000, 5_350_000], [680_000, 5_320_000]]],
      },
    }],
  }, null, 2) + "\n";
  writeFileSync(envelopePath, envelopeBytes);
  const envelopeHash = createHash("sha256").update(envelopeBytes).digest("hex");
  const manifest = JSON.parse(readFileSync(
    join(process.cwd(), "routing/manifest/canonical-output.fixture.json"),
    "utf8",
  )) as Record<string, unknown>;
  const accessEnvelope = manifest.accessEnvelope as Record<string, unknown>;
  const accessArtifact = accessEnvelope.artifact as Record<string, unknown>;
  accessArtifact.contentHash = envelopeHash;
  const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(path, manifestBytes);
  writeFileSync(join(directory, "deployment-attestation.json"), JSON.stringify({
    contractVersion: "meeet-routing-manifest/v1",
    manifestId: manifest.manifestId,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    generatedAt: manifest.generatedAt,
    transformations: [
      { id: "mvv-authoritative-schedule", applied: true },
      { id: "mvg-metadata-enrichment", applied: false },
      { id: "realtime-overlay", applied: false },
      { id: "official-munich-access-envelope-15km", applied: true },
      { id: "otp-graph-import", applied: true },
      { id: "graphhopper-profile-import", applied: true },
    ],
    artifacts: {
      otpGraph: { id: "otp-graph", role: "generated-graph", path: "routing/otp/data/graphs/versions/otp-graph", contentHash: GRAPH_HASH },
      graphhopper: { id: "graphhopper-artifact", role: "generated-graph", path: "routing/graphhopper/data/artifacts/versions/graphhopper", contentHash: GRAPHHOPPER_HASH },
    },
    accessEnvelope: {
      path: envelopePath,
      crs: "EPSG:25832",
      radiusMeters: 15_000,
      artifact: { id: "munich-access-envelope-15km", contentHash: envelopeHash },
    },
  }, null, 2));
  return { path, directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function encodePolyline(coordinates: readonly [number, number][]): string {
  let previousLatitude = 0;
  let previousLongitude = 0;
  return coordinates.map(([longitude, latitude]) => {
    const nextLatitude = Math.round(latitude * 100_000);
    const nextLongitude = Math.round(longitude * 100_000);
    const encoded = encodePolylineValue(nextLatitude - previousLatitude) + encodePolylineValue(nextLongitude - previousLongitude);
    previousLatitude = nextLatitude;
    previousLongitude = nextLongitude;
    return encoded;
  }).join("");
}

function encodePolylineValue(value: number): string {
  let encoded = value < 0 ? ~(value << 1) : value << 1;
  let result = "";
  while (encoded >= 0x20) {
    result += String.fromCharCode((0x20 | (encoded & 0x1f)) + 63);
    encoded >>= 5;
  }
  return result + String.fromCharCode(encoded + 63);
}

function selfHostedEnvironment(
  manifestPath: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    MEEET_PROVIDER_MODE: "self-hosted-routing",
    MEEET_PROVIDER_DEPLOYMENT: "self-hosted",
    MEEET_PROVIDER_TIMEOUT_MS: "1000",
    MEEET_PROVIDER_MAX_RESPONSE_BYTES: "65536",
    MEEET_OTP_GRAPHQL_URL: "https://otp.example.test/otp/gtfs/v1",
    MEEET_OTP_PROFILE: "TRANSIT,WALK",
    MEEET_GRAPHHOPPER_URL: "https://gh.example.test/route",
    MEEET_GRAPHHOPPER_BIKE_PROFILE: "bike",
    MEEET_GRAPHHOPPER_CAR_PROFILE: "car",
    MEEET_ROUTING_MANIFEST_PATH: manifestPath,
    ...overrides,
  };
}

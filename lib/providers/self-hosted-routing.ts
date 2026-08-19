import "server-only";

import { isWithinOfficialMunichBoundary } from "../domain/boundary.ts";
import { haversineDistanceKm } from "../domain/geo.ts";
import type {
  GeoJsonLineString,
  LocationCoordinate,
  PointToPointRoute,
  PointToPointRouteStep,
  PointToPointRoutingRequest,
  PointToPointRoutingResult,
  PointToPointStepMode,
  GeoJsonGeometry,
  RoutingProviderCapabilities,
  RoutingSnapshot,
  SelfHostedRoutingAdapterDescriptor,
  TransitLineReference,
  TravelMode,
  ProviderDescriptor,
} from "../domain/types.ts";
import { ROUTE_FIRST_CONTRACT_VERSION } from "../domain/types.ts";
import { isCanonicalUtcInstant } from "../domain/routing-snapshot.ts";
import type { RoutingMatrixRequest, RoutingMatrixResponse } from "../domain/types.ts";
import { UNAVAILABLE_ROUTING_PROVIDER_CAPABILITIES } from "../domain/providers.ts";
import type { PointToPointRoutingProvider, RoutingProvider } from "../domain/providers.ts";
import type { ProviderConfig, SelfHostedRoutingConfig } from "./config.ts";
import {
  createHttpJsonClient,
  type FetchImplementation,
} from "./http.ts";

export type {
  PointToPointRoute,
  PointToPointRouteStep,
  PointToPointRoutingRequest,
  PointToPointRoutingResult,
  PointToPointStepMode,
  SelfHostedRoutingAdapterDescriptor,
} from "../domain/types.ts";
export type { PointToPointRoutingProvider } from "../domain/providers.ts";

export const SELF_HOSTED_ROUTE_CONTRACT_VERSION = ROUTE_FIRST_CONTRACT_VERSION;
export const MAX_OTP_ITINERARIES = 8;
export const OTP_PAGE_SIZE = 4;
export const MAX_OTP_PAGES = 2;
export const MAX_OTP_LEGS_PER_ITINERARY = 100;
export const MAX_GRAPHHOPPER_PATHS = 8;
export const MAX_GRAPHHOPPER_INSTRUCTIONS = 500;
export const MAX_ROUTE_GEOMETRY_POSITIONS = 20_000;
export const ROUTE_ENDPOINT_TOLERANCE_METERS = 1_000;
export const ROUTE_GEOMETRY_CONTINUITY_TOLERANCE_METERS = 5;

export const OTP_PLAN_CONNECTION_QUERY = `
  query PlanConnection(
    $origin: PlanLabeledLocationInput!,
    $destination: PlanLabeledLocationInput!,
    $dateTime: PlanDateTimeInput,
    $modes: PlanModesInput,
    $first: Int,
    $after: String
  ) {
    planConnection(
      origin: $origin
      destination: $destination
      dateTime: $dateTime
      modes: $modes
      first: $first
      after: $after
    ) {
      edges {
        cursor
        node {
          start
          end
          duration
          legs {
            mode
            start { scheduledTime estimated { time } }
            end { scheduledTime estimated { time } }
            duration
            from { name lat lon stop { gtfsId } }
            to { name lat lon stop { gtfsId } }
            route { gtfsId shortName longName mode }
            headsign
            distance
            legGeometry { points }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
      routingErrors { code description }
    }
  }
`;

export type SelfHostedRoutingOptions = SelfHostedRoutingConfig | ProviderConfig;

const OTP_CAPABILITIES: RoutingProviderCapabilities = {
  supportedModes: ["transit"],
  maxParticipants: 1,
  maxDestinations: 1,
  maxMatrixEntries: 1,
};

const GRAPHHOPPER_CAPABILITIES: RoutingProviderCapabilities = {
  supportedModes: ["bike", "car"],
  maxParticipants: 1,
  maxDestinations: 1,
  maxMatrixEntries: 1,
};

export class OtpGraphqlRoutingProvider implements PointToPointRoutingProvider {
  readonly descriptor: SelfHostedRoutingAdapterDescriptor;
  private readonly config: SelfHostedRoutingConfig;
  private readonly client: ReturnType<typeof createHttpJsonClient>;

  constructor(
    config: SelfHostedRoutingOptions,
    fetchImplementation?: FetchImplementation,
  ) {
    this.config = getSelfHostedRoutingConfig(config);
    this.descriptor = {
      engine: "otp",
      endpoint: this.config.otpGraphqlUrl,
      profile: this.config.otpProfile,
      capabilities: OTP_CAPABILITIES,
      snapshot: this.config.engineSnapshots.otp,
      exhaustive: false,
    };
    this.client = createHttpJsonClient(
      this.config.otpGraphqlUrl,
      this.config,
      this.config.otpToken,
      fetchImplementation,
    );
  }

  async route(request: PointToPointRoutingRequest): Promise<PointToPointRoutingResult> {
    validateRouteRequest(request, "transit");
    const rawItineraries: unknown[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_OTP_PAGES; page += 1) {
      const response = await this.client.postJson<unknown>(
        {
          query: OTP_PLAN_CONNECTION_QUERY,
          variables: {
            origin: toOtpLocation(request.origin, "origin"),
            destination: toOtpLocation(request.destination, "destination"),
            dateTime: toOtpDateTime(request.departureAt),
            modes: toOtpModes(),
            first: OTP_PAGE_SIZE,
            after,
          },
        },
        request.signal,
      );
      const result = readOtpPage(response);
      rawItineraries.push(...result.itineraries);
      if (rawItineraries.length > MAX_OTP_ITINERARIES) throw new Error("OTP planConnection response exceeds the itinerary limit.");
      if (!result.hasNextPage) break;
      if (!result.endCursor) throw new Error("OTP planConnection pageInfo is missing endCursor.");
      after = result.endCursor;
      if (page === MAX_OTP_PAGES - 1) throw new Error("OTP planConnection pagination exceeds the bounded page limit.");
    }
    return {
      contractVersion: SELF_HOSTED_ROUTE_CONTRACT_VERSION,
      routes: rawItineraries.map((itinerary) => parseOtpItinerary(
        itinerary,
        request,
        this.config.accessEnvelopeGeometry,
      )),
      exhaustive: false,
      snapshot: this.config.engineSnapshots.otp,
    };
  }
}

export class GraphHopperRoutingProvider implements PointToPointRoutingProvider {
  readonly descriptor: SelfHostedRoutingAdapterDescriptor;
  private readonly config: SelfHostedRoutingConfig;
  private readonly client: ReturnType<typeof createHttpJsonClient>;

  constructor(
    config: SelfHostedRoutingOptions,
    fetchImplementation?: FetchImplementation,
  ) {
    this.config = getSelfHostedRoutingConfig(config);
    this.descriptor = {
      engine: "graphhopper",
      endpoint: this.config.graphhopperUrl,
      profile: `${this.config.graphhopperBikeProfile},${this.config.graphhopperCarProfile}`,
      capabilities: GRAPHHOPPER_CAPABILITIES,
      snapshot: this.config.engineSnapshots.graphhopper,
      exhaustive: false,
    };
    this.client = createHttpJsonClient(
      this.config.graphhopperUrl,
      this.config,
      this.config.graphhopperToken,
      fetchImplementation,
    );
  }

  async route(request: PointToPointRoutingRequest): Promise<PointToPointRoutingResult> {
    validateRouteRequest(request, "bike", "car");
    const profile = request.mode === "bike"
      ? this.config.graphhopperBikeProfile
      : this.config.graphhopperCarProfile;
    const endpoint = new URL(this.config.graphhopperUrl);
    endpoint.searchParams.set("point", `${request.origin.latitude},${request.origin.longitude}`);
    endpoint.searchParams.append("point", `${request.destination.latitude},${request.destination.longitude}`);
    endpoint.searchParams.set("profile", profile);
    endpoint.searchParams.set("points_encoded", "false");
    endpoint.searchParams.set("instructions", "true");
    endpoint.searchParams.set("calc_points", "true");
    const response = await this.client.getJson<unknown>(endpoint.toString(), request.signal);
    const path = parseGraphHopperPath(response);
    const route = parseGraphHopperRoute(
      path,
      request,
      profile,
      this.config.accessEnvelopeGeometry,
    );
    return {
      contractVersion: SELF_HOSTED_ROUTE_CONTRACT_VERSION,
      routes: route ? [route] : [],
      exhaustive: false,
      snapshot: this.config.engineSnapshots.graphhopper,
    };
  }
}

/** Explicit transitional seam: the route-first foundation is configured, but the matrix calculation is not migrated. */
export class CalculationUnavailableRoutingProvider implements RoutingProvider {
  readonly capabilities = UNAVAILABLE_ROUTING_PROVIDER_CAPABILITIES;
  readonly descriptor: ProviderDescriptor;

  constructor(snapshot: RoutingSnapshot) {
    const realtimeApplied = false;
    const liveData = realtimeApplied && snapshot.realtime.dataState === "live";
    const dataKind = liveData
      ? "live"
      : snapshot.realtime.dataState === "scheduled"
        ? "scheduled"
        : "unknown";
    this.descriptor = {
      name: "self-hosted-route-first-foundation",
      deployment: "self-hosted",
      dataKind,
      liveData,
      asOf: snapshot.generatedAt,
      notes: "Configured route-first routing foundation; meeting matrix calculation remains unavailable until migration.",
      provenance: {
        role: "routing",
        provider: "self-hosted-route-first-foundation",
        deployment: "self-hosted",
        dataKind,
        liveData,
        sourceUrl: null,
        license: null,
        attribution: `${snapshot.feeds.find((feed) => feed.name === "MVV")?.attribution ?? "MVV"}; ${snapshot.feeds.find((feed) => feed.name === "MVG")?.attribution ?? "MVG"}; ${snapshot.osm.attribution}`,
        version: snapshot.manifestId,
        retrievedAt: snapshot.generatedAt,
        notes: "Configured route-first routing foundation; calculation is intentionally unavailable.",
        feeds: {
          mvg: toFeedProvenance(snapshot, "MVG"),
          mvv: toFeedProvenance(snapshot, "MVV"),
        },
      },
    };
  }

  async getTravelTimeMatrix(request: RoutingMatrixRequest): Promise<RoutingMatrixResponse> {
    void request;
    throw new Error("Meeting matrix calculation is unavailable in self-hosted-routing until route-first migration.");
  }
}

export const OtpGraphqlTransitProvider = OtpGraphqlRoutingProvider;
export const GraphHopperPointToPointProvider = GraphHopperRoutingProvider;

function getSelfHostedRoutingConfig(
  config: SelfHostedRoutingOptions,
): SelfHostedRoutingConfig {
  if ("selfHostedRouting" in config) {
    if (!config.selfHostedRouting) {
      throw new Error("Self-hosted routing configuration is required.");
    }
    return config.selfHostedRouting;
  }
  return config;
}

function toFeedProvenance(snapshot: RoutingSnapshot, name: "MVG" | "MVV") {
  const feed = snapshot.feeds.find((candidate) => candidate.name === name);
  if (!feed) throw new Error(`Routing manifest is missing the ${name} feed.`);
  return {
    name: feed.name,
    sourceUrl: feed.sourceUrl,
    license: feed.license,
    attribution: feed.attribution,
    version: feed.version,
    retrievedAt: feed.retrievedAt,
  };
}

function readOtpPage(value: unknown): {
  itineraries: unknown[];
  hasNextPage: boolean;
  endCursor: string | null;
} {
  if (!isRecord(value)) throw new Error("OTP GraphQL response must be an object.");
  if (Array.isArray(value.errors) && value.errors.length > 0) {
    throw new Error("OTP GraphQL response contains errors.");
  }
  const data = isRecord(value.data) ? value.data : value;
  const connection = isRecord(data.planConnection) ? data.planConnection : null;
  if (!connection) throw new Error("OTP GraphQL response is missing planConnection.");
  if (connection.errors !== undefined && connection.errors !== null &&
    (!Array.isArray(connection.errors) || connection.errors.length > 0)) {
    throw new Error("OTP planConnection response contains errors.");
  }
  if (connection.routingErrors !== undefined && connection.routingErrors !== null &&
    (!Array.isArray(connection.routingErrors) || connection.routingErrors.length > 0)) {
    throw new Error("OTP planConnection response contains routingErrors.");
  }
  if (!Array.isArray(connection.edges) || !isRecord(connection.pageInfo)) {
    throw new Error("OTP planConnection response is missing Relay edges or pageInfo.");
  }
  if (typeof connection.pageInfo.hasNextPage !== "boolean" ||
    (connection.pageInfo.endCursor !== null && typeof connection.pageInfo.endCursor !== "string")) {
    throw new Error("OTP planConnection pageInfo is malformed.");
  }
  const itineraries = connection.edges.map((edge) => {
      if (!isRecord(edge) || !isRecord(edge.node)) throw new Error("OTP planConnection edge is malformed.");
      return edge.node;
  });
  return {
    itineraries,
    hasNextPage: connection.pageInfo.hasNextPage,
    endCursor: connection.pageInfo.endCursor,
  };
}

function parseOtpItinerary(
  value: unknown,
  request: PointToPointRoutingRequest,
  accessEnvelopeGeometry: GeoJsonGeometry,
): PointToPointRoute {
  if (!isRecord(value) || !Array.isArray(value.legs) || value.legs.length === 0 || value.legs.length > MAX_OTP_LEGS_PER_ITINERARY) {
    throw new Error("OTP itinerary must contain a bounded legs array.");
  }
  const legs = value.legs.map((leg) => parseOtpLeg(leg));
  const steps = addOtpWaitingSteps(legs);
  const departureAt = parseOtpOffsetDateTime(value.start, "OTP itinerary start");
  const arrivalAt = parseOtpOffsetDateTime(value.end, "OTP itinerary end");
  const durationSeconds = requiredDurationSeconds(value.duration, "OTP itinerary duration");
  const durationMilliseconds = durationSeconds * 1_000;
  if (arrivalAt < departureAt || Date.parse(arrivalAt) - Date.parse(departureAt) !== durationMilliseconds) {
    throw new Error("OTP itinerary contains invalid timing.");
  }
  validateStepTimeline(steps, departureAt, arrivalAt, durationMilliseconds);
  const geometry = mergeStepGeometry(steps, accessEnvelopeGeometry);
  validateRequestEndpoints(geometry, request);
  return {
    mode: "transit",
    durationMilliseconds,
    durationSeconds,
    departureAt,
    arrivalAt,
    geometry,
    steps,
    source: "self-hosted-otp",
  };
}

function parseOtpLeg(value: unknown): PointToPointRouteStep {
  if (!isRecord(value)) throw new Error("OTP itinerary leg must be an object.");
  const mode = parseOtpMode(value.mode);
  const from = parseOtpLocation(value.from, "OTP leg from");
  const to = parseOtpLocation(value.to, "OTP leg to");
  const departureAt = otpLegTimestamp(value.start, "OTP leg start");
  const arrivalAt = otpLegTimestamp(value.end, "OTP leg end");
  const durationSeconds = requiredDurationSeconds(value.duration, "OTP leg duration");
  const durationMilliseconds = durationSeconds * 1_000;
  if (arrivalAt < departureAt || Date.parse(arrivalAt) - Date.parse(departureAt) !== durationMilliseconds) {
    throw new Error("OTP leg contains invalid timing.");
  }
  const transit = mode === "transit";
  const line = transit ? parseOtpLine(value.route) : null;
  const fromStopId = transit ? parseOptionalStopId(value.from) : null;
  const toStopId = transit ? parseOptionalStopId(value.to) : null;
  const modeLabel = transit ? `Take ${line?.identity ?? "transit"}` : "Walk";
  const headsign = typeof value.headsign === "string" && value.headsign.trim()
    ? ` toward ${value.headsign.trim()}`
    : "";
  return {
    kind: "leg",
    mode,
    instruction: `${modeLabel}${headsign} from ${fromStopId ?? "origin"} to ${toStopId ?? "destination"}.`,
    from,
    to,
    fromStopId,
    toStopId,
    line,
    departureAt,
    arrivalAt,
    durationMilliseconds,
    durationSeconds,
    geometry: parseRequiredLegGeometry(value.legGeometry, from, to, "OTP leg geometry"),
  };
}

function addOtpWaitingSteps(legs: readonly PointToPointRouteStep[]): PointToPointRouteStep[] {
  const steps: PointToPointRouteStep[] = [];
  let previous: PointToPointRouteStep | null = null;
  for (const leg of legs) {
    if (previous) {
      const previousArrival = Date.parse(previous.arrivalAt);
      const departure = Date.parse(leg.departureAt);
      if (departure < previousArrival) {
        throw new Error("OTP itinerary legs overlap or are out of order.");
      }
      if (departure > previousArrival) {
        const durationMilliseconds = departure - previousArrival;
        steps.push({
          kind: "wait",
          mode: "wait",
          instruction: "Wait for the next leg.",
          from: previous.to,
          to: leg.from,
          fromStopId: previous.toStopId,
          toStopId: leg.fromStopId,
          line: null,
          departureAt: previous.arrivalAt,
          arrivalAt: leg.departureAt,
          durationMilliseconds,
          durationSeconds: durationMilliseconds % 1_000 === 0 ? durationMilliseconds / 1_000 : null,
          geometry: null,
        });
      }
    }
    steps.push(leg);
    previous = leg;
  }
  return steps;
}

function parseGraphHopperPath(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !Array.isArray(value.paths)) {
    throw new Error("GraphHopper response must contain a paths array.");
  }
  if (value.paths.length > MAX_GRAPHHOPPER_PATHS) {
    throw new Error("GraphHopper response exceeds the path limit.");
  }
  if (value.paths.length === 0) return null;
  const path = value.paths[0];
  if (!isRecord(path)) throw new Error("GraphHopper path is malformed.");
  return path;
}

function parseGraphHopperRoute(
  path: Record<string, unknown> | null,
  request: PointToPointRoutingRequest,
  profile: string,
  accessEnvelopeGeometry: GeoJsonGeometry,
): PointToPointRoute | null {
  if (!path) return null;
  const time = integerInRange(path.time, 0, 24 * 60 * 60 * 1_000, "GraphHopper path time");
  numberInRange(path.distance, 0, Number.MAX_SAFE_INTEGER, "GraphHopper path distance");
  const geometry = parseRequiredLineString(path.points, "GraphHopper path points");
  validateGeometryEnvelope(geometry, accessEnvelopeGeometry);
  validateRequestEndpoints(geometry, request);
  const arrivalAt = new Date(Date.parse(request.departureAt) + time).toISOString();
  const steps = parseGraphHopperInstructions(path.instructions, geometry, request, time);
  return {
    mode: request.mode,
    durationMilliseconds: time,
    durationSeconds: time % 1_000 === 0 ? time / 1_000 : null,
    departureAt: request.departureAt,
    arrivalAt,
    geometry,
    steps,
    source: `self-hosted-graphhopper:${profile}`,
  };
}

function parseGraphHopperInstructions(
  value: unknown,
  geometry: GeoJsonLineString,
  request: PointToPointRoutingRequest,
  totalTimeMs: number,
): PointToPointRouteStep[] {
  if (value === undefined) {
    return [summaryRouteStep(request, geometry, totalTimeMs)];
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_GRAPHHOPPER_INSTRUCTIONS) {
    throw new Error("GraphHopper instructions are malformed or exceed the limit.");
  }
  const steps = value.map((instruction, index) => {
    if (!isRecord(instruction)) throw new Error("GraphHopper instruction is malformed.");
    const text = firstString(instruction, ["text", "instruction"]);
    if (!text) throw new Error("GraphHopper instruction is missing text.");
    const interval = instruction.interval;
    if (!Array.isArray(interval) || interval.length !== 2 ||
      !Number.isInteger(interval[0]) || !Number.isInteger(interval[1]) ||
      interval[0] < 0 || interval[1] < interval[0] || interval[1] >= geometry.coordinates.length ||
      (interval[1] === interval[0] && instruction.time !== 0)) {
      throw new Error("GraphHopper instruction interval is invalid.");
    }
    const start = geometry.coordinates[interval[0]];
    const end = geometry.coordinates[interval[1]];
    const rawTime = integerInRange(instruction.time, 0, totalTimeMs, "GraphHopper instruction time");
    if (index > 0) {
      const previous = value[index - 1];
      if (!isRecord(previous) || !Array.isArray(previous.interval) || interval[0] !== previous.interval[1]) {
        throw new Error("GraphHopper instruction geometry is discontinuous.");
      }
    } else if (interval[0] !== 0) {
      throw new Error("GraphHopper instructions do not start at the path origin.");
    }
    const startAt = new Date(Date.parse(request.departureAt) + instructionOffset(value, index)).toISOString();
    const endAt = new Date(Date.parse(startAt) + rawTime).toISOString();
    return {
      kind: "leg" as const,
      mode: request.mode,
      instruction: text,
      from: fromPosition(start),
      to: fromPosition(end),
      fromStopId: null,
      toStopId: null,
      line: null,
      departureAt: startAt,
      arrivalAt: endAt,
      durationMilliseconds: rawTime,
      durationSeconds: rawTime % 1_000 === 0 ? rawTime / 1_000 : null,
      geometry: interval[1] === interval[0]
        ? null
        : {
          type: "LineString" as const,
          coordinates: geometry.coordinates.slice(interval[0], interval[1] + 1),
        },
    };
  });
  const finalInstruction = value[value.length - 1];
  if (!isRecord(finalInstruction) || !Array.isArray(finalInstruction.interval) ||
    finalInstruction.interval[1] !== geometry.coordinates.length - 1) {
    throw new Error("GraphHopper instructions do not cover the final path coordinate.");
  }
  const totalInstructionTime = steps.reduce((sum, step) => sum + step.durationMilliseconds, 0);
  if (totalInstructionTime !== totalTimeMs) throw new Error("GraphHopper instruction times do not sum to path time.");
  return steps;
}

function instructionOffset(value: unknown[], index: number): number {
  return value.slice(0, index).reduce<number>((total, item) =>
    isRecord(item) && typeof item.time === "number" && Number.isFinite(item.time)
      ? total + Math.max(0, item.time)
      : total,
  0);
}

function summaryRouteStep(
  request: PointToPointRoutingRequest,
  geometry: GeoJsonLineString,
  durationMs: number,
): PointToPointRouteStep {
  return {
    kind: "leg",
    mode: request.mode,
    instruction: `${request.mode === "bike" ? "Bike" : "Drive"} to destination.`,
    from: request.origin,
    to: request.destination,
    fromStopId: null,
    toStopId: null,
    line: null,
    departureAt: request.departureAt,
    arrivalAt: new Date(Date.parse(request.departureAt) + durationMs).toISOString(),
    durationMilliseconds: durationMs,
    durationSeconds: durationMs % 1_000 === 0 ? durationMs / 1_000 : null,
    geometry,
  };
}

function parseOtpLocation(value: unknown, label: string): LocationCoordinate {
  if (!isRecord(value)) throw new Error(`${label} is missing.`);
  const nested = isRecord(value.coordinate) ? value.coordinate : isRecord(value.location) ? value.location : value;
  const latitude = firstNumber(nested, ["latitude", "lat"]);
  const longitude = firstNumber(nested, ["longitude", "lon", "lng"]);
  if (latitude === null || longitude === null || !isFiniteCoordinate(latitude, longitude)) {
    throw new Error(`${label} has invalid coordinates.`);
  }
  return { latitude, longitude };
}

function parseOtpMode(value: unknown): PointToPointStepMode {
  if (typeof value !== "string") throw new Error("OTP leg mode is missing.");
  const mode = value.trim().toUpperCase();
  if (["TRANSIT", "BUS", "TRAM", "SUBWAY", "RAIL", "TRAIN", "GONDOLA", "FERRY"].includes(mode)) return "transit";
  if (["WALK", "FOOT", "ACCESS", "EGRESS"].includes(mode)) return "walk";
  throw new Error(`OTP returned unsupported leg mode ${mode}.`);
}

function parseOtpLine(value: unknown): TransitLineReference {
  if (!isRecord(value)) throw new Error("OTP transit leg is missing a route.");
  const identity = firstString(value, ["gtfsId", "shortName", "longName", "id"]);
  const type = firstString(value, ["mode", "type"]);
  if (!identity || !type) throw new Error("OTP transit route is missing line identity or type.");
  return { identity, type: type.toUpperCase() };
}

function parseOptionalStopId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const stop = isRecord(value.stop) ? value.stop : value;
  return firstString(stop, ["gtfsId", "id", "name"]);
}

function parseRequiredLineString(value: unknown, label: string): GeoJsonLineString {
  if (!isRecord(value) || value.type !== "LineString" || !Array.isArray(value.coordinates) || value.coordinates.length < 2 || value.coordinates.length > MAX_ROUTE_GEOMETRY_POSITIONS) {
    throw new Error(`${label} must be a bounded GeoJSON LineString.`);
  }
  const coordinates = value.coordinates.map((position) => {
    if (!Array.isArray(position) || position.length !== 2 ||
      typeof position[0] !== "number" || typeof position[1] !== "number" ||
      !isFiniteCoordinate(position[1], position[0])) {
      throw new Error(`${label} contains invalid coordinates.`);
    }
    return [position[0], position[1]] as [number, number];
  });
  return { type: "LineString", coordinates };
}

function decodePolyline(value: string, label: string): GeoJsonLineString {
  if (value.length > MAX_ROUTE_GEOMETRY_POSITIONS * 16) {
    throw new Error(`${label} exceeds the encoded geometry limit.`);
  }
  const coordinates: Array<[number, number]> = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  while (index < value.length) {
    const latitudeDelta = decodePolylineValue(value, () => index++, label);
    const longitudeDelta = decodePolylineValue(value, () => index++, label);
    latitude += latitudeDelta;
    longitude += longitudeDelta;
    const coordinate: [number, number] = [longitude / 100_000, latitude / 100_000];
    if (!isFiniteCoordinate(coordinate[1], coordinate[0])) throw new Error(`${label} contains invalid coordinates.`);
    coordinates.push(coordinate);
    if (coordinates.length > MAX_ROUTE_GEOMETRY_POSITIONS) throw new Error(`${label} exceeds the geometry limit.`);
  }
  if (coordinates.length < 2) throw new Error(`${label} must contain at least two positions.`);
  return { type: "LineString", coordinates };
}

function decodePolylineValue(
  value: string,
  nextIndex: () => number,
  label: string,
): number {
  let result = 0;
  let shift = 0;
  while (true) {
    const index = nextIndex();
    if (index >= value.length) throw new Error(`${label} has invalid polyline encoding.`);
    const code = value.charCodeAt(index) - 63;
    if (code < 0 || code > 63) throw new Error(`${label} has invalid polyline encoding.`);
    result |= (code & 0x1f) << shift;
    shift += 5;
    if (code < 0x20) break;
    if (shift > 30) throw new Error(`${label} has an overlong polyline value.`);
  }
  return (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
}

function mergeStepGeometry(
  steps: readonly PointToPointRouteStep[],
  accessEnvelopeGeometry: GeoJsonGeometry,
): GeoJsonLineString {
  const coordinates: Array<[number, number]> = [];
  for (const [index, step] of steps.entries()) {
    if (step.kind === "wait") continue;
    const geometry = step.geometry;
    if (!geometry) throw new Error("OTP itinerary leg geometry is required.");
    validateGeometryEnvelope(geometry, accessEnvelopeGeometry);
    const first = geometry.coordinates[0];
    const previous = coordinates[coordinates.length - 1];
    if (previous && distanceMeters(previous, first) > ROUTE_GEOMETRY_CONTINUITY_TOLERANCE_METERS) {
      throw new Error(`OTP itinerary geometry is discontinuous before leg ${index}.`);
    }
    for (const coordinate of geometry.coordinates) {
      const last = coordinates[coordinates.length - 1];
      if (!last || last[0] !== coordinate[0] || last[1] !== coordinate[1]) coordinates.push(coordinate);
    }
  }
  if (coordinates.length < 2) throw new Error("OTP itinerary geometry must contain at least two positions.");
  return { type: "LineString", coordinates };
}

function parseRequiredLegGeometry(
  value: unknown,
  from: LocationCoordinate,
  to: LocationCoordinate,
  label: string,
): GeoJsonLineString {
  const geometry = isRecord(value) && typeof value.points === "string"
    ? decodePolyline(value.points, label)
    : parseRequiredLineString(value, label);
  if (distanceMeters(geometry.coordinates[0], [from.longitude, from.latitude]) > ROUTE_ENDPOINT_TOLERANCE_METERS ||
    distanceMeters(geometry.coordinates[geometry.coordinates.length - 1], [to.longitude, to.latitude]) > ROUTE_ENDPOINT_TOLERANCE_METERS) {
    throw new Error(`${label} does not reach its declared leg endpoints.`);
  }
  return geometry;
}

function parseOtpOffsetDateTime(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a valid RFC3339 OffsetDateTime.`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw new Error(`${label} must be a valid RFC3339 OffsetDateTime.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[9] ?? 0);
  const offsetMinute = Number(match[10] ?? 0);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59) {
    throw new Error(`${label} must be a valid RFC3339 OffsetDateTime.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be a valid RFC3339 OffsetDateTime.`);
  return new Date(timestamp).toISOString();
}

function otpLegTimestamp(value: unknown, label: string): string {
  if (!isRecord(value)) throw new Error(`${label} is missing.`);
  const scheduled = parseOtpOffsetDateTime(value.scheduledTime, `${label} scheduledTime`);
  if (value.estimated === null) return scheduled;
  if (!isRecord(value.estimated)) {
    throw new Error(`${label} estimated value is invalid.`);
  }
  if (value.estimated.time === undefined || value.estimated.time === null) {
    throw new Error(`${label} estimated time is required.`);
  }
  return parseOtpOffsetDateTime(value.estimated.time, `${label} estimated time`);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function requiredDurationSeconds(value: unknown, label: string): number {
  return integerInRange(value, 0, 24 * 60 * 60, label);
}

function validateStepTimeline(
  steps: readonly PointToPointRouteStep[],
  departureAt: string,
  arrivalAt: string,
  durationMilliseconds: number,
): void {
  if (steps.length === 0 || steps[0].departureAt !== departureAt || steps[steps.length - 1].arrivalAt !== arrivalAt) {
    throw new Error("OTP itinerary leg times do not cover the itinerary interval.");
  }
  let previousArrival = Date.parse(departureAt);
  for (const step of steps) {
    const departure = Date.parse(step.departureAt);
    const arrival = Date.parse(step.arrivalAt);
    if ((step.kind === "wait" && step.mode !== "wait") ||
      (step.kind === "leg" && step.mode === "wait") ||
      departure < previousArrival || arrival < departure || arrival - departure !== step.durationMilliseconds) {
      throw new Error("OTP itinerary leg times are out of order or inconsistent with duration.");
    }
    previousArrival = arrival;
  }
  if (previousArrival - Date.parse(departureAt) !== durationMilliseconds) {
    throw new Error("OTP itinerary duration does not cover its ordered leg timeline.");
  }
}

export function isPointInRoutingAccessEnvelope(
  point: [number, number],
  envelope: GeoJsonGeometry,
): boolean {
  if (envelope.type === "Polygon") return isPointInPolygon(point, envelope.coordinates);
  return envelope.coordinates.some((polygon) => isPointInPolygon(point, polygon));
}

/** Validate the complete segment, not only its endpoint vertices. */
export function isLineStringWithinRoutingAccessEnvelope(
  lineString: GeoJsonLineString,
  envelope: GeoJsonGeometry,
): boolean {
  if (lineString.coordinates.length < 2) return false;
  for (let index = 0; index < lineString.coordinates.length - 1; index += 1) {
    const first = lineString.coordinates[index];
    const second = lineString.coordinates[index + 1];
    if (!first || !second ||
      !isPointInRoutingAccessEnvelope(first, envelope) ||
      !isPointInRoutingAccessEnvelope(second, envelope)) {
      return false;
    }
    const parameters = [0, 1];
    for (const rings of envelope.type === "Polygon"
      ? [envelope.coordinates]
      : envelope.coordinates) {
      for (const ring of rings) addSegmentIntersectionParameters(first, second, ring, parameters);
    }
    parameters.sort((left, right) => left - right);
    const uniqueParameters = parameters.filter((parameter, parameterIndex) =>
      parameterIndex === 0 || parameter - parameters[parameterIndex - 1]! > 1e-10,
    );
    for (let parameterIndex = 0; parameterIndex < uniqueParameters.length - 1; parameterIndex += 1) {
      const start = uniqueParameters[parameterIndex]!;
      const end = uniqueParameters[parameterIndex + 1]!;
      if (end - start <= 1e-10) continue;
      const midpoint = interpolate(first, second, (start + end) / 2);
      if (!isPointInRoutingAccessEnvelope(midpoint, envelope)) return false;
    }
  }
  return true;
}

function isPointInPolygon(
  point: [number, number],
  rings: [number, number][][],
): boolean {
  const [outerRing, ...holes] = rings;
  if (!outerRing || !isPointInRing(point, outerRing)) return false;
  return !holes.some((hole) => isPointStrictlyInsideRing(point, hole));
}

function isPointInRing(point: [number, number], ring: [number, number][]): boolean {
  if (ring.length < 4) return false;
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const current = ring[index];
    const prior = ring[previous];
    if (!current || !prior) return false;
    if (isPointOnSegment(point, prior, current)) return true;
    if ((current[1] > point[1]) !== (prior[1] > point[1])) {
      const intersection = (prior[0] - current[0]) * (point[1] - current[1]) /
        (prior[1] - current[1]) + current[0];
      if (point[0] < intersection) inside = !inside;
    }
  }
  return inside;
}

function isPointStrictlyInsideRing(
  point: [number, number],
  ring: [number, number][],
): boolean {
  if (ring.some((current, index) => {
    const previous = ring[index - 1] ?? ring[ring.length - 1];
    return previous ? isPointOnSegment(point, previous, current) : false;
  })) return false;
  return isPointInRingWithoutBoundary(point, ring);
}

function isPointInRingWithoutBoundary(point: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const current = ring[index];
    const prior = ring[previous];
    if (!current || !prior) return false;
    if ((current[1] > point[1]) !== (prior[1] > point[1])) {
      const intersection = (prior[0] - current[0]) * (point[1] - current[1]) /
        (prior[1] - current[1]) + current[0];
      if (point[0] < intersection) inside = !inside;
    }
  }
  return inside;
}

function isPointOnSegment(
  point: [number, number],
  first: [number, number],
  second: [number, number],
): boolean {
  const crossProduct =
    (point[1] - first[1]) * (second[0] - first[0]) -
    (point[0] - first[0]) * (second[1] - first[1]);
  if (Math.abs(crossProduct) > 1e-10) return false;
  return point[0] >= Math.min(first[0], second[0]) - 1e-10 &&
    point[0] <= Math.max(first[0], second[0]) + 1e-10 &&
    point[1] >= Math.min(first[1], second[1]) - 1e-10 &&
    point[1] <= Math.max(first[1], second[1]) + 1e-10;
}

function addSegmentIntersectionParameters(
  first: [number, number],
  second: [number, number],
  ring: [number, number][],
  parameters: number[],
): void {
  for (let index = 0; index < ring.length - 1; index += 1) {
    const edgeStart = ring[index];
    const edgeEnd = ring[index + 1];
    if (!edgeStart || !edgeEnd) continue;
    const segmentDirection: [number, number] = [second[0] - first[0], second[1] - first[1]];
    const edgeDirection: [number, number] = [edgeEnd[0] - edgeStart[0], edgeEnd[1] - edgeStart[1]];
    const difference: [number, number] = [edgeStart[0] - first[0], edgeStart[1] - first[1]];
    const denominator = crossProduct(segmentDirection, edgeDirection);
    if (Math.abs(denominator) > 1e-12) {
      const segmentParameter = crossProduct(difference, edgeDirection) / denominator;
      const edgeParameter = crossProduct(difference, segmentDirection) / denominator;
      if (segmentParameter >= -1e-10 && segmentParameter <= 1 + 1e-10 &&
        edgeParameter >= -1e-10 && edgeParameter <= 1 + 1e-10) {
        parameters.push(clampUnit(segmentParameter));
      }
      continue;
    }
    if (Math.abs(crossProduct(difference, segmentDirection)) > 1e-12) continue;
    const squaredLength = segmentDirection[0] ** 2 + segmentDirection[1] ** 2;
    if (squaredLength <= 1e-20) continue;
    parameters.push(clampUnit(
      ((edgeStart[0] - first[0]) * segmentDirection[0] +
        (edgeStart[1] - first[1]) * segmentDirection[1]) / squaredLength,
    ));
    parameters.push(clampUnit(
      ((edgeEnd[0] - first[0]) * segmentDirection[0] +
        (edgeEnd[1] - first[1]) * segmentDirection[1]) / squaredLength,
    ));
  }
}

function crossProduct(first: [number, number], second: [number, number]): number {
  return first[0] * second[1] - first[1] * second[0];
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function interpolate(
  first: [number, number],
  second: [number, number],
  parameter: number,
): [number, number] {
  return [
    first[0] + (second[0] - first[0]) * parameter,
    first[1] + (second[1] - first[1]) * parameter,
  ];
}

function validateGeometryEnvelope(
  geometry: GeoJsonLineString,
  envelope: GeoJsonGeometry,
): void {
  if (!isLineStringWithinRoutingAccessEnvelope(geometry, envelope)) {
    throw new Error("Route geometry leaves the immutable Munich access envelope.");
  }
}

function validateRequestEndpoints(
  geometry: GeoJsonLineString,
  request: PointToPointRoutingRequest,
): void {
  if (distanceMeters(geometry.coordinates[0], [request.origin.longitude, request.origin.latitude]) > ROUTE_ENDPOINT_TOLERANCE_METERS ||
    distanceMeters(geometry.coordinates[geometry.coordinates.length - 1], [request.destination.longitude, request.destination.latitude]) > ROUTE_ENDPOINT_TOLERANCE_METERS) {
    throw new Error("Route geometry is outside the snapped request endpoint tolerance.");
  }
}

function validateRouteRequest(
  request: PointToPointRoutingRequest,
  ...allowedModes: TravelMode[]
): void {
  if (!allowedModes.includes(request.mode)) throw new Error("The selected routing adapter does not support this mode.");
  if (!isFiniteCoordinate(request.origin.latitude, request.origin.longitude) || !isFiniteCoordinate(request.destination.latitude, request.destination.longitude)) {
    throw new Error("Routing requests require finite WGS84 coordinates.");
  }
  if (!isWithinOfficialMunichBoundary(request.origin) || !isWithinOfficialMunichBoundary(request.destination)) {
    throw new Error("Self-hosted routing is limited to the official Munich application boundary.");
  }
  if (!isCanonicalUtcInstant(request.departureAt)) {
    throw new Error("Routing requests require a canonical UTC departure instant.");
  }
}

function toOtpLocation(coordinate: LocationCoordinate, label: string): {
  label: string;
  location: { coordinate: { latitude: number; longitude: number } };
} {
  return {
    label,
    location: { coordinate: { latitude: coordinate.latitude, longitude: coordinate.longitude } },
  };
}

function toOtpDateTime(departureAt: string): { earliestDeparture: string } {
  return { earliestDeparture: departureAt };
}

function toOtpModes(): {
  transit: {
    access: Array<"WALK">;
    egress: Array<"WALK">;
    transfer: Array<"WALK">;
    transit: Array<{ mode: string }>;
  };
  transitOnly: true;
} {
  return {
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
  };
}

function numberInRange(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is outside its allowed range.`);
  }
  return value;
}

function integerInRange(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer in its allowed range.`);
  }
  return value;
}

function distanceMeters(first: [number, number], second: [number, number]): number {
  return haversineDistanceKm(
    { latitude: first[1], longitude: first[0] },
    { latitude: second[1], longitude: second[0] },
  ) * 1_000;
}

function fromPosition(position: [number, number]): LocationCoordinate {
  return { latitude: position[1], longitude: position[0] };
}

function firstString(value: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return null;
}

function firstNumber(value: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) return value[key];
  }
  return null;
}

function isFiniteCoordinate(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

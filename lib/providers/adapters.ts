import "server-only";

import {
  MAX_ROUTING_MATRIX_ENTRIES,
} from "../domain/grid.ts";
import {
  MEETING_TIME_ZONE,
} from "../domain/types.ts";
import type {
  GeoJsonGeometry,
  MeetingLocation,
  MeetingPointOfInterest,
  ProviderDescriptor,
  ProviderProvenance,
  ResolvedLocation,
  RoutingMatrixCell,
  RoutingMatrixRequest,
  RoutingMatrixResponse,
  TravelMode,
} from "../domain/types.ts";
import type {
  GeocodingProvider,
  PoiProvider,
  RoutingProvider,
} from "../domain/providers.ts";
import { FULL_ROUTING_PROVIDER_CAPABILITIES } from "../domain/providers.ts";
import type { ConfiguredSourceMetadata, ProviderConfig } from "./config.ts";
import {
  createHttpJsonClient,
  type FetchImplementation,
  HttpJsonClient,
} from "./http.ts";

const MAX_POI_RESULTS = 100;

export class GatewayRoutingProvider implements RoutingProvider {
  readonly descriptor: ProviderDescriptor;
  readonly capabilities = FULL_ROUTING_PROVIDER_CAPABILITIES;
  private readonly client: HttpJsonClient;

  constructor(
    private readonly config: ProviderConfig,
    fetchImplementation?: FetchImplementation,
  ) {
    this.descriptor = {
      name: "configured-routing-gateway",
      deployment: config.deployment,
      dataKind: "scheduled",
      liveData: false,
      asOf: "configured-runtime",
      notes:
        "Gateway contract only. The gateway owns bounded OTP scheduled calls, licensed MVG/MVV data, and configured OSRM car/bike tables; this adapter does not pretend OTP exposes a direct matrix endpoint.",
      provenance: createRoutingProvenance(config),
    };
    this.client = createHttpJsonClient(
      config.routingGatewayUrl ?? "",
      config,
      config.routingGatewayToken,
      fetchImplementation,
    );
  }

  async getTravelTimeMatrix(
    request: RoutingMatrixRequest,
  ): Promise<RoutingMatrixResponse> {
    const payload = {
      contractVersion: "meeet-routing-gateway/v1",
      departureAt: request.departureAt,
      timeZone: MEETING_TIME_ZONE,
      participants: request.participants,
      destinations: request.destinations,
    };
    const response = await this.client.postJson<unknown>(payload);
    return validateRoutingGatewayResponse(response, request);
  }
}

export class HttpGeocodingProvider implements GeocodingProvider {
  readonly descriptor: ProviderDescriptor;
  private readonly client: HttpJsonClient;

  constructor(
    private readonly config: ProviderConfig,
    fetchImplementation?: FetchImplementation,
  ) {
    this.descriptor = {
      name: "configured-geocoding-provider",
      deployment: config.deployment,
      dataKind: "unknown",
      liveData: false,
      asOf: "configured-runtime",
      notes: "Configured server-side geocoding adapter; provider attribution is deployment-specific.",
      provenance: createGenericProvenance(
        "geocoding",
        "configured-geocoding-provider",
        config,
        "Configured server-side geocoding adapter; provider attribution is deployment-specific.",
      ),
    };
    this.client = createHttpJsonClient(
      config.geocodingUrl ?? "",
      config,
      config.geocodingToken,
      fetchImplementation,
    );
  }

  async resolveLocation(location: MeetingLocation): Promise<ResolvedLocation> {
    const response = await this.client.postJson<unknown>({
        contractVersion: "meeet-geocoding/v1",
        timeZone: MEETING_TIME_ZONE,
        location,
      });
    if (
      !isRecord(response) ||
      response.contractVersion !== "meeet-geocoding/v1" ||
      !isRecord(response.source) ||
      !isRecord(response.location)
    ) {
      throw new Error("Configured geocoder response has an invalid shape.");
    }
    const resolved = response.location;
    const source = validateResponseSource(response.source, this.config.geocodingSource);
    if (
      typeof resolved.label !== "string" ||
      !resolved.label.trim() ||
      !isFiniteCoordinate(resolved.latitude, resolved.longitude)
    ) {
      throw new Error("Configured geocoder response has an invalid location.");
    }
    const latitude = resolved.latitude as number;
    const longitude = resolved.longitude as number;
    return {
      label: resolved.label.trim(),
      latitude,
      longitude,
      source:
        source.name,
    };
  }
}

export class HttpPoiProvider implements PoiProvider {
  readonly descriptor: ProviderDescriptor;
  private readonly client: HttpJsonClient;

  constructor(
    private readonly config: ProviderConfig,
    fetchImplementation?: FetchImplementation,
  ) {
    this.descriptor = {
      name: "configured-food-and-drink-provider",
      deployment: config.deployment,
      dataKind: "unknown",
      liveData: false,
      asOf: "configured-runtime",
      notes: "Configured server-side food/drink adapter; provider attribution is deployment-specific.",
      provenance: createGenericProvenance(
        "poi",
        "configured-food-and-drink-provider",
        config,
        "Configured server-side food/drink adapter; provider attribution is deployment-specific.",
      ),
    };
    this.client = createHttpJsonClient(
      config.poiUrl ?? "",
      config,
      config.poiToken,
      fetchImplementation,
    );
  }

  async findFoodAndDrink(
    corridor: GeoJsonGeometry,
  ): Promise<readonly MeetingPointOfInterest[]> {
    const response = await this.client.postJson<unknown>({
        contractVersion: "meeet-poi/v1",
        categories: ["food", "drink"],
        corridor,
      });
    if (
      !isRecord(response) ||
      response.contractVersion !== "meeet-poi/v1" ||
      !isRecord(response.source) ||
      !Array.isArray(response.pois)
    ) {
      throw new Error("Configured POI response has an invalid shape.");
    }
    if (response.pois.length > MAX_POI_RESULTS) {
      throw new Error("Configured POI response exceeds the result limit.");
    }
    const source = validateResponseSource(response.source, this.config.poiSource);
    const ids = new Set<string>();
    return response.pois.map((value) => {
      const poi = parsePoi(value, source.name);
      if (ids.has(poi.id)) {
        throw new Error("Configured POI response contains duplicate ids.");
      }
      ids.add(poi.id);
      return poi;
    });
  }
}

export function validateRoutingGatewayResponse(
  value: unknown,
  request: RoutingMatrixRequest,
): RoutingMatrixResponse {
  if (
    !isRecord(value) ||
    value.contractVersion !== "meeet-routing-gateway/v1" ||
    typeof value.departureAt !== "string" ||
    !Array.isArray(value.travelTimes)
  ) {
    throw new Error("Routing gateway response has an invalid shape.");
  }
  const expectedEntries = request.participants.length * request.destinations.length;
  if (
    expectedEntries > MAX_ROUTING_MATRIX_ENTRIES ||
    value.travelTimes.length !== expectedEntries
  ) {
    throw new Error("Routing gateway response does not match the bounded matrix.");
  }
  const cells = value.travelTimes.map(parseRoutingCell);
  return {
    contractVersion: "meeet-routing-gateway/v1",
    departureAt: value.departureAt,
    travelTimes: cells,
  };
}

function parseRoutingCell(value: unknown): RoutingMatrixCell {
  if (!isRecord(value)) {
    throw new Error("Routing gateway returned an invalid matrix cell.");
  }
  if (
    typeof value.participantId !== "string" ||
    typeof value.destinationId !== "string" ||
    !isTravelMode(value.mode) ||
    (value.status !== "ok" && value.status !== "unreachable") ||
    (value.status === "ok" &&
      (typeof value.minutes !== "number" ||
        !Number.isFinite(value.minutes) ||
        value.minutes < 0 ||
        value.minutes > 24 * 60)) ||
    (value.status === "unreachable" && value.minutes !== null) ||
    typeof value.source !== "string" ||
    value.source.trim().length === 0
  ) {
    throw new Error("Routing gateway returned an invalid matrix cell.");
  }
  return {
    participantId: value.participantId,
    destinationId: value.destinationId,
    mode: value.mode,
    status: value.status,
    minutes: value.minutes as number | null,
    source: value.source.trim(),
  };
}

function parsePoi(value: unknown, defaultSource: string): MeetingPointOfInterest {
  if (!isRecord(value)) {
    throw new Error("Configured POI response contains an invalid entry.");
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    (value.category !== "food" && value.category !== "drink") ||
    !Array.isArray(value.coordinates) ||
    value.coordinates.length !== 2 ||
    !isFiniteCoordinate(value.coordinates[1], value.coordinates[0])
  ) {
    throw new Error("Configured POI response contains an invalid entry.");
  }
  const longitude = value.coordinates[0] as number;
  const latitude = value.coordinates[1] as number;
  return {
    id: value.id,
    name: value.name,
    category: value.category,
    coordinates: [longitude, latitude],
    ...(typeof value.address === "string" ? { address: value.address } : {}),
    source:
      typeof value.source === "string" && value.source.trim()
        ? value.source.trim()
        : defaultSource,
  };
}

function isTravelMode(value: unknown): value is TravelMode {
  return value === "transit" || value === "bike" || value === "car";
}

function isFiniteCoordinate(latitude: unknown, longitude: unknown): boolean {
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateResponseSource(
  value: unknown,
  expected: ConfiguredSourceMetadata | null,
): ConfiguredSourceMetadata {
  if (!expected || !isRecord(value)) {
    throw new Error("Configured provider source provenance is not configured.");
  }
  if (
    value.name !== expected.name ||
    value.url !== expected.url ||
    !isRecord(value.license) ||
    value.license.name !== expected.license.name ||
    value.license.url !== expected.license.url ||
    value.attribution !== expected.attribution ||
    value.version !== expected.version ||
    value.retrievedAt !== expected.retrievedAt
  ) {
    throw new Error("Configured provider response provenance does not match configuration.");
  }
  return expected;
}

function createRoutingProvenance(config: ProviderConfig): ProviderProvenance {
  if (!config.routingFeeds) {
    throw new Error("Configured routing requires MVG and MVV feed provenance.");
  }
  return {
    role: "routing",
    provider: "configured-routing-gateway",
    deployment: config.deployment,
    dataKind: "scheduled",
    liveData: false,
    sourceUrl: null,
    license: null,
    attribution: `${config.routingFeeds.mvg.attribution}; ${config.routingFeeds.mvv.attribution}`,
    version: "configured-runtime",
    retrievedAt: new Date().toISOString(),
    notes:
      "Scheduled routing provenance is supplied by the deployment gateway; no realtime behavior is implied.",
    feeds: config.routingFeeds,
  };
}

function createGenericProvenance(
  role: "geocoding" | "poi",
  provider: string,
  config: ProviderConfig,
  notes: string,
): ProviderProvenance {
  const source = role === "geocoding" ? config.geocodingSource : config.poiSource;
  if (!source) {
    throw new Error(`Configured ${role} provider source provenance is required.`);
  }
  return {
    role,
    provider,
    deployment: config.deployment,
    dataKind: "unknown",
    liveData: false,
    sourceUrl: source.url,
    license: source.license,
    attribution: source.attribution,
    version: source.version,
    retrievedAt: source.retrievedAt,
    notes,
    feeds: null,
  };
}

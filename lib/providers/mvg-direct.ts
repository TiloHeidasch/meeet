import "server-only";

import { cacheLife } from "next/cache";
import { haversineDistanceKm } from "../domain/geo.ts";
import type {
  ProviderDescriptor,
  ProviderProvenance,
  CoordinateJourney,
  CoordinateJourneyPart,
  CoordinateJourneyRequest,
  CoordinateJourneyResult,
  JourneyEndpoint,
  RoutingMatrixCell,
  RoutingMatrixRequest,
  RoutingMatrixResponse,
  RoutingMatrixTimingMetadata,
  RoutingProviderCapabilities,
  RoutingParticipant,
  RouteAlternative,
  RouteAlternativeDiscoveryRequest,
  RouteAlternativeDiscoveryResult,
  RoutePart,
  RouteStationReference,
  TransitLineReference,
} from "../domain/types.ts";
import type {
  CoordinateJourneyProvider,
  RouteAlternativeProvider,
  RoutingProvider,
} from "../domain/providers.ts";
import { withRouteAlternativeIdentities } from "../domain/route-candidates.ts";
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  DEFAULT_PROVIDER_MAX_RESPONSE_BYTES,
  type ProviderConfig,
} from "./config.ts";
import {
  createHttpJsonClient,
  type HttpJsonFetchOptions,
  type FetchImplementation,
} from "./http.ts";
import {
  MVG_DIRECT_API_BASE_URL,
  MVG_DIRECT_NEARBY_CACHE_DECIMAL_PLACES,
  MVG_DIRECT_NEARBY_URL,
  MVG_DIRECT_ROUTES_URL,
  MVG_UPSTREAM_REVALIDATE_SECONDS,
} from "./mvg-constants.ts";
import {
  MVG_DIRECT_LIMITER,
  runMvgDirectCacheFill,
} from "./mvg-limiter.ts";

export {
  MVG_DIRECT_MAX_CONCURRENCY,
  runMvgDirectCacheFill,
} from "./mvg-limiter.ts";

export {
  MVG_DIRECT_API_BASE_URL,
  MVG_DIRECT_API_ORIGIN,
  MVG_DIRECT_LOCATIONS_URL,
  MVG_DIRECT_NEARBY_CACHE_DECIMAL_PLACES,
  MVG_DIRECT_NEARBY_URL,
  MVG_DIRECT_ROUTES_URL,
  MVG_UPSTREAM_REVALIDATE_SECONDS,
} from "./mvg-constants.ts";

export const MVG_DIRECT_SOURCE_URL = MVG_DIRECT_API_BASE_URL;
export const MVG_DIRECT_VERSION = "bgw-pt/v3";
export const MVG_DIRECT_TIMEOUT_MS = DEFAULT_PROVIDER_TIMEOUT_MS;
export const MVG_DIRECT_MATRIX_DEADLINE_MS = 12_000;
export const MVG_DIRECT_MAX_ITINERARY_DURATION_MS = 24 * 60 * 60 * 1_000;
export const MVG_DIRECT_MAX_RESPONSE_BYTES = 512 * 1024;
export const MVG_DIRECT_MAX_STATION_RESULTS = 100;
export const MVG_DIRECT_MAX_ROUTE_RESULTS = 100;
export const MVG_DIRECT_MAX_ROUTE_PARTS = 100;
export const MVG_DIRECT_MAX_ROUTE_ALTERNATIVES = 20;
export const MVG_DIRECT_MAX_LABEL_LENGTH = 512;
export const MVG_DIRECT_MAX_WALKING_TRANSIT_HANDOFF_OVERLAP_MS = 60_000;
export const MVG_DIRECT_MAX_SAME_STATION_ENDPOINT_DISPLACEMENT_METRES = 100;
export const MVG_DIRECT_MAX_RADIUS_METERS = 1_500;
export const MVG_DIRECT_COORDINATE_BINDING_TOLERANCE_METRES = 1;
export const MVG_DIRECT_WALKING_METERS_PER_MINUTE = 75;
export const MVG_DIRECT_MAX_ARRIVAL_DELAY_MINUTES = 24 * 60;
export const MVG_DIRECT_TRANSPORT_TYPES =
  "SCHIFF,UBAHN,TRAM,SBAHN,BUS,REGIONAL_BUS,BAHN";
const MVG_DIRECT_TRANSIT_TYPES = new Set(
  MVG_DIRECT_TRANSPORT_TYPES.split(","),
);

export const MVG_DIRECT_CAPABILITIES: RoutingProviderCapabilities = {
  supportedModes: ["transit"],
  maxParticipants: 4,
  maxDestinations: 19,
  maxMatrixEntries: 76,
};

const UNREACHABLE = null;

interface Station {
  id: string;
  latitude: number;
  longitude: number;
}

interface SnappedStation extends Station {
  walkingMinutes: number;
}

type ConfigLike = Partial<
  Pick<ProviderConfig, "deployment" | "maxResponseBytes" | "timeoutMs">
> & {
  /** Test-only override; production configuration uses the fixed 12-second deadline. */
  matrixDeadlineMs?: number;
};

interface MvgRoute {
  finalEffectiveArrival: number;
  hasTransit: boolean;
  usedRealtime: boolean;
}

interface MvgRouteResult {
  arrivalTimestamp: number;
  usedRealtime: boolean;
}

/**
 * Direct access to the unofficial MVG BGW PT endpoints. Realtime is used when
 * the final route part supplies a valid bounded arrival delay; planned time is
 * the fallback.
 * This class deliberately owns no configurable URL: the endpoint constants
 * above are the only network destinations it can use.
 */
export class MvgDirectRoutingProvider implements RoutingProvider, RouteAlternativeProvider, CoordinateJourneyProvider {
  readonly descriptor: ProviderDescriptor;
  readonly capabilities = MVG_DIRECT_CAPABILITIES;
  private readonly timeoutMs: number;
  private readonly matrixDeadlineMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImplementation: FetchImplementation;

  constructor(
    configOrFetch: ConfigLike | FetchImplementation = defaultConfig(),
    fetchImplementation: FetchImplementation = fetch,
  ) {
    const config = typeof configOrFetch === "function" ? defaultConfig() : configOrFetch;
    this.fetchImplementation =
      typeof configOrFetch === "function" ? configOrFetch : fetchImplementation;
    this.timeoutMs = config.timeoutMs ?? MVG_DIRECT_TIMEOUT_MS;
    this.matrixDeadlineMs = config.matrixDeadlineMs ?? MVG_DIRECT_MATRIX_DEADLINE_MS;
    this.maxResponseBytes = Math.min(
      config.maxResponseBytes ?? DEFAULT_PROVIDER_MAX_RESPONSE_BYTES,
      MVG_DIRECT_MAX_RESPONSE_BYTES,
    );
    const deployment = config.deployment ?? "unknown";
    const provenance: ProviderProvenance = {
      role: "routing",
      provider: "mvg-direct-routing",
      deployment,
      dataKind: "scheduled",
      liveData: false,
      sourceUrl: MVG_DIRECT_SOURCE_URL,
      license: null,
      attribution:
        "MVG BGW PT v3 scheduled coordinate routing; planned timestamps are authoritative for fairness; unofficial endpoint, no SLA.",
      version: MVG_DIRECT_VERSION,
      retrievedAt: new Date().toISOString(),
      notes:
        "Unofficial MVG BGW PT v3 endpoint with no SLA. Canonical meeting searches use scheduled coordinate-to-coordinate arrive-by journeys and do not use realtime for fairness.",
      feeds: null,
    };
    this.descriptor = {
      name: "mvg-direct-routing",
      deployment,
      dataKind: "scheduled",
      liveData: false,
      asOf: MVG_DIRECT_VERSION,
      notes: provenance.notes,
      provenance,
    };
  }

  /** Canonical coordinate-to-coordinate arrive-by journey seam. */
  async getCoordinateJourneys(
    request: CoordinateJourneyRequest,
  ): Promise<CoordinateJourneyResult> {
    if (request.signal?.aborted) throw new Error("MVG coordinate request was already aborted.");
    validateCoordinateJourneyRequest(request);
    const url = new URL(MVG_DIRECT_ROUTES_URL);
    url.searchParams.set("originLatitude", String(request.origin.latitude));
    url.searchParams.set("originLongitude", String(request.origin.longitude));
    url.searchParams.set("destinationLatitude", String(request.destination.latitude));
    url.searchParams.set("destinationLongitude", String(request.destination.longitude));
    url.searchParams.set("routingDateTime", request.arrivalAt);
    url.searchParams.set("routingDateTimeIsArrival", "true");
    url.searchParams.set("transportTypes", MVG_DIRECT_TRANSPORT_TYPES);
    url.searchParams.set("changeSpeed", "NORMAL");
    url.searchParams.set("routeType", "LEAST_TIME");
    if (request.viaStationGlobalId) {
      url.searchParams.set("viaStationGlobalId", request.viaStationGlobalId);
      url.searchParams.set("viaDwellTimeInMinutes", "10");
    }
    const operationSignal = request.signal ?? new AbortController().signal;
    const payload = await MVG_DIRECT_LIMITER.run(
      () => this.getJson(url.toString(), operationSignal, { cache: "no-store" }),
      operationSignal,
    );
    return {
      journeys: parseMvgCoordinateJourneys(payload, request),
      source: this.descriptor.name,
    };
  }

  async getTravelTimeMatrix(
    request: RoutingMatrixRequest,
  ): Promise<RoutingMatrixResponse> {
    if (request.signal?.aborted) throw new Error("MVG matrix request was already aborted.");
    validateRequest(request);
    const matrixController = new AbortController();
    const operationController = new AbortController();
    const abortOperation = () => operationController.abort();
    matrixController.signal.addEventListener("abort", abortOperation, { once: true });
    request.signal?.addEventListener("abort", abortOperation, { once: true });
    if (request.signal?.aborted) operationController.abort();
    const deadline = setTimeout(
      () => matrixController.abort(),
      this.matrixDeadlineMs,
    );
    const stationCache = new Map<string, Promise<SnappedStation | null>>();
    try {
      const snap = (
        coordinate: { latitude: number; longitude: number },
      ): Promise<SnappedStation | null> => {
        const key = coordinateKey(coordinate);
        const existing = stationCache.get(key);
        if (existing) return existing;
        const promise = this.fetchImplementation === globalThis.fetch
          ? this.findCachedNearestStation(coordinate, operationController.signal)
          : MVG_DIRECT_LIMITER.run(
              () => this.findNearestStation(coordinate, operationController.signal),
              operationController.signal,
            );
        stationCache.set(key, promise);
        return promise;
      };

      const originStations = await Promise.all(
        request.participants.map((participant) => snap(participant.origin)),
      );
      const destinationStations = await Promise.all(
        request.destinations.map((destination) => snap(destination.coordinate)),
      );

      const departureTimestamp = Date.parse(request.departureAt);
      const routeCache = new Map<string, Promise<MvgRouteResult | null>>();
      const routeCacheWithDestination = (
        origin: SnappedStation,
        destination: SnappedStation,
        destinationCoordinate: { latitude: number; longitude: number },
      ): Promise<{ minutes: number; usedRealtime: boolean } | null> => {
        const stationReadyAt = new Date(
          departureTimestamp + origin.walkingMinutes * 60_000,
        ).toISOString();
        const key = `${origin.id}\u0000${destination.id}\u0000${stationReadyAt}`;
        if (origin.id === destination.id) {
          return Promise.resolve(
            {
              minutes: roundMinutes(
                origin.walkingMinutes +
                  walkingMinutes(destinationCoordinate, destination),
              ),
              usedRealtime: false,
            },
          );
        }
        const existing = routeCache.get(key);
        const itinerary = existing ?? MVG_DIRECT_LIMITER.run(
          () => this.findEarliestEffectiveArrival(
            origin.id,
            destination.id,
            stationReadyAt,
            operationController.signal,
          ),
          operationController.signal,
        );
        if (!existing) routeCache.set(key, itinerary);
        return itinerary.then((routeResult) =>
          routeResult === null
            ? null
            : {
                minutes: calculateDirectMinutes(
                  departureTimestamp,
                  routeResult.arrivalTimestamp,
                  destinationCoordinate,
                  destination,
                ),
                usedRealtime: routeResult.usedRealtime,
              },
        );
      };

      const pendingCells: Array<{
        participant: RoutingParticipant;
        destinationId: string;
        result: Promise<{ minutes: number; usedRealtime: boolean } | null>;
      }> = [];
      for (let participantIndex = 0; participantIndex < request.participants.length; participantIndex += 1) {
        const participant = request.participants[participantIndex];
        const origin = originStations[participantIndex];
        for (let destinationIndex = 0; destinationIndex < request.destinations.length; destinationIndex += 1) {
          const destination = destinationStations[destinationIndex];
          const result = origin && destination
            ? routeCacheWithDestination(
                origin,
                destination,
                request.destinations[destinationIndex].coordinate,
              )
            : Promise.resolve(UNREACHABLE);
          pendingCells.push({
            participant,
            destinationId: request.destinations[destinationIndex].id,
            result,
          });
        }
      }
      const resolvedCells = await Promise.all(
        pendingCells.map(async (pending) => ({
          ...pending,
          result: await pending.result,
        })),
      );
      const liveData = resolvedCells.some(
        (cell) => cell.result?.usedRealtime === true,
      );
      const timing: RoutingMatrixTimingMetadata = {
        dataKind: liveData ? "live" : "scheduled",
        liveData,
      };
      const travelTimes: RoutingMatrixCell[] = resolvedCells.map((cell) => ({
        participantId: cell.participant.participantId,
        destinationId: cell.destinationId,
        mode: cell.participant.mode,
        status: cell.result === null ? "unreachable" : "ok",
        minutes: cell.result?.minutes ?? null,
        source: this.descriptor.name,
      }));

      return {
        contractVersion: "meeet-routing-gateway/v1",
        departureAt: request.departureAt,
        travelTimes,
        timing,
      };
    } catch (error) {
      matrixController.abort();
      throw error;
    } finally {
      clearTimeout(deadline);
      matrixController.signal.removeEventListener("abort", abortOperation);
      request.signal?.removeEventListener("abort", abortOperation);
    }
  }

  async discoverRouteAlternatives(
    request: RouteAlternativeDiscoveryRequest,
  ): Promise<RouteAlternativeDiscoveryResult> {
    if (request.signal?.aborted) throw new Error("MVG route request was already aborted.");
    validateRouteAlternativeRequest(request);
    const operationController = new AbortController();
    const abortOperation = () => operationController.abort();
    request.signal?.addEventListener("abort", abortOperation, { once: true });
    if (request.signal?.aborted) operationController.abort();
    const deadline = setTimeout(
      () => operationController.abort(),
      this.matrixDeadlineMs,
    );
    try {
      const [originStation, destinationStation] = await Promise.all([
        this.findNearestStationForAlternatives(
          request.origin,
          operationController.signal,
        ),
        this.findNearestStationForAlternatives(
          request.destination,
          operationController.signal,
        ),
      ]);
      const originReference = originStation
        ? toRouteStationReference(originStation)
        : null;
      const destinationReference = destinationStation
        ? toRouteStationReference(destinationStation)
        : null;
      if (!originStation || !destinationStation || !originReference || !destinationReference) {
        return {
          originStation: originReference,
          destinationStation: destinationReference,
          alternatives: [],
        };
      }

      const stationReadyAt = new Date(
        Date.parse(request.departureAt) + originStation.walkingMinutes * 60_000,
      ).toISOString();
      const alternatives = await MVG_DIRECT_LIMITER.run(
        () => this.fetchRouteAlternatives(
          originReference,
          destinationReference,
          stationReadyAt,
          operationController.signal,
        ),
        operationController.signal,
      );
      return {
        originStation: originReference,
        destinationStation: destinationReference,
        alternatives,
      };
    } finally {
      clearTimeout(deadline);
      request.signal?.removeEventListener("abort", abortOperation);
    }
  }

  private async findNearestStationForAlternatives(
    coordinate: { latitude: number; longitude: number },
    signal: AbortSignal,
  ): Promise<SnappedStation | null> {
    return this.fetchImplementation === globalThis.fetch
      ? this.findCachedNearestStation(coordinate, signal)
      : MVG_DIRECT_LIMITER.run(
          () => this.findNearestStation(coordinate, signal),
          signal,
        );
  }

  private async fetchRouteAlternatives(
    origin: RouteStationReference,
    destination: RouteStationReference,
    stationReadyAt: string,
    signal: AbortSignal,
  ): Promise<readonly RouteAlternative[]> {
    const url = new URL(MVG_DIRECT_ROUTES_URL);
    url.searchParams.set("originStationGlobalId", origin.id);
    url.searchParams.set("destinationStationGlobalId", destination.id);
    url.searchParams.set("routingDateTime", stationReadyAt);
    url.searchParams.set("routingDateTimeIsArrival", "false");
    url.searchParams.set("transportTypes", MVG_DIRECT_TRANSPORT_TYPES);
    url.searchParams.set("changeSpeed", "NORMAL");
    url.searchParams.set("routeType", "LEAST_TIME");
    const payload = await this.getJson(url.toString(), signal, {
      cache: "no-store",
    });
    return parseMvgRouteAlternatives(payload, origin, destination, stationReadyAt);
  }

  private async findCachedNearestStation(
    coordinate: { latitude: number; longitude: number },
    signal: AbortSignal,
  ): Promise<SnappedStation | null> {
    const latitude = nearbyCacheCoordinate(coordinate.latitude);
    const longitude = nearbyCacheCoordinate(coordinate.longitude);
    const fill = runMvgDirectCacheFill(
      () => getCachedMvgStations(
        latitude,
        longitude,
        this.timeoutMs,
        this.maxResponseBytes,
      ),
      signal,
    );
    return fill.then((stations) => findNearestStation(coordinate, stations));
  }

  private async findNearestStation(
    coordinate: { latitude: number; longitude: number },
    signal: AbortSignal,
  ): Promise<SnappedStation | null> {
    const url = new URL(MVG_DIRECT_NEARBY_URL);
    const latitude = nearbyCacheCoordinate(coordinate.latitude);
    const longitude = nearbyCacheCoordinate(coordinate.longitude);
    url.searchParams.set("latitude", latitude);
    url.searchParams.set("longitude", longitude);
    const stations = parseStations(await this.getJson(
      url.toString(),
      signal,
      { cache: "no-store" },
    ));
    return findNearestStation(coordinate, stations);
  }

  private async findEarliestEffectiveArrival(
    originStationId: string,
    destinationStationId: string,
    stationReadyAt: string,
    signal: AbortSignal,
  ): Promise<MvgRouteResult | null> {
    const url = new URL(MVG_DIRECT_ROUTES_URL);
    url.searchParams.set("originStationGlobalId", originStationId);
    url.searchParams.set("destinationStationGlobalId", destinationStationId);
    url.searchParams.set("routingDateTime", stationReadyAt);
    url.searchParams.set("routingDateTimeIsArrival", "false");
    url.searchParams.set("transportTypes", MVG_DIRECT_TRANSPORT_TYPES);
    url.searchParams.set("changeSpeed", "NORMAL");
    url.searchParams.set("routeType", "LEAST_TIME");
    const payload = await this.getJson(url.toString(), signal, {
      cache: "no-store",
    });
    const routes = parseRoutes(payload, originStationId, destinationStationId);
    const transitRoutes = routes.filter((route) => route.hasTransit);
    if (transitRoutes.length === 0) return UNREACHABLE;
    const stationReadyTimestamp = Date.parse(stationReadyAt);
    let earliestRoute: MvgRoute | undefined;
    for (const route of transitRoutes) {
      if (route.finalEffectiveArrival < stationReadyTimestamp) {
        throw new Error("MVG route response contains an arrival before station readiness.");
      }
      if (
        !earliestRoute ||
        route.finalEffectiveArrival < earliestRoute.finalEffectiveArrival
      ) {
        earliestRoute = route;
      }
    }
    if (!earliestRoute || !Number.isFinite(earliestRoute.finalEffectiveArrival)) {
      throw new Error("MVG route response contains no destination timestamp.");
    }
    return {
      arrivalTimestamp: earliestRoute.finalEffectiveArrival,
      usedRealtime: earliestRoute.usedRealtime,
    };
  }

  private async getJson(
    url: string,
    signal: AbortSignal,
    fetchOptions?: HttpJsonFetchOptions,
  ): Promise<unknown> {
    // The URL is assembled only from the fixed endpoint constants and encoded
    // URLSearchParams above. Keep this assertion as a second fixed-origin gate.
    const parsed = new URL(url);
    const expectedBase = new URL(MVG_DIRECT_API_BASE_URL);
    if (
      parsed.origin !== expectedBase.origin ||
      !parsed.pathname.startsWith(`${expectedBase.pathname}/`)
    ) {
      throw new Error("MVG direct request escaped the fixed API origin.");
    }
    const client = createHttpJsonClient(
      url,
      {
        // Direct mode honors the configured per-call timeout; the fixed
        // default is only used when a provider is constructed without config.
        timeoutMs: this.timeoutMs,
        maxResponseBytes: this.maxResponseBytes,
      },
      null,
      this.fetchImplementation,
    );
    return client.getJson(url, signal, fetchOptions);
  }
}

async function getCachedMvgStations(
  latitude: string,
  longitude: string,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<Station[]> {
  "use cache";
  cacheLife({ revalidate: MVG_UPSTREAM_REVALIDATE_SECONDS });
  const url = new URL(MVG_DIRECT_NEARBY_URL);
  url.searchParams.set("latitude", latitude);
  url.searchParams.set("longitude", longitude);
  const client = createHttpJsonClient(
    url.toString(),
    {
      // Cache fills have their own timeout and deliberately do not inherit a
      // caller's abort signal, so another request can reuse an in-flight fill.
      timeoutMs,
      maxResponseBytes,
    },
    null,
  );
  const payload = await client.getJson(url.toString(), undefined, {
    cache: "no-store",
  });
  return parseStations(payload);
}

function findNearestStation(
  coordinate: { latitude: number; longitude: number },
  stations: Station[],
): SnappedStation | null {
  let nearest: SnappedStation | undefined;
  for (const station of stations) {
    const distanceMeters = haversineDistanceKm(coordinate, station) * 1_000;
    if (distanceMeters > MVG_DIRECT_MAX_RADIUS_METERS) continue;
    const candidate: SnappedStation = {
      ...station,
      walkingMinutes: roundMinutes(
        distanceMeters / MVG_DIRECT_WALKING_METERS_PER_MINUTE,
      ),
    };
    const nearestDistance = nearest
      ? haversineDistanceKm(coordinate, nearest) * 1_000
      : Number.POSITIVE_INFINITY;
    if (distanceMeters < nearestDistance) nearest = candidate;
  }
  return nearest ?? null;
}

/** Descriptive alias for callers that name the mode rather than its routing role. */
export const MvgDirectTransitProvider = MvgDirectRoutingProvider;

function defaultConfig(): ConfigLike {
  return {
    deployment: "unknown",
    maxResponseBytes: DEFAULT_PROVIDER_MAX_RESPONSE_BYTES,
  };
}

function validateRequest(request: RoutingMatrixRequest): void {
  if (
    request.participants.length > MVG_DIRECT_CAPABILITIES.maxParticipants ||
    request.destinations.length > MVG_DIRECT_CAPABILITIES.maxDestinations ||
    request.participants.length * request.destinations.length >
      MVG_DIRECT_CAPABILITIES.maxMatrixEntries
  ) {
    throw new RangeError(
      "MVG direct routing supports at most 4 participants, 19 destinations, and 76 matrix entries.",
    );
  }
  if (request.participants.some((participant) => participant.mode !== "transit")) {
    throw new RangeError("MVG direct routing supports transit mode only.");
  }
  if (!Number.isFinite(Date.parse(request.departureAt))) {
    throw new RangeError("MVG direct routing requires a valid departure instant.");
  }
  const participantIds = new Set<string>();
  for (const participant of request.participants) {
    if (participantIds.has(participant.participantId)) {
      throw new RangeError("MVG direct routing requires unique participant ids.");
    }
    participantIds.add(participant.participantId);
    validateCoordinate(participant.origin);
  }
  const destinationIds = new Set<string>();
  for (const destination of request.destinations) {
    if (destinationIds.has(destination.id)) {
      throw new RangeError("MVG direct routing requires unique destination ids.");
    }
    destinationIds.add(destination.id);
    validateCoordinate(destination.coordinate);
  }
}

function validateRouteAlternativeRequest(
  request: RouteAlternativeDiscoveryRequest,
): void {
  if (!Number.isFinite(Date.parse(request.departureAt))) {
    throw new RangeError("MVG route alternatives require a valid departure instant.");
  }
  validateCoordinate(request.origin);
  validateCoordinate(request.destination);
}

function toRouteStationReference(station: SnappedStation): RouteStationReference {
  return {
    id: station.id,
    coordinate: {
      latitude: station.latitude,
      longitude: station.longitude,
    },
  };
}

function validateCoordinate(coordinate: { latitude: number; longitude: number }): void {
  if (
    !Number.isFinite(coordinate.latitude) ||
    !Number.isFinite(coordinate.longitude) ||
    coordinate.latitude < -90 ||
    coordinate.latitude > 90 ||
    coordinate.longitude < -180 ||
    coordinate.longitude > 180
  ) {
    throw new RangeError("MVG direct routing requires finite WGS84 coordinates.");
  }
}

function coordinateKey(coordinate: { latitude: number; longitude: number }): string {
  return `${coordinate.latitude}:${coordinate.longitude}`;
}

function nearbyCacheCoordinate(value: number): string {
  const factor = 10 ** MVG_DIRECT_NEARBY_CACHE_DECIMAL_PLACES;
  return (Math.round(value * factor) / factor).toFixed(
    MVG_DIRECT_NEARBY_CACHE_DECIMAL_PLACES,
  );
}

function walkingMinutes(
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number },
): number {
  return roundMinutes(
    (haversineDistanceKm(first, second) * 1_000) /
      MVG_DIRECT_WALKING_METERS_PER_MINUTE,
  );
}

function roundMinutes(value: number): number {
  return Number(value.toFixed(1));
}

function calculateDirectMinutes(
  departureTimestamp: number,
  arrivalTimestamp: number,
  destinationCoordinate: { latitude: number; longitude: number },
  destinationStation: SnappedStation,
): number {
  const minutes =
    (arrivalTimestamp - departureTimestamp) / 60_000 +
    walkingMinutes(destinationCoordinate, destinationStation);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) {
    throw new Error("MVG route response contains an invalid itinerary duration.");
  }
  return roundMinutes(minutes);
}

function parseStations(value: unknown): Station[] {
  const entries = findArrayPayload(value, [
    "stations",
    "nearbyStations",
    "results",
    "items",
    "data",
  ], "nearby station");
  if (entries.length > MVG_DIRECT_MAX_STATION_RESULTS) {
    throw new Error("MVG nearby response exceeds the station result limit.");
  }
  return entries.map(parseStation);
}

function parseStation(value: unknown): Station {
  if (!isRecord(value)) throw new Error("MVG nearby response contains an invalid station.");
  const id = firstString(value, [
    "globalId",
    "globalID",
    "stationGlobalId",
    "stationGlobalID",
    "id",
  ]);
  const coordinate = parseCoordinateValue(value);
  if (!id || !coordinate) {
    throw new Error("MVG nearby response contains an invalid station.");
  }
  return { id, ...coordinate };
}

function findArrayPayload(
  value: unknown,
  keys: readonly string[],
  kind: string,
): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) throw new Error(`MVG ${kind} response has an invalid shape.`);
  for (const key of keys) {
    if (key in value) {
      if (Array.isArray(value[key])) {
        return value[key] as unknown[];
      }
      if (key === "data" && isRecord(value[key])) {
        return findArrayPayload(value[key], keys.filter((candidate) => candidate !== "data"), kind);
      }
      if (!Array.isArray(value[key])) {
        throw new Error(`MVG ${kind} response has an invalid ${key} array.`);
      }
    }
  }
  throw new Error(`MVG ${kind} response has an invalid shape.`);
}

function parseCoordinateValue(
  value: Record<string, unknown>,
): { latitude: number; longitude: number } | null {
  const latitude = firstNumber(value, ["latitude", "lat"]);
  const longitude = firstNumber(value, ["longitude", "lon", "lng"]);
  if (latitude !== null && longitude !== null) {
    return isWgs84(latitude, longitude) ? { latitude, longitude } : null;
  }
  for (const key of ["location", "coordinate", "coordinates"] as const) {
    const nested = value[key];
    if (isRecord(nested)) {
      const parsed = parseCoordinateValue(nested);
      if (parsed) return parsed;
    } else if (
      Array.isArray(nested) &&
      nested.length === 2 &&
      typeof nested[0] === "number" &&
      typeof nested[1] === "number" &&
      isWgs84(nested[1], nested[0])
    ) {
      return { latitude: nested[1], longitude: nested[0] };
    }
  }
  return null;
}

function parseRoutes(
  value: unknown,
  originStationId: string,
  destinationStationId: string,
): MvgRoute[] {
  if (!Array.isArray(value)) {
    throw new Error("MVG routes response must be a JSON array.");
  }
  if (value.length > MVG_DIRECT_MAX_ROUTE_RESULTS) {
    throw new Error("MVG routes response exceeds the route result limit.");
  }
  const routes = value
    .map((route) => parseRoute(route, originStationId, destinationStationId))
    .filter((route): route is MvgRoute => route !== null);
  if (value.length > 0 && routes.length === 0) {
    throw new Error("MVG routes response contains no route matching the requested stations.");
  }
  return routes;
}

const MVG_DIRECT_WALKING_TYPES = new Set([
  "FOOT",
  "FUSS",
  "WALK",
  "PEDESTRIAN",
  "TRANSFER",
]);

type MvgTemporalInvalidReason =
  | "disallowed-inter-part-overlap"
  | "part-arrival-before-departure"
  | "itinerary-arrival-before-departure"
  | "itinerary-duration-exceeded"
  | "arrives-after-arrivalAt";

type MvgCoordinateJourneyParseOutcome =
  | { category: "valid"; journey: CoordinateJourney }
  | {
      category: "temporally-infeasible";
      journey: CoordinateJourney;
      reason: MvgTemporalInvalidReason;
    };

/** Parse the coordinate-to-coordinate response used by the canonical search. */
export function parseMvgCoordinateJourneys(
  value: unknown,
  request: CoordinateJourneyRequest,
): readonly CoordinateJourney[] {
  if (!Array.isArray(value) || value.length > MVG_DIRECT_MAX_ROUTE_RESULTS) {
    throw new Error("MVG coordinate journey response must be a bounded array.");
  }
  const arrivalLimit = Date.parse(request.arrivalAt);
  if (!Number.isFinite(arrivalLimit)) {
    throw new Error("MVG coordinate journey request has an invalid arrivalAt.");
  }
  const parsedJourneys = value.map((entry) => parseMvgCoordinateJourney(entry, request, arrivalLimit));
  if (request.viaStationGlobalId && parsedJourneys.some((outcome) => !outcome.journey.parts.some((part) => part.kind === "transit" && (
    part.from.stationGlobalId === request.viaStationGlobalId ||
    part.to.stationGlobalId === request.viaStationGlobalId ||
    part.intermediateStops.some((stop) => stop.stationGlobalId === request.viaStationGlobalId)
  )))) {
    throw new Error("MVG via journey does not traverse the requested anchor station.");
  }
  const validJourneys = parsedJourneys
    .filter((outcome): outcome is Extract<MvgCoordinateJourneyParseOutcome, { category: "valid" }> => outcome.category === "valid")
    .map((outcome) => outcome.journey);
  if (value.length > 0 && validJourneys.length === 0) {
    throw new Error("MVG coordinate journey response contains no temporally feasible journey.");
  }
  return validJourneys;
}

function parseMvgCoordinateJourney(
  value: unknown,
  request: CoordinateJourneyRequest,
  arrivalLimit: number,
): MvgCoordinateJourneyParseOutcome {
  if (!isRecord(value) || !Array.isArray(value.parts) || value.parts.length === 0 || value.parts.length > MVG_DIRECT_MAX_ROUTE_PARTS) {
    throw new Error("MVG coordinate journey must contain a bounded parts array.");
  }
  const parts: CoordinateJourneyPart[] = [];
  let previousArrival: number | null = null;
  let temporalInvalidReason: MvgTemporalInvalidReason | null = null;
  const markTemporalInvalid = (reason: MvgTemporalInvalidReason): void => {
    temporalInvalidReason ??= reason;
  };
  for (const [index, rawPart] of value.parts.entries()) {
    if (!isRecord(rawPart) || !isRecord(rawPart.from) || !isRecord(rawPart.to)) {
      throw new Error("MVG coordinate journey parts must contain from and to endpoints.");
    }
    const line = parseCoordinateJourneyLine(rawPart.line);
    const from = parseCoordinateJourneyEndpoint(rawPart.from, line.kind === "walking");
    const to = parseCoordinateJourneyEndpoint(rawPart.to, line.kind === "walking");
    if (index > 0 && previousArrival === null) throw new Error("MVG coordinate journey has no previous arrival.");
    const intermediateStops = "intermediateStops" in rawPart
      ? (() => {
          if (!Array.isArray(rawPart.intermediateStops)) throw new Error("MVG coordinate journey part intermediateStops must be an array.");
          return rawPart.intermediateStops.map(parseTransitStop);
        })()
      : [];
    const plannedDeparture = readPartTimestamp(rawPart.from, rawPart, ["plannedDeparture", "plannedDepartureAt", "departureAt"]) ?? previousArrival;
    const plannedArrival = readPartTimestamp(rawPart.to, rawPart, ["plannedArrival", "plannedArrivalAt", "arrivalAt", "plannedDeparture"]);
    if (plannedDeparture === null || plannedDeparture === undefined || plannedArrival === null || plannedArrival === undefined) {
      throw new Error("MVG coordinate journey part is missing planned timestamps.");
    }
    let departure = parseProviderTimestamp(plannedDeparture, "departure");
    const arrival = parseProviderTimestamp(plannedArrival, "arrival");
    if (index > 0) {
      const previous = parts[index - 1]!;
      const hasStationIdentities = previous.to.stationGlobalId !== null && from.stationGlobalId !== null;
      const sameStation = hasStationIdentities && previous.to.stationGlobalId === from.stationGlobalId;
      const sameCoordinate = coordinatesWithinMvgPrecision(previous.to.coordinate, from.coordinate);
      if (!sameStation && !sameCoordinate) {
        throw new Error("MVG coordinate journey parts are not continuous.");
      }
      if (previousArrival !== null && departure < previousArrival) {
        const overlap = previousArrival - departure;
        const walkingTransitHandoff = (previous.kind === "walking" && line.kind === "transit") ||
          (previous.kind === "transit" && line.kind === "walking");
        const validHandoff = walkingTransitHandoff && (sameStation || sameCoordinate) && overlap === MVG_DIRECT_MAX_WALKING_TRANSIT_HANDOFF_OVERLAP_MS;
        if (!validHandoff) {
          markTemporalInvalid("disallowed-inter-part-overlap");
        } else {
          departure = previousArrival;
        }
      }
    }
    if (arrival < departure) {
      markTemporalInvalid("part-arrival-before-departure");
    }
    if (line.kind === "transit" && (from.stationGlobalId === null || to.stationGlobalId === null)) {
      throw new Error("MVG transit parts must retain both station identities.");
    }
    parts.push({
      kind: line.kind,
      from,
      to,
      intermediateStops,
      line: line.line,
      plannedDepartureAt: new Date(departure).toISOString(),
      plannedArrivalAt: new Date(arrival).toISOString(),
    });
    previousArrival = arrival;
  }
  const plannedDepartureAt = parts[0].plannedDepartureAt;
  const plannedArrivalAt = parts.at(-1)!.plannedArrivalAt;
  const departure = Date.parse(plannedDepartureAt);
  const arrival = Date.parse(plannedArrivalAt);
  if (arrival < departure) {
    markTemporalInvalid("itinerary-arrival-before-departure");
  }
  if (arrival - departure > MVG_DIRECT_MAX_ITINERARY_DURATION_MS) {
    markTemporalInvalid("itinerary-duration-exceeded");
  }
  if (parts[0]!.kind === "walking" && parts[0]!.from.stationGlobalId === null) {
    parts[0]!.from.coordinate = request.origin;
  }
  if (parts.at(-1)!.kind === "walking" && parts.at(-1)!.to.stationGlobalId === null) {
    parts.at(-1)!.to.coordinate = request.destination;
  }
  if (!coordinatesWithinMvgPrecision(parts[0].from.coordinate, request.origin) || !coordinatesWithinMvgPrecision(parts.at(-1)!.to.coordinate, request.destination)) {
    throw new Error("MVG coordinate journey is not bound to its requested origin and destination.");
  }
  if (arrival > arrivalLimit) {
    markTemporalInvalid("arrives-after-arrivalAt");
  }
  const transitStops = parts
    .filter((part) => part.kind === "transit")
    .flatMap((part) => [part.from, ...part.intermediateStops, part.to]);
  const journey = {
    transitStops,
    parts,
    plannedDepartureAt,
    plannedArrivalAt,
    plannedDurationMilliseconds: arrival - departure,
  };
  return temporalInvalidReason === null
    ? { category: "valid", journey }
    : { category: "temporally-infeasible", journey, reason: temporalInvalidReason };
}

function parseTransitStop(value: unknown): JourneyEndpoint {
  if (!isRecord(value)) throw new Error("MVG intermediate stop is malformed.");
  const endpoint = parseCoordinateJourneyEndpoint(value, false);
  if (!endpoint.stationGlobalId) throw new Error("MVG intermediate stop lacks a station identity.");
  return endpoint;
}

function parseCoordinateJourneyEndpoint(value: Record<string, unknown>, allowBlankStationIdentity = false): JourneyEndpoint {
  const identityKeys = ["stationGlobalId", "stationGlobalID", "globalId", "globalID", "id"];
  const hasIdentity = identityKeys.some((key) => key in value);
  let stationGlobalId: string | null = null;
  if (hasIdentity) {
    stationGlobalId = firstString(value, identityKeys);
    if (!stationGlobalId) {
      const blankIdentity = identityKeys.some((key) => key in value) && identityKeys
        .filter((key) => key in value)
        .every((key) => typeof value[key] === "string" && value[key].trim().length === 0);
      if (!allowBlankStationIdentity || !blankIdentity) throw new Error("MVG coordinate endpoint has an invalid station identity.");
    }
  }
  const coordinate = parseCoordinateValue(value);
  if (!coordinate) throw new Error("MVG coordinate endpoint has no valid WGS84 coordinate.");
  const label = firstString(value, ["name", "label", "stationName", "stationLabel"]);
  const safeLabel = label && label.length <= MVG_DIRECT_MAX_LABEL_LENGTH ? label : null;
  return { stationGlobalId, coordinate, ...(safeLabel ? { label: safeLabel } : {}) };
}

function parseCoordinateJourneyLine(
  value: unknown,
): { kind: "transit" | "walking"; line: TransitLineReference | null } {
  if (value === undefined || value === null) return { kind: "walking", line: null };
  if (!isRecord(value)) throw new Error("MVG coordinate journey line is malformed.");
  const type = firstString(value, ["transportType", "type", "mode"]);
  if (!type) throw new Error("MVG coordinate journey line has no transport type.");
  const normalizedType = type.toUpperCase();
  if (MVG_DIRECT_TRANSIT_TYPES.has(normalizedType)) {
    const identity = firstString(value, ["globalId", "globalID", "lineId", "lineID", "id", "name", "label", "shortName", "designation"]) ?? normalizedType;
    return { kind: "transit", line: { identity, type: normalizedType } };
  }
  if (MVG_DIRECT_WALKING_TYPES.has(normalizedType)) return { kind: "walking", line: null };
  throw new Error("MVG coordinate journey contains an unsupported part type.");
}

function readPartTimestamp(
  endpoint: Record<string, unknown>,
  part: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    if (typeof endpoint[key] === "string") return endpoint[key] as string;
    if (typeof part[key] === "string") return part[key] as string;
  }
  return null;
}

function parseProviderTimestamp(value: string | number, label: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`MVG coordinate journey ${label} timestamp is invalid.`);
    return value;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`MVG coordinate journey ${label} timestamp is malformed.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`MVG coordinate journey ${label} timestamp is invalid.`);
  return timestamp;
}

function validateCoordinateJourneyRequest(request: CoordinateJourneyRequest): void {
  if (!isWgs84(request.origin.latitude, request.origin.longitude) || !isWgs84(request.destination.latitude, request.destination.longitude)) {
    throw new RangeError("MVG coordinate routing requires finite WGS84 coordinates.");
  }
  if (!Number.isFinite(Date.parse(request.arrivalAt))) throw new RangeError("MVG coordinate routing requires a valid arrival instant.");
  if (request.viaStationGlobalId !== undefined && (!request.viaStationGlobalId.trim() || request.viaDwellTimeInMinutes !== 10)) {
    throw new RangeError("MVG anchor routing requires a station id and ten-minute dwell time.");
  }
}

function coordinatesWithinMvgPrecision(
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number },
): boolean {
  return haversineDistanceKm(first, second) * 1_000 <= MVG_DIRECT_COORDINATE_BINDING_TOLERANCE_METRES;
}

/** Parse the finite, uncached route-alternative response used by Phase 2. */
export function parseMvgRouteAlternatives(
  value: unknown,
  origin: RouteStationReference,
  destination: RouteStationReference,
  stationReadyAt: string,
): readonly RouteAlternative[] {
  if (!Array.isArray(value)) {
    throw new Error("MVG route alternatives response must be a JSON array.");
  }
  if (value.length > MVG_DIRECT_MAX_ROUTE_ALTERNATIVES) {
    throw new Error("MVG route alternatives response exceeds the alternative limit.");
  }
  const stationReadyTimestamp = parseBoundedRouteTimestamp(
    stationReadyAt,
    stationReadyAt,
    "station readiness",
  );
  const parsed = value
    .map((route) => parseRouteAlternative(
      route,
      origin,
      destination,
      stationReadyAt,
      stationReadyTimestamp,
    ))
    .filter((route): route is RouteAlternative => route !== null);
  return deduplicateRouteAlternatives(parsed);
}

function parseRouteAlternative(
  value: unknown,
  origin: RouteStationReference,
  destination: RouteStationReference,
  stationReadyAt: string,
  stationReadyTimestamp: number,
): RouteAlternative | null {
  if (!isRecord(value) || !Array.isArray(value.parts)) {
    throw new Error("MVG route alternative must contain a parts array.");
  }
  if (value.parts.length === 0 || value.parts.length > MVG_DIRECT_MAX_ROUTE_PARTS) {
    throw new Error("MVG route alternative contains an invalid parts array.");
  }
  const providerItineraryId = optionalRouteString(value, [
    "id",
    "routeId",
    "itineraryId",
  ], "route itinerary identity");
  const parts: RoutePart[] = [];
  let previousToStationId: string | null = null;
  let previousPlannedArrivalAt = stationReadyAt;
  let previousEffectiveArrivalTimestamp = stationReadyTimestamp;
  let hasTransit = false;
  let usedRealtime = false;

  for (const [index, rawPart] of value.parts.entries()) {
    if (!isRecord(rawPart) || !isRecord(rawPart.from) || !isRecord(rawPart.to)) {
      throw new Error("MVG route alternative parts must contain from and to stations.");
    }
    const from = parseAlternativeStation(rawPart.from);
    const to = parseAlternativeStation(rawPart.to);
    if (previousToStationId !== null && from.id !== previousToStationId) {
      throw new Error("MVG route alternative parts are not continuous.");
    }
    const line = parseAlternativeLine(rawPart.line);
    hasTransit ||= MVG_DIRECT_TRANSIT_TYPES.has(line.type);

    const explicitDepartureAt = optionalRouteTimestamp(
      rawPart.from,
      "plannedDeparture",
      stationReadyAt,
      stationReadyAt,
    );
    const plannedDepartureAt = explicitDepartureAt ?? previousPlannedArrivalAt;
    const plannedArrivalAt = requiredRouteTimestamp(
      rawPart.to,
      "plannedDeparture",
      stationReadyAt,
      `part ${index} arrival`,
    );
    const departureTimestamp = parseBoundedRouteTimestamp(
      plannedDepartureAt,
      stationReadyAt,
      `part ${index} departure`,
    );
    const arrivalTimestamp = parseBoundedRouteTimestamp(
      plannedArrivalAt,
      stationReadyAt,
      `part ${index} arrival`,
    );
    if (arrivalTimestamp < departureTimestamp) {
      throw new Error("MVG route alternative contains reversed planned timestamps.");
    }
    if (departureTimestamp < previousEffectiveArrivalTimestamp) {
      throw new Error("MVG route alternative contains overlapping parts.");
    }

    const isRealtime = rawPart.realTime === true;
    if (rawPart.realTime !== undefined && typeof rawPart.realTime !== "boolean") {
      throw new Error("MVG route alternative contains an invalid realtime flag.");
    }
    const delay = isRealtime
      ? parseBoundedArrivalDelay(
          isRecord(rawPart.to) ? rawPart.to.arrivalDelayInMinutes : undefined,
        )
      : null;
    const isFinalPart = index === value.parts.length - 1;
    const effectiveArrivalTimestamp = isFinalPart && delay !== null
      ? arrivalTimestamp + delay * 60_000
      : arrivalTimestamp;
    if (effectiveArrivalTimestamp < stationReadyTimestamp ||
      effectiveArrivalTimestamp > stationReadyTimestamp + MVG_DIRECT_MAX_ITINERARY_DURATION_MS) {
      throw new Error("MVG route alternative contains an unbounded effective timestamp.");
    }
    if (effectiveArrivalTimestamp < departureTimestamp) {
      throw new Error("MVG route alternative contains an invalid effective arrival timestamp.");
    }
    const effectiveArrivalAt = new Date(effectiveArrivalTimestamp).toISOString();
    const part: RoutePart = {
      from,
      to,
      plannedDepartureAt,
      plannedArrivalAt,
      effectiveDepartureAt: plannedDepartureAt,
      effectiveArrivalAt,
      line,
    };
    parts.push(part);
    previousToStationId = to.id;
    previousPlannedArrivalAt = plannedArrivalAt;
    previousEffectiveArrivalTimestamp = effectiveArrivalTimestamp;
    if (isFinalPart && delay !== null) usedRealtime = true;
  }

  if (parts[0].from.id !== origin.id || parts[parts.length - 1].to.id !== destination.id) {
    return null;
  }
  if (!hasTransit) return null;

  const plannedDepartureAt = parts[0].plannedDepartureAt;
  const plannedArrivalAt = parts[parts.length - 1].plannedArrivalAt;
  const effectiveDepartureAt = parts[0].effectiveDepartureAt;
  const effectiveArrivalAt = parts[parts.length - 1].effectiveArrivalAt;
  const effectiveDepartureTimestamp = Date.parse(effectiveDepartureAt);
  const effectiveArrivalTimestamp = Date.parse(effectiveArrivalAt);
  if (
    effectiveArrivalTimestamp < effectiveDepartureTimestamp ||
    effectiveArrivalTimestamp > stationReadyTimestamp + MVG_DIRECT_MAX_ITINERARY_DURATION_MS
  ) {
    throw new Error("MVG route alternative contains an invalid itinerary duration.");
  }
  return withRouteAlternativeIdentities({
    providerItineraryId,
    origin,
    destination,
    parts,
    plannedDepartureAt,
    plannedArrivalAt,
    effectiveDepartureAt,
    effectiveArrivalAt,
    usedRealtime,
  });
}

function deduplicateRouteAlternatives(
  alternatives: readonly RouteAlternative[],
): readonly RouteAlternative[] {
  const byTimedIdentity = new Map<string, RouteAlternative>();
  const byProviderItineraryId = new Map<string, string>();
  for (const alternative of alternatives) {
    const timedIdentity = `${alternative.itineraryIdentity}\u0000${routeTimingFingerprint(alternative)}`;
    if (alternative.providerItineraryId !== null) {
      const existingProviderIdentity = byProviderItineraryId.get(alternative.providerItineraryId);
      if (existingProviderIdentity && existingProviderIdentity !== timedIdentity) {
        throw new Error("MVG route alternatives contain conflicting itinerary timing.");
      }
      byProviderItineraryId.set(alternative.providerItineraryId, timedIdentity);
    }
    if (byTimedIdentity.has(timedIdentity)) {
      continue;
    }
    byTimedIdentity.set(timedIdentity, alternative);
  }
  return [...byTimedIdentity.values()];
}

function parseAlternativeStation(value: Record<string, unknown>): RouteStationReference {
  const id = firstString(value, [
    "stationGlobalId",
    "stationGlobalID",
    "globalId",
    "globalID",
    "id",
  ]);
  if (!id || id.length > 200) {
    throw new Error("MVG route alternative contains an invalid station identity.");
  }
  return { id, coordinate: parseOptionalRouteCoordinate(value) };
}

function parseAlternativeLine(value: unknown): RoutePart["line"] {
  if (!isRecord(value)) {
    throw new Error("MVG route alternative part must contain a transit line.");
  }
  const type = firstString(value, ["transportType"]);
  if (!type) throw new Error("MVG route alternative line lacks a transport type.");
  const identity = optionalRouteString(value, [
    "globalId",
    "globalID",
    "lineId",
    "lineID",
    "id",
    "name",
    "label",
    "shortName",
    "designation",
  ], "transit line identity") ?? type.toUpperCase();
  return { identity, type: type.toUpperCase() };
}

function optionalRouteString(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): string | null {
  for (const key of keys) {
    if (!(key in value)) continue;
    if (typeof value[key] !== "string" || value[key].trim().length === 0) {
      throw new Error(`MVG route alternative contains an invalid ${label}.`);
    }
    const result = value[key].trim();
    if (result.length > 200) throw new Error(`MVG route alternative ${label} is too long.`);
    return result;
  }
  return null;
}

function optionalRouteTimestamp(
  value: Record<string, unknown>,
  key: string,
  stationReadyAt: string,
  label: string,
): string | null {
  if (!(key in value)) return null;
  if (typeof value[key] !== "string") {
    throw new Error(`MVG route alternative contains an invalid ${label}.`);
  }
  parseBoundedRouteTimestamp(value[key], stationReadyAt, label);
  return value[key];
}

function requiredRouteTimestamp(
  value: Record<string, unknown>,
  key: string,
  stationReadyAt: string,
  label: string,
): string {
  const timestamp = optionalRouteTimestamp(value, key, stationReadyAt, label);
  if (!timestamp) throw new Error(`MVG route alternative is missing a ${label} timestamp.`);
  return timestamp;
}

function parseBoundedRouteTimestamp(
  value: unknown,
  stationReadyAt: string,
  label: string,
): number {
  if (typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`MVG route alternative contains an invalid ${label} timestamp.`);
  }
  const timestamp = Date.parse(value);
  const ready = Date.parse(stationReadyAt);
  if (!Number.isFinite(timestamp) || !Number.isFinite(ready) ||
    timestamp < ready || timestamp > ready + MVG_DIRECT_MAX_ITINERARY_DURATION_MS) {
    throw new Error(`MVG route alternative contains an unbounded ${label} timestamp.`);
  }
  return timestamp;
}

function parseOptionalRouteCoordinate(
  value: Record<string, unknown>,
): { latitude: number; longitude: number } | null {
  const directKeys = ["latitude", "lat", "longitude", "lon", "lng"];
  const hasDirectCoordinate = directKeys.some((key) => key in value);
  if (hasDirectCoordinate) {
    const coordinate = parseCoordinateValue(value);
    if (!coordinate) throw new Error("MVG route alternative contains an invalid endpoint coordinate.");
    return coordinate;
  }
  const nestedKeys = ["location", "coordinate", "coordinates"];
  if (nestedKeys.some((key) => key in value)) {
    if (nestedKeys.some((key) => value[key] !== null && value[key] !== undefined)) {
      const coordinate = parseCoordinateValue(value);
      if (!coordinate) throw new Error("MVG route alternative contains an invalid endpoint coordinate.");
      return coordinate;
    }
  }
  return null;
}

function routeTimingFingerprint(alternative: RouteAlternative): string {
  return JSON.stringify({
    plannedDepartureAt: alternative.plannedDepartureAt,
    plannedArrivalAt: alternative.plannedArrivalAt,
    effectiveDepartureAt: alternative.effectiveDepartureAt,
    effectiveArrivalAt: alternative.effectiveArrivalAt,
    usedRealtime: alternative.usedRealtime,
  });
}

function parseRoute(
  value: unknown,
  originStationId: string,
  destinationStationId: string,
): MvgRoute | null {
  if (!isRecord(value) || !Array.isArray(value.parts)) {
    throw new Error("MVG route must contain a parts array.");
  }
  if (
    value.parts.length === 0 ||
    value.parts.length > MVG_DIRECT_MAX_ROUTE_PARTS
  ) {
    throw new Error("MVG route contains an invalid parts array.");
  }
  let hasTransit = false;
  let previousToStationId: string | null = null;
  for (const part of value.parts) {
    if (!isRecord(part) || !isRecord(part.from) || !isRecord(part.to)) {
      throw new Error("MVG route part must contain from and to stations.");
    }
    const fromStationId = parseStationReference(part.from);
    const toStationId = parseStationReference(part.to);
    if (fromStationId === null || toStationId === null) {
      throw new Error("MVG route part contains an invalid station identity.");
    }
    if (previousToStationId !== null && fromStationId !== previousToStationId) {
      throw new Error("MVG route parts contain a discontinuous station sequence.");
    }
    if (part.line !== undefined && part.line !== null) {
      if (!isRecord(part.line) || typeof part.line.transportType !== "string") {
        throw new Error("MVG route part contains an invalid line.");
      }
      if (
        MVG_DIRECT_TRANSIT_TYPES.has(part.line.transportType.trim().toUpperCase())
      ) {
        hasTransit = true;
      }
    }
    previousToStationId = toStationId;
  }
  const firstPart = value.parts[0];
  const lastPart = value.parts[value.parts.length - 1];
  if (!isRecord(firstPart) || !isRecord(lastPart)) {
    throw new Error("MVG route parts are malformed.");
  }
  const firstFrom = isRecord(firstPart.from)
    ? parseStationReference(firstPart.from)
    : null;
  const finalTo = isRecord(lastPart.to)
    ? parseStationReference(lastPart.to)
    : null;
  if (firstFrom !== originStationId || finalTo !== destinationStationId) {
    // The endpoint can return a valid alternative ending at a station in the
    // same interchange while also returning alternatives matching the request.
    // Ignore only this alternative; malformed route shapes still fail closed.
    return null;
  }
  if (!isRecord(lastPart.to) || typeof lastPart.to.plannedDeparture !== "string") {
    throw new Error("MVG route final destination lacks plannedDeparture.");
  }
  const plannedArrival = parsePlannedDeparture(lastPart.to.plannedDeparture);
  const arrivalDelay =
    lastPart.realTime === true
      ? parseBoundedArrivalDelay(lastPart.to.arrivalDelayInMinutes)
      : null;
  return {
    finalEffectiveArrival:
      plannedArrival + (arrivalDelay === null ? 0 : arrivalDelay * 60_000),
    hasTransit,
    usedRealtime: arrivalDelay !== null,
  };
}

function parseBoundedArrivalDelay(value: unknown): number | null {
  return typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= MVG_DIRECT_MAX_ARRIVAL_DELAY_MINUTES
    ? value
    : null;
}

function parseStationReference(value: Record<string, unknown>): string | null {
  return typeof value.stationGlobalId === "string" && value.stationGlobalId.trim()
    ? value.stationGlobalId.trim()
    : null;
}

function parsePlannedDeparture(value: string): number {
  if (!/T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error("MVG plannedDeparture must be an ISO timestamp with an offset.");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("MVG plannedDeparture is invalid.");
  }
  return timestamp;
}

function firstString(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return null;
}

function firstNumber(
  value: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) return value[key];
  }
  return null;
}

function isWgs84(latitude: number, longitude: number): boolean {
  return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

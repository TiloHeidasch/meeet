import "server-only";

import { haversineDistanceKm } from "../domain/geo.ts";
import type {
  ProviderDescriptor,
  ProviderProvenance,
  RoutingMatrixCell,
  RoutingMatrixRequest,
  RoutingMatrixResponse,
  RoutingMatrixTimingMetadata,
  RoutingProviderCapabilities,
  RoutingParticipant,
} from "../domain/types.ts";
import type { RoutingProvider } from "../domain/providers.ts";
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  DEFAULT_PROVIDER_MAX_RESPONSE_BYTES,
  type ProviderConfig,
} from "./config.ts";
import {
  createHttpJsonClient,
  type FetchImplementation,
  HttpProviderError,
} from "./http.ts";

export const MVG_DIRECT_API_ORIGIN = "https://www.mvg.de";
export const MVG_DIRECT_API_BASE_URL =
  `${MVG_DIRECT_API_ORIGIN}/api/bgw-pt/v3`;
export const MVG_DIRECT_NEARBY_URL =
  `${MVG_DIRECT_API_BASE_URL}/stations/nearby`;
export const MVG_DIRECT_ROUTES_URL = `${MVG_DIRECT_API_BASE_URL}/routes`;
export const MVG_DIRECT_SOURCE_URL = MVG_DIRECT_API_BASE_URL;
export const MVG_DIRECT_VERSION = "bgw-pt/v3";
export const MVG_DIRECT_TIMEOUT_MS = DEFAULT_PROVIDER_TIMEOUT_MS;
export const MVG_DIRECT_MATRIX_DEADLINE_MS = 12_000;
export const MVG_DIRECT_MAX_RESPONSE_BYTES = 128 * 1024;
export const MVG_DIRECT_MAX_STATION_RESULTS = 100;
export const MVG_DIRECT_MAX_ROUTE_RESULTS = 100;
export const MVG_DIRECT_MAX_ROUTE_PARTS = 100;
export const MVG_DIRECT_MAX_RADIUS_METERS = 1_500;
export const MVG_DIRECT_WALKING_METERS_PER_MINUTE = 75;
export const MVG_DIRECT_MAX_CONCURRENCY = 4;
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
export class MvgDirectRoutingProvider implements RoutingProvider {
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
        "MVG BGW PT v3 routing; realtime is used when supplied on the final route part, invalid realtime fields ignored, and planned timestamps used as the fallback; unofficial endpoint, no SLA.",
      version: MVG_DIRECT_VERSION,
      retrievedAt: new Date().toISOString(),
      notes:
        "Unofficial MVG BGW PT v3 endpoint with no SLA; realtime is used when supplied on the final route part, invalid realtime fields ignored, and planned timestamps used as the fallback. Coordinates are snapped to the nearest returned station within 1500 m using 75 m/min walking access and egress. Transit-only and capped at a complete 2x2 grid (19 destinations; 76 matrix entries).",
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

  async getTravelTimeMatrix(
    request: RoutingMatrixRequest,
  ): Promise<RoutingMatrixResponse> {
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
        const promise = MVG_DIRECT_LIMITER.run(
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

  private async findNearestStation(
    coordinate: { latitude: number; longitude: number },
    signal: AbortSignal,
  ): Promise<SnappedStation | null> {
    const url = new URL(MVG_DIRECT_NEARBY_URL);
    url.searchParams.set("latitude", String(coordinate.latitude));
    url.searchParams.set("longitude", String(coordinate.longitude));
    const payload = await this.getJson(url.toString(), signal);
    const stations = parseStations(payload);
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
    const payload = await this.getJson(url.toString(), signal);
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

  private async getJson(url: string, signal: AbortSignal): Promise<unknown> {
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
    return client.getJson(url, signal);
  }
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
  return value.map((route) =>
    parseRoute(route, originStationId, destinationStationId),
  );
}

function parseRoute(
  value: unknown,
  originStationId: string,
  destinationStationId: string,
): MvgRoute {
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
    throw new Error("MVG route origin or destination identity does not match the request.");
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

class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maximum: number) {}

  run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(new HttpProviderError("aborted", "Provider request was aborted."));
    }
    return new Promise<T>((resolve, reject) => {
      let queued = true;
      let settled = false;
      const start = () => {
        if (settled) return;
        queued = false;
        signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          settled = true;
          reject(new HttpProviderError("aborted", "Provider request was aborted."));
          return;
        }
        this.active += 1;
        Promise.resolve()
          .then(operation)
          .then(resolve, reject)
          .finally(() => {
            settled = true;
            this.active -= 1;
            this.startNext();
          });
      };
      const abort = () => {
        if (!queued || settled) return;
        queued = false;
        settled = true;
        const index = this.queue.indexOf(start);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new HttpProviderError("aborted", "Provider request was aborted."));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (this.active < this.maximum) start();
      else this.queue.push(start);
    });
  }

  private startNext(): void {
    while (this.active < this.maximum) {
      const next = this.queue.shift();
      if (!next) return;
      next();
    }
  }
}

const MVG_DIRECT_LIMITER = new ConcurrencyLimiter(MVG_DIRECT_MAX_CONCURRENCY);

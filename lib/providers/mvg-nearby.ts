import "server-only";

import { haversineDistanceKm } from "../domain/geo.ts";
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  type ProviderConfig,
} from "./config.ts";
import { createHttpJsonClient, type FetchImplementation } from "./http.ts";
import {
  MVG_NEARBY_CACHE_DECIMAL_PLACES,
  MVG_NEARBY_URL,
  MVG_UPSTREAM_REVALIDATE_SECONDS,
} from "./mvg-constants.ts";
import { runMvgCacheFill } from "./mvg-limiter.ts";

export const MVG_NEARBY_TIMEOUT_MS = DEFAULT_PROVIDER_TIMEOUT_MS;
export const MVG_NEARBY_MAX_RESPONSE_BYTES = 512 * 1024;
export const MVG_NEARBY_MAX_STATION_RESULTS = 100;
export const MVG_NEARBY_MAX_RADIUS_METERS = 1_500;
export const MVG_NEARBY_WALKING_METERS_PER_MINUTE = 75;

interface NearbyCacheEntry {
  readonly expiresAt: number;
  readonly stations: readonly MvgNearbyStation[];
}

const nearbyCache = new Map<string, NearbyCacheEntry>();

/** Drop all cached MVG nearby lookups (used by tests for deterministic fetches). */
export function clearMvgNearbyCache(): void {
  nearbyCache.clear();
}

export interface MvgNearbyStation {
  id: string;
  latitude: number;
  longitude: number;
}

export async function fetchMvgNearbyStations(
  coordinate: { latitude: number; longitude: number },
  fetchImplementation: FetchImplementation = fetch,
  signal?: AbortSignal,
  config: Pick<ProviderConfig, "timeoutMs" | "maxResponseBytes"> = {
    timeoutMs: MVG_NEARBY_TIMEOUT_MS,
    maxResponseBytes: MVG_NEARBY_MAX_RESPONSE_BYTES,
  },
): Promise<readonly MvgNearbyStation[]> {
  const url = new URL(MVG_NEARBY_URL);
  url.searchParams.set("latitude", nearbyCacheCoordinate(coordinate.latitude));
  url.searchParams.set("longitude", nearbyCacheCoordinate(coordinate.longitude));
  const cacheKey = url.toString();
  const cached = nearbyCache.get(cacheKey);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    // The returned station array reference is shared and read-only; callers
    // must not mutate it (use a copy if mutation is required).
    return cached.stations;
  }
  const client = createHttpJsonClient(cacheKey, config, null, fetchImplementation);
  const stations = parseStations(await runMvgCacheFill(() => client.getJson(cacheKey, signal, { cache: "no-store" }), signal));
  const ttlMs = MVG_UPSTREAM_REVALIDATE_SECONDS * 1000;
  nearbyCache.set(cacheKey, { expiresAt: Date.now() + ttlMs, stations });
  return stations;
}

export function findNearestMvgStation(
  coordinate: { latitude: number; longitude: number },
  stations: readonly MvgNearbyStation[],
): (MvgNearbyStation & { walkingMinutes: number }) | null {
  let nearest: (MvgNearbyStation & { walkingMinutes: number }) | undefined;
  for (const station of stations) {
    const distanceMeters = haversineDistanceKm(coordinate, station) * 1_000;
    if (distanceMeters > MVG_NEARBY_MAX_RADIUS_METERS) continue;
    const candidate = {
      ...station,
      walkingMinutes: Number((distanceMeters / MVG_NEARBY_WALKING_METERS_PER_MINUTE).toFixed(1)),
    };
    const nearestDistance = nearest
      ? haversineDistanceKm(coordinate, nearest) * 1_000
      : Number.POSITIVE_INFINITY;
    if (distanceMeters < nearestDistance) nearest = candidate;
  }
  return nearest ?? null;
}

export function validateMvgCoordinate(coordinate: { latitude: number; longitude: number }): void {
  if (
    !Number.isFinite(coordinate.latitude) ||
    !Number.isFinite(coordinate.longitude) ||
    coordinate.latitude < -90 ||
    coordinate.latitude > 90 ||
    coordinate.longitude < -180 ||
    coordinate.longitude > 180
  ) {
    throw new RangeError("MVG nearby access requires finite WGS84 coordinates.");
  }
}

function nearbyCacheCoordinate(value: number): string {
  const factor = 10 ** MVG_NEARBY_CACHE_DECIMAL_PLACES;
  return (Math.round(value * factor) / factor).toFixed(MVG_NEARBY_CACHE_DECIMAL_PLACES);
}

function parseStations(value: unknown): MvgNearbyStation[] {
  const entries = findArrayPayload(value, ["stations", "nearbyStations", "results", "items", "data"], "nearby station");
  if (entries.length > MVG_NEARBY_MAX_STATION_RESULTS) {
    throw new Error("MVG nearby response exceeds the station result limit.");
  }
  return entries.map(parseStation);
}

function parseStation(value: unknown): MvgNearbyStation {
  if (!isRecord(value)) throw new Error("MVG nearby response contains an invalid station.");
  const id = firstString(value, ["globalId", "globalID", "stationGlobalId", "stationGlobalID", "id"]);
  const coordinate = parseCoordinateValue(value);
  if (!id || !coordinate) throw new Error("MVG nearby response contains an invalid station.");
  return { id, ...coordinate };
}

function findArrayPayload(value: unknown, keys: readonly string[], kind: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) throw new Error(`MVG ${kind} response has an invalid shape.`);
  for (const key of keys) {
    if (!(key in value)) continue;
    if (Array.isArray(value[key])) return value[key] as unknown[];
    if (key === "data" && isRecord(value[key])) {
      return findArrayPayload(value[key], keys.filter((candidate) => candidate !== "data"), kind);
    }
    throw new Error(`MVG ${kind} response has an invalid ${key} array.`);
  }
  throw new Error(`MVG ${kind} response has an invalid shape.`);
}

function parseCoordinateValue(value: Record<string, unknown>): { latitude: number; longitude: number } | null {
  const latitude = firstNumber(value, ["latitude", "lat"]);
  const longitude = firstNumber(value, ["longitude", "lon", "lng"]);
  if (latitude !== null && longitude !== null && isWgs84(latitude, longitude)) {
    return { latitude, longitude };
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

function isWgs84(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import "server-only";

import { cacheLife } from "next/cache";
import { isWithinOfficialMunichBoundary } from "../domain/boundary.ts";
import {
  createHttpJsonClient,
  type FetchImplementation,
} from "./http.ts";
import { runMvgCacheFill } from "./mvg-limiter.ts";
import {
  MVG_LOCATIONS_URL,
  MVG_UPSTREAM_REVALIDATE_SECONDS,
} from "./mvg-constants.ts";
import {
  DEFAULT_PROVIDER_MAX_RESPONSE_BYTES,
  DEFAULT_PROVIDER_TIMEOUT_MS,
} from "./config.ts";

export interface LocationSearchResult {
  label: string;
  latitude: number;
  longitude: number;
}

export const MVG_LOCATION_SEARCH_MAX_QUERY_LENGTH = 80;
export const MVG_LOCATION_SEARCH_MAX_RESULTS = 20;
export const MVG_LOCATION_SEARCH_TIMEOUT_MS = DEFAULT_PROVIDER_TIMEOUT_MS;
export const MVG_LOCATION_SEARCH_MAX_RESPONSE_BYTES = DEFAULT_PROVIDER_MAX_RESPONSE_BYTES;

export function runMvgLocationCacheFill<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return runMvgCacheFill(operation, signal);
}

export async function searchMvgLocations(
  query: string,
  fetchImplementation: FetchImplementation = fetch,
  signal?: AbortSignal,
): Promise<LocationSearchResult[]> {
  const normalizedQuery = validateLocationSearchQuery(query);
  if (fetchImplementation === globalThis.fetch) {
    return runMvgLocationCacheFill(
      () => getCachedMvgLocations(
        normalizedQuery,
        MVG_LOCATION_SEARCH_TIMEOUT_MS,
        MVG_LOCATION_SEARCH_MAX_RESPONSE_BYTES,
      ),
      signal,
    );
  }
  return searchMvgLocationsWithFetch(
    normalizedQuery,
    fetchImplementation,
    signal,
  );
}

async function getCachedMvgLocations(
  query: string,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<LocationSearchResult[]> {
  "use cache";
  cacheLife({ revalidate: MVG_UPSTREAM_REVALIDATE_SECONDS });
  return searchMvgLocationsWithFetch(
    query,
    undefined,
    undefined,
    timeoutMs,
    maxResponseBytes,
  );
}

async function searchMvgLocationsWithFetch(
  query: string,
  fetchImplementation: FetchImplementation = fetch,
  signal?: AbortSignal,
  timeoutMs = MVG_LOCATION_SEARCH_TIMEOUT_MS,
  maxResponseBytes = MVG_LOCATION_SEARCH_MAX_RESPONSE_BYTES,
): Promise<LocationSearchResult[]> {
  const url = new URL(MVG_LOCATIONS_URL);
  url.searchParams.set("query", query);
  const client = createHttpJsonClient(
    url.toString(),
    {
      timeoutMs,
      maxResponseBytes,
    },
    null,
    fetchImplementation,
  );
  const payload = await client.getJson(url.toString(), signal, {
    cache: "no-store",
  });
  return parseMvgLocationSearchResults(payload);
}

export function validateLocationSearchQuery(query: string): string {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (
    normalized.length === 0 ||
    normalized.length > MVG_LOCATION_SEARCH_MAX_QUERY_LENGTH
  ) {
    throw new RangeError("Location search query is invalid.");
  }
  return normalized;
}

export function parseMvgLocationSearchResults(
  value: unknown,
): LocationSearchResult[] {
  const entries = findLocationArray(value);
  const results: LocationSearchResult[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const result = parseLocationResult(entry);
    if (!result) continue;
    const key = `${normalizeLabel(result.label)}\u0000${result.latitude.toFixed(6)}\u0000${result.longitude.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(result);
    if (results.length >= MVG_LOCATION_SEARCH_MAX_RESULTS) break;
  }
  return results;
}

function findLocationArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) {
    throw new Error("MVG location search response has an invalid shape.");
  }
  for (const key of ["locations", "results", "items", "data"] as const) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested;
    if (key === "data" && isRecord(nested)) {
      return findLocationArray(nested);
    }
    if (key in value) {
      throw new Error(`MVG location search response has an invalid ${key} array.`);
    }
  }
  throw new Error("MVG location search response has an invalid shape.");
}

function parseLocationResult(value: unknown): LocationSearchResult | null {
  if (!isRecord(value)) return null;
  const label = firstString(value, [
    "label",
    "name",
    "displayName",
    "title",
  ]);
  const coordinate = parseCoordinateValue(value);
  if (!label || !coordinate || !isWithinOfficialMunichBoundary(coordinate)) {
    return null;
  }
  return { label, ...coordinate };
}

function parseCoordinateValue(
  value: Record<string, unknown>,
): { latitude: number; longitude: number } | null {
  const latitude = firstFiniteNumber(value, ["latitude", "lat"]);
  const longitude = firstFiniteNumber(value, ["longitude", "lon", "lng"]);
  if (latitude !== null && longitude !== null) {
    return isWgs84(latitude, longitude) ? { latitude, longitude } : null;
  }

  for (const key of ["location", "coordinate", "coordinates", "position"] as const) {
    const nested = value[key];
    if (isRecord(nested)) {
      const parsed = parseCoordinateValue(nested);
      if (parsed) return parsed;
    } else if (
      Array.isArray(nested) &&
      nested.length === 2
    ) {
      const longitudeValue = finiteNumber(nested[0]);
      const latitudeValue = finiteNumber(nested[1]);
      if (
        longitudeValue !== null &&
        latitudeValue !== null &&
        isWgs84(latitudeValue, longitudeValue)
      ) {
        return { latitude: latitudeValue, longitude: longitudeValue };
      }
    }
  }
  return null;
}

function firstString(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    if (typeof value[key] === "string") {
      const result = value[key].trim();
      if (result.length > 0 && result.length <= 120) return result;
    }
  }
  return null;
}

function firstFiniteNumber(
  value: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const result = finiteNumber(value[key]);
    if (result !== null) return result;
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }
  return null;
}

function isWgs84(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

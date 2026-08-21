import type {
  ScheduledStationArea,
} from "./models.ts";

/**
 * Geographic bucket index over station-area centroids. Built once per routing
 * window (or once at compile time for the precomputed neighbor lists) and
 * queried per arrival to find areas within a radius without an all-pairs scan.
 */
export interface ScheduledSpatialIndex {
  readonly bucketSizeDegrees: number;
  readonly buckets: ReadonlyMap<string, readonly string[]>;
  readonly areas: ReadonlyMap<string, ScheduledStationArea>;
}

export function haversineDistanceMeters(
  first: { readonly latitude: number; readonly longitude: number },
  second: { readonly latitude: number; readonly longitude: number },
): number {
  const radiusMeters = 6_371_000;
  const latitudeDelta = ((second.latitude - first.latitude) * Math.PI) / 180;
  const longitudeDelta = ((second.longitude - first.longitude) * Math.PI) / 180;
  const firstLatitude = (first.latitude * Math.PI) / 180;
  const secondLatitude = (second.latitude * Math.PI) / 180;
  const haversine = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return radiusMeters * 2 * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

function buildSpatialIndex(areas: readonly ScheduledStationArea[], radiusMeters: number): ScheduledSpatialIndex {
  const bucketSizeDegrees = Math.max(radiusMeters / 111_000, 0.00001);
  const buckets = new Map<string, string[]>();
  const areaMap = new Map<string, ScheduledStationArea>();
  for (const area of areas) {
    areaMap.set(area.id, area);
    const key = bucketKey(area.coordinate, bucketSizeDegrees);
    const current = buckets.get(key) ?? [];
    current.push(area.id);
    buckets.set(key, current);
  }
  return { bucketSizeDegrees, buckets, areas: areaMap };
}

function querySpatialIndex(
  index: ScheduledSpatialIndex,
  coordinate: { readonly latitude: number; readonly longitude: number },
  radiusMeters: number,
): ScheduledStationArea[] {
  const latitudeRadius = radiusMeters / 111_000;
  const longitudeRadius = latitudeRadius / Math.max(Math.cos((coordinate.latitude * Math.PI) / 180), 0.1);
  const centerLatitudeBucket = Math.floor(coordinate.latitude / index.bucketSizeDegrees);
  const centerLongitudeBucket = Math.floor(coordinate.longitude / index.bucketSizeDegrees);
  const latitudeBuckets = Math.ceil(latitudeRadius / index.bucketSizeDegrees) + 1;
  const longitudeBuckets = Math.ceil(longitudeRadius / index.bucketSizeDegrees) + 1;
  const candidates: ScheduledStationArea[] = [];
  const seen = new Set<string>();
  for (let latitudeOffset = -latitudeBuckets; latitudeOffset <= latitudeBuckets; latitudeOffset += 1) {
    for (let longitudeOffset = -longitudeBuckets; longitudeOffset <= longitudeBuckets; longitudeOffset += 1) {
      const ids = index.buckets.get(`${centerLatitudeBucket + latitudeOffset}:${centerLongitudeBucket + longitudeOffset}`) ?? [];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const area = index.areas.get(id);
        if (area !== undefined && haversineDistanceMeters(coordinate, area.coordinate) <= radiusMeters) candidates.push(area);
      }
    }
  }
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}

function bucketKey(coordinate: { readonly latitude: number; readonly longitude: number }, bucketSizeDegrees: number): string {
  return `${Math.floor(coordinate.latitude / bucketSizeDegrees)}:${Math.floor(coordinate.longitude / bucketSizeDegrees)}`;
}

/**
 * Find every station area within `radiusMeters` of `coordinate`, returned sorted
 * by id. Shared by the runtime scan fallback and the compile-time precomputation
 * of transfer-neighbor lists so both enumerate transfers identically.
 */
export const findAreasWithinRadius = querySpatialIndex;
export const buildAreaSpatialIndex = buildSpatialIndex;

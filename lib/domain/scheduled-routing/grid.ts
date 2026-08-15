import { isPointInGeoJsonGeometry, toGeoJsonPosition } from "../geo.ts";
import type { BoundedMunichGrid, GeoJsonMultiPolygon, GeoJsonPosition, LocationCoordinate } from "../types.ts";
import { createBoundedMunichGrid } from "../grid.ts";

export const SCHEDULED_SURFACE_GRID_COLUMNS = 24;
export const SCHEDULED_SURFACE_GRID_ROWS = 16;
export const MAX_SCHEDULED_SURFACE_CELLS = SCHEDULED_SURFACE_GRID_COLUMNS * SCHEDULED_SURFACE_GRID_ROWS;
export const MAX_SCHEDULED_SURFACE_DESTINATIONS = 2_048;
export const SCHEDULED_SURFACE_GRID_PROFILE = {
  columns: SCHEDULED_SURFACE_GRID_COLUMNS,
  rows: SCHEDULED_SURFACE_GRID_ROWS,
} as const;

/** A bounded clipped fill grid independent of routing-provider matrix limits. */
export function createScheduledSurfaceGrid(): BoundedMunichGrid {
  const grid = createBoundedMunichGrid(SCHEDULED_SURFACE_GRID_PROFILE, { enforceMatrixLimits: false });
  if (grid.cells.length > MAX_SCHEDULED_SURFACE_CELLS || grid.destinations.length > MAX_SCHEDULED_SURFACE_DESTINATIONS) throw new RangeError("The scheduled surface grid exceeds its bounded resource cap.");
  return {
    ...grid,
    cells: grid.cells.map((cell) => ({
      ...cell,
      center: deriveInteriorRepresentativePoint(cell.geometry, cell.center),
    })),
  };
}

/**
 * Return a deterministic point in the open interior of a clipped cell. The
 * rectangular centre is preferred when it is genuinely interior; otherwise a
 * scanline through the polygon's vertex bands finds an interior interval.
 */
export function deriveInteriorRepresentativePoint(
  geometry: GeoJsonMultiPolygon,
  preferredPoint: LocationCoordinate,
): LocationCoordinate {
  if (isScheduledInteriorRepresentativePoint(preferredPoint, geometry)) return preferredPoint;

  for (const polygon of geometry.coordinates) {
    const candidate = representativePointFromPolygon(polygon);
    if (candidate !== null && isScheduledInteriorRepresentativePoint(candidate, geometry)) return candidate;
  }
  throw new RangeError("Unable to derive an interior representative point for a clipped Munich cell.");
}

/** Test the open interior, excluding every exterior and hole boundary. */
export function isScheduledInteriorRepresentativePoint(
  point: LocationCoordinate,
  geometry: GeoJsonMultiPolygon,
): boolean {
  const position = toGeoJsonPosition(point);
  return geometry.coordinates.some((polygon) => {
    const singlePolygon: GeoJsonMultiPolygon = { type: "MultiPolygon", coordinates: [polygon] };
    return isPointInGeoJsonGeometry(position, singlePolygon) && polygon.every((ring) => !isPointOnRing(position, ring));
  });
}

function representativePointFromPolygon(
  polygon: readonly GeoJsonPosition[][],
): LocationCoordinate | null {
  const levels = [...new Set(polygon.flatMap((ring) => ring.map((position) => position[1])))].sort((left, right) => left - right);
  for (let levelIndex = 0; levelIndex + 1 < levels.length; levelIndex += 1) {
    const lower = levels[levelIndex];
    const upper = levels[levelIndex + 1];
    if (lower === undefined || upper === undefined || upper <= lower) continue;
    const latitude = lower + (upper - lower) / 2;
    const outerIntervals = ringIntervals(polygon[0] ?? [], latitude);
    const holeIntervals = polygon.slice(1).flatMap((ring) => ringIntervals(ring, latitude));
    for (const [left, right] of subtractIntervals(outerIntervals, holeIntervals)) {
      if (right <= left) continue;
      const candidate = { latitude, longitude: left + (right - left) / 2 };
      if (isPointInsidePolygon(candidate, polygon)) return candidate;
    }
  }
  return null;
}

function ringIntervals(ring: readonly GeoJsonPosition[], latitude: number): Array<readonly [number, number]> {
  const intersections: number[] = [];
  for (let index = 1; index < ring.length; index += 1) {
    const first = ring[index - 1];
    const second = ring[index];
    if (first === undefined || second === undefined || first[1] === second[1]) continue;
    const lower = Math.min(first[1], second[1]);
    const upper = Math.max(first[1], second[1]);
    if (latitude <= lower || latitude >= upper) continue;
    intersections.push(first[0] + ((latitude - first[1]) * (second[0] - first[0])) / (second[1] - first[1]));
  }
  intersections.sort((left, right) => left - right);
  const intervals: Array<readonly [number, number]> = [];
  for (let index = 0; index + 1 < intersections.length; index += 2) {
    const left = intersections[index];
    const right = intersections[index + 1];
    if (left !== undefined && right !== undefined && right > left) intervals.push([left, right]);
  }
  return intervals;
}

function subtractIntervals(
  source: readonly (readonly [number, number])[],
  removals: readonly (readonly [number, number])[],
): Array<readonly [number, number]> {
  let remaining = [...source];
  for (const [removeLeft, removeRight] of removals) {
    const next: Array<readonly [number, number]> = [];
    for (const [left, right] of remaining) {
      if (removeRight <= left || removeLeft >= right) {
        next.push([left, right]);
        continue;
      }
      if (removeLeft > left) next.push([left, Math.min(removeLeft, right)]);
      if (removeRight < right) next.push([Math.max(removeRight, left), right]);
    }
    remaining = next;
  }
  return remaining;
}

function isPointInsidePolygon(point: LocationCoordinate, polygon: readonly GeoJsonPosition[][]): boolean {
  const geometry: GeoJsonMultiPolygon = { type: "MultiPolygon", coordinates: [polygon as GeoJsonPosition[][]] };
  return isScheduledInteriorRepresentativePoint(point, geometry);
}

function isPointOnRing(point: GeoJsonPosition, ring: readonly GeoJsonPosition[]): boolean {
  for (let index = 1; index < ring.length; index += 1) {
    const first = ring[index - 1];
    const second = ring[index];
    if (first === undefined || second === undefined) continue;
    const cross = (point[1] - first[1]) * (second[0] - first[0]) - (point[0] - first[0]) * (second[1] - first[1]);
    if (Math.abs(cross) > 1e-12) continue;
    if (point[0] >= Math.min(first[0], second[0]) && point[0] <= Math.max(first[0], second[0]) && point[1] >= Math.min(first[1], second[1]) && point[1] <= Math.max(first[1], second[1])) return true;
  }
  return false;
}

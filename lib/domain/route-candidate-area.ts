import * as polygonClippingModule from "polygon-clipping";
import { clipPolygonToOfficialMunichBoundary } from "./boundary.ts";
import type {
  GeoJsonMultiPolygon,
  GeoJsonPolygon,
  GeoJsonPosition,
  LocationCoordinate,
} from "./types.ts";

type PolygonClippingApi = {
  union: (...polygons: unknown[]) => unknown;
};

const polygonClipping = (
  polygonClippingModule as unknown as {
    default?: PolygonClippingApi;
  } & PolygonClippingApi
).default ?? (polygonClippingModule as unknown as PolygonClippingApi);

export const ROUTE_CANDIDATE_BUFFER_RADIUS_METERS = 350;
const ROUTE_CANDIDATE_BUFFER_SEGMENTS = 32;
const METERS_PER_LATITUDE_DEGREE = 111_320;

/**
 * Builds the intentionally limited POI search area for verified route
 * candidates. It is a union of small station-center buffers clipped to the
 * official application boundary, not a travel-time corridor.
 */
export function createRouteCandidateSearchArea(
  coordinates: readonly LocationCoordinate[],
): GeoJsonMultiPolygon {
  const buffers = coordinates.map(createCoordinateBuffer);
  const unionedBuffers = unionPolygons(buffers.map((buffer) => buffer.coordinates));
  const clipped = unionedBuffers.flatMap((polygon) =>
    clipPolygonToOfficialMunichBoundary({
      type: "Polygon",
      coordinates: polygon,
    }).coordinates,
  );
  return {
    type: "MultiPolygon",
    coordinates: unionPolygons(clipped),
  };
}

function createCoordinateBuffer(coordinate: LocationCoordinate): GeoJsonPolygon {
  const latitudeRadius = ROUTE_CANDIDATE_BUFFER_RADIUS_METERS / METERS_PER_LATITUDE_DEGREE;
  const longitudeRadius = latitudeRadius / Math.max(Math.cos((coordinate.latitude * Math.PI) / 180), 0.01);
  const ring: GeoJsonPosition[] = [];
  for (let index = 0; index <= ROUTE_CANDIDATE_BUFFER_SEGMENTS; index += 1) {
    const angle = (index / ROUTE_CANDIDATE_BUFFER_SEGMENTS) * Math.PI * 2;
    ring.push([
      coordinate.longitude + Math.cos(angle) * longitudeRadius,
      coordinate.latitude + Math.sin(angle) * latitudeRadius,
    ]);
  }
  return { type: "Polygon", coordinates: [ring] };
}

function unionPolygons(polygons: readonly GeoJsonPosition[][][]): GeoJsonPosition[][][] {
  if (polygons.length === 0) return [];
  if (polygons.length === 1) return [polygons[0]];
  return polygonClipping.union(...polygons) as GeoJsonPosition[][][];
}

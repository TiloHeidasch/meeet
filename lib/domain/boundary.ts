import * as polygonClippingModule from "polygon-clipping";
import boundaryAsset from "../../data/official/munich-districts.json";
import manifestAsset from "../../data/official/munich-boundary-manifest.json";
import { isPointInGeoJsonGeometry } from "./geo.ts";
import type {
  GeoJsonMultiPolygon,
  GeoJsonPolygon,
  GeoJsonPosition,
  LocationCoordinate,
} from "./types.ts";

type PolygonClippingApi = {
  intersection: (
    subject: number[][][],
    clip: number[][][],
  ) => number[][][][];
};

const polygonClipping = (
  polygonClippingModule as unknown as {
    default?: PolygonClippingApi;
  } & PolygonClippingApi
).default ?? (polygonClippingModule as unknown as PolygonClippingApi);

export interface OfficialBoundaryDistrictProperties {
  districtNumber: string;
  districtName: string;
}

export interface OfficialBoundaryDistrict {
  type: "Feature";
  properties: OfficialBoundaryDistrictProperties;
  geometry: GeoJsonMultiPolygon;
}

export interface OfficialBoundaryFeatureCollection {
  type: "FeatureCollection";
  features: OfficialBoundaryDistrict[];
}

export interface OfficialBoundaryManifest {
  schemaVersion: 1;
  boundaryType: "application-municipal-district-collection";
  legalBoundary: false;
  sourceUrl: string;
  metadataUrl: string;
  retrievedAt: string;
  sourceMetadataDate: string | null;
  metadataRetrievedAt: string;
  rawContentHash: string;
  normalizedContentHash: string;
  metadataContentHash: string;
  rawFeatureCount: number;
  districtCount: 25;
  license: {
    name: string;
    url: string;
  };
  attribution: string;
  note: string;
}

export const OFFICIAL_MUNICH_BOUNDARY =
  boundaryAsset as unknown as OfficialBoundaryFeatureCollection;
export const OFFICIAL_MUNICH_BOUNDARY_MANIFEST =
  manifestAsset as OfficialBoundaryManifest;

export const OFFICIAL_MUNICH_BOUNDARY_BOUNDS = getBoundaryBounds(
  OFFICIAL_MUNICH_BOUNDARY,
);

export function isWithinOfficialMunichBoundary(
  coordinate: LocationCoordinate,
): boolean {
  return OFFICIAL_MUNICH_BOUNDARY.features.some((district) =>
    isPointInGeoJsonGeometry(
      [coordinate.longitude, coordinate.latitude],
      district.geometry,
    ),
  );
}

/**
 * Clips a candidate grid polygon against each official district polygon.
 * The result is a MultiPolygon because a grid cell can touch multiple
 * districts. This is application geometry, not a legal or cadastral union.
 */
export function clipPolygonToOfficialMunichBoundary(
  polygon: GeoJsonPolygon,
): GeoJsonMultiPolygon {
  const clipped: GeoJsonPosition[][][] = [];
  for (const district of OFFICIAL_MUNICH_BOUNDARY.features) {
    for (const districtPolygon of district.geometry.coordinates) {
      const intersections = polygonClipping.intersection(
        polygon.coordinates,
        districtPolygon,
      ) as GeoJsonPosition[][][];
      clipped.push(...intersections);
    }
  }

  return { type: "MultiPolygon", coordinates: clipped };
}

function getBoundaryBounds(boundary: OfficialBoundaryFeatureCollection) {
  const positions = boundary.features.flatMap((district) =>
    district.geometry.coordinates.flatMap((polygon) => polygon[0]),
  );
  const longitudes = positions.map(([longitude]) => longitude);
  const latitudes = positions.map(([, latitude]) => latitude);
  return {
    minLatitude: Math.min(...latitudes),
    maxLatitude: Math.max(...latitudes),
    minLongitude: Math.min(...longitudes),
    maxLongitude: Math.max(...longitudes),
  } as const;
}

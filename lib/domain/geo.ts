import type {
  GeoJsonGeometry,
  GeoJsonPosition,
  LocationCoordinate,
} from "./types.ts";

const EARTH_RADIUS_KM = 6371;

export function toGeoJsonPosition(
  coordinate: LocationCoordinate,
): GeoJsonPosition {
  return [coordinate.longitude, coordinate.latitude];
}

export function fromGeoJsonPosition(position: GeoJsonPosition): LocationCoordinate {
  return { latitude: position[1], longitude: position[0] };
}

export function haversineDistanceKm(
  first: LocationCoordinate,
  second: LocationCoordinate,
): number {
  const latitudeDelta = degreesToRadians(second.latitude - first.latitude);
  const longitudeDelta = degreesToRadians(second.longitude - first.longitude);
  const firstLatitude = degreesToRadians(first.latitude);
  const secondLatitude = degreesToRadians(second.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(haversine));
}


export function isPointInGeoJsonGeometry(
  point: GeoJsonPosition,
  geometry: GeoJsonGeometry,
): boolean {
  if (geometry.type === "Polygon") {
    return isPointInPolygon(point, geometry.coordinates);
  }

  return geometry.coordinates.some((polygon) =>
    isPointInPolygon(point, polygon),
  );
}

function isPointInPolygon(
  point: GeoJsonPosition,
  rings: GeoJsonPosition[][],
): boolean {
  const [outerRing, ...holes] = rings;
  if (!outerRing || !isPointInRing(point, outerRing)) {
    return false;
  }

  return !holes.some((hole) => isPointInRing(point, hole));
}

function isPointInRing(point: GeoJsonPosition, ring: GeoJsonPosition[]): boolean {
  if (ring.length < 3) {
    return false;
  }

  let isInside = false;
  const [pointLongitude, pointLatitude] = point;

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [longitude, latitude] = ring[index];
    const [previousLongitude, previousLatitude] = ring[previous];

    if (
      isPointOnSegment(
        point,
        [previousLongitude, previousLatitude],
        [longitude, latitude],
      )
    ) {
      return true;
    }

    const crossesLatitude =
      latitude > pointLatitude !== previousLatitude > pointLatitude;
    if (crossesLatitude) {
      const intersectionLongitude =
        ((previousLongitude - longitude) * (pointLatitude - latitude)) /
          (previousLatitude - latitude) +
        longitude;
      if (pointLongitude < intersectionLongitude) {
        isInside = !isInside;
      }
    }
  }

  return isInside;
}

function isPointOnSegment(
  point: GeoJsonPosition,
  first: GeoJsonPosition,
  second: GeoJsonPosition,
): boolean {
  const crossProduct =
    (point[1] - first[1]) * (second[0] - first[0]) -
    (point[0] - first[0]) * (second[1] - first[1]);
  if (Math.abs(crossProduct) > 1e-9) {
    return false;
  }

  return (
    point[0] >= Math.min(first[0], second[0]) - 1e-9 &&
    point[0] <= Math.max(first[0], second[0]) + 1e-9 &&
    point[1] >= Math.min(first[1], second[1]) - 1e-9 &&
    point[1] <= Math.max(first[1], second[1]) + 1e-9
  );
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

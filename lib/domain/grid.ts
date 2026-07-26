import {
  clipPolygonToOfficialMunichBoundary,
  OFFICIAL_MUNICH_BOUNDARY_BOUNDS,
} from "./boundary.ts";
import { fromGeoJsonPosition, isPointInGeoJsonGeometry, toGeoJsonPosition } from "./geo.ts";
import type {
  BoundedMunichGrid,
  GridCell,
  LocationCoordinate,
  RoutingMatrixDestination,
} from "./types.ts";

/** Bounded deliberately to keep a four-person matrix below the provider cap. */
export const GRID_COLUMNS = 10;
export const GRID_ROWS = 8;
export const MAX_GRID_CELLS = GRID_COLUMNS * GRID_ROWS;
export const MAX_ROUTING_MATRIX_DESTINATIONS = 400;
export const MAX_ROUTING_MATRIX_ENTRIES = 1600;
export const MAX_CELL_SAMPLE_VERTICES = 4;

export function createBoundedMunichGrid(): BoundedMunichGrid {
  const latitudeStep =
    (OFFICIAL_MUNICH_BOUNDARY_BOUNDS.maxLatitude -
      OFFICIAL_MUNICH_BOUNDARY_BOUNDS.minLatitude) /
    GRID_ROWS;
  const longitudeStep =
    (OFFICIAL_MUNICH_BOUNDARY_BOUNDS.maxLongitude -
      OFFICIAL_MUNICH_BOUNDARY_BOUNDS.minLongitude) /
    GRID_COLUMNS;
  const destinations: RoutingMatrixDestination[] = [];
  const destinationKeys = new Map<string, string>();
  const cells: GridCell[] = [];

  const addDestination = (
    id: string,
    coordinate: LocationCoordinate,
    sampleKind: "center" | "vertex",
  ): string => {
    const key = `${coordinate.latitude.toFixed(7)}:${coordinate.longitude.toFixed(7)}`;
    const existingId = destinationKeys.get(key);
    if (existingId) {
      return existingId;
    }
    destinations.push({ id, coordinate, sampleKind });
    destinationKeys.set(key, id);
    return id;
  };

  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let column = 0; column < GRID_COLUMNS; column += 1) {
      const minLatitude =
        OFFICIAL_MUNICH_BOUNDARY_BOUNDS.minLatitude + row * latitudeStep;
      const maxLatitude = minLatitude + latitudeStep;
      const minLongitude =
        OFFICIAL_MUNICH_BOUNDARY_BOUNDS.minLongitude + column * longitudeStep;
      const maxLongitude = minLongitude + longitudeStep;
      const southwest = { latitude: minLatitude, longitude: minLongitude };
      const southeast = { latitude: minLatitude, longitude: maxLongitude };
      const northeast = { latitude: maxLatitude, longitude: maxLongitude };
      const northwest = { latitude: maxLatitude, longitude: minLongitude };
      const center = {
        latitude: (minLatitude + maxLatitude) / 2,
        longitude: (minLongitude + maxLongitude) / 2,
      };
      const geometry = clipPolygonToOfficialMunichBoundary({
        type: "Polygon",
        coordinates: [
          [
            toGeoJsonPosition(southwest),
            toGeoJsonPosition(southeast),
            toGeoJsonPosition(northeast),
            toGeoJsonPosition(northwest),
            toGeoJsonPosition(southwest),
          ],
        ],
      });
      if (geometry.coordinates.length === 0) continue;
      const cellId = `cell-${row}-${column}`;
      const clippedVertices = selectSampleVertices(geometry);
      const clippedCenter = findValidCenter(center, clippedVertices, geometry);
      const vertexIds = clippedVertices.map((vertex, index) =>
        addDestination(`${cellId}-vertex-${index}`, vertex, "vertex"),
      );
      const centerId = addDestination(`${cellId}-center`, clippedCenter, "center");

      cells.push({
        id: cellId,
        row,
        column,
        center: clippedCenter,
        vertices: clippedVertices,
        geometry,
        sampleDestinationIds: [centerId, ...vertexIds],
      });
    }
  }

  if (
    cells.length > MAX_GRID_CELLS ||
    destinations.length > MAX_ROUTING_MATRIX_DESTINATIONS
  ) {
    throw new RangeError("The bounded Munich grid exceeds the provider matrix cap.");
  }

  return {
    columns: GRID_COLUMNS,
    rows: GRID_ROWS,
    cells,
    destinations,
  };
}

function selectSampleVertices(
  geometry: ReturnType<typeof clipPolygonToOfficialMunichBoundary>,
): LocationCoordinate[] {
  const positions = geometry.coordinates.flatMap((polygon) => polygon[0]);
  const unique = positions.filter((position, index) => {
    const firstIndex = positions.findIndex(
      (candidate) => candidate[0] === position[0] && candidate[1] === position[1],
    );
    return firstIndex === index;
  });
  if (unique.length <= MAX_CELL_SAMPLE_VERTICES) {
    return unique.map(fromGeoJsonPosition);
  }
  return Array.from({ length: MAX_CELL_SAMPLE_VERTICES }, (_, index) =>
    fromGeoJsonPosition(
      unique[Math.floor((index * unique.length) / MAX_CELL_SAMPLE_VERTICES)],
    ),
  );
}

function findValidCenter(
  originalCenter: LocationCoordinate,
  vertices: readonly LocationCoordinate[],
  geometry: ReturnType<typeof clipPolygonToOfficialMunichBoundary>,
): LocationCoordinate {
  if (isPointInGeoJsonGeometry(toGeoJsonPosition(originalCenter), geometry)) {
    return originalCenter;
  }
  const fallback = vertices[0];
  if (fallback) return fallback;
  return originalCenter;
}

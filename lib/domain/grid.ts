import {
  clipPolygonToOfficialMunichBoundary,
  OFFICIAL_MUNICH_BOUNDARY_BOUNDS,
} from "./boundary.ts";
import { fromGeoJsonPosition, isPointInGeoJsonGeometry, toGeoJsonPosition } from "./geo.ts";
import type {
  BoundedMunichGrid,
  GridCell,
  RoutingProviderCapabilities,
  LocationCoordinate,
  RoutingMatrixDestination,
} from "./types.ts";

/** The normal grid is deliberately bounded to keep a four-person matrix small. */
export const GRID_COLUMNS = 10;
export const GRID_ROWS = 8;
export const DIRECT_MVG_GRID_COLUMNS = 2;
export const DIRECT_MVG_GRID_ROWS = 2;
export const DEFAULT_GRID_PROFILE = {
  columns: GRID_COLUMNS,
  rows: GRID_ROWS,
} as const;
export const DIRECT_MVG_GRID_PROFILE = {
  columns: DIRECT_MVG_GRID_COLUMNS,
  rows: DIRECT_MVG_GRID_ROWS,
} as const;
export type GridProfile = Readonly<{ columns: number; rows: number }>;
export const MAX_GRID_CELLS = GRID_COLUMNS * GRID_ROWS;
export const MAX_ROUTING_MATRIX_DESTINATIONS = 400;
export const MAX_ROUTING_MATRIX_ENTRIES = 1600;
export const MAX_CELL_SAMPLE_VERTICES = 4;

export function createBoundedMunichGrid(
  profile: GridProfile = DEFAULT_GRID_PROFILE,
  options: { readonly enforceMatrixLimits?: boolean } = {},
): BoundedMunichGrid {
  const enforceMatrixLimits = options.enforceMatrixLimits ?? true;
  if (
    !Number.isInteger(profile.columns) ||
    !Number.isInteger(profile.rows) ||
    profile.columns < 1 ||
    profile.rows < 1 ||
    profile.columns * profile.rows > MAX_GRID_CELLS && enforceMatrixLimits
  ) {
    throw new RangeError("The Munich grid profile is outside the bounded range.");
  }
  const latitudeStep =
    (OFFICIAL_MUNICH_BOUNDARY_BOUNDS.maxLatitude -
      OFFICIAL_MUNICH_BOUNDARY_BOUNDS.minLatitude) /
    profile.rows;
  const longitudeStep =
    (OFFICIAL_MUNICH_BOUNDARY_BOUNDS.maxLongitude -
      OFFICIAL_MUNICH_BOUNDARY_BOUNDS.minLongitude) /
    profile.columns;
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

  for (let row = 0; row < profile.rows; row += 1) {
    for (let column = 0; column < profile.columns; column += 1) {
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

  if (enforceMatrixLimits && (
    cells.length > MAX_GRID_CELLS ||
    destinations.length > MAX_ROUTING_MATRIX_DESTINATIONS
  )) {
    throw new RangeError("The bounded Munich grid exceeds the provider matrix cap.");
  }

  return {
    columns: profile.columns,
    rows: profile.rows,
    cells,
    destinations,
  };
}

/**
 * Selects a complete profile before any provider work starts. Profiles are
 * built in full; a provider cap never causes the default grid to be sliced.
 */
export function createGridForRoutingCapabilities(
  capabilities: RoutingProviderCapabilities,
): BoundedMunichGrid {
  const profiles = [DEFAULT_GRID_PROFILE, DIRECT_MVG_GRID_PROFILE];
  for (const profile of profiles) {
    const grid = createBoundedMunichGrid(profile);
    if (
      grid.destinations.length <= capabilities.maxDestinations &&
      capabilities.maxParticipants * grid.destinations.length <=
        capabilities.maxMatrixEntries
    ) {
      return grid;
    }
  }
  throw new RangeError("No complete Munich grid profile fits the routing provider cap.");
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

import * as polygonClippingModule from "polygon-clipping";
import { Delaunay } from "d3-delaunay";
import proj4 from "proj4";
import boundaryAsset from "../../data/official/munich-districts.json";
import type {
  MeetingStationArea,
  StationAreaClassification,
} from "./meeting-response.ts";
import type { GeoJsonMultiPolygon } from "../domain/types.ts";

type Pair = [number, number];
type Ring = Pair[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

/** A GeoJSON MultiPolygon in longitude/latitude coordinates. */
export type StationTerritoryBoundary = {
  readonly type: "MultiPolygon";
  readonly coordinates: readonly (readonly (readonly (readonly [number, number])[])[])[];
};

export type StationTerritory = {
  readonly stationAreaId: string;
  readonly classification: StationAreaClassification;
  readonly geometry: GeoJsonMultiPolygon;
};

type PolygonClippingApi = {
  intersection: (subject: MultiPolygon | Polygon, ...clips: (MultiPolygon | Polygon)[]) => MultiPolygon;
  union: (...geometries: (MultiPolygon | Polygon)[]) => MultiPolygon;
};

const polygonClipping = (
  polygonClippingModule as unknown as {
    default?: PolygonClippingApi;
  } & PolygonClippingApi
).default ?? (polygonClippingModule as unknown as PolygonClippingApi);

// EPSG:25832 is ETRS89 / UTM zone 32N. Keeping the GRS80 ellipsoid explicit
// avoids a datum alias changing the projected distance calculation.
const ETRS89_UTM_32N = "+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs";
const WGS84 = "EPSG:4326";
const ENVELOPE_MARGIN_METRES = 1_000;
// Only bbox candidate selection uses this epsilon. It absorbs sub-micrometre
// proj4 roundoff at a component/cell edge; polygon clipping still receives
// the original projected coordinates and therefore keeps exact boundaries.
const BOUNDARY_BBOX_EPSILON_METRES = 1e-6;

type ProjectedSite = {
  readonly x: number;
  readonly y: number;
};

type SiteCluster = ProjectedSite & {
  readonly memberIndexes: number[];
  classification: StationAreaClassification;
};

type ProjectedBoundary = {
  readonly components: readonly ProjectedBoundaryComponent[];
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

type ProjectedBoundaryComponent = {
  readonly polygon: Polygon;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

const officialBoundary = boundaryAsset as unknown as {
  readonly features: readonly {
    readonly geometry: StationTerritoryBoundary;
  }[];
};

let cachedOfficialProjectedBoundary: ProjectedBoundary | undefined;

/**
 * Build nearest-site territories on the complete official Munich surface.
 * Every station area participates in the Voronoi competition, including an
 * unclassified area; classification only controls the returned map metadata.
 */
export function buildStationTerritories(
  stationAreas: readonly MeetingStationArea[],
): readonly StationTerritory[] {
  if (stationAreas.length === 0) return [];
  cachedOfficialProjectedBoundary ??= projectBoundary({
    type: "MultiPolygon",
    coordinates: officialBoundary.features.flatMap((feature) =>
      feature.geometry.coordinates,
    ),
  });
  return buildStationTerritoriesOnProjectedBoundary(stationAreas, cachedOfficialProjectedBoundary);
}

/**
 * Test-fixture seam for the same projected Voronoi construction on an
 * arbitrary MultiPolygon boundary. Production callers should use
 * buildStationTerritories(), which always uses the official Munich surface.
 */
export function buildStationTerritoriesWithinBoundary(
  stationAreas: readonly MeetingStationArea[],
  boundary: StationTerritoryBoundary,
): readonly StationTerritory[] {
  if (stationAreas.length === 0) return [];

  return buildStationTerritoriesOnProjectedBoundary(stationAreas, projectBoundary(boundary));
}

function buildStationTerritoriesOnProjectedBoundary(
  stationAreas: readonly MeetingStationArea[],
  projectedBoundary: ProjectedBoundary,
): readonly StationTerritory[] {
  const { clusters, clusterIndexByMember } = clusterSites(stationAreas);
  const projectedCells = buildProjectedVoronoiCells(clusters, projectedBoundary);
  const clusterGeometries = projectedCells.map((cell) =>
    unprojectMultiPolygon(clipCellToProjectedBoundary(cell, projectedBoundary)),
  );

  return stationAreas.map((stationArea, memberIndex) => {
    const cluster = clusters[clusterIndexByMember[memberIndex]];
    const isRepresentative = cluster.memberIndexes[0] === memberIndex;
    return {
      stationAreaId: stationArea.stationAreaId,
      classification: cluster.classification,
      // A coincident cluster has one geometric territory. Empty records for
      // the non-representative members preserve the one-record-per-input API
      // without duplicating positive area. Conflicting ties are unclassified.
      geometry: isRepresentative
        ? clusterGeometries[clusterIndexByMember[memberIndex]]
        : emptyMultiPolygon(),
    } satisfies StationTerritory;
  });
}

function clusterSites(
  stationAreas: readonly MeetingStationArea[],
): { readonly clusters: SiteCluster[]; readonly clusterIndexByMember: number[] } {
  const clusters: SiteCluster[] = [];
  const clusterByCoordinate = new Map<string, number>();
  const clusterIndexByMember: number[] = [];

  stationAreas.forEach((stationArea, memberIndex) => {
    const [x, y] = projectCoordinate(
      stationArea.coordinate.longitude,
      stationArea.coordinate.latitude,
    );
    const key = `${x}\u0000${y}`;
    let clusterIndex = clusterByCoordinate.get(key);
    if (clusterIndex === undefined) {
      clusterIndex = clusters.length;
      clusterByCoordinate.set(key, clusterIndex);
      clusters.push({
        x,
        y,
        memberIndexes: [memberIndex],
        classification: stationArea.classification,
      });
    } else {
      clusters[clusterIndex].memberIndexes.push(memberIndex);
    }
    clusterIndexByMember.push(clusterIndex);
  });

  for (const cluster of clusters) {
    const firstClassification = stationAreas[cluster.memberIndexes[0]].classification;
    if (!cluster.memberIndexes.every((memberIndex) => stationAreas[memberIndex].classification === firstClassification)) {
      cluster.classification = "unclassified";
    }
  }

  return { clusters, clusterIndexByMember };
}

function buildProjectedVoronoiCells(
  clusters: readonly SiteCluster[],
  boundary: ProjectedBoundary,
): Polygon[] {
  if (clusters.length <= 2 || areCollinear(clusters)) {
    return buildCollinearVoronoiCells(clusters, boundary);
  }

  const points = new Float64Array(clusters.length * 2);
  clusters.forEach((cluster, index) => {
    points[index * 2] = cluster.x;
    points[index * 2 + 1] = cluster.y;
  });
  const voronoi = new Delaunay(points).voronoi(makeEnvelopeBounds(boundary));
  return clusters.map((_, index) => {
    const cell = voronoi.cellPolygon(index);
    return cell.length < 4 ? [] : [cell.map(([x, y]) => [x, y] as Pair)];
  });
}

function areCollinear(clusters: readonly SiteCluster[]): boolean {
  const first = clusters[0];
  const second = clusters[1];
  if (!first || !second) return true;
  const directionX = second.x - first.x;
  const directionY = second.y - first.y;
  return clusters.slice(2).every((cluster) =>
    directionX * (cluster.y - first.y) - directionY * (cluster.x - first.x) === 0,
  );
}

function buildCollinearVoronoiCells(
  clusters: readonly SiteCluster[],
  boundary: ProjectedBoundary,
): Polygon[] {
  const cells: Polygon[] = Array.from({ length: clusters.length }, () => []);
  if (clusters.length === 0) return cells;
  if (clusters.length === 1) {
    cells[0] = [makeEnvelope(boundary)];
    return cells;
  }

  const first = clusters[0];
  const second = clusters[1];
  const directionX = second.x - first.x;
  const directionY = second.y - first.y;
  const sortedIndexes = clusters.map((_, index) => index).sort((firstIndex, secondIndex) => {
    const firstCluster = clusters[firstIndex];
    const secondCluster = clusters[secondIndex];
    const firstDistance = (firstCluster.x - first.x) * directionX + (firstCluster.y - first.y) * directionY;
    const secondDistance = (secondCluster.x - first.x) * directionX + (secondCluster.y - first.y) * directionY;
    return firstDistance - secondDistance;
  });

  for (let order = 0; order < sortedIndexes.length; order += 1) {
    const clusterIndex = sortedIndexes[order];
    const cluster = clusters[clusterIndex];
    let cell: Polygon = [makeEnvelope(boundary)];
    const previous = sortedIndexes[order - 1];
    const next = sortedIndexes[order + 1];
    if (previous !== undefined) {
      cell = clipConvexPolygonToNearestHalfPlane(cell, cluster, clusters[previous]);
    }
    if (next !== undefined && cell.length > 0) {
      cell = clipConvexPolygonToNearestHalfPlane(cell, cluster, clusters[next]);
    }
    cells[clusterIndex] = cell;
  }
  return cells;
}

function projectBoundary(boundary: StationTerritoryBoundary): ProjectedBoundary {
  const components = boundary.coordinates.map((polygon) => {
    const projectedPolygon = polygon.map((ring) => ring.map(([longitude, latitude]) =>
      projectCoordinate(longitude, latitude),
    ));
    const positions = projectedPolygon.flat();
    const xValues = positions.map(([x]) => x);
    const yValues = positions.map(([, y]) => y);
    return {
      polygon: projectedPolygon,
      minX: Math.min(...xValues),
      minY: Math.min(...yValues),
      maxX: Math.max(...xValues),
      maxY: Math.max(...yValues),
    } satisfies ProjectedBoundaryComponent;
  });

  if (components.length === 0) {
    throw new RangeError("Station territory boundary must contain at least one polygon.");
  }

  const xValues = components.flatMap(({ minX, maxX }) => [minX, maxX]);
  const yValues = components.flatMap(({ minY, maxY }) => [minY, maxY]);

  return {
    components,
    minX: Math.min(...xValues),
    minY: Math.min(...yValues),
    maxX: Math.max(...xValues),
    maxY: Math.max(...yValues),
  };
}

function clipCellToProjectedBoundary(
  cell: Polygon,
  boundary: ProjectedBoundary,
): MultiPolygon {
  if (cell.length === 0) return [];

  const cellBounds = getPolygonBounds(cell);
  const fragments: MultiPolygon[] = [];
  for (const component of boundary.components) {
    if (!bboxesOverlap(cellBounds, component)) continue;
    const fragment = polygonClipping.intersection(cell, component.polygon);
    if (fragment.length > 0) fragments.push(fragment);
  }

  if (fragments.length === 0) return [];
  if (fragments.length === 1) return fragments[0];
  // District/source components can touch or overlap. Union only this cell's
  // fragments so their shared area cannot become a positive-area overlap.
  return polygonClipping.union(...fragments);
}

function getPolygonBounds(polygon: Polygon): ProjectedBoundaryComponent {
  const positions = polygon.flat();
  const xValues = positions.map(([x]) => x);
  const yValues = positions.map(([, y]) => y);
  return {
    polygon,
    minX: Math.min(...xValues),
    minY: Math.min(...yValues),
    maxX: Math.max(...xValues),
    maxY: Math.max(...yValues),
  };
}

function bboxesOverlap(
  first: ProjectedBoundaryComponent,
  second: ProjectedBoundaryComponent,
): boolean {
  return first.maxX + BOUNDARY_BBOX_EPSILON_METRES >= second.minX &&
    second.maxX + BOUNDARY_BBOX_EPSILON_METRES >= first.minX &&
    first.maxY + BOUNDARY_BBOX_EPSILON_METRES >= second.minY &&
    second.maxY + BOUNDARY_BBOX_EPSILON_METRES >= first.minY;
}

function projectCoordinate(longitude: number, latitude: number): Pair {
  const [x, y] = proj4(WGS84, ETRS89_UTM_32N, [longitude, latitude]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new RangeError("Station territory coordinates must project to finite UTM values.");
  }
  return [x, y];
}

function unprojectMultiPolygon(multiPolygon: MultiPolygon): GeoJsonMultiPolygon {
  return {
    type: "MultiPolygon",
    coordinates: multiPolygon.map((polygon) =>
      polygon.map((ring) =>
        ring.map(([x, y]) => {
          const [longitude, latitude] = proj4(ETRS89_UTM_32N, WGS84, [x, y]);
          return [longitude, latitude] as [number, number];
        }),
      ),
    ),
  };
}

function emptyMultiPolygon(): GeoJsonMultiPolygon {
  return { type: "MultiPolygon", coordinates: [] };
}

function makeEnvelopeBounds(boundary: ProjectedBoundary): [number, number, number, number] {
  const envelope = makeEnvelope(boundary);
  return [envelope[0][0], envelope[0][1], envelope[2][0], envelope[2][1]];
}

function makeEnvelope(boundary: ProjectedBoundary): Ring {
  const minX = boundary.minX - ENVELOPE_MARGIN_METRES;
  const minY = boundary.minY - ENVELOPE_MARGIN_METRES;
  const maxX = boundary.maxX + ENVELOPE_MARGIN_METRES;
  const maxY = boundary.maxY + ENVELOPE_MARGIN_METRES;
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}

/**
 * Sutherland-Hodgman clipping against the exact perpendicular bisector
 * half-plane. The same linear equation is used for every site pair, so
 * adjacent cells share the hard bisector rather than an epsilon-wide seam.
 */
function clipConvexPolygonToNearestHalfPlane(
  polygon: Polygon,
  site: ProjectedSite,
  otherSite: ProjectedSite,
): Polygon {
  const [firstRing] = polygon;
  if (!firstRing || firstRing.length < 4) return [];

  const a = otherSite.x - site.x;
  const b = otherSite.y - site.y;
  const midpointX = (site.x + otherSite.x) / 2;
  const midpointY = (site.y + otherSite.y) / 2;
  const value = ([x, y]: Pair) => a * (x - midpointX) + b * (y - midpointY);
  const output: Ring = [];

  for (let index = 0; index < firstRing.length - 1; index += 1) {
    const first = firstRing[index];
    const second = firstRing[index + 1];
    const firstValue = value(first);
    const secondValue = value(second);
    const firstInside = firstValue <= 0;
    const secondInside = secondValue <= 0;

    if (firstInside !== secondInside) {
      const ratio = firstValue / (firstValue - secondValue);
      output.push([
        first[0] + ratio * (second[0] - first[0]),
        first[1] + ratio * (second[1] - first[1]),
      ]);
    }
    if (secondInside) output.push(second);
  }

  if (output.length < 3) return [];
  const first = output[0];
  const last = output[output.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) output.push(first);
  return [output];
}

import assert from "node:assert/strict";
import test from "node:test";
import proj4 from "proj4";
import * as polygonClipping from "polygon-clipping";
import boundaryAsset from "../data/official/munich-districts.json";
import {
  buildStationTerritories,
  buildStationTerritoriesWithinBoundary,
  type StationTerritoryBoundary,
} from "../lib/client/station-territories.ts";
import type { MeetingStationArea } from "../lib/client/meeting-response.ts";

const square = (
  minLongitude: number,
  minLatitude: number,
  maxLongitude: number,
  maxLatitude: number,
) => [
  [minLongitude, minLatitude],
  [maxLongitude, minLatitude],
  [maxLongitude, maxLatitude],
  [minLongitude, maxLatitude],
  [minLongitude, minLatitude],
] as [number, number][];

const area = (
  stationAreaId: string,
  longitude: number,
  latitude: number,
  classification: MeetingStationArea["classification"],
): MeetingStationArea => ({
  stationAreaId,
  name: stationAreaId,
  coordinate: { longitude, latitude },
  redBoardingStopId: null,
  blueBoardingStopId: null,
  classification,
  redArrivalSeconds: null,
  blueArrivalSeconds: null,
  fasterParticipant: null,
  withinSelectedTolerance: false,
});

type Pair = readonly [number, number];

function ringArea(ring: readonly Pair[]): number {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    area += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return Math.abs(area) / 2;
}

function multiPolygonArea(geometry: StationTerritoryBoundary): number {
  return geometry.coordinates.reduce(
    (total, polygon) => total + ringArea(polygon[0]) - polygon.slice(1).reduce((holes, hole) => holes + ringArea(hole), 0),
    0,
  );
}

function pointInRing(point: Pair, ring: readonly Pair[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x, y] = ring[index];
    const [previousX, previousY] = ring[previous];
    const crossProduct = (point[1] - previousY) * (x - previousX) - (point[0] - previousX) * (y - previousY);
    const withinSegment = point[0] >= Math.min(previousX, x) - 1e-10 && point[0] <= Math.max(previousX, x) + 1e-10 && point[1] >= Math.min(previousY, y) - 1e-10 && point[1] <= Math.max(previousY, y) + 1e-10;
    if (Math.abs(crossProduct) < 1e-10 && withinSegment) return true;
    if ((y > point[1]) !== (previousY > point[1]) && point[0] < ((previousX - x) * (point[1] - y)) / (previousY - y) + x) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInGeometry(point: Pair, geometry: StationTerritoryBoundary): boolean {
  return geometry.coordinates.some(([outer, ...holes]) =>
    pointInRing(point, outer) && !holes.some((hole) => pointInRing(point, hole)),
  );
}

function projectedDistanceToBoundary(point: Pair, geometry: StationTerritoryBoundary): number {
  const crs = "+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs";
  const project = ([longitude, latitude]: Pair) => proj4("EPSG:4326", crs, [longitude, latitude]);
  const projectedPoint = project(point);
  let closest = Number.POSITIVE_INFINITY;
  for (const polygon of geometry.coordinates) {
    for (const ring of polygon) {
      for (let index = 0; index < ring.length - 1; index += 1) {
        const first = project(ring[index]);
        const second = project(ring[index + 1]);
        const deltaX = second[0] - first[0];
        const deltaY = second[1] - first[1];
        const denominator = deltaX ** 2 + deltaY ** 2;
        const ratio = denominator === 0
          ? 0
          : Math.max(0, Math.min(1, ((projectedPoint[0] - first[0]) * deltaX + (projectedPoint[1] - first[1]) * deltaY) / denominator));
        const distance = Math.hypot(projectedPoint[0] - first[0] - ratio * deltaX, projectedPoint[1] - first[1] - ratio * deltaY);
        closest = Math.min(closest, distance);
      }
    }
  }
  return closest;
}

test("clips a multi-polygon boundary while preserving its hole and disconnected component", () => {
  const boundary: StationTerritoryBoundary = {
    type: "MultiPolygon",
    coordinates: [
      [square(11.5, 48.1, 11.6, 48.2), square(11.53, 48.13, 11.57, 48.17)],
      [square(11.7, 48.1, 11.75, 48.15)],
    ],
  };
  const territories = buildStationTerritoriesWithinBoundary([
    area("west", 11.51, 48.15, "red"),
    area("east", 11.59, 48.15, "unclassified"),
  ], boundary);

  assert.equal(territories.length, 2);
  assert.ok(territories.every((territory) => territory.geometry.type === "MultiPolygon"));
  assert.ok(territories.every((territory) => territory.geometry.coordinates.length > 0));
  assert.ok(territories.some((territory) => territory.geometry.coordinates.length === 2));

  const combinedArea = territories.reduce((total, territory) => total + multiPolygonArea(territory.geometry), 0);
  const expectedArea = 0.1 * 0.1 - 0.04 * 0.04 + 0.05 * 0.05;
  assert.ok(Math.abs(combinedArea - expectedArea) < expectedArea * 1e-7);
  assert.equal(pointInGeometry([11.55, 48.15], territories[0].geometry), false);
  assert.ok(pointInGeometry([11.725, 48.125], territories[0].geometry) || pointInGeometry([11.725, 48.125], territories[1].geometry));
});

test("unions indexed candidate fragments across components without filling a hole", () => {
  const boundary: StationTerritoryBoundary = {
    type: "MultiPolygon",
    coordinates: [
      [square(11.4, 48.1, 11.6, 48.2), square(11.47, 48.13, 11.53, 48.17)],
      [square(11.6, 48.1, 11.7, 48.2)],
      [square(11.8, 48.1, 11.85, 48.15)],
    ],
  };
  const [territory] = buildStationTerritoriesWithinBoundary([
    area("component-spanning-site", 11.55, 48.15, "fair"),
  ], boundary);

  assert.equal(territory.geometry.coordinates.length, 2);
  assert.ok(territory.geometry.coordinates.some((polygon) => polygon.length > 1));
  assert.equal(pointInGeometry([11.5, 48.15], territory.geometry), false);
  assert.ok(pointInGeometry([11.65, 48.15], territory.geometry));
  assert.ok(pointInGeometry([11.825, 48.125], territory.geometry));
});

test("assigns ownership correctly for three or more projected sites", () => {
  const boundary: StationTerritoryBoundary = {
    type: "MultiPolygon",
    coordinates: [[square(11.4, 48.1, 11.8, 48.3)]],
  };
  const stationAreas = [
    area("west", 11.45, 48.15, "red"),
    area("east", 11.75, 48.15, "blue"),
    area("north", 11.6, 48.27, "fair"),
  ];
  const territories = buildStationTerritoriesWithinBoundary(stationAreas, boundary);

  assert.equal(territories.length, 3);
  for (let index = 0; index < stationAreas.length; index += 1) {
    const station = stationAreas[index];
    assert.equal(territories[index].stationAreaId, station.stationAreaId);
    assert.equal(territories[index].classification, station.classification);
    assert.ok(pointInGeometry([station.coordinate.longitude, station.coordinate.latitude], territories[index].geometry));
  }
  assert.ok(territories.every((territory) => multiPolygonArea(territory.geometry) > 0));
});

test("clusters coincident conflicting classifications conservatively", () => {
  const boundary: StationTerritoryBoundary = {
    type: "MultiPolygon",
    coordinates: [[square(11.4, 48.1, 11.8, 48.3)]],
  };
  const territories = buildStationTerritoriesWithinBoundary([
    area("same-red", 11.6, 48.2, "red"),
    area("same-blue", 11.6, 48.2, "blue"),
  ], boundary);

  assert.equal(territories.length, 2);
  assert.ok(territories.every((territory) => territory.classification === "unclassified"));
  assert.equal(territories.some((territory) => territory.classification === "red" || territory.classification === "blue"), false);

  const areas = territories.map((territory) => multiPolygonArea(territory.geometry));
  assert.ok(areas[0] > 0);
  assert.equal(areas[1], 0);
  const firstGeometry = territories[0].geometry.coordinates as unknown as polygonClipping.MultiPolygon;
  const union = polygonClipping.union(firstGeometry);
  const unionArea = multiPolygonArea({ type: "MultiPolygon", coordinates: union });
  assert.ok(Math.abs(areas.reduce((total, value) => total + value, 0) - unionArea) < unionArea * 1e-10);
});

test("partitions the production official Munich surface without gaps or positive-area overlaps", () => {
  const territories = buildStationTerritories([
    area("west", 11.45, 48.13, "red"),
    area("centre", 11.575, 48.137, "fair"),
    area("east", 11.68, 48.15, "blue"),
    area("north", 11.58, 48.20, "unclassified"),
  ]);

  const territoryAreas = territories.map((territory) => multiPolygonArea(territory.geometry));
  assert.ok(territoryAreas.every((value) => value > 0));

  const territoryArea = territoryAreas.reduce((total, value) => total + value, 0);
  const territoryGeometries = territories.map((territory) =>
    territory.geometry.coordinates as unknown as polygonClipping.MultiPolygon,
  );
  const territoryUnion = territoryGeometries.slice(1).reduce(
    (current, next) => polygonClipping.union(current, next),
    territoryGeometries[0],
  );
  const unionArea = multiPolygonArea({ type: "MultiPolygon", coordinates: territoryUnion });
  const officialSurface: StationTerritoryBoundary = {
    type: "MultiPolygon" as const,
    coordinates: boundaryAsset.features.flatMap((feature) => feature.geometry.coordinates) as unknown as StationTerritoryBoundary["coordinates"],
  };
  const officialGeometries = officialSurface.coordinates as unknown as polygonClipping.MultiPolygon;
  const officialUnion = polygonClipping.union(officialGeometries);
  const officialArea = multiPolygonArea({ type: "MultiPolygon", coordinates: officialUnion });

  // Equal territory-sum and union areas rule out positive-area overlaps;
  // equal territory-union and official-union areas rule out positive-area
  // coverage gaps. The tolerance covers only inverse-projection roundoff.
  assert.ok(Math.abs(territoryArea - unionArea) < officialArea * 1e-8);
  assert.ok(Math.abs(unionArea - officialArea) < officialArea * 1e-8);

  // Also probe a dense sample to make accidental interior gaps/overlaps
  // visible independently of the polygon-area identity.
  for (let longitude = 11.3; longitude <= 11.9; longitude += 0.01) {
    for (let latitude = 48.0; latitude <= 48.35; latitude += 0.01) {
      const memberships = territories.filter((territory) => pointInGeometry([longitude, latitude], territory.geometry)).length;
      assert.ok(memberships === 0 || memberships === 1);
    }
  }
  assert.ok(officialArea > 0);
});

test("differently classified sites meet at their projected perpendicular bisector", () => {
  const boundary: StationTerritoryBoundary = {
    type: "MultiPolygon",
    coordinates: [[square(11.4, 48.1, 11.8, 48.3)]],
  };
  const territories = buildStationTerritoriesWithinBoundary([
    area("red-site", 11.45, 48.2, "red"),
    area("blue-site", 11.75, 48.2, "blue"),
  ], boundary);
  const red = territories[0].geometry;
  const blue = territories[1].geometry;
  const projectedCrs = "+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs";
  const firstProjected = proj4("EPSG:4326", projectedCrs, [11.45, 48.2]);
  const secondProjected = proj4("EPSG:4326", projectedCrs, [11.75, 48.2]);
  const projectedMidpoint: Pair = [
    (firstProjected[0] + secondProjected[0]) / 2,
    (firstProjected[1] + secondProjected[1]) / 2,
  ];
  const midpointCoordinates = proj4(projectedCrs, "EPSG:4326", [projectedMidpoint[0], projectedMidpoint[1]]);
  const midpoint: Pair = [midpointCoordinates[0], midpointCoordinates[1]];
  const firstDistanceSquared = (projectedMidpoint[0] - firstProjected[0]) ** 2 + (projectedMidpoint[1] - firstProjected[1]) ** 2;
  const secondDistanceSquared = (projectedMidpoint[0] - secondProjected[0]) ** 2 + (projectedMidpoint[1] - secondProjected[1]) ** 2;

  assert.ok(Math.abs(firstDistanceSquared - secondDistanceSquared) < 1e-6);
  assert.ok(projectedDistanceToBoundary(midpoint, red) < 1);
  assert.ok(projectedDistanceToBoundary(midpoint, blue) < 1);
  assert.equal(territories[0].classification, "red");
  assert.equal(territories[1].classification, "blue");
});

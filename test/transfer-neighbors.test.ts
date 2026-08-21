import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  TRANSFER_NEIGHBOR_RADIUS_METERS,
  type ScheduledRoutingArtifact,
} from "../lib/domain/scheduled-routing/models.ts";
import {
  routeScheduledEarliestArrivals,
  type ScheduledAccessSeed,
} from "../lib/domain/scheduled-routing/index.ts";
import {
  buildAreaSpatialIndex,
  findAreasWithinRadius,
  haversineDistanceMeters,
} from "../lib/domain/scheduled-routing/spatial.ts";
import {
  ScheduleArtifactUnavailableError,
  writeScheduledArtifact,
} from "../lib/domain/scheduled-routing/artifact.ts";
import { FIXTURE_SCHEDULED_ARTIFACT } from "../lib/fixtures/scheduled-routing.ts";

const fixture = FIXTURE_SCHEDULED_ARTIFACT;
const SEARCH_START = "2026-08-11T08:05:00+02:00";

test("every compiled station area carries a precomputed transfer-neighbor list", () => {
  for (const area of fixture.stationAreas) {
    assert.ok(Array.isArray(area.transferNeighbors), `area ${area.id} has transferNeighbors`);
    assert.ok(area.transferNeighbors.length >= 1, `area ${area.id} includes at least itself`);
    const self = area.transferNeighbors.find((neighbor) => neighbor.stationAreaId === area.id);
    assert.ok(self !== undefined, `area ${area.id} references itself`);
    assert.equal(self?.distanceMeters, 0, `area ${area.id} self distance is 0`);
  }
});

test("precomputed neighbors equal a brute-force haversine enumeration within the precompute radius", () => {
  const index = buildAreaSpatialIndex(fixture.stationAreas, TRANSFER_NEIGHBOR_RADIUS_METERS);
  for (const area of fixture.stationAreas) {
    const expected = findAreasWithinRadius(index, area.coordinate, TRANSFER_NEIGHBOR_RADIUS_METERS)
      .map((neighbor) => ({
        stationAreaId: neighbor.id,
        distanceMeters: haversineDistanceMeters(area.coordinate, neighbor.coordinate),
      }))
      .sort((left, right) => left.stationAreaId.localeCompare(right.stationAreaId));
    assert.deepEqual(area.transferNeighbors, expected, `area ${area.id} neighbor list matches brute force`);
  }
});

test("filtered precomputed neighbors reproduce the per-arrival spatial query for any runtime radius up to the precompute radius", () => {
  for (const radius of [250, 600, TRANSFER_NEIGHBOR_RADIUS_METERS]) {
    const index = buildAreaSpatialIndex(fixture.stationAreas, radius);
    for (const area of fixture.stationAreas) {
      const expectedIds = findAreasWithinRadius(index, area.coordinate, radius).map((neighbor) => neighbor.id);
      const actualIds = area.transferNeighbors
        .filter((neighbor) => neighbor.distanceMeters <= radius)
        .map((neighbor) => neighbor.stationAreaId);
      assert.deepEqual(actualIds, expectedIds, `area ${area.id} at radius ${radius} matches spatial query`);
    }
  }
});

test("artifact validation rejects a station area missing transferNeighbors", async () => {
  const tampered: ScheduledRoutingArtifact = {
    ...fixture,
    stationAreas: fixture.stationAreas.map((area, index) =>
      index === 0 ? ({ id: area.id, name: area.name, coordinate: area.coordinate, mode: area.mode } as unknown as typeof area) : area,
    ),
  };
  const directory = await mkdtemp(join(tmpdir(), "meeet-transfer-neighbors-"));
  const manifestPath = join(directory, "scheduled-bundle.json");
  assert.throws(() => writeScheduledArtifact(manifestPath, tampered), ScheduleArtifactUnavailableError);
  await rm(directory, { recursive: true, force: true });
});

test("artifact validation rejects a transfer neighbor with a negative distance", async () => {
  const tampered: ScheduledRoutingArtifact = {
    ...fixture,
    stationAreas: fixture.stationAreas.map((area, index) =>
      index === 0 ? { ...area, transferNeighbors: [{ stationAreaId: area.id, distanceMeters: -1 }] } : area,
    ),
  };
  const directory = await mkdtemp(join(tmpdir(), "meeet-transfer-neighbors-"));
  const manifestPath = join(directory, "scheduled-bundle.json");
  assert.throws(() => writeScheduledArtifact(manifestPath, tampered), ScheduleArtifactUnavailableError);
  await rm(directory, { recursive: true, force: true });
});

test("precomputed transfer-neighbor scan routes end-to-end and is monotonic across radii", () => {
  const seedAreaId = fixture.stationAreas[0]!.id;
  const seeds: ScheduledAccessSeed[] = [{ stationAreaId: seedAreaId, accessSeconds: 0 }];
  const narrow = routeScheduledEarliestArrivals(fixture, seeds, SEARCH_START, { walkingVelocityMetersPerSecond: 1.4, transferRadiusMeters: 250 });
  const wide = routeScheduledEarliestArrivals(fixture, seeds, SEARCH_START, { walkingVelocityMetersPerSecond: 1.4, transferRadiusMeters: TRANSFER_NEIGHBOR_RADIUS_METERS });
  assert.ok(narrow.reachableStationAreaCount > 0, "narrow radius reaches at least one area via precomputed neighbors");
  assert.ok(wide.reachableStationAreaCount >= narrow.reachableStationAreaCount, "wider radius reaches at least as many areas");
  const narrowReached = new Set(narrow.stationArrivals.filter((arrival) => arrival.arrivalAt !== null).map((arrival) => arrival.stationAreaId));
  for (const arrival of wide.stationArrivals) {
    if (narrowReached.has(arrival.stationAreaId)) assert.ok(arrival.arrivalAt !== null, `area ${arrival.stationAreaId} reachable at narrow radius stays reachable when wider`);
  }
});

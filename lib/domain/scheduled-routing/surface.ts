import "server-only";

import { isWithinOfficialMunichBoundary } from "../boundary.ts";
import {
  CHANGE_TIME_PRESETS,
  ROUTING_HORIZON_SECONDS,
  SCHEDULED_ROUTING_CONTRACT_VERSION,
  WALKING_SECONDS_ROUNDING_RULE,
  type ScheduledAccessSeed,
  type ScheduledDeadlineCheck,
  type ScheduledParticipantSurface,
  type ScheduledRoutingArtifact,
  type ScheduledSurfaceInput,
  type ScheduledSurfaceMetadata,
  type ScheduledSurfaceResult,
  type ScheduledStationAreaCandidate,
  type ScheduledStationAreaCatalog,
  type ScheduledStationAreaCatalogEntry,
  type StationArrivalField,
} from "./models.ts";
import {
  DEFAULT_TRANSFER_RADIUS_METERS,
  createScheduledRoutingWindow,
  isScheduledToleranceSatisfied,
  routeScheduledEarliestArrivals,
} from "./router.ts";
import { compareScheduledIds } from "./gtfs.ts";

const STATION_AREA_CHECKPOINT = 32;

/** Calculate a two-participant scheduled arrival surface from station seeds. */
export function calculateScheduledSurface(input: ScheduledSurfaceInput): ScheduledSurfaceResult {
  if (input.accessSeedSets.length !== 2) throw new RangeError("Scheduled surface calculation requires exactly two access-seed sets.");
  const transferRadiusMeters = input.transferRadiusMeters ?? DEFAULT_TRANSFER_RADIUS_METERS;
  const changeTimeSeconds = input.changeTimeSeconds ?? CHANGE_TIME_PRESETS.medium;
  const stationAreaCatalog = buildScheduledStationAreaCatalog(input.schedule, input.deadlineCheck);
  const window = createScheduledRoutingWindow(input.schedule, input.searchStartAt, {
    walkingVelocityMetersPerSecond: input.walkingVelocityMetersPerSecond,
    transferRadiusMeters,
    changeTimeSeconds,
    deadlineCheck: input.deadlineCheck,
  });
  validateInput(input);
  const participantIds = input.participantIds ?? ["participant-1", "participant-2"];
  const routes = input.accessSeedSets.map((seeds) => {
    if (seeds.length === 0) return null;
    return routeScheduledEarliestArrivals(input.schedule, seeds, input.searchStartAt, { deadlineCheck: input.deadlineCheck }, window);
  });
  const firstRoute = routes[0];
  const secondRoute = routes[1];
  const searchStartAt = window.searchStartAt;
  const participantSurfaces: [ScheduledParticipantSurface, ScheduledParticipantSurface] = [
    createParticipantSurface(participantIds[0], input.schedule, firstRoute),
    createParticipantSurface(participantIds[1], input.schedule, secondRoute),
  ];
  const firstReachable = firstRoute?.reachableStationAreaCount ?? 0;
  const secondReachable = secondRoute?.reachableStationAreaCount ?? 0;
  const noAccessSeeds = input.accessSeedSets[0].length === 0 || input.accessSeedSets[1].length === 0;
  const noResult = noAccessSeeds || firstReachable === 0 || secondReachable === 0;
  const metadata: ScheduledSurfaceMetadata = {
    contractVersion: SCHEDULED_ROUTING_CONTRACT_VERSION,
    scheduleContentHash: input.schedule.provenance.contentHash,
    compiledArtifactId: input.schedule.provenance.compiledArtifactId,
    feedId: input.schedule.feedId,
    timeZone: input.schedule.timeZone,
    searchStartAt,
    routingHorizonSeconds: ROUTING_HORIZON_SECONDS,
    selectedTolerancePercent: input.selectedTolerancePercent,
    changeTimeSeconds,
    walkingVelocityMetersPerSecond: input.walkingVelocityMetersPerSecond,
    walkingSecondsRoundingRule: WALKING_SECONDS_ROUNDING_RULE,
    transferRadiusMeters,
    accessSeedCounts: [input.accessSeedSets[0].length, input.accessSeedSets[1].length],
    stationAreaCount: input.schedule.stationAreas.length,
    connectionCount: input.schedule.connections.length,
    coverage: "scheduled-service-day-local-radius/v1",
    representativePointBasis: "inside-clipped-cell/v1",
  };
  const stationAreas = createStationAreaCandidates(
    stationAreaCatalog,
    participantSurfaces[0].stationArrivals,
    participantSurfaces[1].stationArrivals,
    noResult,
    input.selectedTolerancePercent,
    input.deadlineCheck,
  );
  const result: ScheduledSurfaceResult = {
    status: noResult ? "no-result" : "ok",
    reason: noAccessSeeds ? "no-access-seeds" : firstReachable === 0 || secondReachable === 0 ? "no-reachable-stations" : null,
    participants: participantSurfaces,
    stationAreas,
    metadata,
  };
  return deepFreeze(result);
}

/** Alias that names the result by its later API-facing purpose. */
export const calculateScheduledFairnessSurface = calculateScheduledSurface;

function createParticipantSurface(
  participantId: string,
  schedule: ScheduledRoutingArtifact,
  route: ReturnType<typeof routeScheduledEarliestArrivals> | null | undefined,
): ScheduledParticipantSurface {
  const stationArrivals = route?.stationArrivals ?? schedule.stationAreas.map((area) => ({ stationAreaId: area.id, arrivalAt: null, elapsedSeconds: null }));
  return { participantId, stationArrivals };
}

export function buildScheduledStationAreaCatalog(
  schedule: ScheduledRoutingArtifact,
  deadlineCheck?: ScheduledDeadlineCheck,
): ScheduledStationAreaCatalog {
  const entries: ScheduledStationAreaCatalogEntry[] = [];
  const areas = [...schedule.stationAreas].sort((left, right) => compareScheduledIds(left.id, right.id));
  for (let index = 0; index < areas.length; index += 1) {
    if (index % STATION_AREA_CHECKPOINT === 0) deadlineCheck?.("surface-cells");
    const area = areas[index];
    if (area === undefined || !isWithinOfficialMunichBoundary(area.coordinate)) continue;
    entries.push({ stationAreaId: area.id, name: area.name, coordinate: area.coordinate });
  }
  return deepFreeze({ entries });
}

function createStationAreaCandidates(
  catalog: ScheduledStationAreaCatalog,
  redArrivals: readonly StationArrivalField[],
  blueArrivals: readonly StationArrivalField[],
  noResult: boolean,
  tolerancePercent: 5 | 10 | 15,
  deadlineCheck?: ScheduledDeadlineCheck,
): ScheduledStationAreaCandidate[] {
  const redByArea = new Map<string, StationArrivalField>();
  for (let index = 0; index < redArrivals.length; index += 1) {
    if (index % STATION_AREA_CHECKPOINT === 0) deadlineCheck?.("surface-cells");
    const arrival = redArrivals[index];
    if (arrival !== undefined) redByArea.set(arrival.stationAreaId, arrival);
  }
  const blueByArea = new Map<string, StationArrivalField>();
  for (let index = 0; index < blueArrivals.length; index += 1) {
    if (index % STATION_AREA_CHECKPOINT === 0) deadlineCheck?.("surface-cells");
    const arrival = blueArrivals[index];
    if (arrival !== undefined) blueByArea.set(arrival.stationAreaId, arrival);
  }
  const candidates: ScheduledStationAreaCandidate[] = [];
  for (let index = 0; index < catalog.entries.length; index += 1) {
    if (index % STATION_AREA_CHECKPOINT === 0) deadlineCheck?.("surface-cells");
    const area = catalog.entries[index];
    if (area === undefined) continue;
    const red = redByArea.get(area.stationAreaId);
    const blue = blueByArea.get(area.stationAreaId);
    if (noResult) {
      candidates.push({
        stationAreaId: area.stationAreaId,
        name: area.name,
        coordinate: area.coordinate,
        classification: "unclassified",
        redArrivalSeconds: null,
        blueArrivalSeconds: null,
        fasterParticipant: null,
        withinSelectedTolerance: false,
      });
      continue;
    }
    candidates.push(classifyStationArea(
      area.stationAreaId,
      area.name,
      area.coordinate,
      red?.elapsedSeconds ?? null,
      blue?.elapsedSeconds ?? null,
      tolerancePercent,
    ));
  }
  return candidates;
}

function classifyStationArea(
  stationAreaId: string,
  name: string,
  coordinate: { readonly latitude: number; readonly longitude: number },
  redArrivalSeconds: number | null,
  blueArrivalSeconds: number | null,
  tolerancePercent: 5 | 10 | 15,
): ScheduledStationAreaCandidate {
  if (redArrivalSeconds === null && blueArrivalSeconds === null) {
    return { stationAreaId, name, coordinate, classification: "unclassified", redArrivalSeconds: null, blueArrivalSeconds: null, fasterParticipant: null, withinSelectedTolerance: false };
  }
  if (redArrivalSeconds === null) {
    return { stationAreaId, name, coordinate, classification: "blue", redArrivalSeconds: null, blueArrivalSeconds, fasterParticipant: "blue", withinSelectedTolerance: false };
  }
  if (blueArrivalSeconds === null) {
    return { stationAreaId, name, coordinate, classification: "red", redArrivalSeconds, blueArrivalSeconds: null, fasterParticipant: "red", withinSelectedTolerance: false };
  }
  const fair = isScheduledToleranceSatisfied(redArrivalSeconds, blueArrivalSeconds, tolerancePercent);
  return {
    stationAreaId,
    name,
    coordinate,
    classification: fair ? "fair" : redArrivalSeconds < blueArrivalSeconds ? "red" : "blue",
    redArrivalSeconds,
    blueArrivalSeconds,
    fasterParticipant: redArrivalSeconds === blueArrivalSeconds ? null : redArrivalSeconds < blueArrivalSeconds ? "red" : "blue",
    withinSelectedTolerance: fair,
  };
}

function validateInput(input: ScheduledSurfaceInput): void {
  if (input.accessSeedSets.length !== 2) throw new RangeError("Scheduled surface calculation requires exactly two access-seed sets.");
  if (input.selectedTolerancePercent !== 5 && input.selectedTolerancePercent !== 10 && input.selectedTolerancePercent !== 15) throw new RangeError("Selected tolerance must be 5, 10, or 15 percent.");
  if (!Number.isFinite(input.walkingVelocityMetersPerSecond) || input.walkingVelocityMetersPerSecond <= 0) throw new RangeError("Walking velocity must be a positive finite number.");
  if (input.transferRadiusMeters !== undefined && (!Number.isFinite(input.transferRadiusMeters) || input.transferRadiusMeters <= 0)) throw new RangeError("Transfer radius must be a positive finite number.");
  const participantIds = input.participantIds;
  if (participantIds !== undefined && (participantIds[0].trim() === "" || participantIds[1].trim() === "" || participantIds[0] === participantIds[1])) throw new RangeError("Participant IDs must be two distinct non-empty strings.");
  validateAccessSeeds(input.accessSeedSets[0]);
  validateAccessSeeds(input.accessSeedSets[1]);
}

function validateAccessSeeds(seeds: readonly ScheduledAccessSeed[]): void {
  for (const seed of seeds) {
    if (seed.stationAreaId.trim() === "") throw new RangeError("Access seed stationAreaId must not be empty.");
    if (!Number.isSafeInteger(seed.accessSeconds) || seed.accessSeconds < 0 || seed.accessSeconds > ROUTING_HORIZON_SECONDS) throw new RangeError("Access seed accessSeconds must be a whole number within the routing horizon.");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

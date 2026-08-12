import "server-only";

import {
  ROUTING_HORIZON_SECONDS,
  SCHEDULED_ROUTING_CONTRACT_VERSION,
  WALKING_SECONDS_ROUNDING_RULE,
  type CellArrivalField,
  type ScheduledAccessSeed,
  type ScheduledCellClassification,
  type ScheduledClassifiedCell,
  type ScheduledParticipantSurface,
  type ScheduledRoutingArtifact,
  type ScheduledSurfaceCell,
  type ScheduledSurfaceInput,
  type ScheduledSurfaceMetadata,
  type ScheduledSurfaceResult,
  type StationArrivalField,
} from "./models.ts";
import {
  DEFAULT_TRANSFER_RADIUS_METERS,
  DEFAULT_WALKING_VELOCITY_METERS_PER_SECOND,
  createScheduledRoutingWindow,
  isScheduledToleranceSatisfied,
  routeScheduledEarliestArrivals,
  walkingSeconds,
} from "./router.ts";

/** Calculate a two-participant scheduled arrival surface from station seeds. */
export function calculateScheduledSurface(input: ScheduledSurfaceInput): ScheduledSurfaceResult {
  if (input.accessSeedSets.length !== 2) throw new RangeError("Scheduled surface calculation requires exactly two access-seed sets.");
  const transferRadiusMeters = input.transferRadiusMeters ?? DEFAULT_TRANSFER_RADIUS_METERS;
  const window = createScheduledRoutingWindow(input.schedule, input.searchStartAt, {
    walkingVelocityMetersPerSecond: input.walkingVelocityMetersPerSecond,
    transferRadiusMeters,
    deadlineChecker: input.deadlineChecker,
  });
  validateInput(input);
  const participantIds = input.participantIds ?? ["participant-1", "participant-2"];
  const cells = [...input.cells].sort((left, right) => left.id.localeCompare(right.id));
  const routes = input.accessSeedSets.map((seeds) => {
    if (seeds.length === 0) return null;
    return routeScheduledEarliestArrivals(input.schedule, seeds, input.searchStartAt, {}, window);
  });
  const firstRoute = routes[0];
  const secondRoute = routes[1];
  const searchStartAt = window.searchStartAt;
  const searchStartEpochSeconds = window.searchStartEpochSeconds;
  const participantSurfaces: [ScheduledParticipantSurface, ScheduledParticipantSurface] = [
    createParticipantSurface(participantIds[0], input.schedule, firstRoute, cells, input.walkingVelocityMetersPerSecond, searchStartEpochSeconds, input.deadlineChecker),
    createParticipantSurface(participantIds[1], input.schedule, secondRoute, cells, input.walkingVelocityMetersPerSecond, searchStartEpochSeconds, input.deadlineChecker),
  ];
  const firstReachable = firstRoute?.reachableStationAreaCount ?? 0;
  const secondReachable = secondRoute?.reachableStationAreaCount ?? 0;
  const noAccessSeeds = input.accessSeedSets[0].length === 0 || input.accessSeedSets[1].length === 0;
  const noResult = noAccessSeeds || firstReachable === 0 || secondReachable === 0;
  const classifiedCells = noResult
    ? cells.map((cell) => unclassifiedCell(cell.id))
    : cells.map((cell, index) => {
        const first = participantSurfaces[0].cellArrivals[index];
        const second = participantSurfaces[1].cellArrivals[index];
        if (first === undefined || second === undefined) throw new Error("Cell surface assembly lost a cell.");
        return classifyCell(cell.id, first, second, input.selectedTolerancePercent);
      });
  const metadata: ScheduledSurfaceMetadata = {
    contractVersion: SCHEDULED_ROUTING_CONTRACT_VERSION,
    scheduleContentHash: input.schedule.provenance.contentHash,
    compiledArtifactId: input.schedule.provenance.compiledArtifactId,
    feedId: input.schedule.feedId,
    timeZone: input.schedule.timeZone,
    searchStartAt,
    routingHorizonSeconds: ROUTING_HORIZON_SECONDS,
    selectedTolerancePercent: input.selectedTolerancePercent,
    walkingVelocityMetersPerSecond: input.walkingVelocityMetersPerSecond,
    walkingSecondsRoundingRule: WALKING_SECONDS_ROUNDING_RULE,
    transferRadiusMeters,
    accessSeedCounts: [input.accessSeedSets[0].length, input.accessSeedSets[1].length],
    stationAreaCount: input.schedule.stationAreas.length,
    boardingStopCount: input.schedule.boardingStops.length,
    connectionCount: input.schedule.connections.length,
    coverage: "scheduled-service-day-local-radius/v1",
    representativePointBasis: "inside-clipped-cell/v1",
  };
  const result: ScheduledSurfaceResult = {
    status: noResult ? "no-result" : "ok",
    reason: noAccessSeeds ? "no-access-seeds" : firstReachable === 0 || secondReachable === 0 ? "no-reachable-stations" : null,
    participants: participantSurfaces,
    cells: classifiedCells,
    metadata,
  };
  return deepFreeze(result);
}

function unclassifiedCell(cellId: string): ScheduledClassifiedCell {
  return { cellId, classification: "unclassified", redArrivalSeconds: null, blueArrivalSeconds: null, fasterParticipant: null, withinSelectedTolerance: false };
}

/** Alias that names the result by its later API-facing purpose. */
export const calculateScheduledFairnessSurface = calculateScheduledSurface;

function createParticipantSurface(
  participantId: string,
  schedule: ScheduledRoutingArtifact,
  route: ReturnType<typeof routeScheduledEarliestArrivals> | null | undefined,
  cells: readonly ScheduledSurfaceCell[],
  velocityMetersPerSecond: number,
  searchStartEpochSeconds: number,
  deadlineChecker?: () => void,
): ScheduledParticipantSurface {
  const stationArrivals = route?.stationArrivals ?? schedule.stationAreas.map((area) => ({ stationAreaId: area.id, arrivalAt: null, elapsedSeconds: null }));
  const areas = new Map(schedule.stationAreas.map((area) => [area.id, area]));
  const cellArrivals: CellArrivalField[] = cells.map((cell) => {
    deadlineChecker?.();
    let bestElapsed: number | null = null;
    for (const stationArrival of stationArrivals) {
      if (stationArrival.elapsedSeconds === null) continue;
      const area = areas.get(stationArrival.stationAreaId);
      if (area === undefined) throw new Error("Station arrival references an unknown area.");
      const finalWalkSeconds = walkingSeconds(area.coordinate, cell.representativePoint ?? cell.center, velocityMetersPerSecond);
      const elapsedSeconds = stationArrival.elapsedSeconds + finalWalkSeconds;
      if (elapsedSeconds > ROUTING_HORIZON_SECONDS) continue;
      if (bestElapsed === null || elapsedSeconds < bestElapsed) bestElapsed = elapsedSeconds;
    }
    return {
      cellId: cell.id,
      arrivalAt: bestElapsed === null ? null : new Date((searchStartEpochSeconds + bestElapsed) * 1_000).toISOString(),
      elapsedSeconds: bestElapsed,
    };
  });
  return { participantId, stationArrivals, cellArrivals };
}

function classifyCell(
  cellId: string,
  first: CellArrivalField,
  second: CellArrivalField,
  tolerancePercent: number,
): ScheduledClassifiedCell {
  const firstSeconds = first.elapsedSeconds;
  const secondSeconds = second.elapsedSeconds;
  if (firstSeconds === null && secondSeconds === null) {
    return { cellId, classification: "unclassified", redArrivalSeconds: null, blueArrivalSeconds: null, fasterParticipant: null, withinSelectedTolerance: false };
  }
  if (firstSeconds === null) {
    return { cellId, classification: "blue", redArrivalSeconds: null, blueArrivalSeconds: secondSeconds, fasterParticipant: "blue", withinSelectedTolerance: false };
  }
  if (secondSeconds === null) {
    return { cellId, classification: "red", redArrivalSeconds: firstSeconds, blueArrivalSeconds: null, fasterParticipant: "red", withinSelectedTolerance: false };
  }
  const fair = isScheduledToleranceSatisfied(firstSeconds, secondSeconds, tolerancePercent);
  const classification: ScheduledCellClassification = fair ? "fair" : firstSeconds < secondSeconds ? "red" : "blue";
  return {
    cellId,
    classification,
    redArrivalSeconds: firstSeconds,
    blueArrivalSeconds: secondSeconds,
    fasterParticipant: firstSeconds === secondSeconds ? null : firstSeconds < secondSeconds ? "red" : "blue",
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
  const ids = new Set<string>();
  for (const cell of input.cells) {
    if (cell.id.trim() === "" || ids.has(cell.id)) throw new RangeError("Surface cell IDs must be unique and non-empty.");
    ids.add(cell.id);
    validateCoordinate(cell.center, "Surface cell center");
  }
  validateAccessSeeds(input.accessSeedSets[0]);
  validateAccessSeeds(input.accessSeedSets[1]);
}

function validateAccessSeeds(seeds: readonly ScheduledAccessSeed[]): void {
  for (const seed of seeds) {
    if (seed.stationAreaId.trim() === "") throw new RangeError("Access seed stationAreaId must not be empty.");
    if (!Number.isSafeInteger(seed.accessSeconds) || seed.accessSeconds < 0 || seed.accessSeconds > ROUTING_HORIZON_SECONDS) throw new RangeError("Access seed accessSeconds must be a whole number within the routing horizon.");
  }
}

function validateCoordinate(coordinate: { readonly latitude: number; readonly longitude: number }, label: string): void {
  if (!Number.isFinite(coordinate.latitude) || !Number.isFinite(coordinate.longitude) || coordinate.latitude < -90 || coordinate.latitude > 90 || coordinate.longitude < -180 || coordinate.longitude > 180) throw new RangeError(`${label} is outside coordinate bounds.`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

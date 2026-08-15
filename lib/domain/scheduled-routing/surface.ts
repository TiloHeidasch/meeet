import "server-only";

import { isWithinOfficialMunichBoundary } from "../boundary.ts";
import {
  ROUTING_HORIZON_SECONDS,
  SCHEDULED_ROUTING_CONTRACT_VERSION,
  WALKING_SECONDS_ROUNDING_RULE,
  type CellArrivalField,
  type BoardingStopArrivalField,
  type ScheduledAccessSeed,
  type ScheduledCellClassification,
  type ScheduledDeadlineCheck,
  type ScheduledClassifiedCell,
  type ScheduledParticipantSurface,
  type ScheduledRoutingArtifact,
  type ScheduledSurfaceCell,
  type ScheduledSurfaceInput,
  type ScheduledSurfaceMetadata,
  type ScheduledSurfaceResult,
  type ScheduledStationAreaCandidate,
  type ScheduledStationAreaCatalog,
  type ScheduledStationAreaCatalogEntry,
} from "./models.ts";
import {
  DEFAULT_TRANSFER_RADIUS_METERS,
  DEFAULT_WALKING_VELOCITY_METERS_PER_SECOND,
  createScheduledRoutingWindow,
  isScheduledToleranceSatisfied,
  routeScheduledEarliestArrivals,
  walkingSeconds,
} from "./router.ts";
import { isScheduledInteriorRepresentativePoint } from "./grid.ts";
import { compareScheduledIds } from "./gtfs.ts";

const SURFACE_CELL_CHECKPOINT = 16;
const STATION_AREA_CHECKPOINT = 32;

/** Calculate a two-participant scheduled arrival surface from station seeds. */
export function calculateScheduledSurface(input: ScheduledSurfaceInput): ScheduledSurfaceResult {
  if (input.accessSeedSets.length !== 2) throw new RangeError("Scheduled surface calculation requires exactly two access-seed sets.");
  const transferRadiusMeters = input.transferRadiusMeters ?? DEFAULT_TRANSFER_RADIUS_METERS;
  const stationAreaCatalog = buildScheduledStationAreaCatalog(input.schedule, input.deadlineCheck);
  const window = createScheduledRoutingWindow(input.schedule, input.searchStartAt, {
    walkingVelocityMetersPerSecond: input.walkingVelocityMetersPerSecond,
    transferRadiusMeters,
    deadlineCheck: input.deadlineCheck,
  });
  validateInput(input);
  const participantIds = input.participantIds ?? ["participant-1", "participant-2"];
  const cells = [...input.cells].sort((left, right) => left.id.localeCompare(right.id));
  const routes = input.accessSeedSets.map((seeds) => {
    if (seeds.length === 0) return null;
    return routeScheduledEarliestArrivals(input.schedule, seeds, input.searchStartAt, { deadlineCheck: input.deadlineCheck }, window);
  });
  const firstRoute = routes[0];
  const secondRoute = routes[1];
  const searchStartAt = window.searchStartAt;
  const searchStartEpochSeconds = window.searchStartEpochSeconds;
  const participantSurfaces: [ScheduledParticipantSurface, ScheduledParticipantSurface] = [
    createParticipantSurface(participantIds[0], input.schedule, firstRoute, cells, input.walkingVelocityMetersPerSecond, searchStartEpochSeconds, input.deadlineCheck),
    createParticipantSurface(participantIds[1], input.schedule, secondRoute, cells, input.walkingVelocityMetersPerSecond, searchStartEpochSeconds, input.deadlineCheck),
  ];
  const firstReachable = firstRoute?.reachableStationAreaCount ?? 0;
  const secondReachable = secondRoute?.reachableStationAreaCount ?? 0;
  const noAccessSeeds = input.accessSeedSets[0].length === 0 || input.accessSeedSets[1].length === 0;
  const noResult = noAccessSeeds || firstReachable === 0 || secondReachable === 0;
  const classifiedCells = noResult
    ? cells.map((cell) => unclassifiedCell(cell.id))
    : cells.map((cell, index) => {
        if (index % SURFACE_CELL_CHECKPOINT === 0) input.deadlineCheck?.("surface-cells");
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
  const stationAreas = createStationAreaCandidates(
    stationAreaCatalog,
    participantSurfaces[0].boardingStopArrivals,
    participantSurfaces[1].boardingStopArrivals,
    noResult,
    input.selectedTolerancePercent,
    input.deadlineCheck,
  );
  const result: ScheduledSurfaceResult = {
    status: noResult ? "no-result" : "ok",
    reason: noAccessSeeds ? "no-access-seeds" : firstReachable === 0 || secondReachable === 0 ? "no-reachable-stations" : null,
    participants: participantSurfaces,
    cells: classifiedCells,
    stationAreas,
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
  deadlineCheck?: ScheduledDeadlineCheck,
): ScheduledParticipantSurface {
  const stationArrivals = route?.stationArrivals ?? schedule.stationAreas.map((area) => ({ stationAreaId: area.id, arrivalAt: null, elapsedSeconds: null }));
  const boardingStopArrivals = route?.boardingStopArrivals ?? emptyBoardingStopArrivals(schedule.boardingStops, deadlineCheck);
  const areas = new Map(schedule.stationAreas.map((area) => [area.id, area]));
  const cellArrivals: CellArrivalField[] = cells.map((cell, index) => {
    if (index % SURFACE_CELL_CHECKPOINT === 0) deadlineCheck?.("surface-cells");
    let bestElapsed: number | null = null;
    for (const stationArrival of stationArrivals) {
      if (stationArrival.elapsedSeconds === null) continue;
      const area = areas.get(stationArrival.stationAreaId);
      if (area === undefined) throw new Error("Station arrival references an unknown area.");
      const finalWalkSeconds = walkingSeconds(area.coordinate, cell.representativePoint, velocityMetersPerSecond);
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
  return { participantId, stationArrivals, boardingStopArrivals, cellArrivals };
}

function emptyBoardingStopArrivals(
  stops: readonly ScheduledRoutingArtifact["boardingStops"][number][],
  deadlineCheck?: ScheduledDeadlineCheck,
): BoardingStopArrivalField[] {
  return stops.map((stop, index) => {
    if (index % STATION_AREA_CHECKPOINT === 0) deadlineCheck?.("surface-cells");
    return { boardingStopId: stop.id, arrivalAt: null, elapsedSeconds: null };
  });
}

export function buildScheduledStationAreaCatalog(
  schedule: ScheduledRoutingArtifact,
  deadlineCheck?: ScheduledDeadlineCheck,
): ScheduledStationAreaCatalog {
  const connectedStopIds = new Set<string>();
  for (let index = 0; index < schedule.connections.length; index += 1) {
    if (index % STATION_AREA_CHECKPOINT === 0) deadlineCheck?.("surface-cells");
    const connection = schedule.connections[index];
    if (connection === undefined) continue;
    connectedStopIds.add(connection.fromStopId);
    connectedStopIds.add(connection.toStopId);
  }
  const stopsById = new Map<string, ScheduledRoutingArtifact["boardingStops"][number]>();
  for (let index = 0; index < schedule.boardingStops.length; index += 1) {
    if (index % STATION_AREA_CHECKPOINT === 0) deadlineCheck?.("surface-cells");
    const stop = schedule.boardingStops[index];
    if (stop !== undefined) stopsById.set(stop.id, stop);
  }
  const entries: ScheduledStationAreaCatalogEntry[] = [];
  const areas = [...schedule.stationAreas].sort((left, right) => compareScheduledIds(left.id, right.id));
  for (let index = 0; index < areas.length; index += 1) {
    if (index % STATION_AREA_CHECKPOINT === 0) deadlineCheck?.("surface-cells");
    const area = areas[index];
    if (area === undefined || !isWithinOfficialMunichBoundary(area.coordinate)) continue;
    const eligibleBoardingStopIds: string[] = [];
    for (let stopIndex = 0; stopIndex < area.boardingStopIds.length; stopIndex += 1) {
      if (stopIndex % STATION_AREA_CHECKPOINT === 0) deadlineCheck?.("surface-cells");
      const stopId = area.boardingStopIds[stopIndex];
      if (stopId === undefined) continue;
      const stop = stopsById.get(stopId);
      if (stop !== undefined && isWithinOfficialMunichBoundary(stop.coordinate) && connectedStopIds.has(stopId)) eligibleBoardingStopIds.push(stopId);
    }
    eligibleBoardingStopIds.sort(compareScheduledIds);
    if (eligibleBoardingStopIds.length === 0) continue;
    entries.push({ stationAreaId: area.id, name: area.name, coordinate: area.coordinate, eligibleBoardingStopIds });
  }
  return deepFreeze({ entries });
}

function createStationAreaCandidates(
  catalog: ScheduledStationAreaCatalog,
  redArrivals: readonly BoardingStopArrivalField[],
  blueArrivals: readonly BoardingStopArrivalField[],
  noResult: boolean,
  tolerancePercent: 5 | 10 | 15,
  deadlineCheck?: ScheduledDeadlineCheck,
): ScheduledStationAreaCandidate[] {
  const redByStop = new Map<string, BoardingStopArrivalField>();
  for (let index = 0; index < redArrivals.length; index += 1) {
    if (index % STATION_AREA_CHECKPOINT === 0) deadlineCheck?.("surface-cells");
    const arrival = redArrivals[index];
    if (arrival !== undefined) redByStop.set(arrival.boardingStopId, arrival);
  }
  const blueByStop = new Map<string, BoardingStopArrivalField>();
  for (let index = 0; index < blueArrivals.length; index += 1) {
    if (index % STATION_AREA_CHECKPOINT === 0) deadlineCheck?.("surface-cells");
    const arrival = blueArrivals[index];
    if (arrival !== undefined) blueByStop.set(arrival.boardingStopId, arrival);
  }
  const candidates: ScheduledStationAreaCandidate[] = [];
  for (let index = 0; index < catalog.entries.length; index += 1) {
    if (index % STATION_AREA_CHECKPOINT === 0) deadlineCheck?.("surface-cells");
    const area = catalog.entries[index];
    if (area === undefined) continue;
    const red = fastestEligibleBoardingStop(area.eligibleBoardingStopIds, redByStop, deadlineCheck);
    const blue = fastestEligibleBoardingStop(area.eligibleBoardingStopIds, blueByStop, deadlineCheck);
    if (noResult) {
      candidates.push({
        stationAreaId: area.stationAreaId,
        name: area.name,
        coordinate: area.coordinate,
        redBoardingStopId: null,
        blueBoardingStopId: null,
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
      red?.boardingStopId ?? null,
      blue?.boardingStopId ?? null,
      red?.elapsedSeconds ?? null,
      blue?.elapsedSeconds ?? null,
      tolerancePercent,
    ));
  }
  return candidates;
}

function fastestEligibleBoardingStop(
  stopIds: readonly string[],
  arrivals: ReadonlyMap<string, BoardingStopArrivalField>,
  deadlineCheck?: ScheduledDeadlineCheck,
): BoardingStopArrivalField | null {
  let fastest: { readonly arrival: BoardingStopArrivalField; readonly elapsedSeconds: number } | null = null;
  for (let index = 0; index < stopIds.length; index += 1) {
    if (index % STATION_AREA_CHECKPOINT === 0) deadlineCheck?.("surface-cells");
    const stopId = stopIds[index];
    if (stopId === undefined) continue;
    const arrival = arrivals.get(stopId);
    const elapsedSeconds = arrival?.elapsedSeconds;
    if (arrival === undefined || elapsedSeconds === null || elapsedSeconds === undefined) continue;
    if (fastest === null || elapsedSeconds < fastest.elapsedSeconds || (elapsedSeconds === fastest.elapsedSeconds && compareScheduledIds(arrival.boardingStopId, fastest.arrival.boardingStopId) < 0)) fastest = { arrival, elapsedSeconds };
  }
  return fastest?.arrival ?? null;
}

function classifyStationArea(
  stationAreaId: string,
  name: string,
  coordinate: { readonly latitude: number; readonly longitude: number },
  redBoardingStopId: string | null,
  blueBoardingStopId: string | null,
  redArrivalSeconds: number | null,
  blueArrivalSeconds: number | null,
  tolerancePercent: 5 | 10 | 15,
): ScheduledStationAreaCandidate {
  if (redArrivalSeconds === null && blueArrivalSeconds === null) {
    return { stationAreaId, name, coordinate, redBoardingStopId: null, blueBoardingStopId: null, classification: "unclassified", redArrivalSeconds: null, blueArrivalSeconds: null, fasterParticipant: null, withinSelectedTolerance: false };
  }
  if (redArrivalSeconds === null) {
    return { stationAreaId, name, coordinate, redBoardingStopId: null, blueBoardingStopId, classification: "blue", redArrivalSeconds: null, blueArrivalSeconds, fasterParticipant: "blue", withinSelectedTolerance: false };
  }
  if (blueArrivalSeconds === null) {
    return { stationAreaId, name, coordinate, redBoardingStopId, blueBoardingStopId: null, classification: "red", redArrivalSeconds, blueArrivalSeconds: null, fasterParticipant: "red", withinSelectedTolerance: false };
  }
  const fair = isScheduledToleranceSatisfied(redArrivalSeconds, blueArrivalSeconds, tolerancePercent);
  return {
    stationAreaId,
    name,
    coordinate,
    redBoardingStopId,
    blueBoardingStopId,
    classification: fair ? "fair" : redArrivalSeconds < blueArrivalSeconds ? "red" : "blue",
    redArrivalSeconds,
    blueArrivalSeconds,
    fasterParticipant: redArrivalSeconds === blueArrivalSeconds ? null : redArrivalSeconds < blueArrivalSeconds ? "red" : "blue",
    withinSelectedTolerance: fair,
  };
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
    validateCoordinate(cell.representativePoint, "Surface cell representative point");
    if (cell.geometry !== undefined && !isScheduledInteriorRepresentativePoint(cell.representativePoint, cell.geometry)) throw new RangeError("Surface cell representative point must be strictly inside its clipped geometry.");
  }
  validateAccessSeeds(input.accessSeedSets[0]);
  validateAccessSeeds(input.accessSeedSets[1]);
}

function validateAccessSeeds(seeds: readonly ScheduledAccessSeed[]): void {
  for (const seed of seeds) {
    if (seed.stationAreaId.trim() === "") throw new RangeError("Access seed stationAreaId must not be empty.");
    if (seed.boardingStopId !== undefined && seed.boardingStopId.trim() === "") throw new RangeError("Access seed boardingStopId must not be empty.");
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

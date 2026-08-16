import "server-only";

import {
  ROUTING_HORIZON_SECONDS,
  WALKING_SECONDS_ROUNDING_RULE,
  type ScheduledAccessSeed,
  type ScheduledBoardingStop,
  type ScheduledConnection,
  type ScheduledDeadlineCheck,
  type BoardingStopArrivalField,
  type ScheduledRoutingArtifact,
  type ScheduledRoutingOptions,
  type ScheduledRoutingResult,
  type StationArrivalField,
} from "./models.ts";
import {
  compareScheduledConnections,
} from "./gtfs.ts";
import {
  addServiceDays,
  parseOffsetInstant,
  serviceDateAnchorEpochSeconds,
  serviceDateRangeForSearch,
} from "./time.ts";
import type { ScheduledAccessSeedCandidate } from "../providers.ts";

export const DEFAULT_WALKING_VELOCITY_METERS_PER_SECOND = 1.4;
export const DEFAULT_TRANSFER_RADIUS_METERS = 250;
const ROUTING_CONNECTION_CHECKPOINT = 2_048;

export interface ScheduledMaterializedConnection {
  readonly instanceId: string;
  readonly serviceDate: string;
  readonly source: ScheduledConnection;
  readonly departureEpochSeconds: number;
  readonly arrivalEpochSeconds: number;
  readonly connectionKey: string;
  readonly previousContinuationKey: string | null;
}

export interface ScheduledSpatialIndex {
  readonly bucketSizeDegrees: number;
  readonly buckets: ReadonlyMap<string, readonly string[]>;
  readonly stops: ReadonlyMap<string, ScheduledBoardingStop>;
}

interface ResolvedRoutingOptions {
  readonly walkingVelocityMetersPerSecond: number;
  readonly transferRadiusMeters: number;
  readonly deadlineCheck?: ScheduledDeadlineCheck;
}

export interface ScheduledRoutingWindow {
  readonly schedule: ScheduledRoutingArtifact;
  readonly searchStartAt: string;
  readonly searchStartEpochSeconds: number;
  readonly horizonEndEpochSeconds: number;
  readonly walkingVelocityMetersPerSecond: number;
  readonly transferRadiusMeters: number;
  readonly connections: readonly ScheduledMaterializedConnection[];
  readonly spatialIndex: ScheduledSpatialIndex;
  readonly deadlineCheck?: ScheduledDeadlineCheck;
}

export const SCHEDULED_DETAIL_SELECTION_POLICY = "earliest-arrival/canonical-scan-first/v1";

export type ScheduledSelectedRouteStop = {
  readonly boardingStopId: string;
  readonly stationAreaId: string;
  readonly name: string;
};

export type ScheduledSelectedRouteStationArea = {
  readonly stationAreaId: string;
  readonly name: string;
};

export type ScheduledSelectedRouteCoordinate = {
  readonly latitude: number;
  readonly longitude: number;
};

export type ScheduledSelectedRouteSegment =
  | {
      readonly kind: "walk";
      readonly purpose: "origin-access" | "station-area-access" | "transfer";
      readonly durationSeconds: number;
      readonly distanceMeters: number;
      readonly from: ScheduledSelectedRouteCoordinate;
      readonly to: ScheduledSelectedRouteCoordinate;
      readonly estimate: "geometric-estimate-not-directions/v1";
      readonly startAt: string;
      readonly endAt: string;
    }
  | {
      readonly kind: "wait";
      readonly durationSeconds: number;
      readonly at: ScheduledSelectedRouteStop;
      readonly startAt: string;
      readonly endAt: string;
    }
  | {
      readonly kind: "transit";
      readonly durationSeconds: number;
      readonly startAt: string;
      readonly endAt: string;
      readonly source: "mvv-gtfs";
      readonly serviceDate: string;
      readonly serviceId: string;
      readonly tripId: string;
      readonly line: string;
      readonly headsign: string;
      readonly from: ScheduledSelectedRouteStop;
      readonly to: ScheduledSelectedRouteStop;
    }
  | {
      readonly kind: "identity-resolution";
      readonly purpose: "station-access";
      readonly durationSeconds: 0;
      readonly startAt: string;
      readonly endAt: string;
      readonly source: "mvg-nearby-to-mvv-gtfs-identity/v1";
      readonly target: "station-area" | "boarding-stop";
      readonly from: ScheduledSelectedRouteCoordinate;
      readonly to: ScheduledSelectedRouteStationArea | ScheduledSelectedRouteStop;
      readonly toCoordinate: ScheduledSelectedRouteCoordinate;
    };

export interface ScheduledSelectedBoardingStopRoute {
  readonly boardingStopId: string;
  readonly stationAreaId: string;
  readonly totalSeconds: number;
  readonly arrivalAt: string;
  readonly segments: readonly ScheduledSelectedRouteSegment[];
}

export interface ScheduledRoutingWitnessInstrumentation {
  /** Server-test seam; witness capture is otherwise strictly opt-in. */
  readonly onWitnessAllocation?: (kind: "ready-map" | "connection-map") => void;
}

export interface ScheduledSelectedBoardingStopOptions extends ScheduledRoutingOptions, ScheduledRoutingWitnessInstrumentation {
  readonly origin?: ScheduledSelectedRouteCoordinate;
}

/** Narrow instrumentation seam for deterministic routing-window tests. */
export interface ScheduledRoutingWindowInstrumentation {
  readonly onCandidateServiceDate?: (serviceDate: string) => void;
  readonly serviceDateAnchor?: (serviceDate: string, timeZone: string) => number;
}

/**
 * Connection-scan routing with bounded local transfers. A transfer is emitted
 * only from a transit arrival and is queried through a geographic bucket index;
 * the algorithm never computes a stop-to-stop all-pairs closure.
 */
export function routeScheduledEarliestArrivals(
  schedule: ScheduledRoutingArtifact,
  accessSeeds: readonly ScheduledAccessSeed[],
  searchStartAt: string,
  options: ScheduledRoutingOptions & ScheduledRoutingWitnessInstrumentation = {},
  suppliedWindow?: ScheduledRoutingWindow,
): ScheduledRoutingResult {
  const window = suppliedWindow ?? createScheduledRoutingWindow(schedule, searchStartAt, options);
  if (window.schedule !== schedule) throw new RangeError("A routing window belongs to a different schedule artifact.");
  const parsedStart = parseOffsetInstant(searchStartAt, schedule.timeZone);
  if (parsedStart.epochSeconds !== window.searchStartEpochSeconds) throw new RangeError("A routing window belongs to a different search start.");
  const scan = scanScheduledConnections(schedule, accessSeeds, window, options);
  const stationArrivals: StationArrivalField[] = schedule.stationAreas.map((area) => {
    const epochSeconds = scan.earliestArrivalByArea.get(area.id);
    return {
      stationAreaId: area.id,
      arrivalAt: epochSeconds === undefined ? null : formatEpochSeconds(epochSeconds),
      elapsedSeconds: epochSeconds === undefined ? null : epochSeconds - parsedStart.epochSeconds,
    };
  });
  const boardingStopArrivals: BoardingStopArrivalField[] = schedule.boardingStops.map((stop, index) => {
    if (index % ROUTING_CONNECTION_CHECKPOINT === 0) (options.deadlineCheck ?? window.deadlineCheck)?.("routing-scan");
    const readyAt = scan.earliestReadyByStop.get(stop.id);
    return {
      boardingStopId: stop.id,
      arrivalAt: readyAt === undefined ? null : formatEpochSeconds(readyAt),
      elapsedSeconds: readyAt === undefined ? null : readyAt - parsedStart.epochSeconds,
    };
  });
  return Object.freeze({
    stationArrivals: Object.freeze(stationArrivals),
    boardingStopArrivals: Object.freeze(boardingStopArrivals),
    reachableStationAreaCount: stationArrivals.filter((arrival) => arrival.arrivalAt !== null).length,
    searchStartAt: parsedStart.canonicalAt,
    searchStartEpochSeconds: parsedStart.epochSeconds,
    horizonEndEpochSeconds: window.horizonEndEpochSeconds,
  });
}

interface ScheduledReadyWitness {
  readonly kind: "origin" | "transfer";
  readonly seed?: ScheduledAccessSeed;
  readonly seedIndex?: number;
  readonly connectionKey?: string;
  readonly fromStopId?: string;
}

interface ScheduledConnectionWitness {
  readonly connection: ScheduledMaterializedConnection;
  readonly previousKey: string | null;
}

interface ScheduledScanState {
  readonly earliestReadyByStop: Map<string, number>;
  readonly earliestArrivalByArea: Map<string, number>;
  readonly readyWitnessByStop?: Map<string, ScheduledReadyWitness>;
  readonly connectionWitnessByKey?: Map<string, ScheduledConnectionWitness>;
  readonly window: ScheduledRoutingWindow;
  readonly parsedStartEpochSeconds: number;
}

function scanScheduledConnections(
  schedule: ScheduledRoutingArtifact,
  accessSeeds: readonly ScheduledAccessSeed[],
  window: ScheduledRoutingWindow,
  options: ScheduledRoutingOptions & ScheduledRoutingWitnessInstrumentation,
  captureWitness = false,
): ScheduledScanState {
  const resolvedOptions: ResolvedRoutingOptions = {
    walkingVelocityMetersPerSecond: window.walkingVelocityMetersPerSecond,
    transferRadiusMeters: window.transferRadiusMeters,
    deadlineCheck: options.deadlineCheck ?? window.deadlineCheck,
  };
  resolvedOptions.deadlineCheck?.("routing-scan");
  const stationById = new Map(schedule.stationAreas.map((area) => [area.id, area]));
  const stopById = new Map(schedule.boardingStops.map((stop) => [stop.id, stop]));
  const earliestReadyByStop = new Map<string, number>();
  const earliestArrivalByArea = new Map<string, number>();
  const readyWitnessByStop = captureWitness ? new Map<string, ScheduledReadyWitness>() : undefined;
  const connectionWitnessByKey = captureWitness ? new Map<string, ScheduledConnectionWitness>() : undefined;
  if (captureWitness) {
    options.onWitnessAllocation?.("ready-map");
    options.onWitnessAllocation?.("connection-map");
  }
  const reachableConnectionKeys = new Set<string>();
  const continuationByPreviousKey = new Map<string, ScheduledMaterializedConnection>();
  for (let connectionIndex = 0; connectionIndex < window.connections.length; connectionIndex += 1) {
    if (connectionIndex % ROUTING_CONNECTION_CHECKPOINT === 0) resolvedOptions.deadlineCheck?.("routing-scan");
    const connection = window.connections[connectionIndex];
    if (connection === undefined) continue;
    if (connection.previousContinuationKey !== null) continuationByPreviousKey.set(connection.previousContinuationKey, connection);
  }

  let enqueueForStop: ((stopId: string) => void) | null = null;
  const updateReady = (stopId: string, readyAt: number, witness?: ScheduledReadyWitness): void => {
    if (readyAt > window.horizonEndEpochSeconds) return;
    const current = earliestReadyByStop.get(stopId);
    if (current !== undefined && current <= readyAt) return;
    earliestReadyByStop.set(stopId, readyAt);
    if (readyWitnessByStop !== undefined && witness !== undefined) readyWitnessByStop.set(stopId, witness);
    enqueueForStop?.(stopId);
  };
  const updateArrivalMinimum = (stationAreaId: string, arrivalEpochSeconds: number): void => {
    if (arrivalEpochSeconds <= window.horizonEndEpochSeconds) updateMinimum(earliestArrivalByArea, stationAreaId, arrivalEpochSeconds);
  };

  for (let seedIndex = 0; seedIndex < accessSeeds.length; seedIndex += 1) {
    const seed = accessSeeds[seedIndex];
    if (seed === undefined) continue;
    resolvedOptions.deadlineCheck?.("routing-scan");
    const area = stationById.get(seed.stationAreaId);
    if (area === undefined) throw new RangeError(`Access seed references unknown station area ${seed.stationAreaId}.`);
    validateWholeNonNegative(seed.accessSeconds, "Access seed accessSeconds");
    if (seed.accessSeconds > ROUTING_HORIZON_SECONDS) throw new RangeError("Access seed accessSeconds must not exceed the 24-hour routing horizon.");
    const stationArrival = window.searchStartEpochSeconds + seed.accessSeconds;
    updateArrivalMinimum(area.id, stationArrival);
    const stopIds = seed.boardingStopId === undefined ? area.boardingStopIds : [seed.boardingStopId];
    if (seed.boardingStopId !== undefined && !area.boardingStopIds.includes(seed.boardingStopId)) {
      throw new RangeError(`Access seed references boarding stop ${seed.boardingStopId} outside station area ${area.id}.`);
    }
    for (const stopId of stopIds) {
      const stop = stopById.get(stopId);
      if (stop === undefined) throw new Error("Station area references a missing boarding stop.");
      const accessCoordinate = area.coordinate;
      const accessWalkSeconds = seed.boardingStopId === undefined
        ? walkingSeconds(accessCoordinate, stop.coordinate, resolvedOptions.walkingVelocityMetersPerSecond)
        : 0;
      updateReady(stop.id, stationArrival + accessWalkSeconds, captureWitness ? { kind: "origin", seed, seedIndex } : undefined);
    }
  }

  // Linear CSA with a bounded fixpoint for one departure-time bucket. This is
  // the shared scan used by both the surface and the selected-stop witness.
  let bucketStart = 0;
  while (bucketStart < window.connections.length) {
    resolvedOptions.deadlineCheck?.("routing-scan");
    const firstConnection = window.connections[bucketStart];
    if (firstConnection === undefined) break;
    const departureEpochSeconds = firstConnection.departureEpochSeconds;
    let bucketEnd = bucketStart + 1;
    while (bucketEnd < window.connections.length && window.connections[bucketEnd]?.departureEpochSeconds === departureEpochSeconds) bucketEnd += 1;
    const byFromStop = new Map<string, ScheduledMaterializedConnection[]>();
    for (let index = bucketStart; index < bucketEnd; index += 1) {
      if ((index - bucketStart) % ROUTING_CONNECTION_CHECKPOINT === 0) resolvedOptions.deadlineCheck?.("routing-scan");
      const connection = window.connections[index];
      if (connection === undefined) continue;
      const current = byFromStop.get(connection.source.fromStopId) ?? [];
      current.push(connection);
      byFromStop.set(connection.source.fromStopId, current);
    }
    const queued = new Set<string>();
    const processed = new Set<string>();
    const queue: ScheduledMaterializedConnection[] = [];
    const enqueueConnection = (connection: ScheduledMaterializedConnection): void => {
      if (queued.has(connection.connectionKey) || processed.has(connection.connectionKey)) return;
      const previousReachable = connection.previousContinuationKey !== null && reachableConnectionKeys.has(connection.previousContinuationKey);
      const readyAt = earliestReadyByStop.get(connection.source.fromStopId);
      const canBoard = connection.source.pickupType === 0 && readyAt !== undefined && readyAt <= departureEpochSeconds;
      if (!canBoard && !previousReachable) return;
      queued.add(connection.connectionKey);
      queue.push(connection);
    };
    enqueueForStop = (stopId) => {
      for (const connection of byFromStop.get(stopId) ?? []) enqueueConnection(connection);
    };
    for (let index = bucketStart; index < bucketEnd; index += 1) {
      if ((index - bucketStart) % ROUTING_CONNECTION_CHECKPOINT === 0) resolvedOptions.deadlineCheck?.("routing-scan");
      const connection = window.connections[index];
      if (connection !== undefined) enqueueConnection(connection);
    }
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      if (queueIndex % ROUTING_CONNECTION_CHECKPOINT === 0) resolvedOptions.deadlineCheck?.("routing-scan");
      const connection = queue[queueIndex];
      if (connection === undefined || processed.has(connection.connectionKey)) continue;
      processed.add(connection.connectionKey);
      reachableConnectionKeys.add(connection.connectionKey);
      if (connectionWitnessByKey !== undefined) {
        connectionWitnessByKey.set(connection.connectionKey, { connection, previousKey: connection.previousContinuationKey !== null && reachableConnectionKeys.has(connection.previousContinuationKey) ? connection.previousContinuationKey : null });
      }
      const nextConnection = continuationByPreviousKey.get(connection.connectionKey);
      if (nextConnection !== undefined && nextConnection.departureEpochSeconds === departureEpochSeconds) enqueueConnection(nextConnection);
      if (connection.source.dropOffType !== 0) continue;

      updateArrivalMinimum(connection.source.toStationAreaId, connection.arrivalEpochSeconds);
      const arrivalStop = stopById.get(connection.source.toStopId);
      if (arrivalStop === undefined) throw new Error("Connection references a missing arrival stop.");
      for (const transferStop of querySpatialIndex(window.spatialIndex, arrivalStop.coordinate, resolvedOptions.transferRadiusMeters)) {
        const transferReady = connection.arrivalEpochSeconds + walkingSeconds(arrivalStop.coordinate, transferStop.coordinate, resolvedOptions.walkingVelocityMetersPerSecond);
        updateArrivalMinimum(transferStop.stationAreaId, transferReady);
        updateReady(transferStop.id, transferReady, captureWitness ? { kind: "transfer", connectionKey: connection.connectionKey, fromStopId: arrivalStop.id } : undefined);
      }
    }
    enqueueForStop = null;
    bucketStart = bucketEnd;
  }
  return { earliestReadyByStop, earliestArrivalByArea, readyWitnessByStop, connectionWitnessByKey, window, parsedStartEpochSeconds: window.searchStartEpochSeconds };
}

/**
 * Deterministically reconstruct only the selected boarding stop's earliest
 * canonical route. It intentionally shares the exact CSA scan used by the
 * meeting surface and never traverses the full station-area result set.
 */
export function routeScheduledSelectedBoardingStop(
  schedule: ScheduledRoutingArtifact,
  canonicalAccessSeeds: readonly ScheduledAccessSeed[],
  selectedBoardingStopId: string,
  searchStartAt: string,
  options: ScheduledSelectedBoardingStopOptions = {},
  suppliedWindow?: ScheduledRoutingWindow,
  evidenceCandidates: readonly ScheduledAccessSeedCandidate[] = [],
): ScheduledSelectedBoardingStopRoute | null {
  const window = suppliedWindow ?? createScheduledRoutingWindow(schedule, searchStartAt, options);
  if (window.schedule !== schedule) throw new RangeError("A routing window belongs to a different schedule artifact.");
  const parsedStart = parseOffsetInstant(searchStartAt, schedule.timeZone);
  if (parsedStart.epochSeconds !== window.searchStartEpochSeconds) throw new RangeError("A routing window belongs to a different search start.");
  const selectedStop = schedule.boardingStops.find((stop) => stop.id === selectedBoardingStopId);
  if (selectedStop === undefined) throw new RangeError(`Selected boarding stop ${selectedBoardingStopId} is not in the schedule artifact.`);
  const scan = scanScheduledConnections(schedule, canonicalAccessSeeds, window, options, true);
  const readyWitnessByStop = scan.readyWitnessByStop;
  const connectionWitnessByKey = scan.connectionWitnessByKey;
  if (readyWitnessByStop === undefined || connectionWitnessByKey === undefined) throw new Error("Selected route witness capture was not enabled.");
  const readyEpochSeconds = scan.earliestReadyByStop.get(selectedBoardingStopId);
  const witness = readyWitnessByStop.get(selectedBoardingStopId);
  if (readyEpochSeconds === undefined || witness === undefined) return null;
  const totalSeconds = readyEpochSeconds - scan.parsedStartEpochSeconds;
  const segments: ScheduledSelectedRouteSegment[] = [];
  const visitedConnections = new Set<string>();
  const appendReady = (stopId: string): void => {
    const readyWitness = readyWitnessByStop.get(stopId);
    if (readyWitness === undefined) throw new Error(`Selected route lost boarding-stop witness ${stopId}.`);
    if (readyWitness.kind === "origin") {
      const seed = readyWitness.seed;
      if (seed === undefined) throw new Error("Selected route lost origin seed witness.");
      const area = schedule.stationAreas.find((candidate) => candidate.id === seed.stationAreaId);
      const stop = schedule.boardingStops.find((candidate) => candidate.id === stopId);
      if (area === undefined || stop === undefined) throw new Error("Selected route references a missing station area or stop.");
      const isExactStopSeed = seed.boardingStopId !== undefined;
      const candidate = readyWitness.seedIndex === undefined ? undefined : evidenceCandidates[readyWitness.seedIndex];
      const hasResolvedCoordinate = candidate !== undefined;
      const accessTargetCoordinate = hasResolvedCoordinate ? candidate.coordinate : isExactStopSeed ? stop.coordinate : area.coordinate;
      const originCoordinate = options.origin ?? accessTargetCoordinate;
      const origin = { latitude: originCoordinate.latitude, longitude: originCoordinate.longitude };
      appendWalk(segments, "origin-access", seed.accessSeconds, haversineDistanceMeters(origin, accessTargetCoordinate), origin, accessTargetCoordinate, scan.parsedStartEpochSeconds);
      let currentEpoch = scan.parsedStartEpochSeconds + seed.accessSeconds;
      if (hasResolvedCoordinate) {
        if (isExactStopSeed) appendIdentityResolution(segments, accessTargetCoordinate, routeStop(schedule, stop.id), stop.coordinate, "boarding-stop", currentEpoch);
        else appendIdentityResolution(segments, accessTargetCoordinate, routeStationArea(schedule, area.id), area.coordinate, "station-area", currentEpoch);
      }
      if (!isExactStopSeed) {
        const areaToStopSeconds = walkingSeconds(area.coordinate, stop.coordinate, window.walkingVelocityMetersPerSecond);
        appendWalk(segments, "station-area-access", areaToStopSeconds, haversineDistanceMeters(area.coordinate, stop.coordinate), area.coordinate, stop.coordinate, currentEpoch);
        currentEpoch += areaToStopSeconds;
      }
      if (currentEpoch !== scan.earliestReadyByStop.get(stopId)) throw new Error("Selected route origin witness does not reconcile its boarding readiness.");
      return;
    }
    const connectionKey = readyWitness.connectionKey;
    const fromStopId = readyWitness.fromStopId;
    if (connectionKey === undefined || fromStopId === undefined) throw new Error("Selected route lost transfer witness.");
    appendConnection(connectionKey);
    const fromStop = schedule.boardingStops.find((candidate) => candidate.id === fromStopId);
    const toStop = schedule.boardingStops.find((candidate) => candidate.id === stopId);
    if (fromStop === undefined || toStop === undefined) throw new Error("Selected route transfer references a missing stop.");
    const currentEpoch = epochAtEnd(segments, scan.parsedStartEpochSeconds);
    const transferSeconds = walkingSeconds(fromStop.coordinate, toStop.coordinate, window.walkingVelocityMetersPerSecond);
    if (fromStop.id !== toStop.id) appendWalk(segments, "transfer", transferSeconds, haversineDistanceMeters(fromStop.coordinate, toStop.coordinate), fromStop.coordinate, toStop.coordinate, currentEpoch);
  };
  const appendConnection = (connectionKey: string): void => {
    if (visitedConnections.has(connectionKey)) throw new Error("Selected route witness contains a connection cycle.");
    visitedConnections.add(connectionKey);
    const connectionWitness = connectionWitnessByKey.get(connectionKey);
    if (connectionWitness === undefined) throw new Error(`Selected route lost connection witness ${connectionKey}.`);
    const connection = connectionWitness.connection;
    if (connectionWitness.previousKey !== null) appendConnection(connectionWitness.previousKey);
    else appendReady(connection.source.fromStopId);
    const currentEpoch = epochAtEnd(segments, scan.parsedStartEpochSeconds);
    if (currentEpoch > connection.departureEpochSeconds) throw new Error("Selected route witness boards after departure.");
    if (currentEpoch < connection.departureEpochSeconds && connectionWitness.previousKey === null) {
      const at = routeStop(schedule, connection.source.fromStopId);
      appendWait(segments, connection.departureEpochSeconds - currentEpoch, at, currentEpoch);
    }
    const from = routeStop(schedule, connection.source.fromStopId);
    const to = routeStop(schedule, connection.source.toStopId);
    appendTransit(segments, schedule, connection, from, to);
  };
  appendReady(selectedBoardingStopId);
  const compactedSegments = mergeContiguousTransitSegments(segments);
  const computedTotal = epochAtEnd(compactedSegments, scan.parsedStartEpochSeconds) - scan.parsedStartEpochSeconds;
  if (computedTotal !== totalSeconds) throw new Error("Selected route witness does not reconcile cached boarding-stop readiness.");
  return Object.freeze({
    boardingStopId: selectedStop.id,
    stationAreaId: selectedStop.stationAreaId,
    totalSeconds,
    arrivalAt: formatEpochSeconds(scan.parsedStartEpochSeconds + totalSeconds),
    segments: Object.freeze(compactedSegments),
  });
}

function appendWalk(
  segments: ScheduledSelectedRouteSegment[],
  purpose: "origin-access" | "station-area-access" | "transfer",
  durationSeconds: number,
  distanceMeters: number,
  from: ScheduledSelectedRouteCoordinate,
  to: ScheduledSelectedRouteCoordinate,
  startEpochSeconds: number,
): void {
  segments.push({
    kind: "walk",
    purpose,
    durationSeconds,
    distanceMeters,
    from,
    to,
    estimate: "geometric-estimate-not-directions/v1",
    startAt: formatEpochSeconds(startEpochSeconds),
    endAt: formatEpochSeconds(startEpochSeconds + durationSeconds),
  });
}

function appendWait(
  segments: ScheduledSelectedRouteSegment[],
  durationSeconds: number,
  at: ScheduledSelectedRouteStop,
  startEpochSeconds: number,
): void {
  segments.push({
    kind: "wait",
    durationSeconds,
    at,
    startAt: formatEpochSeconds(startEpochSeconds),
    endAt: formatEpochSeconds(startEpochSeconds + durationSeconds),
  });
}

function appendTransit(
  segments: ScheduledSelectedRouteSegment[],
  schedule: ScheduledRoutingArtifact,
  connection: ScheduledMaterializedConnection,
  from: ScheduledSelectedRouteStop,
  to: ScheduledSelectedRouteStop,
): void {
  const trip = connection.source;
  const tripHeadsign = schedule.trips.find((trip) => trip.tripId === connection.source.tripId)?.headsign;
  const headsign = tripHeadsign?.trim() || connection.source.line.longName || connection.source.line.shortName || connection.source.tripId;
  segments.push({
    kind: "transit",
    durationSeconds: connection.arrivalEpochSeconds - connection.departureEpochSeconds,
    startAt: formatEpochSeconds(connection.departureEpochSeconds),
    endAt: formatEpochSeconds(connection.arrivalEpochSeconds),
    source: "mvv-gtfs",
    serviceDate: connection.serviceDate,
    serviceId: trip.serviceId,
    tripId: trip.tripId,
    line: trip.line.shortName || trip.line.routeId,
    headsign,
    from,
    to,
  });
}

function appendIdentityResolution(
  segments: ScheduledSelectedRouteSegment[],
  from: ScheduledSelectedRouteCoordinate,
  to: ScheduledSelectedRouteStationArea | ScheduledSelectedRouteStop,
  toCoordinate: ScheduledSelectedRouteCoordinate,
  target: "station-area" | "boarding-stop",
  epochSeconds: number,
): void {
  segments.push({
    kind: "identity-resolution",
    purpose: "station-access",
    durationSeconds: 0,
    startAt: formatEpochSeconds(epochSeconds),
    endAt: formatEpochSeconds(epochSeconds),
    source: "mvg-nearby-to-mvv-gtfs-identity/v1",
    target,
    from,
    to,
    toCoordinate,
  });
}

function routeStationArea(schedule: ScheduledRoutingArtifact, stationAreaId: string): ScheduledSelectedRouteStationArea {
  const area = schedule.stationAreas.find((candidate) => candidate.id === stationAreaId);
  if (area === undefined) throw new Error(`Selected route references missing station area ${stationAreaId}.`);
  return { stationAreaId: area.id, name: area.name };
}

function routeStop(schedule: ScheduledRoutingArtifact, stopId: string): ScheduledSelectedRouteStop {
  const stop = schedule.boardingStops.find((candidate) => candidate.id === stopId);
  if (stop === undefined) throw new Error(`Selected route references missing stop ${stopId}.`);
  return { boardingStopId: stop.id, stationAreaId: stop.stationAreaId, name: stop.name };
}

function epochAtEnd(segments: readonly ScheduledSelectedRouteSegment[], fallbackEpochSeconds: number): number {
  const last = segments[segments.length - 1];
  return last === undefined ? fallbackEpochSeconds : Date.parse(last.endAt) / 1_000;
}

function mergeContiguousTransitSegments(
  segments: readonly ScheduledSelectedRouteSegment[],
): ScheduledSelectedRouteSegment[] {
  const result: ScheduledSelectedRouteSegment[] = [];
  for (const segment of segments) {
    const previous = result[result.length - 1];
    if (previous?.kind === "transit" && segment.kind === "transit" &&
      previous.serviceDate === segment.serviceDate && previous.tripId === segment.tripId &&
      Date.parse(previous.endAt) <= Date.parse(segment.startAt)) {
      result[result.length - 1] = {
        ...previous,
        durationSeconds: (Date.parse(segment.endAt) - Date.parse(previous.startAt)) / 1_000,
        endAt: segment.endAt,
        to: segment.to,
      };
    } else {
      result.push(segment);
    }
  }
  return result;
}

const routingWindowCache = new Map<string, ScheduledRoutingWindow>();
const MAX_CACHED_ROUTING_WINDOWS = 4;

export function clearScheduledRoutingWindowCache(): void {
  routingWindowCache.clear();
}

export function createScheduledRoutingWindow(
  schedule: ScheduledRoutingArtifact,
  searchStartAt: string,
  options: ScheduledRoutingOptions = {},
  instrumentation: ScheduledRoutingWindowInstrumentation = {},
): ScheduledRoutingWindow {
  const resolvedOptions: ResolvedRoutingOptions = {
    walkingVelocityMetersPerSecond: options.walkingVelocityMetersPerSecond ?? DEFAULT_WALKING_VELOCITY_METERS_PER_SECOND,
    transferRadiusMeters: options.transferRadiusMeters ?? DEFAULT_TRANSFER_RADIUS_METERS,
    deadlineCheck: options.deadlineCheck,
  };
  validateRoutingOptions(resolvedOptions);
  resolvedOptions.deadlineCheck?.("routing-window");
  const parsedStart = parseOffsetInstant(searchStartAt, schedule.timeZone);
  validateScheduledSearchWindow(schedule, parsedStart.epochSeconds);
  const horizonEndEpochSeconds = parsedStart.epochSeconds + ROUTING_HORIZON_SECONDS;
  const isCacheable = !instrumentation.onCandidateServiceDate && !instrumentation.serviceDateAnchor;
  const cacheKey = `${schedule.provenance.compiledArtifactId}:${parsedStart.canonicalAt}:${resolvedOptions.walkingVelocityMetersPerSecond}:${resolvedOptions.transferRadiusMeters}`;
  if (isCacheable) {
    const cached = routingWindowCache.get(cacheKey);
    if (cached !== undefined && cached.schedule === schedule) {
      resolvedOptions.deadlineCheck?.("routing-window");
      return cached;
    }
  }
  const connections = materializeConnections(schedule, parsedStart.epochSeconds, horizonEndEpochSeconds, instrumentation, resolvedOptions.deadlineCheck);
  resolvedOptions.deadlineCheck?.("routing-window");
  const spatialIndex = buildSpatialIndex(schedule.boardingStops, resolvedOptions.transferRadiusMeters);
  resolvedOptions.deadlineCheck?.("routing-window");
  const window: ScheduledRoutingWindow = Object.freeze({
    schedule,
    searchStartAt: parsedStart.canonicalAt,
    searchStartEpochSeconds: parsedStart.epochSeconds,
    horizonEndEpochSeconds,
    walkingVelocityMetersPerSecond: resolvedOptions.walkingVelocityMetersPerSecond,
    transferRadiusMeters: resolvedOptions.transferRadiusMeters,
    connections: Object.freeze(connections),
    spatialIndex,
    deadlineCheck: resolvedOptions.deadlineCheck,
  });
  if (isCacheable) {
    if (routingWindowCache.size >= MAX_CACHED_ROUTING_WINDOWS) {
      const firstKey = routingWindowCache.keys().next().value;
      if (firstKey !== undefined) routingWindowCache.delete(firstKey);
    }
    routingWindowCache.set(cacheKey, window);
  }
  return window;
}

export function validateScheduledSearchWindow(schedule: ScheduledRoutingArtifact, searchStartEpochSeconds: number): void {
  if (!Number.isSafeInteger(searchStartEpochSeconds)) throw new RangeError("searchStartAt must represent an exact whole second.");
  if (searchStartEpochSeconds < schedule.searchStartBounds.earliestEpochSeconds || searchStartEpochSeconds > schedule.searchStartBounds.latestEpochSeconds) {
    throw new RangeError("searchStartAt is outside the schedule's routable coverage bounds.");
  }
}

export function walkingSeconds(
  from: { readonly latitude: number; readonly longitude: number },
  to: { readonly latitude: number; readonly longitude: number },
  velocityMetersPerSecond: number,
): number {
  if (!Number.isFinite(velocityMetersPerSecond) || velocityMetersPerSecond <= 0) {
    throw new RangeError("Walking velocity must be a positive finite number.");
  }
  const distanceMeters = haversineDistanceMeters(from, to);
  return distanceMeters === 0 ? 0 : Math.ceil(distanceMeters / velocityMetersPerSecond);
}

export function isScheduledToleranceSatisfied(
  firstElapsedSeconds: number,
  secondElapsedSeconds: number,
  tolerancePercent: number,
): boolean {
  validateTolerance(tolerancePercent);
  if (!Number.isInteger(firstElapsedSeconds) || !Number.isInteger(secondElapsedSeconds) || firstElapsedSeconds < 0 || secondElapsedSeconds < 0) {
    throw new RangeError("Travel times must be non-negative integer seconds.");
  }
  const difference = Math.abs(firstElapsedSeconds - secondElapsedSeconds);
  const sum = firstElapsedSeconds + secondElapsedSeconds;
  // Equivalent to both times being within ±tolerance of their integer-safe
  // two-point median. Multiplication avoids floating-point boundary drift.
  return difference * 100 <= sum * tolerancePercent;
}

function materializeConnections(
  schedule: ScheduledRoutingArtifact,
  searchStartEpochSeconds: number,
  horizonEndEpochSeconds: number,
  instrumentation: ScheduledRoutingWindowInstrumentation,
  deadlineCheck?: ScheduledDeadlineCheck,
): ScheduledMaterializedConnection[] {
  deadlineCheck?.("routing-window");
  const [firstCandidateDate, lastCandidateDate] = serviceDateRangeForSearch(searchStartEpochSeconds, schedule.timeZone, schedule.maximumServiceDayTimeSeconds);
  const streams: ScheduledConnectionDateStream[] = [];
  let serviceDate = firstCandidateDate;
  while (serviceDate <= lastCandidateDate) {
    deadlineCheck?.("routing-window");
    instrumentation.onCandidateServiceDate?.(serviceDate);
    const activeServiceIds = activeServiceIdsForDate(schedule, serviceDate);
    const anchorEpochSeconds = (instrumentation.serviceDateAnchor ?? serviceDateAnchorEpochSeconds)(serviceDate, schedule.timeZone);
    if (activeServiceIds.size > 0) {
      streams.push(createScheduledConnectionDateStream(schedule.connections, serviceDate, anchorEpochSeconds, activeServiceIds, searchStartEpochSeconds, horizonEndEpochSeconds, deadlineCheck));
    }
    serviceDate = addServiceDays(serviceDate, 1);
  }
  const heap = new ScheduledConnectionMinHeap();
  streams.forEach((stream, streamIndex) => {
    deadlineCheck?.("routing-window");
    const connection = stream.next();
    if (connection !== null) heap.push({ connection, stream, streamIndex });
  });
  const results: ScheduledMaterializedConnection[] = [];
  let mergedConnections = 0;
  while (heap.size > 0) {
    if (mergedConnections % ROUTING_CONNECTION_CHECKPOINT === 0) deadlineCheck?.("routing-window");
    const entry = heap.pop();
    if (entry === null) break;
    results.push(entry.connection);
    mergedConnections += 1;
    const next = entry.stream.next();
    if (next !== null) heap.push({ connection: next, stream: entry.stream, streamIndex: entry.streamIndex });
  }
  return results;
}

interface ScheduledConnectionDateStream {
  readonly next: () => ScheduledMaterializedConnection | null;
}

function createScheduledConnectionDateStream(
  connections: readonly ScheduledConnection[],
  serviceDate: string,
  anchorEpochSeconds: number,
  activeServiceIds: ReadonlySet<string>,
  searchStartEpochSeconds: number,
  horizonEndEpochSeconds: number,
  deadlineCheck?: ScheduledDeadlineCheck,
): ScheduledConnectionDateStream {
  const firstServiceDaySecond = Math.max(0, searchStartEpochSeconds - anchorEpochSeconds);
  const lastServiceDaySecond = horizonEndEpochSeconds - anchorEpochSeconds;
  let connectionIndex = firstConnectionIndexAtOrAfter(connections, firstServiceDaySecond);
  const endConnectionIndex = lastServiceDaySecond < 0 ? connectionIndex : firstConnectionIndexAfter(connections, lastServiceDaySecond);
  const previousByTrip = new Map<string, ScheduledConnection>();
  const includedKeys = new Set<string>();
  let scannedConnections = 0;

  return {
    next: () => {
      while (connectionIndex < endConnectionIndex) {
        if (scannedConnections % ROUTING_CONNECTION_CHECKPOINT === 0) deadlineCheck?.("routing-window");
        const source = connections[connectionIndex];
        connectionIndex += 1;
        scannedConnections += 1;
        if (source === undefined || !activeServiceIds.has(source.serviceId)) continue;
        const departureEpochSeconds = anchorEpochSeconds + source.departureTimeSeconds;
        const arrivalEpochSeconds = anchorEpochSeconds + source.arrivalTimeSeconds;
        const connectionKey = `${serviceDate}:${source.tripId}:${source.fromStopSequence}`;
        const previous = previousByTrip.get(source.tripId);
        const previousKey = previous === undefined ? null : `${serviceDate}:${previous.tripId}:${previous.fromStopSequence}`;
        previousByTrip.set(source.tripId, source);
        if (departureEpochSeconds < searchStartEpochSeconds || departureEpochSeconds > horizonEndEpochSeconds || arrivalEpochSeconds > horizonEndEpochSeconds) continue;
        const materialized: ScheduledMaterializedConnection = {
          instanceId: connectionKey,
          serviceDate,
          source,
          departureEpochSeconds,
          arrivalEpochSeconds,
          connectionKey,
          previousContinuationKey: previousKey !== null && includedKeys.has(previousKey) ? previousKey : null,
        };
        includedKeys.add(connectionKey);
        return materialized;
      }
      return null;
    },
  };
}

function firstConnectionIndexAtOrAfter(connections: readonly ScheduledConnection[], departureTimeSeconds: number): number {
  let low = 0;
  let high = connections.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const connection = connections[middle];
    if (connection === undefined || connection.departureTimeSeconds >= departureTimeSeconds) high = middle;
    else low = middle + 1;
  }
  return low;
}

function firstConnectionIndexAfter(connections: readonly ScheduledConnection[], departureTimeSeconds: number): number {
  let low = 0;
  let high = connections.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const connection = connections[middle];
    if (connection === undefined || connection.departureTimeSeconds > departureTimeSeconds) high = middle;
    else low = middle + 1;
  }
  return low;
}

interface ScheduledConnectionHeapEntry {
  readonly connection: ScheduledMaterializedConnection;
  readonly stream: ScheduledConnectionDateStream;
  readonly streamIndex: number;
}

class ScheduledConnectionMinHeap {
  private readonly entries: ScheduledConnectionHeapEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  push(entry: ScheduledConnectionHeapEntry): void {
    this.entries.push(entry);
    let index = this.entries.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareHeapEntries(this.entries[parent]!, this.entries[index]!) <= 0) break;
      [this.entries[parent], this.entries[index]] = [this.entries[index]!, this.entries[parent]!];
      index = parent;
    }
  }

  pop(): ScheduledConnectionHeapEntry | null {
    const first = this.entries[0];
    if (first === undefined) return null;
    const last = this.entries.pop();
    if (last !== undefined && this.entries.length > 0) {
      this.entries[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.entries.length && compareHeapEntries(this.entries[left]!, this.entries[smallest]!) < 0) smallest = left;
        if (right < this.entries.length && compareHeapEntries(this.entries[right]!, this.entries[smallest]!) < 0) smallest = right;
        if (smallest === index) break;
        [this.entries[index], this.entries[smallest]] = [this.entries[smallest]!, this.entries[index]!];
        index = smallest;
      }
    }
    return first;
  }
}

function compareHeapEntries(left: ScheduledConnectionHeapEntry, right: ScheduledConnectionHeapEntry): number {
  return compareMaterializedConnections(left.connection, right.connection) || left.streamIndex - right.streamIndex;
}

function activeServiceIdsForDate(schedule: ScheduledRoutingArtifact, serviceDate: string): Set<string> {
  const activeServiceIds = new Set<string>();
  if (serviceDate < schedule.serviceDateRange.firstDate || serviceDate > schedule.serviceDateRange.lastDate) return activeServiceIds;
  const day = new Date(`${serviceDate}T00:00:00Z`).getUTCDay();
  const weekdayIndex = day === 0 ? 6 : day - 1;
  for (const calendar of schedule.calendars) {
    if (serviceDate >= calendar.startDate && serviceDate <= calendar.endDate && calendar.weekdays[weekdayIndex] === true) activeServiceIds.add(calendar.serviceId);
  }
  for (const exception of schedule.exceptions) {
    if (exception.date !== serviceDate) continue;
    if (exception.exceptionType === 1) activeServiceIds.add(exception.serviceId);
    else activeServiceIds.delete(exception.serviceId);
  }
  return activeServiceIds;
}

function buildSpatialIndex(stops: readonly ScheduledBoardingStop[], radiusMeters: number): ScheduledSpatialIndex {
  const bucketSizeDegrees = Math.max(radiusMeters / 111_000, 0.00001);
  const buckets = new Map<string, string[]>();
  const stopMap = new Map<string, ScheduledBoardingStop>();
  for (const stop of stops) {
    stopMap.set(stop.id, stop);
    const key = bucketKey(stop.coordinate, bucketSizeDegrees);
    const current = buckets.get(key) ?? [];
    current.push(stop.id);
    buckets.set(key, current);
  }
  return { bucketSizeDegrees, buckets, stops: stopMap };
}

function querySpatialIndex(
  index: ScheduledSpatialIndex,
  coordinate: { readonly latitude: number; readonly longitude: number },
  radiusMeters: number,
): ScheduledBoardingStop[] {
  const latitudeRadius = radiusMeters / 111_000;
  const longitudeRadius = latitudeRadius / Math.max(Math.cos((coordinate.latitude * Math.PI) / 180), 0.1);
  const centerLatitudeBucket = Math.floor(coordinate.latitude / index.bucketSizeDegrees);
  const centerLongitudeBucket = Math.floor(coordinate.longitude / index.bucketSizeDegrees);
  const latitudeBuckets = Math.ceil(latitudeRadius / index.bucketSizeDegrees) + 1;
  const longitudeBuckets = Math.ceil(longitudeRadius / index.bucketSizeDegrees) + 1;
  const candidates: ScheduledBoardingStop[] = [];
  const seen = new Set<string>();
  for (let latitudeOffset = -latitudeBuckets; latitudeOffset <= latitudeBuckets; latitudeOffset += 1) {
    for (let longitudeOffset = -longitudeBuckets; longitudeOffset <= longitudeBuckets; longitudeOffset += 1) {
      const ids = index.buckets.get(`${centerLatitudeBucket + latitudeOffset}:${centerLongitudeBucket + longitudeOffset}`) ?? [];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const stop = index.stops.get(id);
        if (stop !== undefined && haversineDistanceMeters(coordinate, stop.coordinate) <= radiusMeters) candidates.push(stop);
      }
    }
  }
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}

function bucketKey(coordinate: { readonly latitude: number; readonly longitude: number }, bucketSizeDegrees: number): string {
  return `${Math.floor(coordinate.latitude / bucketSizeDegrees)}:${Math.floor(coordinate.longitude / bucketSizeDegrees)}`;
}

function compareMaterializedConnections(left: ScheduledMaterializedConnection, right: ScheduledMaterializedConnection): number {
  return left.departureEpochSeconds - right.departureEpochSeconds || compareScheduledConnections(left.source, right.source) || left.arrivalEpochSeconds - right.arrivalEpochSeconds || left.instanceId.localeCompare(right.instanceId);
}

function updateMinimum(values: Map<string, number>, key: string, epochSeconds: number): void {
  const current = values.get(key);
  if (current === undefined || epochSeconds < current) values.set(key, epochSeconds);
}

function validateRoutingOptions(options: ResolvedRoutingOptions): void {
  if (!Number.isFinite(options.walkingVelocityMetersPerSecond) || options.walkingVelocityMetersPerSecond <= 0) throw new RangeError("Walking velocity must be a positive finite number.");
  if (!Number.isFinite(options.transferRadiusMeters) || options.transferRadiusMeters <= 0) throw new RangeError("Transfer radius must be a positive finite number.");
}

function validateWholeNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer.`);
}

function validateTolerance(value: number): void {
  if (value !== 5 && value !== 10 && value !== 15) throw new RangeError("Selected tolerance must be 5, 10, or 15 percent.");
}

function formatEpochSeconds(epochSeconds: number): string {
  if (!Number.isSafeInteger(epochSeconds)) throw new RangeError("Scheduled arrival is outside the safe integer-second range.");
  return new Date(epochSeconds * 1_000).toISOString();
}

export function haversineDistanceMeters(
  first: { readonly latitude: number; readonly longitude: number },
  second: { readonly latitude: number; readonly longitude: number },
): number {
  const radiusMeters = 6_371_000;
  const latitudeDelta = ((second.latitude - first.latitude) * Math.PI) / 180;
  const longitudeDelta = ((second.longitude - first.longitude) * Math.PI) / 180;
  const firstLatitude = (first.latitude * Math.PI) / 180;
  const secondLatitude = (second.latitude * Math.PI) / 180;
  const haversine = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return radiusMeters * 2 * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

// Keep the exported model rule tied to the implementation so it cannot drift.
export const SCHEDULED_WALKING_SECONDS_ROUNDING_RULE = WALKING_SECONDS_ROUNDING_RULE;

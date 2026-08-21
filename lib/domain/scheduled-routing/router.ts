import "server-only";

import {
  CHANGE_TIME_PRESETS,
  ROUTING_HORIZON_SECONDS,
  TRANSFER_NEIGHBOR_RADIUS_METERS,
  WALKING_SECONDS_ROUNDING_RULE,
  type ScheduledAccessSeed,
  type ScheduledConnection,
  type ScheduledDeadlineCheck,
  type ScheduledRoutingArtifact,
  type ScheduledRoutingOptions,
  type ScheduledRoutingResult,
  type ScheduledStationArea,
  type StationArrivalField,
  type ItineraryEdge,
  type ItineraryConnectionRef,
} from "./models.ts";
import {
  compareScheduledConnections,
} from "./gtfs.ts";
import {
  buildAreaSpatialIndex as buildSpatialIndex,
  findAreasWithinRadius as querySpatialIndex,
  haversineDistanceMeters,
  type ScheduledSpatialIndex,
} from "./spatial.ts";

export { haversineDistanceMeters } from "./spatial.ts";
import {
  addServiceDays,
  ceilToWholeMinuteSeconds,
  parseSearchStartInstant,
  serviceDateAnchorEpochSeconds,
  serviceDateRangeForSearch,
} from "./time.ts";

export const DEFAULT_WALKING_VELOCITY_METERS_PER_SECOND = 1.4;
export const DEFAULT_TRANSFER_RADIUS_METERS = 250;
export const DEFAULT_CHANGE_TIME_SECONDS = CHANGE_TIME_PRESETS.medium;
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

interface ResolvedRoutingOptions {
  readonly walkingVelocityMetersPerSecond: number;
  readonly transferRadiusMeters: number;
  readonly changeTimeSeconds: number;
  readonly deadlineCheck?: ScheduledDeadlineCheck;
}

export interface ScheduledRoutingWindow {
  readonly schedule: ScheduledRoutingArtifact;
  readonly searchStartAt: string;
  readonly searchStartEpochSeconds: number;
  readonly horizonEndEpochSeconds: number;
  readonly walkingVelocityMetersPerSecond: number;
  readonly transferRadiusMeters: number;
  readonly changeTimeSeconds: number;
  readonly connections: readonly ScheduledMaterializedConnection[];
  /**
   * Geographic bucket index used only when the runtime `transferRadiusMeters`
   * exceeds the precomputed `TRANSFER_NEIGHBOR_RADIUS_METERS`. When present, the
   * scan falls back to a per-arrival spatial query; otherwise it uses the
   * precomputed transfer-neighbor lists (issue #76).
   */
  readonly spatialIndex?: ScheduledSpatialIndex;
  readonly deadlineCheck?: ScheduledDeadlineCheck;
}

export const SCHEDULED_DETAIL_SELECTION_POLICY = "earliest-arrival/canonical-scan-first/v1";

/** Narrow instrumentation seam for deterministic routing-window tests. */
export interface ScheduledRoutingWindowInstrumentation {
  readonly onCandidateServiceDate?: (serviceDate: string) => void;
  readonly serviceDateAnchor?: (serviceDate: string, timeZone: string) => number;
}

/**
 * Connection-scan routing with bounded local transfers. A transfer is emitted
 * only from a transit arrival and is queried through a geographic bucket index;
 * the algorithm never computes an area-to-area all-pairs closure. Transfers
 * operate on station areas: a same-area transfer costs the static change-time
 * preset, and a different-area transfer within the radius costs the
 * centroid-to-centroid walking time. No change time applies at the origin area
 * (the participant walks in fresh) or at the destination area (the meeting is
 * reached).
 */
export function routeScheduledEarliestArrivals(
  schedule: ScheduledRoutingArtifact,
  accessSeeds: readonly ScheduledAccessSeed[],
  searchStartAt: string,
  options: ScheduledRoutingOptions = {},
  suppliedWindow?: ScheduledRoutingWindow,
): ScheduledRoutingResult {
  const window = suppliedWindow ?? createScheduledRoutingWindow(schedule, searchStartAt, options);
  if (window.schedule !== schedule) throw new RangeError("A routing window belongs to a different schedule artifact.");
  const parsedStart = parseSearchStartInstant(searchStartAt, schedule.timeZone);
  if (parsedStart.epochSeconds !== window.searchStartEpochSeconds) throw new RangeError("A routing window belongs to a different search start.");
  const scan = scanScheduledConnections(schedule, accessSeeds, window, options);
  const stationArrivals: StationArrivalField[] = schedule.stationAreas.map((area) => {
    const epochSeconds = scan.earliestArrivalByArea.get(area.id);
    return {
      stationAreaId: area.id,
      arrivalEpochSeconds: epochSeconds === undefined ? null : epochSeconds,
      elapsedSeconds: epochSeconds === undefined ? null : epochSeconds - parsedStart.epochSeconds,
    };
  });
  return Object.freeze({
    stationArrivals: Object.freeze(stationArrivals),
    reachableStationAreaCount: stationArrivals.filter((arrival) => arrival.arrivalEpochSeconds !== null).length,
    searchStartAt: parsedStart.canonicalAt,
    searchStartEpochSeconds: parsedStart.epochSeconds,
    horizonEndEpochSeconds: window.horizonEndEpochSeconds,
    predecessorByArea: scan.predecessorByArea,
  });
}

/**
 * Runs both participant scans over the same read-only window, sharing the
 * participant-independent continuation map across them. This is shared
 * precomputation, not true thread parallelism: each participant still runs its
 * own independent BFS pass (so results are identical to two sequential scans),
 * but the expensive shared structures are built once instead of twice. Transfer
 * neighborhoods are already precomputed on the shared station-area objects (see
 * issue #76), so they are reused across both scans automatically. Worker
 * threads were rejected to respect the multi-hundred-MB artifact memory
 * envelope.
 */
export function scanScheduledConnectionsPair(
  schedule: ScheduledRoutingArtifact,
  accessSeedSets: readonly [readonly ScheduledAccessSeed[], readonly ScheduledAccessSeed[]],
  window: ScheduledRoutingWindow,
  options: ScheduledRoutingOptions = {},
): [ScheduledScanState, ScheduledScanState] {
  const graph = buildScheduledScanGraph(schedule, window, options.deadlineCheck ?? window.deadlineCheck);
  return [
    scanScheduledConnectionsForParticipant(schedule, accessSeedSets[0], window, options, graph),
    scanScheduledConnectionsForParticipant(schedule, accessSeedSets[1], window, options, graph),
  ];
}

export function routeScheduledEarliestArrivalsPair(
  schedule: ScheduledRoutingArtifact,
  accessSeedSets: readonly [readonly ScheduledAccessSeed[], readonly ScheduledAccessSeed[]],
  searchStartAt: string,
  options: ScheduledRoutingOptions = {},
  suppliedWindow?: ScheduledRoutingWindow,
): [ScheduledRoutingResult, ScheduledRoutingResult] {
  const window = suppliedWindow ?? createScheduledRoutingWindow(schedule, searchStartAt, options);
  if (window.schedule !== schedule) throw new RangeError("A routing window belongs to a different schedule artifact.");
  const parsedStart = parseSearchStartInstant(searchStartAt, schedule.timeZone);
  if (parsedStart.epochSeconds !== window.searchStartEpochSeconds) throw new RangeError("A routing window belongs to a different search start.");
  const scans = scanScheduledConnectionsPair(schedule, accessSeedSets, window, options);
  const toResult = (scan: ScheduledScanState): ScheduledRoutingResult => {
    const stationArrivals: StationArrivalField[] = schedule.stationAreas.map((area) => {
      const epochSeconds = scan.earliestArrivalByArea.get(area.id);
      return {
        stationAreaId: area.id,
        arrivalEpochSeconds: epochSeconds === undefined ? null : epochSeconds,
        elapsedSeconds: epochSeconds === undefined ? null : epochSeconds - parsedStart.epochSeconds,
      };
    });
    return Object.freeze({
      stationArrivals: Object.freeze(stationArrivals),
      reachableStationAreaCount: stationArrivals.filter((arrival) => arrival.arrivalEpochSeconds !== null).length,
      searchStartAt: parsedStart.canonicalAt,
      searchStartEpochSeconds: parsedStart.epochSeconds,
      horizonEndEpochSeconds: window.horizonEndEpochSeconds,
      predecessorByArea: scan.predecessorByArea,
    });
  };
  return [toResult(scans[0]), toResult(scans[1])];
}

interface ScheduledScanState {
  readonly earliestArrivalByArea: Map<string, number>;
  readonly window: ScheduledRoutingWindow;
  readonly parsedStartEpochSeconds: number;
  readonly predecessorByArea: Record<string, ItineraryEdge>;
}

interface ScheduledScanGraph {
  readonly stationById: Map<string, ScheduledStationArea>;
  readonly continuationByPreviousKey: Map<string, ScheduledMaterializedConnection>;
}

function buildScheduledScanGraph(
  schedule: ScheduledRoutingArtifact,
  window: ScheduledRoutingWindow,
  deadlineCheck?: ScheduledDeadlineCheck,
): ScheduledScanGraph {
  const stationById = new Map(schedule.stationAreas.map((area) => [area.id, area]));
  const continuationByPreviousKey = new Map<string, ScheduledMaterializedConnection>();
  for (let connectionIndex = 0; connectionIndex < window.connections.length; connectionIndex += 1) {
    if (connectionIndex % ROUTING_CONNECTION_CHECKPOINT === 0) deadlineCheck?.("routing-scan");
    const connection = window.connections[connectionIndex];
    if (connection === undefined) continue;
    if (connection.previousContinuationKey !== null) continuationByPreviousKey.set(connection.previousContinuationKey, connection);
  }
  return { stationById, continuationByPreviousKey };
}

function scanScheduledConnectionsForParticipant(
  schedule: ScheduledRoutingArtifact,
  accessSeeds: readonly ScheduledAccessSeed[],
  window: ScheduledRoutingWindow,
  options: ScheduledRoutingOptions,
  graph: ScheduledScanGraph,
): ScheduledScanState {
  const resolvedOptions: ResolvedRoutingOptions = {
    walkingVelocityMetersPerSecond: window.walkingVelocityMetersPerSecond,
    transferRadiusMeters: window.transferRadiusMeters,
    changeTimeSeconds: window.changeTimeSeconds,
    deadlineCheck: options.deadlineCheck ?? window.deadlineCheck,
  };
  resolvedOptions.deadlineCheck?.("routing-scan");
  const earliestArrivalByArea = new Map<string, number>();
  const earliestBoardingReadyByArea = new Map<string, number>();
  const reachableConnectionKeys = new Set<string>();
  const predecessorByArea: Record<string, ItineraryEdge> = {};
  const tripHeadsignById = new Map(schedule.trips.map((trip) => [trip.tripId, trip.headsign]));

  let enqueueForArea: ((areaId: string) => void) | null = null;
  const updateArrivalMinimum = (stationAreaId: string, arrivalEpochSeconds: number): boolean => {
    if (arrivalEpochSeconds > window.horizonEndEpochSeconds) return false;
    const current = earliestArrivalByArea.get(stationAreaId);
    if (current !== undefined && current <= arrivalEpochSeconds) return false;
    earliestArrivalByArea.set(stationAreaId, arrivalEpochSeconds);
    return true;
  };

  const updateBoardingReadyMinimum = (stationAreaId: string, readyEpochSeconds: number): void => {
    if (readyEpochSeconds > window.horizonEndEpochSeconds) return;
    const current = earliestBoardingReadyByArea.get(stationAreaId);
    if (current !== undefined && current <= readyEpochSeconds) return;
    earliestBoardingReadyByArea.set(stationAreaId, readyEpochSeconds);
    enqueueForArea?.(stationAreaId);
  };

  const emitTransfer = (
    transferArea: ScheduledStationArea,
    distanceMeters: number,
    arrivalArea: ScheduledStationArea,
    arrivalEpochSeconds: number,
  ): void => {
    if (transferArea.id === arrivalArea.id) {
      updateBoardingReadyMinimum(arrivalArea.id, arrivalEpochSeconds + resolvedOptions.changeTimeSeconds);
    } else {
      const walkArrival = arrivalEpochSeconds + walkingSecondsForDistance(distanceMeters, resolvedOptions.walkingVelocityMetersPerSecond);
      if (updateArrivalMinimum(transferArea.id, walkArrival)) predecessorByArea[transferArea.id] = { kind: "walk", fromAreaId: arrivalArea.id, arrivalEpochSeconds: walkArrival };
      updateBoardingReadyMinimum(transferArea.id, walkArrival);
    }
  };

  for (let seedIndex = 0; seedIndex < accessSeeds.length; seedIndex += 1) {
    const seed = accessSeeds[seedIndex];
    if (seed === undefined) continue;
    resolvedOptions.deadlineCheck?.("routing-scan");
    const area = graph.stationById.get(seed.stationAreaId);
    if (area === undefined) throw new RangeError(`Access seed references unknown station area ${seed.stationAreaId}.`);
    validateWholeNonNegative(seed.accessSeconds, "Access seed accessSeconds");
    if (seed.accessSeconds > ROUTING_HORIZON_SECONDS) throw new RangeError("Access seed accessSeconds must not exceed the 24-hour routing horizon.");
    if (seed.accessSeconds % 60 !== 0) throw new RangeError("Access seed accessSeconds must be minute-aligned.");
    const seedArrival = window.searchStartEpochSeconds + seed.accessSeconds;
    if (updateArrivalMinimum(area.id, seedArrival)) predecessorByArea[area.id] = { kind: "seed", seedAreaId: area.id, accessSeconds: seed.accessSeconds };
    updateBoardingReadyMinimum(area.id, seedArrival);
  }

  // Linear CSA with a bounded fixpoint for one departure-time bucket. This is
  // the shared scan used by the meeting surface.
  let bucketStart = 0;
  while (bucketStart < window.connections.length) {
    resolvedOptions.deadlineCheck?.("routing-scan");
    const firstConnection = window.connections[bucketStart];
    if (firstConnection === undefined) break;
    const departureEpochSeconds = firstConnection.departureEpochSeconds;
    let bucketEnd = bucketStart + 1;
    while (bucketEnd < window.connections.length && window.connections[bucketEnd]?.departureEpochSeconds === departureEpochSeconds) bucketEnd += 1;
    const byFromArea = new Map<string, ScheduledMaterializedConnection[]>();
    for (let index = bucketStart; index < bucketEnd; index += 1) {
      if ((index - bucketStart) % ROUTING_CONNECTION_CHECKPOINT === 0) resolvedOptions.deadlineCheck?.("routing-scan");
      const connection = window.connections[index];
      if (connection === undefined) continue;
      const current = byFromArea.get(connection.source.fromStationAreaId) ?? [];
      current.push(connection);
      byFromArea.set(connection.source.fromStationAreaId, current);
    }
    const queued = new Set<string>();
    const processed = new Set<string>();
    const queue: ScheduledMaterializedConnection[] = [];
    const enqueueConnection = (connection: ScheduledMaterializedConnection): void => {
      if (queued.has(connection.connectionKey) || processed.has(connection.connectionKey)) return;
      const previousReachable = connection.previousContinuationKey !== null && reachableConnectionKeys.has(connection.previousContinuationKey);
      const readyAt = earliestBoardingReadyByArea.get(connection.source.fromStationAreaId);
      const canBoard = connection.source.pickupType === 0 && readyAt !== undefined && readyAt <= departureEpochSeconds;
      if (!canBoard && !previousReachable) return;
      queued.add(connection.connectionKey);
      queue.push(connection);
    };
    enqueueForArea = (areaId) => {
      for (const connection of byFromArea.get(areaId) ?? []) enqueueConnection(connection);
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
      const nextConnection = graph.continuationByPreviousKey.get(connection.connectionKey);
      if (nextConnection !== undefined && nextConnection.departureEpochSeconds === departureEpochSeconds) enqueueConnection(nextConnection);
      if (connection.source.dropOffType !== 0) continue;

      if (updateArrivalMinimum(connection.source.toStationAreaId, connection.arrivalEpochSeconds)) predecessorByArea[connection.source.toStationAreaId] = { kind: "connection", connection: buildConnectionRef(connection, tripHeadsignById) };
      const arrivalArea = graph.stationById.get(connection.source.toStationAreaId);
      if (arrivalArea === undefined) throw new Error("Connection references a missing arrival station area.");
      if (window.spatialIndex !== undefined) {
        for (const transferArea of querySpatialIndex(window.spatialIndex, arrivalArea.coordinate, resolvedOptions.transferRadiusMeters)) {
          emitTransfer(transferArea, haversineDistanceMeters(arrivalArea.coordinate, transferArea.coordinate), arrivalArea, connection.arrivalEpochSeconds);
        }
      } else {
        for (const neighbor of arrivalArea.transferNeighbors) {
          if (neighbor.distanceMeters > resolvedOptions.transferRadiusMeters) continue;
          const transferArea = graph.stationById.get(neighbor.stationAreaId);
          if (transferArea === undefined) continue;
          emitTransfer(transferArea, neighbor.distanceMeters, arrivalArea, connection.arrivalEpochSeconds);
        }
      }
    }
    enqueueForArea = null;
    bucketStart = bucketEnd;
  }
  return { earliestArrivalByArea, window, parsedStartEpochSeconds: window.searchStartEpochSeconds, predecessorByArea };
}

function buildConnectionRef(
  connection: ScheduledMaterializedConnection,
  tripHeadsignById: ReadonlyMap<string, string>,
): ItineraryConnectionRef {
  return {
    fromStationAreaId: connection.source.fromStationAreaId,
    toStationAreaId: connection.source.toStationAreaId,
    departureEpochSeconds: connection.departureEpochSeconds,
    arrivalEpochSeconds: connection.arrivalEpochSeconds,
    tripId: connection.source.tripId,
    lineShortName: connection.source.line.shortName,
    routeType: connection.source.line.routeType,
    headsign: tripHeadsignById.get(connection.source.tripId) ?? "",
  };
}

function scanScheduledConnections(
  schedule: ScheduledRoutingArtifact,
  accessSeeds: readonly ScheduledAccessSeed[],
  window: ScheduledRoutingWindow,
  options: ScheduledRoutingOptions,
): ScheduledScanState {
  const graph = buildScheduledScanGraph(schedule, window, options.deadlineCheck ?? window.deadlineCheck);
  return scanScheduledConnectionsForParticipant(schedule, accessSeeds, window, options, graph);
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
    changeTimeSeconds: options.changeTimeSeconds ?? DEFAULT_CHANGE_TIME_SECONDS,
    deadlineCheck: options.deadlineCheck,
  };
  validateRoutingOptions(resolvedOptions);
  resolvedOptions.deadlineCheck?.("routing-window");
  const parsedStart = parseSearchStartInstant(searchStartAt, schedule.timeZone);
  validateScheduledSearchWindow(schedule, parsedStart.epochSeconds);
  const horizonEndEpochSeconds = parsedStart.epochSeconds + ROUTING_HORIZON_SECONDS;
  const isCacheable = !instrumentation.onCandidateServiceDate && !instrumentation.serviceDateAnchor;
  const cacheKey = `${schedule.provenance.compiledArtifactId}:${parsedStart.canonicalAt}:${resolvedOptions.walkingVelocityMetersPerSecond}:${resolvedOptions.transferRadiusMeters}:${resolvedOptions.changeTimeSeconds}`;
  if (isCacheable) {
    const cached = routingWindowCache.get(cacheKey);
    if (cached !== undefined && cached.schedule === schedule) {
      resolvedOptions.deadlineCheck?.("routing-window");
      return cached;
    }
  }
  const connections = materializeConnections(schedule, parsedStart.epochSeconds, horizonEndEpochSeconds, instrumentation, resolvedOptions.deadlineCheck);
  resolvedOptions.deadlineCheck?.("routing-window");
  // The precomputed transfer-neighbor lists cover up to TRANSFER_NEIGHBOR_RADIUS_METERS.
  // Only build the geographic index when the runtime radius exceeds that, so the
  // scan falls back to a per-arrival spatial query for larger radii (issue #76).
  const spatialIndex = resolvedOptions.transferRadiusMeters > TRANSFER_NEIGHBOR_RADIUS_METERS ? buildSpatialIndex(schedule.stationAreas, resolvedOptions.transferRadiusMeters) : undefined;
  resolvedOptions.deadlineCheck?.("routing-window");
  const window: ScheduledRoutingWindow = Object.freeze({
    schedule,
    searchStartAt: parsedStart.canonicalAt,
    searchStartEpochSeconds: parsedStart.epochSeconds,
    horizonEndEpochSeconds,
    walkingVelocityMetersPerSecond: resolvedOptions.walkingVelocityMetersPerSecond,
    transferRadiusMeters: resolvedOptions.transferRadiusMeters,
    changeTimeSeconds: resolvedOptions.changeTimeSeconds,
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
  if (!Number.isSafeInteger(searchStartEpochSeconds)) throw new RangeError("searchStartAt must represent an exact whole-minute-aligned second.");
  if (searchStartEpochSeconds < schedule.searchStartBounds.earliestEpochSeconds || searchStartEpochSeconds > schedule.searchStartBounds.latestEpochSeconds) {
    throw new RangeError("searchStartAt is outside the schedule's routable coverage bounds.");
  }
}

export function walkingSeconds(
  from: { readonly latitude: number; readonly longitude: number },
  to: { readonly latitude: number; readonly longitude: number },
  velocityMetersPerSecond: number,
): number {
  return walkingSecondsForDistance(haversineDistanceMeters(from, to), velocityMetersPerSecond);
}

/** Walk time for an already-known centroid distance, avoiding a haversine recomputation. */
export function walkingSecondsForDistance(distanceMeters: number, velocityMetersPerSecond: number): number {
  if (!Number.isFinite(velocityMetersPerSecond) || velocityMetersPerSecond <= 0) {
    throw new RangeError("Walking velocity must be a positive finite number.");
  }
  if (distanceMeters === 0) return 0;
  return ceilToWholeMinuteSeconds(distanceMeters / velocityMetersPerSecond);
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

// Module-level cache of service IDs active on a given date, keyed by
// `${compiledArtifactId}:${serviceDate}`. The returned `Set` is shared across
// all callers for that key and MUST be treated as read-only; never mutate it.
const serviceIdsByArtifactAndDate = new Map<string, Set<string>>();

function activeServiceIdsForDate(schedule: ScheduledRoutingArtifact, serviceDate: string): Set<string> {
  const cacheKey = `${schedule.provenance.compiledArtifactId}:${serviceDate}`;
  const cached = serviceIdsByArtifactAndDate.get(cacheKey);
  if (cached !== undefined) return cached;
  const activeServiceIds = new Set<string>();
  if (serviceDate < schedule.serviceDateRange.firstDate || serviceDate > schedule.serviceDateRange.lastDate) {
    serviceIdsByArtifactAndDate.set(cacheKey, activeServiceIds);
    return activeServiceIds;
  }
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
  serviceIdsByArtifactAndDate.set(cacheKey, activeServiceIds);
  return activeServiceIds;
}

function compareMaterializedConnections(left: ScheduledMaterializedConnection, right: ScheduledMaterializedConnection): number {
  return left.departureEpochSeconds - right.departureEpochSeconds || compareScheduledConnections(left.source, right.source) || left.arrivalEpochSeconds - right.arrivalEpochSeconds || left.instanceId.localeCompare(right.instanceId);
}

function validateRoutingOptions(options: ResolvedRoutingOptions): void {
  if (!Number.isFinite(options.walkingVelocityMetersPerSecond) || options.walkingVelocityMetersPerSecond <= 0) throw new RangeError("Walking velocity must be a positive finite number.");
  if (!Number.isFinite(options.transferRadiusMeters) || options.transferRadiusMeters <= 0) throw new RangeError("Transfer radius must be a positive finite number.");
  if (options.changeTimeSeconds !== CHANGE_TIME_PRESETS.quick && options.changeTimeSeconds !== CHANGE_TIME_PRESETS.medium && options.changeTimeSeconds !== CHANGE_TIME_PRESETS.long) throw new RangeError("Change time must be one of the scheduled change-time presets (180, 300, or 600 seconds).");
}

function validateWholeNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer.`);
}

function validateTolerance(value: number): void {
  if (value !== 5 && value !== 10 && value !== 15) throw new RangeError("Selected tolerance must be 5, 10, or 15 percent.");
}

// Keep the exported model rule tied to the implementation so it cannot drift.
export const SCHEDULED_WALKING_SECONDS_ROUNDING_RULE = WALKING_SECONDS_ROUNDING_RULE;

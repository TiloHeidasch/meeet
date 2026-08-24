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
  /** Number of connections in the canonical scan window. The compact row data is private. */
  readonly connectionCount: number;
  /** Byte size of the private compact connection table retained by this window. */
  readonly compactTableByteLength: number;
  /**
   * Geographic bucket index used only when the runtime `transferRadiusMeters`
   * exceeds the precomputed `TRANSFER_NEIGHBOR_RADIUS_METERS`. When present, the
   * scan falls back to a per-arrival spatial query; otherwise it uses the
   * precomputed transfer-neighbor lists (issue #76).
   */
  readonly spatialIndex?: ScheduledSpatialIndex;
}

export const SCHEDULED_DETAIL_SELECTION_POLICY = "earliest-arrival/canonical-scan-first/v1";

/**
 * The compact-table projection is intentionally available only through the
 * opt-in instrumentation argument. Normal routing windows retain no
 * per-connection objects or service-date strings.
 */
export interface ScheduledRoutingMaterializedConnection {
  readonly source: ScheduledConnection;
  readonly serviceDate: string;
  readonly departureEpochSeconds: number;
  readonly arrivalEpochSeconds: number;
  readonly predecessorRowIndex: number | null;
  readonly continuationRowIndex: number | null;
}

/** Narrow instrumentation seam for deterministic routing-window tests. */
export interface ScheduledRoutingWindowInstrumentation {
  readonly onCandidateServiceDate?: (serviceDate: string) => void;
  readonly serviceDateAnchor?: (serviceDate: string, timeZone: string) => number;
  /** Test-only projection; no compact typed-array storage is exposed. */
  readonly onMaterializedConnection?: (connection: ScheduledRoutingMaterializedConnection) => void;
  /** Sparse primitive-only materialization progress; no row projection is created. */
  readonly onMaterializationCheckpoint?: (materializedConnectionCount: number) => void;
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
 * participant-independent compact connection table across them. This is shared
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
  const deadlineCheck = options.deadlineCheck ?? deadlineCheckByWindow.get(window);
  const graph = buildScheduledScanGraph(schedule, window, deadlineCheck);
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
  readonly connectionTable: ScheduledConnectionTable;
}

/**
 * The materialized scan window deliberately has no object-per-connection
 * representation. A row is four numbers: the source template index, the two
 * minute offsets from the canonical search start, and a forward continuation
 * row (+1, with zero as the sentinel). This stays private so callers cannot
 * accidentally retain or mutate the routing scratch representation.
 */
interface ScheduledConnectionTable {
  readonly sourceConnectionIndex: Uint32Array;
  readonly departureMinuteOffset: Uint32Array;
  readonly arrivalMinuteOffset: Uint32Array;
  readonly continuationRowPlusOne: Uint32Array;
  readonly byteLength: number;
}

const connectionTableByWindow = new WeakMap<ScheduledRoutingWindow, ScheduledConnectionTable>();
const deadlineCheckByWindow = new WeakMap<ScheduledRoutingWindow, ScheduledDeadlineCheck>();

function buildScheduledScanGraph(
  schedule: ScheduledRoutingArtifact,
  window: ScheduledRoutingWindow,
  deadlineCheck?: ScheduledDeadlineCheck,
): ScheduledScanGraph {
  const stationById = new Map(schedule.stationAreas.map((area) => [area.id, area]));
  deadlineCheck?.("routing-scan");
  const connectionTable = connectionTableByWindow.get(window);
  if (connectionTable === undefined) throw new Error("Routing window is missing its private connection table.");
  return { stationById, connectionTable };
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
    deadlineCheck: options.deadlineCheck ?? deadlineCheckByWindow.get(window),
  };
  resolvedOptions.deadlineCheck?.("routing-scan");
  const earliestArrivalByArea = new Map<string, number>();
  const earliestBoardingReadyByArea = new Map<string, number>();
  // Authorization is participant-local. A processed row authorizes its
  // forward continuation, including a continuation in a later departure
  // bucket. No per-connection string keys or shared mutable continuation map
  // are retained between participant scans.
  const authorizedRows = new Uint8Array(graph.connectionTable.sourceConnectionIndex.length);
  const queuedOrProcessedRows = new Uint8Array(graph.connectionTable.sourceConnectionIndex.length);
  const predecessorByArea: Record<string, ItineraryEdge> = {};
  const tripHeadsignById = new Map(schedule.trips.map((trip) => [trip.tripId, trip.headsign]));
  const table = graph.connectionTable;

  const sourceForRow = (rowIndex: number): ScheduledConnection => {
    const sourceIndex = table.sourceConnectionIndex[rowIndex];
    const source = schedule.connections[sourceIndex];
    if (source === undefined) throw new Error("Compact routing row references a missing connection template.");
    return source;
  };

  const departureEpochForRow = (rowIndex: number): number => window.searchStartEpochSeconds + table.departureMinuteOffset[rowIndex]! * 60;
  const arrivalEpochForRow = (rowIndex: number): number => window.searchStartEpochSeconds + table.arrivalMinuteOffset[rowIndex]! * 60;

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
  while (bucketStart < table.sourceConnectionIndex.length) {
    resolvedOptions.deadlineCheck?.("routing-scan");
    const departureMinuteOffset = table.departureMinuteOffset[bucketStart];
    if (departureMinuteOffset === undefined) break;
    const departureEpochSeconds = window.searchStartEpochSeconds + departureMinuteOffset * 60;
    let bucketEnd = bucketStart + 1;
    while (bucketEnd < table.sourceConnectionIndex.length && table.departureMinuteOffset[bucketEnd] === departureMinuteOffset) bucketEnd += 1;
    const byFromArea = new Map<string, number[]>();
    for (let index = bucketStart; index < bucketEnd; index += 1) {
      if ((index - bucketStart) % ROUTING_CONNECTION_CHECKPOINT === 0) resolvedOptions.deadlineCheck?.("routing-scan");
      const source = sourceForRow(index);
      const current = byFromArea.get(source.fromStationAreaId) ?? [];
      current.push(index);
      byFromArea.set(source.fromStationAreaId, current);
    }
    const queue: number[] = [];
    const enqueueConnection = (rowIndex: number): void => {
      if (queuedOrProcessedRows[rowIndex] === 1) return;
      const source = sourceForRow(rowIndex);
      const readyAt = earliestBoardingReadyByArea.get(source.fromStationAreaId);
      const canBoard = source.pickupType === 0 && readyAt !== undefined && readyAt <= departureEpochSeconds;
      if (!canBoard && authorizedRows[rowIndex] !== 1) return;
      queuedOrProcessedRows[rowIndex] = 1;
      queue.push(rowIndex);
    };
    enqueueForArea = (areaId) => {
      for (const rowIndex of byFromArea.get(areaId) ?? []) enqueueConnection(rowIndex);
    };
    for (let index = bucketStart; index < bucketEnd; index += 1) {
      if ((index - bucketStart) % ROUTING_CONNECTION_CHECKPOINT === 0) resolvedOptions.deadlineCheck?.("routing-scan");
      enqueueConnection(index);
    }
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      if (queueIndex % ROUTING_CONNECTION_CHECKPOINT === 0) resolvedOptions.deadlineCheck?.("routing-scan");
      const rowIndex = queue[queueIndex];
      if (rowIndex === undefined) continue;
      const source = sourceForRow(rowIndex);
      const arrivalEpochSeconds = arrivalEpochForRow(rowIndex);
      authorizedRows[rowIndex] = 1;
      const nextRowPlusOne = table.continuationRowPlusOne[rowIndex] ?? 0;
      if (nextRowPlusOne !== 0) {
        const nextRowIndex = nextRowPlusOne - 1;
        authorizedRows[nextRowIndex] = 1;
        if (nextRowIndex < bucketEnd && table.departureMinuteOffset[nextRowIndex] === departureMinuteOffset) enqueueConnection(nextRowIndex);
      }
      if (source.dropOffType !== 0) continue;

      if (updateArrivalMinimum(source.toStationAreaId, arrivalEpochSeconds)) predecessorByArea[source.toStationAreaId] = { kind: "connection", connection: buildConnectionRef(source, departureEpochForRow(rowIndex), arrivalEpochSeconds, tripHeadsignById) };
      const arrivalArea = graph.stationById.get(source.toStationAreaId);
      if (arrivalArea === undefined) throw new Error("Connection references a missing arrival station area.");
      if (window.spatialIndex !== undefined) {
        for (const transferArea of querySpatialIndex(window.spatialIndex, arrivalArea.coordinate, resolvedOptions.transferRadiusMeters)) {
          emitTransfer(transferArea, haversineDistanceMeters(arrivalArea.coordinate, transferArea.coordinate), arrivalArea, arrivalEpochSeconds);
        }
      } else {
        for (const neighbor of arrivalArea.transferNeighbors) {
          if (neighbor.distanceMeters > resolvedOptions.transferRadiusMeters) continue;
          const transferArea = graph.stationById.get(neighbor.stationAreaId);
          if (transferArea === undefined) continue;
          emitTransfer(transferArea, neighbor.distanceMeters, arrivalArea, arrivalEpochSeconds);
        }
      }
    }
    enqueueForArea = null;
    bucketStart = bucketEnd;
  }
  return { earliestArrivalByArea, window, parsedStartEpochSeconds: window.searchStartEpochSeconds, predecessorByArea };
}

function buildConnectionRef(
  source: ScheduledConnection,
  departureEpochSeconds: number,
  arrivalEpochSeconds: number,
  tripHeadsignById: ReadonlyMap<string, string>,
): ItineraryConnectionRef {
  return {
    fromStationAreaId: source.fromStationAreaId,
    toStationAreaId: source.toStationAreaId,
    departureEpochSeconds,
    arrivalEpochSeconds,
    tripId: source.tripId,
    lineShortName: source.line.shortName,
    routeType: source.line.routeType,
    headsign: tripHeadsignById.get(source.tripId) ?? "",
  };
}

function scanScheduledConnections(
  schedule: ScheduledRoutingArtifact,
  accessSeeds: readonly ScheduledAccessSeed[],
  window: ScheduledRoutingWindow,
  options: ScheduledRoutingOptions,
): ScheduledScanState {
  const deadlineCheck = options.deadlineCheck ?? deadlineCheckByWindow.get(window);
  const graph = buildScheduledScanGraph(schedule, window, deadlineCheck);
  return scanScheduledConnectionsForParticipant(schedule, accessSeeds, window, options, graph);
}

interface CachedConnectionTable {
  readonly schedule: ScheduledRoutingArtifact;
  readonly searchStartEpochSeconds: number;
  readonly table: ScheduledConnectionTable;
}

interface CachedRoutingWindow {
  readonly window: ScheduledRoutingWindow;
  readonly connectionTable: CachedConnectionTable;
}

const routingWindowCache = new Map<string, CachedRoutingWindow>();
// The cache identity is the artifact object plus canonical search epoch. The
// table entry itself is used as the key so wrappers can link to it by identity
// during eviction without serialisation mismatches.
const routingConnectionTableCache = new Map<CachedConnectionTable, true>();
const MAX_CACHED_ROUTING_WINDOWS = 4;
const MAX_CACHED_CONNECTION_TABLES = 4;
const MAX_CACHED_ROUTING_BYTES = 64 * 1024 * 1024;
let cachedRoutingBytes = 0;

export function clearScheduledRoutingWindowCache(): void {
  routingWindowCache.clear();
  routingConnectionTableCache.clear();
  cachedRoutingBytes = 0;
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
  // Deadline callbacks are not part of the public window shape or compact
  // table. A callback-bearing invocation gets a private weak association
  // below, while only callback-free wrappers enter the cache.
  const hasInstrumentation = Boolean(instrumentation.onCandidateServiceDate || instrumentation.serviceDateAnchor || instrumentation.onMaterializedConnection || instrumentation.onMaterializationCheckpoint);
  // A callback-bearing wrapper is invocation-local. The table can still be
  // shared, but a cached wrapper must never retain a caller's callback.
  const isCacheable = !hasInstrumentation && resolvedOptions.deadlineCheck === undefined;
  const cacheKey = `${schedule.provenance.compiledArtifactId}:${parsedStart.canonicalAt}:${resolvedOptions.walkingVelocityMetersPerSecond}:${resolvedOptions.transferRadiusMeters}:${resolvedOptions.changeTimeSeconds}`;
  if (isCacheable) {
    const cached = routingWindowCache.get(cacheKey);
    if (cached !== undefined && cached.window.schedule === schedule) {
      routingWindowCache.delete(cacheKey);
      routingWindowCache.set(cacheKey, cached);
      touchCachedConnectionTable(cached.connectionTable);
      return cached.window;
    }
  }
  const connectionData = getOrCreateConnectionTable(
    schedule,
    parsedStart.epochSeconds,
    horizonEndEpochSeconds,
    instrumentation,
    resolvedOptions.deadlineCheck,
  );
  const connectionTable = connectionData.table;
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
    connectionCount: connectionTable.sourceConnectionIndex.length,
    compactTableByteLength: connectionTable.byteLength,
    spatialIndex,
  });
  connectionTableByWindow.set(window, connectionTable);
  if (resolvedOptions.deadlineCheck !== undefined) deadlineCheckByWindow.set(window, resolvedOptions.deadlineCheck);
  if (isCacheable) {
    if (routingWindowCache.size >= MAX_CACHED_ROUTING_WINDOWS) {
      const firstKey = routingWindowCache.keys().next().value;
      if (firstKey !== undefined) routingWindowCache.delete(firstKey);
    }
    // Oversized tables are deliberately returned but not retained by either
    // cache, so the byte bound remains meaningful.
    if (connectionTable.byteLength <= MAX_CACHED_ROUTING_BYTES) {
      routingWindowCache.set(cacheKey, { window, connectionTable: connectionData.cacheEntry });
    }
  }
  return window;
}

function getOrCreateConnectionTable(
  schedule: ScheduledRoutingArtifact,
  searchStartEpochSeconds: number,
  horizonEndEpochSeconds: number,
  instrumentation: ScheduledRoutingWindowInstrumentation,
  deadlineCheck?: ScheduledDeadlineCheck,
): { readonly table: ScheduledConnectionTable; readonly cacheEntry: CachedConnectionTable } {
  const canCache = !instrumentation.onCandidateServiceDate && !instrumentation.serviceDateAnchor && !instrumentation.onMaterializedConnection && !instrumentation.onMaterializationCheckpoint;
  if (canCache) {
    const cached = findCachedConnectionTable(schedule, searchStartEpochSeconds);
    if (cached !== undefined) return { table: cached.table, cacheEntry: cached };
  }
  const table = materializeConnections(schedule, searchStartEpochSeconds, horizonEndEpochSeconds, instrumentation, deadlineCheck);
  const cacheEntry: CachedConnectionTable = { schedule, searchStartEpochSeconds, table };
  if (!canCache || table.byteLength > MAX_CACHED_ROUTING_BYTES) return { table, cacheEntry };

  while (
    routingConnectionTableCache.size >= MAX_CACHED_CONNECTION_TABLES ||
    cachedRoutingBytes + table.byteLength > MAX_CACHED_ROUTING_BYTES
  ) {
    const firstEntry = routingConnectionTableCache.keys().next().value;
    if (firstEntry === undefined) break;
    evictCachedConnectionTable(firstEntry);
  }
  routingConnectionTableCache.set(cacheEntry, true);
  cachedRoutingBytes += table.byteLength;
  return { table, cacheEntry };
}

function findCachedConnectionTable(schedule: ScheduledRoutingArtifact, searchStartEpochSeconds: number): CachedConnectionTable | undefined {
  for (const cached of routingConnectionTableCache.keys()) {
    if (cached.schedule !== schedule || cached.searchStartEpochSeconds !== searchStartEpochSeconds) continue;
    touchCachedConnectionTable(cached);
    return cached;
  }
  return undefined;
}

function touchCachedConnectionTable(cached: CachedConnectionTable): void {
  if (!routingConnectionTableCache.has(cached)) return;
  // Keep table LRU order independent of wrapper LRU order, while making a
  // wrapper hit count as use of the shared table too.
  routingConnectionTableCache.delete(cached);
  routingConnectionTableCache.set(cached, true);
}

function evictCachedConnectionTable(cached: CachedConnectionTable): void {
  if (routingConnectionTableCache.delete(cached)) cachedRoutingBytes = Math.max(0, cachedRoutingBytes - cached.table.byteLength);
  for (const [windowKey, cachedWindow] of routingWindowCache) {
    if (cachedWindow.connectionTable === cached) routingWindowCache.delete(windowKey);
  }
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
): ScheduledConnectionTable {
  deadlineCheck?.("routing-window");
  const [firstCandidateDate, lastCandidateDate] = serviceDateRangeForSearch(searchStartEpochSeconds, schedule.timeZone, schedule.maximumServiceDayTimeSeconds);
  const streams: ScheduledConnectionDateCursor[] = [];
  let serviceDate = firstCandidateDate;
  while (serviceDate <= lastCandidateDate) {
    deadlineCheck?.("routing-window");
    instrumentation.onCandidateServiceDate?.(serviceDate);
    const activeServiceIds = activeServiceIdsForDate(schedule, serviceDate);
    const anchorEpochSeconds = (instrumentation.serviceDateAnchor ?? serviceDateAnchorEpochSeconds)(serviceDate, schedule.timeZone);
    if (activeServiceIds.size > 0) {
      streams.push(createScheduledConnectionDateStream(schedule.connections, serviceDate, anchorEpochSeconds, activeServiceIds, searchStartEpochSeconds, horizonEndEpochSeconds));
    }
    serviceDate = addServiceDays(serviceDate, 1);
  }
  const heap = new ScheduledConnectionMinHeap(schedule.connections);
  const tableBuilder = new ScheduledConnectionTableBuilder(
    searchStartEpochSeconds,
    instrumentation.onMaterializedConnection !== undefined,
    instrumentation.onMaterializationCheckpoint,
  );
  for (let streamIndex = 0; streamIndex < streams.length; streamIndex += 1) {
    deadlineCheck?.("routing-window");
    const stream = streams[streamIndex];
    if (stream !== undefined && advanceScheduledConnectionDateCursor(stream, schedule.connections, deadlineCheck)) {
      heap.push({ cursor: stream, streamIndex });
    }
  }
  let mergedConnections = 0;
  while (heap.size > 0) {
    if (mergedConnections % ROUTING_CONNECTION_CHECKPOINT === 0) deadlineCheck?.("routing-window");
    const entry = heap.pop();
    if (entry === null) break;
    const rowIndex = tableBuilder.append(entry.cursor);
    commitScheduledConnectionDateCursor(entry.cursor, rowIndex);
    mergedConnections += 1;
    if (advanceScheduledConnectionDateCursor(entry.cursor, schedule.connections, deadlineCheck)) heap.push(entry);
  }
  return tableBuilder.finish(schedule.connections, instrumentation.onMaterializedConnection);
}

interface ScheduledConnectionDateCursor {
  readonly serviceDate: string;
  readonly anchorEpochSeconds: number;
  readonly activeServiceIds: ReadonlySet<string>;
  readonly searchStartEpochSeconds: number;
  readonly horizonEndEpochSeconds: number;
  readonly endConnectionIndex: number;
  /** Zero means the immediately preceding active source was not materialized;
   * otherwise this is its output row index plus one. The map is date-local. */
  readonly previousRowPlusOneByTrip: Map<string, number>;
  connectionIndex: number;
  scannedConnections: number;
  sourceConnectionIndex: number;
  departureEpochSeconds: number;
  arrivalEpochSeconds: number;
  previousRowIndex: number;
  pendingTripId: string | null;
  hasCandidate: boolean;
}

function createScheduledConnectionDateStream(
  connections: readonly ScheduledConnection[],
  serviceDate: string,
  anchorEpochSeconds: number,
  activeServiceIds: ReadonlySet<string>,
  searchStartEpochSeconds: number,
  horizonEndEpochSeconds: number,
): ScheduledConnectionDateCursor {
  const firstServiceDaySecond = Math.max(0, searchStartEpochSeconds - anchorEpochSeconds);
  const lastServiceDaySecond = horizonEndEpochSeconds - anchorEpochSeconds;
  const connectionIndex = firstConnectionIndexAtOrAfter(connections, firstServiceDaySecond);
  const endConnectionIndex = lastServiceDaySecond < 0 ? connectionIndex : firstConnectionIndexAfter(connections, lastServiceDaySecond);
  return {
    serviceDate,
    anchorEpochSeconds,
    activeServiceIds,
    searchStartEpochSeconds,
    horizonEndEpochSeconds,
    endConnectionIndex,
    previousRowPlusOneByTrip: new Map<string, number>(),
    connectionIndex,
    scannedConnections: 0,
    sourceConnectionIndex: -1,
    departureEpochSeconds: 0,
    arrivalEpochSeconds: 0,
    previousRowIndex: -1,
    pendingTripId: null,
    hasCandidate: false,
  };
}

function advanceScheduledConnectionDateCursor(
  cursor: ScheduledConnectionDateCursor,
  connections: readonly ScheduledConnection[],
  deadlineCheck?: ScheduledDeadlineCheck,
): boolean {
  cursor.pendingTripId = null;
  cursor.hasCandidate = false;
  while (cursor.connectionIndex < cursor.endConnectionIndex) {
    if (cursor.scannedConnections % ROUTING_CONNECTION_CHECKPOINT === 0) deadlineCheck?.("routing-window");
    const sourceConnectionIndex = cursor.connectionIndex;
    const source = connections[sourceConnectionIndex];
    cursor.connectionIndex += 1;
    cursor.scannedConnections += 1;
    if (source === undefined || !cursor.activeServiceIds.has(source.serviceId)) continue;
    const departureEpochSeconds = cursor.anchorEpochSeconds + source.departureTimeSeconds;
    const arrivalEpochSeconds = cursor.anchorEpochSeconds + source.arrivalTimeSeconds;
    const previousRowPlusOne = cursor.previousRowPlusOneByTrip.get(source.tripId) ?? 0;
    if (departureEpochSeconds < cursor.searchStartEpochSeconds || departureEpochSeconds > cursor.horizonEndEpochSeconds || arrivalEpochSeconds > cursor.horizonEndEpochSeconds) {
      cursor.previousRowPlusOneByTrip.set(source.tripId, 0);
      continue;
    }
    cursor.sourceConnectionIndex = sourceConnectionIndex;
    cursor.departureEpochSeconds = departureEpochSeconds;
    cursor.arrivalEpochSeconds = arrivalEpochSeconds;
    cursor.previousRowIndex = previousRowPlusOne === 0 ? -1 : previousRowPlusOne - 1;
    // The current candidate replaces this state only after its ordered-merge
    // row has been committed below.
    cursor.pendingTripId = source.tripId;
    cursor.hasCandidate = true;
    return true;
  }
  return false;
}

function commitScheduledConnectionDateCursor(cursor: ScheduledConnectionDateCursor, rowIndex: number): void {
  if (!cursor.hasCandidate || cursor.pendingTripId === null) throw new Error("Cannot commit an empty routing cursor.");
  cursor.previousRowPlusOneByTrip.set(cursor.pendingTripId, rowIndex + 1);
  cursor.pendingTripId = null;
  cursor.hasCandidate = false;
}

const SCHEDULED_CONNECTION_TABLE_CHUNK_LENGTH = 16_384;

interface ScheduledConnectionTableChunk {
  readonly sourceConnectionIndex: Uint32Array;
  readonly departureMinuteOffset: Uint32Array;
  readonly arrivalMinuteOffset: Uint32Array;
  readonly continuationRowPlusOne: Uint32Array;
}

class ScheduledConnectionTableBuilder {
  private readonly chunks: ScheduledConnectionTableChunk[] = [];
  private readonly serviceDateByRow: string[] | undefined;
  private count = 0;

  public constructor(
    private readonly searchStartEpochSeconds: number,
    captureServiceDates: boolean,
    private readonly onMaterializationCheckpoint?: (materializedConnectionCount: number) => void,
  ) {
    this.serviceDateByRow = captureServiceDates ? [] : undefined;
  }

  append(cursor: ScheduledConnectionDateCursor): number {
    const rowIndex = this.count;
    const chunkIndex = Math.floor(rowIndex / SCHEDULED_CONNECTION_TABLE_CHUNK_LENGTH);
    let chunk = this.chunks[chunkIndex];
    if (chunk === undefined) {
      chunk = {
        sourceConnectionIndex: new Uint32Array(SCHEDULED_CONNECTION_TABLE_CHUNK_LENGTH),
        departureMinuteOffset: new Uint32Array(SCHEDULED_CONNECTION_TABLE_CHUNK_LENGTH),
        arrivalMinuteOffset: new Uint32Array(SCHEDULED_CONNECTION_TABLE_CHUNK_LENGTH),
        continuationRowPlusOne: new Uint32Array(SCHEDULED_CONNECTION_TABLE_CHUNK_LENGTH),
      };
      this.chunks.push(chunk);
    }
    const chunkOffset = rowIndex % SCHEDULED_CONNECTION_TABLE_CHUNK_LENGTH;
    chunk.sourceConnectionIndex[chunkOffset] = cursor.sourceConnectionIndex;
    chunk.departureMinuteOffset[chunkOffset] = minuteOffset(cursor.departureEpochSeconds, this.searchStartEpochSeconds);
    chunk.arrivalMinuteOffset[chunkOffset] = minuteOffset(cursor.arrivalEpochSeconds, this.searchStartEpochSeconds);
    chunk.continuationRowPlusOne[chunkOffset] = 0;
    if (cursor.previousRowIndex >= 0) {
      const predecessorChunkIndex = Math.floor(cursor.previousRowIndex / SCHEDULED_CONNECTION_TABLE_CHUNK_LENGTH);
      const predecessorChunk = this.chunks[predecessorChunkIndex];
      if (predecessorChunk === undefined) throw new Error("Continuation references a missing compact table chunk.");
      predecessorChunk.continuationRowPlusOne[cursor.previousRowIndex % SCHEDULED_CONNECTION_TABLE_CHUNK_LENGTH] = rowIndex + 1;
    }
    this.serviceDateByRow?.push(cursor.serviceDate);
    this.count += 1;
    if (this.count % ROUTING_CONNECTION_CHECKPOINT === 0) this.onMaterializationCheckpoint?.(this.count);
    return rowIndex;
  }

  finish(
    connections: readonly ScheduledConnection[],
    onMaterializedConnection?: (connection: ScheduledRoutingMaterializedConnection) => void,
  ): ScheduledConnectionTable {
    const table: ScheduledConnectionTable = {
      sourceConnectionIndex: this.flatten("sourceConnectionIndex"),
      departureMinuteOffset: this.flatten("departureMinuteOffset"),
      arrivalMinuteOffset: this.flatten("arrivalMinuteOffset"),
      continuationRowPlusOne: this.flatten("continuationRowPlusOne"),
      byteLength: this.count * Uint32Array.BYTES_PER_ELEMENT * 4,
    };
    this.onMaterializationCheckpoint?.(this.count);
    if (onMaterializedConnection !== undefined) {
      const serviceDateByRow = this.serviceDateByRow;
      if (serviceDateByRow === undefined) throw new Error("Materialized projection was not enabled for this table builder.");
      const predecessorRowByRow = new Int32Array(this.count);
      predecessorRowByRow.fill(-1);
      for (let rowIndex = 0; rowIndex < this.count; rowIndex += 1) {
        const continuationRowPlusOne = table.continuationRowPlusOne[rowIndex] ?? 0;
        if (continuationRowPlusOne !== 0) predecessorRowByRow[continuationRowPlusOne - 1] = rowIndex;
      }
      for (let rowIndex = 0; rowIndex < this.count; rowIndex += 1) {
        const sourceConnectionIndex = table.sourceConnectionIndex[rowIndex];
        const source = connections[sourceConnectionIndex];
        const serviceDate = serviceDateByRow[rowIndex];
        if (source === undefined || serviceDate === undefined) throw new Error("Materialized projection references a missing connection row.");
        const predecessorRowIndex = predecessorRowByRow[rowIndex];
        const continuationRowPlusOne = table.continuationRowPlusOne[rowIndex] ?? 0;
        onMaterializedConnection(Object.freeze({
          source,
          serviceDate,
          departureEpochSeconds: this.searchStartEpochSeconds + (table.departureMinuteOffset[rowIndex] ?? 0) * 60,
          arrivalEpochSeconds: this.searchStartEpochSeconds + (table.arrivalMinuteOffset[rowIndex] ?? 0) * 60,
          predecessorRowIndex: predecessorRowIndex < 0 ? null : predecessorRowIndex,
          continuationRowIndex: continuationRowPlusOne === 0 ? null : continuationRowPlusOne - 1,
        }));
      }
    }
    return table;
  }

  private flatten(field: keyof ScheduledConnectionTableChunk): Uint32Array {
    const values = new Uint32Array(this.count);
    for (let chunkIndex = 0; chunkIndex < this.chunks.length; chunkIndex += 1) {
      const start = chunkIndex * SCHEDULED_CONNECTION_TABLE_CHUNK_LENGTH;
      const length = Math.min(SCHEDULED_CONNECTION_TABLE_CHUNK_LENGTH, this.count - start);
      if (length <= 0) break;
      const chunk = this.chunks[chunkIndex];
      if (chunk === undefined) throw new Error("Compact table is missing a backing chunk.");
      values.set(chunk[field].subarray(0, length), start);
    }
    return values;
  }
}

function minuteOffset(epochSeconds: number, searchStartEpochSeconds: number): number {
  const offsetSeconds = epochSeconds - searchStartEpochSeconds;
  if (!Number.isSafeInteger(offsetSeconds) || offsetSeconds < 0 || offsetSeconds % 60 !== 0) throw new Error("Materialized connection epoch is not a canonical whole-minute offset.");
  return offsetSeconds / 60;
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
  readonly cursor: ScheduledConnectionDateCursor;
  readonly streamIndex: number;
}

class ScheduledConnectionMinHeap {
  private readonly entries: ScheduledConnectionHeapEntry[] = [];

  public constructor(private readonly connections: readonly ScheduledConnection[]) {}

  get size(): number {
    return this.entries.length;
  }

  push(entry: ScheduledConnectionHeapEntry): void {
    this.entries.push(entry);
    let index = this.entries.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareHeapEntries(this.entries[parent]!, this.entries[index]!, this.connections) <= 0) break;
      const parentEntry = this.entries[parent]!;
      this.entries[parent] = this.entries[index]!;
      this.entries[index] = parentEntry;
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
        if (left < this.entries.length && compareHeapEntries(this.entries[left]!, this.entries[smallest]!, this.connections) < 0) smallest = left;
        if (right < this.entries.length && compareHeapEntries(this.entries[right]!, this.entries[smallest]!, this.connections) < 0) smallest = right;
        if (smallest === index) break;
        const currentEntry = this.entries[index]!;
        this.entries[index] = this.entries[smallest]!;
        this.entries[smallest] = currentEntry;
        index = smallest;
      }
    }
    return first;
  }
}

function compareHeapEntries(left: ScheduledConnectionHeapEntry, right: ScheduledConnectionHeapEntry, connections: readonly ScheduledConnection[]): number {
  const leftSource = connections[left.cursor.sourceConnectionIndex];
  const rightSource = connections[right.cursor.sourceConnectionIndex];
  if (leftSource === undefined || rightSource === undefined) throw new Error("Heap candidate references a missing connection template.");
  return left.cursor.departureEpochSeconds - right.cursor.departureEpochSeconds || compareScheduledConnections(leftSource, rightSource) || left.cursor.arrivalEpochSeconds - right.cursor.arrivalEpochSeconds || left.streamIndex - right.streamIndex;
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

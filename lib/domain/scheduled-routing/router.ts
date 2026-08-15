import "server-only";

import {
  ROUTING_HORIZON_SECONDS,
  WALKING_SECONDS_ROUNDING_RULE,
  type ScheduledAccessSeed,
  type ScheduledBoardingStop,
  type ScheduledConnection,
  type ScheduledDeadlineCheck,
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
  options: ScheduledRoutingOptions = {},
  suppliedWindow?: ScheduledRoutingWindow,
): ScheduledRoutingResult {
  const window = suppliedWindow ?? createScheduledRoutingWindow(schedule, searchStartAt, options);
  if (window.schedule !== schedule) throw new RangeError("A routing window belongs to a different schedule artifact.");
  const parsedStart = parseOffsetInstant(searchStartAt, schedule.timeZone);
  if (parsedStart.epochSeconds !== window.searchStartEpochSeconds) throw new RangeError("A routing window belongs to a different search start.");
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
  const reachableConnectionKeys = new Set<string>();
  const continuationByPreviousKey = new Map<string, ScheduledMaterializedConnection>();
  for (let connectionIndex = 0; connectionIndex < window.connections.length; connectionIndex += 1) {
    if (connectionIndex % ROUTING_CONNECTION_CHECKPOINT === 0) resolvedOptions.deadlineCheck?.("routing-scan");
    const connection = window.connections[connectionIndex];
    if (connection === undefined) continue;
    if (connection.previousContinuationKey !== null) continuationByPreviousKey.set(connection.previousContinuationKey, connection);
  }

  let enqueueForStop: ((stopId: string) => void) | null = null;
  const updateReady = (stopId: string, readyAt: number): void => {
    if (readyAt > window.horizonEndEpochSeconds) return;
    const current = earliestReadyByStop.get(stopId);
    if (current !== undefined && current <= readyAt) return;
    earliestReadyByStop.set(stopId, readyAt);
    enqueueForStop?.(stopId);
  };
  const updateArrivalMinimum = (stationAreaId: string, arrivalEpochSeconds: number): void => {
    if (arrivalEpochSeconds <= window.horizonEndEpochSeconds) updateMinimum(earliestArrivalByArea, stationAreaId, arrivalEpochSeconds);
  };

  for (const seed of accessSeeds) {
    resolvedOptions.deadlineCheck?.("routing-scan");
    const area = stationById.get(seed.stationAreaId);
    if (area === undefined) throw new RangeError(`Access seed references unknown station area ${seed.stationAreaId}.`);
    validateWholeNonNegative(seed.accessSeconds, "Access seed accessSeconds");
    if (seed.accessSeconds > ROUTING_HORIZON_SECONDS) throw new RangeError("Access seed accessSeconds must not exceed the 24-hour routing horizon.");
    const stationArrival = parsedStart.epochSeconds + seed.accessSeconds;
    updateArrivalMinimum(area.id, stationArrival);
    const stopIds = seed.boardingStopId === undefined ? area.boardingStopIds : [seed.boardingStopId];
    if (seed.boardingStopId !== undefined && !area.boardingStopIds.includes(seed.boardingStopId)) {
      throw new RangeError(`Access seed references boarding stop ${seed.boardingStopId} outside station area ${area.id}.`);
    }
    for (const stopId of stopIds) {
      const stop = stopById.get(stopId);
      if (stop === undefined) throw new Error("Station area references a missing boarding stop.");
      const accessWalkSeconds = seed.boardingStopId === undefined
        ? walkingSeconds(area.coordinate, stop.coordinate, resolvedOptions.walkingVelocityMetersPerSecond)
        : 0;
      updateReady(stop.id, stationArrival + accessWalkSeconds);
    }
  }

  // Linear CSA with a bounded fixpoint for one departure-time bucket. A
  // zero-second transfer may make a lexically earlier trip board at the same
  // instant, so the bucket is drained through a queue; each connection can be
  // enqueued and processed at most once in that bucket.
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
      const nextConnection = continuationByPreviousKey.get(connection.connectionKey);
      if (nextConnection !== undefined && nextConnection.departureEpochSeconds === departureEpochSeconds) enqueueConnection(nextConnection);
      if (connection.source.dropOffType !== 0) continue;

      updateArrivalMinimum(connection.source.toStationAreaId, connection.arrivalEpochSeconds);
      const arrivalStop = stopById.get(connection.source.toStopId);
      if (arrivalStop === undefined) throw new Error("Connection references a missing arrival stop.");
      for (const transferStop of querySpatialIndex(window.spatialIndex, arrivalStop.coordinate, resolvedOptions.transferRadiusMeters)) {
        const transferReady = connection.arrivalEpochSeconds + walkingSeconds(arrivalStop.coordinate, transferStop.coordinate, resolvedOptions.walkingVelocityMetersPerSecond);
        updateArrivalMinimum(transferStop.stationAreaId, transferReady);
        updateReady(transferStop.id, transferReady);
      }
    }
    enqueueForStop = null;
    bucketStart = bucketEnd;
  }

  const stationArrivals: StationArrivalField[] = schedule.stationAreas.map((area) => {
    const epochSeconds = earliestArrivalByArea.get(area.id);
    return {
      stationAreaId: area.id,
      arrivalAt: epochSeconds === undefined ? null : formatEpochSeconds(epochSeconds),
      elapsedSeconds: epochSeconds === undefined ? null : epochSeconds - parsedStart.epochSeconds,
    };
  });
  return Object.freeze({
    stationArrivals: Object.freeze(stationArrivals),
    reachableStationAreaCount: stationArrivals.filter((arrival) => arrival.arrivalAt !== null).length,
    searchStartAt: parsedStart.canonicalAt,
    searchStartEpochSeconds: parsedStart.epochSeconds,
    horizonEndEpochSeconds: window.horizonEndEpochSeconds,
  });
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
  const connections = materializeConnections(schedule, parsedStart.epochSeconds, horizonEndEpochSeconds, instrumentation, resolvedOptions.deadlineCheck);
  resolvedOptions.deadlineCheck?.("routing-window");
  const spatialIndex = buildSpatialIndex(schedule.boardingStops, resolvedOptions.transferRadiusMeters);
  resolvedOptions.deadlineCheck?.("routing-window");
  return Object.freeze({
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

function updateMinimum(values: Map<string, number>, key: string, value: number): void {
  const current = values.get(key);
  if (current === undefined || value < current) values.set(key, value);
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

function haversineDistanceMeters(
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

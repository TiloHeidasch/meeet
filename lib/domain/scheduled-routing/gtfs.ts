import "server-only";

import { createHash, type Hash } from "node:crypto";

import { logCompilerProgress } from "../../log.ts";
import type {
  GtfsPickupDropOffType,
  GtfsAcquisitionRecord,
  GtfsFileProvenance,
  ScheduledArtifactProvenance,
  ScheduledConnection,
  ScheduledRoute,
  ScheduledRoutingArtifact,
  ScheduledSearchStartBounds,
  ScheduledStationArea,
  ScheduledTransferNeighbor,
  ScheduledTrip,
  ServiceCalendar,
  ServiceException,
  StationAreaMode,
} from "./models.ts";
import { TRANSFER_NEIGHBOR_RADIUS_METERS } from "./models.ts";
import { addServiceDays, parseOffsetInstant, serviceDateAnchorEpochSeconds } from "./time.ts";
import { buildAreaSpatialIndex, findAreasWithinRadius, haversineDistanceMeters } from "./spatial.ts";

export interface GtfsFeedFiles {
  readonly [fileName: string]: string;
}

export interface GtfsImportOptions {
  readonly feedId?: string;
  readonly timeZone?: string;
  readonly acquisition: GtfsAcquisitionRecord;
  /** Emit [compile] progress lines; defaults to true. Runner-side imports (e.g. fixtures) pass false. */
  readonly logProgress?: boolean;
}

export type ScheduledArtifactCore = Omit<ScheduledRoutingArtifact, "provenance">;
export type ScheduledArtifactIdentityProvenance = Omit<ScheduledArtifactProvenance, "compiledArtifactId">;

/** Stable ordering for every persisted collection whose identity is a string. */
export function compareScheduledIds(left: string, right: string): number {
  return left.localeCompare(right);
}

export function calculateScheduledCompiledArtifactId(
  core: ScheduledArtifactCore,
  provenance: ScheduledArtifactIdentityProvenance,
): string {
  return sha256Canonical({ core, provenance });
}

export function calculateScheduledContentHash(
  feedId: string,
  timeZone: string,
  files: readonly GtfsFileProvenance[],
): string {
  return sha256Canonical({ feedId, timeZone, files });
}

export class GtfsValidationError extends Error {
  readonly fileName: string | null;
  readonly rowNumber: number | null;

  constructor(message: string, fileName: string | null = null, rowNumber: number | null = null) {
    super(fileName === null ? message : `${fileName}${rowNumber === null ? "" : `:${rowNumber}`}: ${message}`);
    this.name = "GtfsValidationError";
    this.fileName = fileName;
    this.rowNumber = rowNumber;
  }
}

interface CsvTable {
  readonly fileName: string;
  readonly headers: readonly string[];
  readonly rows: readonly Record<string, string>[];
}

interface StopRecord {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly locationType: number;
  readonly parentStationId: string | null;
}

interface StopTimeRecord {
  readonly tripId: string;
  readonly arrivalTimeSeconds: number;
  readonly departureTimeSeconds: number;
  readonly stopId: string;
  readonly stopSequence: number;
  readonly pickupType: GtfsPickupDropOffType;
  readonly dropOffType: GtfsPickupDropOffType;
}

interface AgencyRecord {
  readonly agencyId: string;
  readonly agencyName: string;
  readonly agencyUrl: string;
  readonly agencyTimezone: string;
}

/** Import the compact, deterministic GTFS subset used by scheduled routing. */
export function importGtfsSchedule(
  files: GtfsFeedFiles,
  options: GtfsImportOptions,
): ScheduledRoutingArtifact {
  const feedId = options.feedId ?? "gtfs-feed";
  const acquisition = normalizeAcquisition(options.acquisition);
  const logProgress = options.logProgress ?? true;
  validateNonEmpty(feedId, "feedId");

  const fileNames = Object.keys(files).sort(compareScheduledIds);
  for (const fileName of fileNames) {
    if (typeof files[fileName] !== "string") {
      throw new GtfsValidationError("GTFS file content must be a string.", fileName);
    }
  }
  for (const required of ["agency.txt", "routes.txt", "stops.txt", "trips.txt", "stop_times.txt"]) {
    if (files[required] === undefined) {
      throw new GtfsValidationError(`Required GTFS file is missing: ${required}.`, required);
    }
  }
  if (files["calendar.txt"] === undefined && files["calendar_dates.txt"] === undefined) {
    throw new GtfsValidationError("At least calendar.txt or calendar_dates.txt is required.");
  }
  for (const unsupported of ["frequencies.txt", "transfers.txt", "pathways.txt"]) {
    rejectUnsupportedOptionalFile(files, unsupported);
  }

  const agencyTable = readTable(files, "agency.txt");
  const routesTable = readTable(files, "routes.txt");
  const stopsTable = readTable(files, "stops.txt");
  const tripsTable = readTable(files, "trips.txt");
  const stopTimesTable = readTable(files, "stop_times.txt");
  const calendarTable = files["calendar.txt"] === undefined ? null : readTable(files, "calendar.txt");
  const exceptionsTable = files["calendar_dates.txt"] === undefined ? null : readTable(files, "calendar_dates.txt");
  if (logProgress) logCompilerProgress("parsing GTFS tables (agency, routes, stops, trips, stop_times, calendar, calendar_dates)");

  requireColumns(agencyTable, ["agency_id", "agency_name", "agency_url", "agency_timezone"]);
  const agency = parseAgency(agencyTable);
  const timeZone = options.timeZone ?? agency.agencyTimezone;
  if (timeZone !== agency.agencyTimezone) throw new GtfsValidationError("Importer timezone must match the single supported agency timezone.", "agency.txt");
  if (timeZone !== "Europe/Berlin") throw new GtfsValidationError("Only Europe/Berlin is supported by scheduled routing.", "agency.txt");
  validateTimeZone(timeZone);
  requireColumns(routesTable, ["route_id", "route_type"]);
  requireColumns(stopsTable, ["stop_id", "stop_name", "stop_lat", "stop_lon"]);
  requireColumns(tripsTable, ["route_id", "service_id", "trip_id"]);
  requireColumns(stopTimesTable, ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"]);
  if (calendarTable !== null) {
    requireColumns(calendarTable, ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"]);
  }
  if (exceptionsTable !== null) {
    requireColumns(exceptionsTable, ["service_id", "date", "exception_type"]);
  }

  const routes = parseRoutes(routesTable);
  if (logProgress) logCompilerProgress(`routes parsed: ${routes.length}`);
  const stops = parseStops(stopsTable);
  if (logProgress) logCompilerProgress(`stops parsed: ${stops.length}`);
  const trips = parseTrips(tripsTable, routes);
  if (logProgress) logCompilerProgress(`trips parsed: ${trips.length}`);
  const modesByArea = deriveStationAreaModes(stopTimesTable, trips, stops, routes);
  const stationAreas = createStationAreas(stops, modesByArea);
  if (logProgress) logCompilerProgress(`station areas created: ${stationAreas.length}`);
  const calendars = parseCalendars(calendarTable);
  const exceptions = parseExceptions(exceptionsTable);
  if (logProgress) logCompilerProgress(`calendars parsed: ${calendars.length}, exceptions parsed: ${exceptions.length}`);
  validateServices(trips, calendars, exceptions, calendarTable !== null);
  const connections = parseConnections(stopTimesTable, trips, stops, routes);
  if (logProgress) logCompilerProgress(`connections parsed: ${connections.length}`);
  const serviceDateRange = deriveServiceDateRange(calendars, exceptions, trips);
  if (serviceDateRange.firstDate < acquisition.feedValidFrom || serviceDateRange.lastDate > acquisition.feedValidUntil) {
    throw new GtfsValidationError("Compiled service validity exceeds the acquired feed validity.");
  }
  const maximumServiceDayTimeSeconds = maximumConnectionTimeSeconds(connections);
  const searchStartBounds = deriveSearchStartBounds(serviceDateRange, maximumServiceDayTimeSeconds, timeZone);
  const sortedRoutes = sortByKey(routes, (route) => route.routeId);
  const sortedTrips = sortByKey(trips, (trip) => trip.tripId);
  const sortedStationAreas = sortByKey(stationAreas, (area) => area.id);
  const sortedCalendars = sortByKey(calendars, (calendar) => calendar.serviceId);
  const sortedExceptions = [...exceptions].sort((left, right) => compareScheduledIds(`${left.date}:${left.serviceId}`, `${right.date}:${right.serviceId}`));
  const sortedConnections = [...connections].sort(compareScheduledConnections);
  const compiledPayload: ScheduledArtifactCore = {
    contractVersion: "meeet-scheduled-routing/v1",
    feedId,
    timeZone,
    serviceDateRange,
    maximumServiceDayTimeSeconds,
    searchStartBounds,
    routes: sortedRoutes,
    trips: sortedTrips,
    stationAreas: sortedStationAreas,
    calendars: sortedCalendars,
    exceptions: sortedExceptions,
    connections: sortedConnections,
  };
  const provenance = createProvenance(files, fileNames, feedId, timeZone, acquisition, compiledPayload);
  if (logProgress) logCompilerProgress(`provenance computed (contentHash=${provenance.contentHash}, compiledArtifactId=${provenance.compiledArtifactId})`);

  const artifact: ScheduledRoutingArtifact = {
    contractVersion: "meeet-scheduled-routing/v1",
    feedId,
    timeZone,
    serviceDateRange,
    maximumServiceDayTimeSeconds,
    searchStartBounds,
    routes: sortedRoutes,
    trips: sortedTrips,
    stationAreas: sortedStationAreas,
    calendars: sortedCalendars,
    exceptions: sortedExceptions,
    connections: sortedConnections,
    provenance,
  };
  if (logProgress) logCompilerProgress(`GTFS import complete (feedId=${feedId}, serviceDateRange=${serviceDateRange.firstDate}..${serviceDateRange.lastDate})`);
  return deepFreeze(artifact);
}

/** Short alias for callers treating the result as an imported snapshot. */
export const importGtfsSnapshot = importGtfsSchedule;

function readTable(files: GtfsFeedFiles, fileName: string): CsvTable {
  const content = files[fileName];
  if (content === undefined) throw new GtfsValidationError("GTFS file is missing.", fileName);
  const records = parseCsv(content, fileName);
  const headerRow = records[0];
  if (headerRow === undefined || headerRow.length === 0) {
    throw new GtfsValidationError("GTFS file has no header row.", fileName);
  }
  const headers = headerRow.map((header) => header.trim());
  if (headers.some((header) => header.length === 0) || new Set(headers).size !== headers.length) {
    throw new GtfsValidationError("GTFS header contains an empty or duplicate column.", fileName, 1);
  }
  const rows: Record<string, string>[] = [];
  for (let index = 1; index < records.length; index += 1) {
    const values = records[index];
    if (values === undefined || values.every((value) => value.trim() === "")) continue;
    if (values.length !== headers.length) {
      throw new GtfsValidationError("Column count does not match the header.", fileName, index + 1);
    }
    const row: Record<string, string> = {};
    for (let column = 0; column < headers.length; column += 1) {
      const header = headers[column];
      const value = values[column];
      if (header === undefined || value === undefined) {
        throw new GtfsValidationError("Malformed CSV row.", fileName, index + 1);
      }
      row[header] = value.trim();
    }
    rows.push(row);
  }
  return { fileName, headers, rows };
}

function parseCsv(content: string, fileName: string): string[][] {
  const normalizedContent = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < normalizedContent.length; index += 1) {
    const character = normalizedContent[index];
    if (character === undefined) continue;
    if (quoted) {
      if (character === '"') {
        if (normalizedContent[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new GtfsValidationError("Unclosed quoted CSV field.", fileName);
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function requireColumns(table: CsvTable, columns: readonly string[]): void {
  for (const column of columns) {
    if (!table.headers.includes(column)) {
      throw new GtfsValidationError(`Required column is missing: ${column}.`, table.fileName, 1);
    }
  }
}

function parseAgency(table: CsvTable): AgencyRecord {
  const ids = new Set<string>();
  const agencies: AgencyRecord[] = [];
  for (let index = 0; index < table.rows.length; index += 1) {
    const row = table.rows[index];
    if (row === undefined) continue;
    const agencyId = required(row, "agency_id", table, index);
    addUnique(ids, agencyId, table, index, "agency_id");
    agencies.push({
      agencyId,
      agencyName: required(row, "agency_name", table, index),
      agencyUrl: required(row, "agency_url", table, index),
      agencyTimezone: required(row, "agency_timezone", table, index),
    });
  }
  if (agencies.length === 0) throw new GtfsValidationError("agency.txt must contain at least one agency.", table.fileName);
  const timeZones = new Set(agencies.map((agency) => agency.agencyTimezone));
  if (timeZones.size !== 1) throw new GtfsValidationError("All agencies must use one shared timezone.", table.fileName);
  const agency = agencies[0];
  if (agency === undefined) throw new GtfsValidationError("agency.txt must contain at least one agency.", table.fileName);
  return agency;
}

function rejectUnsupportedOptionalFile(files: GtfsFeedFiles, fileName: string): void {
  const content = files[fileName];
  if (content === undefined) return;
  const records = parseCsv(content, fileName);
  if (records.slice(1).some((row) => row.some((value) => value.trim() !== ""))) {
    throw new GtfsValidationError(`${fileName} is unsupported and must be empty.`, fileName);
  }
}

function parseRoutes(table: CsvTable): ScheduledRoute[] {
  const routes: ScheduledRoute[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < table.rows.length; index += 1) {
    const row = table.rows[index];
    if (row === undefined) continue;
    const routeId = required(row, "route_id", table, index);
    addUnique(ids, routeId, table, index, "route_id");
    routes.push({
      routeId,
      shortName: row.route_short_name ?? "",
      longName: row.route_long_name ?? "",
      routeType: integer(row.route_type ?? "", table, index, "route_type", 0, 999),
    });
  }
  if (routes.length === 0) throw new GtfsValidationError("routes.txt must contain at least one route.", table.fileName);
  return routes;
}

function parseStops(table: CsvTable): StopRecord[] {
  const stops: StopRecord[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < table.rows.length; index += 1) {
    const row = table.rows[index];
    if (row === undefined) continue;
    const id = required(row, "stop_id", table, index);
    addUnique(ids, id, table, index, "stop_id");
    const latitude = coordinate(row.stop_lat ?? "", table, index, "stop_lat", -90, 90);
    const longitude = coordinate(row.stop_lon ?? "", table, index, "stop_lon", -180, 180);
    const locationType = row.location_type === undefined || row.location_type === "" ? 0 : integer(row.location_type, table, index, "location_type", 0, 4);
    if (locationType !== 0 && locationType !== 1) {
      throw new GtfsValidationError("Only location_type 0 boarding stops and 1 parent stations are supported.", table.fileName, index + 2);
    }
    const parentStationId = row.parent_station === undefined || row.parent_station === "" ? null : row.parent_station;
    if (locationType === 1 && parentStationId !== null) {
      throw new GtfsValidationError("A parent station cannot itself have parent_station.", table.fileName, index + 2);
    }
    stops.push({ id, name: required(row, "stop_name", table, index), latitude, longitude, locationType, parentStationId });
  }
  if (stops.length === 0) throw new GtfsValidationError("stops.txt must contain at least one stop.", table.fileName);
  return stops;
}

export const MODE_PRIORITY: Record<StationAreaMode, number> = {
  sbahn: 4,
  ubahn: 3,
  tram: 2,
  bus: 1,
};

export function routeTypeToMode(routeType: number): StationAreaMode {
  if (routeType === 2 || (routeType >= 100 && routeType <= 199)) return "sbahn";
  if (routeType === 1 || (routeType >= 400 && routeType <= 499)) return "ubahn";
  if (routeType === 0 || (routeType >= 900 && routeType <= 999)) return "tram";
  return "bus";
}

function highestStationMode(modes?: ReadonlySet<StationAreaMode>): StationAreaMode {
  if (!modes || modes.size === 0) return "bus";
  let highest: StationAreaMode = "bus";
  let highestRank = MODE_PRIORITY.bus;
  for (const mode of modes) {
    const rank = MODE_PRIORITY[mode];
    if (rank > highestRank) {
      highest = mode;
      highestRank = rank;
    }
  }
  return highest;
}

function deriveStationAreaModes(
  stopTimesTable: CsvTable,
  trips: readonly ScheduledTrip[],
  stops: readonly StopRecord[],
  routes: readonly ScheduledRoute[],
): ReadonlyMap<string, ReadonlySet<StationAreaMode>> {
  const tripById = new Map(trips.map((trip) => [trip.tripId, trip]));
  const stopById = new Map(stops.map((stop) => [stop.id, stop]));
  const routeById = new Map(routes.map((route) => [route.routeId, route]));
  const modesByArea = new Map<string, Set<StationAreaMode>>();

  for (const row of stopTimesTable.rows) {
    const tripId = row.trip_id;
    const stopId = row.stop_id;
    if (!tripId || !stopId) continue;
    const trip = tripById.get(tripId);
    const stop = stopById.get(stopId);
    if (!trip || !stop) continue;
    const route = routeById.get(trip.routeId);
    if (!route) continue;
    const areaId = stop.parentStationId ?? stop.id;
    const mode = routeTypeToMode(route.routeType);
    let areaModes = modesByArea.get(areaId);
    if (!areaModes) {
      areaModes = new Set<StationAreaMode>();
      modesByArea.set(areaId, areaModes);
    }
    areaModes.add(mode);
  }
  return modesByArea;
}

function createStationAreas(
  stops: readonly StopRecord[],
  modesByArea: ReadonlyMap<string, ReadonlySet<StationAreaMode>>,
): ScheduledStationArea[] {
  const byId = new Map(stops.map((stop) => [stop.id, stop]));
  const baseAreas: ScheduledStationArea[] = [];
  for (const stop of stops) {
    if (stop.locationType === 1) {
      const mode = highestStationMode(modesByArea.get(stop.id));
      baseAreas.push({ id: stop.id, name: stop.name, coordinate: coordinateOf(stop), mode, transferNeighbors: [] });
    }
  }
  for (const stop of stops) {
    if (stop.locationType !== 0) continue;
    const parent = stop.parentStationId === null ? null : byId.get(stop.parentStationId);
    if (stop.parentStationId !== null && (parent === null || parent === undefined || parent.locationType !== 1)) {
      throw new GtfsValidationError(`parent_station ${stop.parentStationId} does not identify a parent station.`, "stops.txt");
    }
    if (parent === null) {
      const mode = highestStationMode(modesByArea.get(stop.id));
      baseAreas.push({ id: stop.id, name: stop.name, coordinate: coordinateOf(stop), mode, transferNeighbors: [] });
    }
  }
  return attachTransferNeighbors(baseAreas);
}

/**
 * Precompute, at compile time, the transfer-neighbor list for every station area
 * within `TRANSFER_NEIGHBOR_RADIUS_METERS` (issue #76). The list is sorted by
 * station-area id and always includes the area itself with `distanceMeters: 0`,
 * matching the previous per-arrival spatial-query enumeration so routing results
 * are identical for any runtime radius up to the precomputed radius.
 */
function attachTransferNeighbors(areas: ScheduledStationArea[]): ScheduledStationArea[] {
  const index = buildAreaSpatialIndex(areas, TRANSFER_NEIGHBOR_RADIUS_METERS);
  return areas.map((area) => {
    const transferNeighbors: ScheduledTransferNeighbor[] = findAreasWithinRadius(index, area.coordinate, TRANSFER_NEIGHBOR_RADIUS_METERS).map((neighbor) => ({
      stationAreaId: neighbor.id,
      distanceMeters: haversineDistanceMeters(area.coordinate, neighbor.coordinate),
    }));
    return { ...area, transferNeighbors };
  });
}

function parseTrips(table: CsvTable, routes: readonly ScheduledRoute[]): ScheduledTrip[] {
  const routeIds = new Set(routes.map((route) => route.routeId));
  const ids = new Set<string>();
  const trips: ScheduledTrip[] = [];
  for (let index = 0; index < table.rows.length; index += 1) {
    const row = table.rows[index];
    if (row === undefined) continue;
    const tripId = required(row, "trip_id", table, index);
    addUnique(ids, tripId, table, index, "trip_id");
    const routeId = required(row, "route_id", table, index);
    if (!routeIds.has(routeId)) throw new GtfsValidationError(`Unknown route_id ${routeId}.`, table.fileName, index + 2);
    trips.push({ tripId, routeId, serviceId: required(row, "service_id", table, index), headsign: row.trip_headsign ?? "" });
  }
  if (trips.length === 0) throw new GtfsValidationError("trips.txt must contain at least one trip.", table.fileName);
  return trips;
}

function parseCalendars(table: CsvTable | null): ServiceCalendar[] {
  if (table === null) return [];
  const ids = new Set<string>();
  const calendars: ServiceCalendar[] = [];
  for (let index = 0; index < table.rows.length; index += 1) {
    const row = table.rows[index];
    if (row === undefined) continue;
    const serviceId = required(row, "service_id", table, index);
    addUnique(ids, serviceId, table, index, "service_id");
    const weekdays: [boolean, boolean, boolean, boolean, boolean, boolean, boolean] = [
      boolean01(row.monday ?? "", table, index, "monday"),
      boolean01(row.tuesday ?? "", table, index, "tuesday"),
      boolean01(row.wednesday ?? "", table, index, "wednesday"),
      boolean01(row.thursday ?? "", table, index, "thursday"),
      boolean01(row.friday ?? "", table, index, "friday"),
      boolean01(row.saturday ?? "", table, index, "saturday"),
      boolean01(row.sunday ?? "", table, index, "sunday"),
    ];
    const startDate = gtfsDate(required(row, "start_date", table, index), table, index);
    const endDate = gtfsDate(required(row, "end_date", table, index), table, index);
    if (startDate > endDate) throw new GtfsValidationError("start_date must not be after end_date.", table.fileName, index + 2);
    calendars.push({ serviceId, startDate, endDate, weekdays });
  }
  return calendars;
}

function parseExceptions(table: CsvTable | null): ServiceException[] {
  if (table === null) return [];
  const keys = new Set<string>();
  const exceptions: ServiceException[] = [];
  for (let index = 0; index < table.rows.length; index += 1) {
    const row = table.rows[index];
    if (row === undefined) continue;
    const serviceId = required(row, "service_id", table, index);
    const date = gtfsDate(required(row, "date", table, index), table, index);
    const exceptionType = integer(row.exception_type ?? "", table, index, "exception_type", 1, 2);
    const key = `${serviceId}:${date}`;
    if (keys.has(key)) throw new GtfsValidationError("Duplicate service exception.", table.fileName, index + 2);
    keys.add(key);
    exceptions.push({ serviceId, date, exceptionType: exceptionType === 1 ? 1 : 2 });
  }
  return exceptions;
}

function validateServices(
  trips: readonly ScheduledTrip[],
  calendars: readonly ServiceCalendar[],
  exceptions: readonly ServiceException[],
  calendarFilePresent: boolean,
): void {
  const calendarServiceIds = new Set(calendars.map((calendar) => calendar.serviceId));
  const additionServiceIds = new Set(exceptions.filter((exception) => exception.exceptionType === 1).map((exception) => exception.serviceId));
  const knownServiceIds = new Set([...calendarServiceIds, ...exceptions.map((exception) => exception.serviceId)]);
  for (const trip of trips) {
    if (!knownServiceIds.has(trip.serviceId)) throw new GtfsValidationError(`Trip ${trip.tripId} references unknown service_id ${trip.serviceId}.`, "trips.txt");
    const hasPotentialCalendarService = calendars.some((calendar) => calendar.serviceId === trip.serviceId && calendarHasActiveDate(calendar, exceptions));
    if (!hasPotentialCalendarService && !additionServiceIds.has(trip.serviceId)) {
      throw new GtfsValidationError(`Trip ${trip.tripId} has no active calendar date or activating calendar_dates addition for service_id ${trip.serviceId}; no routable interval exists.`, "trips.txt");
    }
    if (!calendarFilePresent && !additionServiceIds.has(trip.serviceId)) {
      throw new GtfsValidationError(`calendar.txt is absent and service_id ${trip.serviceId} has only removal exceptions.`, "calendar_dates.txt");
    }
  }
}

interface AreaVisit {
  readonly areaId: string;
  readonly visitIndex: number;
  readonly departureTimeSeconds: number;
  readonly arrivalTimeSeconds: number;
  readonly hasPickup: boolean;
  readonly hasDropoff: boolean;
}

function parseConnections(
  table: CsvTable,
  trips: readonly ScheduledTrip[],
  stops: readonly StopRecord[],
  routes: readonly ScheduledRoute[],
): ScheduledConnection[] {
  const tripById = new Map(trips.map((trip) => [trip.tripId, trip]));
  const stopById = new Map(stops.filter((stop) => stop.locationType === 0).map((stop) => [stop.id, stop]));
  const routeById = new Map(routes.map((route) => [route.routeId, route]));
  const rowsByTrip = new Map<string, StopTimeRecord[]>();
  const seenKeys = new Set<string>();
  for (let index = 0; index < table.rows.length; index += 1) {
    const row = table.rows[index];
    if (row === undefined) continue;
    const tripId = required(row, "trip_id", table, index);
    if (!tripById.has(tripId)) throw new GtfsValidationError(`Unknown trip_id ${tripId}.`, table.fileName, index + 2);
    const stopId = required(row, "stop_id", table, index);
    if (!stopById.has(stopId)) throw new GtfsValidationError(`stop_id ${stopId} is not a boarding stop.`, table.fileName, index + 2);
    const stopSequence = integer(row.stop_sequence ?? "", table, index, "stop_sequence", 1, Number.MAX_SAFE_INTEGER);
    const key = `${tripId}:${stopSequence}`;
    if (seenKeys.has(key)) throw new GtfsValidationError("stop_sequence must be unique within a trip.", table.fileName, index + 2);
    seenKeys.add(key);
    const arrivalTimeSeconds = gtfsTime(required(row, "arrival_time", table, index), table, index, "arrival_time");
    const departureTimeSeconds = gtfsTime(required(row, "departure_time", table, index), table, index, "departure_time");
    if (arrivalTimeSeconds > departureTimeSeconds) throw new GtfsValidationError("arrival_time must not be after departure_time.", table.fileName, index + 2);
    const pickupType = pickupDropOff(row.pickup_type ?? "0", table, index, "pickup_type");
    const dropOffType = pickupDropOff(row.drop_off_type ?? "0", table, index, "drop_off_type");
    const stopTime: StopTimeRecord = { tripId, arrivalTimeSeconds, departureTimeSeconds, stopId, stopSequence, pickupType, dropOffType };
    const current = rowsByTrip.get(tripId) ?? [];
    current.push(stopTime);
    rowsByTrip.set(tripId, current);
  }

  const connections: ScheduledConnection[] = [];
  for (const trip of trips) {
    const stopTimes = [...(rowsByTrip.get(trip.tripId) ?? [])].sort((left, right) => left.stopSequence - right.stopSequence);
    if (stopTimes.length < 2) throw new GtfsValidationError(`Trip ${trip.tripId} must have at least two stop_times rows.`, table.fileName);
    for (let index = 1; index < stopTimes.length; index += 1) {
      const previous = stopTimes[index - 1];
      const current = stopTimes[index];
      if (previous === undefined || current === undefined) continue;
      if (previous.departureTimeSeconds > current.arrivalTimeSeconds) {
        throw new GtfsValidationError(`Stop-time connection is not chronological for trip ${trip.tripId}.`, table.fileName);
      }
    }
    const route = routeById.get(trip.routeId);
    if (route === undefined) throw new Error("Trip route disappeared during connection assembly.");
    const visits = groupTripIntoAreaVisits(stopTimes, stopById);
    for (let index = 1; index < visits.length; index += 1) {
      const previous = visits[index - 1];
      const current = visits[index];
      if (previous === undefined || current === undefined) continue;
      connections.push({
        id: `${trip.tripId}:${previous.visitIndex}-${current.visitIndex}`,
        tripId: trip.tripId,
        routeId: trip.routeId,
        serviceId: trip.serviceId,
        fromStationAreaId: previous.areaId,
        toStationAreaId: current.areaId,
        fromStopSequence: previous.visitIndex,
        toStopSequence: current.visitIndex,
        departureTimeSeconds: previous.departureTimeSeconds,
        arrivalTimeSeconds: current.arrivalTimeSeconds,
        pickupType: previous.hasPickup ? 0 : 1,
        dropOffType: current.hasDropoff ? 0 : 1,
        line: route,
      });
    }
  }
  return connections;
}

function groupTripIntoAreaVisits(
  stopTimes: readonly StopTimeRecord[],
  stopById: ReadonlyMap<string, StopRecord>,
): AreaVisit[] {
  const visits: AreaVisit[] = [];
  let currentStops: StopTimeRecord[] = [];
  let currentAreaId: string | null = null;
  for (const stopTime of stopTimes) {
    const stop = stopById.get(stopTime.stopId);
    if (stop === undefined) throw new Error("Stop-time references a missing boarding stop.");
    const areaId = stop.parentStationId ?? stop.id;
    if (currentAreaId === null) {
      currentAreaId = areaId;
    } else if (areaId !== currentAreaId) {
      visits.push(buildAreaVisit(currentStops, currentAreaId, visits.length));
      currentStops = [];
      currentAreaId = areaId;
    }
    currentStops.push(stopTime);
  }
  if (currentAreaId !== null) visits.push(buildAreaVisit(currentStops, currentAreaId, visits.length));
  return visits;
}

function buildAreaVisit(stopTimes: readonly StopTimeRecord[], areaId: string, visitIndex: number): AreaVisit {
  let departureTimeSeconds: number | null = null;
  let arrivalTimeSeconds: number | null = null;
  let hasPickup = false;
  let hasDropoff = false;
  for (const stopTime of stopTimes) {
    if (stopTime.pickupType === 0) {
      hasPickup = true;
      if (departureTimeSeconds === null || stopTime.departureTimeSeconds < departureTimeSeconds) departureTimeSeconds = stopTime.departureTimeSeconds;
    }
    if (stopTime.dropOffType === 0) {
      hasDropoff = true;
      if (arrivalTimeSeconds === null || stopTime.arrivalTimeSeconds < arrivalTimeSeconds) arrivalTimeSeconds = stopTime.arrivalTimeSeconds;
    }
  }
  // A visit with no boardable/alightable stop still carries the trip's
  // through-movement times so consecutive connections stay chronological and
  // the trip remains continuable past the area.
  if (departureTimeSeconds === null) departureTimeSeconds = Math.min(...stopTimes.map((stopTime) => stopTime.departureTimeSeconds));
  if (arrivalTimeSeconds === null) arrivalTimeSeconds = Math.min(...stopTimes.map((stopTime) => stopTime.arrivalTimeSeconds));
  return { areaId, visitIndex, departureTimeSeconds, arrivalTimeSeconds, hasPickup, hasDropoff };
}

function createProvenance(
  files: GtfsFeedFiles,
  fileNames: readonly string[],
  feedId: string,
  timeZone: string,
  acquisition: GtfsAcquisitionRecord,
  compiledPayload: ScheduledArtifactCore,
): ScheduledArtifactProvenance {
  const fileProvenance: GtfsFileProvenance[] = fileNames.map((fileName) => {
    const content = files[fileName];
    if (content === undefined) throw new Error("GTFS file disappeared during hashing.");
    return { fileName, sha256: sha256(content), byteLength: Buffer.byteLength(content, "utf8") };
  });
  const contentHash = calculateScheduledContentHash(feedId, timeZone, fileProvenance);
  const identity: ScheduledArtifactIdentityProvenance = { hashAlgorithm: "sha256", contentHash, feedId, timeZone, files: fileProvenance, acquisition };
  const compiledArtifactId = calculateScheduledCompiledArtifactId(compiledPayload, identity);
  return { ...identity, compiledArtifactId };
}

function deriveServiceDateRange(
  calendars: readonly ServiceCalendar[],
  exceptions: readonly ServiceException[],
  trips: readonly ScheduledTrip[],
): { readonly firstDate: string; readonly lastDate: string } {
  const serviceIds = new Set(trips.map((trip) => trip.serviceId));
  const dates = [
    ...calendars.filter((calendar) => serviceIds.has(calendar.serviceId)).flatMap((calendar) => calendarActiveBoundaryDates(calendar, exceptions)),
    ...exceptions.filter((exception) => serviceIds.has(exception.serviceId) && exception.exceptionType === 1).map((exception) => exception.date),
  ].sort();
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  if (firstDate === undefined || lastDate === undefined) throw new GtfsValidationError("The feed contains no service dates.");
  return { firstDate, lastDate };
}

function maximumConnectionTimeSeconds(connections: readonly ScheduledConnection[]): number {
  let maximum = 0;
  for (const connection of connections) {
    maximum = Math.max(maximum, connection.departureTimeSeconds, connection.arrivalTimeSeconds);
  }
  return maximum;
}

function calendarActiveBoundaryDates(calendar: ServiceCalendar, exceptions: readonly ServiceException[]): readonly string[] {
  let firstDate: string | null = null;
  let lastDate: string | null = null;
  let current = calendar.startDate;
  while (current <= calendar.endDate) {
    if (calendarDateHasBaseService(calendar, current, exceptions)) {
      firstDate = current;
      break;
    }
    current = addServiceDays(current, 1);
  }
  current = calendar.endDate;
  while (current >= calendar.startDate) {
    if (calendarDateHasBaseService(calendar, current, exceptions)) {
      lastDate = current;
      break;
    }
    current = addServiceDays(current, -1);
  }
  if (firstDate === null || lastDate === null) return [];
  return firstDate === lastDate ? [firstDate] : [firstDate, lastDate];
}

function calendarHasActiveDate(calendar: ServiceCalendar, exceptions: readonly ServiceException[]): boolean {
  return calendarActiveBoundaryDates(calendar, exceptions).length > 0;
}

function calendarDateHasBaseService(calendar: ServiceCalendar, serviceDate: string, exceptions: readonly ServiceException[]): boolean {
  const date = new Date(`${serviceDate}T00:00:00Z`).getUTCDay();
  const weekdayIndex = date === 0 ? 6 : date - 1;
  if (calendar.weekdays[weekdayIndex] !== true) return false;
  const exception = exceptions.find((candidate) => candidate.serviceId === calendar.serviceId && candidate.date === serviceDate);
  return exception?.exceptionType !== 2;
}

function deriveSearchStartBounds(
  serviceDateRange: { readonly firstDate: string; readonly lastDate: string },
  maximumServiceDayTimeSeconds: number,
  timeZone: string,
): ScheduledSearchStartBounds {
  const firstAnchor = serviceDateAnchorEpochSeconds(serviceDateRange.firstDate, timeZone);
  const previousAnchor = serviceDateAnchorEpochSeconds(addServiceDays(serviceDateRange.firstDate, -1), timeZone);
  const followingAnchor = serviceDateAnchorEpochSeconds(addServiceDays(serviceDateRange.lastDate, 1), timeZone);
  const earliestEpochSeconds = Math.max(firstAnchor, previousAnchor + maximumServiceDayTimeSeconds + 1);
  const latestEpochSeconds = followingAnchor - 86_400 - 1;
  if (latestEpochSeconds < earliestEpochSeconds) throw new GtfsValidationError("The feed has no valid 24-hour routable search interval.");
  return {
    earliestEpochSeconds,
    latestEpochSeconds,
    earliestAt: formatEpochSeconds(earliestEpochSeconds),
    latestAt: formatEpochSeconds(latestEpochSeconds),
    maximumServiceDayTimeSeconds,
  };
}

/** The persisted connection order used by import, validation, and CSA scans. */
export function compareScheduledConnections(left: ScheduledConnection, right: ScheduledConnection): number {
  return left.departureTimeSeconds - right.departureTimeSeconds || left.arrivalTimeSeconds - right.arrivalTimeSeconds || left.serviceId.localeCompare(right.serviceId) || left.tripId.localeCompare(right.tripId) || left.fromStopSequence - right.fromStopSequence || left.toStopSequence - right.toStopSequence || left.id.localeCompare(right.id);
}

function sortByKey<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => compareScheduledIds(key(left), key(right)));
}

function coordinateOf(stop: StopRecord): { readonly latitude: number; readonly longitude: number } {
  return { latitude: stop.latitude, longitude: stop.longitude };
}

function required(row: Record<string, string>, column: string, table: CsvTable, index: number): string {
  const value = row[column];
  if (value === undefined || value === "") throw new GtfsValidationError(`Required value ${column} is empty.`, table.fileName, index + 2);
  return value;
}

function validateNonEmpty(value: string, label: string): void {
  if (value.trim() === "") throw new RangeError(`${label} must not be empty.`);
}

function normalizeAcquisition(acquisition: GtfsAcquisitionRecord | undefined): GtfsAcquisitionRecord {
  if (acquisition === undefined) throw new RangeError("An explicit GTFS acquisition record is required.");
  validateNonEmpty(acquisition.sourceUrl, "acquisition.sourceUrl");
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(acquisition.sourceUrl);
  } catch {
    throw new RangeError("acquisition.sourceUrl must be an absolute URL.");
  }
  if (sourceUrl.protocol !== "https:" && sourceUrl.protocol !== "http:") throw new RangeError("acquisition.sourceUrl must use HTTP or HTTPS.");
  parseOffsetInstant(acquisition.retrievedAt, "Europe/Berlin");
  if (!Number.isSafeInteger(acquisition.rawArchiveByteSize) || acquisition.rawArchiveByteSize < 0) throw new RangeError("acquisition.rawArchiveByteSize must be a non-negative safe integer.");
  if (!/^[0-9a-f]{64}$/.test(acquisition.rawArchiveSha256)) throw new RangeError("acquisition.rawArchiveSha256 must be a lowercase SHA-256 hex digest.");
  validateNonEmpty(acquisition.feedVersion, "acquisition.feedVersion");
  const validFrom = acquisitionDate(acquisition.feedValidFrom, "acquisition.feedValidFrom");
  const validUntil = acquisitionDate(acquisition.feedValidUntil, "acquisition.feedValidUntil");
  if (validFrom > validUntil) throw new RangeError("acquisition feed validity start must not be after its end.");
  validateNonEmpty(acquisition.attribution, "acquisition.attribution");
  validateNonEmpty(acquisition.officialAttribution, "acquisition.officialAttribution");
  validateNonEmpty(acquisition.officialLicense.name, "acquisition.officialLicense.name");
  let officialLicenseUrl: URL;
  try {
    officialLicenseUrl = new URL(acquisition.officialLicense.url);
  } catch {
    throw new RangeError("acquisition.officialLicense.url must be an absolute URL.");
  }
  if (officialLicenseUrl.protocol !== "https:") throw new RangeError("acquisition.officialLicense.url must use HTTPS.");
  if (acquisition.officialProvenance.source === "feed" && acquisition.officialProvenance.policyId !== null) throw new RangeError("acquisition.officialProvenance must not combine feed metadata with a policy id.");
  if (acquisition.officialProvenance.source === "meeet-policy" && acquisition.officialProvenance.policyId !== "mvv-cc-by-4.0-fallback/v1") throw new RangeError("acquisition.officialProvenance policy id is unsupported.");
  return { ...acquisition, feedValidFrom: validFrom, feedValidUntil: validUntil };
}

function acquisitionDate(value: string, label: string): string {
  const normalized = /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new RangeError(`${label} must use YYYY-MM-DD or YYYYMMDD.`);
  const [yearText, monthText, dayText] = normalized.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new RangeError(`${label} is not a valid date.`);
  return normalized;
}

function addUnique(set: Set<string>, value: string, table: CsvTable, index: number, column: string): void {
  if (set.has(value)) throw new GtfsValidationError(`Duplicate ${column} ${value}.`, table.fileName, index + 2);
  set.add(value);
}

function integer(value: string, table: CsvTable, index: number, column: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) throw new GtfsValidationError(`${column} must be an integer.`, table.fileName, index + 2);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new GtfsValidationError(`${column} is outside its supported range.`, table.fileName, index + 2);
  return result;
}

function coordinate(value: string, table: CsvTable, index: number, column: string, minimum: number, maximum: number): number {
  if (value === "" || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) throw new GtfsValidationError(`${column} must be a decimal coordinate.`, table.fileName, index + 2);
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new GtfsValidationError(`${column} is outside coordinate bounds.`, table.fileName, index + 2);
  return result;
}

function boolean01(value: string, table: CsvTable, index: number, column: string): boolean {
  if (value !== "0" && value !== "1") throw new GtfsValidationError(`${column} must be 0 or 1.`, table.fileName, index + 2);
  return value === "1";
}

function gtfsDate(value: string, table: CsvTable, index: number): string {
  if (!/^\d{8}$/.test(value)) throw new GtfsValidationError("Date must use YYYYMMDD.", table.fileName, index + 2);
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new GtfsValidationError("Date is not a real calendar date.", table.fileName, index + 2);
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

/**
 * The scheduled calculation is minute-aligned end to end, so sub-minute
 * seconds are truncated to the minute instead of rejecting the row: real
 * feeds carry non-zero seconds, but the artifact must stay minute-aligned.
 */
function gtfsTime(value: string, table: CsvTable, index: number, column: string): number {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new GtfsValidationError(`${column} must use HH:MM:SS.`, table.fileName, index + 2);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59 || hours > 99) throw new GtfsValidationError(`${column} is outside the supported GTFS time range.`, table.fileName, index + 2);
  return hours * 3_600 + minutes * 60;
}

function pickupDropOff(value: string, table: CsvTable, index: number, column: string): GtfsPickupDropOffType {
  const result = integer(value, table, index, column, 0, 3);
  if (result === 0 || result === 1) return result;
  throw new GtfsValidationError(`${column} uses unsupported on-demand or conditional semantics; only 0 and 1 are routable.`, table.fileName, index + 2);
}

function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new RangeError(`Unknown IANA time zone: ${timeZone}`);
  }
}

function formatEpochSeconds(epochSeconds: number): string {
  if (!Number.isSafeInteger(epochSeconds)) throw new RangeError("Epoch is outside the safe integer-second range.");
  return new Date(epochSeconds * 1_000).toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Canonical(value: unknown): string {
  const hash = createHash("sha256");
  writeCanonicalJson(hash, value);
  return hash.digest("hex");
}

function writeCanonicalJson(hash: Hash, value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("Cannot hash an unsupported provenance value.");
    hash.update(encoded, "utf8");
    return;
  }
  if (Array.isArray(value)) {
    hash.update("[", "utf8");
    value.forEach((entry, index) => {
      if (index > 0) hash.update(",", "utf8");
      writeCanonicalJson(hash, entry);
    });
    hash.update("]", "utf8");
    return;
  }
  if (typeof value === "object" && value !== null) {
    hash.update("{", "utf8");
    Object.keys(value).sort((left, right) => left.localeCompare(right)).forEach((key, index) => {
      if (index > 0) hash.update(",", "utf8");
      hash.update(JSON.stringify(key), "utf8");
      hash.update(":", "utf8");
      writeCanonicalJson(hash, (value as Record<string, unknown>)[key]);
    });
    hash.update("}", "utf8");
    return;
  }
  throw new TypeError("Cannot hash an unsupported provenance value.");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) {
      for (const child of value) deepFreeze(child);
    } else {
      for (const child of Object.values(value)) deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

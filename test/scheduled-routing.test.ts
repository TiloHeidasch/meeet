import assert from "node:assert/strict";
import test from "node:test";

import {
  addServiceDays,
  calculateScheduledSurface,
  compareScheduledConnections,
  importGtfsSchedule,
  isScheduledToleranceSatisfied,
  parseOffsetInstant,
  routeScheduledEarliestArrivals,
  createScheduledRoutingWindow,
  serviceDateRangeForSearch,
  serviceDateAnchorEpochSeconds,
  serviceDateForEpochSeconds,
  serviceDateSecondsToEpochSeconds,
  type GtfsFeedFiles,
  type ScheduledMaterializedConnection,
  type ScheduledRoutingArtifact,
} from "../lib/domain/scheduled-routing/index.ts";
import {
  createScheduledSurfaceGrid,
  deriveInteriorRepresentativePoint,
  isScheduledInteriorRepresentativePoint,
} from "../lib/domain/scheduled-routing/grid.ts";
import type { GeoJsonMultiPolygon } from "../lib/domain/types.ts";
import { ScheduledCalculationDeadlineError } from "../lib/domain/scheduled-admission.ts";

const SEARCH_START = "2026-08-11T08:05:00+02:00";

function deadlineAtPhase(target: string): (phase?: string) => void {
  return (phase?: string): void => {
    if (phase === target) throw new ScheduledCalculationDeadlineError(`deadline-${target}`);
  };
}

const ACQUISITION = {
  sourceUrl: "https://example.test/mvv-feed.zip",
  retrievedAt: "2026-08-11T10:00:00Z",
  rawArchiveByteSize: 12_345,
  rawArchiveSha256: "a".repeat(64),
  feedVersion: "fixture-2026-08",
  feedValidFrom: "2026-08-09",
  feedValidUntil: "2026-08-16",
  attribution: "Fixture Transit Publisher",
  officialAttribution: "Fixture Transit Publisher",
  officialLicense: { name: "Fixture License", url: "https://example.test/license" },
  officialProvenance: { source: "feed", policyId: null } as const,
};

const FIXTURE_FILES: GtfsFeedFiles = {
  "agency.txt": [
    "agency_id,agency_name,agency_url,agency_timezone",
    "fixture-agency,Fixture Transit,https://example.test,Europe/Berlin",
  ].join("\n"),
  "routes.txt": [
    "route_id,route_short_name,route_long_name,route_type",
    "red,R,Red line,1",
    "blue,B,Blue line,1",
  ].join("\n"),
  "stops.txt": [
    "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
    "station-a,Station A,48.1000,11.5000,1,",
    "a-1,Station A platform,48.1000,11.5000,0,station-a",
    "station-b,Station B,48.1000,11.5100,1,",
    "b-1,Station B platform 1,48.1000,11.5100,0,station-b",
    "b-2,Station B platform 2,48.1002,11.5100,0,station-b",
    "station-c,Station C,48.1000,11.5200,1,",
    "c-1,Station C platform,48.1000,11.5200,0,station-c",
    "station-unreachable,Unreachable,48.1000,11.5300,1,",
    "u-1,Unreachable platform,48.1000,11.5300,0,station-unreachable",
  ].join("\n"),
  "trips.txt": [
    "route_id,service_id,trip_id,trip_headsign",
    "red,weekday,through,Station C",
    "red,weekday,fast,Station C",
    "blue,weekday,transfer,Station C",
    "blue,sunday,sunday-trip,Station B",
    "red,weekday,midnight,Station B",
  ].join("\n"),
  "stop_times.txt": [
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type",
    "through,08:10:00,08:10:00,a-1,1,0,0",
    "through,08:20:00,08:21:00,b-1,2,0,0",
    "through,08:30:00,08:30:00,c-1,3,0,0",
    "fast,08:12:00,08:12:00,a-1,1,0,0",
    "fast,08:18:00,08:19:00,b-1,2,0,0",
    "fast,08:25:00,08:25:00,c-1,3,0,0",
    "transfer,08:25:00,08:25:00,b-2,1,0,0",
    "transfer,08:35:00,08:35:00,c-1,2,0,0",
    "sunday-trip,08:00:00,08:00:00,c-1,1,0,0",
    "sunday-trip,08:10:00,08:10:00,b-1,2,0,0",
    "midnight,23:55:00,23:55:00,a-1,1,0,0",
    "midnight,24:10:00,24:10:00,b-1,2,0,0",
  ].join("\n"),
  "calendar.txt": [
    "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
    "weekday,1,1,1,1,1,1,1,20260809,20260816",
    "sunday,0,0,0,0,0,0,1,20260809,20260816",
  ].join("\n"),
  "calendar_dates.txt": [
    "service_id,date,exception_type",
    "weekday,20260810,2",
    "sunday,20260809,1",
  ].join("\n"),
};

function fixture() {
  return importGtfsSchedule(FIXTURE_FILES, { feedId: "fixture-feed", timeZone: "Europe/Berlin", acquisition: ACQUISITION });
}

function withoutFile(files: GtfsFeedFiles, fileName: string): GtfsFeedFiles {
  const copy: Record<string, string> = { ...files };
  delete copy[fileName];
  return copy;
}

function importFixtureFiles(files: GtfsFeedFiles) {
  return importGtfsSchedule(files, { acquisition: ACQUISITION });
}

function activeServiceSpanFixture(firstDate: string, lastDate: string): GtfsFeedFiles {
  return {
    ...withoutFile(FIXTURE_FILES, "calendar_dates.txt"),
    "trips.txt": FIXTURE_FILES["trips.txt"].replace("sunday,", "weekday,"),
    "calendar.txt": [
      "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
      `weekday,1,1,1,1,1,1,1,${firstDate},${lastDate}`,
    ].join("\n"),
  };
}

function overlappingStreamFixture(firstDate: string, lastDate: string): GtfsFeedFiles {
  return {
    ...withoutFile(FIXTURE_FILES, "calendar_dates.txt"),
    "trips.txt": "route_id,service_id,trip_id\nred,weekday,late\nblue,weekday,early",
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "late,23:50:00,23:50:00,a-1,1",
      "late,24:00:00,24:00:00,b-1,2",
      "early,00:10:00,00:10:00,a-1,1",
      "early,00:20:00,00:20:00,b-1,2",
    ].join("\n"),
    "calendar.txt": [
      "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
      `weekday,1,1,1,1,1,1,1,${firstDate},${lastDate}`,
    ].join("\n"),
  };
}

function referenceMaterializeConnections(schedule: ScheduledRoutingArtifact, searchStartAt: string): ScheduledMaterializedConnection[] {
  const searchStartEpochSeconds = parseOffsetInstant(searchStartAt, schedule.timeZone).epochSeconds;
  const horizonEndEpochSeconds = searchStartEpochSeconds + 86_400;
  const [firstCandidateDate, lastCandidateDate] = serviceDateRangeForSearch(searchStartEpochSeconds, schedule.timeZone, schedule.maximumServiceDayTimeSeconds);
  const results: ScheduledMaterializedConnection[] = [];
  let serviceDate = firstCandidateDate;
  while (serviceDate <= lastCandidateDate) {
    const activeServiceIds = referenceActiveServiceIds(schedule, serviceDate);
    const previousByTrip = new Map<string, ScheduledRoutingArtifact["connections"][number]>();
    const includedKeys = new Set<string>();
    for (const source of schedule.connections) {
      if (!activeServiceIds.has(source.serviceId)) continue;
      const departureEpochSeconds = serviceDateSecondsToEpochSeconds(serviceDate, source.departureTimeSeconds, schedule.timeZone);
      const arrivalEpochSeconds = serviceDateSecondsToEpochSeconds(serviceDate, source.arrivalTimeSeconds, schedule.timeZone);
      const connectionKey = `${serviceDate}:${source.tripId}:${source.fromStopSequence}`;
      if (departureEpochSeconds < searchStartEpochSeconds || departureEpochSeconds > horizonEndEpochSeconds || arrivalEpochSeconds > horizonEndEpochSeconds) {
        previousByTrip.set(source.tripId, source);
        continue;
      }
      const previous = previousByTrip.get(source.tripId);
      const previousKey = previous === undefined ? null : `${serviceDate}:${previous.tripId}:${previous.fromStopSequence}`;
      results.push({
        instanceId: connectionKey,
        serviceDate,
        source,
        departureEpochSeconds,
        arrivalEpochSeconds,
        connectionKey,
        previousContinuationKey: previousKey !== null && includedKeys.has(previousKey) ? previousKey : null,
      });
      includedKeys.add(connectionKey);
      previousByTrip.set(source.tripId, source);
    }
    serviceDate = addServiceDays(serviceDate, 1);
  }
  return results.sort(compareReferenceMaterializedConnections);
}

function referenceActiveServiceIds(schedule: ScheduledRoutingArtifact, serviceDate: string): Set<string> {
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

function compareReferenceMaterializedConnections(left: ScheduledMaterializedConnection, right: ScheduledMaterializedConnection): number {
  return left.departureEpochSeconds - right.departureEpochSeconds || compareScheduledConnections(left.source, right.source) || left.arrivalEpochSeconds - right.arrivalEpochSeconds || left.instanceId.localeCompare(right.instanceId);
}

test("GTFS import validates station areas, IDs, coordinates, columns, and freezes provenance", () => {
  const schedule = fixture();
  assert.equal(schedule.stationAreas.find((area) => area.id === "station-b")?.boardingStopIds.length, 2);
  assert.equal(schedule.boardingStops.find((stop) => stop.id === "b-1")?.stationAreaId, "station-b");
  assert.equal(schedule.connections[0]?.departureTimeSeconds, 28_800);
  assert.equal(schedule.provenance.hashAlgorithm, "sha256");
  assert.equal(schedule.provenance.contentHash, fixture().provenance.contentHash);
  assert.deepEqual(schedule.provenance.acquisition, ACQUISITION);
  assert.equal(schedule.provenance.acquisition.rawArchiveSha256, "a".repeat(64));
  assert.equal(schedule.provenance.compiledArtifactId, fixture().provenance.compiledArtifactId);
  const changedCompiled = importFixtureFiles({ ...FIXTURE_FILES, "routes.txt": FIXTURE_FILES["routes.txt"].replace("Red line", "Red line changed") });
  assert.notEqual(schedule.provenance.compiledArtifactId, changedCompiled.provenance.compiledArtifactId);
  assert.notEqual(schedule.provenance.compiledArtifactId, ACQUISITION.rawArchiveSha256);
  assert.equal(Object.isFrozen(schedule), true);
  assert.equal(Object.isFrozen(schedule.connections), true);
  assert.throws(() => Reflect.apply(Array.prototype.push, schedule.connections, [schedule.connections[0]]), TypeError);

  const missingColumn = { ...FIXTURE_FILES, "routes.txt": "route_id\nred" };
  assert.throws(() => importFixtureFiles(missingColumn), /route_type/);
  const badCoordinate = { ...FIXTURE_FILES, "stops.txt": FIXTURE_FILES["stops.txt"].replace("48.1000,11.5000,1", "91.0000,11.5000,1") };
  assert.throws(() => importFixtureFiles(badCoordinate), /coordinate bounds/);
  const badParent = { ...FIXTURE_FILES, "stops.txt": FIXTURE_FILES["stops.txt"].replace("station-b\n", "missing-parent\n") };
  assert.throws(() => importFixtureFiles(badParent), /parent_station/);
});

test("GTFS importer accepts a BOM immediately before a quoted header and quoted CSV values", () => {
  const bomQuotedFiles: GtfsFeedFiles = {
    "agency.txt": "\uFEFF\"agency_id\",\"agency_name\",\"agency_url\",\"agency_timezone\"\n\"bom-agency\",\"BOM Agency\",\"https://example.test\",\"Europe/Berlin\"",
    "routes.txt": "\uFEFF\"route_id\",\"route_short_name\",\"route_type\"\n\"bom-route\",\"BOM\",\"3\"",
    "stops.txt": "\uFEFF\"stop_id\",\"stop_name\",\"stop_lat\",\"stop_lon\",\"location_type\",\"parent_station\"\n\"bom-a\",\"BOM A\",\"48.1000\",\"11.5000\",\"1\",\n\"bom-a-stop\",\"BOM A platform\",\"48.1000\",\"11.5000\",\"0\",\"bom-a\"\n\"bom-b\",\"BOM B\",\"48.1010\",\"11.5010\",\"1\",\n\"bom-b-stop\",\"BOM B platform\",\"48.1010\",\"11.5010\",\"0\",\"bom-b\"",
    "trips.txt": "\uFEFF\"route_id\",\"service_id\",\"trip_id\"\n\"bom-route\",\"bom-service\",\"bom-trip\"",
    "stop_times.txt": "\uFEFF\"trip_id\",\"arrival_time\",\"departure_time\",\"stop_id\",\"stop_sequence\"\n\"bom-trip\",\"08:00:00\",\"08:00:00\",\"bom-a-stop\",\"1\"\n\"bom-trip\",\"08:10:00\",\"08:10:00\",\"bom-b-stop\",\"2\"",
    "calendar.txt": "\uFEFF\"service_id\",\"monday\",\"tuesday\",\"wednesday\",\"thursday\",\"friday\",\"saturday\",\"sunday\",\"start_date\",\"end_date\"\n\"bom-service\",\"1\",\"1\",\"1\",\"1\",\"1\",\"1\",\"1\",\"20260809\",\"20260816\"",
  };
  const schedule = importGtfsSchedule(bomQuotedFiles, { acquisition: ACQUISITION });
  assert.equal(schedule.routes[0]?.routeId, "bom-route");
  assert.equal(schedule.routes[0]?.shortName, "BOM");
});

test("GTFS parser rejects non-chronological connections and accepts HH:MM:SS next-day rollover", () => {
  const badTimes = { ...FIXTURE_FILES, "stop_times.txt": FIXTURE_FILES["stop_times.txt"].replace("08:30:00,08:30:00,c-1,3", "08:19:00,08:30:00,c-1,3") };
  assert.throws(() => importFixtureFiles(badTimes), /chronological/);
  const schedule = fixture();
  const midnight = schedule.connections.find((connection) => connection.id === "midnight:1-2");
  assert.equal(midnight?.arrivalTimeSeconds, 24 * 3_600 + 10 * 60);
});

test("router scans the persisted connection template without sorting a cloned full array", () => {
  const schedule = fixture();
  const originalSort = Array.prototype.sort;
  let templateSortAttempted = false;
  Array.prototype.sort = function (this: unknown[], compareFn?: (left: unknown, right: unknown) => number): unknown[] {
    if (this.some((entry) => typeof entry === "object" && entry !== null && ("departureTimeSeconds" in entry || ("source" in entry && typeof entry.source === "object" && entry.source !== null && "departureTimeSeconds" in entry.source)))) templateSortAttempted = true;
    return originalSort.call(this, compareFn as ((left: unknown, right: unknown) => number) | undefined);
  } as typeof Array.prototype.sort;
  try {
    routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  } finally {
    Array.prototype.sort = originalSort;
  }
  assert.equal(templateSortAttempted, false);
});

test("routing-window materialization calculates one anchor per candidate service date", () => {
  const candidateDates: string[] = [];
  const anchors: string[] = [];
  createScheduledRoutingWindow(fixture(), SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 }, {
    onCandidateServiceDate: (serviceDate: string) => candidateDates.push(serviceDate),
    serviceDateAnchor: (serviceDate: string, timeZone: string) => {
      anchors.push(serviceDate);
      return serviceDateAnchorEpochSeconds(serviceDate, timeZone);
    },
  });
  assert.ok(candidateDates.length > 0);
  assert.deepEqual(anchors, candidateDates);
  assert.equal(new Set(anchors).size, anchors.length);
});

test("lazy date streams and heap merge are reference-equivalent across normal and DST-overlapping windows", () => {
  const normalSchedule = importGtfsSchedule(overlappingStreamFixture("20260811", "20260812"), { acquisition: { ...ACQUISITION, feedValidFrom: "2026-08-11", feedValidUntil: "2026-08-12" } });
  const springSchedule = importGtfsSchedule(overlappingStreamFixture("20260329", "20260330"), {
    acquisition: { ...ACQUISITION, feedValidFrom: "2026-03-29", feedValidUntil: "2026-03-30" },
  });
  const fallSchedule = importGtfsSchedule(overlappingStreamFixture("20261025", "20261026"), {
    acquisition: { ...ACQUISITION, feedValidFrom: "2026-10-25", feedValidUntil: "2026-10-26" },
  });
  const cases = [
    { schedule: normalSchedule, searchStartAt: "2026-08-11T23:40:00+02:00" },
    { schedule: springSchedule, searchStartAt: "2026-03-29T22:40:00+02:00" },
    { schedule: fallSchedule, searchStartAt: "2026-10-25T22:40:00+01:00" },
  ];
  for (const { schedule, searchStartAt } of cases) {
    const actual = createScheduledRoutingWindow(schedule, searchStartAt, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 }).connections;
    assert.deepEqual(actual, referenceMaterializeConnections(schedule, searchStartAt));
    assert.ok(new Set(actual.map((connection) => connection.serviceDate)).size >= 2, `${searchStartAt}: ${[...new Set(actual.map((connection) => connection.serviceDate))].join(",")}`);
    for (let index = 1; index < actual.length; index += 1) assert.ok(compareReferenceMaterializedConnections(actual[index - 1]!, actual[index]!) <= 0);
  }
});

test("connection scan includes scheduled waiting and same-trip continuation, while honoring restrictions", () => {
  const schedule = fixture();
  const result = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], SEARCH_START, {
    walkingVelocityMetersPerSecond: 10,
    transferRadiusMeters: 100,
  });
  const stationC = result.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c");
  assert.equal(stationC?.elapsedSeconds, 20 * 60);
  const stationB = result.stationArrivals.find((arrival) => arrival.stationAreaId === "station-b");
  assert.equal(stationB?.elapsedSeconds, 13 * 60);

  const restricted = { ...FIXTURE_FILES, "stop_times.txt": FIXTURE_FILES["stop_times.txt"].replace("through,08:20:00,08:21:00,b-1,2,0,0", "through,08:20:00,08:21:00,b-1,2,0,1") };
  const restrictedSchedule = importFixtureFiles(restricted);
  const restrictedResult = routeScheduledEarliestArrivals(restrictedSchedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  assert.equal(restrictedResult.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, 20 * 60);
  const noPickup = { ...FIXTURE_FILES, "stop_times.txt": FIXTURE_FILES["stop_times.txt"].replace("fast,08:12:00,08:12:00,a-1,1,0,0", "fast,08:12:00,08:12:00,a-1,1,1,0") };
  const noPickupSchedule = importFixtureFiles(noPickup);
  const noPickupResult = routeScheduledEarliestArrivals(noPickupSchedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  assert.equal(noPickupResult.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, 25 * 60);

  const throughOnly = {
    ...FIXTURE_FILES,
    "trips.txt": "route_id,service_id,trip_id\nred,weekday,restricted-through",
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type",
      "restricted-through,08:10:00,08:10:00,a-1,1,0,0",
      "restricted-through,08:20:00,08:20:00,b-1,10,1,1",
      "restricted-through,08:30:00,08:30:00,c-1,20,1,0",
    ].join("\n"),
  };
  const throughOnlyResult = routeScheduledEarliestArrivals(importFixtureFiles(throughOnly), [{ stationAreaId: "station-a", accessSeconds: 0 }], SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  assert.equal(throughOnlyResult.stationArrivals.find((arrival) => arrival.stationAreaId === "station-b")?.elapsedSeconds, null);
  assert.equal(throughOnlyResult.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, 25 * 60);
});

test("date streams preserve continuation predecessors and do not authorize one before search start", () => {
  const schedule = fixture();
  const window = createScheduledRoutingWindow(schedule, SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  const through = window.connections.filter((connection) => connection.source.tripId === "through");
  assert.equal(through[0]?.previousContinuationKey, null);
  assert.equal(through[1]?.previousContinuationKey, through[0]?.connectionKey);

  const lateWindow = createScheduledRoutingWindow(schedule, "2026-08-11T08:15:00+02:00", { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  const lateThrough = lateWindow.connections.find((connection) => connection.source.tripId === "through");
  assert.equal(lateThrough?.source.fromStopSequence, 2);
  assert.equal(lateThrough?.previousContinuationKey, null);
});

test("calendar exceptions determine service and do not cross service-day identity", () => {
  const schedule = fixture();
  const removedMonday = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], "2026-08-10T08:05:00+02:00", { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  assert.equal(removedMonday.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, null);
  const addedSunday = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-c", accessSeconds: 0 }], "2026-08-09T07:55:00+02:00", { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  assert.equal(addedSunday.stationArrivals.find((arrival) => arrival.stationAreaId === "station-b")?.elapsedSeconds, 15 * 60);

  const dstEpoch = serviceDateSecondsToEpochSeconds("2026-03-28", 86_400 + 10 * 60, "Europe/Berlin");
  assert.equal(serviceDateForEpochSeconds(dstEpoch, "Europe/Berlin"), "2026-03-29");
  const offsetEpoch = Date.parse("2026-10-25T00:30:00+02:00") / 1_000;
  assert.equal(serviceDateForEpochSeconds(offsetEpoch, "Europe/Berlin"), "2026-10-24");
});

test("service-day anchors use local noon minus twelve elapsed hours across both 2026 DST transitions", () => {
  const springAnchor = serviceDateSecondsToEpochSeconds("2026-03-29", 0, "Europe/Berlin");
  assert.equal(springAnchor, 1_774_735_200);
  assert.equal(serviceDateAnchorEpochSeconds("2026-03-29", "Europe/Berlin") - serviceDateAnchorEpochSeconds("2026-03-28", "Europe/Berlin"), 23 * 3_600);
  assert.equal(serviceDateSecondsToEpochSeconds("2026-03-29", 25 * 3_600 + 30 * 60, "Europe/Berlin"), 1_774_827_000);
  assert.equal(serviceDateForEpochSeconds(springAnchor + 2 * 3_600, "Europe/Berlin"), "2026-03-29");
  assert.equal(
    serviceDateSecondsToEpochSeconds("2026-03-29", 25 * 3_600 + 30 * 60, "Europe/Berlin") - springAnchor,
    25 * 3_600 + 30 * 60,
  );

  const fallAnchor = serviceDateSecondsToEpochSeconds("2026-10-25", 0, "Europe/Berlin");
  assert.equal(fallAnchor, 1_792_882_800);
  assert.equal(serviceDateAnchorEpochSeconds("2026-10-25", "Europe/Berlin") - serviceDateAnchorEpochSeconds("2026-10-24", "Europe/Berlin"), 25 * 3_600);
  const fallOver24 = serviceDateSecondsToEpochSeconds("2026-10-25", 26 * 3_600, "Europe/Berlin");
  assert.equal(fallOver24, 1_792_976_400);
  assert.equal(serviceDateForEpochSeconds(fallAnchor + 2 * 3_600, "Europe/Berlin"), "2026-10-25");
  assert.equal(fallOver24 - fallAnchor, 26 * 3_600);
});

test("midnight rollover is routable from the preceding local service date", () => {
  const schedule = fixture();
  const midnightStart = "2026-08-09T23:50:00+02:00";
  const window = createScheduledRoutingWindow(schedule, midnightStart, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  const midnightConnection = window.connections.find((connection) => connection.source.tripId === "midnight");
  assert.equal(midnightConnection?.serviceDate, "2026-08-09");
  assert.equal(midnightConnection === undefined ? null : midnightConnection.arrivalEpochSeconds - midnightConnection.departureEpochSeconds, 15 * 60);
  const result = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], midnightStart, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 }, window);
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "station-b")?.elapsedSeconds, 20 * 60);
  assert.match(result.stationArrivals.find((arrival) => arrival.stationAreaId === "station-b")?.arrivalAt ?? "", /2026-08-09T22:10/);
});

test("local coordinate interchange is available without an all-pairs transfer graph", () => {
  const transferFiles: GtfsFeedFiles = {
    ...FIXTURE_FILES,
    "trips.txt": [
      "route_id,service_id,trip_id",
      "red,weekday,first-leg",
      "blue,weekday,second-leg",
    ].join("\n"),
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "first-leg,08:10:00,08:10:00,a-1,1",
      "first-leg,08:20:00,08:20:00,b-1,2",
      "second-leg,08:24:00,08:24:00,b-2,1",
      "second-leg,08:34:00,08:34:00,c-1,2",
    ].join("\n"),
  };
  const schedule = importFixtureFiles(transferFiles);
  const result = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, 29 * 60);
  const blocked = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 10 });
  assert.equal(blocked.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, null);
});

test("linear CSA preserves equal-time numeric sequence 1 to 10 and exactly one transfer hop", () => {
  const equalSequenceFiles: GtfsFeedFiles = {
    ...FIXTURE_FILES,
    "stops.txt": [
      "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
      "origin,Origin,48.1000,11.5000,1,",
      "origin-stop,Origin platform,48.1000,11.5000,0,origin",
      "arrive,Arrive,48.1000,11.5100,1,",
      "arrive-stop,Arrive platform,48.1000,11.5100,0,arrive",
      "transfer,Transfer,48.1005,11.5100,1,",
      "transfer-stop,Transfer platform,48.1005,11.5100,0,transfer",
      "walk-only,Walk only,48.1010,11.5100,1,",
      "walk-only-stop,Walk only platform,48.1010,11.5100,0,walk-only",
      "destination,Destination,48.1020,11.5100,1,",
      "destination-stop,Destination platform,48.1020,11.5100,0,destination",
    ].join("\n"),
    "trips.txt": [
      "route_id,service_id,trip_id",
      "red,weekday,equal-sequence",
      "blue,weekday,after-transfer",
    ].join("\n"),
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "equal-sequence,08:10:00,08:10:00,origin-stop,1",
      "equal-sequence,08:10:00,08:10:00,arrive-stop,10",
      "after-transfer,08:20:00,08:20:00,transfer-stop,1",
      "after-transfer,08:30:00,08:30:00,destination-stop,2",
    ].join("\n"),
  };
  const schedule = importGtfsSchedule(equalSequenceFiles, { acquisition: ACQUISITION });
  const window = createScheduledRoutingWindow(schedule, SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 70 });
  const result = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "origin", accessSeconds: 0 }], SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 70 }, window);
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "arrive")?.elapsedSeconds, 5 * 60);
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "transfer")?.elapsedSeconds, 5 * 60 + 6);
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "destination")?.elapsedSeconds, 25 * 60);
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "walk-only")?.elapsedSeconds, null);
});

test("same-instant zero-walk transfers do not depend on lexical cross-trip order", () => {
  const crossTripFiles: GtfsFeedFiles = {
    ...FIXTURE_FILES,
    "trips.txt": [
      "route_id,service_id,trip_id",
      "red,weekday,z-incoming",
      "blue,weekday,a-outgoing",
    ].join("\n"),
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "z-incoming,08:10:00,08:10:00,a-1,1",
      "z-incoming,08:10:00,08:10:00,b-1,2",
      "a-outgoing,08:10:00,08:10:00,b-1,1",
      "a-outgoing,08:20:00,08:20:00,c-1,2",
    ].join("\n"),
  };
  const schedule = importFixtureFiles(crossTripFiles);
  const result = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "station-b")?.elapsedSeconds, 5 * 60);
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, 15 * 60);
});

test("cross-stream zero-time transfers remain routable across consecutive service dates", () => {
  const crossStreamFiles: GtfsFeedFiles = {
    ...FIXTURE_FILES,
    "trips.txt": "route_id,service_id,trip_id\nred,weekday,incoming\nblue,weekday,outgoing",
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "incoming,25:50:00,25:50:00,a-1,1",
      "incoming,26:00:00,26:00:00,b-1,2",
      "outgoing,02:00:00,02:00:00,b-1,1",
      "outgoing,02:10:00,02:10:00,c-1,2",
    ].join("\n"),
  };
  const schedule = importFixtureFiles(crossStreamFiles);
  const searchStartAt = "2026-08-12T01:50:00+02:00";
  const window = createScheduledRoutingWindow(schedule, searchStartAt, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  assert.deepEqual(new Set(window.connections.map((connection) => connection.serviceDate)), new Set(["2026-08-11", "2026-08-12"]));
  const result = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], searchStartAt, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 }, window);
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, 20 * 60);
});

test("surface uses station arrivals plus a geographic final segment and classifies integer tolerance boundaries", () => {
  const schedule = fixture();
  const cells = [
    { id: "at-a", center: { latitude: 48.1, longitude: 11.5 }, representativePoint: { latitude: 48.1, longitude: 11.5 } },
    { id: "midpoint", center: { latitude: 48.1, longitude: 11.505 }, representativePoint: { latitude: 48.1, longitude: 11.505 } },
    { id: "at-b", center: { latitude: 48.1, longitude: 11.51 }, representativePoint: { latitude: 48.1, longitude: 11.51 } },
    { id: "unserved", center: { latitude: 48.1, longitude: 11.53 }, representativePoint: { latitude: 48.1, longitude: 11.53 } },
  ];
  const result = calculateScheduledSurface({
    schedule,
    accessSeedSets: [
      [{ stationAreaId: "station-a", accessSeconds: 0 }],
      [{ stationAreaId: "station-b", accessSeconds: 0 }],
    ],
    searchStartAt: SEARCH_START,
    selectedTolerancePercent: 10,
    cells,
    walkingVelocityMetersPerSecond: 100,
    transferRadiusMeters: 100,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.metadata.walkingSecondsRoundingRule.includes("ceil"), true);
  assert.equal(result.cells.find((cell) => cell.cellId === "at-a")?.classification, "red");
  assert.equal(result.cells.find((cell) => cell.cellId === "at-b")?.classification, "blue");
  assert.equal(result.cells.find((cell) => cell.cellId === "midpoint")?.classification, "fair");
  assert.equal(result.cells.find((cell) => cell.cellId === "unserved")?.classification, "blue");

  const noSeeds = calculateScheduledSurface({ schedule, accessSeedSets: [[], []], searchStartAt: SEARCH_START, selectedTolerancePercent: 10, cells: [{ id: "empty", center: { latitude: 48.1, longitude: 11.5 }, representativePoint: { latitude: 48.1, longitude: 11.5 } }], walkingVelocityMetersPerSecond: 100, transferRadiusMeters: 100 });
  assert.equal(noSeeds.status, "no-result");
  assert.equal(noSeeds.reason, "no-access-seeds");
  assert.equal(noSeeds.cells[0]?.classification, "unclassified");
  const oneSeed = calculateScheduledSurface({ schedule, accessSeedSets: [[{ stationAreaId: "station-a", accessSeconds: 0 }], []], searchStartAt: SEARCH_START, selectedTolerancePercent: 10, cells: [{ id: "one-sided", center: { latitude: 48.1, longitude: 11.5 }, representativePoint: { latitude: 48.1, longitude: 11.5 } }], walkingVelocityMetersPerSecond: 100, transferRadiusMeters: 100 });
  assert.equal(oneSeed.status, "no-result");
  assert.deepEqual(oneSeed.cells.map((cell) => cell.classification), ["unclassified"]);
});

test("scheduled routing checks injected deadlines at window, scan, and surface phases", () => {
  const schedule = fixture();
  assert.throws(
    () => createScheduledRoutingWindow(schedule, SEARCH_START, { deadlineCheck: deadlineAtPhase("routing-window") }),
    ScheduledCalculationDeadlineError,
  );

  const window = createScheduledRoutingWindow(schedule, SEARCH_START, { walkingVelocityMetersPerSecond: 100, transferRadiusMeters: 100 });
  assert.throws(
    () => routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], SEARCH_START, { deadlineCheck: deadlineAtPhase("routing-scan"), walkingVelocityMetersPerSecond: 100, transferRadiusMeters: 100 }, window),
    ScheduledCalculationDeadlineError,
  );

  assert.throws(
    () => calculateScheduledSurface({
      schedule,
      accessSeedSets: [[{ stationAreaId: "station-a", accessSeconds: 0 }], [{ stationAreaId: "station-b", accessSeconds: 0 }]],
      searchStartAt: SEARCH_START,
      selectedTolerancePercent: 10,
      cells: [{ id: "deadline-cell", center: { latitude: 48.1, longitude: 11.505 }, representativePoint: { latitude: 48.1, longitude: 11.505 } }],
      walkingVelocityMetersPerSecond: 100,
      transferRadiusMeters: 100,
      deadlineCheck: deadlineAtPhase("surface-cells"),
    }),
    ScheduledCalculationDeadlineError,
  );
});

test("exact boarding-stop seeds board only the resolved stop while area seeds retain station-area access", () => {
  const schedule = fixture();
  const stopRestrictedSchedule = {
    ...schedule,
    connections: schedule.connections.filter((connection) => connection.fromStopId !== "b-2"),
  };
  const exactStop = routeScheduledEarliestArrivals(
    stopRestrictedSchedule,
    [{ stationAreaId: "station-b", boardingStopId: "b-2", accessSeconds: 0 }],
    SEARCH_START,
    { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 },
  );
  const areaSeed = routeScheduledEarliestArrivals(
    stopRestrictedSchedule,
    [{ stationAreaId: "station-b", accessSeconds: 0 }],
    SEARCH_START,
    { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 },
  );
  assert.equal(exactStop.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.arrivalAt, null);
  assert.notEqual(areaSeed.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.arrivalAt, null);
});

test("surface evaluates the disclosed representative point rather than an outside rectangular center", () => {
  const schedule = fixture();
  const result = calculateScheduledSurface({
    schedule,
    accessSeedSets: [[{ stationAreaId: "station-a", accessSeconds: 0 }], [{ stationAreaId: "station-b", accessSeconds: 0 }]],
    searchStartAt: SEARCH_START,
    selectedTolerancePercent: 10,
    cells: [{ id: "disclosed-point", center: { latitude: 48.1, longitude: 11.53 }, representativePoint: { latitude: 48.1, longitude: 11.5 } }],
    walkingVelocityMetersPerSecond: 100,
    transferRadiusMeters: 100,
  });
  assert.equal(result.participants[0]?.cellArrivals[0]?.elapsedSeconds, 0);
  assert.equal(result.cells[0]?.classification, "red");
});

test("scheduled clipped cells use strict interior representatives for boundary and concave geometries", () => {
  const grid = createScheduledSurfaceGrid();
  assert.equal(grid.cells.every((cell) => isScheduledInteriorRepresentativePoint(cell.center, cell.geometry)), true);

  const concaveGeometry: GeoJsonMultiPolygon = {
    type: "MultiPolygon",
    coordinates: [[[
      [11.5, 48.1],
      [11.54, 48.1],
      [11.54, 48.11],
      [11.51, 48.11],
      [11.51, 48.14],
      [11.5, 48.14],
      [11.5, 48.1],
    ]]],
  };
  const representative = deriveInteriorRepresentativePoint(concaveGeometry, { latitude: 48.125, longitude: 11.525 });
  assert.equal(isScheduledInteriorRepresentativePoint(representative, concaveGeometry), true);
  assert.notDeepEqual(representative, { latitude: 48.1, longitude: 11.5 });
});

test("zero and inclusive tolerance boundaries stay deterministic", () => {
  assert.equal(isScheduledToleranceSatisfied(0, 0, 10), true);
  assert.equal(isScheduledToleranceSatisfied(90, 110, 10), true);
  assert.equal(isScheduledToleranceSatisfied(89, 110, 10), false);
  assert.equal(isScheduledToleranceSatisfied(0, 1, 10), false);
  assert.throws(() => isScheduledToleranceSatisfied(1, 1, 0), /5, 10, or 15/);
});

test("search bounds use maximum service-day time, validate before seeds, and fail closed for strict instants", () => {
  const schedule = fixture();
  const bounds = schedule.searchStartBounds;
  assert.doesNotThrow(() => routeScheduledEarliestArrivals(schedule, [], bounds.earliestAt));
  assert.doesNotThrow(() => routeScheduledEarliestArrivals(schedule, [], bounds.latestAt));
  const previousServiceOverlapEnd = serviceDateSecondsToEpochSeconds("2026-08-08", 24 * 3_600 + 10 * 60, "Europe/Berlin");
  assert.throws(() => routeScheduledEarliestArrivals(schedule, [], new Date((previousServiceOverlapEnd - 1) * 1_000).toISOString()), /coverage|bounds/);
  assert.doesNotThrow(() => routeScheduledEarliestArrivals(schedule, [], new Date((previousServiceOverlapEnd + 1) * 1_000).toISOString()));
  assert.throws(() => routeScheduledEarliestArrivals(schedule, [], new Date((serviceDateAnchorEpochSeconds("2026-08-17", "Europe/Berlin") - 86_400) * 1_000).toISOString()), /coverage|bounds/);
  assert.throws(() => routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "missing", accessSeconds: 0 }], new Date((bounds.earliestEpochSeconds - 1) * 1_000).toISOString()), /coverage|bounds/);
  assert.throws(() => routeScheduledEarliestArrivals(schedule, [], new Date((bounds.latestEpochSeconds + 1) * 1_000).toISOString()), /coverage|bounds/);
  assert.throws(() => routeScheduledEarliestArrivals(schedule, [], "2026-08-11T08:05:00"), /explicit offset/);
  assert.throws(() => routeScheduledEarliestArrivals(schedule, [], "2026-08-11T08:05:00.500+02:00"), /whole second/);

  const noValidInterval: GtfsFeedFiles = {
    ...withoutFile(FIXTURE_FILES, "calendar_dates.txt"),
    "calendar.txt": [
      "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
      "weekday,0,0,0,0,0,0,0,20260811,20260811",
      "sunday,0,0,0,0,0,0,0,20260811,20260811",
    ].join("\n"),
    "stop_times.txt": FIXTURE_FILES["stop_times.txt"].replace("23:55:00,23:55:00", "08:00:00,08:00:00").replace("24:10:00,24:10:00", "08:10:00,08:10:00"),
  };
  assert.throws(() => importGtfsSchedule(noValidInterval, { acquisition: ACQUISITION }), /routable|24-hour|interval/);
});

test("search bounds observe active spring and fall DST service-day gaps", () => {
  const springSchedule = importGtfsSchedule(activeServiceSpanFixture("20260329", "20260330"), {
    acquisition: { ...ACQUISITION, feedValidFrom: "2026-03-29", feedValidUntil: "2026-03-30" },
  });
  assert.deepEqual(
    [springSchedule.searchStartBounds.earliestEpochSeconds, springSchedule.searchStartBounds.earliestAt],
    [1_774_739_401, "2026-03-28T23:10:01.000Z"],
  );
  assert.deepEqual(
    [springSchedule.searchStartBounds.latestEpochSeconds, springSchedule.searchStartBounds.latestAt],
    [1_774_821_599, "2026-03-29T21:59:59.000Z"],
  );
  assert.doesNotThrow(() => routeScheduledEarliestArrivals(springSchedule, [], springSchedule.searchStartBounds.earliestAt));
  assert.doesNotThrow(() => routeScheduledEarliestArrivals(springSchedule, [], springSchedule.searchStartBounds.latestAt));

  const fallFiles = {
    ...activeServiceSpanFixture("20261025", "20261026"),
    "stop_times.txt": activeServiceSpanFixture("20261025", "20261026")["stop_times.txt"].replace("24:10:00,24:10:00", "26:00:00,26:00:00"),
  };
  const fallSchedule = importGtfsSchedule(fallFiles, {
    acquisition: { ...ACQUISITION, feedValidFrom: "2026-10-25", feedValidUntil: "2026-10-26" },
  });
  assert.deepEqual(
    [fallSchedule.searchStartBounds.earliestEpochSeconds, fallSchedule.searchStartBounds.earliestAt],
    [1_792_886_401, "2026-10-25T00:00:01.000Z"],
  );
  assert.deepEqual(
    [fallSchedule.searchStartBounds.latestEpochSeconds, fallSchedule.searchStartBounds.latestAt],
    [1_792_969_199, "2026-10-25T22:59:59.000Z"],
  );
  assert.doesNotThrow(() => routeScheduledEarliestArrivals(fallSchedule, [], fallSchedule.searchStartBounds.earliestAt));
  assert.doesNotThrow(() => routeScheduledEarliestArrivals(fallSchedule, [], fallSchedule.searchStartBounds.latestAt));
});

test("one active service date passes service validation before its empty routable interval is rejected", () => {
  const oneDateFiles = activeServiceSpanFixture("20260811", "20260811");
  assert.throws(
    () => importGtfsSchedule(oneDateFiles, { acquisition: { ...ACQUISITION, feedValidFrom: "2026-08-11", feedValidUntil: "2026-08-11" } }),
    /no valid 24-hour routable search interval/,
  );
});

test("direct and transfer arrivals respect the inclusive 24-hour horizon", () => {
  const boundaryFiles: GtfsFeedFiles = {
    ...FIXTURE_FILES,
    "stops.txt": [
      "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
      "boundary-a,Boundary A,48.1000,11.5000,1,",
      "boundary-a-stop,Boundary A platform,48.1000,11.5000,0,boundary-a",
      "boundary-b,Boundary B,48.1000,11.5100,1,",
      "boundary-b-stop,Boundary B platform,48.1000,11.5100,0,boundary-b",
      "boundary-exact,Boundary exact transfer,48.1000,11.5100,1,",
      "boundary-exact-stop,Boundary exact transfer platform,48.1000,11.5100,0,boundary-exact",
      "boundary-past,Boundary past transfer,48.10001,11.5100,1,",
      "boundary-past-stop,Boundary past transfer platform,48.10001,11.5100,0,boundary-past",
    ].join("\n"),
    "trips.txt": "route_id,service_id,trip_id\nred,weekday,boundary-trip",
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "boundary-trip,32:00:00,32:00:00,boundary-a-stop,1",
      "boundary-trip,32:05:00,32:05:00,boundary-b-stop,2",
    ].join("\n"),
  };
  const schedule = importFixtureFiles(boundaryFiles);
  const exactDirect = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "boundary-a", accessSeconds: 86_400 }], SEARCH_START);
  assert.equal(exactDirect.stationArrivals.find((arrival) => arrival.stationAreaId === "boundary-a")?.elapsedSeconds, 86_400);
  assert.throws(() => routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "boundary-a", accessSeconds: 86_401 }], SEARCH_START), /24-hour routing horizon/);

  const exactTransfer = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "boundary-a", accessSeconds: 0 }], SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  assert.equal(exactTransfer.stationArrivals.find((arrival) => arrival.stationAreaId === "boundary-b")?.elapsedSeconds, 86_400);
  assert.equal(exactTransfer.stationArrivals.find((arrival) => arrival.stationAreaId === "boundary-exact")?.elapsedSeconds, 86_400);
  assert.equal(exactTransfer.stationArrivals.find((arrival) => arrival.stationAreaId === "boundary-past")?.elapsedSeconds, null);
});

test("calendar-only and exception-only additions are valid, but removal-only service is unsafe", () => {
  assert.doesNotThrow(() => importGtfsSchedule(withoutFile(FIXTURE_FILES, "calendar_dates.txt"), { acquisition: ACQUISITION }));
  const exceptionOnly = withoutFile(FIXTURE_FILES, "calendar.txt");
  const exceptionOnlyAdditions = {
    ...exceptionOnly,
    "calendar_dates.txt": [
      "service_id,date,exception_type",
      "weekday,20260811,1",
      "sunday,20260809,1",
    ].join("\n"),
  };
  assert.doesNotThrow(() => importGtfsSchedule(exceptionOnlyAdditions, { acquisition: ACQUISITION }));
  const removalOnly = {
    ...exceptionOnly,
    "calendar_dates.txt": "service_id,date,exception_type\nweekday,20260811,2\nsunday,20260809,2",
  };
  assert.throws(() => importGtfsSchedule(removalOnly, { acquisition: ACQUISITION }), /addition|active service|calendar/);
});

test("agency timezone and unsupported GTFS extensions are fail-closed", () => {
  assert.throws(() => importFixtureFiles(withoutFile(FIXTURE_FILES, "agency.txt")), /agency.txt/);
  const unsupportedTimezone = { ...FIXTURE_FILES, "agency.txt": FIXTURE_FILES["agency.txt"].replace("Europe/Berlin", "Europe/London") };
  assert.throws(() => importGtfsSchedule(unsupportedTimezone, { acquisition: ACQUISITION }), /timezone|Europe\/Berlin/);
  for (const fileName of ["frequencies.txt", "transfers.txt", "pathways.txt"]) {
    assert.throws(() => importGtfsSchedule({ ...FIXTURE_FILES, [fileName]: "id\nnon-empty" }, { acquisition: ACQUISITION }), new RegExp(fileName));
  }
  const onDemand = { ...FIXTURE_FILES, "stop_times.txt": FIXTURE_FILES["stop_times.txt"].replace("fast,08:12:00,08:12:00,a-1,1,0,0", "fast,08:12:00,08:12:00,a-1,1,2,0") };
  assert.throws(() => importGtfsSchedule(onDemand, { acquisition: ACQUISITION }), /pickup_type|on-demand|conditional/);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  addServiceDays,
  calculateScheduledSurface,
  compareScheduledConnections,
  importGtfsSchedule,
  isScheduledToleranceSatisfied,
  parseOffsetInstant,
  parseSearchStartInstant,
  routeScheduledEarliestArrivals,
  routeScheduledEarliestArrivalsPair,
  createScheduledRoutingWindow,
  clearScheduledRoutingWindowCache,
  serviceDateRangeForSearch,
  serviceDateAnchorEpochSeconds,
  serviceDateForEpochSeconds,
  serviceDateSecondsToEpochSeconds,
  walkingSeconds,
  type GtfsFeedFiles,
  type ScheduledRoutingArtifact,
  type ScheduledRoutingMaterializedConnection,
} from "../lib/domain/scheduled-routing/index.ts";
import { ScheduledCalculationDeadlineError } from "../lib/domain/scheduled-admission.ts";
import { FIXTURE_SCHEDULED_ARTIFACT, FIXTURE_SCHEDULED_ACCESS_PROVIDER } from "../lib/fixtures/scheduled-routing.ts";
import { calculateScheduledMeeting } from "../lib/domain/scheduled-routing/meeting.ts";
import {
  parseScheduledMeetingRequest,
  validateScheduledMeetingResponse,
} from "../lib/validation/meeting-v3.ts";

const SEARCH_START = "2026-08-11T08:05:00+02:00";

/**
 * The latest whole-minute instant at or before a search-start bound. Bounds
 * are computed at one-second precision (deliberately ending in :59 at their
 * upper edge), but every searchStartAt is rounded up to the next whole
 * minute, so this is the latest instant that actually stays in bounds.
 */
function latestWholeMinuteAt(latestEpochSeconds: number): string {
  return new Date(Math.floor(latestEpochSeconds / 60) * 60 * 1_000).toISOString();
}

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

interface ReferenceMaterializedConnection {
  readonly instanceId: string;
  readonly serviceDate: string;
  readonly source: ScheduledRoutingArtifact["connections"][number];
  readonly departureEpochSeconds: number;
  readonly arrivalEpochSeconds: number;
  readonly connectionKey: string;
  readonly previousContinuationKey: string | null;
}

function referenceMaterializeConnections(schedule: ScheduledRoutingArtifact, searchStartAt: string): ReferenceMaterializedConnection[] {
  const searchStartEpochSeconds = parseSearchStartInstant(searchStartAt, schedule.timeZone).epochSeconds;
  const horizonEndEpochSeconds = searchStartEpochSeconds + 86_400;
  const [firstCandidateDate, lastCandidateDate] = serviceDateRangeForSearch(searchStartEpochSeconds, schedule.timeZone, schedule.maximumServiceDayTimeSeconds);
  const results: ReferenceMaterializedConnection[] = [];
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

function compareReferenceMaterializedConnections(left: ReferenceMaterializedConnection, right: ReferenceMaterializedConnection): number {
  return left.departureEpochSeconds - right.departureEpochSeconds || compareScheduledConnections(left.source, right.source) || left.arrivalEpochSeconds - right.arrivalEpochSeconds || left.instanceId.localeCompare(right.instanceId);
}

test("GTFS import validates station areas, IDs, coordinates, columns, and freezes provenance", () => {
  const schedule = fixture();
  assert.equal(schedule.stationAreas.find((area) => area.id === "station-b")?.name, "Station B");
  assert.equal("boardingStops" in schedule, false);
  assert.equal(schedule.connections.find((connection) => connection.id === "through:0-1")?.fromStationAreaId, "station-a");
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
  const midnight = schedule.connections.find((connection) => connection.id === "midnight:0-1");
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

test("routeScheduledEarliestArrivalsPair matches two sequential routeScheduledEarliestArrivals calls", () => {
  const schedule = fixture();
  const seedsA = [{ stationAreaId: "station-a", accessSeconds: 0 }];
  const seedsB = [{ stationAreaId: "station-c", accessSeconds: 0 }];
  const options = { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 };
  const sequential = [
    routeScheduledEarliestArrivals(schedule, seedsA, SEARCH_START, options),
    routeScheduledEarliestArrivals(schedule, seedsB, SEARCH_START, options),
  ];
  const paired = routeScheduledEarliestArrivalsPair(
    schedule,
    [seedsA, seedsB],
    SEARCH_START,
    options,
  );
  assert.deepEqual(paired[0], sequential[0]);
  assert.deepEqual(paired[1], sequential[1]);
  assert.ok(paired[0].reachableStationAreaCount > 0);
  assert.ok(paired[1].reachableStationAreaCount > 0);
  assert.ok(Object.keys(paired[0].predecessorByArea).length > 0);
  assert.deepEqual(paired[0].predecessorByArea, sequential[0].predecessorByArea);
  assert.deepEqual(paired[1].predecessorByArea, sequential[1].predecessorByArea);
});

test("routeScheduledEarliestArrivalsPair matches sequential scans with asymmetric reachability", () => {
  const schedule = fixture();
  const seedsA = [{ stationAreaId: "station-a", accessSeconds: 0 }];
  const seedsB = [{ stationAreaId: "station-unreachable", accessSeconds: 0 }];
  const options = { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 };
  const sequential = [
    routeScheduledEarliestArrivals(schedule, seedsA, SEARCH_START, options),
    routeScheduledEarliestArrivals(schedule, seedsB, SEARCH_START, options),
  ];
  const paired = routeScheduledEarliestArrivalsPair(
    schedule,
    [seedsA, seedsB],
    SEARCH_START,
    options,
  );
  assert.deepEqual(paired[0], sequential[0]);
  assert.deepEqual(paired[1], sequential[1]);
  assert.ok(paired[0].reachableStationAreaCount > 0);
  assert.deepEqual(paired[0].predecessorByArea, sequential[0].predecessorByArea);
  assert.equal(paired[1].reachableStationAreaCount, 1);
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
    const actualRows: ScheduledRoutingMaterializedConnection[] = [];
    const actual = createScheduledRoutingWindow(schedule, searchStartAt, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 }, {
      onMaterializedConnection: (connection) => actualRows.push(connection),
    });
    const reference = referenceMaterializeConnections(schedule, searchStartAt);
    assert.equal(actual.connectionCount, reference.length);
    assert.equal(actualRows.length, reference.length);
    const referenceIndexByKey = new Map(reference.map((connection, index) => [connection.connectionKey, index]));
    const continuationIndexByKey = new Map<string, number>();
    for (let index = 0; index < reference.length; index += 1) {
      const previousKey = reference[index]?.previousContinuationKey;
      if (previousKey !== null && previousKey !== undefined) continuationIndexByKey.set(previousKey, index);
    }
    assert.deepEqual(
      actualRows.map((row) => ({
        source: row.source.id,
        serviceDate: row.serviceDate,
        departureEpochSeconds: row.departureEpochSeconds,
        arrivalEpochSeconds: row.arrivalEpochSeconds,
        predecessorRowIndex: row.predecessorRowIndex,
        continuationRowIndex: row.continuationRowIndex,
      })),
      reference.map((row) => ({
        source: row.source.id,
        serviceDate: row.serviceDate,
        departureEpochSeconds: row.departureEpochSeconds,
        arrivalEpochSeconds: row.arrivalEpochSeconds,
        predecessorRowIndex: row.previousContinuationKey === null ? null : referenceIndexByKey.get(row.previousContinuationKey) ?? null,
        continuationRowIndex: continuationIndexByKey.get(row.connectionKey) ?? null,
      })),
    );
    const firstActualRow = actualRows[0];
    assert.ok(firstActualRow !== undefined);
    assert.equal(Object.isFrozen(firstActualRow), true);
    assert.ok(new Set(reference.map((connection) => connection.serviceDate)).size >= 2, `${searchStartAt}: ${[...new Set(reference.map((connection) => connection.serviceDate))].join(",")}`);
    for (let index = 1; index < reference.length; index += 1) assert.ok(compareReferenceMaterializedConnections(reference[index - 1]!, reference[index]!) <= 0);
    const routed = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], searchStartAt, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 }, actual);
    assert.ok(routed.reachableStationAreaCount > 0);
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

test("continuation authorization honors the search cutoff and same-bucket continuations", () => {
  const throughOnly = importFixtureFiles({
    ...FIXTURE_FILES,
    "trips.txt": "route_id,service_id,trip_id\nred,weekday,only-through",
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type",
      "only-through,08:10:00,08:10:00,a-1,1,0,0",
      "only-through,08:10:00,08:10:00,b-1,2,0,0",
      "only-through,08:20:00,08:20:00,c-1,3,0,0",
    ].join("\n"),
  });
  const early = routeScheduledEarliestArrivals(throughOnly, [{ stationAreaId: "station-a", accessSeconds: 0 }], SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  assert.equal(early.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, 15 * 60);

  const late = routeScheduledEarliestArrivals(throughOnly, [{ stationAreaId: "station-a", accessSeconds: 0 }], "2026-08-11T08:15:00+02:00", { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  assert.equal(late.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, null);

  const cutoffNonBoardable = importFixtureFiles({
    ...FIXTURE_FILES,
    "trips.txt": "route_id,service_id,trip_id\nred,weekday,cutoff-through",
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type",
      "cutoff-through,08:10:00,08:10:00,a-1,1,0,0",
      "cutoff-through,08:20:00,08:20:00,b-1,2,0,0",
      "cutoff-through,08:30:00,08:30:00,c-1,3,1,0",
    ].join("\n"),
  });
  const cutoffRows: ScheduledRoutingMaterializedConnection[] = [];
  createScheduledRoutingWindow(cutoffNonBoardable, "2026-08-11T08:15:00+02:00", { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 }, {
    onMaterializedConnection: (connection) => cutoffRows.push(connection),
  });
  const successor = cutoffRows.find((row) => row.source.fromStationAreaId === "station-b");
  assert.ok(successor !== undefined);
  assert.equal(successor?.predecessorRowIndex, null);
  const cutoffResult = routeScheduledEarliestArrivals(cutoffNonBoardable, [{ stationAreaId: "station-a", accessSeconds: 0 }], "2026-08-11T08:15:00+02:00", { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  assert.equal(cutoffResult.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, null);
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
  assert.ok(window.connectionCount > 0);
  const result = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], midnightStart, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 }, window);
  const stationBArrival = result.stationArrivals.find((arrival) => arrival.stationAreaId === "station-b");
  assert.equal(stationBArrival?.elapsedSeconds, 20 * 60);
  assert.ok(stationBArrival?.arrivalEpochSeconds !== null, "station-b arrival epoch must be present");
  assert.match(
    new Date((stationBArrival!.arrivalEpochSeconds as number) * 1000).toISOString(),
    /2026-08-09T22:10/,
  );
});

test("local coordinate interchange is available without an all-pairs transfer graph", () => {
  const transferFiles: GtfsFeedFiles = {
    ...FIXTURE_FILES,
    "stops.txt": [
      "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
      "station-a,Station A,48.1000,11.5000,1,",
      "a-1,Station A platform,48.1000,11.5000,0,station-a",
      "station-b,Station B,48.1000,11.5100,1,",
      "b-1,Station B platform 1,48.1000,11.5100,0,station-b",
      "station-x,Station X,48.1001,11.5100,1,",
      "x-1,Station X platform,48.1001,11.5100,0,station-x",
      "station-c,Station C,48.1000,11.5200,1,",
      "c-1,Station C platform,48.1000,11.5200,0,station-c",
    ].join("\n"),
    "trips.txt": [
      "route_id,service_id,trip_id",
      "red,weekday,first-leg",
      "blue,weekday,second-leg",
    ].join("\n"),
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "first-leg,08:10:00,08:10:00,a-1,1",
      "first-leg,08:20:00,08:20:00,b-1,2",
      "second-leg,08:24:00,08:24:00,x-1,1",
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
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "transfer")?.elapsedSeconds, 6 * 60);
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "destination")?.elapsedSeconds, 25 * 60);
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "walk-only")?.elapsedSeconds, null);
});

test("same-instant transfers respect the change-time preset regardless of lexical cross-trip order", () => {
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
      "a-outgoing,08:15:00,08:15:00,b-1,1",
      "a-outgoing,08:25:00,08:25:00,c-1,2",
    ].join("\n"),
  };
  const schedule = importFixtureFiles(crossTripFiles);
  const result = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "station-b")?.elapsedSeconds, 5 * 60);
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, 20 * 60);
});

test("cross-stream same-area transfers remain routable across consecutive service dates", () => {
  const crossStreamFiles: GtfsFeedFiles = {
    ...FIXTURE_FILES,
    "trips.txt": "route_id,service_id,trip_id\nred,weekday,incoming\nblue,weekday,outgoing",
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "incoming,25:50:00,25:50:00,a-1,1",
      "incoming,26:00:00,26:00:00,b-1,2",
      "outgoing,02:05:00,02:05:00,b-1,1",
      "outgoing,02:15:00,02:15:00,c-1,2",
    ].join("\n"),
  };
  const schedule = importFixtureFiles(crossStreamFiles);
  const searchStartAt = "2026-08-12T01:50:00+02:00";
  const window = createScheduledRoutingWindow(schedule, searchStartAt, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 });
  assert.equal(window.connectionCount, referenceMaterializeConnections(schedule, searchStartAt).length);
  const result = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], searchStartAt, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 }, window);
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, 25 * 60);
});

test("same-area transfers cost the static change-time preset", () => {
  const changeTimeFiles: GtfsFeedFiles = {
    ...FIXTURE_FILES,
    "trips.txt": "route_id,service_id,trip_id\nred,weekday,incoming\nblue,weekday,outgoing",
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "incoming,08:10:00,08:10:00,a-1,1",
      "incoming,08:20:00,08:20:00,b-1,2",
      "outgoing,08:24:00,08:24:00,b-2,1",
      "outgoing,08:34:00,08:34:00,c-1,2",
    ].join("\n"),
  };
  const schedule = importFixtureFiles(changeTimeFiles);
  const quick = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100, changeTimeSeconds: 180 });
  assert.equal(quick.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, 29 * 60);
  const long = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100, changeTimeSeconds: 600 });
  assert.equal(long.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, null);
});

test("different-area transfers cost walking time, not the change-time preset", () => {
  const walkTransferFiles: GtfsFeedFiles = {
    ...FIXTURE_FILES,
    "stops.txt": [
      "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
      "station-a,Station A,48.1000,11.5000,1,",
      "a-1,Station A platform,48.1000,11.5000,0,station-a",
      "station-b,Station B,48.1000,11.5100,1,",
      "b-1,Station B platform 1,48.1000,11.5100,0,station-b",
      "station-x,Station X,48.1001,11.5100,1,",
      "x-1,Station X platform,48.1001,11.5100,0,station-x",
      "station-c,Station C,48.1000,11.5200,1,",
      "c-1,Station C platform,48.1000,11.5200,0,station-c",
    ].join("\n"),
    "trips.txt": "route_id,service_id,trip_id\nred,weekday,incoming\nblue,weekday,outgoing",
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "incoming,08:10:00,08:10:00,a-1,1",
      "incoming,08:20:00,08:20:00,b-1,2",
      "outgoing,08:24:00,08:24:00,x-1,1",
      "outgoing,08:34:00,08:34:00,c-1,2",
    ].join("\n"),
  };
  const schedule = importFixtureFiles(walkTransferFiles);
  const result = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100, changeTimeSeconds: 600 });
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, 29 * 60);
});

test("no change time applies at the origin seed or the destination arrival", () => {
  const originFiles: GtfsFeedFiles = {
    ...FIXTURE_FILES,
    "trips.txt": "route_id,service_id,trip_id\nblue,weekday,outgoing",
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "outgoing,08:10:00,08:10:00,b-2,1",
      "outgoing,08:20:00,08:20:00,c-1,2",
    ].join("\n"),
  };
  const schedule = importFixtureFiles(originFiles);
  const result = routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-b", accessSeconds: 0 }], SEARCH_START, { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100, changeTimeSeconds: 600 });
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, 15 * 60);
});

test("routing-window cache keys include the change-time preset and default to medium", () => {
  const schedule = fixture();
  const baseOptions = { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 };
  clearScheduledRoutingWindowCache();
  const quickFirst = createScheduledRoutingWindow(schedule, SEARCH_START, { ...baseOptions, changeTimeSeconds: 180 });
  const quickSecond = createScheduledRoutingWindow(schedule, SEARCH_START, { ...baseOptions, changeTimeSeconds: 180 });
  assert.strictEqual(quickSecond, quickFirst);
  assert.equal(quickFirst.changeTimeSeconds, 180);
  const long = createScheduledRoutingWindow(schedule, SEARCH_START, { ...baseOptions, changeTimeSeconds: 600 });
  assert.notStrictEqual(long, quickFirst);
  assert.equal(long.changeTimeSeconds, 600);
  const defaultWindow = createScheduledRoutingWindow(schedule, SEARCH_START, baseOptions);
  assert.equal(defaultWindow.changeTimeSeconds, 300);
  assert.throws(() => createScheduledRoutingWindow(schedule, SEARCH_START, { ...baseOptions, changeTimeSeconds: 240 }), /presets/);
  assert.equal("deadlineCheck" in quickFirst, false);

  const cachedCallerPhases: string[] = [];
  const cachedCallerWindow = createScheduledRoutingWindow(schedule, SEARCH_START, {
    ...baseOptions,
    deadlineCheck: (phase) => cachedCallerPhases.push(phase),
  });
  assert.notStrictEqual(cachedCallerWindow, defaultWindow);
  assert.deepEqual(cachedCallerPhases, ["routing-window", "routing-window", "routing-window"]);

  const inheritedPhaseCount = cachedCallerPhases.length;
  routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], SEARCH_START, {}, cachedCallerWindow);
  assert.ok(cachedCallerPhases.length > inheritedPhaseCount);

  const overridePhases: string[] = [];
  const inheritedPhaseCountBeforeOverride = cachedCallerPhases.length;
  routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "station-a", accessSeconds: 0 }], SEARCH_START, {
    ...baseOptions,
    deadlineCheck: (phase) => overridePhases.push(phase),
  }, cachedCallerWindow);
  assert.ok(overridePhases.length > 0);
  assert.equal(cachedCallerPhases.length, inheritedPhaseCountBeforeOverride);

  const phases: string[] = [];
  const currentCallerWindow = createScheduledRoutingWindow(schedule, SEARCH_START, {
    ...baseOptions,
    walkingVelocityMetersPerSecond: 11,
    deadlineCheck: (phase) => phases.push(phase),
  });
  assert.equal(currentCallerWindow.connectionCount, quickFirst.connectionCount);
  assert.deepEqual(phases, ["routing-window", "routing-window", "routing-window"]);
});

test("compact table byte metrics are exposed and table eviction removes linked wrappers", () => {
  const schedule = fixture();
  const options = { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 };
  clearScheduledRoutingWindowCache();
  const first = createScheduledRoutingWindow(schedule, SEARCH_START, options);
  const second = createScheduledRoutingWindow(schedule, "2026-08-11T09:05:00+02:00", options);
  createScheduledRoutingWindow(schedule, "2026-08-12T08:05:00+02:00", options);
  createScheduledRoutingWindow(schedule, "2026-08-13T08:05:00+02:00", options);

  assert.equal(first.compactTableByteLength, first.connectionCount * 4 * Uint32Array.BYTES_PER_ELEMENT);
  assert.ok(first.compactTableByteLength > 0);
  // A wrapper hit also refreshes its linked table. The first wrapper/table
  // pair therefore survives insertion of the fifth distinct search epoch,
  // while the untouched second pair is evicted.
  assert.strictEqual(createScheduledRoutingWindow(schedule, SEARCH_START, options), first);
  createScheduledRoutingWindow(schedule, "2026-08-14T08:05:00+02:00", options);
  assert.strictEqual(createScheduledRoutingWindow(schedule, SEARCH_START, options), first);
  assert.notStrictEqual(createScheduledRoutingWindow(schedule, "2026-08-11T09:05:00+02:00", options), second);
});

test("surface classifies station areas across red, blue, and fair tolerance boundaries", () => {
  const schedule = fixture();
  const result = calculateScheduledSurface({
    schedule,
    accessSeedSets: [
      [{ stationAreaId: "station-a", accessSeconds: 0 }],
      [{ stationAreaId: "station-b", accessSeconds: 0 }],
    ],
    searchStartAt: SEARCH_START,
    selectedTolerancePercent: 10,
    walkingVelocityMetersPerSecond: 100,
    transferRadiusMeters: 100,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.metadata.walkingSecondsRoundingRule.includes("ceil"), true);
  const byId = new Map(result.stationAreas.map((area) => [area.stationAreaId, area]));
  assert.equal(byId.get("station-a")?.classification, "red");
  assert.equal(byId.get("station-b")?.classification, "blue");
  assert.equal(byId.get("station-c")?.classification, "fair");

  const noSeeds = calculateScheduledSurface({ schedule, accessSeedSets: [[], []], searchStartAt: SEARCH_START, selectedTolerancePercent: 10, walkingVelocityMetersPerSecond: 100, transferRadiusMeters: 100 });
  assert.equal(noSeeds.status, "no-result");
  assert.equal(noSeeds.reason, "no-access-seeds");
  assert.equal(noSeeds.stationAreas[0]?.classification, "unclassified");
  const oneSeed = calculateScheduledSurface({ schedule, accessSeedSets: [[{ stationAreaId: "station-a", accessSeconds: 0 }], []], searchStartAt: SEARCH_START, selectedTolerancePercent: 10, walkingVelocityMetersPerSecond: 100, transferRadiusMeters: 100 });
  assert.equal(oneSeed.status, "no-result");
  assert.equal(oneSeed.stationAreas.every((area) => area.classification === "unclassified"), true);

  assert.throws(
    () => calculateScheduledSurface({
      schedule,
      accessSeedSets: [[{ stationAreaId: "station-a", accessSeconds: 61 }], [{ stationAreaId: "station-b", accessSeconds: 0 }]],
      searchStartAt: SEARCH_START,
      selectedTolerancePercent: 10,
      walkingVelocityMetersPerSecond: 100,
      transferRadiusMeters: 100,
    }),
    /minute-aligned/,
  );
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
      walkingVelocityMetersPerSecond: 100,
      transferRadiusMeters: 100,
      deadlineCheck: deadlineAtPhase("station-areas"),
    }),
    ScheduledCalculationDeadlineError,
  );
});

test("area seeds board any connection departing the seeded station area", () => {
  const schedule = fixture();
  const result = routeScheduledEarliestArrivals(
    schedule,
    [{ stationAreaId: "station-b", accessSeconds: 0 }],
    SEARCH_START,
    { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 },
  );
  assert.equal(result.stationArrivals.find((arrival) => arrival.stationAreaId === "station-c")?.elapsedSeconds, 20 * 60);
});

test("routing persists the fastest destination station-area arrival with a deterministic result", () => {
  const fastestBoardingStopFiles: GtfsFeedFiles = {
    ...FIXTURE_FILES,
    "trips.txt": `${FIXTURE_FILES["trips.txt"]}\nred,weekday,fast-b2,Station B`,
    "stop_times.txt": `${FIXTURE_FILES["stop_times.txt"]}\nfast-b2,08:10:00,08:10:00,a-1,1,0,0\nfast-b2,08:15:00,08:15:00,b-2,2,0,0`,
  };
  const result = routeScheduledEarliestArrivals(
    importFixtureFiles(fastestBoardingStopFiles),
    [{ stationAreaId: "station-a", accessSeconds: 0 }],
    SEARCH_START,
    { walkingVelocityMetersPerSecond: 10, transferRadiusMeters: 100 },
  );
  const destination = result.stationArrivals.find((arrival) => arrival.stationAreaId === "station-b");
  assert.equal(destination?.elapsedSeconds, 10 * 60);
});

test("equal-time arrivals to the same station area stay deterministic for station-area candidates", () => {
  const equalReadyBoardingStopsFiles: GtfsFeedFiles = {
    ...FIXTURE_FILES,
    "stops.txt": [
      "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
      "station-a,Station A,48.1000,11.5000,1,",
      "a-1,Station A platform,48.1000,11.5000,0,station-a",
      "station-b,Station B,48.1000,11.5100,1,",
      "b-z,Station B platform Z,48.1000,11.5100,0,station-b",
      "b-a,Station B platform A,48.1000,11.5100,0,station-b",
    ].join("\n"),
    "trips.txt": [
      "route_id,service_id,trip_id",
      "red,weekday,z-arrival",
      "blue,weekday,a-arrival",
    ].join("\n"),
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "z-arrival,08:10:00,08:10:00,a-1,1",
      "z-arrival,08:15:00,08:15:00,b-z,2",
      "a-arrival,08:10:00,08:10:00,a-1,1",
      "a-arrival,08:15:00,08:15:00,b-a,2",
    ].join("\n"),
  };
  const schedule = importFixtureFiles(equalReadyBoardingStopsFiles);
  const result = calculateScheduledSurface({
    schedule,
    accessSeedSets: [
      [{ stationAreaId: "station-a", accessSeconds: 0 }],
      [{ stationAreaId: "station-a", accessSeconds: 0 }],
    ],
    searchStartAt: SEARCH_START,
    selectedTolerancePercent: 10,
    walkingVelocityMetersPerSecond: 10,
    transferRadiusMeters: 100,
  });

  const stationB = result.stationAreas.find((candidate) => candidate.stationAreaId === "station-b");
  assert.deepEqual(
    [stationB?.redArrivalSeconds, stationB?.blueArrivalSeconds, stationB?.classification],
    [10 * 60, 10 * 60, "fair"],
  );
});

test("zero and inclusive tolerance boundaries stay deterministic", () => {
  assert.equal(isScheduledToleranceSatisfied(0, 0, 10), true);
  assert.equal(isScheduledToleranceSatisfied(90, 110, 10), true);
  assert.equal(isScheduledToleranceSatisfied(89, 110, 10), false);
  assert.equal(isScheduledToleranceSatisfied(0, 1, 10), false);
  assert.throws(() => isScheduledToleranceSatisfied(1, 1, 0), /5, 10, or 15/);
});

test("parseSearchStartInstant canonicalizes to the next whole minute, unchanged for whole-minute instants", () => {
  assert.equal(parseSearchStartInstant("2026-08-11T08:05:00+02:00", "Europe/Berlin").canonicalAt, "2026-08-11T06:05:00.000Z");
  assert.equal(parseSearchStartInstant("2026-08-11T08:05:01+02:00", "Europe/Berlin").canonicalAt, "2026-08-11T06:06:00.000Z");
  assert.equal(parseSearchStartInstant("2026-08-11T08:05:59+02:00", "Europe/Berlin").canonicalAt, "2026-08-11T06:06:00.000Z");
  assert.equal(parseSearchStartInstant("2026-08-11T23:59:59+02:00", "Europe/Berlin").canonicalAt, "2026-08-11T22:00:00.000Z");
  const rounded = parseSearchStartInstant("2026-08-11T08:05:01+02:00", "Europe/Berlin");
  assert.equal(rounded.epochSeconds % 60, 0);
  // parseOffsetInstant itself stays whole-second precision, with no rounding: it also
  // parses non-searchStartAt instants (acquisition timestamps, freshness clocks).
  assert.equal(parseOffsetInstant("2026-08-11T08:05:01+02:00", "Europe/Berlin").canonicalAt, "2026-08-11T06:05:01.000Z");
});

test("parseSearchStartInstant rounding is offset-invariant on spring and fall DST transition dates", () => {
  assert.equal(parseSearchStartInstant("2026-03-29T01:59:59+01:00", "Europe/Berlin").canonicalAt, "2026-03-29T01:00:00.000Z");
  assert.equal(parseSearchStartInstant("2026-10-25T02:59:59+02:00", "Europe/Berlin").canonicalAt, "2026-10-25T01:00:00.000Z");
});

test("gtfsTime truncates nonzero seconds to the minute instead of rejecting the feed", () => {
  const nonzeroSecondsFiles: GtfsFeedFiles = {
    ...FIXTURE_FILES,
    "stop_times.txt": FIXTURE_FILES["stop_times.txt"]
      .replace("through,08:10:00,08:10:00,a-1,1,0,0", "through,08:10:30,08:10:45,a-1,1,0,0")
      .replace("through,08:20:00,08:21:00,b-1,2,0,0", "through,08:20:30,08:21:00,b-1,2,0,0"),
  };
  const schedule = importGtfsSchedule(nonzeroSecondsFiles, { acquisition: ACQUISITION });
  const connection = schedule.connections.find((candidate) => candidate.tripId === "through");
  assert.ok(connection);
  assert.equal(connection.id, "through:0-1");
  // 08:10:30 / 08:10:45 truncate to 08:10:00 (29400 s) and 08:20:30 to 08:20:00 (30000 s).
  assert.equal(connection.departureTimeSeconds, 8 * 3_600 + 10 * 60);
  assert.equal(connection.arrivalTimeSeconds, 8 * 3_600 + 20 * 60);
});

test("walkingSeconds rounds up to the next whole minute, with zero distance taking zero seconds", () => {
  const origin = { latitude: 48.1000, longitude: 11.5000 };
  assert.equal(walkingSeconds(origin, origin, 1.4), 0);
  // A tiny nonzero distance still costs a full minute once rounded up.
  assert.equal(walkingSeconds(origin, { latitude: 48.10001, longitude: 11.5000 }, 1.4), 60);
  // A distance requiring roughly 30 raw seconds of walking rounds up to one whole minute.
  const thirtySecondTarget = { latitude: origin.latitude + (1.4 * 30) / 111_000, longitude: origin.longitude };
  assert.equal(walkingSeconds(origin, thirtySecondTarget, 1.4), 60);
  // A distance requiring roughly 90 raw seconds of walking rounds up to the next whole minute.
  const ninetySecondTarget = { latitude: origin.latitude + (1.4 * 90) / 111_000, longitude: origin.longitude };
  assert.equal(walkingSeconds(origin, ninetySecondTarget, 1.4), 120);
});

test("search bounds use maximum service-day time, validate before seeds, and fail closed for strict instants", () => {
  const schedule = fixture();
  const bounds = schedule.searchStartBounds;
  assert.doesNotThrow(() => routeScheduledEarliestArrivals(schedule, [], bounds.earliestAt));
  assert.doesNotThrow(() => routeScheduledEarliestArrivals(schedule, [], latestWholeMinuteAt(bounds.latestEpochSeconds)));
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
  assert.doesNotThrow(() => routeScheduledEarliestArrivals(springSchedule, [], latestWholeMinuteAt(springSchedule.searchStartBounds.latestEpochSeconds)));

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
  assert.doesNotThrow(() => routeScheduledEarliestArrivals(fallSchedule, [], latestWholeMinuteAt(fallSchedule.searchStartBounds.latestEpochSeconds)));
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
  assert.throws(() => routeScheduledEarliestArrivals(schedule, [{ stationAreaId: "boundary-a", accessSeconds: 61 }], SEARCH_START), /minute-aligned/);

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

test("station-level collapse drops intra-area legs and deduplicates consecutive same-area visits", () => {
  const schedule = FIXTURE_SCHEDULED_ARTIFACT;
  assert.ok(schedule.stationAreas.every((area) => Object.keys(area).sort().join(",") === "coordinate,id,mode,name,transferNeighbors"));
  assert.ok(schedule.connections.every((connection) => connection.fromStationAreaId !== connection.toStationAreaId));
  const collapse = schedule.connections.filter((connection) => connection.tripId === "fixture-collapse");
  assert.deepEqual(collapse.map((connection) => [connection.fromStationAreaId, connection.toStationAreaId]), [
    ["fixture-a", "fixture-b"],
    ["fixture-b", "fixture-c"],
  ]);
  assert.equal(collapse[0]?.id, "fixture-collapse:0-1");
  assert.equal(collapse[0]?.fromStopSequence, 0);
  assert.equal(collapse[0]?.toStopSequence, 1);
  assert.equal(collapse[1]?.id, "fixture-collapse:1-2");
  assert.equal(collapse[1]?.fromStopSequence, 1);
  assert.equal(collapse[1]?.toStopSequence, 2);
});

test("station-level collapse boards and alights at the earliest stop that allows the maneuver", () => {
  const schedule = FIXTURE_SCHEDULED_ARTIFACT;
  const collapse = schedule.connections.filter((connection) => connection.tripId === "fixture-collapse");
  assert.equal(collapse[0]?.pickupType, 0);
  assert.equal(collapse[0]?.departureTimeSeconds, 8 * 3600 + 42 * 60);
  assert.equal(collapse[0]?.dropOffType, 0);
  assert.equal(collapse[0]?.arrivalTimeSeconds, 8 * 3600 + 52 * 60);
  assert.equal(collapse[1]?.pickupType, 0);
  assert.equal(collapse[1]?.departureTimeSeconds, 8 * 3600 + 51 * 60);
  assert.equal(collapse[1]?.dropOffType, 0);
  assert.equal(collapse[1]?.arrivalTimeSeconds, 9 * 3600);
});

test("station-level collapse keeps non-consecutive same-area visits as separate connections", () => {
  const schedule = FIXTURE_SCHEDULED_ARTIFACT;
  const returnTrip = schedule.connections.filter((connection) => connection.tripId === "fixture-return");
  assert.deepEqual(returnTrip.map((connection) => [connection.fromStationAreaId, connection.toStationAreaId]), [
    ["fixture-a", "fixture-b"],
    ["fixture-b", "fixture-c"],
    ["fixture-c", "fixture-b"],
  ]);
  assert.equal(returnTrip[0]?.fromStopSequence, 0);
  assert.equal(returnTrip[1]?.toStopSequence, 2);
  assert.equal(returnTrip[2]?.fromStopSequence, 2);
  assert.equal(returnTrip[2]?.toStopSequence, 3);
});

test("station area modes are classified according to strict hierarchy: S-Bahn > U-Bahn > Tram > Bus", () => {
  const customFiles: GtfsFeedFiles = {
    ...FIXTURE_FILES,
    "routes.txt": [
      "route_id,route_short_name,route_long_name,route_type",
      "sbahn-line,S1,S-Bahn 1,2",
      "ubahn-line,U2,U-Bahn 2,1",
      "tram-line,19,Tram 19,0",
      "bus-line,100,Museumsbus,3",
    ].join("\n"),
    "stops.txt": [
      "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
      "multi-station,Multi Station,48.1374,11.5755,1,",
      "multi-s,Multi S Platform,48.1374,11.5755,0,multi-station",
      "multi-u,Multi U Platform,48.1374,11.5755,0,multi-station",
      "u-tram-station,U-Tram Station,48.1400,11.5700,1,",
      "ut-u,UT U Platform,48.1400,11.5700,0,u-tram-station",
      "ut-t,UT T Platform,48.1400,11.5700,0,u-tram-station",
      "tram-bus-station,Tram-Bus Station,48.1450,11.5650,1,",
      "tb-t,TB T Platform,48.1450,11.5650,0,tram-bus-station",
      "tb-b,TB B Platform,48.1450,11.5650,0,tram-bus-station",
      "bus-only-station,Bus Only Station,48.1500,11.5600,1,",
      "bo-b,BO B Platform,48.1500,11.5600,0,bus-only-station",
    ].join("\n"),
    "trips.txt": [
      "route_id,service_id,trip_id",
      "sbahn-line,weekday,s-trip",
      "ubahn-line,weekday,u-trip",
      "tram-line,weekday,t-trip",
      "bus-line,weekday,b-trip",
    ].join("\n"),
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "s-trip,08:00:00,08:00:00,multi-s,1",
      "s-trip,08:10:00,08:10:00,bo-b,2",
      "u-trip,08:00:00,08:00:00,multi-u,1",
      "u-trip,08:10:00,08:10:00,ut-u,2",
      "t-trip,08:00:00,08:00:00,ut-t,1",
      "t-trip,08:10:00,08:10:00,tb-t,2",
      "b-trip,08:00:00,08:00:00,tb-b,1",
      "b-trip,08:10:00,08:10:00,bo-b,2",
    ].join("\n"),
  };
  const compiled = importFixtureFiles(customFiles);
  const byId = new Map(compiled.stationAreas.map((a) => [a.id, a]));
  // Multi has S-Bahn and U-Bahn -> highest is S-Bahn
  assert.equal(byId.get("multi-station")?.mode, "sbahn");
  // U-Tram has U-Bahn and Tram -> highest is U-Bahn
  assert.equal(byId.get("u-tram-station")?.mode, "ubahn");
  // Tram-Bus has Tram and Bus -> highest is Tram
  assert.equal(byId.get("tram-bus-station")?.mode, "tram");
  // Bus-Only has S-Bahn visit (bo-b on s-trip) -> S-Bahn
  assert.equal(byId.get("bus-only-station")?.mode, "sbahn");
});

test("v3 scheduled calculation accepts an external-Munich (MVV-area) origin", async () => {
  const parsed = parseScheduledMeetingRequest({
    contractVersion: "meeet-meeting/v3",
    participants: [
      { id: "red", origin: { label: "Garching Forschungszentrum", latitude: 48.2614, longitude: 11.6711 }, mode: "transit" },
      { id: "blue", origin: { label: "Baldham", latitude: 48.1014, longitude: 11.7872 }, mode: "transit" },
    ],
    tolerancePercent: 10,
    changeTimePreset: "medium",
    searchStartAt: "2026-08-11T08:05:00+02:00",
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const response = await calculateScheduledMeeting(parsed.data, {
    artifact: FIXTURE_SCHEDULED_ARTIFACT,
    access: FIXTURE_SCHEDULED_ACCESS_PROVIDER,
  });
  assert.equal(response.metadata.origins.coverage, "globally-valid-origin/v1");
  assert.equal(validateScheduledMeetingResponse(response, parsed.data).success, true);
});

test("v3 scheduled calculation yields an explicit no-result when external origins have no access seeds", async () => {
  const parsed = parseScheduledMeetingRequest({
    contractVersion: "meeet-meeting/v3",
    participants: [
      { id: "red", origin: { label: "Herrsching", latitude: 48.0025, longitude: 11.1764 }, mode: "transit" },
      { id: "blue", origin: { label: "Garching", latitude: 48.2614, longitude: 11.6711 }, mode: "transit" },
    ],
    tolerancePercent: 10,
    changeTimePreset: "medium",
    searchStartAt: "2026-08-11T08:05:00+02:00",
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const response = await calculateScheduledMeeting(parsed.data, {
    artifact: FIXTURE_SCHEDULED_ARTIFACT,
    access: { ...FIXTURE_SCHEDULED_ACCESS_PROVIDER, resolveAccessSeeds: async () => [] },
  });
  assert.equal(response.status, "no-result");
  assert.equal(response.reason, "no-access-seeds");
  assert.equal(response.metadata.origins.coverage, "globally-valid-origin/v1");
  assert.equal(validateScheduledMeetingResponse(response, parsed.data).success, true);
});

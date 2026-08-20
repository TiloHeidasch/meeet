import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SCHEDULED_MVV_FEED_URL,
  ScheduleArtifactUnavailableError,
  compileScheduledArtifact,
  loadScheduledArtifact,
  writeScheduledArtifact,
} from "../lib/domain/scheduled-routing/artifact.ts";
import {
  parseScheduledMeetingRequest,
  type ScheduledMeetingResponseDto,
  validateScheduledMeetingResponse,
} from "../lib/validation/meeting-v3.ts";
import {
  calculateScheduledMeeting,
  type ScheduledMeetingProviderBundle,
} from "../lib/domain/scheduled-routing/meeting.ts";
import {
  FIXTURE_SCHEDULED_ACCESS_PROVIDER,
  FIXTURE_SCHEDULED_ARTIFACT,
} from "../lib/fixtures/scheduled-routing.ts";
import { currentDateRange, fixtureFeedFiles } from "../scripts/fixture-schedule-transform.ts";
import { MvgScheduledAccessSeedProvider } from "../lib/providers/mvg-scheduled-access.ts";
import { handleMeetingPost } from "../lib/domain/meeting-api.ts";
import { fixtureProviders } from "../lib/fixtures/providers.ts";
import type { MeetingProviders } from "../lib/domain/providers.ts";
import { compareScheduledIds, importGtfsSchedule, type GtfsFeedFiles } from "../lib/domain/scheduled-routing/gtfs.ts";
import type { ScheduledRoutingArtifact } from "../lib/domain/scheduled-routing/models.ts";
import { buildScheduledStationAreaCatalog } from "../lib/domain/scheduled-routing/surface.ts";
import { createMeetingProviders } from "../lib/providers/factory.ts";
import { MVG_NEARBY_URL } from "../lib/providers/mvg-constants.ts";
import { ScheduledCalculationDeadlineError } from "../lib/domain/scheduled-admission.ts";
import type { ScheduledAccessSeedCandidate, ScheduledAccessSeedRequest } from "../lib/domain/providers.ts";

const V3_REQUEST = {
  contractVersion: "meeet-meeting/v3",
  participants: [
    { id: "red", origin: { label: "Origin red", latitude: 48.1374, longitude: 11.5755 }, mode: "transit" },
    { id: "blue", origin: { label: "Origin blue", latitude: 48.1400, longitude: 11.5700 }, mode: "transit" },
  ],
  tolerancePercent: 10,
  changeTimePreset: "medium",
  searchStartAt: "2026-08-11T08:05:00+02:00",
};

function compilerFeedFiles(): GtfsFeedFiles {
  return {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nfixture,Fixture,https://example.test,Europe/Berlin",
    "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_version,feed_start_date,feed_end_date\n\"Münchner Verkehrs- und Tarifverbund GmbH (MVV)\",https://www.mvv-muenchen.de,de,phase2-fixture,20260801,20260831",
    "attributions.txt": "attribution_id,organization_name,attribution_text,attribution_url\nofficial,\"Münchner Verkehrs- und Tarifverbund GmbH (MVV)\",\"Data licensed under CC BY 4.0\",https://creativecommons.org/licenses/by/4.0/",
    "routes.txt": "route_id,route_short_name,route_type\nfixture-line,F,3",
    "stops.txt": "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nfixture-a,Fixture A,48.1374,11.5755,1,\nfixture-a-stop,Fixture A stop,48.1374,11.5755,0,fixture-a\nfixture-b,Fixture B,48.1400,11.5700,1,\nfixture-b-stop,Fixture B stop,48.1400,11.5700,0,fixture-b",
    "trips.txt": "route_id,service_id,trip_id\nfixture-line,fixture-service,fixture-trip",
    "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nfixture-trip,08:10:00,08:10:00,fixture-a-stop,1\nfixture-trip,08:20:00,08:20:00,fixture-b-stop,2",
    "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nfixture-service,1,1,1,1,1,1,1,20260801,20260831",
  };
}

function localeOrderingCompilerFeedFiles(): GtfsFeedFiles {
  return {
    ...compilerFeedFiles(),
    "routes.txt": "route_id,route_short_name,route_type\nfixture-line,F,3\nä-route,Ä,3\nz-route,Z,3",
  };
}

function interleavedTripOrderingCompilerFeedFiles(): GtfsFeedFiles {
  return {
    ...compilerFeedFiles(),
    "routes.txt": "route_id,route_short_name,route_type\nroute-z,Z,3\nroute-a,A,3",
    "trips.txt": "route_id,service_id,trip_id\nroute-z,service-z,trip-a\nroute-a,service-a,trip-z",
    "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\ntrip-a,08:10:00,08:10:00,fixture-a-stop,1\ntrip-a,08:20:00,08:20:00,fixture-b-stop,2\ntrip-z,08:30:00,08:30:00,fixture-a-stop,1\ntrip-z,08:40:00,08:40:00,fixture-b-stop,2",
    "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nservice-z,1,1,1,1,1,1,1,20260801,20260831\nservice-a,1,1,1,1,1,1,1,20260801,20260831",
  };
}

async function validScheduledResponse(): Promise<ScheduledMeetingResponseDto> {
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) throw new Error("Fixture request unexpectedly failed validation.");
  return calculateScheduledMeeting(parsed.data, {
    artifact: FIXTURE_SCHEDULED_ARTIFACT,
    access: FIXTURE_SCHEDULED_ACCESS_PROVIDER,
  });
}

interface MutableResponseShape {
  status: string;
  reason: string | null;
  readonly participants: Array<{ id: string; origin: Record<string, unknown>; readonly accessSeeds: Array<Record<string, unknown>> }>;
  readonly stationAreas: Array<Record<string, unknown>>;
  readonly metadata: {
    readonly schedule: Record<string, unknown>;
    readonly surface: Record<string, unknown>;
    readonly stationAreas: Record<string, unknown>;
    readonly accessProvider: Record<string, unknown>;
  };
}

function mutableResponse(response: ScheduledMeetingResponseDto): MutableResponseShape {
  return JSON.parse(JSON.stringify(response)) as MutableResponseShape;
}

function stationAreaMeetingFeedFiles(): GtfsFeedFiles {
  return {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nfixture,Fixture,https://example.test,Europe/Berlin",
    "routes.txt": "route_id,route_short_name,route_long_name,route_type\nred,R,Red,3\nblue,B,Blue,3",
    "stops.txt": [
      "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
      "red-area,Red area,48.1374,11.5755,1,",
      "a-slow,Red slow platform,48.1374,11.5800,0,red-area",
      "z-fast,Red fast platform,48.1374,11.5755,0,red-area",
      "fair-area,Fair area,48.1380,11.5760,1,",
      "fair-stop,Fair platform,48.1380,11.5760,0,fair-area",
      "blue-area,Blue area,48.1390,11.5770,1,",
      "blue-stop,Blue platform,48.1390,11.5770,0,blue-area",
      "unserved-area,Unserved area,48.1000,11.5000,1,",
      "unserved-stop,Unserved platform,48.1000,11.5000,0,unserved-area",
      "unserved-stop-2,Unserved platform 2,48.1000,11.5001,0,unserved-area",
      "disconnected-area,Disconnected area,48.1010,11.5010,1,",
      "disconnected-stop,Disconnected platform,48.1010,11.5010,0,disconnected-area",
      "outside-stop-area,Outside-stop area,48.1020,11.5020,1,",
      "outside-child-stop,Outside platform,48.5000,11.5000,0,outside-stop-area",
      "outside-child-stop-2,Outside platform 2,48.5000,11.5001,0,outside-stop-area",
      "outside-area,Outside area,48.5000,11.5000,1,",
      "outside-stop,Outside platform,48.5000,11.5000,0,outside-area",
    ].join("\n"),
    "trips.txt": "route_id,service_id,trip_id,trip_headsign\nred,fixture-service,red-trip,Fair and blue\nblue,fixture-service,blue-trip,Fair\nred,fixture-service,slow-trip,Slow and fair\nred,fixture-service,unserved-trip,Unserved\nred,fixture-service,outside-stop-trip,Outside",
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type",
      "red-trip,08:10:00,08:10:00,z-fast,1,0,0",
      "red-trip,08:20:00,08:20:00,fair-stop,2,0,0",
      "red-trip,08:35:00,08:35:00,blue-stop,3,0,0",
      "blue-trip,08:10:00,08:10:00,blue-stop,1,0,0",
      "blue-trip,08:20:00,08:20:00,fair-stop,2,0,0",
      "unserved-trip,08:10:00,08:10:00,unserved-stop,1,0,0",
      "unserved-trip,08:20:00,08:20:00,unserved-stop-2,2,0,0",
      "slow-trip,08:10:00,08:10:00,a-slow,1,0,0",
      "slow-trip,08:20:00,08:20:00,fair-stop,2,0,0",
      "outside-stop-trip,08:10:00,08:10:00,outside-child-stop,1,0,0",
      "outside-stop-trip,08:20:00,08:20:00,outside-child-stop-2,2,0,0",
    ].join("\n"),
    "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nfixture-service,1,1,1,1,1,1,1,20260801,20260831",
  };
}

function stationAreaMeetingArtifact() {
  return importGtfsSchedule(stationAreaMeetingFeedFiles(), {
    feedId: "station-area-meeting-feed",
    acquisition: FIXTURE_SCHEDULED_ARTIFACT.provenance.acquisition,
  });
}

function stationAreaMeetingAccessProvider(empty = false) {
  return {
    ...FIXTURE_SCHEDULED_ACCESS_PROVIDER,
    async resolveAccessSeeds(request: ScheduledAccessSeedRequest): Promise<readonly ScheduledAccessSeedCandidate[]> {
      if (empty) return [];
      const stationAreaId = request.origin.latitude < 48.139 ? "red-area" : "blue-area";
      const area = request.schedule.stationAreas.find((candidate) => candidate.id === stationAreaId);
      if (area === undefined) throw new Error(`Missing ${stationAreaId}`);
      return [{
        seedId: `fixture-access:${stationAreaId}`,
        mvgStationId: stationAreaId,
        stationAreaId,
        coordinate: area.coordinate,
        accessSeconds: 0,
        provenance: {
          source: "fixture-static",
          endpoint: "fixture-static",
          distanceMeters: 0,
          walkingSeconds: 0,
          note: "No upstream service was contacted.",
        },
      }];
    },
  };
}

test("compiler and loader retain raw acquisition provenance and reject malformed or stale artifacts", async () => {
  const rawArchiveBytes = new TextEncoder().encode("deterministic raw archive bytes");
  const artifact = compileScheduledArtifact({
    sourceUrl: SCHEDULED_MVV_FEED_URL,
    rawArchiveBytes,
    feedFiles: compilerFeedFiles(),
    retrievedAt: "2026-08-11T10:00:00Z",
  });
  assert.equal(artifact.provenance.acquisition.sourceUrl, SCHEDULED_MVV_FEED_URL);
  assert.equal(artifact.provenance.acquisition.rawArchiveByteSize, rawArchiveBytes.byteLength);
  assert.notEqual(artifact.provenance.compiledArtifactId, artifact.provenance.acquisition.rawArchiveSha256);
  assert.equal(artifact.provenance.acquisition.officialAttribution, "Münchner Verkehrs- und Tarifverbund GmbH (MVV)");
  assert.equal(artifact.provenance.acquisition.officialLicense.name, "CC BY 4.0");
  assert.deepEqual(artifact.provenance.acquisition.officialProvenance, { source: "feed", policyId: null });

  const directory = await mkdtemp(join(tmpdir(), "meeet-schedule-"));
  const artifactPath = join(directory, "scheduled-artifact.json");
  writeScheduledArtifact(artifactPath, artifact);
  const loaded = loadScheduledArtifact(artifactPath, { now: "2026-08-11T12:00:00Z" });
  assert.equal(loaded.provenance.compiledArtifactId, artifact.provenance.compiledArtifactId);
  const cachedPath = join(directory, "cached-artifact.json");
  writeScheduledArtifact(cachedPath, artifact);
  const cached = loadScheduledArtifact(cachedPath, { now: "2026-08-11T12:00:00Z" });
  await writeFile(cachedPath, "{}", "utf8");
  assert.strictEqual(loadScheduledArtifact(cachedPath, { now: "2026-08-11T12:00:00Z" }), cached);
  const malformedPath = join(directory, "malformed-artifact.json");
  const malformed = JSON.parse(await readFile(artifactPath, "utf8")) as { compiledArtifactId: string };
  malformed.compiledArtifactId = "0".repeat(64);
  await writeFile(malformedPath, JSON.stringify(malformed), "utf8");
  assert.throws(() => loadScheduledArtifact(malformedPath, { now: "2026-08-11T12:00:00Z" }), ScheduleArtifactUnavailableError);
  await rm(directory, { recursive: true, force: true });
});

test("station-area collapse is strict: old boarding-stop shapes are rejected at write and load", async () => {
  const artifact = compileScheduledArtifact({
    sourceUrl: SCHEDULED_MVV_FEED_URL,
    rawArchiveBytes: new TextEncoder().encode("strict-shape-tamper"),
    feedFiles: compilerFeedFiles(),
    retrievedAt: "2026-08-11T10:00:00Z",
  });
  const oldShape = {
    ...artifact,
    boardingStops: [{ id: "fixture-a-stop", name: "Fixture A stop", coordinate: { latitude: 48.1374, longitude: 11.5755 }, stationAreaId: "fixture-a" }],
    stationAreas: artifact.stationAreas.map((area) => ({ ...area, boardingStopIds: ["fixture-a-stop"], parentStationId: null })),
    connections: artifact.connections.map((connection) => ({ ...connection, fromStopId: "fixture-a-stop", toStopId: "fixture-b-stop" })),
  } as unknown as ScheduledRoutingArtifact;
  const directory = await mkdtemp(join(tmpdir(), "meeet-old-shape-"));
  const manifestPath = join(directory, "scheduled-bundle.json");
  assert.throws(() => writeScheduledArtifact(manifestPath, oldShape), ScheduleArtifactUnavailableError);
  await rm(directory, { recursive: true, force: true });
});

test("scheduled artifact persists as a compact binary bundle and retains immutable cache identity", async () => {
  const artifact = compileScheduledArtifact({
    sourceUrl: SCHEDULED_MVV_FEED_URL,
    rawArchiveBytes: new TextEncoder().encode("binary-bundle-fixture"),
    feedFiles: compilerFeedFiles(),
    retrievedAt: "2026-08-11T10:00:00Z",
  });
  const directory = await mkdtemp(join(tmpdir(), "meeet-bundle-"));
  const manifestPath = join(directory, "scheduled-bundle.json");
  writeScheduledArtifact(manifestPath, artifact);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { contractVersion: string; encoding: string; writerNodeMajor: number; payloadFile: string; payloadByteLength: number; provenance?: unknown; routes?: unknown };
  assert.equal(manifest.contractVersion, "meeet-scheduled-routing-bundle/v1");
  assert.equal(manifest.encoding, "node-v8-structured-clone/1");
  assert.equal(manifest.writerNodeMajor, Number(process.versions.node.split(".")[0]));
  assert.equal(manifest.routes, undefined);
  assert.equal(manifest.provenance !== undefined, true);
  assert.ok(manifest.payloadFile.endsWith(".v8.bin"));
  assert.equal((await readFile(join(directory, manifest.payloadFile))).byteLength, manifest.payloadByteLength);
  const loaded = loadScheduledArtifact(manifestPath, { now: "2026-08-11T12:00:00Z" });
  assert.strictEqual(loadScheduledArtifact(manifestPath, { now: "2026-08-11T12:00:00Z" }), loaded);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.connections), true);
  await rm(directory, { recursive: true, force: true });
});

test("loader normalizes its default freshness clock but keeps explicit fractional now invalid", async () => {
  const artifact = compileScheduledArtifact({ sourceUrl: SCHEDULED_MVV_FEED_URL, rawArchiveBytes: new TextEncoder().encode("default-loader-clock"), feedFiles: compilerFeedFiles(), retrievedAt: "2026-08-11T10:00:00Z" });
  const directory = await mkdtemp(join(tmpdir(), "meeet-loader-clock-"));
  const manifestPath = join(directory, "scheduled-bundle.json");
  writeScheduledArtifact(manifestPath, artifact);
  const RealDate = globalThis.Date;
  class FractionalDate extends RealDate {
    static now(): number {
      return RealDate.parse("2026-08-11T12:00:00.987Z");
    }

    constructor(value?: string | number | Date) {
      super(value === undefined ? "2026-08-11T12:00:00.987Z" : value instanceof RealDate ? value.getTime() : value);
    }
  }
  globalThis.Date = FractionalDate as unknown as DateConstructor;
  try {
    assert.doesNotThrow(() => loadScheduledArtifact(manifestPath));
  } finally {
    globalThis.Date = RealDate;
  }
  assert.throws(() => loadScheduledArtifact(manifestPath, { now: "2026-08-11T12:00:00.123Z" }), ScheduleArtifactUnavailableError);
  await rm(directory, { recursive: true, force: true });
});

test("loader freshness clock stays at whole-second precision and is not minute-rounded like searchStartAt", async () => {
  const artifact = compileScheduledArtifact({ sourceUrl: SCHEDULED_MVV_FEED_URL, rawArchiveBytes: new TextEncoder().encode("freshness-precision"), feedFiles: compilerFeedFiles(), retrievedAt: "2026-08-11T10:00:00Z" });
  assert.equal(artifact.provenance.acquisition.feedValidUntil, "2026-08-31");
  const directory = await mkdtemp(join(tmpdir(), "meeet-loader-freshness-"));
  const manifestPath = join(directory, "scheduled-bundle.json");
  writeScheduledArtifact(manifestPath, artifact);
  // 2026-08-31T23:59:30+02:00 Berlin local: still the last valid feed day. A freshness
  // clock that reused the searchStartAt minute-ceil rounding would round this up to
  // 2026-09-01T00:00:00+02:00 and wrongly treat the feed as expired a minute early.
  assert.doesNotThrow(() => loadScheduledArtifact(manifestPath, { now: "2026-08-31T21:59:30Z" }));
  // One second after Berlin local midnight, the feed is genuinely expired.
  assert.throws(() => loadScheduledArtifact(manifestPath, { now: "2026-08-31T22:00:01Z" }), ScheduleArtifactUnavailableError);
  await rm(directory, { recursive: true, force: true });
});

test("loader rejects a bundle manifest written for a different Node major before payload deserialization", async () => {
  const artifact = compileScheduledArtifact({ sourceUrl: SCHEDULED_MVV_FEED_URL, rawArchiveBytes: new TextEncoder().encode("node-major-mismatch"), feedFiles: compilerFeedFiles(), retrievedAt: "2026-08-11T10:00:00Z" });
  const directory = await mkdtemp(join(tmpdir(), "meeet-node-major-"));
  const manifestPath = join(directory, "scheduled-bundle.json");
  writeScheduledArtifact(manifestPath, artifact);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const mismatchedPath = join(directory, "mismatched-bundle.json");
  await writeFile(mismatchedPath, JSON.stringify({ ...manifest, writerNodeMajor: Number(process.versions.node.split(".")[0]) + 1 }), "utf8");
  assert.throws(() => loadScheduledArtifact(mismatchedPath, { now: "2026-08-11T12:00:00Z" }), /Node major/);
  await rm(directory, { recursive: true, force: true });
});

test("binary bundle roundtrip accepts the importer's locale-ordered MVV-shaped IDs", async () => {
  assert.equal("ä-route" >= "z-route", true);
  assert.equal("ä-route".localeCompare("z-route") < 0, true);
  assert.equal(compareScheduledIds("ä-route", "z-route") < 0, true);
  const artifact = compileScheduledArtifact({
    sourceUrl: SCHEDULED_MVV_FEED_URL,
    rawArchiveBytes: new TextEncoder().encode("locale-ordering-fixture"),
    feedFiles: localeOrderingCompilerFeedFiles(),
    retrievedAt: "2026-08-11T10:00:00Z",
  });
  assert.deepEqual(artifact.routes.map((route) => route.routeId), ["ä-route", "fixture-line", "z-route"]);
  const directory = await mkdtemp(join(tmpdir(), "meeet-locale-ordering-"));
  const manifestPath = join(directory, "scheduled-bundle.json");
  writeScheduledArtifact(manifestPath, artifact);
  const loaded = loadScheduledArtifact(manifestPath, { now: "2026-08-11T12:00:00Z" });
  assert.deepEqual(loaded.routes.map((route) => route.routeId), ["ä-route", "fixture-line", "z-route"]);
  await rm(directory, { recursive: true, force: true });
});

test("binary bundle roundtrip preserves trip ID ordering across interleaved routes", async () => {
  const artifact = compileScheduledArtifact({
    sourceUrl: SCHEDULED_MVV_FEED_URL,
    rawArchiveBytes: new TextEncoder().encode("interleaved-trip-ordering-fixture"),
    feedFiles: interleavedTripOrderingCompilerFeedFiles(),
    retrievedAt: "2026-08-11T10:00:00Z",
  });
  const directory = await mkdtemp(join(tmpdir(), "meeet-interleaved-trips-"));
  const manifestPath = join(directory, "scheduled-bundle.json");
  writeScheduledArtifact(manifestPath, artifact);
  assert.deepEqual(artifact.routes.map((route) => route.routeId), ["route-a", "route-z"]);
  assert.deepEqual(artifact.trips.map((trip) => trip.tripId), ["trip-a", "trip-z"]);
  const loaded = loadScheduledArtifact(manifestPath, { now: "2026-08-11T12:00:00Z" });
  assert.deepEqual(loaded.trips.map((trip) => trip.tripId), ["trip-a", "trip-z"]);
  await rm(directory, { recursive: true, force: true });
});

test("bundle loader rejects truncated or substituted payloads and rechecks cached expiry and raw identity", async () => {
  const rawArchiveBytes = new TextEncoder().encode("bundle-integrity-archive");
  const artifact = compileScheduledArtifact({ sourceUrl: SCHEDULED_MVV_FEED_URL, rawArchiveBytes, feedFiles: compilerFeedFiles(), feedId: "integrity-feed", retrievedAt: "2026-08-11T10:00:00Z" });
  const substitutedArtifact = compileScheduledArtifact({ sourceUrl: SCHEDULED_MVV_FEED_URL, rawArchiveBytes: new TextEncoder().encode("bundle-substitution-archive"), feedFiles: compilerFeedFiles(), feedId: "substituted-feed", retrievedAt: "2026-08-11T10:00:00Z" });
  const createBundle = async (name: string, value: typeof artifact) => {
    const directory = await mkdtemp(join(tmpdir(), `meeet-${name}-`));
    const manifestPath = join(directory, "scheduled-bundle.json");
    writeScheduledArtifact(manifestPath, value);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { payloadFile: string };
    return { directory, manifestPath, payloadPath: join(directory, manifest.payloadFile) };
  };

  const truncated = await createBundle("truncated", artifact);
  const truncatedBytes = await readFile(truncated.payloadPath);
  await writeFile(truncated.payloadPath, truncatedBytes.subarray(0, truncatedBytes.byteLength - 1));
  assert.throws(() => loadScheduledArtifact(truncated.manifestPath, { now: "2026-08-11T12:00:00Z" }), ScheduleArtifactUnavailableError);
  await rm(truncated.directory, { recursive: true, force: true });

  const original = await createBundle("original", artifact);
  const substituted = await createBundle("substituted", substitutedArtifact);
  await writeFile(original.payloadPath, await readFile(substituted.payloadPath));
  assert.throws(() => loadScheduledArtifact(original.manifestPath, { now: "2026-08-11T12:00:00Z" }), ScheduleArtifactUnavailableError);
  await rm(original.directory, { recursive: true, force: true });
  await rm(substituted.directory, { recursive: true, force: true });

  const cachedBundle = await createBundle("cached-recheck", artifact);
  const cached = loadScheduledArtifact(cachedBundle.manifestPath, { now: "2026-08-11T12:00:00Z", rawArchiveBytes });
  assert.equal(Object.isFrozen(cached), true);
  assert.throws(() => loadScheduledArtifact(cachedBundle.manifestPath, { now: "2026-08-11T12:00:00Z", rawArchiveBytes: new TextEncoder().encode("wrong-archive") }), ScheduleArtifactUnavailableError);
  assert.throws(() => loadScheduledArtifact(cachedBundle.manifestPath, { now: "2026-09-01T12:00:00Z", rawArchiveBytes }), ScheduleArtifactUnavailableError);
  await rm(cachedBundle.directory, { recursive: true, force: true });
});

test("bundle manifest rejects unsafe payload paths and size-limit violations", async () => {
  const artifact = compileScheduledArtifact({ sourceUrl: SCHEDULED_MVV_FEED_URL, rawArchiveBytes: new TextEncoder().encode("manifest-limits"), feedFiles: compilerFeedFiles(), retrievedAt: "2026-08-11T10:00:00Z" });
  const directory = await mkdtemp(join(tmpdir(), "meeet-manifest-limits-"));
  const manifestPath = join(directory, "scheduled-bundle.json");
  writeScheduledArtifact(manifestPath, artifact);
  const validManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;

  await writeFile(manifestPath, JSON.stringify({ ...validManifest, payloadFile: "../outside.v8.bin" }), "utf8");
  assert.throws(() => loadScheduledArtifact(manifestPath, { now: "2026-08-11T12:00:00Z" }), ScheduleArtifactUnavailableError);
  await writeFile(manifestPath, "x".repeat(1_048_577), "utf8");
  assert.throws(() => loadScheduledArtifact(manifestPath, { now: "2026-08-11T12:00:00Z" }), ScheduleArtifactUnavailableError);
  await writeFile(manifestPath, JSON.stringify({ ...validManifest, payloadByteLength: 1_073_741_825 }), "utf8");
  assert.throws(() => loadScheduledArtifact(manifestPath, { now: "2026-08-11T12:00:00Z" }), ScheduleArtifactUnavailableError);
  await rm(directory, { recursive: true, force: true });
});

test("compiler defaults retrieval provenance to a canonical UTC whole-second instant", () => {
  const artifact = compileScheduledArtifact({
    sourceUrl: SCHEDULED_MVV_FEED_URL,
    rawArchiveBytes: new TextEncoder().encode("default-retrieval-time"),
    feedFiles: compilerFeedFiles(),
  });
  const retrievedAt = artifact.provenance.acquisition.retrievedAt;
  assert.match(retrievedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  assert.equal(Date.parse(retrievedAt) % 1_000, 0);
  assert.throws(() => compileScheduledArtifact({
    sourceUrl: SCHEDULED_MVV_FEED_URL,
    rawArchiveBytes: new TextEncoder().encode("explicit-subsecond-retrieval-time"),
    feedFiles: compilerFeedFiles(),
    retrievedAt: "2026-08-11T10:00:00.123Z",
  }), /whole second/);
});

test("compiler rejects nonempty unsupported extensions and the CLI imports server-only code under react-server", () => {
  assert.throws(() => compileScheduledArtifact({
    sourceUrl: SCHEDULED_MVV_FEED_URL,
    rawArchiveBytes: new TextEncoder().encode("unsupported-extension"),
    feedFiles: { ...compilerFeedFiles(), "frequencies.txt": "trip_id,start_time,end_time,headway_secs\ntrip,08:00:00,09:00:00,600" },
    retrievedAt: "2026-08-11T10:00:00Z",
  }), /frequencies\.txt/);
  const help = execFileSync("npm", ["run", "schedule:compile:mvv", "--", "--help"], { encoding: "utf8" });
  assert.match(help, /ABSOLUTE_ZIP/);
});

test("canonical-feed fixture without machine-readable attribution uses explicit MVV policy provenance", () => {
  const files: Record<string, string> = { ...compilerFeedFiles() };
  delete files["attributions.txt"];
  const artifact = compileScheduledArtifact({
    sourceUrl: SCHEDULED_MVV_FEED_URL,
    rawArchiveBytes: new TextEncoder().encode("canonical-feed-without-license-fields"),
    feedFiles: files,
    retrievedAt: "2026-08-11T10:00:00Z",
  });
  assert.equal(artifact.provenance.acquisition.officialAttribution, "Münchner Verkehrs- und Tarifverbund GmbH (MVV)");
  assert.deepEqual(artifact.provenance.acquisition.officialLicense, {
    name: "CC BY 4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
  });
  assert.deepEqual(artifact.provenance.acquisition.officialProvenance, {
    source: "meeet-policy",
    policyId: "mvv-cc-by-4.0-fallback/v1",
  });
});

test("compiler rejects conflicting official feed and attribution metadata", () => {
  const files: Record<string, string> = { ...compilerFeedFiles() };
  files["attributions.txt"] += "\nofficial-duplicate,\"Münchner Verkehrs- und Tarifverbund GmbH (MVV)\",\"CC BY 3.0\",https://creativecommons.org/licenses/by/3.0/";
  assert.throws(() => compileScheduledArtifact({
    sourceUrl: SCHEDULED_MVV_FEED_URL,
    rawArchiveBytes: new TextEncoder().encode("conflicting-official-metadata"),
    feedFiles: files,
    retrievedAt: "2026-08-11T10:00:00Z",
  }), /conflicting official MVV license metadata/);
});

test("offline compiler extracts every nested GTFS text basename and retains extension provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-mvv-zip-"));
  const sourceDirectory = join(directory, "nested", "gtfs");
  const archivePath = join(directory, "input.zip");
  await mkdir(sourceDirectory, { recursive: true });
  const files = {
    ...compilerFeedFiles(),
    "frequencies.txt": "",
    "transfers.txt": "",
    "pathways.txt": "",
  };
  for (const [fileName, content] of Object.entries(files)) await writeFile(join(sourceDirectory, fileName), content, "utf8");
  execFileSync("zip", ["-q", "-r", archivePath, "nested"], { cwd: directory });
  const artifact = compileScheduledArtifact({ sourceUrl: SCHEDULED_MVV_FEED_URL, inputPath: archivePath, retrievedAt: "2026-08-11T10:00:00Z" });
  assert.ok(artifact.provenance.files.some((file) => file.fileName === "attributions.txt"));
  assert.ok(artifact.provenance.files.some((file) => file.fileName === "frequencies.txt"));
  await rm(directory, { recursive: true, force: true });
});

test("MVG scheduled access maps only exact artifact identities and never calls routes", async () => {
  const calls: string[] = [];
  const provider = new MvgScheduledAccessSeedProvider({
    fetchImplementation: async (input) => {
      calls.push(String(input));
      return Response.json({ stations: [
        { globalId: "fixture-a", latitude: 48.1374, longitude: 11.5755 },
        { globalId: "unknown-mvg-id", latitude: 48.1380, longitude: 11.5750 },
      ] });
    },
  });
  const seeds = await provider.resolveAccessSeeds({ origin: V3_REQUEST.participants[0].origin, schedule: FIXTURE_SCHEDULED_ARTIFACT });
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0]?.mvgStationId, "fixture-a");
  assert.equal(seeds[0]?.stationAreaId, "fixture-a");
  assert.equal(calls.length, 1);
  assert.equal(calls.some((url) => url.includes("/routes")), false);
});

test("scheduled access provenance is explicitly access-only and rejects routing, scheduled, live, and malformed claims", async () => {
  const provider = new MvgScheduledAccessSeedProvider({ fetchImplementation: async () => Response.json({ stations: [] }) });
  assert.equal(provider.descriptor.provenance.role, "access");
  assert.equal(provider.descriptor.provenance.dataKind, "access");
  assert.equal(provider.descriptor.dataKind, "access");

  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const response = await validScheduledResponse();
  const tamperProvider = (mutate: (provider: Record<string, unknown>, provenance: Record<string, unknown>) => void) => {
    const tamper = mutableResponse(response);
    const providerValue = tamper.metadata.accessProvider as unknown as Record<string, unknown>;
    const provenance = providerValue.provenance as Record<string, unknown>;
    mutate(providerValue, provenance);
    assert.equal(validateScheduledMeetingResponse(tamper, parsed.data).success, false);
  };
  tamperProvider((providerValue, provenance) => { providerValue.dataKind = "scheduled"; provenance.dataKind = "scheduled"; });
  tamperProvider((providerValue, provenance) => { providerValue.dataKind = "live"; provenance.dataKind = "live"; providerValue.liveData = true; provenance.liveData = true; });
  tamperProvider((_, provenance) => { provenance.role = "routing"; });
  tamperProvider((providerValue) => { providerValue.provenance = null; });
});

test("v3 request parsing canonicalizes exactly-zero fractional seconds and rejects non-zero fractions", () => {
  const zeroFraction = parseScheduledMeetingRequest({ ...V3_REQUEST, searchStartAt: "2026-08-11T08:05:00.000Z" });
  assert.equal(zeroFraction.success, true);
  if (zeroFraction.success) assert.equal(zeroFraction.data.searchStartAt, "2026-08-11T08:05:00.000Z");
  assert.equal(parseScheduledMeetingRequest({ ...V3_REQUEST, searchStartAt: "2026-08-11T08:05:00.0+02:00" }).success, true);
  assert.equal(parseScheduledMeetingRequest({ ...V3_REQUEST, searchStartAt: "2026-08-11T08:05:00.001Z" }).success, false);
  assert.equal(parseScheduledMeetingRequest({ ...V3_REQUEST, searchStartAt: "2026-08-11T08:05:00.0001Z" }).success, false);
});

test("v3 request parsing rounds whole-second searchStartAt values up to the next whole minute", () => {
  const onMinute = parseScheduledMeetingRequest({ ...V3_REQUEST, searchStartAt: "2026-08-11T08:05:00Z" });
  assert.equal(onMinute.success, true);
  if (onMinute.success) assert.equal(onMinute.data.searchStartAt, "2026-08-11T08:05:00.000Z");
  const oneSecondPastMinute = parseScheduledMeetingRequest({ ...V3_REQUEST, searchStartAt: "2026-08-11T08:05:01Z" });
  assert.equal(oneSecondPastMinute.success, true);
  if (oneSecondPastMinute.success) assert.equal(oneSecondPastMinute.data.searchStartAt, "2026-08-11T08:06:00.000Z");
  const lastSecondOfMinute = parseScheduledMeetingRequest({ ...V3_REQUEST, searchStartAt: "2026-08-11T08:05:59Z" });
  assert.equal(lastSecondOfMinute.success, true);
  if (lastSecondOfMinute.success) assert.equal(lastSecondOfMinute.data.searchStartAt, "2026-08-11T08:06:00.000Z");
});

test("scheduled meeting checks injected deadlines at each orchestration boundary", async () => {
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  for (const target of ["meeting-start", "meeting-access", "meeting-surface", "meeting-result"] as const) {
    const deadlineCheck = (phase: string): void => {
      if (phase === target) throw new ScheduledCalculationDeadlineError(`deadline-${target}`);
    };
    await assert.rejects(
      calculateScheduledMeeting(parsed.data, {
        artifact: FIXTURE_SCHEDULED_ARTIFACT,
        access: FIXTURE_SCHEDULED_ACCESS_PROVIDER,
        deadlineCheck,
      }),
      ScheduledCalculationDeadlineError,
    );
  }
});

test("v3 validation is strict and scheduled orchestration emits only the v3 station-area surface contract", async () => {
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const response = await calculateScheduledMeeting(parsed.data, {
    artifact: FIXTURE_SCHEDULED_ARTIFACT,
    access: FIXTURE_SCHEDULED_ACCESS_PROVIDER,
  } satisfies ScheduledMeetingProviderBundle);
  assert.equal(response.contractVersion, "meeet-meeting/v3");
  assert.equal(response.participants.length, 2);
  assert.equal(response.participants[0].color, "red");
  assert.equal(response.participants[1].color, "blue");
  assert.ok(response.stationAreas.length > 0);
  assert.ok(response.stationAreas.every((area) => area.stationAreaId !== "" && area.classification !== undefined));
  assert.equal(response.metadata.stationAreas.count, response.stationAreas.length);
  assert.equal(response.metadata.surface.classificationMethod, "scheduled-arrival-comparison-with-selected-tolerance/v1");
  assert.equal(response.metadata.surface.classificationBasis, "scheduled-station-area-arrival/v1");
  assert.equal(response.metadata.surface.representativePointBasis, "station-area-coordinate/v1");
  assert.equal(response.metadata.surface.finalWalkingMethod, "scheduled-access-and-transfer-walking/v1");
  assert.equal(response.metadata.surface.changeTimeSeconds, 300);
  assert.equal(response.metadata.stationAreas.coverage, "official-munich-boundary-with-connected-artifact-station-areas/v1");
  assert.equal(validateScheduledMeetingResponse(response, parsed.data).success, true);
  assert.equal("fairLocations" in response, false);
  assert.equal(parseScheduledMeetingRequest({ ...V3_REQUEST, arrivalAt: V3_REQUEST.searchStartAt }).success, false);
});

test("scheduled meeting emits every eligible Munich station area with derived classifications and fails closed on station-area tampering", async () => {
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const artifact = stationAreaMeetingArtifact();
  const response = await calculateScheduledMeeting(parsed.data, {
    artifact,
    access: stationAreaMeetingAccessProvider(),
  });
  const byId = new Map(response.stationAreas.map((candidate) => [candidate.stationAreaId, candidate]));
  assert.deepEqual([...byId.keys()], ["blue-area", "disconnected-area", "fair-area", "outside-stop-area", "red-area", "unserved-area"]);
  assert.equal(byId.get("red-area")?.classification, "red");
  assert.equal(byId.get("red-area")?.redArrivalSeconds, 0);
  assert.equal(byId.get("fair-area")?.classification, "fair");
  assert.equal(byId.get("blue-area")?.classification, "blue");
  assert.equal(byId.get("unserved-area")?.classification, "unclassified");
  assert.equal(byId.get("disconnected-area")?.classification, "unclassified");
  assert.equal(byId.get("outside-stop-area")?.classification, "unclassified");
  assert.equal(byId.get("outside-area"), undefined);
  assert.equal(response.metadata.stationAreas.count, response.stationAreas.length);
  assert.equal(validateScheduledMeetingResponse(response, parsed.data).success, true);
  const catalog = buildScheduledStationAreaCatalog(artifact);
  assert.equal(validateScheduledMeetingResponse(response, parsed.data, { stationAreaCatalog: catalog }).success, true);

  const deleted = mutableResponse(response);
  deleted.stationAreas.pop();
  assert.equal(validateScheduledMeetingResponse(deleted, parsed.data, { stationAreaCatalog: catalog }).success, false);

  const reordered = mutableResponse(response);
  [reordered.stationAreas[0], reordered.stationAreas[1]] = [reordered.stationAreas[1]!, reordered.stationAreas[0]!];
  assert.equal(validateScheduledMeetingResponse(reordered, parsed.data, { stationAreaCatalog: catalog }).success, false);

  const renamed = mutableResponse(response);
  renamed.stationAreas[0]!.name = "Tampered name";
  assert.equal(validateScheduledMeetingResponse(renamed, parsed.data, { stationAreaCatalog: catalog }).success, false);

  const relocated = mutableResponse(response);
  relocated.stationAreas[0]!.coordinate = { latitude: 48.2, longitude: 11.6 };
  assert.equal(validateScheduledMeetingResponse(relocated, parsed.data, { stationAreaCatalog: catalog }).success, false);

  const noResult = await calculateScheduledMeeting(parsed.data, {
    artifact,
    access: stationAreaMeetingAccessProvider(true),
  });
  assert.equal(noResult.status, "no-result");
  assert.ok(noResult.stationAreas.every((candidate) => candidate.classification === "unclassified"));
  assert.equal(validateScheduledMeetingResponse(noResult, parsed.data, { stationAreaCatalog: catalog }).success, true);

  const classificationTamper = mutableResponse(response);
  classificationTamper.stationAreas.find((candidate) => candidate.stationAreaId === "red-area")!.classification = "blue";
  assert.equal(validateScheduledMeetingResponse(classificationTamper, parsed.data).success, false);

  const idTamper = mutableResponse(response);
  idTamper.stationAreas[0]!.stationAreaId = idTamper.stationAreas[1]!.stationAreaId;
  assert.equal(validateScheduledMeetingResponse(idTamper, parsed.data).success, false);

  const countTamper = mutableResponse(response);
  countTamper.metadata.stationAreas.count = response.stationAreas.length + 1;
  assert.equal(validateScheduledMeetingResponse(countTamper, parsed.data).success, false);
});

test("v3 response validation derives exact station-area classification and rejects arrival tampering", async () => {
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const response = await validScheduledResponse();
  assert.equal(validateScheduledMeetingResponse(response, parsed.data).success, true);
  const sourceIndex = response.stationAreas.findIndex((area) => area.redArrivalSeconds !== null && area.blueArrivalSeconds !== null);
  assert.ok(sourceIndex >= 0);

  const classificationTamper = mutableResponse(response);
  const classificationArea = classificationTamper.stationAreas[sourceIndex]!;
  classificationArea.redArrivalSeconds = 0;
  classificationArea.blueArrivalSeconds = 100;
  classificationArea.classification = "fair";
  classificationArea.fasterParticipant = null;
  classificationArea.withinSelectedTolerance = true;
  assert.equal(validateScheduledMeetingResponse(classificationTamper, parsed.data).success, false);

  const fasterParticipantTamper = mutableResponse(response);
  const fasterArea = fasterParticipantTamper.stationAreas[sourceIndex]!;
  fasterArea.redArrivalSeconds = 0;
  fasterArea.blueArrivalSeconds = 100;
  fasterArea.classification = "red";
  fasterArea.fasterParticipant = "blue";
  fasterArea.withinSelectedTolerance = false;
  assert.equal(validateScheduledMeetingResponse(fasterParticipantTamper, parsed.data).success, false);

  const oneSidedTamper = mutableResponse(response);
  const oneSidedArea = oneSidedTamper.stationAreas[sourceIndex]!;
  oneSidedArea.redArrivalSeconds = 100;
  oneSidedArea.blueArrivalSeconds = null;
  oneSidedArea.classification = "red";
  oneSidedArea.fasterParticipant = null;
  oneSidedArea.withinSelectedTolerance = false;
  assert.equal(validateScheduledMeetingResponse(oneSidedTamper, parsed.data).success, false);
});

test("v3 response validation rejects arrival and access seconds that are not minute-aligned", async () => {
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const response = await validScheduledResponse();
  assert.equal(validateScheduledMeetingResponse(response, parsed.data).success, true);
  const sourceIndex = response.stationAreas.findIndex((area) => area.redArrivalSeconds !== null);
  assert.ok(sourceIndex >= 0);

  const arrivalTamper = mutableResponse(response);
  const arrivalArea = arrivalTamper.stationAreas[sourceIndex]!;
  arrivalArea.redArrivalSeconds = (arrivalArea.redArrivalSeconds as number) + 1;
  assert.equal(validateScheduledMeetingResponse(arrivalTamper, parsed.data).success, false);

  const accessTamper = mutableResponse(response);
  const seed = accessTamper.participants[0]!.accessSeeds[0];
  assert.ok(seed !== undefined);
  seed.accessSeconds = (seed.accessSeconds as number) + 1;
  assert.equal(validateScheduledMeetingResponse(accessTamper, parsed.data).success, false);
});

test("v3 response validation enforces no-result, identity, search-start, and seed-count bindings", async () => {
  const response = await validScheduledResponse();
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(validateScheduledMeetingResponse(response, parsed.data).success, true);
  const participantIdTamper = mutableResponse(response);
  participantIdTamper.participants[0]!.id = "tampered-participant";
  assert.equal(validateScheduledMeetingResponse(participantIdTamper, parsed.data).success, false);
  const participantOriginTamper = mutableResponse(response);
  participantOriginTamper.participants[1]!.origin.latitude = 48.2;
  assert.equal(validateScheduledMeetingResponse(participantOriginTamper, parsed.data).success, false);
  const noResultResponse = await calculateScheduledMeeting(parsed.data, {
    artifact: FIXTURE_SCHEDULED_ARTIFACT,
    access: { ...FIXTURE_SCHEDULED_ACCESS_PROVIDER, resolveAccessSeeds: async () => [] },
  });
  assert.equal(validateScheduledMeetingResponse(noResultResponse, parsed.data).success, true);
  const noResultTamper = mutableResponse(noResultResponse);
  noResultTamper.stationAreas[0]!.classification = "red";
  noResultTamper.stationAreas[0]!.redArrivalSeconds = 1;
  noResultTamper.stationAreas[0]!.fasterParticipant = "red";
  assert.equal(validateScheduledMeetingResponse(noResultTamper, parsed.data).success, false);

  const invalidNoAccessReason = mutableResponse(noResultResponse);
  invalidNoAccessReason.reason = "no-access-seeds";
  invalidNoAccessReason.participants[0]!.accessSeeds.push(...response.participants[0].accessSeeds.map((seed) => seed as unknown as Record<string, unknown>));
  invalidNoAccessReason.participants[1]!.accessSeeds.push(...response.participants[1].accessSeeds.map((seed) => seed as unknown as Record<string, unknown>));
  invalidNoAccessReason.metadata.surface.accessSeedCounts = [response.participants[0].accessSeeds.length, response.participants[1].accessSeeds.length];
  assert.equal(validateScheduledMeetingResponse(invalidNoAccessReason, parsed.data).success, false);

  const invalidNoReachableReason = mutableResponse(noResultResponse);
  invalidNoReachableReason.reason = "no-reachable-stations";
  assert.equal(validateScheduledMeetingResponse(invalidNoReachableReason, parsed.data).success, false);

  for (const [field, value] of [["feedId", "tampered-feed"], ["scheduleContentHash", "f".repeat(64)], ["compiledArtifactId", "e".repeat(64)], ["timeZone", "Europe/London"], ["searchStartAt", "2026-08-11T06:05:00.123Z"]] as const) {
    const tamper = mutableResponse(response);
    tamper.metadata.surface[field] = value;
    assert.equal(validateScheduledMeetingResponse(tamper, parsed.data).success, false, `surface ${field} tamper should fail`);
  }

  const seedCountTamper = mutableResponse(response);
  seedCountTamper.metadata.surface.accessSeedCounts = [999, 999];
  assert.equal(validateScheduledMeetingResponse(seedCountTamper, parsed.data).success, false);
});

test("v3 response validation binds surface search start and tolerance to the parsed request", async () => {
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const response = await validScheduledResponse();
  assert.equal(validateScheduledMeetingResponse(response, parsed.data).success, true);

  const searchStartTamper = mutableResponse(response);
  searchStartTamper.metadata.surface.searchStartAt = "2026-08-11T06:06:00.000Z";
  assert.equal(validateScheduledMeetingResponse(searchStartTamper, parsed.data).success, false);

  const toleranceTamper = mutableResponse(response);
  toleranceTamper.metadata.surface.selectedTolerancePercent = 5;
  assert.equal(validateScheduledMeetingResponse(toleranceTamper, parsed.data).success, false);
});

test("v3 request requires a supported changeTimePreset and binds surface change time to it", async () => {
  assert.equal(parseScheduledMeetingRequest({ ...V3_REQUEST, changeTimePreset: "quick" }).success, true);
  assert.equal(parseScheduledMeetingRequest({ ...V3_REQUEST, changeTimePreset: "long" }).success, true);
  const invalid = parseScheduledMeetingRequest({ ...V3_REQUEST, changeTimePreset: "instant" });
  assert.equal(invalid.success, false);
  if (!invalid.success) assert.deepEqual(invalid.issues[0]?.path, ["changeTimePreset"]);
  const missing = parseScheduledMeetingRequest({ ...V3_REQUEST, changeTimePreset: undefined });
  assert.equal(missing.success, false);

  const parsed = parseScheduledMeetingRequest({ ...V3_REQUEST, changeTimePreset: "quick" });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const response = await calculateScheduledMeeting(parsed.data, {
    artifact: FIXTURE_SCHEDULED_ARTIFACT,
    access: FIXTURE_SCHEDULED_ACCESS_PROVIDER,
  });
  assert.equal(response.metadata.surface.changeTimeSeconds, 180);
  assert.equal(validateScheduledMeetingResponse(response, parsed.data).success, true);

  const changeTimeTamper = mutableResponse(response);
  changeTimeTamper.metadata.surface.changeTimeSeconds = 600;
  assert.equal(validateScheduledMeetingResponse(changeTimeTamper, parsed.data).success, false);

  const unsupportedChangeTime = mutableResponse(response);
  unsupportedChangeTime.metadata.surface.changeTimeSeconds = 240;
  assert.equal(validateScheduledMeetingResponse(unsupportedChangeTime, parsed.data).success, false);
});

test("v3 response uses the station-area coverage contract and rejects the retired boarding-stop shape", async () => {
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const response = await validScheduledResponse();
  assert.equal(response.metadata.stationAreas.coverage, "official-munich-boundary-with-connected-artifact-station-areas/v1");
  assert.equal(validateScheduledMeetingResponse(response, parsed.data).success, true);

  const legacyCoverage = mutableResponse(response);
  legacyCoverage.metadata.stationAreas.coverage = "official-munich-boundary-with-connected-artifact-boarding-stops/v1";
  assert.equal(validateScheduledMeetingResponse(legacyCoverage, parsed.data).success, false);

  const legacyMarker = mutableResponse(response);
  legacyMarker.stationAreas[0]!.redBoardingStopId = "fixture-a-stop";
  assert.equal(validateScheduledMeetingResponse(legacyMarker, parsed.data).success, false);
});

test("v3 response rejects retired boarding-stop identity on access seeds", async () => {
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const response = await validScheduledResponse();
  const mutable = mutableResponse(response);
  (mutable.participants[0]!.accessSeeds[0] as Record<string, unknown>).boardingStopId = "fixture-a-stop";
  assert.equal(validateScheduledMeetingResponse(mutable, parsed.data).success, false);
});

test("v3 response validation rejects the retired grid-cell surface contract", async () => {
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const response = await validScheduledResponse();

  const legacyCells = mutableResponse(response) as unknown as Record<string, unknown>;
  legacyCells.cells = [{ id: "cell-1", geometry: { type: "MultiPolygon", coordinates: [[[[11.57, 48.13], [11.58, 48.13], [11.58, 48.14], [11.57, 48.14], [11.57, 48.13]]]] }, representativePoint: { latitude: 48.135, longitude: 11.575 }, classification: "fair", redArrivalSeconds: 600, blueArrivalSeconds: 660, fasterParticipant: "red", withinSelectedTolerance: true }];
  const legacyCellsResult = validateScheduledMeetingResponse(legacyCells, parsed.data);
  assert.equal(legacyCellsResult.success, false);
  if (!legacyCellsResult.success) {
    assert.ok(legacyCellsResult.issues.some((issue) => issue.path.includes("cells")));
  }

  const legacyGrid = mutableResponse(response);
  (legacyGrid.metadata as unknown as Record<string, unknown>).grid = { columns: 24, rows: 16, cellCount: 1, geometry: "munich-clipped-surface-grid/v1" };
  const legacyGridResult = validateScheduledMeetingResponse(legacyGrid, parsed.data);
  assert.equal(legacyGridResult.success, false);
  if (!legacyGridResult.success) {
    assert.ok(legacyGridResult.issues.some((issue) => issue.path.includes("grid")));
  }
});

test("scheduled HTTP path handles fixture success, no seeds, and unavailable artifacts without legacy fallback", async () => {
  const providers: MeetingProviders = {
    ...fixtureProviders,
    scheduledArtifact: FIXTURE_SCHEDULED_ARTIFACT,
    scheduledAccess: FIXTURE_SCHEDULED_ACCESS_PROVIDER,
  };
  const success = await handleMeetingPost(new Request("https://meeet.test/api/meeting/calculate", { method: "POST", body: JSON.stringify(V3_REQUEST), headers: { "content-type": "application/json" } }), providers);
  assert.equal(success.status, 200);
  assert.equal((await success.json()).contractVersion, "meeet-meeting/v3");

  const noSeedsProviders: MeetingProviders = {
    ...providers,
    scheduledAccess: { ...FIXTURE_SCHEDULED_ACCESS_PROVIDER, resolveAccessSeeds: async () => [] },
  };
  const noSeeds = await handleMeetingPost(new Request("https://meeet.test/api/meeting/calculate", { method: "POST", body: JSON.stringify(V3_REQUEST) }), noSeedsProviders);
  const noSeedsBody = await noSeeds.json();
  assert.equal(noSeeds.status, 200);
  assert.equal(noSeedsBody.status, "no-result");
  assert.equal(noSeedsBody.reason, "no-access-seeds");
  assert.ok(noSeedsBody.stationAreas.every((area: { classification: string }) => area.classification === "unclassified"));

  const unavailable = await handleMeetingPost(new Request("https://meeet.test/api/meeting/calculate", { method: "POST", body: JSON.stringify(V3_REQUEST) }), { ...providers, scheduledArtifact: undefined });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "PROVIDER_NOT_CONFIGURED");
});

test("scheduled HTTP uses only MVG nearby access through the real endpoint seam", async () => {
  const calls: string[] = [];
  const scheduledAccess = new MvgScheduledAccessSeedProvider({
    fetchImplementation: async (input) => {
      calls.push(String(input));
      return Response.json({ stations: [
        { globalId: "fixture-a", latitude: 48.1374, longitude: 11.5755 },
        { globalId: "fixture-b", latitude: 48.1400, longitude: 11.5700 },
      ] });
    },
  });
  const response = await handleMeetingPost(new Request("https://meeet.test/api/meeting/calculate", {
    method: "POST",
    body: JSON.stringify(V3_REQUEST),
    headers: { "content-type": "application/json" },
  }), { ...fixtureProviders, scheduledArtifact: FIXTURE_SCHEDULED_ARTIFACT, scheduledAccess });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url.startsWith(MVG_NEARBY_URL)));
  assert.equal(calls.some((url) => url.includes("/routes")), false);
});

test("configured scheduled artifact errors propagate from the provider factory", () => {
  assert.throws(() => createMeetingProviders({
    MEEET_PROVIDER_MODE: "configured",
    MEEET_SCHEDULE_ARTIFACT_PATH: "/tmp/meeet-missing-scheduled-artifact.json",
    MEEET_SCHEDULED_MIN_MEMORY_GIB: "4",
  }), ScheduleArtifactUnavailableError);
});

test("fixture mode honors MEEET_SCHEDULE_ARTIFACT_PATH and keeps the fixture access provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-fixture-artifact-"));
  try {
    const dateRange = currentDateRange();
    const feedFiles = fixtureFeedFiles(Date.now());
    const artifact = compileScheduledArtifact({
      sourceUrl: SCHEDULED_MVV_FEED_URL,
      rawArchiveBytes: new TextEncoder().encode("fixture-factory-test"),
      feedFiles,
      retrievedAt: "2026-08-11T10:00:00Z",
      feedId: "fixture-scheduled-feed",
    });
    const path = join(directory, "scheduled-artifact.json");
    writeScheduledArtifact(path, artifact);

    const providers = createMeetingProviders({
      MEEET_PROVIDER_MODE: "fixture",
      MEEET_SCHEDULE_ARTIFACT_PATH: path,
    });
    assert.equal(providers.scheduledArtifact?.feedId, "fixture-scheduled-feed");
    assert.equal(providers.scheduledArtifact?.serviceDateRange.firstDate, dateRange.firstDate);
    assert.equal(providers.scheduledArtifact?.serviceDateRange.lastDate, dateRange.lastDate);
    assert.notEqual(providers.scheduledArtifact?.provenance.acquisition.feedValidFrom, "2026-08-01");
    assert.equal(providers.scheduledAccess?.descriptor.name, "fixture-scheduled-access");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("default fixture mode uses the pre-baked fixture artifact", () => {
  const providers = createMeetingProviders({ MEEET_PROVIDER_MODE: "fixture" });
  assert.equal(providers.scheduledArtifact?.feedId, "fixture-scheduled-feed");
  assert.equal(providers.scheduledArtifact?.provenance.acquisition.feedValidFrom, "2026-08-01");
  assert.equal(providers.scheduledAccess?.descriptor.name, "fixture-scheduled-access");
});

test("fixture schedule transform shifts stop times deterministically around the Berlin wall clock", () => {
  const firstDeparture = (files: GtfsFeedFiles): string => files["stop_times.txt"].split("\n")[1]?.split(",")[2] ?? "unknown";
  const noonFeed = fixtureFeedFiles(new Date("2026-08-18T14:00:00+02:00").getTime());
  assert.equal(firstDeparture(noonFeed), "14:10:00");
  const wrapFeed = fixtureFeedFiles(new Date("2026-08-18T07:00:00+02:00").getTime());
  assert.equal(firstDeparture(wrapFeed), "31:10:00");
  const midnightFeed = fixtureFeedFiles(new Date("2026-08-18T23:50:00+02:00").getTime());
  assert.equal(firstDeparture(midnightFeed), "24:00:00");
});

test("fixture schedule transform re-dates the feed around today and still compiles", async () => {
  const dateRange = currentDateRange();
  const feedFiles = fixtureFeedFiles(new Date("2026-08-18T14:00:00+02:00").getTime());
  const firstDate = dateRange.firstDate.replaceAll("-", "");
  const lastDate = dateRange.lastDate.replaceAll("-", "");
  assert.ok(feedFiles["feed_info.txt"].endsWith(`de,fixture-scheduled-2026-08,${firstDate},${lastDate}`));
  assert.ok(feedFiles["calendar.txt"].endsWith(`1,${firstDate},${lastDate}`));
  assert.ok(!feedFiles["feed_info.txt"].includes("20260801"));
  assert.ok(!feedFiles["calendar.txt"].includes("20260831"));

  const artifact = compileScheduledArtifact({
    sourceUrl: SCHEDULED_MVV_FEED_URL,
    rawArchiveBytes: new TextEncoder().encode("fixture-transform-deterministic"),
    feedFiles,
    retrievedAt: "2026-08-11T10:00:00Z",
    feedId: "fixture-scheduled-feed",
  });
  assert.equal(artifact.feedId, "fixture-scheduled-feed");
  assert.equal(artifact.serviceDateRange.firstDate, dateRange.firstDate);
  assert.equal(artifact.serviceDateRange.lastDate, dateRange.lastDate);
});

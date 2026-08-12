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
import { MvgScheduledAccessSeedProvider } from "../lib/providers/mvg-scheduled-access.ts";
import { handleMeetingPost } from "../lib/domain/meeting-api.ts";
import { ScheduledCalculationAdmission } from "../lib/domain/meeting-api.ts";
import { fixtureProviders } from "../lib/fixtures/providers.ts";
import type { MeetingProviders } from "../lib/domain/providers.ts";
import { compareScheduledIds, type GtfsFeedFiles } from "../lib/domain/scheduled-routing/gtfs.ts";
import { createScheduledSurfaceGrid } from "../lib/domain/scheduled-routing/grid.ts";
import { createMeetingProviders } from "../lib/providers/factory.ts";
import { MVG_NEARBY_URL } from "../lib/providers/mvg-constants.ts";

const V3_REQUEST = {
  contractVersion: "meeet-meeting/v3",
  participants: [
    { id: "red", origin: { label: "Origin red", latitude: 48.1374, longitude: 11.5755 }, mode: "transit" },
    { id: "blue", origin: { label: "Origin blue", latitude: 48.1400, longitude: 11.5700 }, mode: "transit" },
  ],
  tolerancePercent: 10,
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
    grid: undefined,
  });
}

interface MutableResponseShape {
  readonly status: string;
  readonly reason: string | null;
  readonly participants: Array<{ readonly accessSeeds: Array<Record<string, unknown>> }>;
  readonly cells: Array<Record<string, unknown>>;
  readonly metadata: {
    readonly schedule: Record<string, unknown>;
    readonly surface: Record<string, unknown>;
  };
}

function mutableResponse(response: ScheduledMeetingResponseDto): MutableResponseShape {
  return JSON.parse(JSON.stringify(response)) as MutableResponseShape;
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
  assert.equal(provider.descriptor.provenance.role, "access");
  assert.equal(provider.descriptor.dataKind, "unknown");
});

test("v3 accepts canonical zero-fraction search instants but rejects non-zero fractions", () => {
  assert.equal(parseScheduledMeetingRequest({ ...V3_REQUEST, searchStartAt: "2026-08-11T08:05:00.000Z" }).success, true);
  assert.equal(parseScheduledMeetingRequest({ ...V3_REQUEST, searchStartAt: "2026-08-11T08:05:00.001Z" }).success, false);
});

test("v3 response preserves optional exact boarding-stop identity and rejects blank IDs", async () => {
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const response = await validScheduledResponse();
  const mutable = mutableResponse(response);
  mutable.participants[0]!.accessSeeds[0]!.boardingStopId = "fixture-a-stop";
  assert.equal(validateScheduledMeetingResponse(mutable, parsed.data).success, true);
  mutable.participants[0]!.accessSeeds[0]!.boardingStopId = "";
  assert.equal(validateScheduledMeetingResponse(mutable, parsed.data).success, false);
});

test("scheduled admission rejects an occupied second request with explicit unavailability", async () => {
  const admission = new ScheduledCalculationAdmission(1);
  const release = admission.enter();
  const response = await handleMeetingPost(new Request("https://meeet.test/api/meeting/calculate", {
    method: "POST",
    body: JSON.stringify(V3_REQUEST),
  }), { ...fixtureProviders, scheduledArtifact: FIXTURE_SCHEDULED_ARTIFACT, scheduledAccess: FIXTURE_SCHEDULED_ACCESS_PROVIDER }, { admission });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "PROVIDER_UNAVAILABLE");
  release();
});

test("v3 validation is strict and scheduled orchestration emits only the v3 surface contract", async () => {
  const surfaceGrid = createScheduledSurfaceGrid();
  assert.equal(surfaceGrid.columns, 24);
  assert.equal(surfaceGrid.rows, 16);
  assert.ok(surfaceGrid.destinations.length > 400);
  assert.ok(surfaceGrid.cells.every((cell) => cell.geometry.type === "MultiPolygon" && cell.geometry.coordinates.length > 0));
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const response = await calculateScheduledMeeting(parsed.data, {
    artifact: FIXTURE_SCHEDULED_ARTIFACT,
    access: FIXTURE_SCHEDULED_ACCESS_PROVIDER,
    grid: undefined,
  } satisfies ScheduledMeetingProviderBundle);
  assert.equal(response.contractVersion, "meeet-meeting/v3");
  assert.equal(response.participants.length, 2);
  assert.equal(response.participants[0].color, "red");
  assert.equal(response.participants[1].color, "blue");
  assert.ok(response.cells.every((cell) => cell.geometry.type === "MultiPolygon"));
  assert.ok(response.cells.every((cell) => !("cellId" in cell)));
  assert.ok(response.cells.length >= 200);
  assert.ok(response.metadata.grid.columns >= 24);
  assert.equal(response.metadata.surface.classificationMethod, "representative-point-with-geometric-final-station-walking/v1");
  assert.equal(response.metadata.surface.classificationBasis, "representative-point");
   assert.equal(response.metadata.surface.representativePointBasis, "inside-clipped-cell/v1");
  assert.equal(response.metadata.surface.finalWalkingMethod, "geometric-station-walking-estimate-not-navigation");
  assert.equal(validateScheduledMeetingResponse(response, parsed.data).success, true);
  assert.equal("fairLocations" in response, false);
  assert.equal(parseScheduledMeetingRequest({ ...V3_REQUEST, arrivalAt: V3_REQUEST.searchStartAt }).success, false);
});

test("v3 response validation derives exact cell classification and rejects arrival tampering", async () => {
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const response = await validScheduledResponse();
  assert.equal(validateScheduledMeetingResponse(response, parsed.data).success, true);
  const sourceIndex = response.cells.findIndex((cell) => cell.redArrivalSeconds !== null && cell.blueArrivalSeconds !== null);
  assert.ok(sourceIndex >= 0);

  const classificationTamper = mutableResponse(response);
  const classificationCell = classificationTamper.cells[sourceIndex]!;
  classificationCell.redArrivalSeconds = 0;
  classificationCell.blueArrivalSeconds = 100;
  classificationCell.classification = "fair";
  classificationCell.fasterParticipant = null;
  classificationCell.withinSelectedTolerance = true;
  assert.equal(validateScheduledMeetingResponse(classificationTamper, parsed.data).success, false);

  const fasterParticipantTamper = mutableResponse(response);
  const fasterCell = fasterParticipantTamper.cells[sourceIndex]!;
  fasterCell.redArrivalSeconds = 0;
  fasterCell.blueArrivalSeconds = 100;
  fasterCell.classification = "red";
  fasterCell.fasterParticipant = "blue";
  fasterCell.withinSelectedTolerance = false;
  assert.equal(validateScheduledMeetingResponse(fasterParticipantTamper, parsed.data).success, false);

  const oneSidedTamper = mutableResponse(response);
  const oneSidedCell = oneSidedTamper.cells[sourceIndex]!;
  oneSidedCell.redArrivalSeconds = 100;
  oneSidedCell.blueArrivalSeconds = null;
  oneSidedCell.classification = "red";
  oneSidedCell.fasterParticipant = null;
  oneSidedCell.withinSelectedTolerance = false;
  assert.equal(validateScheduledMeetingResponse(oneSidedTamper, parsed.data).success, false);
});

test("v3 response validation enforces no-result, identity, search-start, and seed-count bindings", async () => {
  const response = await validScheduledResponse();
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const noResultResponse = await calculateScheduledMeeting(parsed.data, {
    artifact: FIXTURE_SCHEDULED_ARTIFACT,
    access: { ...FIXTURE_SCHEDULED_ACCESS_PROVIDER, resolveAccessSeeds: async () => [] },
    grid: undefined,
  });
  assert.equal(validateScheduledMeetingResponse(noResultResponse, parsed.data).success, true);
  const noResultTamper = mutableResponse(noResultResponse);
  noResultTamper.cells[0]!.classification = "red";
  noResultTamper.cells[0]!.redArrivalSeconds = 1;
  noResultTamper.cells[0]!.fasterParticipant = "red";
  assert.equal(validateScheduledMeetingResponse(noResultTamper, parsed.data).success, false);

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

test("v3 response validation restricts access provenance to non-live MVG seed access", async () => {
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const response = await validScheduledResponse();
  const mutateProvider = (mutate: (provider: Record<string, unknown>, provenance: Record<string, unknown>) => void) => {
    const tamper = mutableResponse(response);
    const provider = (tamper.metadata as unknown as Record<string, unknown>).accessProvider as Record<string, unknown>;
    const provenance = provider.provenance as Record<string, unknown>;
    mutate(provider, provenance);
    assert.equal(validateScheduledMeetingResponse(tamper, parsed.data).success, false);
  };
  mutateProvider((_, provenance) => { provenance.role = "routing"; });
  mutateProvider((provider, provenance) => { provider.dataKind = "scheduled"; provenance.dataKind = "scheduled"; });
  mutateProvider((provider, provenance) => { provider.liveData = true; provenance.liveData = true; });
  mutateProvider((provider, provenance) => { provider.dataKind = "unknown"; provenance.dataKind = "demo-static"; });
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
  assert.ok(noSeedsBody.cells.every((cell: { classification: string }) => cell.classification === "unclassified"));

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

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  SCHEDULED_MVV_FEED_URL,
  compileScheduledArtifact,
  loadScheduledArtifact,
  rotateScheduledArtifact,
  writeScheduledArtifact,
} from "../lib/domain/scheduled-routing/artifact.ts";
import type { GtfsFeedFiles } from "../lib/domain/scheduled-routing/gtfs.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

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

function fetchBytes(bytes: Uint8Array): typeof fetch {
  return async () => new Response(new Uint8Array(bytes));
}

function writeFixtureArtifact(outputPath: string, rawArchiveBytes: Uint8Array): void {
  const artifact = compileScheduledArtifact({
    sourceUrl: SCHEDULED_MVV_FEED_URL,
    rawArchiveBytes,
    feedFiles: compilerFeedFiles(),
    retrievedAt: "2026-08-11T10:00:00Z",
  });
  writeScheduledArtifact(outputPath, artifact);
}

function buildFixtureArchive(directory: string, name: string): Uint8Array {
  const sourceDirectory = join(directory, "gtfs");
  mkdirSync(sourceDirectory, { recursive: true });
  for (const [fileName, content] of Object.entries(compilerFeedFiles())) {
    writeFileSync(join(sourceDirectory, fileName), content, "utf8");
  }
  const archivePath = join(directory, name);
  execFileSync("zip", ["-q", "-r", archivePath, "gtfs"], { cwd: directory });
  return new Uint8Array(readFileSync(archivePath));
}

function capturedLines(mock: { mock: { calls: ReadonlyArray<{ arguments: readonly unknown[] }> } }): string[] {
  return mock.mock.calls.map((call) => String(call.arguments[0]));
}

test("offline compile and write emit [compile] parsing and serialization lines", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-compile-log-"));
  const outputPath = join(directory, "scheduled-artifact.json");
  const mock = t.mock.method(console, "error");
  t.after(() => {
    mock.mock.restore();
  });
  const artifact = compileScheduledArtifact({
    sourceUrl: SCHEDULED_MVV_FEED_URL,
    rawArchiveBytes: new TextEncoder().encode("offline-compile-log-fixture"),
    feedFiles: compilerFeedFiles(),
    retrievedAt: "2026-08-11T10:00:00Z",
  });
  writeScheduledArtifact(outputPath, artifact);
  const lines = capturedLines(mock);
  assert.ok(lines.some((line) => line.includes("routes parsed: 1")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("stops parsed: 4")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("trips parsed: 1")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("station areas created: 2")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("connections parsed: 1")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("payload serialized:")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("artifact written:")), lines.join("\n"));
  await rm(directory, { recursive: true, force: true });
});

test("the compiler script emits a [compile] completion summary on offline compile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-compile-script-"));
  const archivePath = join(directory, "feed.zip");
  buildFixtureArchive(directory, "feed.zip");
  const outputPath = join(directory, "scheduled-artifact.json");
  const tsxPath = join(projectRoot, "node_modules", ".bin", "tsx");
  const nodeOptions = [process.env.NODE_OPTIONS, "--conditions=react-server"].filter(Boolean).join(" ");
  const result = spawnSync(tsxPath, ["scripts/compile-mvv-schedule.ts", "--input", archivePath, "--output", outputPath], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
  });
  assert.equal(result.status, 0, result.stderr ?? "");
  const stderr = result.stderr ?? "";
  assert.match(stderr, /\[compile\] .*routes parsed: 1/);
  assert.match(stderr, /\[compile\] .*stops parsed: 4/);
  assert.match(stderr, /\[compile\] .*trips parsed: 1/);
  assert.match(stderr, /\[compile\] .*station areas created: 2/);
  assert.match(stderr, /\[compile\] .*connections parsed: 1/);
  assert.match(stderr, /\[compile\] .*payload serialized: \d+ bytes/);
  assert.match(stderr, /\[compile\] .*GTFS import complete \(feedId=phase2-fixture, serviceDateRange=2026-08-01\.\.2026-08-31\)/);
  assert.match(stderr, /\[compile\] .*offline compile complete: routes=1, trips=1, stationAreas=2, calendars=1, exceptions=0, connections=1, serviceDateRange=2026-08-01\.\.2026-08-31, feedId=phase2-fixture in \d+ms/);
  assert.equal((result.stdout ?? "").trim(), outputPath);
  await rm(directory, { recursive: true, force: true });
});

test("the compiler script emits a [compile] compilation-failed line when the input archive is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-compile-failure-"));
  const missingInputPath = join(directory, "missing.zip");
  const outputPath = join(directory, "scheduled-artifact.json");
  const tsxPath = join(projectRoot, "node_modules", ".bin", "tsx");
  const nodeOptions = [process.env.NODE_OPTIONS, "--conditions=react-server"].filter(Boolean).join(" ");
  const result = spawnSync(tsxPath, ["scripts/compile-mvv-schedule.ts", "--input", missingInputPath, "--output", outputPath], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
  });
  assert.equal(result.status, 1);
  const stderr = result.stderr ?? "";
  assert.match(stderr, /\[compile\] .*compilation failed:/);
  assert.doesNotMatch(result.stdout ?? "", new RegExp(outputPath));
  await rm(directory, { recursive: true, force: true });
});

test("rotation logs keeping existing artifact for a fresh artifact", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-rotation-log-"));
  const outputPath = join(directory, "scheduled-artifact.json");
  const bytes = new TextEncoder().encode("rotation-fresh-log-fixture");
  writeFixtureArtifact(outputPath, bytes);
  const mock = t.mock.method(console, "error");
  t.after(() => {
    mock.mock.restore();
  });
  const result = await rotateScheduledArtifact({
    outputPath,
    now: "2026-08-11T12:00:00Z",
    fetchImplementation: fetchBytes(bytes),
  });
  assert.equal(result.action, "kept");
  assert.equal(result.reason, "fresh");
  const lines = capturedLines(mock);
  assert.ok(lines.some((line) => line.includes("rotation: existing artifact manifest found")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("rotation: keeping existing artifact (reason=fresh)")), lines.join("\n"));
  await rm(directory, { recursive: true, force: true });
});

test("rotation logs proceeding to download and compile when no manifest exists", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-rotation-log-"));
  const outputPath = join(directory, "scheduled-artifact.json");
  const archiveBytes = buildFixtureArchive(directory, "feed.zip");
  const mock = t.mock.method(console, "error");
  t.after(() => {
    mock.mock.restore();
  });
  const result = await rotateScheduledArtifact({
    outputPath,
    now: "2026-08-11T12:00:00Z",
    fetchImplementation: fetchBytes(archiveBytes),
  });
  assert.equal(result.action, "compiled");
  assert.equal(result.reason, "missing");
  const lines = capturedLines(mock);
  assert.ok(lines.some((line) => line.includes("rotation: no existing artifact manifest at")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("rotation: proceeding to download and compile (reason=missing)")), lines.join("\n"));
  await rm(directory, { recursive: true, force: true });
});

test("loadScheduledArtifact cold load emits a [meeet] line with artifact identity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-load-log-"));
  const outputPath = join(directory, "scheduled-artifact.json");
  writeFixtureArtifact(outputPath, new TextEncoder().encode("load-log-fixture"));
  const mock = t.mock.method(console, "log");
  t.after(() => {
    mock.mock.restore();
  });
  const loaded = loadScheduledArtifact(outputPath, { now: "2026-08-11T12:00:00Z" });
  assert.equal(loaded.provenance.acquisition.feedVersion, "phase2-fixture");
  const lines = capturedLines(mock);
  const loadLine = lines.find((line) => line.includes("scheduled artifact loaded in"));
  assert.ok(loadLine !== undefined, lines.join("\n"));
  assert.match(loadLine, /^\[meeet\] /);
  assert.match(loadLine, /compiledArtifactId=[a-f0-9]{64}/);
  assert.match(loadLine, /in \d+ms/);
  await rm(directory, { recursive: true, force: true });
});
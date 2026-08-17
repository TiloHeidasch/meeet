import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SCHEDULED_COMPILER_VERSION,
  SCHEDULED_MVV_FEED_URL,
  ScheduleArtifactUnavailableError,
  compileScheduledArtifact,
  loadScheduledArtifact,
  rotateScheduledArtifact,
  writeScheduledArtifact,
} from "../lib/domain/scheduled-routing/artifact.ts";
import type { GtfsFeedFiles } from "../lib/domain/scheduled-routing/gtfs.ts";

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

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fetchBytes(bytes: Uint8Array): typeof fetch {
  return async () => new Response(new Uint8Array(bytes));
}

function fetchFailure(): typeof fetch {
  return async () => new Response(null, { status: 503 });
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

test("rotation compiles a missing artifact and the written artifact loads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-rotation-"));
  const outputPath = join(directory, "scheduled-artifact.json");
  const archiveBytes = buildFixtureArchive(directory, "feed.zip");
  const result = await rotateScheduledArtifact({
    outputPath,
    now: "2026-08-11T12:00:00Z",
    fetchImplementation: fetchBytes(archiveBytes),
  });
  assert.equal(result.action, "compiled");
  assert.equal(result.reason, "missing");
  assert.equal(result.outputPath, outputPath);
  const loaded = loadScheduledArtifact(outputPath, { now: "2026-08-11T12:00:00Z" });
  assert.equal(loaded.provenance.acquisition.rawArchiveSha256, sha256Bytes(archiveBytes));
  await rm(directory, { recursive: true, force: true });
});

test("rotation keeps a fresh artifact and leaves the manifest bytes unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-rotation-"));
  const outputPath = join(directory, "scheduled-artifact.json");
  const bytes = new TextEncoder().encode("rotation-fresh-fixture");
  writeFixtureArtifact(outputPath, bytes);
  const before = await readFile(outputPath);
  const result = await rotateScheduledArtifact({
    outputPath,
    now: "2026-08-11T12:00:00Z",
    fetchImplementation: fetchBytes(bytes),
  });
  assert.equal(result.action, "kept");
  assert.equal(result.reason, "fresh");
  const after = await readFile(outputPath);
  assert.equal(after.equals(before), true);
  await rm(directory, { recursive: true, force: true });
});

test("rotation recompiles when the manifest compiler version differs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-rotation-"));
  const outputPath = join(directory, "scheduled-artifact.json");
  writeFixtureArtifact(outputPath, new TextEncoder().encode("rotation-version-fixture"));
  const manifest = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
  manifest.compilerVersion = "meeet-scheduled-compiler/v0";
  await writeFile(outputPath, JSON.stringify(manifest), "utf8");
  const archiveBytes = buildFixtureArchive(directory, "feed.zip");
  const result = await rotateScheduledArtifact({
    outputPath,
    now: "2026-08-11T12:00:00Z",
    fetchImplementation: fetchBytes(archiveBytes),
  });
  assert.equal(result.action, "compiled");
  assert.equal(result.reason, "compiler-version");
  const rewritten = JSON.parse(await readFile(outputPath, "utf8")) as { compilerVersion?: string };
  assert.equal(rewritten.compilerVersion, SCHEDULED_COMPILER_VERSION);
  await rm(directory, { recursive: true, force: true });
});

test("rotation fails hard when the manifest compiler version differs and the feed cannot be fetched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-rotation-"));
  const outputPath = join(directory, "scheduled-artifact.json");
  writeFixtureArtifact(outputPath, new TextEncoder().encode("rotation-version-failure-fixture"));
  const manifest = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
  manifest.compilerVersion = "meeet-scheduled-compiler/v0";
  await writeFile(outputPath, JSON.stringify(manifest), "utf8");
  const before = await readFile(outputPath);
  await assert.rejects(
    rotateScheduledArtifact({
      outputPath,
      now: "2026-08-11T12:00:00Z",
      fetchImplementation: fetchFailure(),
    }),
    ScheduleArtifactUnavailableError,
  );
  const after = await readFile(outputPath);
  assert.equal(after.equals(before), true);
  await rm(directory, { recursive: true, force: true });
});

test("rotation recompiles a legacy manifest without compilerVersion and the loader still accepts it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-rotation-"));
  const outputPath = join(directory, "scheduled-artifact.json");
  writeFixtureArtifact(outputPath, new TextEncoder().encode("rotation-legacy-fixture"));
  const manifest = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
  delete manifest.compilerVersion;
  await writeFile(outputPath, JSON.stringify(manifest), "utf8");
  const loaded = loadScheduledArtifact(outputPath, { now: "2026-08-11T12:00:00Z" });
  assert.equal(loaded.provenance.acquisition.feedVersion, "phase2-fixture");
  const archiveBytes = buildFixtureArchive(directory, "feed.zip");
  const result = await rotateScheduledArtifact({
    outputPath,
    now: "2026-08-11T12:00:00Z",
    fetchImplementation: fetchBytes(archiveBytes),
  });
  assert.equal(result.action, "compiled");
  assert.equal(result.reason, "compiler-version");
  const rewritten = JSON.parse(await readFile(outputPath, "utf8")) as { compilerVersion?: string };
  assert.equal(rewritten.compilerVersion, SCHEDULED_COMPILER_VERSION);
  await rm(directory, { recursive: true, force: true });
});

test("rotation recompiles when the latest feed archive differs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-rotation-"));
  const outputPath = join(directory, "scheduled-artifact.json");
  writeFixtureArtifact(outputPath, new TextEncoder().encode("rotation-old-feed"));
  const archiveBytes = buildFixtureArchive(directory, "feed.zip");
  const result = await rotateScheduledArtifact({
    outputPath,
    now: "2026-08-11T12:00:00Z",
    fetchImplementation: fetchBytes(archiveBytes),
  });
  assert.equal(result.action, "compiled");
  assert.equal(result.reason, "feed-changed");
  const rewritten = JSON.parse(await readFile(outputPath, "utf8")) as { provenance: { acquisition: { rawArchiveSha256: string } } };
  assert.equal(rewritten.provenance.acquisition.rawArchiveSha256, sha256Bytes(archiveBytes));
  await rm(directory, { recursive: true, force: true });
});

test("rotation recompiles when the feed validity window has expired", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-rotation-"));
  const outputPath = join(directory, "scheduled-artifact.json");
  writeFixtureArtifact(outputPath, new TextEncoder().encode("rotation-expired-fixture"));
  const archiveBytes = buildFixtureArchive(directory, "feed.zip");
  const result = await rotateScheduledArtifact({
    outputPath,
    now: "2026-09-01T12:00:00Z",
    fetchImplementation: fetchBytes(archiveBytes),
  });
  assert.equal(result.action, "compiled");
  assert.equal(result.reason, "feed-out-of-date");
  await rm(directory, { recursive: true, force: true });
});

test("rotation recompiles when the payload file is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-rotation-"));
  const outputPath = join(directory, "scheduled-artifact.json");
  writeFixtureArtifact(outputPath, new TextEncoder().encode("rotation-missing-payload"));
  const manifest = JSON.parse(await readFile(outputPath, "utf8")) as { payloadFile: string };
  await rm(join(directory, manifest.payloadFile));
  const archiveBytes = buildFixtureArchive(directory, "feed.zip");
  const result = await rotateScheduledArtifact({
    outputPath,
    now: "2026-08-11T12:00:00Z",
    fetchImplementation: fetchBytes(archiveBytes),
  });
  assert.equal(result.action, "compiled");
  assert.equal(result.reason, "missing-payload");
  const rewritten = JSON.parse(await readFile(outputPath, "utf8")) as { payloadFile: string };
  assert.equal(existsSync(join(directory, rewritten.payloadFile)), true);
  await rm(directory, { recursive: true, force: true });
});

test("rotation keeps the artifact when the latest feed cannot be fetched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-rotation-"));
  const outputPath = join(directory, "scheduled-artifact.json");
  writeFixtureArtifact(outputPath, new TextEncoder().encode("rotation-unavailable-feed"));
  const before = await readFile(outputPath);
  const result = await rotateScheduledArtifact({
    outputPath,
    now: "2026-08-11T12:00:00Z",
    fetchImplementation: fetchFailure(),
  });
  assert.equal(result.action, "kept");
  assert.equal(result.reason, "check-unavailable");
  const after = await readFile(outputPath);
  assert.equal(after.equals(before), true);
  await rm(directory, { recursive: true, force: true });
});

test("rotation propagates the download error when no artifact exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meeet-rotation-"));
  const outputPath = join(directory, "scheduled-artifact.json");
  await assert.rejects(
    rotateScheduledArtifact({
      outputPath,
      now: "2026-08-11T12:00:00Z",
      fetchImplementation: fetchFailure(),
    }),
    ScheduleArtifactUnavailableError,
  );
  await rm(directory, { recursive: true, force: true });
});
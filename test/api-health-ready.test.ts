import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readinessResponse } from "../app/api/health/ready/route.ts";
import {
  compileScheduledArtifact,
  SCHEDULED_MVV_FEED_URL,
  writeScheduledArtifact,
} from "../lib/domain/scheduled-routing/artifact.ts";
import { FIXTURE_SCHEDULED_GTFS_FILES } from "../lib/fixtures/scheduled-routing.ts";

const ENVIRONMENT_KEYS = [
  "NODE_ENV",
  "MEEET_PROVIDER_MODE",
  "MEEET_PROVIDER_DEPLOYMENT",
  "MEEET_SCHEDULE_ARTIFACT_PATH",
  "MEEET_SCHEDULED_CONCURRENCY",
  "MEEET_SCHEDULED_DEADLINE_MS",
  "MEEET_SCHEDULED_MIN_MEMORY_GIB",
] as const;

test("readiness returns 204 for a valid production configured artifact without provider access", async () => {
  const fixture = artifactFixture(currentDateRange());
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("readiness must not access an upstream provider");
  }) as typeof fetch;
  try {
    const response = await withEnvironment({
      NODE_ENV: "production",
      MEEET_PROVIDER_MODE: "configured",
      MEEET_PROVIDER_DEPLOYMENT: "managed",
      MEEET_SCHEDULE_ARTIFACT_PATH: fixture.path,
      MEEET_SCHEDULED_CONCURRENCY: "1",
      MEEET_SCHEDULED_DEADLINE_MS: "30000",
      MEEET_SCHEDULED_MIN_MEMORY_GIB: "4",
    }, () => Promise.resolve(readinessResponse()));
    assert.equal(response.status, 204);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    fixture.cleanup();
  }
});

test("readiness fails closed for missing, tampered, expired, wrong-node, and invalid configuration", async () => {
  const fixtures = [
    artifactFixture(currentDateRange()),
    artifactFixture(currentDateRange()),
    artifactFixture({ firstDate: "2000-01-01", lastDate: "2000-01-31" }),
    artifactFixture(currentDateRange()),
  ];
  try {
    const tamperedManifestPath = fixtures[1]!.path;
    const tamperedManifest = JSON.parse(readFileSync(tamperedManifestPath, "utf8")) as Record<string, unknown>;
    tamperedManifest.payloadSha256 = "0".repeat(64);
    writeFileSync(tamperedManifestPath, JSON.stringify(tamperedManifest));

    const wrongNodeManifestPath = fixtures[3]!.path;
    const wrongNodeManifest = JSON.parse(readFileSync(wrongNodeManifestPath, "utf8")) as Record<string, unknown>;
    wrongNodeManifest.writerNodeMajor = Number(process.versions.node.split(".")[0]) + 1;
    writeFileSync(wrongNodeManifestPath, JSON.stringify(wrongNodeManifest));

    const cases: Array<{ path: string; overrides?: Record<string, string | undefined> }> = [
      { path: join(fixtures[0]!.directory, "missing.json") },
      { path: tamperedManifestPath },
      { path: fixtures[2]!.path },
      { path: wrongNodeManifestPath },
      { path: fixtures[0]!.path, overrides: { MEEET_SCHEDULED_MIN_MEMORY_GIB: "3" } },
      { path: fixtures[0]!.path, overrides: { MEEET_PROVIDER_MODE: "fixture" } },
    ];

    for (const candidate of cases) {
      const response = await withEnvironment({
        NODE_ENV: "production",
        MEEET_PROVIDER_MODE: "configured",
        MEEET_PROVIDER_DEPLOYMENT: "managed",
        MEEET_SCHEDULE_ARTIFACT_PATH: candidate.path,
        MEEET_SCHEDULED_CONCURRENCY: "1",
        MEEET_SCHEDULED_DEADLINE_MS: "30000",
        MEEET_SCHEDULED_MIN_MEMORY_GIB: "4",
        ...candidate.overrides,
      }, () => Promise.resolve(readinessResponse()));
      assert.equal(response.status, 503);
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});

function artifactFixture(dateRange: { firstDate: string; lastDate: string }): {
  path: string;
  directory: string;
  cleanup: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), "meeet-ready-artifact-"));
  const path = join(directory, "scheduled-artifact.json");
  const feedFiles = {
    ...FIXTURE_SCHEDULED_GTFS_FILES,
    "feed_info.txt": FIXTURE_SCHEDULED_GTFS_FILES["feed_info.txt"]
      .replace("20260801", dateRange.firstDate.replaceAll("-", ""))
      .replace("20260831", dateRange.lastDate.replaceAll("-", "")),
    "calendar.txt": FIXTURE_SCHEDULED_GTFS_FILES["calendar.txt"]
      .replace("20260801", dateRange.firstDate.replaceAll("-", ""))
      .replace("20260831", dateRange.lastDate.replaceAll("-", "")),
  };
  const artifact = compileScheduledArtifact({
    sourceUrl: SCHEDULED_MVV_FEED_URL,
    rawArchiveBytes: new TextEncoder().encode(`readiness-${dateRange.firstDate}-${dateRange.lastDate}`),
    feedFiles,
    retrievedAt: "2026-08-11T10:00:00Z",
  });
  writeScheduledArtifact(path, artifact);
  return { path, directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function currentDateRange(): { firstDate: string; lastDate: string } {
  const today = new Date();
  const firstDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const lastDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
  return {
    firstDate: firstDate.toISOString().slice(0, 10),
    lastDate: lastDate.toISOString().slice(0, 10),
  };
}

async function withEnvironment<T>(
  values: Record<string, string | undefined>,
  callback: () => Promise<T>,
): Promise<T> {
  const environment = process.env as Record<string, string | undefined>;
  const previous = new Map<string, string | undefined>();
  for (const key of ENVIRONMENT_KEYS) {
    previous.set(key, environment[key]);
    const value = values[key];
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const key of ENVIRONMENT_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete environment[key];
      else environment[key] = value;
    }
  }
}

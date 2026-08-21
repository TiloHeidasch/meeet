// Parent harness for v2 fresh-process paired scheduled-calculation profiling
// (issue #72, issue #90). Exactly three uninstrumented Node 24 children supply
// the first/warm timing medians. If CPU or heap diagnostics are requested, a
// separate fourth child runs one diagnostic pair and is excluded from every
// timing, stage, and heap aggregate.
//
// Child stdout is never parsed: the worker writes a JSON report to a temporary
// path and the parent reads that file. Request timers begin after child startup,
// request parsing, and artifact load, and end after calculation, strict
// validation with calculation.stationAreaCatalog, and response serialization.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";

import {
  aggregateProfile,
  buildWorkerLaunch,
  collectProfileSamples,
  PROFILE_SAMPLE_COUNT,
  type AggregateProfileReport,
  type ChildProfileReport,
  type ChildRunRequest,
} from "./profile-scheduled-calculation-protocol.ts";

const PROFILES_DIR = resolvePath("profiles");
const WORKER_PATH = resolvePath("scripts/profile-scheduled-calculation-worker.ts");
const TSX_CLI_PATH = createRequire(import.meta.url).resolve("tsx/cli");

function main(): void {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor !== 24) {
    console.error(`[profile] the scheduled artifact is written and loaded by Node 24; run this harness under Node 24 (current major: ${nodeMajor}).`);
    process.exitCode = 2;
    return;
  }
  const heapSnapshots = process.argv.includes("--heap-snapshots");
  const cpuProfile = process.argv.includes("--inspector-cpu");
  mkdirSync(PROFILES_DIR, { recursive: true });
  try {
    run(heapSnapshots, cpuProfile);
  } catch (error: unknown) {
    console.error(`[profile] harness failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
  }
}

function run(heapSnapshots: boolean, cpuProfile: boolean): void {
  if (!existsSync(WORKER_PATH) || !existsSync(TSX_CLI_PATH)) throw new Error("The repository tsx runner or profiling worker is missing.");
  const collection = collectProfileSamples({
    cpuProfile,
    heapSnapshots,
    runChild: (request) => runChild(request),
  });
  const report = aggregateProfile(collection);
  const reportPath = resolvePath(PROFILES_DIR, `report-${report.artifact.compiledArtifactId.slice(0, 12)}-${new Date().toISOString().replaceAll(":", "-")}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${reportPath}\n`);
  printRankedTable(report);
}

function runChild(request: ChildRunRequest): ChildProfileReport {
  const temporaryDirectory = mkdtempSync(resolvePath(PROFILES_DIR, ".calculation-profile-sample-"));
  const outputPath = resolvePath(temporaryDirectory, "sample.json");
  try {
    const launch = buildWorkerLaunch({
      nodePath: process.execPath,
      tsxCliPath: TSX_CLI_PATH,
      workerPath: WORKER_PATH,
      outputPath,
      request,
    });
    const result = spawnSync(launch.command, [...launch.args], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=react-server`.trim() },
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (result.error !== undefined) throw new Error(`Fresh-process profile sample ${request.sample} could not start: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Fresh-process profile sample ${request.sample} exited with status ${String(result.status)}${result.signal === null ? "" : ` (signal ${result.signal})`}.`);
    return JSON.parse(readFileSync(outputPath, "utf8")) as ChildProfileReport;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function printRankedTable(report: AggregateProfileReport): void {
  console.error(`[profile] schema=v2 compiledArtifactId=${report.artifact.compiledArtifactId} fresh-process timing samples=${PROFILE_SAMPLE_COUNT}`);
  console.error(`[profile] request medians: first=${report.requestTimings.firstRequestMedianMs} ms, warm=${report.requestTimings.warmRequestMedianMs} ms`);
  console.error(`[profile] artifact-load median=${report.artifactLoad.medianElapsedMs} ms heapDelta=${Math.trunc(report.artifactLoad.medianHeapDeltaBytes)} bytes`);
  console.error("[profile] stage medians (first then warm):");
  for (const requestKind of ["firstRequest", "warmRequest"] as const) {
    const stages = [...report.stages[requestKind]].sort((left, right) => right.medianElapsedMs - left.medianElapsedMs);
    for (const stage of stages) {
      console.error(`[profile]   ${requestKind}:${stage.stage.padEnd(28)} ${String(stage.medianElapsedMs).padStart(8)} ms  heapDelta=${Math.trunc(stage.medianHeapDeltaBytes)} bytes`);
    }
  }
  if (report.diagnostics !== null) {
    console.error(`[profile] diagnostics: child=${report.diagnostics.childProcessId} cpu=${report.diagnostics.cpuProfilePath ?? "none"} heap=${report.diagnostics.heapSnapshotPath ?? "none"}`);
  }
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && resolvePath(entrypoint) === resolvePath(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) main();

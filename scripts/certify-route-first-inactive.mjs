import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const npmBinary = process.platform === "win32" ? "npm.cmd" : "npm";
const pythonBinary = process.platform === "win32" ? "python" : "python3";
const defaultOutput = ".artifacts/route-first-inactive-certification.json";
const allowedOtpSkip = "REQUIRED pinned OTP 2.6 gate introspects the live schema and executes paginated planConnection";
const allowedEnvironmentKeys = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "USER",
  "LOGNAME",
  "SHELL",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
];

const args = process.argv.slice(2);
let outputPath = defaultOutput;
let allowDirtyDevelopment = false;
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--allow-dirty-development") {
    allowDirtyDevelopment = true;
  } else if (argument === "--output") {
    outputPath = args[index + 1] ?? "";
    index += 1;
  } else if (argument.startsWith("--output=")) {
    outputPath = argument.slice("--output=".length);
  } else {
    console.error(`Unknown option: ${argument}`);
    process.exitCode = 2;
    process.exit();
  }
}

if (!outputPath.trim()) {
  console.error("--output requires a path.");
  process.exitCode = 2;
  process.exit();
}

const resolvedOutput = resolve(root, outputPath);

function reportPathForDisplay(path) {
  return path.startsWith(`${root}/`) ? relative(root, path) : basename(path);
}

function writeReport(report) {
  mkdirSync(dirname(resolvedOutput), { recursive: true });
  writeFileSync(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function printReport(report) {
  console.log(`route-first inactive certification: ${report.certification.passed ? "PASSED" : "FAILED"}`);
  console.log(`report: ${reportPathForDisplay(resolvedOutput)}`);
  for (const entry of report.checks) console.log(`- ${entry.name}: ${entry.status} (${entry.durationMs}ms)`);
  if (report.identifiedTestSkips.length > 0) console.log(`- skips: ${report.identifiedTestSkips.map((entry) => entry.name).join(", ")}`);
  if (report.certification.failureReasons.length > 0) console.log(`- failure reasons: ${report.certification.failureReasons.join(", ")}`);
}

function readNodeEngine() {
  try {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    return typeof packageJson.engines?.node === "string" ? packageJson.engines.node.trim() : "";
  } catch {
    return "";
  }
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function evaluateNodeEngine(versionText, range) {
  const version = parseVersion(versionText);
  const clauses = range.split(/\s+/).filter(Boolean);
  if (!version || clauses.length === 0 || clauses.some((clause) => clause === "||" || clause.includes("||"))) {
    return { supported: false, satisfied: false };
  }
  const comparisons = clauses.map((clause) => {
    const match = /^(>=|<=|>|<|=)?v?(\d+)\.(\d+)\.(\d+)$/.exec(clause);
    if (!match) return null;
    return {
      operator: match[1] ?? "=",
      version: [Number(match[2]), Number(match[3]), Number(match[4])],
    };
  });
  if (comparisons.some((comparison) => comparison === null)) return { supported: false, satisfied: false };
  const satisfied = comparisons.every((comparison) => {
    const compared = compareVersions(version, comparison.version);
    if (comparison.operator === ">=") return compared >= 0;
    if (comparison.operator === "<=") return compared <= 0;
    if (comparison.operator === ">") return compared > 0;
    if (comparison.operator === "<") return compared < 0;
    return compared === 0;
  });
  return { supported: true, satisfied };
}

function makeSubprocessEnvironment() {
  const environment = {};
  for (const key of allowedEnvironmentKeys) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  environment.TZ = "UTC";
  environment.CI = "1";
  environment.NEXT_TELEMETRY_DISABLED = "1";
  environment.PLAYWRIGHT_PORT = "3100";
  const emptyNpmConfig = resolve(root, ".artifacts", "route-first-inactive-empty.npmrc");
  mkdirSync(dirname(emptyNpmConfig), { recursive: true });
  writeFileSync(emptyNpmConfig, "", { encoding: "utf8", mode: 0o600 });
  environment.NPM_CONFIG_USERCONFIG = emptyNpmConfig;
  environment.NPM_CONFIG_GLOBALCONFIG = emptyNpmConfig;
  return environment;
}

const nodeEngine = readNodeEngine();
const nodeGate = nodeEngine ? evaluateNodeEngine(process.version, nodeEngine) : { supported: false, satisfied: false };
if (!nodeGate.supported || !nodeGate.satisfied) {
  const failureReason = !nodeEngine
    ? "node-engine-not-declared-or-unreadable"
    : !nodeGate.supported
      ? "node-engine-range-unreadable"
      : `unsupported-node-runtime:${process.version};required=${nodeEngine}`;
  const report = {
    schemaVersion: "route-first-inactive-certification/v1",
    generatedAt: new Date().toISOString(),
    sourceRevision: "not-checked",
    dirtyTree: null,
    dirtyDevelopmentOverride: allowDirtyDevelopment,
    toolchain: { node: process.version, nodeEngine, npm: "not-checked" },
    subprocessEnvironment: { mode: "not-started", checksStarted: false },
    releaseScope: "route-first-inactive",
    activationEligible: false,
    durable: false,
    runtimePersistence: "in-memory-process",
    activation: "blocked-until-durable-provider",
    defaultStatus: "unavailable",
    checks: [],
    identifiedTestSkips: [],
    externalActivationBlockers: [],
    certification: { passed: false, developmentChecksPassed: false, failureReasons: [failureReason] },
  };
  writeReport(report);
  console.error(`route-first inactive certification cannot start: ${failureReason}`);
  printReport(report);
  process.exitCode = 1;
  process.exit();
}

const subprocessEnvironment = makeSubprocessEnvironment();

function run(command, commandArgs, environment = subprocessEnvironment) {
  const started = performance.now();
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    result,
    durationMs: Math.round(performance.now() - started),
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function commandText(command, commandArgs) {
  return [command, ...commandArgs].join(" ");
}

function extractSkips(output, kind) {
  if (kind === "unit") {
    return [...new Set(output.split("\n")
      .filter((line) => line.includes("﹣"))
      .map((line) => line.slice(line.indexOf("﹣") + 1).split("#", 1)[0].trim().replace(/\s+\([^)]*ms\)$/, "").trim())
      .filter(Boolean))];
  }
  if (kind === "playwright-json") {
    const report = parsePlaywrightJson(output);
    if (!report) return [];
    const names = [];
    walkPlaywrightSuites(report.suites ?? [], [], names);
    return [...new Set(names)];
  }
  return [];
}

function skipCount(output, kind) {
  if (kind === "unit") return Number(output.match(/(?:^|\n)ℹ skipped (\d+)/)?.[1] ?? 0);
  if (kind === "playwright-json") {
    const report = parsePlaywrightJson(output);
    if (report) {
      const names = [];
      walkPlaywrightSuites(report.suites ?? [], [], names);
      return names.length;
    }
    return Number(output.match(/(?:^|\n)\s*(\d+)\s+skipped\b/i)?.[1] ?? 0);
  }
  return 0;
}

function parsePlaywrightJson(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
}

function walkPlaywrightSuites(suites, parents, names) {
  for (const suite of suites) {
    const nextParents = suite.title ? [...parents, suite.title] : parents;
    for (const spec of suite.specs ?? []) {
      if ((spec.tests ?? []).some((test) => test.status === "skipped" || (test.results ?? []).some((result) => result.status === "skipped"))) {
        names.push(spec.title ? [...nextParents, spec.title].join(" › ") : "unidentified-test-skip");
      }
    }
    walkPlaywrightSuites(suite.suites ?? [], nextParents, names);
  }
}

const checks = [];
const unexpectedSkips = new Set();
const identifiedTestSkips = [];
let allowedOtpSkipCount = 0;

function check(name, command, commandArgs, kind) {
  const execution = run(command, commandArgs);
  const output = `${execution.stdout}\n${execution.stderr}`;
  const names = extractSkips(output, kind);
  const count = skipCount(output, kind);
  const skipNames = [...names];
  if (count > skipNames.length) skipNames.push("unidentified-test-skip");
  let invalidSkip = false;
  const structuredReportMissing = kind === "playwright-json" && parsePlaywrightJson(output) === null;
  if (structuredReportMissing) {
    unexpectedSkips.add(`${name}:missing-structured-report`);
    invalidSkip = true;
  }
  for (const skipName of skipNames) {
    identifiedTestSkips.push({ check: name, name: skipName });
    if (skipName === allowedOtpSkip && name === "full-unit-tests") {
      allowedOtpSkipCount += 1;
    } else {
      unexpectedSkips.add(`${name}:${skipName}`);
      invalidSkip = true;
    }
  }
  const commandFailed = execution.result.error || execution.result.status !== 0;
  checks.push({
    name,
    command: commandText(command, commandArgs),
    status: commandFailed || invalidSkip ? "failed" : "passed",
    durationMs: execution.durationMs,
    skipNames,
  });
}

const gitRevisionExecution = run("git", ["rev-parse", "--verify", "HEAD"]);
const gitStatusExecution = run("git", ["status", "--porcelain", "--untracked-files=all"]);
const npmVersionExecution = run(npmBinary, ["--version"]);
const dirtyTree = gitStatusExecution.result.status !== 0 || gitStatusExecution.stdout.trim().length > 0 || gitStatusExecution.stderr.trim().length > 0;
const sourceRevision = gitRevisionExecution.result.status === 0 ? gitRevisionExecution.stdout.trim() : "unknown";
const npmVersion = npmVersionExecution.result.status === 0 ? npmVersionExecution.stdout.trim() : "unknown";

check("full-unit-tests", npmBinary, ["test"], "unit");
check("typescript", npmBinary, ["exec", "--", "tsc", "--noEmit"]);
check("lint", npmBinary, ["run", "lint"]);
check("all-playwright-tests", npmBinary, ["run", "test:e2e", "--", "--reporter=json"], "playwright-json");
check("routing-config-fixture", pythonBinary, ["routing/scripts/validate-routing-config.py"]);
check("routing-manifest-fixture", pythonBinary, ["routing/scripts/validate-routing-manifest.py", "--fixture", "routing/manifest/canonical-output.fixture.json"]);
check("build-and-verify-trace", npmBinary, ["run", "build:verify-trace"]);
check("git-diff-check", "git", ["diff", "--check"]);

const commandFailures = checks.filter((entry) => entry.status === "failed").map((entry) => entry.name);
const allowedExternalBlockers = identifiedTestSkips.some((entry) => entry.check === "full-unit-tests" && entry.name === allowedOtpSkip)
  ? [{ id: "otp-2.6-live-schema-gate", testIdentity: allowedOtpSkip, status: "external-activation-blocker" }]
  : [];
const developmentFailureReasons = [
  ...commandFailures.map((name) => `command-failed:${name}`),
  ...[...unexpectedSkips].map((name) => `unexpected-skip:${name}`),
  ...(gitRevisionExecution.result.status !== 0 ? ["source-revision-unavailable"] : []),
  ...(npmVersionExecution.result.status !== 0 ? ["npm-version-unavailable"] : []),
  ...(allowedOtpSkipCount !== 1 ? [`required-otp-skip-count:${allowedOtpSkipCount}`] : []),
];
const report = {
  schemaVersion: "route-first-inactive-certification/v1",
  generatedAt: new Date().toISOString(),
  sourceRevision,
  dirtyTree,
  dirtyDevelopmentOverride: allowDirtyDevelopment,
  toolchain: { node: process.version, nodeEngine, npm: npmVersion },
  subprocessEnvironment: {
    mode: "explicit-allowlist",
    checksStarted: true,
    allowlistedKeys: Object.keys(subprocessEnvironment).sort(),
    excludedPatterns: ["MEEET_*", "ROUTING_*", "OTP_*", "*_URL", "*_TOKEN", "*_PASSWORD", "*_SECRET", "*_CREDENTIAL*"],
  },
  releaseScope: "route-first-inactive",
  activationEligible: false,
  durable: false,
  runtimePersistence: "in-memory-process",
  activation: "blocked-until-durable-provider",
  defaultStatus: "unavailable",
  checks,
  identifiedTestSkips,
  externalActivationBlockers: allowedExternalBlockers,
  certification: {
    passed: developmentFailureReasons.length === 0 && !dirtyTree,
    developmentChecksPassed: developmentFailureReasons.length === 0,
    failureReasons: [...new Set([...developmentFailureReasons, ...(dirtyTree ? ["dirty-tree"] : [])])],
  },
};

writeReport(report);
printReport(report);
process.exitCode = report.certification.passed ? 0 : 1;

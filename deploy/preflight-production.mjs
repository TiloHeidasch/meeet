#!/usr/bin/env node

import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DEPLOYMENT_ENV_KEYS, readProductionEnvFile } from "./production-env.mjs";

const args = process.argv.slice(2);
if (args.length > 1) {
  console.error("Usage: node deploy/preflight-production.mjs [env-file]");
  process.exit(2);
}

const envFile = resolve(process.cwd(), args[0] ?? "deploy/production.env");
const errors = [];
const deploymentControlled = [...DEPLOYMENT_ENV_KEYS];

const exportedDeploymentControlled = deploymentControlled.filter((key) => Object.hasOwn(process.env, key));
if (exportedDeploymentControlled.length > 0) {
  error(
    `deployment-controlled variables are already exported: ${exportedDeploymentControlled.join(", ")}; unset them before running the preflight and Compose (for example: unset ${exportedDeploymentControlled.join(" ")})`,
  );
}

function error(message) {
  errors.push(message);
}

const { values, errors: envFileErrors } = readProductionEnvFile(envFile);
for (const message of envFileErrors) error(message);
const unknownKeys = [...values.keys()].filter((key) => !DEPLOYMENT_ENV_KEYS.includes(key));
if (unknownKeys.length > 0) error(`unsupported deployment environment keys: ${unknownKeys.join(", ")}`);
for (const key of deploymentControlled) {
  if (!values.get(key)) error(`${key} is required in ${envFile}`);
}

const tunnelToken = values.get("TUNNEL_TOKEN");
if (tunnelToken !== undefined && (tunnelToken === "" || /[\r\n\0]/.test(tunnelToken))) {
  error("TUNNEL_TOKEN must be a nonempty value with no newline or NUL characters");
}

const ghcrOwner = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const digest = "[0-9a-f]{64}";
const runnerImagePattern = new RegExp(`^ghcr\\.io/(${ghcrOwner})/meeet@sha256:${digest}$`);
const compilerImagePattern = new RegExp(`^ghcr\\.io/(${ghcrOwner})/meeet-artifact-compiler@sha256:${digest}$`);
const runnerImage = values.get("MEEET_IMAGE");
const compilerImage = values.get("MEEET_COMPILER_IMAGE");
const runnerMatch = runnerImage && runnerImagePattern.exec(runnerImage);
const compilerMatch = compilerImage && compilerImagePattern.exec(compilerImage);
if (runnerImage && !runnerMatch) error("MEEET_IMAGE must be ghcr.io/<lowercase owner>/meeet@sha256:<64 lowercase hex digits>");
if (compilerImage && !compilerMatch) error("MEEET_COMPILER_IMAGE must be ghcr.io/<lowercase owner>/meeet-artifact-compiler@sha256:<64 lowercase hex digits>");
if (runnerMatch && compilerMatch && runnerMatch[1] !== compilerMatch[1]) {
  error("MEEET_IMAGE and MEEET_COMPILER_IMAGE must use the same lowercase GHCR owner");
}

const scheduleHostDir = values.get("MEEET_SCHEDULE_HOST_DIR");
if (scheduleHostDir && (!isAbsolute(scheduleHostDir) || scheduleHostDir.includes("\0"))) {
  error("MEEET_SCHEDULE_HOST_DIR must be an absolute host path");
}

for (const key of values.keys()) {
  if (key === "TUNNEL_TOKEN") continue;
  if (/(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/.test(key)) {
    error(`${key} is not allowed in the ordinary deployment environment; only TUNNEL_TOKEN may carry a token`);
  }
}

function run(command, commandArgs) {
  try {
    const result = spawnSync(command, commandArgs, { encoding: "utf8" });
    if (result.error) return { ok: false, output: result.error.message };
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    return { ok: result.status === 0, output };
  } catch (cause) {
    return { ok: false, output: cause.message };
  }
}

if (errors.length === 0) {
  const compose = run("docker", ["compose", "version", "--short"]);
  const composeVersion = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)/.exec(compose.output);
  if (!compose.ok || !composeVersion) {
    error(`Docker Compose v2.33.0 or newer is required (${compose.output || "docker compose is unavailable"})`);
  } else {
    const [, major, minor, patch] = composeVersion;
    const version = [Number(major), Number(minor), Number(patch)];
    if (version[0] < 2 || (version[0] === 2 && (version[1] < 33 || (version[1] === 33 && version[2] < 0)))) {
      error(`Docker Compose v2.33.0 or newer is required (found ${major}.${minor}.${patch})`);
    }
  }

  const engine = run("docker", ["version", "--format", "{{.Server.Version}}"]);
  const engineVersion = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)/.exec(engine.output);
  if (!engine.ok || !engineVersion) {
    error(`Docker Engine 28 or newer is required (${engine.output || "docker version failed"})`);
  } else if (Number(engineVersion[1]) < 28) {
    error(`Docker Engine 28 or newer is required (found ${engineVersion[0].trim()})`);
  }

  const engineApi = run("docker", ["version", "--format", "{{.Server.APIVersion}}"]);
  const engineApiVersion = /(?:^|\s)v?(\d+)\.(\d+)(?:\s|$)/.exec(engineApi.output);
  if (!engineApi.ok || !engineApiVersion) {
    error(`Docker Engine API v1.48 or newer is required (${engineApi.output || "Docker API version unavailable"})`);
  } else if (Number(engineApiVersion[1]) < 1 || (Number(engineApiVersion[1]) === 1 && Number(engineApiVersion[2]) < 48)) {
    error(`Docker Engine API v1.48 or newer is required (found ${engineApiVersion[0].trim()})`);
  }
}

if (errors.length > 0) {
  console.error("Production deployment preflight failed:");
  for (const message of errors) console.error(`- ${message}`);
  process.exit(1);
}

console.log(`Production deployment preflight passed for ${envFile}`);

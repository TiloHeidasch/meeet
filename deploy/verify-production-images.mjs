#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { DEPLOYMENT_ENV_KEYS, readProductionEnvFile } from "./production-env.mjs";

const args = process.argv.slice(2);
if (args.length > 1) {
  console.error("Usage: node deploy/verify-production-images.mjs [env-file]");
  process.exit(2);
}

const envFile = resolve(process.cwd(), args[0] ?? "deploy/production.env");
const { values, errors } = readProductionEnvFile(envFile);
const unknownKeys = [...values.keys()].filter((key) => !DEPLOYMENT_ENV_KEYS.includes(key));
if (unknownKeys.length > 0) errors.push(`unsupported deployment environment keys: ${unknownKeys.join(", ")}`);
if (errors.length > 0) fail(errors);

const runnerImage = values.get("MEEET_IMAGE");
const compilerImage = values.get("MEEET_COMPILER_IMAGE");
if (!runnerImage || !compilerImage) fail(["MEEET_IMAGE and MEEET_COMPILER_IMAGE are required"]);
const ghcrOwner = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const digest = "[0-9a-f]{64}";
const runnerMatch = new RegExp(`^ghcr\\.io/(${ghcrOwner})/meeet@sha256:${digest}$`).exec(runnerImage);
const compilerMatch = new RegExp(`^ghcr\\.io/(${ghcrOwner})/meeet-artifact-compiler@sha256:${digest}$`).exec(compilerImage);
if (!runnerMatch || !compilerMatch) fail(["MEEET_IMAGE and MEEET_COMPILER_IMAGE must be exact lowercase digest-pinned GHCR references"]);
if (runnerMatch[1] !== compilerMatch[1]) fail(["MEEET_IMAGE and MEEET_COMPILER_IMAGE must use the same lowercase GHCR owner"]);

const runnerRevision = inspectRevision(runnerImage, "MEEET_IMAGE");
const compilerRevision = inspectRevision(compilerImage, "MEEET_COMPILER_IMAGE");
if (runnerRevision !== compilerRevision) {
  fail(["MEEET_IMAGE and MEEET_COMPILER_IMAGE have different org.opencontainers.image.revision labels"]);
}

console.log("Production runner/compiler image revision labels match.");

function inspectRevision(image, name) {
  const result = spawnSync(
    "docker",
    ["image", "inspect", image, "--format", '{{ index .Config.Labels "org.opencontainers.image.revision" }}'],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    fail([`${name} image inspect failed: ${result.error?.message ?? result.stderr?.trim() ?? "docker image inspect failed"}`]);
  }
  const revision = (result.stdout ?? "").trim();
  if (revision === "" || revision === "<no value>") {
    fail([`${name} is missing a nonempty org.opencontainers.image.revision label`]);
  }
  return revision;
}

function fail(messages) {
  console.error("Production image verification failed:");
  for (const message of messages) console.error(`- ${message}`);
  process.exit(1);
}

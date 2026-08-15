#!/usr/bin/env node

import { resolve } from "node:path";
import { DEPLOYMENT_ENV_KEYS, readProductionEnvFile } from "./production-env.mjs";

const args = process.argv.slice(2);
if (args.length > 1) {
  console.error("Usage: node deploy/read-compiler-image.mjs [env-file]");
  process.exit(2);
}

const envFile = resolve(process.cwd(), args[0] ?? "deploy/production.env");
const { values, errors } = readProductionEnvFile(envFile);
const unknownKeys = [...values.keys()].filter((key) => !DEPLOYMENT_ENV_KEYS.includes(key));
if (unknownKeys.length > 0) errors.push(`unsupported deployment environment keys: ${unknownKeys.join(", ")}`);
if (errors.length > 0) {
  console.error("Cannot safely read the compiler image:");
  for (const message of errors) console.error(`- ${message}`);
  process.exit(1);
}

const compilerImage = values.get("MEEET_COMPILER_IMAGE");
if (!compilerImage) {
  console.error(`MEEET_COMPILER_IMAGE is required in ${envFile}`);
  process.exit(1);
}
if (!/^ghcr\.io\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/meeet-artifact-compiler@sha256:[0-9a-f]{64}$/.test(compilerImage)) {
  console.error("MEEET_COMPILER_IMAGE is not a valid lowercase digest-pinned GHCR compiler image");
  process.exit(1);
}

process.stdout.write(`${compilerImage}\n`);

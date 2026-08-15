import { existsSync, readFileSync, statSync } from "node:fs";

export const DEPLOYMENT_ENV_KEYS = Object.freeze([
  "MEEET_IMAGE",
  "MEEET_COMPILER_IMAGE",
  "CLOUDFLARED_IMAGE",
  "MEEET_SCHEDULE_HOST_DIR",
  "CLOUDFLARED_TOKEN_FILE",
]);

/**
 * Parse the deliberately small production dotenv contract. This parser never
 * evaluates shell syntax, expands variables, or exports values.
 */
export function readProductionEnvFile(path) {
  const errors = [];
  const values = new Map();
  if (!existsSync(path)) {
    errors.push(`environment file does not exist: ${path}`);
    return { values, errors };
  }
  try {
    if (!statSync(path).isFile()) {
      errors.push(`environment path is not a regular file: ${path}`);
      return { values, errors };
    }
  } catch (cause) {
    errors.push(`cannot inspect environment file ${path}: ${cause.message}`);
    return { values, errors };
  }

  let contents;
  try {
    contents = readFileSync(path, "utf8");
  } catch (cause) {
    errors.push(`cannot read environment file ${path}: ${cause.message}`);
    return { values, errors };
  }
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      errors.push(`${path}:${index + 1}: expected KEY=value`);
      continue;
    }
    let value = match[2].trim();
    if ((value.startsWith('"') && !value.endsWith('"')) || (value.startsWith("'") && !value.endsWith("'"))) {
      errors.push(`${path}:${index + 1}: unterminated quoted value`);
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return { values, errors };
}

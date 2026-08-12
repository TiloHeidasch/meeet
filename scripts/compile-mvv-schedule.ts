import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  SCHEDULED_MVV_FEED_URL,
  compileScheduledArtifact,
  fetchAndCompileScheduledArtifact,
  writeScheduledArtifact,
} from "../lib/domain/scheduled-routing/artifact.ts";

async function main(): Promise<void> {
  const argumentsMap = parseArguments(process.argv.slice(2));
  if (argumentsMap.help) {
    process.stdout.write("Usage: npm run schedule:compile:mvv -- [--input ABSOLUTE_ZIP] [--output ABSOLUTE_JSON] [--source-url CANONICAL_MVV_URL]\n");
    return;
  }
  const outputPath = resolve(argumentsMap.output ?? "data/scheduled/mvv-scheduled-artifact.json");
  if (!isAbsolute(outputPath)) throw new Error("The schedule compiler output path must be absolute.");
  const artifact = argumentsMap.input === undefined
    ? await fetchAndCompileScheduledArtifact({ sourceUrl: argumentsMap.sourceUrl })
    : compileScheduledArtifact({ sourceUrl: argumentsMap.sourceUrl, inputPath: argumentsMap.input });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeScheduledArtifact(outputPath, artifact);
  process.stdout.write(`${outputPath}\n`);
}

function parseArguments(argumentsList: readonly string[]): { input?: string; output?: string; sourceUrl: string; help?: boolean } {
  let input: string | undefined;
  let output: string | undefined;
  let sourceUrl = SCHEDULED_MVV_FEED_URL;
  let help = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (name === "--help" || name === "-h") {
      help = true;
      continue;
    }
    if ((name === "--input" || name === "--output" || name === "--source-url") && value !== undefined) {
      if (name === "--input") input = requireAbsolutePath(value, "--input");
      if (name === "--output") output = requireAbsolutePath(value, "--output");
      if (name === "--source-url") sourceUrl = value;
      index += 1;
      continue;
    }
    throw new Error("Usage: npm run schedule:compile:mvv -- [--input ABSOLUTE_ZIP] [--output ABSOLUTE_JSON] [--source-url CANONICAL_MVV_URL]");
  }
  return { input, output, sourceUrl, help };
}

function requireAbsolutePath(value: string, flag: string): string {
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path.`);
  return value;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Schedule compilation failed."}\n`);
  process.exitCode = 1;
});

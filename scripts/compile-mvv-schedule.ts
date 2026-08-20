import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { logCompilerProgress, elapsedMs } from "../lib/log.ts";
import {
  SCHEDULED_MVV_FEED_URL,
  compileScheduledArtifact,
  rotateScheduledArtifact,
  writeScheduledArtifact,
} from "../lib/domain/scheduled-routing/artifact.ts";

async function main(): Promise<void> {
  const argumentsMap = parseArguments(process.argv.slice(2));
  if (argumentsMap.help) {
    process.stdout.write("Usage: npm run schedule:compile:mvv -- [--input ABSOLUTE_ZIP] [--output ABSOLUTE_JSON] [--source-url CANONICAL_MVV_URL]\nOffline compile with --input, or startup rotation without --input.\n");
    return;
  }
  const outputPath = resolve(argumentsMap.output ?? "data/scheduled/mvv-scheduled-artifact.json");
  if (!isAbsolute(outputPath)) throw new Error("The schedule compiler output path must be absolute.");
  mkdirSync(dirname(outputPath), { recursive: true });
  const mode = argumentsMap.input === undefined ? "rotation" : "offline compile";
  logCompilerProgress(`schedule compiler startup (mode=${mode}, output=${outputPath}, sourceUrl=${argumentsMap.sourceUrl})`);
  const startedAt = performance.now();
  if (argumentsMap.input === undefined) {
    const result = await rotateScheduledArtifact({ outputPath, sourceUrl: argumentsMap.sourceUrl });
    process.stdout.write(`${result.action}:${result.reason}\n`);
    logCompilerProgress(`rotation complete: ${result.action} (${result.reason}) in ${elapsedMs(startedAt)}ms`);
  } else {
    const artifact = compileScheduledArtifact({ sourceUrl: argumentsMap.sourceUrl, inputPath: argumentsMap.input });
    writeScheduledArtifact(outputPath, artifact);
    logCompilerProgress(
      `offline compile complete: routes=${artifact.routes.length}, trips=${artifact.trips.length}, stationAreas=${artifact.stationAreas.length}, calendars=${artifact.calendars.length}, exceptions=${artifact.exceptions.length}, connections=${artifact.connections.length}, serviceDateRange=${artifact.serviceDateRange.firstDate}..${artifact.serviceDateRange.lastDate}, feedId=${artifact.feedId} in ${elapsedMs(startedAt)}ms`,
    );
  }
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
    throw new Error("Usage: npm run schedule:compile:mvv -- [--input ABSOLUTE_ZIP] [--output ABSOLUTE_JSON] [--source-url CANONICAL_MVV_URL]\nOffline compile with --input, or startup rotation without --input.");
  }
  return { input, output, sourceUrl, help };
}

function requireAbsolutePath(value: string, flag: string): string {
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path.`);
  return value;
}

void main().catch((error: unknown) => {
  logCompilerProgress(`compilation failed: ${error instanceof Error ? error.message : "Schedule compilation failed."}`);
  process.exitCode = 1;
});

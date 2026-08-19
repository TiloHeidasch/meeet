import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import {
  SCHEDULED_MVV_FEED_URL,
  compileScheduledArtifact,
  writeScheduledArtifact,
} from "../lib/domain/scheduled-routing/artifact.ts";
import { fixtureFeedFiles } from "./fixture-schedule-transform.ts";

async function main(): Promise<void> {
  const argumentsMap = parseArguments(process.argv.slice(2));
  if (argumentsMap.help) {
    process.stdout.write("Usage: npm run schedule:compile:fixture -- --output ABSOLUTE_JSON\n");
    return;
  }
  const outputPath = argumentsMap.output;
  if (outputPath === undefined) throw new Error("The fixture schedule compiler requires an --output path.");
  if (!isAbsolute(outputPath)) throw new Error("The fixture schedule compiler output path must be absolute.");

  const feedFiles = fixtureFeedFiles(Date.now());

  const artifact = compileScheduledArtifact({
    sourceUrl: SCHEDULED_MVV_FEED_URL,
    rawArchiveBytes: new TextEncoder().encode(`fixture-e2e-${Date.now()}`),
    feedFiles,
    retrievedAt: new Date(Math.trunc(Date.now() / 1_000) * 1_000).toISOString(),
    feedId: "fixture-scheduled-feed",
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeScheduledArtifact(outputPath, artifact);

  const firstDeparture = feedFiles["stop_times.txt"].split("\n")[1]?.split(",")[2] ?? "unknown";
  process.stdout.write(`${outputPath}\n`);
  process.stdout.write(
    `serviceDateRange: ${artifact.serviceDateRange.firstDate}..${artifact.serviceDateRange.lastDate}\n`,
  );
  process.stdout.write(`first departure: ${firstDeparture}\n`);
}

function parseArguments(argumentsList: readonly string[]): { output?: string; help?: boolean } {
  let output: string | undefined;
  let help = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (name === "--help" || name === "-h") {
      help = true;
      continue;
    }
    if (name === "--output" && value !== undefined) {
      output = value;
      index += 1;
      continue;
    }
    throw new Error("Usage: npm run schedule:compile:fixture -- --output ABSOLUTE_JSON");
  }
  return { output, help };
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Fixture schedule compilation failed."}\n`);
  process.exitCode = 1;
});

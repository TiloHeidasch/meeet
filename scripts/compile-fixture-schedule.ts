import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import {
  SCHEDULED_MVV_FEED_URL,
  compileScheduledArtifact,
  writeScheduledArtifact,
} from "../lib/domain/scheduled-routing/artifact.ts";
import { FIXTURE_SCHEDULED_GTFS_FILES } from "../lib/fixtures/scheduled-routing.ts";

/** First fixture departure (fixture-a-b at 08:10) in minutes of day. */
const FIRST_FIXTURE_DEPARTURE_MINUTES = 490;

async function main(): Promise<void> {
  const argumentsMap = parseArguments(process.argv.slice(2));
  if (argumentsMap.help) {
    process.stdout.write("Usage: npm run schedule:compile:fixture -- --output ABSOLUTE_JSON\n");
    return;
  }
  const outputPath = argumentsMap.output;
  if (outputPath === undefined) throw new Error("The fixture schedule compiler requires an --output path.");
  if (!isAbsolute(outputPath)) throw new Error("The fixture schedule compiler output path must be absolute.");

  const dateRange = currentDateRange();
  const shiftMinutes = fixtureShiftMinutes();
  const feedFiles = {
    ...FIXTURE_SCHEDULED_GTFS_FILES,
    "feed_info.txt": FIXTURE_SCHEDULED_GTFS_FILES["feed_info.txt"]
      .replace("20260801", dateRange.firstDate.replaceAll("-", ""))
      .replace("20260831", dateRange.lastDate.replaceAll("-", "")),
    "calendar.txt": FIXTURE_SCHEDULED_GTFS_FILES["calendar.txt"]
      .replace("20260801", dateRange.firstDate.replaceAll("-", ""))
      .replace("20260831", dateRange.lastDate.replaceAll("-", "")),
    "stop_times.txt": shiftStopTimes(FIXTURE_SCHEDULED_GTFS_FILES["stop_times.txt"], shiftMinutes),
  };

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

function currentDateRange(): { firstDate: string; lastDate: string } {
  const today = new Date();
  const firstDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const lastDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
  return {
    firstDate: firstDate.toISOString().slice(0, 10),
    lastDate: lastDate.toISOString().slice(0, 10),
  };
}

function fixtureShiftMinutes(): number {
  const nowPlusTenMinutes = Date.now() + 10 * 60 * 1000;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(nowPlusTenMinutes);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  let shift = hour * 60 + minute - FIRST_FIXTURE_DEPARTURE_MINUTES;
  if (shift < 0) shift += 24 * 60;
  return shift;
}

function shiftStopTimes(stopTimes: string, shiftMinutes: number): string {
  return stopTimes
    .split("\n")
    .map((row, index) => {
      if (index === 0 || row.trim() === "") return row;
      const columns = row.split(",");
      columns[1] = shiftGtfsTime(columns[1] ?? "", shiftMinutes);
      columns[2] = shiftGtfsTime(columns[2] ?? "", shiftMinutes);
      return columns.join(",");
    })
    .join("\n");
}

function shiftGtfsTime(value: string, shiftMinutes: number): string {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid GTFS time ${value}.`);
  const totalMinutes = Number(match[1]) * 60 + Number(match[2]) + shiftMinutes;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${match[3]}`;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Fixture schedule compilation failed."}\n`);
  process.exitCode = 1;
});
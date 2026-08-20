import type { GtfsFeedFiles } from "../lib/domain/scheduled-routing/gtfs.ts";
import { FIXTURE_SCHEDULED_GTFS_FILES } from "../lib/fixtures/scheduled-routing.ts";

/** First fixture departure (fixture-a-b at 08:10) in minutes of day. */
export const FIRST_FIXTURE_DEPARTURE_MINUTES = 490;

export function currentDateRange(): { firstDate: string; lastDate: string } {
  const today = new Date();
  const firstDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const lastDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
  return {
    firstDate: firstDate.toISOString().slice(0, 10),
    lastDate: lastDate.toISOString().slice(0, 10),
  };
}

/**
 * Berlin wall-clock shift (minutes) that places the first fixture departure
 * exactly ten minutes after `nowMs`, wrapping past midnight when needed.
 */
export function shiftMinutesFor(nowMs: number): number {
  const nowPlusTenMinutes = nowMs + 10 * 60 * 1000;
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

/** The fixture feed re-dated around today and its stop times shifted to `nowMs`. */
export function fixtureFeedFiles(nowMs: number): GtfsFeedFiles {
  const dateRange = currentDateRange();
  const shiftMinutes = shiftMinutesFor(nowMs);
  return {
    ...FIXTURE_SCHEDULED_GTFS_FILES,
    "feed_info.txt": FIXTURE_SCHEDULED_GTFS_FILES["feed_info.txt"]
      .replace("20260801", dateRange.firstDate.replaceAll("-", ""))
      .replace("20260831", dateRange.lastDate.replaceAll("-", "")),
    "calendar.txt": FIXTURE_SCHEDULED_GTFS_FILES["calendar.txt"]
      .replace("20260801", dateRange.firstDate.replaceAll("-", ""))
      .replace("20260831", dateRange.lastDate.replaceAll("-", "")),
    "stop_times.txt": shiftStopTimes(FIXTURE_SCHEDULED_GTFS_FILES["stop_times.txt"], shiftMinutes),
  };
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
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  // Mirror lib/domain/scheduled-routing/gtfs.ts gtfsTime, which rejects hours
  // past 99 even though the fixture input is always two-digit, and rejects
  // nonzero seconds because the scheduled calculation is minute-aligned.
  if (hours > 99 || minutes > 59 || seconds > 59) throw new Error(`Invalid GTFS time ${value}.`);
  if (seconds !== 0) throw new Error(`Invalid GTFS time ${value}: seconds must be :00.`);
  const totalMinutes = hours * 60 + minutes + shiftMinutes;
  const shiftedHours = Math.floor(totalMinutes / 60);
  const shiftedMinutes = totalMinutes % 60;
  if (shiftedHours > 99) throw new Error(`Shifted GTFS time ${value} exceeds the supported 99-hour range.`);
  return `${String(shiftedHours).padStart(2, "0")}:${String(shiftedMinutes).padStart(2, "0")}:${match[3]}`;
}

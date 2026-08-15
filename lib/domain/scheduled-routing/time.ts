import "server-only";

import { ROUTING_HORIZON_SECONDS, SECONDS_PER_DAY } from "./models.ts";

export interface ParsedOffsetInstant {
  readonly epochSeconds: number;
  readonly canonicalAt: string;
  readonly timeZone: string;
}

const OFFSET_INSTANT_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})$/;

export function parseOffsetInstant(value: string, timeZone: string): ParsedOffsetInstant {
  const match = typeof value === "string" ? OFFSET_INSTANT_PATTERN.exec(value) : null;
  const fractional = match?.[1].match(/\.(\d+)$/)?.[1];
  if (match === null) {
    throw new RangeError("searchStartAt must be an ISO-8601 instant with an explicit offset.");
  }
  if (fractional !== undefined && /[1-9]/.test(fractional)) throw new RangeError("searchStartAt must represent an exact whole second.");
  validateTimeZone(timeZone);
  const epochMilliseconds = Date.parse(value);
  if (!Number.isFinite(epochMilliseconds) || epochMilliseconds % 1_000 !== 0) {
    throw new RangeError("searchStartAt must represent an exact whole second.");
  }
  const instant = new Date(epochMilliseconds);
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError("searchStartAt is not a valid instant.");
  }
  return {
    epochSeconds: epochMilliseconds / 1_000,
    canonicalAt: instant.toISOString(),
    timeZone,
  };
}

export function serviceDateForEpochSeconds(epochSeconds: number, timeZone: string): string {
  const parts = zonedParts(epochSeconds, timeZone);
  const civilDate = formatDate(parts.year, parts.month, parts.day);
  let selectedDate: string | null = null;
  let selectedAnchor = Number.NEGATIVE_INFINITY;
  for (let offset = -6; offset <= 2; offset += 1) {
    const candidateDate = addServiceDays(civilDate, offset);
    const candidateAnchor = serviceDateAnchorEpochSeconds(candidateDate, timeZone);
    if (candidateAnchor <= epochSeconds && candidateAnchor > selectedAnchor) {
      selectedDate = candidateDate;
      selectedAnchor = candidateAnchor;
    }
  }
  if (selectedDate === null) throw new RangeError("The instant is outside the supported service-date range.");
  return selectedDate;
}

/**
 * GTFS service-day anchor: local noon minus twelve elapsed hours. This is an
 * elapsed-time anchor, not a local-midnight wall-clock conversion, so every
 * service-day second remains ordered and duration-preserving across DST.
 */
export function serviceDateAnchorEpochSeconds(serviceDate: string, timeZone: string): number {
  const date = parseServiceDate(serviceDate);
  validateTimeZone(timeZone);
  const naiveNoonMilliseconds = Date.UTC(date.year, date.month - 1, date.day, 12, 0, 0);
  return (resolveLocalWallClockMilliseconds(naiveNoonMilliseconds, timeZone) - 12 * 3_600 * 1_000) / 1_000;
}

export function serviceDateSecondsToEpochSeconds(
  serviceDate: string,
  secondsSinceServiceDayStart: number,
  timeZone: string,
): number {
  if (
    !Number.isInteger(secondsSinceServiceDayStart) ||
    secondsSinceServiceDayStart < 0 ||
    secondsSinceServiceDayStart > 99 * SECONDS_PER_DAY + 86_399
  ) {
    throw new RangeError("GTFS service-day time is outside the supported whole-second range.");
  }
  return serviceDateAnchorEpochSeconds(serviceDate, timeZone) + secondsSinceServiceDayStart;
}

export function addServiceDays(serviceDate: string, days: number): string {
  const date = parseServiceDate(serviceDate);
  if (!Number.isInteger(days)) throw new RangeError("Service-day offsets must be integers.");
  const milliseconds = Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000;
  const result = new Date(milliseconds);
  return formatDate(result.getUTCFullYear(), result.getUTCMonth() + 1, result.getUTCDate());
}

export function serviceDateRangeForSearch(
  searchStartEpochSeconds: number,
  timeZone: string,
  maximumServiceDayTimeSeconds = 0,
): readonly [string, string] {
  const firstLocalDate = serviceDateForEpochSeconds(searchStartEpochSeconds, timeZone);
  const horizonEnd = searchStartEpochSeconds + ROUTING_HORIZON_SECONDS;
  const lastLocalDate = serviceDateForEpochSeconds(horizonEnd, timeZone);
  const lookbackDays = Math.floor(Math.max(0, maximumServiceDayTimeSeconds) / SECONDS_PER_DAY);
  return [addServiceDays(firstLocalDate, -lookbackDays), lastLocalDate];
}

function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new RangeError(`Unknown IANA time zone: ${timeZone}`);
  }
}

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function zonedParts(epochSeconds: number, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = new Map<string, number>();
  for (const part of formatter.formatToParts(new Date(epochSeconds * 1_000))) {
    if (part.type === "year" || part.type === "month" || part.type === "day" || part.type === "hour" || part.type === "minute" || part.type === "second") {
      values.set(part.type, Number(part.value));
    }
  }
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  const hour = values.get("hour");
  const minute = values.get("minute");
  const second = values.get("second");
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined) {
    throw new Error("The time-zone formatter did not return a complete instant.");
  }
  return { year, month, day, hour, minute, second };
}

function timeZoneOffsetMilliseconds(epochMilliseconds: number, timeZone: string): number {
  const parts = zonedParts(Math.trunc(epochMilliseconds / 1_000), timeZone);
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return representedAsUtc - Math.trunc(epochMilliseconds / 1_000) * 1_000;
}

function resolveLocalWallClockMilliseconds(naiveMilliseconds: number, timeZone: string): number {
  let candidateMilliseconds = naiveMilliseconds;
  let lastCandidate = Number.NaN;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offsetMilliseconds = timeZoneOffsetMilliseconds(candidateMilliseconds, timeZone);
    const nextCandidate = naiveMilliseconds - offsetMilliseconds;
    if (nextCandidate === candidateMilliseconds || nextCandidate === lastCandidate) return nextCandidate;
    lastCandidate = candidateMilliseconds;
    candidateMilliseconds = nextCandidate;
  }
  return candidateMilliseconds;
}

function parseServiceDate(value: string): { readonly year: number; readonly month: number; readonly day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`Invalid service date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
    throw new RangeError(`Invalid service date: ${value}`);
  }
  return { year, month, day };
}

function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

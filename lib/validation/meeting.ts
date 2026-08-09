import {
  DEFAULT_TOLERANCE_PERCENT,
  MEETING_TIME_ZONE,
  TOLERANCE_PERCENT_OPTIONS,
} from "../domain/types.ts";
import { isWithinOfficialMunichBoundary } from "../domain/boundary.ts";
import type {
  MeetingCalculationInput,
  MeetingLocation,
  MeetingParticipant,
  TolerancePercent,
} from "../domain/types.ts";

export interface ValidationIssue {
  path: Array<string | number>;
  code: string;
  message: string;
}

export type ValidationResult =
  | { success: true; data: MeetingCalculationInput }
  | { success: false; issues: readonly ValidationIssue[] };

const ROOT_KEYS = ["participants", "arrivalAt", "tolerancePercent"] as const;
const PARTICIPANT_KEYS = ["id", "location", "mode"] as const;
const LOCATION_KEYS = ["label", "latitude", "longitude"] as const;

/** Parse the canonical request. Missing arrivalAt is rejected deliberately. */
export function parseMeetingCalculationInput(
  input: unknown,
  now = new Date(),
): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return { success: false, issues: [issue([], "invalid_type", "Request body must be a JSON object.")] };
  }

  addUnknownKeyIssues(input, ROOT_KEYS, [], issues);
  const tolerancePercent = parseTolerance(input.tolerancePercent, issues);
  const arrivalAt = parseArrivalAt(input.arrivalAt, now, issues);

  const values = input.participants;
  if (!Array.isArray(values)) {
    issues.push(issue(["participants"], "invalid_type", "participants must contain exactly 2 participants."));
  } else if (values.length !== 2) {
    issues.push(issue(["participants"], "invalid_length", "participants must contain exactly 2 participants."));
  }

  const participants: MeetingParticipant[] = [];
  if (Array.isArray(values)) {
    values.forEach((value, index) => {
      const participant = parseParticipant(value, index, issues);
      if (participant) participants.push(participant);
    });
  }

  const ids = new Set<string>();
  participants.forEach((participant, index) => {
    if (ids.has(participant.id)) {
      issues.push(issue(["participants", index, "id"], "duplicate", "Participant ids must be unique."));
    }
    ids.add(participant.id);
  });

  if (issues.length > 0 || participants.length !== 2 || !arrivalAt) {
    return { success: false, issues };
  }
  return {
    success: true,
    data: {
      participants: [participants[0], participants[1]],
      tolerancePercent,
      arrivalAt,
    },
  };
}

function parseParticipant(
  value: unknown,
  index: number,
  issues: ValidationIssue[],
): MeetingParticipant | undefined {
  const path = ["participants", index] as Array<string | number>;
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Participant must be an object."));
    return undefined;
  }
  addUnknownKeyIssues(value, PARTICIPANT_KEYS, path, issues);
  const id = parseId(value.id, path, index, issues);
  const location = parseLocation(value.location, path, issues);
  if (value.mode !== "transit") {
    issues.push(issue(path.concat("mode"), "invalid_enum", "mode must be transit."));
  }
  if (!id || !location || value.mode !== "transit") return undefined;
  return { id, location, mode: "transit" };
}

function parseId(
  value: unknown,
  path: Array<string | number>,
  index: number,
  issues: ValidationIssue[],
): string | undefined {
  if (value === undefined) return `participant-${index + 1}`;
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(issue(path.concat("id"), "invalid_type", "id must be a non-empty string."));
    return undefined;
  }
  const id = value.trim();
  if (id.length > 64) {
    issues.push(issue(path.concat("id"), "too_long", "id must be at most 64 characters."));
    return undefined;
  }
  return id;
}

function parseLocation(
  value: unknown,
  path: Array<string | number>,
  issues: ValidationIssue[],
): MeetingLocation | undefined {
  const locationPath = path.concat("location");
  if (!isRecord(value)) {
    issues.push(issue(locationPath, "invalid_type", "location must be an object."));
    return undefined;
  }
  addUnknownKeyIssues(value, LOCATION_KEYS, locationPath, issues);
  const label = value.label;
  if (typeof label !== "string" || label.trim().length === 0) {
    issues.push(issue(locationPath.concat("label"), "invalid_type", "location.label must be a non-empty string."));
  } else if (label.trim().length > 120) {
    issues.push(issue(locationPath.concat("label"), "too_long", "location.label must be at most 120 characters."));
  }
  const latitude = parseCoordinate(value.latitude, "latitude", locationPath, issues);
  const longitude = parseCoordinate(value.longitude, "longitude", locationPath, issues);
  if (
    typeof label !== "string" || label.trim().length === 0 || label.trim().length > 120 ||
    latitude === undefined || longitude === undefined
  ) return undefined;

  const location = { label: label.trim(), latitude, longitude };
  if (!isWithinOfficialMunichBoundary(location)) {
    issues.push(issue(locationPath, "outside_official_munich_boundary", "Location must be inside the official Munich application boundary used for application coverage."));
    return undefined;
  }
  return location;
}

function parseCoordinate(
  value: unknown,
  field: "latitude" | "longitude",
  path: Array<string | number>,
  issues: ValidationIssue[],
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(issue(path.concat(field), "invalid_type", `location.${field} must be a finite number.`));
    return undefined;
  }
  const valid = field === "latitude" ? value >= -90 && value <= 90 : value >= -180 && value <= 180;
  if (!valid) {
    issues.push(issue(path.concat(field), "out_of_range", `location.${field} is outside its valid geographic range.`));
    return undefined;
  }
  return value;
}

function parseTolerance(value: unknown, issues: ValidationIssue[]): TolerancePercent {
  if (value === undefined) return DEFAULT_TOLERANCE_PERCENT;
  if (typeof value !== "number" || !(TOLERANCE_PERCENT_OPTIONS as readonly number[]).includes(value)) {
    issues.push(issue(["tolerancePercent"], "invalid_enum", "tolerancePercent must be one of 5, 10, or 15 percent."));
    return 10 as TolerancePercent;
  }
  return value as TolerancePercent;
}

function parseArrivalAt(value: unknown, now: Date, issues: ValidationIssue[]): string | undefined {
  if (value === undefined) {
    issues.push(issue(["arrivalAt"], "required", "arrivalAt is required; the client supplies the default arrival time."));
    return undefined;
  }
  if (typeof value !== "string") {
    issues.push(issue(["arrivalAt"], "invalid_type", "arrivalAt must be an ISO 8601 instant with a timezone offset or Z."));
    return undefined;
  }
  const instant = parseIsoInstant(value);
  const nowMs = now.getTime();
  if (!instant || !Number.isFinite(nowMs)) {
    issues.push(issue(["arrivalAt"], "invalid_datetime", `arrivalAt must be a valid ISO 8601 instant; calculations use ${MEETING_TIME_ZONE}.`));
    return undefined;
  }
  const timestamp = instant.getTime();
  const endOfFollowingDay = berlinEndOfFollowingCalendarDay(now);
  if (timestamp < nowMs || timestamp > endOfFollowingDay) {
    issues.push(issue(["arrivalAt"], "outside_planning_window", "arrivalAt must be from now through the end of the following Europe/Berlin calendar day."));
    return undefined;
  }
  return instant.toISOString();
}

function parseIsoInstant(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return undefined;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) ? instant : undefined;
}

function berlinEndOfFollowingCalendarDay(now: Date): number {
  const current = berlinParts(now);
  const nextDate = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  const wall = {
    year: nextDate.getUTCFullYear(),
    month: nextDate.getUTCMonth() + 1,
    day: nextDate.getUTCDate(),
    hour: 23,
    minute: 59,
    second: 59,
    millisecond: 999,
  };
  let guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.millisecond);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.millisecond) - berlinOffsetMinutes(new Date(guess)) * 60_000;
  }
  return guess;
}

function berlinParts(value: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: MEETING_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value),
  };
}

function berlinOffsetMinutes(value: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: MEETING_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(value);
  const localAsUtc = Date.UTC(
    Number(parts.find((part) => part.type === "year")?.value),
    Number(parts.find((part) => part.type === "month")?.value) - 1,
    Number(parts.find((part) => part.type === "day")?.value),
    Number(parts.find((part) => part.type === "hour")?.value),
    Number(parts.find((part) => part.type === "minute")?.value),
    Number(parts.find((part) => part.type === "second")?.value),
  );
  return (localAsUtc - value.getTime()) / 60_000;
}

function addUnknownKeyIssues(value: Record<string, unknown>, allowed: readonly string[], path: Array<string | number>, issues: ValidationIssue[]): void {
  Object.keys(value).forEach((key) => {
    if (!allowed.includes(key)) issues.push(issue(path.concat(key), "unknown_key", `Unknown field ${key} is not allowed.`));
  });
}

function issue(path: Array<string | number>, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

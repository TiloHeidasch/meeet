import {
  DEFAULT_TOLERANCE_PERCENT,
  MEETING_TIME_ZONE,
  TOLERANCE_PERCENT_OPTIONS,
  TRAVEL_MODES,
} from "../domain/types.ts";
import { isWithinOfficialMunichBoundary } from "../domain/boundary.ts";
import type {
  MeetingCalculationInput,
  MeetingLocation,
  MeetingParticipant,
  TolerancePercent,
  TravelMode,
} from "../domain/types.ts";

export interface ValidationIssue {
  path: Array<string | number>;
  code: string;
  message: string;
}

export type ValidationResult =
  | { success: true; data: MeetingCalculationInput }
  | { success: false; issues: readonly ValidationIssue[] };

const ROOT_KEYS = [
  "participants",
  "tolerancePercent",
  "tolerance",
  "departureAt",
] as const;
const PARTICIPANT_KEYS = ["id", "location", "mode"] as const;
const LOCATION_KEYS = ["label", "latitude", "longitude"] as const;

export function parseMeetingCalculationInput(
  input: unknown,
  now = new Date(),
): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return {
      success: false,
      issues: [
        issue([], "invalid_type", "Request body must be a JSON object."),
      ],
    };
  }

  addUnknownKeyIssues(input, ROOT_KEYS, [], issues);

  const tolerancePercent = parseTolerance(input, issues);
  const departureAt = parseDepartureAt(input.departureAt, now, issues);
  const participantsValue = input.participants;
  if (!Array.isArray(participantsValue)) {
    issues.push(
      issue(
        ["participants"],
        "invalid_type",
        "participants must be an array containing 2 to 4 participants.",
      ),
    );
  } else {
    if (participantsValue.length < 2 || participantsValue.length > 4) {
      issues.push(
        issue(
          ["participants"],
          "invalid_length",
          "participants must contain between 2 and 4 participants.",
        ),
      );
    }
  }

  const participants: MeetingParticipant[] = [];
  if (Array.isArray(participantsValue)) {
    participantsValue.forEach((participantValue, index) => {
      const participant = parseParticipant(participantValue, index, issues);
      if (participant) {
        participants.push(participant);
      }
    });
  }

  const ids = new Set<string>();
  participants.forEach((participant, index) => {
    if (ids.has(participant.id)) {
      issues.push(
        issue(
          ["participants", index, "id"],
          "duplicate",
          "Participant ids must be unique.",
        ),
      );
    }
    ids.add(participant.id);
  });

  if (issues.length > 0) {
    return { success: false, issues };
  }

  return {
    success: true,
    data: { participants, tolerancePercent, departureAt },
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
  const mode = parseMode(value.mode, path, issues);
  if (!id || !location || !mode) {
    return undefined;
  }

  return { id, location, mode };
}

function parseId(
  value: unknown,
  path: Array<string | number>,
  index: number,
  issues: ValidationIssue[],
): string | undefined {
  if (value === undefined) {
    return `participant-${index + 1}`;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(
      issue(
        path.concat("id"),
        "invalid_type",
        "id must be a non-empty string.",
      ),
    );
    return undefined;
  }
  const id = value.trim();
  if (id.length > 64) {
    issues.push(
      issue(
        path.concat("id"),
        "too_long",
        "id must be at most 64 characters.",
      ),
    );
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
    issues.push(
      issue(locationPath, "invalid_type", "location must be an object."),
    );
    return undefined;
  }

  addUnknownKeyIssues(value, LOCATION_KEYS, locationPath, issues);
  const label = value.label;
  if (typeof label !== "string" || label.trim().length === 0) {
    issues.push(
      issue(
        locationPath.concat("label"),
        "invalid_type",
        "location.label must be a non-empty string.",
      ),
    );
  } else if (label.trim().length > 120) {
    issues.push(
      issue(
        locationPath.concat("label"),
        "too_long",
        "location.label must be at most 120 characters.",
      ),
    );
  }

  const latitude = parseCoordinate(value.latitude, "latitude", locationPath, issues);
  const longitude = parseCoordinate(value.longitude, "longitude", locationPath, issues);
  if (
    typeof label !== "string" ||
    label.trim().length === 0 ||
    label.trim().length > 120 ||
    latitude === undefined ||
    longitude === undefined
  ) {
    return undefined;
  }

  const location = { label: label.trim(), latitude, longitude };
  if (!isWithinOfficialMunichBoundary(location)) {
    issues.push(
      issue(
        locationPath,
        "outside_official_munich_boundary",
        "Location must be inside the official Munich district boundary used for application coverage.",
      ),
    );
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
    issues.push(
      issue(
        path.concat(field),
        "invalid_type",
        `location.${field} must be a finite number.`,
      ),
    );
    return undefined;
  }

  const validRange =
    field === "latitude" ? value >= -90 && value <= 90 : value >= -180 && value <= 180;
  if (!validRange) {
    issues.push(
      issue(
        path.concat(field),
        "out_of_range",
        `location.${field} is outside its valid geographic range.`,
      ),
    );
    return undefined;
  }
  return value;
}

function parseMode(
  value: unknown,
  path: Array<string | number>,
  issues: ValidationIssue[],
): TravelMode | undefined {
  if (typeof value !== "string" || !isTravelMode(value)) {
    issues.push(
      issue(
        path.concat("mode"),
        "invalid_enum",
        `mode must be one of: ${TRAVEL_MODES.join(", ")}.`,
      ),
    );
    return undefined;
  }
  return value;
}

function parseTolerance(
  input: Record<string, unknown>,
  issues: ValidationIssue[],
): TolerancePercent {
  const hasTolerancePercent = Object.prototype.hasOwnProperty.call(
    input,
    "tolerancePercent",
  );
  const hasTolerance = Object.prototype.hasOwnProperty.call(input, "tolerance");
  if (hasTolerancePercent && hasTolerance) {
    issues.push(
      issue(
        [],
        "ambiguous",
        "Use either tolerancePercent or tolerance, not both.",
      ),
    );
    return DEFAULT_TOLERANCE_PERCENT;
  }

  const value = hasTolerancePercent
    ? input.tolerancePercent
    : hasTolerance
      ? input.tolerance
      : DEFAULT_TOLERANCE_PERCENT;
  if (typeof value !== "number" || !isTolerancePercent(value)) {
    issues.push(
      issue(
        [hasTolerancePercent ? "tolerancePercent" : "tolerance"],
        "invalid_enum",
        "tolerance must be one of 5, 10, or 15 percent.",
      ),
    );
    return DEFAULT_TOLERANCE_PERCENT;
  }
  return value;
}

function parseDepartureAt(
  value: unknown,
  now: Date,
  issues: ValidationIssue[],
): string {
  if (value === undefined) {
    return now.toISOString();
  }

  if (typeof value !== "string") {
    issues.push(
      issue(
        ["departureAt"],
        "invalid_type",
        "departureAt must be an ISO 8601 instant with a timezone offset or Z.",
      ),
    );
    return now.toISOString();
  }

  const instant = parseIsoInstant(value);
  if (!instant) {
    issues.push(
      issue(
        ["departureAt"],
        "invalid_datetime",
        `departureAt must be a valid ISO 8601 instant; calculations use ${MEETING_TIME_ZONE}.`,
      ),
    );
    return now.toISOString();
  }
  return instant.toISOString();
}

function parseIsoInstant(value: string): Date | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(
      value,
    );
  if (!match) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }

  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) ? instant : undefined;
}

function addUnknownKeyIssues(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: Array<string | number>,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      issues.push(
        issue(
          path.concat(key),
          "unknown_key",
          `Unknown field ${key} is not allowed.`,
        ),
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTravelMode(value: string): value is TravelMode {
  return (TRAVEL_MODES as readonly string[]).includes(value);
}

function isTolerancePercent(value: number): value is TolerancePercent {
  return (TOLERANCE_PERCENT_OPTIONS as readonly number[]).includes(value);
}

function issue(
  path: Array<string | number>,
  code: string,
  message: string,
): ValidationIssue {
  return { path, code, message };
}

import { TRAVEL_MODES } from "./types.ts";
import type {
  GeoJsonLineString,
  SelectedVenueRouteResponse,
} from "./types.ts";

export const MAX_VENUE_ROUTE_RESPONSE_BYTES = 512 * 1024;
export const MAX_VENUE_ROUTE_LEGS = 4;
export const MAX_VENUE_ROUTE_STEPS = 100;
export const MAX_VENUE_ROUTE_STRING_LENGTH = 512;

export interface VenueRouteResponseValidationIssue {
  path: Array<string | number>;
  code: string;
  message: string;
}

export type SafeSelectedVenueRouteResponse =
  | { success: true; data: SelectedVenueRouteResponse }
  | { success: false; issues: readonly VenueRouteResponseValidationIssue[] };

export function validateSelectedVenueRouteResponse(
  value: unknown,
): SafeSelectedVenueRouteResponse {
  const issues: VenueRouteResponseValidationIssue[] = [];
  if (!isRecord(value)) {
    return invalid(issue([], "invalid_type", "Venue route response must be an object."));
  }

  try {
    const serialized = JSON.stringify(value);
    if (
      !serialized ||
      new TextEncoder().encode(serialized).byteLength > MAX_VENUE_ROUTE_RESPONSE_BYTES
    ) {
      return invalid(issue([], "too_large", "Venue route response exceeds the client size limit."));
    }
  } catch {
    return invalid(issue([], "invalid_json", "Venue route response is not serializable JSON."));
  }

  requireKeys(value, ["contractVersion", "status", "departureAt", "venue", "legs"], [], issues);
  if (value.contractVersion !== "meeet-venue-routes/v1") {
    issues.push(issue(["contractVersion"], "invalid_value", "Unknown venue route contract version."));
  }
  if (value.status !== "ok") {
    issues.push(issue(["status"], "invalid_discriminator", "Venue route status must be ok."));
  }
  validateIsoInstant(value.departureAt, ["departureAt"], issues);
  validateVenue(value.venue, ["venue"], issues);

  if (!Array.isArray(value.legs) ||
    value.legs.length < 2 ||
    value.legs.length > MAX_VENUE_ROUTE_LEGS) {
    issues.push(issue(["legs"], "invalid_length", "legs must contain 2 to 4 entries."));
  } else {
    const participantIds = new Set<string>();
    let stepCount = 0;
    value.legs.forEach((leg, index) => {
      const path = ["legs", index] as Array<string | number>;
      if (!isRecord(leg)) {
        issues.push(issue(path, "invalid_type", "Venue route leg must be an object."));
        return;
      }
      requireKeys(
        leg,
        ["participantId", "mode", "status", "summary", "durationMinutes", "steps", "geometry", "source"],
        path,
        issues,
      );
      validateString(leg.participantId, path.concat("participantId"), issues, 1);
      if (typeof leg.participantId === "string") {
        if (participantIds.has(leg.participantId)) {
          issues.push(issue(path.concat("participantId"), "duplicate", "Leg participant ids must be unique."));
        }
        participantIds.add(leg.participantId);
      }
      if (!(TRAVEL_MODES as readonly unknown[]).includes(leg.mode)) {
        issues.push(issue(path.concat("mode"), "invalid_value", "Unknown travel mode."));
      }
      if (leg.status !== "detailed" && leg.status !== "summary") {
        issues.push(issue(path.concat("status"), "invalid_value", "Unknown venue route leg status."));
      }
      validateString(leg.summary, path.concat("summary"), issues, 1);
      validateDuration(leg.durationMinutes, path.concat("durationMinutes"), issues);
      if (!Array.isArray(leg.steps) || leg.steps.length < 1 || leg.steps.length > MAX_VENUE_ROUTE_STEPS) {
        issues.push(issue(path.concat("steps"), "invalid_length", "A venue route must contain 1 to 100 steps."));
      } else {
        stepCount += leg.steps.length;
        leg.steps.forEach((step, stepIndex) => validateStep(step, path.concat("steps", stepIndex), issues));
      }
      validateGeometry(leg.geometry, path.concat("geometry"), issues);
      validateString(leg.source, path.concat("source"), issues, 1);
      if (leg.status === "summary" && leg.geometry !== null) {
        issues.push(issue(path.concat("geometry"), "invalid_value", "Summary legs must not include route geometry."));
      }
      if (leg.status === "summary" && Array.isArray(leg.steps) &&
        (leg.steps.length !== 1 || leg.steps[0]?.kind !== "summary")) {
        issues.push(issue(path.concat("steps"), "invalid_value", "Summary legs must contain one summary step."));
      }
      if (leg.status === "detailed" && Array.isArray(leg.steps) &&
        leg.steps.some((step) => !isRecord(step) || step.kind !== "transit")) {
        issues.push(issue(path.concat("steps"), "invalid_value", "Detailed legs must contain transit steps."));
      }
    });
    if (stepCount > MAX_VENUE_ROUTE_STEPS) {
      issues.push(issue(["legs"], "too_large", "Venue route response contains too many steps."));
    }
  }

  return issues.length > 0
    ? { success: false, issues }
    : { success: true, data: value as unknown as SelectedVenueRouteResponse };
}

export function parseSelectedVenueRouteResponse(
  value: unknown,
): SelectedVenueRouteResponse | null {
  const result = validateSelectedVenueRouteResponse(value);
  return result.success ? result.data : null;
}

export function assertSelectedVenueRouteResponse(
  value: unknown,
): SelectedVenueRouteResponse {
  const result = validateSelectedVenueRouteResponse(value);
  if (!result.success) {
    throw new Error("The selected venue route response failed its DTO validation.");
  }
  return result.data;
}

function validateVenue(
  value: unknown,
  path: Array<string | number>,
  issues: VenueRouteResponseValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "venue must be an object."));
    return;
  }
  requireKeys(value, ["id", "name", "coordinates"], path, issues, ["category", "address", "source"]);
  validateString(value.id, path.concat("id"), issues, 1);
  validateString(value.name, path.concat("name"), issues, 1);
  validatePosition(value.coordinates, path.concat("coordinates"), issues);
  if (value.category !== undefined && value.category !== "food" && value.category !== "drink") {
    issues.push(issue(path.concat("category"), "invalid_value", "Venue category must be food or drink."));
  }
  if (value.address !== undefined) validateString(value.address, path.concat("address"), issues, 0);
  if (value.source !== undefined) validateString(value.source, path.concat("source"), issues, 1);
}

function validateStep(
  value: unknown,
  path: Array<string | number>,
  issues: VenueRouteResponseValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Venue route step must be an object."));
    return;
  }
  requireKeys(
    value,
    ["kind", "instruction", "from", "to", "fromStopId", "toStopId", "line", "departureAt", "arrivalAt", "durationMinutes"],
    path,
    issues,
  );
  if (value.kind !== "transit" && value.kind !== "summary") {
    issues.push(issue(path.concat("kind"), "invalid_value", "Unknown venue route step kind."));
  }
  validateString(value.instruction, path.concat("instruction"), issues, 1);
  validateCoordinateOrNull(value.from, path.concat("from"), issues);
  validateCoordinateOrNull(value.to, path.concat("to"), issues);
  validateStringOrNull(value.fromStopId, path.concat("fromStopId"), issues);
  validateStringOrNull(value.toStopId, path.concat("toStopId"), issues);
  validateLineOrNull(value.line, path.concat("line"), issues);
  validateIsoInstantOrNull(value.departureAt, path.concat("departureAt"), issues);
  validateIsoInstantOrNull(value.arrivalAt, path.concat("arrivalAt"), issues);
  validateDuration(value.durationMinutes, path.concat("durationMinutes"), issues);
  if (value.kind === "summary" && (value.line !== null || value.fromStopId !== null || value.toStopId !== null)) {
    issues.push(issue(path, "invalid_value", "Summary steps must not contain transit stop or line data."));
  }
  if (value.kind === "transit" && (value.line === null || value.fromStopId === null || value.toStopId === null)) {
    issues.push(issue(path, "invalid_value", "Transit steps must contain line and stop data."));
  }
}

function validateGeometry(
  value: unknown,
  path: Array<string | number>,
  issues: VenueRouteResponseValidationIssue[],
): value is GeoJsonLineString | null {
  if (value === null) return true;
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Route geometry must be null or a LineString."));
    return false;
  }
  requireKeys(value, ["type", "coordinates"], path, issues);
  if (value.type !== "LineString") {
    issues.push(issue(path.concat("type"), "invalid_value", "Route geometry must be a LineString."));
  }
  if (!Array.isArray(value.coordinates) || value.coordinates.length < 2) {
    issues.push(issue(path.concat("coordinates"), "invalid_length", "A LineString must contain at least two positions."));
  } else {
    value.coordinates.forEach((position, index) => validatePosition(position, path.concat("coordinates", index), issues));
  }
  return true;
}

function validatePosition(
  value: unknown,
  path: Array<string | number>,
  issues: VenueRouteResponseValidationIssue[],
): void {
  if (!Array.isArray(value) || value.length !== 2 ||
    typeof value[0] !== "number" || !Number.isFinite(value[0]) || value[0] < -180 || value[0] > 180 ||
    typeof value[1] !== "number" || !Number.isFinite(value[1]) || value[1] < -90 || value[1] > 90) {
    issues.push(issue(path, "invalid_coordinate", "Coordinates must be finite [longitude, latitude] WGS84 positions."));
  }
}

function validateCoordinateOrNull(
  value: unknown,
  path: Array<string | number>,
  issues: VenueRouteResponseValidationIssue[],
): void {
  if (value === null) return;
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Step coordinate must be an object or null."));
    return;
  }
  requireKeys(value, ["latitude", "longitude"], path, issues);
  if (typeof value.latitude !== "number" || !Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90 ||
    typeof value.longitude !== "number" || !Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180) {
    issues.push(issue(path, "invalid_coordinate", "Step coordinate must be finite WGS84 values."));
  }
}

function validateLineOrNull(
  value: unknown,
  path: Array<string | number>,
  issues: VenueRouteResponseValidationIssue[],
): void {
  if (value === null) return;
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Transit line must be an object or null."));
    return;
  }
  requireKeys(value, ["identity", "type"], path, issues);
  validateString(value.identity, path.concat("identity"), issues, 1);
  validateString(value.type, path.concat("type"), issues, 1);
}

function validateDuration(
  value: unknown,
  path: Array<string | number>,
  issues: VenueRouteResponseValidationIssue[],
): void {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 24 * 60)) {
    issues.push(issue(path, "invalid_number", "Duration must be null or a finite number from 0 to 1440."));
  }
}

function validateStringOrNull(
  value: unknown,
  path: Array<string | number>,
  issues: VenueRouteResponseValidationIssue[],
): void {
  if (value !== null) validateString(value, path, issues, 1);
}

function validateIsoInstantOrNull(
  value: unknown,
  path: Array<string | number>,
  issues: VenueRouteResponseValidationIssue[],
): void {
  if (value !== null) validateIsoInstant(value, path, issues);
}

function validateIsoInstant(
  value: unknown,
  path: Array<string | number>,
  issues: VenueRouteResponseValidationIssue[],
): void {
  if (typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(new Date(value).getTime())) {
    issues.push(issue(path, "invalid_datetime", "Timestamp must be a canonical UTC ISO instant."));
  }
}

function validateString(
  value: unknown,
  path: Array<string | number>,
  issues: VenueRouteResponseValidationIssue[],
  minimum: number,
): void {
  if (typeof value !== "string" || value.length < minimum || value.length > MAX_VENUE_ROUTE_STRING_LENGTH) {
    issues.push(issue(path, "invalid_string", "String is missing or outside the allowed size."));
  }
}

function requireKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  path: Array<string | number>,
  issues: VenueRouteResponseValidationIssue[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  required.forEach((key) => {
    if (!(key in value)) issues.push(issue(path.concat(key), "missing_field", `Missing ${key}.`));
  });
  Object.keys(value).forEach((key) => {
    if (!allowed.has(key)) issues.push(issue(path.concat(key), "unknown_field", `Unknown field ${key}.`));
  });
}

function issue(
  path: Array<string | number>,
  code: string,
  message: string,
): VenueRouteResponseValidationIssue {
  return { path, code, message };
}

function invalid(singleIssue: VenueRouteResponseValidationIssue): SafeSelectedVenueRouteResponse {
  return { success: false, issues: [singleIssue] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import {
  MEETING_TIME_ZONE,
  TOLERANCE_PERCENT_OPTIONS,
  TRAVEL_MODES,
} from "./types.ts";
import type {
  GeoJsonGeometry,
  MeetingCalculationResponse,
  MeetingParticipant,
} from "./types.ts";

export const MAX_CALCULATION_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_CORRIDOR_POLYGONS = 256;
export const MAX_CORRIDOR_POSITIONS = 20_000;
export const MAX_POIS = 100;
export const MAX_STRING_LENGTH = 512;
const DIRECT_MVG_PROVIDER = "mvg-direct-routing";
const DIRECT_MVG_SOURCE_URL = "https://www.mvg.de/api/bgw-pt/v3";

export interface ResponseValidationIssue {
  path: Array<string | number>;
  code: string;
  message: string;
}

export type SafeMeetingResponse =
  | { success: true; data: MeetingCalculationResponse }
  | { success: false; issues: readonly ResponseValidationIssue[] };

export function validateMeetingCalculationResponse(
  value: unknown,
): SafeMeetingResponse {
  const issues: ResponseValidationIssue[] = [];
  if (!isRecord(value)) {
    return invalid(issue([], "invalid_type", "Calculation response must be an object."));
  }
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || new TextEncoder().encode(serialized).byteLength > MAX_CALCULATION_RESPONSE_BYTES) {
      issues.push(
        issue([], "too_large", "Calculation response exceeds the client response-size limit."),
      );
      return { success: false, issues };
    }
  } catch {
    return invalid(issue([], "invalid_json", "Calculation response is not serializable JSON."));
  }

  if (value.status === "ok") {
    validateOkResponse(value, issues);
  } else if (value.status === "no-corridor") {
    validateNoCorridorResponse(value, issues);
  } else {
    issues.push(issue(["status"], "invalid_discriminator", "status must be ok or no-corridor."));
  }
  return issues.length > 0
    ? { success: false, issues }
    : { success: true, data: value as unknown as MeetingCalculationResponse };
}

export function parseMeetingCalculationResponse(
  value: unknown,
): MeetingCalculationResponse | null {
  const result = validateMeetingCalculationResponse(value);
  return result.success ? result.data : null;
}

export function assertMeetingCalculationResponse(
  value: unknown,
): MeetingCalculationResponse {
  const result = validateMeetingCalculationResponse(value);
  if (!result.success) {
    throw new Error("The calculation response failed its DTO validation.");
  }
  return result.data;
}

function validateOkResponse(
  value: Record<string, unknown>,
  issues: ResponseValidationIssue[],
): void {
  requireKeys(
    value,
    [
      "status",
      "meetingPoint",
      "corridor",
      "travelTimeRange",
      "travelTimes",
      "pois",
      "requestSnapshot",
      "metadata",
    ],
    [],
    issues,
  );
  validateCoordinate(value.meetingPoint, ["meetingPoint"], issues);
  validateCorridor(value.corridor, ["corridor"], issues);
  validateTravelTimeRange(value.travelTimeRange, ["travelTimeRange"], issues);
  validateTravelTimes(value.travelTimes, value.requestSnapshot, issues);
  validatePois(value.pois, ["pois"], issues);
  validateSnapshot(value.requestSnapshot, ["requestSnapshot"], issues);
  validateMetadata(value.metadata, ["metadata"], issues);
}

function validateNoCorridorResponse(
  value: Record<string, unknown>,
  issues: ResponseValidationIssue[],
): void {
  requireKeys(value, ["status", "reason", "requestSnapshot", "metadata"], [], issues);
  if (!isRecord(value.reason)) {
    issues.push(issue(["reason"], "invalid_type", "reason must be an object."));
  } else {
    requireKeys(value.reason, ["code", "message"], ["reason"], issues);
    if (value.reason.code !== "NO_COMPARABLE_GRID_CELL") {
      issues.push(issue(["reason", "code"], "invalid_value", "Unknown no-corridor reason."));
    }
    validateString(value.reason.message, ["reason", "message"], issues, 1);
  }
  validateSnapshot(value.requestSnapshot, ["requestSnapshot"], issues);
  validateMetadata(value.metadata, ["metadata"], issues);
}

function validateSnapshot(
  value: unknown,
  path: Array<string | number>,
  issues: ResponseValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "requestSnapshot must be an object."));
    return;
  }
  requireKeys(value, ["participants", "tolerancePercent", "departureAt", "timeZone"], path, issues);
  if (!Array.isArray(value.participants) || value.participants.length < 2 || value.participants.length > 4) {
    issues.push(issue(path.concat("participants"), "invalid_length", "Snapshot must contain 2 to 4 participants."));
  } else {
    const ids = new Set<string>();
    value.participants.forEach((participant, index) => {
      const parsed = validateParticipant(participant, path.concat("participants", index), issues);
      if (parsed) {
        if (ids.has(parsed.id)) {
          issues.push(issue(path.concat("participants", index, "id"), "duplicate", "Participant ids must be unique."));
        }
        ids.add(parsed.id);
      }
    });
  }
  validateTolerance(value.tolerancePercent, path.concat("tolerancePercent"), issues);
  validateIsoInstant(value.departureAt, path.concat("departureAt"), issues);
  if (value.timeZone !== MEETING_TIME_ZONE) {
    issues.push(issue(path.concat("timeZone"), "invalid_value", "Only Europe/Berlin is supported."));
  }
}

function validateParticipant(
  value: unknown,
  path: Array<string | number>,
  issues: ResponseValidationIssue[],
): MeetingParticipant | null {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Participant must be an object."));
    return null;
  }
  requireKeys(value, ["id", "location", "mode"], path, issues);
  validateString(value.id, path.concat("id"), issues, 1);
  if (!isRecord(value.location)) {
    issues.push(issue(path.concat("location"), "invalid_type", "Participant location must be an object."));
  } else {
    requireKeys(value.location, ["label", "latitude", "longitude"], path.concat("location"), issues);
    validateString(value.location.label, path.concat("location", "label"), issues, 1);
    validateWgs84(value.location.latitude, value.location.longitude, path.concat("location"), issues);
  }
  if (!isTravelMode(value.mode)) {
    issues.push(issue(path.concat("mode"), "invalid_value", "Unknown travel mode."));
  }
  if (
    typeof value.id !== "string" ||
    !isRecord(value.location) ||
    typeof value.location.label !== "string" ||
    typeof value.location.latitude !== "number" ||
    typeof value.location.longitude !== "number" ||
    !isTravelMode(value.mode)
  ) {
    return null;
  }
  return {
    id: value.id,
    location: {
      label: value.location.label,
      latitude: value.location.latitude,
      longitude: value.location.longitude,
    },
    mode: value.mode,
  };
}

function validateCorridor(
  value: unknown,
  path: Array<string | number>,
  issues: ResponseValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "corridor must be a GeoJSON Feature."));
    return;
  }
  requireKeys(value, ["type", "properties", "geometry"], path, issues);
  if (value.type !== "Feature") {
    issues.push(issue(path.concat("type"), "invalid_value", "corridor must be a Feature."));
  }
  if (!isRecord(value.properties)) {
    issues.push(issue(path.concat("properties"), "invalid_type", "corridor properties are required."));
  } else {
    requireKeys(
      value.properties,
      [
        "kind",
        "approximation",
        "verification",
        "tolerancePercent",
        "cellCount",
        "gridColumns",
        "gridRows",
        "boundaryName",
        "geometryGuarantee",
      ],
      path.concat("properties"),
      issues,
    );
    if (value.properties.kind !== "sample-grid-corridor") {
      issues.push(issue(path.concat("properties", "kind"), "invalid_value", "Unsupported corridor kind."));
    }
    if (value.properties.approximation !== "sample-grid") {
      issues.push(issue(path.concat("properties", "approximation"), "invalid_value", "Corridor must declare sample-grid approximation."));
    }
    if (value.properties.verification !== "center-and-clipped-vertices") {
      issues.push(issue(path.concat("properties", "verification"), "invalid_value", "Corridor sample verification metadata is missing."));
    }
    validateTolerance(value.properties.tolerancePercent, path.concat("properties", "tolerancePercent"), issues);
    validateBoundedInteger(value.properties.cellCount, path.concat("properties", "cellCount"), issues, 1, MAX_CORRIDOR_POLYGONS);
    validateBoundedInteger(value.properties.gridColumns, path.concat("properties", "gridColumns"), issues, 1, 64);
    validateBoundedInteger(value.properties.gridRows, path.concat("properties", "gridRows"), issues, 1, 64);
    validateString(value.properties.boundaryName, path.concat("properties", "boundaryName"), issues, 1);
    validateString(value.properties.geometryGuarantee, path.concat("properties", "geometryGuarantee"), issues, 1);
    if (!String(value.properties.geometryGuarantee).includes("not independently routed")) {
      issues.push(issue(path.concat("properties", "geometryGuarantee"), "missing_caveat", "Corridor must declare the unverified-interior caveat."));
    }
  }
  const geometry = validateGeometry(value.geometry, path.concat("geometry"), issues);
  if (!geometry || geometry.type !== "MultiPolygon") {
    issues.push(issue(path.concat("geometry"), "invalid_value", "Corridor geometry must be a non-empty MultiPolygon."));
  }
}

function validateGeometry(
  value: unknown,
  path: Array<string | number>,
  issues: ResponseValidationIssue[],
): GeoJsonGeometry | null {
  if (!isRecord(value) || (value.type !== "Polygon" && value.type !== "MultiPolygon")) {
    issues.push(issue(path, "invalid_geometry", "Geometry must be Polygon or MultiPolygon."));
    return null;
  }
  const polygons = value.type === "Polygon" ? [value.coordinates] : value.coordinates;
  if (!Array.isArray(polygons) || polygons.length === 0 || polygons.length > MAX_CORRIDOR_POLYGONS) {
    issues.push(issue(path.concat("coordinates"), "invalid_length", "Geometry has an invalid polygon count."));
    return null;
  }
  let positionCount = 0;
  polygons.forEach((polygon, polygonIndex) => {
    if (!Array.isArray(polygon) || polygon.length === 0) {
      issues.push(issue(path.concat("coordinates", polygonIndex), "invalid_geometry", "Polygon must contain rings."));
      return;
    }
    polygon.forEach((ring, ringIndex) => {
      if (!Array.isArray(ring) || ring.length < 4 || !closedRing(ring)) {
        issues.push(issue(path.concat("coordinates", polygonIndex, ringIndex), "invalid_ring", "Rings must be closed and contain at least four positions."));
        return;
      }
      positionCount += ring.length;
      if (positionCount > MAX_CORRIDOR_POSITIONS) {
        issues.push(issue(path.concat("coordinates"), "too_large", "Geometry contains too many positions."));
      }
      ring.forEach((position, positionIndex) => validatePosition(position, path.concat("coordinates", polygonIndex, ringIndex, positionIndex), issues));
      if (ringArea(ring) <= 1e-12) {
        issues.push(issue(path.concat("coordinates", polygonIndex, ringIndex), "degenerate_ring", "Ring must have non-zero area."));
      }
    });
  });
  return value as unknown as GeoJsonGeometry;
}

function validatePosition(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!Array.isArray(value) || value.length !== 2 || !Number.isFinite(value[0]) || !Number.isFinite(value[1]) || value[0] < -180 || value[0] > 180 || value[1] < -90 || value[1] > 90) {
    issues.push(issue(path, "invalid_coordinate", "GeoJSON positions must be finite [longitude, latitude] WGS84 coordinates."));
  }
}

function validateTravelTimeRange(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "travelTimeRange must be an object."));
    return;
  }
  requireKeys(value, ["targetMinutes", "lowerMinutes", "upperMinutes", "observedMinMinutes", "observedMaxMinutes", "tolerancePercent", "isComparable"], path, issues);
  ["targetMinutes", "lowerMinutes", "upperMinutes", "observedMinMinutes", "observedMaxMinutes"].forEach((key) => validateFiniteBoundedNumber(value[key], path.concat(key), issues, 0, 24 * 60));
  validateTolerance(value.tolerancePercent, path.concat("tolerancePercent"), issues);
  if (typeof value.isComparable !== "boolean") issues.push(issue(path.concat("isComparable"), "invalid_type", "isComparable must be boolean."));
}

function validateTravelTimes(value: unknown, snapshot: unknown, issues: ResponseValidationIssue[]): void {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    issues.push(issue(["travelTimes"], "invalid_length", "travelTimes must contain 2 to 4 entries."));
    return;
  }
  const ids = new Set<string>();
  value.forEach((item, index) => {
    const path = ["travelTimes", index];
    if (!isRecord(item)) {
      issues.push(issue(path, "invalid_type", "Travel time must be an object."));
      return;
    }
    requireKeys(item, ["participantId", "mode", "minutes", "source"], path, issues);
    validateString(item.participantId, path.concat("participantId"), issues, 1);
    if (typeof item.participantId === "string") {
      if (ids.has(item.participantId)) issues.push(issue(path.concat("participantId"), "duplicate", "Travel-time participant ids must be unique."));
      ids.add(item.participantId);
    }
    if (!isTravelMode(item.mode)) issues.push(issue(path.concat("mode"), "invalid_value", "Unknown travel mode."));
    validateFiniteBoundedNumber(item.minutes, path.concat("minutes"), issues, 0, 24 * 60);
    validateString(item.source, path.concat("source"), issues, 1);
  });
  if (isRecord(snapshot) && Array.isArray(snapshot.participants)) {
    const expected = new Set(snapshot.participants.flatMap((participant) => isRecord(participant) && typeof participant.id === "string" ? [participant.id] : []));
    const expectedModes = new Map(snapshot.participants.flatMap((participant) => isRecord(participant) && typeof participant.id === "string" && isTravelMode(participant.mode) ? [[participant.id, participant.mode] as const] : []));
    if (value.length !== expected.size) issues.push(issue(["travelTimes"], "invalid_length", "Travel times must cover every snapshot participant exactly once."));
    ids.forEach((id) => {
      if (!expected.has(id)) issues.push(issue(["travelTimes"], "unknown_participant", "Travel time references an unknown participant."));
    });
    value.forEach((item, index) => {
      if (isRecord(item) && typeof item.participantId === "string" && expectedModes.get(item.participantId) !== item.mode) {
        issues.push(issue(["travelTimes", index, "mode"], "mismatched_mode", "Travel time mode does not match the request snapshot."));
      }
    });
  }
}

function validatePois(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!Array.isArray(value) || value.length > MAX_POIS) {
    issues.push(issue(path, "invalid_length", "POIs must be an array of at most 100 entries."));
    return;
  }
  const ids = new Set<string>();
  value.forEach((item, index) => {
    const itemPath = path.concat(index);
    if (!isRecord(item)) {
      issues.push(issue(itemPath, "invalid_type", "POI must be an object."));
      return;
    }
    requireKeys(item, ["id", "name", "category", "coordinates", "source"], itemPath, issues, ["address"]);
    validateString(item.id, itemPath.concat("id"), issues, 1);
    if (typeof item.id === "string") {
      if (ids.has(item.id)) issues.push(issue(itemPath.concat("id"), "duplicate", "POI ids must be unique."));
      ids.add(item.id);
    }
    validateString(item.name, itemPath.concat("name"), issues, 1);
    if (item.category !== "food" && item.category !== "drink") issues.push(issue(itemPath.concat("category"), "invalid_value", "POI category must be food or drink."));
    validatePosition(item.coordinates, itemPath.concat("coordinates"), issues);
    validateString(item.source, itemPath.concat("source"), issues, 1);
    if (item.address !== undefined) validateString(item.address, itemPath.concat("address"), issues, 0);
  });
}

function validateMetadata(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "metadata must be an object."));
    return;
  }
  requireKeys(value, ["source", "approximation", "providers", "boundary", "provenance"], path, issues);
  if (!isRecord(value.source)) issues.push(issue(path.concat("source"), "invalid_type", "metadata source is required."));
  else {
    requireKeys(value.source, ["deployment", "dataKind", "liveData", "label"], path.concat("source"), issues);
    validateString(value.source.deployment, path.concat("source", "deployment"), issues, 1);
    validateString(value.source.dataKind, path.concat("source", "dataKind"), issues, 1);
    if (!["fixture", "self-hosted", "managed", "unknown"].includes(String(value.source.deployment))) issues.push(issue(path.concat("source", "deployment"), "invalid_value", "Unknown provider deployment."));
    if (!["demo-static", "scheduled", "live", "unknown"].includes(String(value.source.dataKind))) issues.push(issue(path.concat("source", "dataKind"), "invalid_value", "Unknown provider data kind."));
    if (typeof value.source.liveData !== "boolean") issues.push(issue(path.concat("source", "liveData"), "invalid_type", "liveData must be boolean."));
    validateString(value.source.label, path.concat("source", "label"), issues, 1);
  }
  validateString(value.approximation, path.concat("approximation"), issues, 1);
  if (!String(value.approximation).includes("Sample-grid approximation")) issues.push(issue(path.concat("approximation"), "missing_caveat", "Metadata must describe sample-grid approximation."));
  if (!isRecord(value.providers)) issues.push(issue(path.concat("providers"), "invalid_type", "Provider descriptors are required."));
  else {
    validateProviderDescriptor(value.providers.geocoding, "geocoding", path.concat("providers", "geocoding"), issues);
    validateProviderDescriptor(value.providers.routing, "routing", path.concat("providers", "routing"), issues);
    validateProviderDescriptor(value.providers.poi, "poi", path.concat("providers", "poi"), issues);
  }
  validateBoundary(value.boundary, path.concat("boundary"), issues);
  if (!isRecord(value.provenance)) issues.push(issue(path.concat("provenance"), "invalid_type", "Attribution provenance is required."));
  else {
    validateBoundary(value.provenance.boundary, path.concat("provenance", "boundary"), issues);
    validateProviderProvenance(value.provenance.routing, "routing", path.concat("provenance", "routing"), issues);
    validateProviderProvenance(value.provenance.geocoding, "geocoding", path.concat("provenance", "geocoding"), issues);
    validateProviderProvenance(value.provenance.poi, "poi", path.concat("provenance", "poi"), issues);
    validateMapProvenance(value.provenance.map, path.concat("provenance", "map"), issues);
  }
}

function validateProviderDescriptor(value: unknown, role: "geocoding" | "routing" | "poi", path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Provider descriptor is required."));
    return;
  }
  requireKeys(value, ["name", "deployment", "dataKind", "liveData", "asOf", "notes", "provenance"], path, issues);
  validateString(value.name, path.concat("name"), issues, 1);
  validateString(value.deployment, path.concat("deployment"), issues, 1);
  validateString(value.dataKind, path.concat("dataKind"), issues, 1);
  if (!["fixture", "self-hosted", "managed", "unknown"].includes(String(value.deployment))) issues.push(issue(path.concat("deployment"), "invalid_value", "Unknown provider deployment."));
  if (!["demo-static", "scheduled", "live", "unknown"].includes(String(value.dataKind))) issues.push(issue(path.concat("dataKind"), "invalid_value", "Unknown provider data kind."));
  if (value.deployment !== "fixture" && value.dataKind === "demo-static") issues.push(issue(path, "contradictory_provenance", "Configured providers cannot report fixture/static data."));
  if (typeof value.liveData !== "boolean") issues.push(issue(path.concat("liveData"), "invalid_type", "liveData must be boolean."));
  if (value.name === DIRECT_MVG_PROVIDER) {
    if (value.deployment !== "unknown") {
      issues.push(issue(path.concat("deployment"), "invalid_value", "Direct MVG routing must use unknown deployment."));
    }
    if (
      !(
        (value.dataKind === "scheduled" && value.liveData === false) ||
        (value.dataKind === "live" && value.liveData === true)
      )
    ) {
      issues.push(issue(path, "invalid_value", "Direct MVG routing dataKind/liveData must be scheduled/false or live/true."));
    }
  }
  validateString(value.asOf, path.concat("asOf"), issues, 1);
  validateString(value.notes, path.concat("notes"), issues, 1);
  validateProviderProvenance(value.provenance, role, path.concat("provenance"), issues);
}

function validateProviderProvenance(value: unknown, role: "geocoding" | "routing" | "poi", path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Provider provenance is required."));
    return;
  }
  requireKeys(value, ["role", "provider", "deployment", "dataKind", "liveData", "sourceUrl", "license", "attribution", "version", "retrievedAt", "notes", "feeds"], path, issues);
  if (value.role !== role) issues.push(issue(path.concat("role"), "invalid_value", "Provider provenance role does not match."));
  validateString(value.provider, path.concat("provider"), issues, 1);
  validateString(value.deployment, path.concat("deployment"), issues, 1);
  validateString(value.dataKind, path.concat("dataKind"), issues, 1);
  if (value.deployment !== "fixture" && value.dataKind === "demo-static") issues.push(issue(path, "contradictory_provenance", "Configured providers cannot report fixture/static data."));
  if (typeof value.liveData !== "boolean") issues.push(issue(path.concat("liveData"), "invalid_type", "liveData must be boolean."));
  validateHttpsOrNull(value.sourceUrl, path.concat("sourceUrl"), issues);
  validateLicenseOrNull(value.license, path.concat("license"), issues);
  validateString(value.attribution, path.concat("attribution"), issues, 1);
  validateString(value.version, path.concat("version"), issues, 1);
  validateString(value.retrievedAt, path.concat("retrievedAt"), issues, 1);
  validateString(value.notes, path.concat("notes"), issues, 1);
  if (role === "routing" && value.provider === DIRECT_MVG_PROVIDER) {
    if (value.deployment !== "unknown") {
      issues.push(issue(path.concat("deployment"), "invalid_value", "Direct MVG routing must use unknown deployment provenance."));
    }
    if (
      !(
        (value.dataKind === "scheduled" && value.liveData === false) ||
        (value.dataKind === "live" && value.liveData === true)
      )
    ) {
      issues.push(issue(path, "invalid_value", "Direct MVG provenance dataKind/liveData must be scheduled/false or live/true."));
    }
    if (value.sourceUrl !== DIRECT_MVG_SOURCE_URL) {
      issues.push(issue(path.concat("sourceUrl"), "invalid_value", "Direct MVG provenance must use the fixed BGW PT v3 source URL."));
    }
    if (value.license !== null) {
      issues.push(issue(path.concat("license"), "invalid_value", "Direct MVG provenance must not claim an unverified licence."));
    }
    if (value.feeds !== null) {
      issues.push(issue(path.concat("feeds"), "invalid_value", "Direct MVG routing does not claim MVG or MVV feed provenance."));
    }
    if (
      !String(value.attribution).toLowerCase().includes("unofficial") ||
      !String(value.notes).toLowerCase().includes("no sla") ||
      !String(value.attribution).toLowerCase().includes("realtime is used when supplied") ||
      !String(value.attribution).toLowerCase().includes("planned timestamps used") ||
      !String(value.notes).toLowerCase().includes("realtime is used when supplied") ||
      !String(value.notes).toLowerCase().includes("planned timestamps used") ||
      !String(value.attribution).toLowerCase().includes("as the fallback") ||
      !String(value.notes).toLowerCase().includes("as the fallback")
    ) {
      issues.push(issue(path, "incomplete_provenance", "Direct MVG provenance must disclose its unofficial, no-SLA, realtime-when-supplied, planned-time-fallback status."));
    }
    validateIsoInstant(value.retrievedAt, path.concat("retrievedAt"), issues);
  } else if (role === "routing" && value.dataKind === "scheduled") validateFeeds(value.feeds, path.concat("feeds"), issues);
  else if (value.feeds !== null) validateFeeds(value.feeds, path.concat("feeds"), issues);
  else if (value.feeds !== null) issues.push(issue(path.concat("feeds"), "invalid_value", "feeds must be null or a valid feed object."));
}

function validateFeeds(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "missing_provenance", "Configured scheduled routing requires MVG and MVV feed provenance."));
    return;
  }
  validateFeed(value.mvg, "MVG", path.concat("mvg"), issues);
  validateFeed(value.mvv, "MVV", path.concat("mvv"), issues);
}

function validateFeed(value: unknown, name: "MVG" | "MVV", path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "missing_provenance", `${name} feed provenance is required.`));
    return;
  }
  requireKeys(value, ["name", "sourceUrl", "license", "attribution", "version", "retrievedAt"], path, issues);
  if (value.name !== name) issues.push(issue(path.concat("name"), "invalid_value", `Expected ${name} feed provenance.`));
  validateHttpsOrNull(value.sourceUrl, path.concat("sourceUrl"), issues);
  validateLicenseOrNull(value.license, path.concat("license"), issues);
  validateString(value.attribution, path.concat("attribution"), issues, 1);
  validateString(value.version, path.concat("version"), issues, 1);
  validateIsoInstant(value.retrievedAt, path.concat("retrievedAt"), issues);
}

function validateBoundary(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Official boundary provenance is required."));
    return;
  }
  requireKeys(value, ["name", "sourceUrl", "metadataUrl", "retrievedAt", "contentHash", "metadataContentHash", "districtCount", "license", "attribution", "legalBoundary"], path, issues);
  validateString(value.name, path.concat("name"), issues, 1);
  validateHttpsOrNull(value.sourceUrl, path.concat("sourceUrl"), issues);
  validateHttpsOrNull(value.metadataUrl, path.concat("metadataUrl"), issues);
  validateString(value.retrievedAt, path.concat("retrievedAt"), issues, 1);
  validateHash(value.contentHash, path.concat("contentHash"), issues);
  validateHash(value.metadataContentHash, path.concat("metadataContentHash"), issues);
  if (value.districtCount !== 25) issues.push(issue(path.concat("districtCount"), "invalid_value", "Official application boundary must contain 25 districts."));
  validateLicenseOrNull(value.license, path.concat("license"), issues);
  if (isRecord(value.license) && (typeof value.license.name !== "string" || !value.license.name.includes("DL-DE-BY-2.0"))) {
    issues.push(issue(path.concat("license", "name"), "missing_license", "Official boundary licence attribution is missing."));
  }
  validateString(value.attribution, path.concat("attribution"), issues, 1);
  if (value.legalBoundary !== false) issues.push(issue(path.concat("legalBoundary"), "invalid_value", "Boundary must not be labelled legal or cadastral."));
}

function validateMapProvenance(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Map configuration provenance is required."));
    return;
  }
  requireKeys(value, ["source", "styleUrl", "attribution"], path, issues);
  if (value.source !== "client-configured") issues.push(issue(path.concat("source"), "invalid_value", "Map configuration must be client-configured."));
  validateHttpsOrNull(value.styleUrl, path.concat("styleUrl"), issues);
  if (value.attribution !== null) validateString(value.attribution, path.concat("attribution"), issues, 1);
}

function validateCoordinate(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Coordinate must be an object."));
    return;
  }
  requireKeys(value, ["latitude", "longitude"], path, issues);
  validateWgs84(value.latitude, value.longitude, path, issues);
}

function validateWgs84(latitude: unknown, longitude: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (typeof latitude !== "number" || typeof longitude !== "number" || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    issues.push(issue(path, "invalid_coordinate", "Coordinates must be finite WGS84 values."));
  }
}

function validateTolerance(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (typeof value !== "number" || !(TOLERANCE_PERCENT_OPTIONS as readonly number[]).includes(value)) issues.push(issue(path, "invalid_value", "Tolerance must be 5, 10, or 15."));
}

function validateIsoInstant(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(new Date(String(value)).getTime())) issues.push(issue(path, "invalid_datetime", "Timestamp must be a canonical UTC ISO instant."));
}

function validateFiniteBoundedNumber(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[], minimum: number, maximum: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) issues.push(issue(path, "invalid_number", "Number is outside the allowed finite range."));
}

function validateBoundedInteger(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[], minimum: number, maximum: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) issues.push(issue(path, "invalid_integer", "Integer is outside the allowed range."));
}

function validateString(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[], minimum: number): void {
  if (typeof value !== "string" || value.length < minimum || value.length > MAX_STRING_LENGTH) issues.push(issue(path, "invalid_string", "String is missing or outside the allowed size."));
}

function validateHttpsOrNull(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (value !== null && (typeof value !== "string" || !value.startsWith("https://") || value.length > MAX_STRING_LENGTH)) issues.push(issue(path, "invalid_url", "URL must be null or HTTPS."));
}

function validateLicenseOrNull(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (value !== null) {
    if (!isRecord(value)) issues.push(issue(path, "invalid_type", "License must be null or an object."));
    else {
      requireKeys(value, ["name", "url"], path, issues);
      validateString(value.name, path.concat("name"), issues, 1);
      validateHttpsOrNull(value.url, path.concat("url"), issues);
    }
  }
}

function validateHash(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) issues.push(issue(path, "invalid_hash", "Content hash must be a SHA-256 hex string."));
}

function requireKeys(value: Record<string, unknown>, required: readonly string[], path: Array<string | number>, issues: ResponseValidationIssue[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  required.forEach((key) => {
    if (!(key in value)) issues.push(issue(path.concat(key), "missing_field", `Missing ${key}.`));
  });
  Object.keys(value).forEach((key) => {
    if (!allowed.has(key)) issues.push(issue(path.concat(key), "unknown_field", `Unknown field ${key}.`));
  });
}

function validatePositionObject(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((entry) => typeof entry === "number");
}

function closedRing(ring: unknown[]): boolean {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return validatePositionObject(first) && validatePositionObject(last) && first[0] === last[0] && first[1] === last[1];
}

function ringArea(ring: unknown[]): number {
  const positions = ring.filter(validatePositionObject);
  return Math.abs(positions.reduce((sum, current, index) => {
    const next = positions[(index + 1) % positions.length];
    return sum + current[0] * next[1] - next[0] * current[1];
  }, 0) / 2);
}

function isTravelMode(value: unknown): value is "transit" | "bike" | "car" {
  return (TRAVEL_MODES as readonly unknown[]).includes(value);
}

function issue(path: Array<string | number>, code: string, message: string): ResponseValidationIssue {
  return { path, code, message };
}

function invalid(singleIssue: ResponseValidationIssue): SafeMeetingResponse {
  return { success: false, issues: [singleIssue] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

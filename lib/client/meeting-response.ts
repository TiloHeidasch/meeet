// This module is deliberately independent of the server validator. Its only
// runtime asset is the public Munich boundary geometry; server validators,
// schedule artifacts, provider data, and credentials must stay out of it.
import boundaryAsset from "../../data/official/munich-districts.json";
import type {
  ScheduledMeetingRequest,
  ScheduledMeetingResponseDto as ServerMeetingResponse,
} from "../validation/meeting-v3.ts";

export type MeetingRequest = ScheduledMeetingRequest & {
  readonly changeTimePreset: "quick" | "medium" | "long";
};
export type StationAreaMode = "sbahn" | "ubahn" | "tram" | "bus";
export type StationAreaClassification = "red" | "blue" | "fair" | "unclassified";
export type MeetingStationArea = {
  readonly stationAreaId: string; readonly name: string;
  readonly coordinate: { readonly latitude: number; readonly longitude: number };
  readonly mode: StationAreaMode;
  readonly classification: StationAreaClassification;
  readonly redArrivalSeconds: number | null; readonly blueArrivalSeconds: number | null;
  readonly fasterParticipant: "red" | "blue" | null; readonly withinSelectedTolerance: boolean;
};
export type MeetingResponse = Omit<ServerMeetingResponse, "metadata"> & {
  readonly stationAreas: readonly MeetingStationArea[];
  readonly metadata: ServerMeetingResponse["metadata"] & {
    readonly surface: ServerMeetingResponse["metadata"]["surface"] & { readonly changeTimeSeconds: 180 | 300 | 600 };
    readonly stationAreas: { readonly count: number; readonly coverage: "official-munich-boundary-with-connected-artifact-station-areas/v1"; readonly selection: "all-eligible-scheduled-station-areas/v1" };
  };
};
export type ClientValidationIssue = { path: readonly (string | number)[]; message: string };
export type ClientValidationResult =
  | { success: true; data: MeetingResponse }
  | { success: false; issues: readonly ClientValidationIssue[] };

const fail = (issues: ClientValidationIssue[], path: (string | number)[], message: string) => issues.push({ path, message });
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[], path: (string | number)[], issues: ClientValidationIssue[]) => Object.keys(value).forEach((key) => { if (!allowed.includes(key)) fail(issues, [...path, key], "Unknown field is not allowed."); });
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullableWhole = (value: unknown): value is number | null => value === null || whole(value);
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const instant = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.0+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const coordinate = (value: unknown): value is { latitude: number; longitude: number } => object(value) && typeof value.latitude === "number" && Number.isFinite(value.latitude) && value.latitude >= -90 && value.latitude <= 90 && typeof value.longitude === "number" && Number.isFinite(value.longitude) && value.longitude >= -180 && value.longitude <= 180;
type BoundaryGeometry = { readonly type: "MultiPolygon"; readonly coordinates: readonly (readonly (readonly (readonly [number, number])[])[])[] };
const officialBoundary = boundaryAsset as unknown as { readonly features: readonly { readonly geometry: BoundaryGeometry }[] };
export const insideOfficialMunichBoundary = (value: unknown): boolean => coordinate(value) && officialBoundary.features.some(({ geometry }) => geometry.coordinates.some((polygon) => polygon.length > 0 && ringRelation(value, polygon[0] as unknown[]) !== -1 && polygon.slice(1).every((hole) => ringRelation(value, hole as unknown[]) === -1)));

function ringRelation(point: { latitude: number; longitude: number }, ring: unknown[]): -1 | 0 | 1 {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]; const b = ring[j];
    if (!position(a) || !position(b)) return 0;
    const boundary = ((a[1] - point.latitude) * (b[0] - point.longitude) - (b[1] - point.latitude) * (a[0] - point.longitude)) === 0 && point.longitude >= Math.min(a[0], b[0]) && point.longitude <= Math.max(a[0], b[0]) && point.latitude >= Math.min(a[1], b[1]) && point.latitude <= Math.max(a[1], b[1]);
    if (boundary) return 0;
    if ((a[1] > point.latitude) !== (b[1] > point.latitude) && point.longitude < (b[0] - a[0]) * (point.latitude - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? 1 : -1;
}
const position = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && Number.isFinite(value[0]) && value[0] >= -180 && value[0] <= 180 && typeof value[1] === "number" && Number.isFinite(value[1]) && value[1] >= -90 && value[1] <= 90;
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const WALKING_ROUNDING = "ceil(distanceMetres / velocityMetresPerSecond), with zero distance taking zero seconds";
const CHANGE_TIME_SECONDS = { quick: 180, medium: 300, long: 600 } as const;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function seed(value: unknown, path: (string | number)[], issues: ClientValidationIssue[]): boolean {
  if (!object(value)) { fail(issues, path, "Access seed must be an object."); return false; }
  keys(value, ["seedId", "mvgStationId", "stationAreaId", "coordinate", "accessSeconds", "provenance"], path, issues);
  const p = value.provenance;
  const valid = nonEmpty(value.seedId) && nonEmpty(value.mvgStationId) && nonEmpty(value.stationAreaId) && whole(value.accessSeconds) && coordinate(value.coordinate) && object(p) && (p.source === "mvg-nearby" || p.source === "fixture-static") && nonEmpty(p.endpoint) && typeof p.distanceMeters === "number" && Number.isFinite(p.distanceMeters) && p.distanceMeters >= 0 && whole(p.walkingSeconds) && typeof p.note === "string";
  if (object(value.coordinate)) keys(value.coordinate, ["latitude", "longitude"], [...path, "coordinate"], issues);
  if (object(p)) keys(p, ["source", "endpoint", "distanceMeters", "walkingSeconds", "note"], [...path, "provenance"], issues);
  if (!valid) fail(issues, path, "Access seed fields or provenance are invalid.");
  return valid;
}

function participant(value: unknown, index: number, request: MeetingRequest, issues: ClientValidationIssue[]): boolean {
  const path = ["participants", index];
  if (!object(value)) { fail(issues, path, "Participant must be an object."); return false; }
  keys(value, ["id", "color", "origin", "mode", "accessSeeds"], path, issues);
  const origin = value.origin; const seeds = value.accessSeeds;
  const expected = request.participants[index];
  const responseOrigin = originShape(origin) ? origin : undefined;
  const valid = nonEmpty(value.id) && value.color === (index === 0 ? "red" : "blue") && value.mode === "transit" && originShape(origin) && Array.isArray(seeds) && seeds.every((item, seedIndex) => seed(item, [...path, "accessSeeds", seedIndex], issues));
  if (object(origin)) keys(origin, ["label", "latitude", "longitude"], [...path, "origin"], issues);
  if (expected && (value.id !== expected.id || !responseOrigin || responseOrigin.label !== expected.origin.label || responseOrigin.latitude !== expected.origin.latitude || responseOrigin.longitude !== expected.origin.longitude)) fail(issues, path, "Response participant does not match the request.");
  if (!valid) fail(issues, path, "Participant fields are invalid.");
  return valid;
}

function acquisition(value: unknown, path: (string | number)[], issues: ClientValidationIssue[]): boolean {
  if (!object(value)) return false;
  keys(value, ["sourceUrl", "retrievedAt", "rawArchiveByteSize", "rawArchiveSha256", "feedVersion", "feedValidFrom", "feedValidUntil", "attribution", "officialAttribution", "officialLicense", "officialProvenance"], path, issues);
  const license = value.officialLicense; const provenance = value.officialProvenance;
  const valid = nonEmpty(value.sourceUrl) && instant(value.retrievedAt) && whole(value.rawArchiveByteSize) && sha(value.rawArchiveSha256) && nonEmpty(value.feedVersion) && date(value.feedValidFrom) && date(value.feedValidUntil) && value.feedValidFrom <= value.feedValidUntil && nonEmpty(value.attribution) && nonEmpty(value.officialAttribution) && object(license) && nonEmpty(license.name) && nonEmpty(license.url) && object(provenance) && (provenance.source === "feed" || provenance.source === "meeet-policy") && (provenance.policyId === null || provenance.policyId === "mvv-cc-by-4.0-fallback/v1");
  if (object(license)) keys(license, ["name", "url"], [...path, "officialLicense"], issues);
  if (object(provenance)) keys(provenance, ["source", "policyId"], [...path, "officialProvenance"], issues);
  if (!valid) fail(issues, path, "Schedule acquisition provenance is invalid.");
  return valid;
}

function metadata(value: unknown, request: MeetingRequest, participants: unknown, stationAreas: unknown[], issues: ClientValidationIssue[]): boolean {
  if (!object(value)) { fail(issues, ["metadata"], "Metadata must be an object."); return false; }
  keys(value, ["schedule", "surface", "stationAreas", "accessProvider", "coverage"], ["metadata"], issues);
  const schedule = value.schedule; const surface = value.surface; const stationMetadata = value.stationAreas; const provider = value.accessProvider;
  if (!object(schedule) || !object(surface) || !object(stationMetadata) || !object(provider)) { fail(issues, ["metadata"], "Complete schedule, surface, station-area and provider metadata are required."); return false; }
  keys(schedule, ["contractVersion", "feedId", "timeZone", "scheduleContentHash", "compiledArtifactId", "serviceDateRange", "acquisition"], ["metadata", "schedule"], issues);
  keys(surface, ["contractVersion", "scheduleContentHash", "compiledArtifactId", "feedId", "timeZone", "searchStartAt", "routingHorizonSeconds", "selectedTolerancePercent", "walkingVelocityMetersPerSecond", "walkingSecondsRoundingRule", "transferRadiusMeters", "accessSeedCounts", "stationAreaCount", "connectionCount", "changeTimeSeconds", "coverage", "representativePointBasis", "classificationMethod", "classificationBasis", "finalWalkingMethod"], ["metadata", "surface"], issues);
  keys(stationMetadata, ["count", "coverage", "selection"], ["metadata", "stationAreas"], issues);
  keys(provider, ["name", "deployment", "dataKind", "liveData", "asOf", "notes", "provenance"], ["metadata", "accessProvider"], issues);
  if (object(provider.provenance)) {
    keys(provider.provenance, ["role", "provider", "deployment", "dataKind", "liveData", "sourceUrl", "license", "attribution", "version", "retrievedAt", "notes", "feeds"], ["metadata", "accessProvider", "provenance"], issues);
    if (object(provider.provenance.license)) keys(provider.provenance.license, ["name", "url"], ["metadata", "accessProvider", "provenance", "license"], issues);
    if (object(provider.provenance.feeds)) {
      keys(provider.provenance.feeds, ["mvg", "mvv"], ["metadata", "accessProvider", "provenance", "feeds"], issues);
      for (const name of ["mvg", "mvv"] as const) {
        const feed = provider.provenance.feeds[name];
        if (object(feed)) keys(feed, ["name", "sourceUrl", "license", "attribution", "version", "retrievedAt"], ["metadata", "accessProvider", "provenance", "feeds", name], issues);
      }
    }
  }
  const range = schedule.serviceDateRange; const counts = surface.accessSeedCounts;
  if (object(range)) keys(range, ["firstDate", "lastDate"], ["metadata", "schedule", "serviceDateRange"], issues);
  const valid = schedule.contractVersion === "meeet-scheduled-routing/v1" && nonEmpty(schedule.feedId) && schedule.timeZone === "Europe/Berlin" && sha(schedule.scheduleContentHash) && sha(schedule.compiledArtifactId) && object(range) && date(range.firstDate) && date(range.lastDate) && range.firstDate <= range.lastDate && acquisition(schedule.acquisition, ["metadata", "schedule", "acquisition"], issues) && surface.contractVersion === "meeet-scheduled-routing/v1" && sha(surface.scheduleContentHash) && sha(surface.compiledArtifactId) && surface.feedId === schedule.feedId && surface.timeZone === schedule.timeZone && surface.scheduleContentHash === schedule.scheduleContentHash && surface.compiledArtifactId === schedule.compiledArtifactId && instant(surface.searchStartAt) && surface.searchStartAt === request.searchStartAt && surface.routingHorizonSeconds === 86400 && (surface.selectedTolerancePercent === 5 || surface.selectedTolerancePercent === 10 || surface.selectedTolerancePercent === 15) && surface.selectedTolerancePercent === request.tolerancePercent && typeof surface.walkingVelocityMetersPerSecond === "number" && Number.isFinite(surface.walkingVelocityMetersPerSecond) && surface.walkingSecondsRoundingRule === WALKING_ROUNDING && typeof surface.transferRadiusMeters === "number" && Number.isFinite(surface.transferRadiusMeters) && Array.isArray(counts) && counts.length === 2 && counts.every(whole) && whole(surface.stationAreaCount) && whole(surface.connectionCount) && surface.changeTimeSeconds === CHANGE_TIME_SECONDS[request.changeTimePreset] && surface.coverage === "scheduled-service-day-local-radius/v1" && surface.representativePointBasis === "inside-clipped-cell/v1" && surface.classificationMethod === "representative-point-with-geometric-final-station-walking/v1" && surface.classificationBasis === "representative-point" && surface.finalWalkingMethod === "geometric-station-walking-estimate-not-navigation" && value.coverage === "munich-clipped-scheduled-grid/v1" && providerShape(provider);
  if (schedule.feedId !== surface.feedId || schedule.scheduleContentHash !== surface.scheduleContentHash || schedule.compiledArtifactId !== surface.compiledArtifactId || schedule.timeZone !== surface.timeZone) fail(issues, ["metadata"], "Schedule and surface identities must match.");
  if (Array.isArray(counts) && Array.isArray(participants)) participants.forEach((p, i) => { if (object(p) && Array.isArray(p.accessSeeds) && counts[i] !== p.accessSeeds.length) fail(issues, ["metadata", "surface", "accessSeedCounts", i], "Access-seed count does not match serialized seeds."); });
  if (!valid || !whole(stationMetadata.count) || stationMetadata.count !== stationAreas.length || stationMetadata.coverage !== "official-munich-boundary-with-connected-artifact-station-areas/v1" || stationMetadata.selection !== "all-eligible-scheduled-station-areas/v1") fail(issues, ["metadata"], "Metadata fields are invalid.");
  return valid;
}

function providerShape(value: Record<string, unknown>): boolean {
  const p = value.provenance;
  if (!object(p)) return false;
  const license = p.license;
  const licenseShape = license === null || (object(license) && nonEmpty(license.name) && nonEmpty(license.url));
  const feeds = p.feeds;
  const feedsShape = feeds === null || (object(feeds) && ["mvg", "mvv"].every((name) => feedShape(feeds[name])));
  const descriptorDataKind = value.dataKind === "access" || value.dataKind === "demo-static";
  return nonEmpty(value.name) && ["fixture", "self-hosted", "managed", "unknown"].includes(String(value.deployment)) && descriptorDataKind && value.liveData === false && nonEmpty(value.asOf) && typeof value.notes === "string" && p.role === "access" && nonEmpty(p.provider) && p.deployment === value.deployment && p.dataKind === value.dataKind && p.liveData === false && (p.sourceUrl === null || nonEmpty(p.sourceUrl)) && licenseShape && nonEmpty(p.attribution) && nonEmpty(p.version) && p.version === value.asOf && nonEmpty(p.retrievedAt) && p.notes === value.notes && feedsShape && p.feeds === null;
}
function feedShape(value: unknown): boolean {
  return object(value) && (value.name === "MVG" || value.name === "MVV") && nonEmpty(value.sourceUrl) && object(value.license) && nonEmpty(value.license.name) && nonEmpty(value.license.url) && nonEmpty(value.attribution) && nonEmpty(value.version) && nonEmpty(value.retrievedAt);
}
function originShape(value: unknown): value is { label: string; latitude: number; longitude: number } {
  return object(value) && nonEmpty(value.label) && typeof value.latitude === "number" && Number.isFinite(value.latitude) && value.latitude >= -90 && value.latitude <= 90 && typeof value.longitude === "number" && Number.isFinite(value.longitude) && value.longitude >= -180 && value.longitude <= 180;
}

function stationArea(value: unknown, index: number, status: unknown, tolerance: unknown, issues: ClientValidationIssue[]): boolean {
  const path = ["stationAreas", index];
  if (!object(value)) { fail(issues, path, "Station area must be an object."); return false; }
  keys(value, ["stationAreaId", "name", "coordinate", "mode", "classification", "redArrivalSeconds", "blueArrivalSeconds", "fasterParticipant", "withinSelectedTolerance"], path, issues);
  if (object(value.coordinate)) keys(value.coordinate, ["latitude", "longitude"], [...path, "coordinate"], issues);
  const valid = nonEmpty(value.stationAreaId) && nonEmpty(value.name) && ["sbahn", "ubahn", "tram", "bus"].includes(String(value.mode)) && insideOfficialMunichBoundary(value.coordinate) && ["red", "blue", "fair", "unclassified"].includes(String(value.classification)) && nullableWhole(value.redArrivalSeconds) && nullableWhole(value.blueArrivalSeconds) && (value.fasterParticipant === null || value.fasterParticipant === "red" || value.fasterParticipant === "blue") && typeof value.withinSelectedTolerance === "boolean";
  const red = value.redArrivalSeconds; const blue = value.blueArrivalSeconds;
  if (status === "no-result" && (value.classification !== "unclassified" || red !== null || blue !== null || value.fasterParticipant !== null || value.withinSelectedTolerance !== false)) fail(issues, path, "No-result station areas must be unclassified and have no travel fields.");
  if (status === "ok" && nullableWhole(red) && nullableWhole(blue)) { const hasRed = red !== null; const hasBlue = blue !== null; const fair = hasRed && hasBlue && Math.abs(red - blue) * 100 <= (red + blue) * Number(tolerance); const expected = !hasRed && !hasBlue ? "unclassified" : fair ? "fair" : hasRed && hasBlue ? red! < blue! ? "red" : "blue" : hasRed ? "red" : "blue"; const faster = !hasRed && !hasBlue ? null : hasRed && hasBlue && red === blue ? null : hasRed && hasBlue ? red! < blue! ? "red" : "blue" : hasRed ? "red" : "blue"; const expectedTolerance = !hasRed && !hasBlue ? false : fair; if (value.classification !== expected || value.withinSelectedTolerance !== expectedTolerance || value.fasterParticipant !== faster) fail(issues, path, "Station area classification contradicts arrivals."); }
  if (!valid) fail(issues, path, "Station area fields are invalid.");
  return valid;
}

export function validateMeetingResponse(value: unknown, request: MeetingRequest): ClientValidationResult {
  const issues: ClientValidationIssue[] = [];
  if (!object(value)) return { success: false, issues: [{ path: [], message: "The meeting response must be an object." }] };
  keys(value, ["contractVersion", "status", "reason", "participants", "stationAreas", "metadata"], [], issues);
  if (value.contractVersion !== "meeet-meeting/v3") fail(issues, ["contractVersion"], "Only the meeet-meeting/v3 response is supported.");
  if (value.status !== "ok" && value.status !== "no-result") fail(issues, ["status"], "The response status is invalid.");
  if ((value.status === "ok" && value.reason !== null) || (value.status === "no-result" && value.reason !== "no-access-seeds" && value.reason !== "no-reachable-stations")) fail(issues, ["reason"], "The response reason is invalid for its status.");
  const participants = value.participants; const stationAreas = value.stationAreas;
  if (!Array.isArray(participants) || participants.length !== 2) fail(issues, ["participants"], "Exactly two participants are required.");
  else participants.forEach((p, i) => participant(p, i, request, issues));
  if (!Array.isArray(stationAreas)) fail(issues, ["stationAreas"], "Station areas must be an array.");
  else { const ids = new Set<string>(); stationAreas.forEach((item, i) => { stationArea(item, i, value.status, object(value.metadata) && object(value.metadata.surface) ? value.metadata.surface.selectedTolerancePercent : undefined, issues); if (object(item) && typeof item.stationAreaId === "string") { if (ids.has(item.stationAreaId)) fail(issues, ["stationAreas", i, "stationAreaId"], "Station area ids must be unique."); ids.add(item.stationAreaId); } }); }
  const metadataValue = value.metadata;
  metadata(metadataValue, request, participants, Array.isArray(stationAreas) ? stationAreas : [], issues);
  if (value.status === "no-result" && object(metadataValue) && object(metadataValue.surface) && Array.isArray(metadataValue.surface.accessSeedCounts) && Array.isArray(participants)) {
    const counts = metadataValue.surface.accessSeedCounts;
    const empty = counts.length === 2 && counts.some((count) => count === 0) && participants.length === 2 && participants.some((item) => object(item) && Array.isArray(item.accessSeeds) && item.accessSeeds.length === 0);
    const reachable = counts.length === 2 && counts.every((count) => whole(count) && count > 0) && participants.length === 2 && participants.every((item) => object(item) && Array.isArray(item.accessSeeds) && item.accessSeeds.length > 0);
    if (value.reason === "no-access-seeds" && !empty) fail(issues, ["reason"], "no-access-seeds requires at least one participant access-seed set to be empty.");
    if (value.reason === "no-reachable-stations" && !reachable) fail(issues, ["reason"], "no-reachable-stations requires both participant access-seed sets to be non-empty.");
  }
  if (issues.length || !isParsedResponse(value)) return { success: false, issues: issues.length ? issues : [{ path: [], message: "The response structure is invalid." }] };
  return { success: true, data: value };
}

function isParsedResponse(value: unknown): value is MeetingResponse {
  if (!object(value) || value.contractVersion !== "meeet-meeting/v3" || (value.status !== "ok" && value.status !== "no-result") || !Array.isArray(value.participants) || value.participants.length !== 2 || !Array.isArray(value.stationAreas) || !object(value.metadata)) return false;
  const participantShape = (item: unknown) => object(item) && typeof item.id === "string" && (item.color === "red" || item.color === "blue") && item.mode === "transit" && originShape(item.origin) && Array.isArray(item.accessSeeds) && item.accessSeeds.every((seedValue) => object(seedValue) && object(seedValue.coordinate) && object(seedValue.provenance));
  const metadataShape = value.metadata;
  return value.participants.every(participantShape) && value.stationAreas.every((area) => object(area) && typeof area.stationAreaId === "string" && coordinate(area.coordinate)) && object(metadataShape.stationAreas) && metadataShape.stationAreas.count === value.stationAreas.length && metadataShape.stationAreas.coverage === "official-munich-boundary-with-connected-artifact-station-areas/v1" && metadataShape.stationAreas.selection === "all-eligible-scheduled-station-areas/v1" && object(metadataShape.schedule) && object(metadataShape.surface) && (metadataShape.surface.changeTimeSeconds === 180 || metadataShape.surface.changeTimeSeconds === 300 || metadataShape.surface.changeTimeSeconds === 600) && object(metadataShape.accessProvider) && metadataShape.coverage === "munich-clipped-scheduled-grid/v1";
}

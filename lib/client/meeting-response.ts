// This module is deliberately independent of the server validator.  Keep it
// free of runtime imports: it is part of the browser trust boundary.
import type {
  ScheduledMeetingCellDto as MeetingCell,
  ScheduledMeetingRequest as MeetingRequest,
  ScheduledMeetingResponseDto as MeetingResponse,
} from "../validation/meeting-v3.ts";

export type { MeetingRequest, MeetingResponse, MeetingCell };
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
function multipolygon(value: unknown): value is MeetingCell["geometry"] {
  if (!object(value) || value.type !== "MultiPolygon" || !Array.isArray(value.coordinates) || value.coordinates.length === 0) return false;
  return value.coordinates.every((polygon) => Array.isArray(polygon) && polygon.length > 0 && polygon.every((ring) => Array.isArray(ring) && ring.length >= 4 && position(ring[0]) && position(ring[ring.length - 1]) && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] && ring.every(position)));
}
function interior(point: { latitude: number; longitude: number }, geometry: MeetingCell["geometry"]): boolean {
  return geometry.coordinates.some((polygon) => {
    if (polygon.length === 0) return false;
    const outer = ringRelation(point, polygon[0]!);
    return outer === 1 && polygon.slice(1).every((hole) => ringRelation(point, hole) === -1);
  });
}
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const WALKING_ROUNDING = "ceil(distanceMetres / velocityMetresPerSecond), with zero distance taking zero seconds";
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function seed(value: unknown, path: (string | number)[], issues: ClientValidationIssue[]): boolean {
  if (!object(value)) { fail(issues, path, "Access seed must be an object."); return false; }
  keys(value, ["seedId", "mvgStationId", "stationAreaId", "boardingStopId", "coordinate", "accessSeconds", "provenance"], path, issues);
  const p = value.provenance;
  const valid = nonEmpty(value.seedId) && nonEmpty(value.mvgStationId) && nonEmpty(value.stationAreaId) && (value.boardingStopId === undefined || nonEmpty(value.boardingStopId)) && whole(value.accessSeconds) && coordinate(value.coordinate) && object(p) && (p.source === "mvg-nearby" || p.source === "fixture-static") && nonEmpty(p.endpoint) && typeof p.distanceMeters === "number" && Number.isFinite(p.distanceMeters) && p.distanceMeters >= 0 && whole(p.walkingSeconds) && typeof p.note === "string";
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

function metadata(value: unknown, request: MeetingRequest, participants: unknown, cells: unknown[], issues: ClientValidationIssue[]): boolean {
  if (!object(value)) { fail(issues, ["metadata"], "Metadata must be an object."); return false; }
  keys(value, ["schedule", "surface", "grid", "accessProvider", "coverage"], ["metadata"], issues);
  const schedule = value.schedule; const surface = value.surface; const grid = value.grid; const provider = value.accessProvider;
  if (!object(schedule) || !object(surface) || !object(grid) || !object(provider)) { fail(issues, ["metadata"], "Complete schedule, surface, grid and provider metadata are required."); return false; }
  keys(schedule, ["contractVersion", "feedId", "timeZone", "scheduleContentHash", "compiledArtifactId", "serviceDateRange", "acquisition"], ["metadata", "schedule"], issues);
  keys(surface, ["contractVersion", "scheduleContentHash", "compiledArtifactId", "feedId", "timeZone", "searchStartAt", "routingHorizonSeconds", "selectedTolerancePercent", "walkingVelocityMetersPerSecond", "walkingSecondsRoundingRule", "transferRadiusMeters", "accessSeedCounts", "stationAreaCount", "boardingStopCount", "connectionCount", "coverage", "representativePointBasis", "classificationMethod", "classificationBasis", "finalWalkingMethod"], ["metadata", "surface"], issues);
  keys(grid, ["columns", "rows", "cellCount", "geometry"], ["metadata", "grid"], issues);
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
  const valid = schedule.contractVersion === "meeet-scheduled-routing/v1" && nonEmpty(schedule.feedId) && schedule.timeZone === "Europe/Berlin" && sha(schedule.scheduleContentHash) && sha(schedule.compiledArtifactId) && object(range) && date(range.firstDate) && date(range.lastDate) && range.firstDate <= range.lastDate && acquisition(schedule.acquisition, ["metadata", "schedule", "acquisition"], issues) && surface.contractVersion === "meeet-scheduled-routing/v1" && sha(surface.scheduleContentHash) && sha(surface.compiledArtifactId) && surface.feedId === schedule.feedId && surface.timeZone === schedule.timeZone && surface.scheduleContentHash === schedule.scheduleContentHash && surface.compiledArtifactId === schedule.compiledArtifactId && instant(surface.searchStartAt) && surface.searchStartAt === request.searchStartAt && surface.routingHorizonSeconds === 86400 && (surface.selectedTolerancePercent === 5 || surface.selectedTolerancePercent === 10 || surface.selectedTolerancePercent === 15) && surface.selectedTolerancePercent === request.tolerancePercent && typeof surface.walkingVelocityMetersPerSecond === "number" && Number.isFinite(surface.walkingVelocityMetersPerSecond) && surface.walkingSecondsRoundingRule === WALKING_ROUNDING && typeof surface.transferRadiusMeters === "number" && Number.isFinite(surface.transferRadiusMeters) && Array.isArray(counts) && counts.length === 2 && counts.every(whole) && whole(surface.stationAreaCount) && whole(surface.boardingStopCount) && whole(surface.connectionCount) && surface.coverage === "scheduled-service-day-local-radius/v1" && surface.representativePointBasis === "inside-clipped-cell/v1" && surface.classificationMethod === "representative-point-with-geometric-final-station-walking/v1" && surface.classificationBasis === "representative-point" && surface.finalWalkingMethod === "geometric-station-walking-estimate-not-navigation" && grid.geometry === "munich-clipped-surface-grid/v1" && whole(grid.columns) && whole(grid.rows) && grid.columns >= 24 && grid.rows >= 16 && whole(grid.cellCount) && grid.cellCount === cells.length && value.coverage === "munich-clipped-scheduled-grid/v1" && providerShape(provider);
  if (schedule.feedId !== surface.feedId || schedule.scheduleContentHash !== surface.scheduleContentHash || schedule.compiledArtifactId !== surface.compiledArtifactId || schedule.timeZone !== surface.timeZone) fail(issues, ["metadata"], "Schedule and surface identities must match.");
  if (Array.isArray(counts) && Array.isArray(participants)) participants.forEach((p, i) => { if (object(p) && Array.isArray(p.accessSeeds) && counts[i] !== p.accessSeeds.length) fail(issues, ["metadata", "surface", "accessSeedCounts", i], "Access-seed count does not match serialized seeds."); });
  if (!valid) fail(issues, ["metadata"], "Metadata fields are invalid.");
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

function cell(value: unknown, index: number, status: unknown, tolerance: unknown, issues: ClientValidationIssue[]): boolean {
  const path = ["cells", index];
  if (!object(value)) { fail(issues, path, "Cell must be an object."); return false; }
  keys(value, ["id", "geometry", "representativePoint", "classification", "redArrivalSeconds", "blueArrivalSeconds", "fasterParticipant", "withinSelectedTolerance"], path, issues);
  if (object(value.geometry)) keys(value.geometry, ["type", "coordinates"], [...path, "geometry"], issues);
  if (object(value.representativePoint)) keys(value.representativePoint, ["latitude", "longitude"], [...path, "representativePoint"], issues);
  const valid = nonEmpty(value.id) && multipolygon(value.geometry) && coordinate(value.representativePoint) && (multipolygon(value.geometry) && coordinate(value.representativePoint) ? interior(value.representativePoint, value.geometry) : false) && ["red", "blue", "fair", "unclassified"].includes(String(value.classification)) && nullableWhole(value.redArrivalSeconds) && nullableWhole(value.blueArrivalSeconds) && (value.fasterParticipant === null || value.fasterParticipant === "red" || value.fasterParticipant === "blue") && typeof value.withinSelectedTolerance === "boolean";
  const red = value.redArrivalSeconds; const blue = value.blueArrivalSeconds;
  if (status === "no-result" && (value.classification !== "unclassified" || red !== null || blue !== null || value.fasterParticipant !== null || value.withinSelectedTolerance !== false)) fail(issues, path, "No-result cells must be uniformly unclassified.");
  if (status === "ok" && nullableWhole(red) && nullableWhole(blue) && (red !== null || blue !== null)) { const fair = red !== null && blue !== null && Math.abs(red - blue) * 100 <= (red + blue) * Number(tolerance); const expected = fair ? "fair" : red !== null && blue !== null ? red < blue ? "red" : "blue" : red !== null ? "red" : "blue"; const faster = red !== null && blue !== null && red === blue ? null : red !== null && blue !== null ? red < blue ? "red" : "blue" : red !== null ? "red" : "blue"; if (value.classification !== expected || value.withinSelectedTolerance !== fair || value.fasterParticipant !== faster) fail(issues, path, "Cell classification contradicts its arrival fields."); }
  if (!valid) fail(issues, path, "Cell geometry or fields are invalid.");
  return valid;
}

export function validateMeetingResponse(value: unknown, request: MeetingRequest): ClientValidationResult {
  const issues: ClientValidationIssue[] = [];
  if (!object(value)) return { success: false, issues: [{ path: [], message: "The meeting response must be an object." }] };
  keys(value, ["contractVersion", "status", "reason", "participants", "cells", "metadata"], [], issues);
  if (value.contractVersion !== "meeet-meeting/v3") fail(issues, ["contractVersion"], "Only the meeet-meeting/v3 response is supported.");
  if (value.status !== "ok" && value.status !== "no-result") fail(issues, ["status"], "The response status is invalid.");
  if ((value.status === "ok" && value.reason !== null) || (value.status === "no-result" && value.reason !== "no-access-seeds" && value.reason !== "no-reachable-stations")) fail(issues, ["reason"], "The response reason is invalid for its status.");
  const participants = value.participants; const cells = value.cells;
  if (!Array.isArray(participants) || participants.length !== 2) fail(issues, ["participants"], "Exactly two participants are required.");
  else participants.forEach((p, i) => participant(p, i, request, issues));
  if (!Array.isArray(cells)) fail(issues, ["cells"], "Cells must be an array.");
  else { const ids = new Set<string>(); cells.forEach((item, i) => { if (object(item) && (typeof item.id !== "string" || ids.has(item.id))) fail(issues, ["cells", i, "id"], "Cell ids must be unique and non-empty."); if (object(item) && typeof item.id === "string") ids.add(item.id); }); }
  const metadataValue = value.metadata;
  if (Array.isArray(cells)) { const tolerance = object(metadataValue) && object(metadataValue.surface) ? metadataValue.surface.selectedTolerancePercent : undefined; cells.forEach((item, i) => cell(item, i, value.status, tolerance, issues)); }
  metadata(metadataValue, request, participants, Array.isArray(cells) ? cells : [], issues);
  if (issues.length || !isParsedResponse(value)) return { success: false, issues: issues.length ? issues : [{ path: [], message: "The response structure is invalid." }] };
  return { success: true, data: value };
}

function isParsedResponse(value: unknown): value is MeetingResponse {
  if (!object(value) || value.contractVersion !== "meeet-meeting/v3" || (value.status !== "ok" && value.status !== "no-result") || !Array.isArray(value.participants) || value.participants.length !== 2 || !Array.isArray(value.cells) || !object(value.metadata)) return false;
  const participantShape = (item: unknown) => object(item) && typeof item.id === "string" && (item.color === "red" || item.color === "blue") && item.mode === "transit" && originShape(item.origin) && Array.isArray(item.accessSeeds) && item.accessSeeds.every((seedValue) => object(seedValue) && object(seedValue.coordinate) && object(seedValue.provenance));
  const cellShape = (item: unknown) => object(item) && typeof item.id === "string" && object(item.geometry) && object(item.representativePoint) && typeof item.classification === "string" && nullableWhole(item.redArrivalSeconds) && nullableWhole(item.blueArrivalSeconds) && typeof item.withinSelectedTolerance === "boolean";
  const metadataShape = value.metadata;
  return value.participants.every(participantShape) && value.cells.every(cellShape) && object(metadataShape.schedule) && object(metadataShape.surface) && object(metadataShape.grid) && object(metadataShape.accessProvider) && metadataShape.coverage === "munich-clipped-scheduled-grid/v1";
}

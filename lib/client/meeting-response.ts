// Browser-safe v3 response adapter. Do not import server-only validation here.
export type {
  ScheduledMeetingRequest as MeetingRequest,
  ScheduledMeetingResponseDto as MeetingResponse,
  ScheduledMeetingCellDto as MeetingCell,
} from "../validation/meeting-v3.ts";

import type { MeetingRequest, MeetingResponse } from "./meeting-response";

export type ClientValidationIssue = { path: readonly (string | number)[]; message: string };
export type ClientValidationResult = { success: true; data: MeetingResponse } | { success: false; issues: readonly ClientValidationIssue[] };
type Issues = ClientValidationIssue[];
type Obj = Record<string, unknown>;

const RED = "red" as const;
const BLUE = "blue" as const;
const TZ = "Europe/Berlin";

export function validateMeetingResponse(value: unknown, request: MeetingRequest): ClientValidationResult {
  const issues: Issues = [];
  if (!object(value)) return fail([], "The meeting response must be an object.");
  keys(value, ["contractVersion", "status", "reason", "participants", "cells", "metadata"], [], issues);
  if (value.contractVersion !== "meeet-meeting/v3") add([], "Only the meeet-meeting/v3 response is supported.", issues);
  if (value.status !== "ok" && value.status !== "no-result") add(["status"], "The response status is invalid.", issues);
  if (value.status === "ok" && value.reason !== null) add(["reason"], "A successful response must have a null reason.", issues);
  if (value.status === "no-result" && value.reason !== "no-access-seeds" && value.reason !== "no-reachable-stations") add(["reason"], "A no-result response must disclose a v3 reason.", issues);
  if (!tuple(value.participants)) add(["participants"], "Exactly two participants are required.", issues);
  else value.participants.forEach((participant, index) => participantDto(participant, index, request, issues));
  let metadata: Obj | undefined;
  if (!object(value.metadata)) add(["metadata"], "Response metadata is required.", issues);
  else { metadata = value.metadata; metadataDto(metadata, request, issues); }
  if (metadata && object(metadata.schedule) && object(metadata.surface)) {
    for (const field of ["feedId", "scheduleContentHash", "compiledArtifactId", "timeZone"] as const) {
      if (metadata.schedule[field] !== metadata.surface[field]) add(["metadata", "surface", field], "Schedule and surface identity must match.", issues);
    }
    const surface = metadata.surface;
    const counts = object(surface) ? surface.accessSeedCounts : undefined;
    if (tuple(value.participants) && tupleNumbers(counts)) value.participants.forEach((participant, index) => { if (object(participant) && Array.isArray(participant.accessSeeds) && counts[index] !== participant.accessSeeds.length) add(["metadata", "surface", "accessSeedCounts", index], "Surface seed counts must match serialized participant seeds.", issues); });
  }
  if (!Array.isArray(value.cells)) add(["cells"], "Response cells are required.", issues);
  else {
    const ids = new Set<string>();
    value.cells.forEach((cell, index) => { if (object(cell) && typeof cell.id === "string" && ids.has(cell.id)) add(["cells", index, "id"], "Cell ids must be unique.", issues); if (object(cell) && typeof cell.id === "string") ids.add(cell.id); cellDto(cell, index, value.status, metadata, issues); });
    if (metadata && object(metadata.grid) && metadata.grid.cellCount !== value.cells.length) add(["metadata", "grid", "cellCount"], "Grid cellCount must match serialized cells.", issues);
  }
  return issues.length ? { success: false, issues } : { success: true, data: value as unknown as MeetingResponse };
}

function participantDto(value: unknown, index: number, request: MeetingRequest, issues: Issues): void {
  const path = ["participants", index];
  if (!object(value)) return add(path, "Participant must be an object.", issues);
  keys(value, ["id", "color", "origin", "mode", "accessSeeds"], path, issues);
  const expected = request.participants[index];
  if (typeof value.id !== "string" || !value.id.trim() || value.id.length > 64) add([...path, "id"], "Participant id is invalid.", issues);
  if (value.color !== (index === 0 ? RED : BLUE)) add([...path, "color"], "Participant colours must be red then blue.", issues);
  if (value.mode !== "transit") add([...path, "mode"], "Participant mode must be transit.", issues);
  if (!coordinateOrigin(value.origin, [...path, "origin"], issues)) return;
  if (expected && (value.id !== expected.id || value.origin.label !== expected.origin.label || value.origin.latitude !== expected.origin.latitude || value.origin.longitude !== expected.origin.longitude)) add(path, "Response origin does not match the request.", issues);
  if (!Array.isArray(value.accessSeeds)) return add([...path, "accessSeeds"], "Access seeds must be an array.", issues);
  value.accessSeeds.forEach((seed, seedIndex) => seedDto(seed, [...path, "accessSeeds", seedIndex], issues));
}

function coordinateOrigin(value: unknown, path: (string | number)[], issues: Issues): value is Obj {
  if (!object(value)) { add(path, "Origin must be an object.", issues); return false; }
  keys(value, ["label", "latitude", "longitude"], path, issues);
  if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 120) add([...path, "label"], "Origin label is invalid.", issues);
  if (!coordinate(value, path, issues)) return false;
  return true;
}

function seedDto(value: unknown, path: (string | number)[], issues: Issues): void {
  if (!object(value)) return add(path, "Access seed must be an object.", issues);
  keys(value, ["seedId", "mvgStationId", "stationAreaId", "boardingStopId", "coordinate", "accessSeconds", "provenance"], path, issues);
  for (const field of ["seedId", "mvgStationId", "stationAreaId"] as const) if (typeof value[field] !== "string" || !value[field]) add([...path, field], "Seed identity is invalid.", issues);
  if (!wholeSecond(value.accessSeconds)) add([...path, "accessSeconds"], "Seed access time must be a non-negative whole second.", issues);
  if (value.boardingStopId !== undefined && (typeof value.boardingStopId !== "string" || !value.boardingStopId)) add([...path, "boardingStopId"], "Boarding stop identity is invalid.", issues);
  if (!object(value.coordinate)) add([...path, "coordinate"], "Seed coordinate is required.", issues); else { keys(value.coordinate, ["latitude", "longitude"], [...path, "coordinate"], issues); coordinate(value.coordinate, [...path, "coordinate"], issues); }
  if (!object(value.provenance)) return add([...path, "provenance"], "Seed provenance is required.", issues);
  keys(value.provenance, ["source", "endpoint", "distanceMeters", "walkingSeconds", "note"], [...path, "provenance"], issues);
  if (value.provenance.source !== "mvg-nearby" && value.provenance.source !== "fixture-static") add([...path, "provenance", "source"], "Seed provenance source is invalid.", issues);
  if (typeof value.provenance.endpoint !== "string" || typeof value.provenance.note !== "string" || !finite(value.provenance.distanceMeters) || !wholeSecond(value.provenance.walkingSeconds)) add([...path, "provenance"], "Seed provenance fields are invalid.", issues);
}

function metadataDto(value: Obj, request: MeetingRequest, issues: Issues): void {
  keys(value, ["schedule", "surface", "grid", "accessProvider", "coverage"], ["metadata"], issues);
  if (!object(value.schedule)) add(["metadata", "schedule"], "Schedule metadata is required.", issues); else scheduleDto(value.schedule, issues);
  if (!object(value.surface)) add(["metadata", "surface"], "Surface metadata is required.", issues); else surfaceDto(value.surface, request, issues);
  if (!object(value.grid)) add(["metadata", "grid"], "Grid metadata is required.", issues); else { keys(value.grid, ["columns", "rows", "cellCount", "geometry"], ["metadata", "grid"], issues); if (!integerAtLeast(value.grid.columns, 24) || !integerAtLeast(value.grid.rows, 16) || !integerAtLeast(value.grid.cellCount, 1) || value.grid.geometry !== "munich-clipped-surface-grid/v1") add(["metadata", "grid"], "Grid metadata is invalid.", issues); }
  if (!object(value.accessProvider)) add(["metadata", "accessProvider"], "Access provider metadata is required.", issues); else providerDto(value.accessProvider, ["metadata", "accessProvider"], issues);
  if (value.coverage !== "munich-clipped-scheduled-grid/v1") add(["metadata", "coverage"], "Coverage metadata is invalid.", issues);
}

function scheduleDto(value: Obj, issues: Issues): void {
  const path = ["metadata", "schedule"]; keys(value, ["contractVersion", "feedId", "timeZone", "scheduleContentHash", "compiledArtifactId", "serviceDateRange", "acquisition"], path, issues);
  if (value.contractVersion !== "meeet-scheduled-routing/v1" || typeof value.feedId !== "string" || value.timeZone !== TZ || !hash(value.scheduleContentHash) || !hash(value.compiledArtifactId)) add(path, "Schedule identity is invalid.", issues);
  if (!object(value.serviceDateRange)) add([...path, "serviceDateRange"], "Service date range is required.", issues); else { keys(value.serviceDateRange, ["firstDate", "lastDate"], [...path, "serviceDateRange"], issues); if (!date(value.serviceDateRange.firstDate) || !date(value.serviceDateRange.lastDate) || value.serviceDateRange.firstDate > value.serviceDateRange.lastDate) add([...path, "serviceDateRange"], "Service date range is invalid.", issues); }
  if (!object(value.acquisition)) add([...path, "acquisition"], "Schedule acquisition metadata is required.", issues); else acquisitionDto(value.acquisition, [...path, "acquisition"], issues);
}

function acquisitionDto(value: Obj, path: (string | number)[], issues: Issues): void {
  keys(value, ["sourceUrl", "retrievedAt", "rawArchiveByteSize", "rawArchiveSha256", "feedVersion", "feedValidFrom", "feedValidUntil", "attribution", "officialAttribution", "officialLicense", "officialProvenance"], path, issues);
  if (typeof value.sourceUrl !== "string" || typeof value.retrievedAt !== "string" || !integerAtLeast(value.rawArchiveByteSize, 0) || !hash(value.rawArchiveSha256) || typeof value.feedVersion !== "string" || !date(value.feedValidFrom) || !date(value.feedValidUntil) || typeof value.attribution !== "string" || typeof value.officialAttribution !== "string") add(path, "Acquisition metadata is invalid.", issues);
  if (!object(value.officialLicense)) add([...path, "officialLicense"], "Official license is required.", issues); else { keys(value.officialLicense, ["name", "url"], [...path, "officialLicense"], issues); if (typeof value.officialLicense.name !== "string" || typeof value.officialLicense.url !== "string") add([...path, "officialLicense"], "Official license is invalid.", issues); }
  if (!object(value.officialProvenance)) add([...path, "officialProvenance"], "Official provenance is required.", issues); else { keys(value.officialProvenance, ["source", "policyId"], [...path, "officialProvenance"], issues); if ((value.officialProvenance.source !== "feed" && value.officialProvenance.source !== "meeet-policy") || (value.officialProvenance.policyId !== null && value.officialProvenance.policyId !== "mvv-cc-by-4.0-fallback/v1")) add([...path, "officialProvenance"], "Official provenance is invalid.", issues); }
}

function surfaceDto(value: Obj, request: MeetingRequest, issues: Issues): void {
  const path = ["metadata", "surface"]; keys(value, ["contractVersion", "scheduleContentHash", "compiledArtifactId", "feedId", "timeZone", "searchStartAt", "routingHorizonSeconds", "selectedTolerancePercent", "walkingVelocityMetersPerSecond", "walkingSecondsRoundingRule", "transferRadiusMeters", "accessSeedCounts", "stationAreaCount", "boardingStopCount", "connectionCount", "coverage", "representativePointBasis", "classificationMethod", "classificationBasis", "finalWalkingMethod"], path, issues);
  if (value.contractVersion !== "meeet-scheduled-routing/v1" || !hash(value.scheduleContentHash) || !hash(value.compiledArtifactId) || typeof value.feedId !== "string" || value.timeZone !== TZ || value.searchStartAt !== request.searchStartAt || value.routingHorizonSeconds !== 86400 || !tolerance(value.selectedTolerancePercent) || value.selectedTolerancePercent !== request.tolerancePercent || !finitePositive(value.walkingVelocityMetersPerSecond) || typeof value.walkingSecondsRoundingRule !== "string" || !finitePositive(value.transferRadiusMeters) || !tupleNumbers(value.accessSeedCounts) || !integerAtLeast(value.stationAreaCount, 0) || !integerAtLeast(value.boardingStopCount, 0) || !integerAtLeast(value.connectionCount, 0) || value.coverage !== "scheduled-service-day-local-radius/v1" || value.representativePointBasis !== "inside-clipped-cell/v1" || value.classificationMethod !== "representative-point-with-geometric-final-station-walking/v1" || value.classificationBasis !== "representative-point" || value.finalWalkingMethod !== "geometric-station-walking-estimate-not-navigation") add(path, "Surface metadata is invalid or not bound to the request.", issues);
}

function providerDto(value: Obj, path: (string | number)[], issues: Issues): void {
  keys(value, ["name", "deployment", "dataKind", "liveData", "asOf", "notes", "provenance"], path, issues);
  if (typeof value.name !== "string" || !["fixture", "self-hosted", "managed", "unknown"].includes(String(value.deployment)) || !["demo-static", "unknown"].includes(String(value.dataKind)) || value.liveData !== false || typeof value.asOf !== "string" || typeof value.notes !== "string") add(path, "Access provider descriptor must describe non-live MVG seed access only.", issues);
  if (!object(value.provenance)) return add([...path, "provenance"], "Provider provenance is required.", issues);
  provenanceDto(value.provenance, [...path, "provenance"], issues);
  if (value.provenance.role !== "access") add([...path, "provenance", "role"], "Access provider provenance role must be access.", issues);
  if (value.provenance.deployment !== value.deployment) add([...path, "provenance", "deployment"], "Access provider provenance deployment must match the descriptor.", issues);
  if (value.provenance.dataKind !== value.dataKind) add([...path, "provenance", "dataKind"], "Access provider provenance dataKind must match the descriptor.", issues);
  if (value.provenance.liveData !== false || value.provenance.liveData !== value.liveData) add([...path, "provenance", "liveData"], "Access provider provenance liveData must be false and match the descriptor.", issues);
  if (value.provenance.version !== value.asOf) add([...path, "provenance", "version"], "Access provider provenance version must match descriptor asOf.", issues);
  if (value.provenance.notes !== value.notes) add([...path, "provenance", "notes"], "Access provider provenance notes must match the descriptor.", issues);
  if (value.provenance.feeds !== null) add([...path, "provenance", "feeds"], "Access provider provenance cannot claim schedule feeds.", issues);
}

function provenanceDto(value: Obj, path: (string | number)[], issues: Issues): void {
  keys(value, ["role", "provider", "deployment", "dataKind", "liveData", "sourceUrl", "license", "attribution", "version", "retrievedAt", "notes", "feeds"], path, issues);
  if (!["geocoding", "routing", "poi", "access"].includes(String(value.role)) || typeof value.provider !== "string" || typeof value.deployment !== "string" || typeof value.dataKind !== "string" || typeof value.liveData !== "boolean" || (value.sourceUrl !== null && typeof value.sourceUrl !== "string") || typeof value.attribution !== "string" || typeof value.version !== "string" || typeof value.retrievedAt !== "string" || typeof value.notes !== "string") add(path, "Provider provenance is invalid.", issues);
  if (value.license !== null && (!object(value.license) || typeof value.license.name !== "string" || typeof value.license.url !== "string")) add([...path, "license"], "Provider license is invalid.", issues);
  if (value.feeds !== null) add([...path, "feeds"], "Unexpected provider feeds are not accepted by the v3 client contract.", issues);
}

function cellDto(value: unknown, index: number, status: unknown, metadata: Obj | undefined, issues: Issues): void {
  const path = ["cells", index]; if (!object(value)) return add(path, "Cell must be an object.", issues); keys(value, ["id", "geometry", "representativePoint", "classification", "redArrivalSeconds", "blueArrivalSeconds", "fasterParticipant", "withinSelectedTolerance"], path, issues);
  if (typeof value.id !== "string" || !value.id) add([...path, "id"], "Cell id is invalid.", issues); if (!multiPolygon(value.geometry)) add([...path, "geometry"], "Cell geometry must be a valid MultiPolygon.", issues); if (!object(value.representativePoint) || !coordinate(value.representativePoint, [...path, "representativePoint"], issues)) add([...path, "representativePoint"], "Cell representative point is required.", issues);
  if (!isClassification(value.classification) || !nullableSecond(value.redArrivalSeconds) || !nullableSecond(value.blueArrivalSeconds) || (value.fasterParticipant !== null && value.fasterParticipant !== RED && value.fasterParticipant !== BLUE) || typeof value.withinSelectedTolerance !== "boolean") return add(path, "Cell fields are invalid.", issues);
  if (status === "no-result") { if (value.classification !== "unclassified" || value.redArrivalSeconds !== null || value.blueArrivalSeconds !== null || value.fasterParticipant !== null || value.withinSelectedTolerance) add(path, "No-result cells must be uniformly unclassified.", issues); return; }
  if (value.classification === "unclassified") { if (value.redArrivalSeconds !== null || value.blueArrivalSeconds !== null || value.fasterParticipant !== null || value.withinSelectedTolerance) add(path, "Unclassified cells cannot contain arrivals.", issues); return; }
  if (!metadata || !object(metadata.surface) || !tolerance(metadata.surface.selectedTolerancePercent)) return add(path, "Cell tolerance cannot be verified.", issues);
  const red = value.redArrivalSeconds; const blue = value.blueArrivalSeconds; if (red === null && blue === null) return add(path, "Classified cells need a reachable arrival.", issues);
  const fair = red !== null && blue !== null && Math.abs(red - blue) * 100 <= (red + blue) * metadata.surface.selectedTolerancePercent;
  const expected = fair ? "fair" : red !== null && (blue === null || red < blue) ? "red" : "blue";
  const faster = red !== null && blue !== null && red === blue ? null : red !== null && (blue === null || red < blue) ? RED : BLUE;
  if (value.classification !== expected || value.withinSelectedTolerance !== fair || value.fasterParticipant !== faster) add(path, "Cell classification contradicts arrival fields.", issues);
}

function multiPolygon(value: unknown): boolean { if (!object(value) || value.type !== "MultiPolygon" || !Array.isArray(value.coordinates) || !value.coordinates.length) return false; return value.coordinates.every((polygon) => Array.isArray(polygon) && polygon.length > 0 && polygon.every((ring) => Array.isArray(ring) && ring.length >= 4 && ring.every(position) && samePosition(ring[0], ring[ring.length - 1]))); }
function samePosition(a: unknown, b: unknown): boolean { return position(a) && position(b) && a[0] === b[0] && a[1] === b[1]; }
function position(value: unknown): value is [number, number] { return Array.isArray(value) && value.length === 2 && finite(value[0]) && finite(value[1]); }
function coordinate(value: Obj, path: (string | number)[], issues: Issues): boolean { if (!finite(value.latitude) || Number(value.latitude) < -90 || Number(value.latitude) > 90 || !finite(value.longitude) || Number(value.longitude) < -180 || Number(value.longitude) > 180) { add(path, "Coordinate is invalid.", issues); return false; } return true; }
function keys(value: Obj, allowed: readonly string[], path: (string | number)[], issues: Issues): void { Object.keys(value).filter((key) => !allowed.includes(key)).forEach((key) => add([...path, key], "Unknown response field.", issues)); }
function object(value: unknown): value is Obj { return typeof value === "object" && value !== null && !Array.isArray(value); }
function tuple(value: unknown): value is [unknown, unknown] { return Array.isArray(value) && value.length === 2; }
function tupleNumbers(value: unknown): value is [number, number] { return tuple(value) && value.every((item) => integerAtLeast(item, 0)); }
function wholeSecond(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function nullableSecond(value: unknown): value is number | null { return value === null || wholeSecond(value); }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function finitePositive(value: unknown): value is number { return finite(value) && value > 0; }
function integerAtLeast(value: unknown, minimum: number): value is number { return wholeSecond(value) && value >= minimum; }
function hash(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value); }
function date(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value); }
function tolerance(value: unknown): value is 5 | 10 | 15 { return value === 5 || value === 10 || value === 15; }
function isClassification(value: unknown): value is "red" | "blue" | "fair" | "unclassified" { return value === RED || value === BLUE || value === "fair" || value === "unclassified"; }
function add(path: readonly (string | number)[], message: string, issues: Issues): void { issues.push({ path, message }); }
function fail(path: readonly (string | number)[], message: string): ClientValidationResult { return { success: false, issues: [{ path, message }] }; }

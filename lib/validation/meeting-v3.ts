import { isWithinOfficialMunichBoundary } from "../domain/boundary.ts";
import { MEETING_TIME_ZONE } from "../domain/types.ts";
import { parseOffsetInstant } from "../domain/scheduled-routing/time.ts";
import type {
  GtfsAcquisitionRecord,
  ScheduledCellClassification,
  ScheduledSurfaceMetadata,
} from "../domain/scheduled-routing/models.ts";
import type { GeoJsonMultiPolygon, ProviderDescriptor } from "../domain/types.ts";
import { isScheduledInteriorRepresentativePoint } from "../domain/scheduled-routing/grid.ts";
import type { ScheduledAccessSeedProvenance } from "../domain/providers.ts";

export interface ScheduledMeetingParticipantInput {
  readonly id: string;
  readonly origin: {
    readonly label: string;
    readonly latitude: number;
    readonly longitude: number;
  };
  readonly mode: "transit";
}

export interface ScheduledMeetingRequest {
  readonly contractVersion: "meeet-meeting/v3";
  readonly participants: readonly [ScheduledMeetingParticipantInput, ScheduledMeetingParticipantInput];
  readonly tolerancePercent: 5 | 10 | 15;
  readonly searchStartAt: string;
}

export interface ScheduledValidationIssue {
  readonly path: Array<string | number>;
  readonly code: string;
  readonly message: string;
}

export type ScheduledRequestValidationResult =
  | { readonly success: true; readonly data: ScheduledMeetingRequest }
  | { readonly success: false; readonly issues: readonly ScheduledValidationIssue[] };

export interface ScheduledMeetingAccessSeedDto {
  readonly seedId: string;
  readonly mvgStationId: string;
  readonly stationAreaId: string;
  readonly boardingStopId?: string;
  readonly coordinate: { readonly latitude: number; readonly longitude: number };
  readonly accessSeconds: number;
  readonly provenance: ScheduledAccessSeedProvenance;
}

export interface ScheduledMeetingParticipantDto {
  readonly id: string;
  readonly color: "red" | "blue";
  readonly origin: ScheduledMeetingParticipantInput["origin"];
  readonly mode: "transit";
  readonly accessSeeds: readonly ScheduledMeetingAccessSeedDto[];
}

export interface ScheduledMeetingCellDto {
  readonly id: string;
  readonly geometry: GeoJsonMultiPolygon;
  readonly representativePoint: { readonly latitude: number; readonly longitude: number };
  readonly classification: ScheduledCellClassification;
  readonly redArrivalSeconds: number | null;
  readonly blueArrivalSeconds: number | null;
  readonly fasterParticipant: "red" | "blue" | null;
  readonly withinSelectedTolerance: boolean;
}

export interface ScheduledMeetingMetadataDto {
  readonly schedule: {
    readonly contractVersion: string;
    readonly feedId: string;
    readonly timeZone: string;
    readonly scheduleContentHash: string;
    readonly compiledArtifactId: string;
    readonly serviceDateRange: { readonly firstDate: string; readonly lastDate: string };
    readonly acquisition: GtfsAcquisitionRecord;
  };
  readonly surface: ScheduledSurfaceMetadata & {
    readonly classificationMethod: "representative-point-with-geometric-final-station-walking/v1";
    readonly classificationBasis: "representative-point";
    readonly representativePointBasis: "inside-clipped-cell/v1";
    readonly finalWalkingMethod: "geometric-station-walking-estimate-not-navigation";
  };
  readonly grid: {
    readonly columns: number;
    readonly rows: number;
    readonly cellCount: number;
    readonly geometry: "munich-clipped-surface-grid/v1";
  };
  readonly accessProvider: ProviderDescriptor;
  readonly coverage: "munich-clipped-scheduled-grid/v1";
}

export interface ScheduledMeetingResponseDto {
  readonly contractVersion: "meeet-meeting/v3";
  readonly status: "ok" | "no-result";
  readonly reason: "no-access-seeds" | "no-reachable-stations" | null;
  readonly participants: readonly [ScheduledMeetingParticipantDto, ScheduledMeetingParticipantDto];
  readonly cells: readonly ScheduledMeetingCellDto[];
  readonly metadata: ScheduledMeetingMetadataDto;
}

export type ScheduledMeetingResponse = ScheduledMeetingResponseDto;

export type ScheduledResponseValidationResult =
  | { readonly success: true; readonly data: ScheduledMeetingResponse }
  | { readonly success: false; readonly issues: readonly ScheduledValidationIssue[] };

const REQUEST_KEYS = ["contractVersion", "participants", "tolerancePercent", "searchStartAt"] as const;
const PARTICIPANT_KEYS = ["id", "origin", "mode"] as const;
const ORIGIN_KEYS = ["label", "latitude", "longitude"] as const;

export function parseScheduledMeetingRequest(input: unknown): ScheduledRequestValidationResult {
  const issues: ScheduledValidationIssue[] = [];
  if (!isRecord(input)) return failure([], "invalid_type", "Request body must be a JSON object.");
  addUnknownKeys(input, REQUEST_KEYS, [], issues);
  if (input.contractVersion !== "meeet-meeting/v3") issues.push(issue(["contractVersion"], "invalid_value", "contractVersion must be meeet-meeting/v3."));
  const tolerancePercent = parseTolerance(input.tolerancePercent, issues);
  const searchStartAt = parseSearchStartAt(input.searchStartAt, issues);
  const participantsValue = input.participants;
  const participants: ScheduledMeetingParticipantInput[] = [];
  if (!Array.isArray(participantsValue)) {
    issues.push(issue(["participants"], "invalid_type", "participants must contain exactly two participants."));
  } else {
    if (participantsValue.length !== 2) issues.push(issue(["participants"], "invalid_length", "participants must contain exactly two participants."));
    participantsValue.forEach((value, index) => {
      const participant = parseParticipant(value, index, issues);
      if (participant !== undefined) participants.push(participant);
    });
  }
  const ids = new Set<string>();
  participants.forEach((participant, index) => {
    if (ids.has(participant.id)) issues.push(issue(["participants", index, "id"], "duplicate", "Participant ids must be unique."));
    ids.add(participant.id);
  });
  if (issues.length > 0 || participants.length !== 2 || searchStartAt === undefined) return { success: false, issues };
  return {
    success: true,
    data: {
      contractVersion: "meeet-meeting/v3",
      participants: [participants[0]!, participants[1]!],
      tolerancePercent,
      searchStartAt,
    },
  };
}

export function validateScheduledMeetingResponse(input: unknown, request: ScheduledMeetingRequest): ScheduledResponseValidationResult {
  const issues: ScheduledValidationIssue[] = [];
  if (!isRecord(input)) return failure([], "invalid_type", "Scheduled meeting response must be an object.");
  addUnknownKeys(input, ["contractVersion", "status", "reason", "participants", "cells", "metadata"], [], issues);
  if (input.contractVersion !== "meeet-meeting/v3") issues.push(issue(["contractVersion"], "invalid_value", "Response contractVersion must be meeet-meeting/v3."));
  if (input.status !== "ok" && input.status !== "no-result") issues.push(issue(["status"], "invalid_enum", "Response status must be ok or no-result."));
  if (input.reason !== null && input.reason !== "no-access-seeds" && input.reason !== "no-reachable-stations") issues.push(issue(["reason"], "invalid_enum", "Response no-result reason is invalid."));
  if (!Array.isArray(input.participants) || input.participants.length !== 2) {
    issues.push(issue(["participants"], "invalid_length", "Response must contain exactly two participants."));
  } else {
    input.participants.forEach((participant, index) => validateResponseParticipant(participant, index, issues));
    if (input.participants[0] && isRecord(input.participants[0]) && input.participants[0].color !== "red") issues.push(issue(["participants", 0, "color"], "invalid_value", "The first participant must be red."));
    if (input.participants[1] && isRecord(input.participants[1]) && input.participants[1].color !== "blue") issues.push(issue(["participants", 1, "color"], "invalid_value", "The second participant must be blue."));
  }
  if (!Array.isArray(input.cells)) {
    issues.push(issue(["cells"], "invalid_type", "Response cells must be an array."));
  } else {
    input.cells.forEach((cell, index) => validateCell(cell, index, issues));
    const ids = input.cells.map((cell) => isRecord(cell) && typeof cell.id === "string" ? cell.id : "");
    if (new Set(ids).size !== ids.length || ids.some((id) => id === "")) issues.push(issue(["cells"], "duplicate", "Response cell ids must be unique and non-empty."));
    input.cells.forEach((cell, index) => validateCellInvariant(cell, index, issues));
  }
  if (!isRecord(input.metadata)) issues.push(issue(["metadata"], "invalid_type", "Response metadata must be an object."));
  else validateResponseMetadata(input.metadata, issues);
  if (isRecord(input.metadata)) validateResponseInvariants(input, input.metadata, request, issues);
  if (input.status === "ok" && input.reason !== null) issues.push(issue(["reason"], "invalid_value", "Successful responses must have a null no-result reason."));
  if (input.status === "no-result" && input.reason === null) issues.push(issue(["reason"], "required", "No-result responses must disclose a reason."));
  if (isRecord(input.metadata) && Array.isArray(input.cells) && typeof input.metadata.grid === "object" && input.metadata.grid !== null && "cellCount" in input.metadata.grid && input.metadata.grid.cellCount !== input.cells.length) issues.push(issue(["metadata", "grid", "cellCount"], "inconsistent", "Grid cellCount must equal serialized cell count."));
  if (issues.length > 0 || !isScheduledMeetingResponse(input)) {
    if (issues.length === 0) issues.push(issue([], "invalid_structure", "Scheduled meeting response structure is invalid."));
    return { success: false, issues };
  }
  return { success: true, data: input };
}

function parseParticipant(value: unknown, index: number, issues: ScheduledValidationIssue[]): ScheduledMeetingParticipantInput | undefined {
  const path = ["participants", index];
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Participant must be an object."));
    return undefined;
  }
  addUnknownKeys(value, PARTICIPANT_KEYS, path, issues);
  if (typeof value.id !== "string" || value.id.trim() === "" || value.id.length > 64) issues.push(issue([...path, "id"], "invalid_value", "id must be a non-empty string of at most 64 characters."));
  if (value.mode !== "transit") issues.push(issue([...path, "mode"], "invalid_enum", "mode must be transit."));
  const origin = parseOrigin(value.origin, path, issues);
  if (typeof value.id !== "string" || value.id.trim() === "" || value.id.length > 64 || value.mode !== "transit" || origin === undefined) return undefined;
  return { id: value.id.trim(), origin, mode: "transit" };
}

function parseOrigin(value: unknown, path: Array<string | number>, issues: ScheduledValidationIssue[]): ScheduledMeetingParticipantInput["origin"] | undefined {
  const originPath = [...path, "origin"];
  if (!isRecord(value)) {
    issues.push(issue(originPath, "invalid_type", "origin must be an object."));
    return undefined;
  }
  addUnknownKeys(value, ORIGIN_KEYS, originPath, issues);
  const label = value.label;
  const latitude = value.latitude;
  const longitude = value.longitude;
  if (typeof label !== "string" || label.trim() === "" || label.length > 120) issues.push(issue([...originPath, "label"], "invalid_value", "origin.label must be a non-empty string of at most 120 characters."));
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) issues.push(issue([...originPath, "latitude"], "invalid_value", "origin.latitude must be a finite latitude."));
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) issues.push(issue([...originPath, "longitude"], "invalid_value", "origin.longitude must be a finite longitude."));
  if (typeof label !== "string" || label.trim() === "" || label.length > 120 || typeof latitude !== "number" || !Number.isFinite(latitude) || typeof longitude !== "number" || !Number.isFinite(longitude) || !isWithinOfficialMunichBoundary({ latitude, longitude })) {
    if (typeof latitude === "number" && Number.isFinite(latitude) && typeof longitude === "number" && Number.isFinite(longitude) && !isWithinOfficialMunichBoundary({ latitude, longitude })) issues.push(issue(originPath, "outside_official_munich_boundary", "origin must be inside the official Munich application boundary."));
    return undefined;
  }
  return { label: label.trim(), latitude, longitude };
}

function parseTolerance(value: unknown, issues: ScheduledValidationIssue[]): 5 | 10 | 15 {
  if (value !== 5 && value !== 10 && value !== 15) {
    issues.push(issue(["tolerancePercent"], "invalid_enum", "tolerancePercent must be 5, 10, or 15."));
    return 10;
  }
  return value;
}

function parseSearchStartAt(value: unknown, issues: ScheduledValidationIssue[]): string | undefined {
  const fractionalMatch = typeof value === "string" ? /\.(\d+)(?=(?:Z|[+-]\d{2}:\d{2})$)/.exec(value) : null;
  if (typeof value !== "string" || (fractionalMatch !== null && /[1-9]/.test(fractionalMatch[1] ?? ""))) {
    issues.push(issue(["searchStartAt"], "invalid_datetime", "searchStartAt must be an offset-aware ISO instant with whole-second precision."));
    return undefined;
  }
  try {
    return parseOffsetInstant(value, MEETING_TIME_ZONE).canonicalAt;
  } catch {
    issues.push(issue(["searchStartAt"], "invalid_datetime", "searchStartAt must be an offset-aware ISO instant with whole-second precision."));
    return undefined;
  }
}

function validateCell(value: unknown, index: number, issues: ScheduledValidationIssue[]): void {
  const path = ["cells", index];
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Cell must be an object."));
    return;
  }
  addUnknownKeys(value, ["id", "geometry", "representativePoint", "classification", "redArrivalSeconds", "blueArrivalSeconds", "fasterParticipant", "withinSelectedTolerance"], path, issues);
  if (typeof value.id !== "string" || value.id.trim() === "") issues.push(issue([...path, "id"], "invalid_value", "Cell id must be non-empty."));
  if (!isMultiPolygon(value.geometry)) issues.push(issue([...path, "geometry"], "invalid_geometry", "Cell geometry must be a valid non-empty GeoJSON MultiPolygon."));
  if (!isCoordinate(value.representativePoint)) issues.push(issue([...path, "representativePoint"], "invalid_coordinate", "Cell representativePoint must be a valid coordinate."));
  else if (isMultiPolygon(value.geometry) && !isScheduledInteriorRepresentativePoint(value.representativePoint, value.geometry)) issues.push(issue([...path, "representativePoint"], "invalid_coordinate", "Cell representativePoint must be strictly inside its clipped geometry."));
  if (value.classification !== "red" && value.classification !== "blue" && value.classification !== "fair" && value.classification !== "unclassified") issues.push(issue([...path, "classification"], "invalid_enum", "Cell classification is invalid."));
  if (!isNullableWholeSecond(value.redArrivalSeconds)) issues.push(issue([...path, "redArrivalSeconds"], "invalid_value", "redArrivalSeconds must be a whole second or null."));
  if (!isNullableWholeSecond(value.blueArrivalSeconds)) issues.push(issue([...path, "blueArrivalSeconds"], "invalid_value", "blueArrivalSeconds must be a whole second or null."));
  if (value.fasterParticipant !== null && value.fasterParticipant !== "red" && value.fasterParticipant !== "blue") issues.push(issue([...path, "fasterParticipant"], "invalid_enum", "fasterParticipant is invalid."));
  if (typeof value.withinSelectedTolerance !== "boolean") issues.push(issue([...path, "withinSelectedTolerance"], "invalid_type", "withinSelectedTolerance must be boolean."));
}

function validateCellInvariant(value: unknown, index: number, issues: ScheduledValidationIssue[]): void {
  if (!isRecord(value)) return;
  const classification = value.classification;
  const red = value.redArrivalSeconds;
  const blue = value.blueArrivalSeconds;
  const fair = classification === "fair";
  const bothReachable = isWholeSecond(red) && isWholeSecond(blue);
  if (classification === "unclassified" && (red !== null || blue !== null)) issues.push(issue(["cells", index], "inconsistent", "Unclassified cells must have no arrival fields."));
  if (classification !== "unclassified" && red === null && blue === null) issues.push(issue(["cells", index], "inconsistent", "Classified cells must expose at least one reachable arrival field."));
  if (classification === "fair" && !bothReachable) issues.push(issue(["cells", index], "inconsistent", "Fair cells must expose both participant arrival fields."));
  if (fair !== (value.withinSelectedTolerance === true)) issues.push(issue(["cells", index], "inconsistent", "withinSelectedTolerance must match fair classification."));
}

function validateResponseInvariants(value: Record<string, unknown>, metadata: Record<string, unknown>, request: ScheduledMeetingRequest, issues: ScheduledValidationIssue[]): void {
  const schedule = metadata.schedule;
  const surface = metadata.surface;
  if (!isRecord(schedule) || !isRecord(surface)) return;

  for (const field of ["feedId", "scheduleContentHash", "compiledArtifactId", "timeZone"] as const) {
    const scheduleValue = field === "scheduleContentHash" ? schedule.scheduleContentHash : schedule[field];
    const surfaceValue = surface[field];
    if (typeof scheduleValue === "string" && typeof surfaceValue === "string" && scheduleValue !== surfaceValue) {
      issues.push(issue(["metadata", "surface", field], "inconsistent", `Surface ${field} must match schedule ${field}.`));
    }
  }

  if (surface.searchStartAt !== request.searchStartAt) issues.push(issue(["metadata", "surface", "searchStartAt"], "inconsistent", "Surface searchStartAt must match the parsed scheduled request."));
  if (surface.selectedTolerancePercent !== request.tolerancePercent) issues.push(issue(["metadata", "surface", "selectedTolerancePercent"], "inconsistent", "Surface selectedTolerancePercent must match the parsed scheduled request."));

  if (typeof surface.searchStartAt !== "string" || typeof surface.timeZone !== "string") {
    return;
  }
  try {
    const parsed = parseOffsetInstant(surface.searchStartAt, surface.timeZone);
    if (parsed.canonicalAt !== surface.searchStartAt) issues.push(issue(["metadata", "surface", "searchStartAt"], "inconsistent", "Surface searchStartAt must use its canonical whole-second UTC representation."));
  } catch {
    issues.push(issue(["metadata", "surface", "searchStartAt"], "invalid_datetime", "Surface searchStartAt must be an offset-aware ISO instant with whole-second precision."));
  }

  if (Array.isArray(value.participants) && value.participants.length === 2 && Array.isArray(surface.accessSeedCounts) && surface.accessSeedCounts.length === 2) {
    const firstParticipant = value.participants[0];
    const secondParticipant = value.participants[1];
    const firstCount = surface.accessSeedCounts[0];
    const secondCount = surface.accessSeedCounts[1];
    if (isRecord(firstParticipant) && Array.isArray(firstParticipant.accessSeeds) && typeof firstCount === "number" && firstParticipant.accessSeeds.length !== firstCount) issues.push(issue(["metadata", "surface", "accessSeedCounts", 0], "inconsistent", "The red access-seed count must match serialized red access seeds."));
    if (isRecord(secondParticipant) && Array.isArray(secondParticipant.accessSeeds) && typeof secondCount === "number" && secondParticipant.accessSeeds.length !== secondCount) issues.push(issue(["metadata", "surface", "accessSeedCounts", 1], "inconsistent", "The blue access-seed count must match serialized blue access seeds."));
  }

  const tolerance = surface.selectedTolerancePercent;
  if (!isSelectedTolerance(tolerance) || !Array.isArray(value.cells)) return;
  value.cells.forEach((cell, index) => validateDerivedCellInvariant(cell, index, value.status, tolerance, issues));
}

function validateDerivedCellInvariant(value: unknown, index: number, status: unknown, tolerancePercent: 5 | 10 | 15, issues: ScheduledValidationIssue[]): void {
  if (!isRecord(value)) return;
  const path = ["cells", index];
  const classification = value.classification;
  const red = value.redArrivalSeconds;
  const blue = value.blueArrivalSeconds;
  const fasterParticipant = value.fasterParticipant;
  const withinSelectedTolerance = value.withinSelectedTolerance;

  if (status === "no-result") {
    if (classification !== "unclassified" || red !== null || blue !== null || fasterParticipant !== null || withinSelectedTolerance !== false) {
      issues.push(issue(path, "inconsistent", "No-result cells must be unclassified with null arrivals, no faster participant, and false tolerance."));
    }
    return;
  }

  if (!isNullableWholeSecond(red) || !isNullableWholeSecond(blue)) return;
  let expectedClassification: ScheduledCellClassification = "unclassified";
  let expectedFasterParticipant: "red" | "blue" | null = null;
  let expectedWithinSelectedTolerance = false;
  if (isWholeSecond(red) && isWholeSecond(blue)) {
    expectedWithinSelectedTolerance = isToleranceSatisfied(red, blue, tolerancePercent);
    expectedClassification = expectedWithinSelectedTolerance ? "fair" : red < blue ? "red" : "blue";
    expectedFasterParticipant = red === blue ? null : red < blue ? "red" : "blue";
  } else if (isWholeSecond(red)) {
    expectedClassification = "red";
    expectedFasterParticipant = "red";
  } else if (isWholeSecond(blue)) {
    expectedClassification = "blue";
    expectedFasterParticipant = "blue";
  }
  if (classification !== expectedClassification || fasterParticipant !== expectedFasterParticipant || withinSelectedTolerance !== expectedWithinSelectedTolerance) {
    issues.push(issue(path, "inconsistent", "Cell classification, faster participant, and tolerance flag must be derived from its arrival fields."));
  }
}

function validateResponseParticipant(value: unknown, index: number, issues: ScheduledValidationIssue[]): void {
  const path = ["participants", index];
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Response participant must be an object."));
    return;
  }
  addUnknownKeys(value, ["id", "color", "origin", "mode", "accessSeeds"], path, issues);
  if (typeof value.id !== "string" || value.id.trim() === "") issues.push(issue([...path, "id"], "invalid_value", "Response participant id must be non-empty."));
  if (value.color !== "red" && value.color !== "blue") issues.push(issue([...path, "color"], "invalid_enum", "Response participant color must be red or blue."));
  if (value.mode !== "transit") issues.push(issue([...path, "mode"], "invalid_enum", "Response participant mode must be transit."));
  if (!isRecord(value.origin)) {
    issues.push(issue([...path, "origin"], "invalid_type", "Response participant origin must be an object."));
  } else if (typeof value.origin.label !== "string" || typeof value.origin.latitude !== "number" || typeof value.origin.longitude !== "number") {
    issues.push(issue([...path, "origin"], "invalid_value", "Response participant origin is invalid."));
  }
  if (!Array.isArray(value.accessSeeds)) {
    issues.push(issue([...path, "accessSeeds"], "invalid_type", "Response participant accessSeeds must be an array."));
  } else {
    value.accessSeeds.forEach((seed, seedIndex) => {
      const seedPath = [...path, "accessSeeds", seedIndex];
      if (isRecord(seed)) addUnknownKeys(seed, ["seedId", "mvgStationId", "stationAreaId", "boardingStopId", "coordinate", "accessSeconds", "provenance"], seedPath, issues);
      if (!isRecord(seed) || typeof seed.seedId !== "string" || seed.seedId.trim() === "" || typeof seed.mvgStationId !== "string" || seed.mvgStationId.trim() === "" || typeof seed.stationAreaId !== "string" || seed.stationAreaId.trim() === "" || (seed.boardingStopId !== undefined && (typeof seed.boardingStopId !== "string" || seed.boardingStopId.trim() === "")) || !isWholeSecond(seed.accessSeconds) || !isRecord(seed.coordinate) || !isCoordinate(seed.coordinate) || !isRecord(seed.provenance) || (seed.provenance.source !== "mvg-nearby" && seed.provenance.source !== "fixture-static") || typeof seed.provenance.endpoint !== "string" || typeof seed.provenance.distanceMeters !== "number" || !Number.isFinite(seed.provenance.distanceMeters) || seed.provenance.distanceMeters < 0 || !isWholeSecond(seed.provenance.walkingSeconds) || typeof seed.provenance.note !== "string") {
        issues.push(issue(seedPath, "invalid_value", "Response access seed provenance is invalid."));
      }
      if (isRecord(seed?.coordinate)) addUnknownKeys(seed.coordinate, ["latitude", "longitude"], [...seedPath, "coordinate"], issues);
      if (isRecord(seed?.provenance)) addUnknownKeys(seed.provenance, ["source", "endpoint", "distanceMeters", "walkingSeconds", "note"], [...seedPath, "provenance"], issues);
    });
  }
}

function validateResponseMetadata(value: Record<string, unknown>, issues: ScheduledValidationIssue[]): void {
  const path = ["metadata"];
  addUnknownKeys(value, ["schedule", "surface", "grid", "accessProvider", "coverage"], path, issues);
  const schedule = value.schedule;
  if (isRecord(schedule)) addUnknownKeys(schedule, ["contractVersion", "feedId", "timeZone", "scheduleContentHash", "compiledArtifactId", "serviceDateRange", "acquisition"], [...path, "schedule"], issues);
  if (isRecord(schedule) && isRecord(schedule.serviceDateRange)) addUnknownKeys(schedule.serviceDateRange, ["firstDate", "lastDate"], [...path, "schedule", "serviceDateRange"], issues);
  if (isRecord(schedule) && isRecord(schedule.acquisition)) {
    const acquisitionPath = [...path, "schedule", "acquisition"];
    addUnknownKeys(schedule.acquisition, ["sourceUrl", "retrievedAt", "rawArchiveByteSize", "rawArchiveSha256", "feedVersion", "feedValidFrom", "feedValidUntil", "attribution", "officialAttribution", "officialLicense", "officialProvenance"], acquisitionPath, issues);
    if (isRecord(schedule.acquisition.officialLicense)) addUnknownKeys(schedule.acquisition.officialLicense, ["name", "url"], [...acquisitionPath, "officialLicense"], issues);
    if (isRecord(schedule.acquisition.officialProvenance)) addUnknownKeys(schedule.acquisition.officialProvenance, ["source", "policyId"], [...acquisitionPath, "officialProvenance"], issues);
  }
  if (isRecord(value.surface)) addUnknownKeys(value.surface, ["contractVersion", "scheduleContentHash", "compiledArtifactId", "feedId", "timeZone", "searchStartAt", "routingHorizonSeconds", "selectedTolerancePercent", "walkingVelocityMetersPerSecond", "walkingSecondsRoundingRule", "transferRadiusMeters", "accessSeedCounts", "stationAreaCount", "boardingStopCount", "connectionCount", "coverage", "representativePointBasis", "classificationMethod", "classificationBasis", "finalWalkingMethod"], [...path, "surface"], issues);
  if (isRecord(value.grid)) addUnknownKeys(value.grid, ["columns", "rows", "cellCount", "geometry"], [...path, "grid"], issues);
  if (isRecord(value.accessProvider)) {
    const providerPath = [...path, "accessProvider"];
    addUnknownKeys(value.accessProvider, ["name", "deployment", "dataKind", "liveData", "asOf", "notes", "provenance"], providerPath, issues);
    if (isRecord(value.accessProvider.provenance)) addUnknownKeys(value.accessProvider.provenance, ["role", "provider", "deployment", "dataKind", "liveData", "sourceUrl", "license", "attribution", "version", "retrievedAt", "notes", "feeds"], [...providerPath, "provenance"], issues);
    if (!isScheduledAccessProviderDescriptor(value.accessProvider)) issues.push(issue(providerPath, "invalid_value", "Access provider metadata must describe non-live nearby access, not scheduled routing."));
  }
}

function isScheduledMeetingResponse(value: unknown): value is ScheduledMeetingResponseDto {
  if (!isRecord(value)) return false;
  return value.contractVersion === "meeet-meeting/v3" &&
    (value.status === "ok" || value.status === "no-result") &&
    (value.reason === null || value.reason === "no-access-seeds" || value.reason === "no-reachable-stations") &&
    Array.isArray(value.participants) && value.participants.length === 2 &&
    isScheduledParticipantDto(value.participants[0]) && isScheduledParticipantDto(value.participants[1]) &&
    Array.isArray(value.cells) && value.cells.every(isScheduledCellDto) &&
    isScheduledMetadataDto(value.metadata);
}

function isScheduledParticipantDto(value: unknown): value is ScheduledMeetingParticipantDto {
  return isRecord(value) && typeof value.id === "string" && (value.color === "red" || value.color === "blue") && value.mode === "transit" && isRecord(value.origin) && typeof value.origin.label === "string" && typeof value.origin.latitude === "number" && typeof value.origin.longitude === "number" && Array.isArray(value.accessSeeds) && value.accessSeeds.every(isScheduledSeedDto);
}

function isScheduledSeedDto(value: unknown): value is ScheduledMeetingAccessSeedDto {
  return isRecord(value) && typeof value.seedId === "string" && value.seedId.trim() !== "" && typeof value.mvgStationId === "string" && value.mvgStationId.trim() !== "" && typeof value.stationAreaId === "string" && value.stationAreaId.trim() !== "" && (value.boardingStopId === undefined || (typeof value.boardingStopId === "string" && value.boardingStopId.trim() !== "")) && isWholeSecond(value.accessSeconds) && isCoordinate(value.coordinate) && isRecord(value.provenance) && (value.provenance.source === "mvg-nearby" || value.provenance.source === "fixture-static") && typeof value.provenance.endpoint === "string" && typeof value.provenance.distanceMeters === "number" && Number.isFinite(value.provenance.distanceMeters) && value.provenance.distanceMeters >= 0 && isWholeSecond(value.provenance.walkingSeconds) && typeof value.provenance.note === "string";
}

function isScheduledCellDto(value: unknown): value is ScheduledMeetingCellDto {
  return isRecord(value) && typeof value.id === "string" && isMultiPolygon(value.geometry) && isCoordinate(value.representativePoint) && isScheduledInteriorRepresentativePoint(value.representativePoint, value.geometry) && (value.classification === "red" || value.classification === "blue" || value.classification === "fair" || value.classification === "unclassified") && isNullableWholeSecond(value.redArrivalSeconds) && isNullableWholeSecond(value.blueArrivalSeconds) && (value.fasterParticipant === null || value.fasterParticipant === "red" || value.fasterParticipant === "blue") && typeof value.withinSelectedTolerance === "boolean";
}

function isScheduledMetadataDto(value: unknown): value is ScheduledMeetingMetadataDto {
  if (!isRecord(value) || !isRecord(value.schedule) || !isRecord(value.surface) || !isRecord(value.grid) || !isScheduledAccessProviderDescriptor(value.accessProvider)) return false;
  return value.coverage === "munich-clipped-scheduled-grid/v1" &&
    typeof value.schedule.contractVersion === "string" && typeof value.schedule.feedId === "string" && value.schedule.timeZone === MEETING_TIME_ZONE && typeof value.schedule.scheduleContentHash === "string" && typeof value.schedule.compiledArtifactId === "string" && isDateRange(value.schedule.serviceDateRange) && isAcquisition(value.schedule.acquisition) &&
    value.surface.classificationMethod === "representative-point-with-geometric-final-station-walking/v1" && value.surface.classificationBasis === "representative-point" && value.surface.representativePointBasis === "inside-clipped-cell/v1" && value.surface.finalWalkingMethod === "geometric-station-walking-estimate-not-navigation" && isSurfaceMetadata(value.surface) &&
    typeof value.grid.columns === "number" && Number.isSafeInteger(value.grid.columns) && typeof value.grid.rows === "number" && Number.isSafeInteger(value.grid.rows) && typeof value.grid.cellCount === "number" && Number.isSafeInteger(value.grid.cellCount) && value.grid.columns >= 24 && value.grid.rows >= 16 && value.grid.cellCount > 0 && value.grid.geometry === "munich-clipped-surface-grid/v1";
}

function isSurfaceMetadata(value: unknown): value is ScheduledMeetingMetadataDto["surface"] {
  if (!isRecord(value)) return false;
  return value.contractVersion === "meeet-scheduled-routing/v1" && typeof value.scheduleContentHash === "string" && typeof value.compiledArtifactId === "string" && typeof value.feedId === "string" && value.timeZone === MEETING_TIME_ZONE && typeof value.searchStartAt === "string" && value.routingHorizonSeconds === 86_400 && (value.selectedTolerancePercent === 5 || value.selectedTolerancePercent === 10 || value.selectedTolerancePercent === 15) && typeof value.walkingVelocityMetersPerSecond === "number" && typeof value.walkingSecondsRoundingRule === "string" && typeof value.transferRadiusMeters === "number" && Array.isArray(value.accessSeedCounts) && value.accessSeedCounts.length === 2 && value.accessSeedCounts.every((count) => Number.isSafeInteger(count) && count >= 0) && Number.isSafeInteger(value.stationAreaCount) && Number.isSafeInteger(value.boardingStopCount) && Number.isSafeInteger(value.connectionCount) && value.coverage === "scheduled-service-day-local-radius/v1" && value.representativePointBasis === "inside-clipped-cell/v1";
}

function isProviderDescriptor(value: unknown): value is ProviderDescriptor {
  return isRecord(value) && typeof value.name === "string" && (value.deployment === "fixture" || value.deployment === "self-hosted" || value.deployment === "managed" || value.deployment === "unknown") && (value.dataKind === "demo-static" || value.dataKind === "scheduled" || value.dataKind === "access" || value.dataKind === "live" || value.dataKind === "unknown") && typeof value.liveData === "boolean" && typeof value.asOf === "string" && typeof value.notes === "string" && isRecord(value.provenance);
}

function isScheduledAccessProviderDescriptor(value: unknown): value is ProviderDescriptor {
  if (!isProviderDescriptor(value)) return false;
  const provenance = value.provenance;
  return value.liveData === false &&
    (value.dataKind === "access" || value.dataKind === "demo-static") &&
    isRecord(provenance) &&
    provenance.role === "access" &&
    typeof provenance.provider === "string" &&
    provenance.deployment === value.deployment &&
    provenance.dataKind === value.dataKind &&
    provenance.liveData === false &&
    (provenance.sourceUrl === null || typeof provenance.sourceUrl === "string") &&
    (provenance.license === null || (isRecord(provenance.license) && typeof provenance.license.name === "string" && typeof provenance.license.url === "string")) &&
    typeof provenance.attribution === "string" &&
    typeof provenance.version === "string" &&
    typeof provenance.retrievedAt === "string" &&
    typeof provenance.notes === "string" &&
    provenance.version === value.asOf &&
    provenance.notes === value.notes &&
    provenance.feeds === null;
}

function isAcquisition(value: unknown): value is GtfsAcquisitionRecord {
  return isRecord(value) && typeof value.sourceUrl === "string" && typeof value.retrievedAt === "string" && typeof value.rawArchiveByteSize === "number" && Number.isSafeInteger(value.rawArchiveByteSize) && value.rawArchiveByteSize >= 0 && typeof value.rawArchiveSha256 === "string" && typeof value.feedVersion === "string" && isDateString(value.feedValidFrom) && isDateString(value.feedValidUntil) && typeof value.attribution === "string" && typeof value.officialAttribution === "string" && isRecord(value.officialLicense) && typeof value.officialLicense.name === "string" && typeof value.officialLicense.url === "string" && isRecord(value.officialProvenance) && (value.officialProvenance.source === "feed" || value.officialProvenance.source === "meeet-policy") && (value.officialProvenance.policyId === null || value.officialProvenance.policyId === "mvv-cc-by-4.0-fallback/v1");
}

function isDateRange(value: unknown): value is { readonly firstDate: string; readonly lastDate: string } {
  return isRecord(value) && isDateString(value.firstDate) && isDateString(value.lastDate) && value.firstDate <= value.lastDate;
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isCoordinate(value: unknown): value is { readonly latitude: number; readonly longitude: number } {
  return isRecord(value) && typeof value.latitude === "number" && Number.isFinite(value.latitude) && value.latitude >= -90 && value.latitude <= 90 && typeof value.longitude === "number" && Number.isFinite(value.longitude) && value.longitude >= -180 && value.longitude <= 180;
}

function isMultiPolygon(value: unknown): value is GeoJsonMultiPolygon {
  if (!isRecord(value) || value.type !== "MultiPolygon" || !Array.isArray(value.coordinates) || value.coordinates.length === 0) return false;
  return value.coordinates.every((polygon) => {
    if (!Array.isArray(polygon) || polygon.length === 0) return false;
    return polygon.every((ring) => {
      if (!Array.isArray(ring) || ring.length < 4) return false;
      const positions = ring.filter(isGeoJsonPosition);
      const first = positions[0];
      const last = positions[positions.length - 1];
      return positions.length === ring.length && first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1];
    });
  });
}

function isGeoJsonPosition(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && Number.isFinite(value[0]) && typeof value[1] === "number" && Number.isFinite(value[1]);
}

function isNullableWholeSecond(value: unknown): value is number | null {
  return value === null || isWholeSecond(value);
}

function isWholeSecond(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSelectedTolerance(value: unknown): value is 5 | 10 | 15 {
  return value === 5 || value === 10 || value === 15;
}

function isToleranceSatisfied(firstElapsedSeconds: number, secondElapsedSeconds: number, tolerancePercent: 5 | 10 | 15): boolean {
  return Math.abs(firstElapsedSeconds - secondElapsedSeconds) * 100 <= (firstElapsedSeconds + secondElapsedSeconds) * tolerancePercent;
}

function addUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: Array<string | number>, issues: ScheduledValidationIssue[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(issue([...path, key], "unknown_key", `Unknown field ${key} is not allowed.`));
}

function issue(path: Array<string | number>, code: string, message: string): ScheduledValidationIssue {
  return { path, code, message };
}

function failure(path: Array<string | number>, code: string, message: string): ScheduledRequestValidationResult & ScheduledResponseValidationResult {
  return { success: false, issues: [issue(path, code, message)] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { isWithinOfficialMunichBoundary } from "../domain/boundary.ts";
import { MEETING_TIME_ZONE } from "../domain/types.ts";
import { parseSearchStartInstant } from "../domain/scheduled-routing/time.ts";
import {
  CHANGE_TIME_PRESETS,
  type GtfsAcquisitionRecord,
  type ScheduledStationAreaClassification,
  type ScheduledChangeTimePreset,
  type ScheduledDeadlineCheck,
  type ScheduledSurfaceMetadata,
  type ScheduledStationAreaCatalog,
  type ScheduledStationAreaMetadata,
  type StationAreaMode,
} from "../domain/scheduled-routing/models.ts";
import type { ProviderDescriptor } from "../domain/types.ts";
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
  readonly changeTimePreset: ScheduledChangeTimePreset;
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

export interface ScheduledMeetingStationAreaDto {
  readonly stationAreaId: string;
  readonly name: string;
  readonly coordinate: { readonly latitude: number; readonly longitude: number };
  readonly mode: StationAreaMode;
  readonly classification: ScheduledStationAreaClassification;
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
    readonly classificationMethod: "scheduled-arrival-comparison-with-selected-tolerance/v1";
    readonly classificationBasis: "scheduled-station-area-arrival/v1";
    readonly representativePointBasis: "station-area-coordinate/v1";
    readonly finalWalkingMethod: "scheduled-access-and-transfer-walking/v1";
  };
  readonly stationAreas: ScheduledStationAreaMetadata;
  readonly accessProvider: ProviderDescriptor;
  readonly coverage: "munich-scheduled-station-area-meeting/v1";
  readonly origins: { readonly coverage: "globally-valid-origin/v1" };
}

export interface ScheduledMeetingResponseDto {
  readonly contractVersion: "meeet-meeting/v3";
  readonly status: "ok" | "no-result";
  readonly reason: "no-access-seeds" | "no-reachable-stations" | null;
  readonly participants: readonly [ScheduledMeetingParticipantDto, ScheduledMeetingParticipantDto];
  readonly stationAreas: readonly ScheduledMeetingStationAreaDto[];
  readonly metadata: ScheduledMeetingMetadataDto;
}

export type ScheduledMeetingResponse = ScheduledMeetingResponseDto;

export type ScheduledResponseValidationResult =
  | { readonly success: true; readonly data: ScheduledMeetingResponse }
  | { readonly success: false; readonly issues: readonly ScheduledValidationIssue[] };

export interface ScheduledMeetingResponseValidationContext {
  readonly stationAreaCatalog?: ScheduledStationAreaCatalog;
  readonly deadlineCheck?: ScheduledDeadlineCheck;
}

const REQUEST_KEYS = ["contractVersion", "participants", "tolerancePercent", "changeTimePreset", "searchStartAt"] as const;
const PARTICIPANT_KEYS = ["id", "origin", "mode"] as const;
const ORIGIN_KEYS = ["label", "latitude", "longitude"] as const;

export function parseScheduledMeetingRequest(input: unknown): ScheduledRequestValidationResult {
  const issues: ScheduledValidationIssue[] = [];
  if (!isRecord(input)) return failure([], "invalid_type", "Request body must be a JSON object.");
  addUnknownKeys(input, REQUEST_KEYS, [], issues);
  if (input.contractVersion !== "meeet-meeting/v3") issues.push(issue(["contractVersion"], "invalid_value", "contractVersion must be meeet-meeting/v3."));
  const tolerancePercent = parseTolerance(input.tolerancePercent, issues);
  const changeTimePreset = parseChangeTimePreset(input.changeTimePreset, issues);
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
      changeTimePreset,
      searchStartAt,
    },
  };
}

export function validateScheduledMeetingResponse(
  input: unknown,
  request: ScheduledMeetingRequest,
  context: ScheduledMeetingResponseValidationContext = {},
): ScheduledResponseValidationResult {
  const issues: ScheduledValidationIssue[] = [];
  if (!isRecord(input)) return failure([], "invalid_type", "Scheduled meeting response must be an object.");
  addUnknownKeys(input, ["contractVersion", "status", "reason", "participants", "stationAreas", "metadata"], [], issues);
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
  if (!Array.isArray(input.stationAreas)) {
    issues.push(issue(["stationAreas"], "invalid_type", "Response stationAreas must be an array."));
  } else {
    input.stationAreas.forEach((candidate, index) => validateStationArea(candidate, index, issues));
    const ids = input.stationAreas.map((candidate) => isRecord(candidate) && typeof candidate.stationAreaId === "string" ? candidate.stationAreaId : "");
    if (new Set(ids).size !== ids.length || ids.some((id) => id === "")) issues.push(issue(["stationAreas"], "duplicate", "Response stationAreaIds must be unique and non-empty."));
  }
  if (!isRecord(input.metadata)) issues.push(issue(["metadata"], "invalid_type", "Response metadata must be an object."));
  else validateResponseMetadata(input.metadata, issues);
  if (isRecord(input.metadata)) validateResponseInvariants(input, input.metadata, request, issues, context.deadlineCheck);
  if (context.stationAreaCatalog !== undefined) validateStationAreaCatalog(input, context.stationAreaCatalog, issues, context.deadlineCheck);
  if (input.status === "ok" && input.reason !== null) issues.push(issue(["reason"], "invalid_value", "Successful responses must have a null no-result reason."));
  if (input.status === "no-result" && input.reason === null) issues.push(issue(["reason"], "required", "No-result responses must disclose a reason."));
  if (isRecord(input.metadata) && Array.isArray(input.stationAreas) && isRecord(input.metadata.stationAreas) && input.metadata.stationAreas.count !== input.stationAreas.length) issues.push(issue(["metadata", "stationAreas", "count"], "inconsistent", "Station-area count must equal serialized station-area count."));
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
  if (typeof label !== "string" || label.trim() === "" || label.length > 120 || typeof latitude !== "number" || !Number.isFinite(latitude) || typeof longitude !== "number" || !Number.isFinite(longitude)) {
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

function parseChangeTimePreset(value: unknown, issues: ScheduledValidationIssue[]): ScheduledChangeTimePreset {
  if (value !== "quick" && value !== "medium" && value !== "long") {
    issues.push(issue(["changeTimePreset"], "invalid_enum", "changeTimePreset must be quick, medium, or long."));
    return "medium";
  }
  return value;
}

function effectiveChangeTimeSeconds(preset: ScheduledChangeTimePreset): number {
  return CHANGE_TIME_PRESETS[preset];
}

function parseSearchStartAt(value: unknown, issues: ScheduledValidationIssue[]): string | undefined {
  const fractionalMatch = typeof value === "string" ? /\.(\d+)(?=(?:Z|[+-]\d{2}:\d{2})$)/.exec(value) : null;
  if (typeof value !== "string" || (fractionalMatch !== null && /[1-9]/.test(fractionalMatch[1] ?? ""))) {
    issues.push(issue(["searchStartAt"], "invalid_datetime", "searchStartAt must be an offset-aware ISO instant with whole-second precision."));
    return undefined;
  }
  try {
    return parseSearchStartInstant(value, MEETING_TIME_ZONE).canonicalAt;
  } catch {
    issues.push(issue(["searchStartAt"], "invalid_datetime", "searchStartAt must be an offset-aware ISO instant with whole-second precision."));
    return undefined;
  }
}

function validateResponseInvariants(value: Record<string, unknown>, metadata: Record<string, unknown>, request: ScheduledMeetingRequest, issues: ScheduledValidationIssue[], deadlineCheck?: ScheduledDeadlineCheck): void {
  if (Array.isArray(value.participants) && value.participants.length === 2) {
    const expectedParticipants = request.participants;
    value.participants.forEach((participant, index) => {
      const expected = expectedParticipants[index];
      if (expected === undefined || !isRecord(participant)) return;
      if (participant.id !== expected.id) issues.push(issue(["participants", index, "id"], "inconsistent", "Response participant id must match the scheduled request."));
      if (!isRecord(participant.origin)) return;
      if (participant.origin.label !== expected.origin.label || participant.origin.latitude !== expected.origin.latitude || participant.origin.longitude !== expected.origin.longitude) {
        issues.push(issue(["participants", index, "origin"], "inconsistent", "Response participant origin must match the scheduled request."));
      }
    });
  }
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
  if (surface.changeTimeSeconds !== effectiveChangeTimeSeconds(request.changeTimePreset)) issues.push(issue(["metadata", "surface", "changeTimeSeconds"], "inconsistent", "Surface changeTimeSeconds must match the parsed scheduled request preset."));

  if (typeof surface.searchStartAt !== "string" || typeof surface.timeZone !== "string") {
    return;
  }
  try {
    const parsed = parseSearchStartInstant(surface.searchStartAt, surface.timeZone);
    if (parsed.canonicalAt !== surface.searchStartAt) issues.push(issue(["metadata", "surface", "searchStartAt"], "inconsistent", "Surface searchStartAt must use its canonical whole-minute UTC representation."));
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

  if (value.status === "no-result" && (value.reason === "no-access-seeds" || value.reason === "no-reachable-stations")) {
    const hasEmptyCountSet = Array.isArray(surface.accessSeedCounts) && surface.accessSeedCounts.some((count) => count === 0);
    const hasEmptySerializedSet = Array.isArray(value.participants) && value.participants.some((participant) => isRecord(participant) && Array.isArray(participant.accessSeeds) && participant.accessSeeds.length === 0);
    const hasEmptySeedSet = hasEmptyCountSet || hasEmptySerializedSet;
    if (value.reason === "no-access-seeds" && !hasEmptySeedSet) issues.push(issue(["reason"], "inconsistent", "no-access-seeds requires at least one empty serialized or metadata access-seed set."));
    if (value.reason === "no-reachable-stations" && hasEmptySeedSet) issues.push(issue(["reason"], "inconsistent", "no-reachable-stations requires two non-empty access-seed sets."));
  }

  const tolerance = surface.selectedTolerancePercent;
  if (!isSelectedTolerance(tolerance)) return;
  if (Array.isArray(value.stationAreas)) value.stationAreas.forEach((candidate, index) => {
    if (index % 32 === 0) deadlineCheck?.("meeting-result");
    validateDerivedStationAreaInvariant(candidate, index, value.status, tolerance, issues);
  });
}

function validateStationAreaCatalog(input: Record<string, unknown>, catalog: ScheduledStationAreaCatalog, issues: ScheduledValidationIssue[], deadlineCheck?: ScheduledDeadlineCheck): void {
  if (!Array.isArray(input.stationAreas)) return;
  if (input.stationAreas.length !== catalog.entries.length) {
    issues.push(issue(["stationAreas"], "inconsistent", "Response stationAreas must contain exactly the eligible station-area catalog."));
    return;
  }
  for (let index = 0; index < catalog.entries.length; index += 1) {
    if (index % 32 === 0) deadlineCheck?.("meeting-result");
    const candidate = input.stationAreas[index];
    const entry = catalog.entries[index];
    if (!isRecord(candidate) || entry === undefined) continue;
    const path = ["stationAreas", index];
    if (candidate.stationAreaId !== entry.stationAreaId) issues.push(issue([...path, "stationAreaId"], "inconsistent", "Station-area candidates must use canonical catalog order and identity."));
    if (candidate.name !== entry.name) issues.push(issue([...path, "name"], "inconsistent", "Station-area candidate name must match the canonical catalog."));
    if (candidate.mode !== entry.mode) issues.push(issue([...path, "mode"], "inconsistent", "Station-area candidate mode must match the canonical catalog."));
    if (!isRecord(candidate.coordinate) || candidate.coordinate.latitude !== entry.coordinate.latitude || candidate.coordinate.longitude !== entry.coordinate.longitude) issues.push(issue([...path, "coordinate"], "inconsistent", "Station-area candidate coordinate must match the canonical catalog."));
  }
}

function validateStationArea(value: unknown, index: number, issues: ScheduledValidationIssue[]): void {
  const path = ["stationAreas", index];
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Station-area candidate must be an object."));
    return;
  }
  addUnknownKeys(value, ["stationAreaId", "name", "coordinate", "mode", "classification", "redArrivalSeconds", "blueArrivalSeconds", "fasterParticipant", "withinSelectedTolerance"], path, issues);
  if (typeof value.stationAreaId !== "string" || value.stationAreaId.trim() === "") issues.push(issue([...path, "stationAreaId"], "invalid_value", "stationAreaId must be non-empty."));
  if (typeof value.name !== "string" || value.name.trim() === "") issues.push(issue([...path, "name"], "invalid_value", "Station-area name must be non-empty."));
  if (value.mode !== "sbahn" && value.mode !== "ubahn" && value.mode !== "tram" && value.mode !== "bus") issues.push(issue([...path, "mode"], "invalid_enum", "Station-area mode is invalid."));
  if (!isCoordinate(value.coordinate)) issues.push(issue([...path, "coordinate"], "invalid_coordinate", "Station-area coordinate must be valid."));
  else if (!isWithinOfficialMunichBoundary(value.coordinate)) issues.push(issue([...path, "coordinate"], "outside_official_munich_boundary", "Station-area coordinate must be inside the official Munich application boundary."));
  if (isRecord(value.coordinate)) addUnknownKeys(value.coordinate, ["latitude", "longitude"], [...path, "coordinate"], issues);
  if (value.classification !== "red" && value.classification !== "blue" && value.classification !== "fair" && value.classification !== "unclassified") issues.push(issue([...path, "classification"], "invalid_enum", "Station-area classification is invalid."));
  if (!isNullableWholeSecond(value.redArrivalSeconds)) issues.push(issue([...path, "redArrivalSeconds"], "invalid_value", "redArrivalSeconds must be a whole minute (in seconds) or null."));
  if (!isNullableWholeSecond(value.blueArrivalSeconds)) issues.push(issue([...path, "blueArrivalSeconds"], "invalid_value", "blueArrivalSeconds must be a whole minute (in seconds) or null."));
  if (value.fasterParticipant !== null && value.fasterParticipant !== "red" && value.fasterParticipant !== "blue") issues.push(issue([...path, "fasterParticipant"], "invalid_enum", "Station-area fasterParticipant is invalid."));
  if (typeof value.withinSelectedTolerance !== "boolean") issues.push(issue([...path, "withinSelectedTolerance"], "invalid_type", "Station-area withinSelectedTolerance must be boolean."));
}

function validateDerivedStationAreaInvariant(value: unknown, index: number, status: unknown, tolerancePercent: 5 | 10 | 15, issues: ScheduledValidationIssue[]): void {
  if (!isRecord(value)) return;
  const path = ["stationAreas", index];
  const classification = value.classification;
  const red = value.redArrivalSeconds;
  const blue = value.blueArrivalSeconds;
  const fasterParticipant = value.fasterParticipant;
  const withinSelectedTolerance = value.withinSelectedTolerance;

  if (status === "no-result") {
    if (classification !== "unclassified" || red !== null || blue !== null || fasterParticipant !== null || withinSelectedTolerance !== false) {
      issues.push(issue(path, "inconsistent", "No-result station areas must be unclassified with null arrivals, no faster participant, and false tolerance."));
    }
    return;
  }

  if (!isNullableWholeSecond(red) || !isNullableWholeSecond(blue)) return;
  let expectedClassification: ScheduledStationAreaClassification = "unclassified";
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
    issues.push(issue(path, "inconsistent", "Station-area classification, faster participant, and tolerance flag must be derived from its arrival fields."));
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
      if (isRecord(seed)) addUnknownKeys(seed, ["seedId", "mvgStationId", "stationAreaId", "coordinate", "accessSeconds", "provenance"], seedPath, issues);
      if (!isRecord(seed) || typeof seed.seedId !== "string" || seed.seedId.trim() === "" || typeof seed.mvgStationId !== "string" || seed.mvgStationId.trim() === "" || typeof seed.stationAreaId !== "string" || seed.stationAreaId.trim() === "" || !isWholeSecond(seed.accessSeconds) || !isRecord(seed.coordinate) || !isCoordinate(seed.coordinate) || !isRecord(seed.provenance) || (seed.provenance.source !== "mvg-nearby" && seed.provenance.source !== "fixture-static") || typeof seed.provenance.endpoint !== "string" || typeof seed.provenance.distanceMeters !== "number" || !Number.isFinite(seed.provenance.distanceMeters) || seed.provenance.distanceMeters < 0 || !isWholeSecond(seed.provenance.walkingSeconds) || typeof seed.provenance.note !== "string") {
        issues.push(issue(seedPath, "invalid_value", "Response access seed provenance is invalid."));
      }
      if (isRecord(seed?.coordinate)) addUnknownKeys(seed.coordinate, ["latitude", "longitude"], [...seedPath, "coordinate"], issues);
      if (isRecord(seed?.provenance)) addUnknownKeys(seed.provenance, ["source", "endpoint", "distanceMeters", "walkingSeconds", "note"], [...seedPath, "provenance"], issues);
    });
  }
}

function validateResponseMetadata(value: Record<string, unknown>, issues: ScheduledValidationIssue[]): void {
  const path = ["metadata"];
  addUnknownKeys(value, ["schedule", "surface", "stationAreas", "accessProvider", "coverage", "origins"], path, issues);
  const schedule = value.schedule;
  if (isRecord(schedule)) addUnknownKeys(schedule, ["contractVersion", "feedId", "timeZone", "scheduleContentHash", "compiledArtifactId", "serviceDateRange", "acquisition"], [...path, "schedule"], issues);
  if (isRecord(schedule) && isRecord(schedule.serviceDateRange)) addUnknownKeys(schedule.serviceDateRange, ["firstDate", "lastDate"], [...path, "schedule", "serviceDateRange"], issues);
  if (isRecord(schedule) && isRecord(schedule.acquisition)) {
    const acquisitionPath = [...path, "schedule", "acquisition"];
    addUnknownKeys(schedule.acquisition, ["sourceUrl", "retrievedAt", "rawArchiveByteSize", "rawArchiveSha256", "feedVersion", "feedValidFrom", "feedValidUntil", "attribution", "officialAttribution", "officialLicense", "officialProvenance"], acquisitionPath, issues);
    if (isRecord(schedule.acquisition.officialLicense)) addUnknownKeys(schedule.acquisition.officialLicense, ["name", "url"], [...acquisitionPath, "officialLicense"], issues);
    if (isRecord(schedule.acquisition.officialProvenance)) addUnknownKeys(schedule.acquisition.officialProvenance, ["source", "policyId"], [...acquisitionPath, "officialProvenance"], issues);
  }
  if (isRecord(value.surface)) addUnknownKeys(value.surface, ["contractVersion", "scheduleContentHash", "compiledArtifactId", "feedId", "timeZone", "searchStartAt", "routingHorizonSeconds", "selectedTolerancePercent", "changeTimeSeconds", "walkingVelocityMetersPerSecond", "walkingSecondsRoundingRule", "transferRadiusMeters", "accessSeedCounts", "stationAreaCount", "connectionCount", "coverage", "representativePointBasis", "classificationMethod", "classificationBasis", "finalWalkingMethod"], [...path, "surface"], issues);
  if (isRecord(value.stationAreas)) addUnknownKeys(value.stationAreas, ["count", "coverage", "selection"], [...path, "stationAreas"], issues);
  if (isRecord(value.accessProvider)) {
    const providerPath = [...path, "accessProvider"];
    addUnknownKeys(value.accessProvider, ["name", "deployment", "dataKind", "liveData", "asOf", "notes", "provenance"], providerPath, issues);
    if (isRecord(value.accessProvider.provenance)) addUnknownKeys(value.accessProvider.provenance, ["role", "provider", "deployment", "dataKind", "liveData", "sourceUrl", "license", "attribution", "version", "retrievedAt", "notes", "feeds"], [...providerPath, "provenance"], issues);
    if (!isScheduledAccessProviderDescriptor(value.accessProvider)) issues.push(issue(providerPath, "invalid_value", "Access provider metadata must describe non-live nearby access, not scheduled routing."));
  }
  if (value.origins !== undefined && !isRecord(value.origins)) {
    issues.push(issue([...path, "origins"], "invalid_type", "origins must be an object."));
  } else if (isRecord(value.origins)) {
    const originsPath = [...path, "origins"];
    addUnknownKeys(value.origins, ["coverage"], originsPath, issues);
    if (value.origins.coverage !== "globally-valid-origin/v1") issues.push(issue(originsPath, "invalid_value", "origins.coverage must be globally-valid-origin/v1."));
  }
}

function isScheduledMeetingResponse(value: unknown): value is ScheduledMeetingResponseDto {
  if (!isRecord(value)) return false;
  return value.contractVersion === "meeet-meeting/v3" &&
    (value.status === "ok" || value.status === "no-result") &&
    (value.reason === null || value.reason === "no-access-seeds" || value.reason === "no-reachable-stations") &&
    Array.isArray(value.participants) && value.participants.length === 2 &&
    isScheduledParticipantDto(value.participants[0]) && isScheduledParticipantDto(value.participants[1]) &&
    Array.isArray(value.stationAreas) && value.stationAreas.every(isScheduledStationAreaDto) &&
    isScheduledMetadataDto(value.metadata);
}

function isScheduledParticipantDto(value: unknown): value is ScheduledMeetingParticipantDto {
  return isRecord(value) && typeof value.id === "string" && (value.color === "red" || value.color === "blue") && value.mode === "transit" && isRecord(value.origin) && typeof value.origin.label === "string" && typeof value.origin.latitude === "number" && typeof value.origin.longitude === "number" && Array.isArray(value.accessSeeds) && value.accessSeeds.every(isScheduledSeedDto);
}

function isScheduledSeedDto(value: unknown): value is ScheduledMeetingAccessSeedDto {
  return isRecord(value) && typeof value.seedId === "string" && value.seedId.trim() !== "" && typeof value.mvgStationId === "string" && value.mvgStationId.trim() !== "" && typeof value.stationAreaId === "string" && value.stationAreaId.trim() !== "" && isWholeSecond(value.accessSeconds) && isCoordinate(value.coordinate) && isRecord(value.provenance) && (value.provenance.source === "mvg-nearby" || value.provenance.source === "fixture-static") && typeof value.provenance.endpoint === "string" && typeof value.provenance.distanceMeters === "number" && Number.isFinite(value.provenance.distanceMeters) && value.provenance.distanceMeters >= 0 && isWholeSecond(value.provenance.walkingSeconds) && typeof value.provenance.note === "string";
}

function isScheduledStationAreaDto(value: unknown): value is ScheduledMeetingStationAreaDto {
  return isRecord(value) && typeof value.stationAreaId === "string" && value.stationAreaId.trim() !== "" && typeof value.name === "string" && value.name.trim() !== "" && (value.mode === "sbahn" || value.mode === "ubahn" || value.mode === "tram" || value.mode === "bus") && isCoordinate(value.coordinate) && isWithinOfficialMunichBoundary(value.coordinate) && (value.classification === "red" || value.classification === "blue" || value.classification === "fair" || value.classification === "unclassified") && isNullableWholeSecond(value.redArrivalSeconds) && isNullableWholeSecond(value.blueArrivalSeconds) && (value.fasterParticipant === null || value.fasterParticipant === "red" || value.fasterParticipant === "blue") && typeof value.withinSelectedTolerance === "boolean";
}

function isScheduledMetadataDto(value: unknown): value is ScheduledMeetingMetadataDto {
  if (!isRecord(value) || !isRecord(value.schedule) || !isRecord(value.surface) || !isScheduledStationAreaMetadata(value.stationAreas) || !isScheduledAccessProviderDescriptor(value.accessProvider)) return false;
  return value.coverage === "munich-scheduled-station-area-meeting/v1" &&
    isRecord(value.origins) && value.origins.coverage === "globally-valid-origin/v1" &&
    typeof value.schedule.contractVersion === "string" && typeof value.schedule.feedId === "string" && value.schedule.timeZone === MEETING_TIME_ZONE && typeof value.schedule.scheduleContentHash === "string" && typeof value.schedule.compiledArtifactId === "string" && isDateRange(value.schedule.serviceDateRange) && isAcquisition(value.schedule.acquisition) &&
    value.surface.classificationMethod === "scheduled-arrival-comparison-with-selected-tolerance/v1" && value.surface.classificationBasis === "scheduled-station-area-arrival/v1" && value.surface.representativePointBasis === "station-area-coordinate/v1" && value.surface.finalWalkingMethod === "scheduled-access-and-transfer-walking/v1" && isSurfaceMetadata(value.surface);
}

function isScheduledStationAreaMetadata(value: unknown): value is ScheduledStationAreaMetadata {
  return isRecord(value) && typeof value.count === "number" && Number.isSafeInteger(value.count) && value.count >= 0 && value.coverage === "official-munich-boundary-with-connected-artifact-station-areas/v1" && value.selection === "all-eligible-scheduled-station-areas/v1";
}

function isSurfaceMetadata(value: unknown): value is ScheduledMeetingMetadataDto["surface"] {
  if (!isRecord(value)) return false;
  return value.contractVersion === "meeet-scheduled-routing/v1" && typeof value.scheduleContentHash === "string" && typeof value.compiledArtifactId === "string" && typeof value.feedId === "string" && value.timeZone === MEETING_TIME_ZONE && typeof value.searchStartAt === "string" && value.routingHorizonSeconds === 86_400 && (value.selectedTolerancePercent === 5 || value.selectedTolerancePercent === 10 || value.selectedTolerancePercent === 15) && (value.changeTimeSeconds === 180 || value.changeTimeSeconds === 300 || value.changeTimeSeconds === 600) && typeof value.walkingVelocityMetersPerSecond === "number" && typeof value.walkingSecondsRoundingRule === "string" && typeof value.transferRadiusMeters === "number" && Array.isArray(value.accessSeedCounts) && value.accessSeedCounts.length === 2 && value.accessSeedCounts.every((count) => Number.isSafeInteger(count) && count >= 0) && Number.isSafeInteger(value.stationAreaCount) && Number.isSafeInteger(value.connectionCount) && value.coverage === "scheduled-service-day-local-radius/v1" && value.representativePointBasis === "station-area-coordinate/v1";
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

function isNullableWholeSecond(value: unknown): value is number | null {
  return value === null || isWholeSecond(value);
}

/** The scheduled calculation is minute-aligned end to end: seconds must be a multiple of 60. */
function isWholeSecond(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value % 60 === 0;
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

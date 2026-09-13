import { isWithinOfficialMunichBoundary } from "../domain/boundary.ts";
import {
  isScheduledToleranceSatisfied,
  SCHEDULED_DETAIL_SELECTION_POLICY,
} from "../domain/scheduled-routing/router.ts";
import { WALKING_SECONDS_ROUNDING_RULE, SCHEDULED_ROUTING_CONTRACT_VERSION, CHANGE_TIME_PRESETS } from "../domain/scheduled-routing/models.ts";
import type { ScheduledMeetingRequest, ScheduledMeetingStationAreaDto, ScheduledValidationIssue } from "./meeting-v3.ts";
import type {
  StationAreaDetailsResponseDto,
} from "../domain/station-area-details-contract.ts";
import { STATION_AREA_DETAILS_CONTRACT_VERSION } from "../domain/station-area-details-contract.ts";

export interface StationAreaDetailsValidationContext {
  readonly request?: ScheduledMeetingRequest;
  readonly selectedMarker?: ScheduledMeetingStationAreaDto;
  readonly artifactIdentity?: {
    readonly feedId: string;
    readonly timeZone: string;
    readonly scheduleContentHash: string;
    readonly compiledArtifactId: string;
  };
}

export type StationAreaDetailsValidationResult =
  | { readonly success: true; readonly data: StationAreaDetailsResponseDto }
  | { readonly success: false; readonly issues: readonly ScheduledValidationIssue[] };

const DETAIL_KEYS = ["contractVersion", "status", "reason", "stationArea", "participants", "basis"] as const;
const MARKER_KEYS = ["stationAreaId", "name", "coordinate", "mode", "classification", "redArrivalSeconds", "blueArrivalSeconds", "fasterParticipant", "withinSelectedTolerance"] as const;
const BASIS_KEYS = ["contractVersion", "searchStartAt", "selectedTolerancePercent", "changeTimeSeconds", "routingHorizonSeconds", "walkingVelocityMetersPerSecond", "walkingSecondsRoundingRule", "transferRadiusMeters", "deterministicSelectionPolicy", "schedule", "accessProvider"] as const;
const PARTICIPANT_KEYS = ["id", "color", "origin", "status", "unavailableReason", "terminal", "itinerary"] as const;
const TERMINAL_KEYS = ["totalSeconds", "arrivalAt"] as const;

export function validateStationAreaDetailsResponse(
  input: unknown,
  context: StationAreaDetailsValidationContext = {},
): StationAreaDetailsValidationResult {
  const issues: ScheduledValidationIssue[] = [];
  if (!isRecord(input)) return failure([], "invalid_type", "Station-area detail response must be an object.");
  addUnknownKeys(input, DETAIL_KEYS, [], issues);
  if (input.contractVersion !== STATION_AREA_DETAILS_CONTRACT_VERSION) issues.push(issue(["contractVersion"], "invalid_value", "Response contractVersion must be meeet-station-area-details/v1."));
  if (input.status !== "ok" && input.status !== "no-result") issues.push(issue(["status"], "invalid_enum", "Detail status must be ok or no-result."));
  if (input.reason !== null && input.reason !== "no-access-seeds" && input.reason !== "no-reachable-stations") issues.push(issue(["reason"], "invalid_enum", "Detail no-result reason is invalid."));
  if (!isRecord(input.stationArea)) issues.push(issue(["stationArea"], "invalid_type", "Detail stationArea must be a station-area marker."));
  else validateMarker(input.stationArea, ["stationArea"], issues);

  if (!Array.isArray(input.participants) || input.participants.length !== 2) {
    issues.push(issue(["participants"], "invalid_length", "Detail response must contain exactly two participants."));
  } else {
    input.participants.forEach((participant, index) => validateParticipant(participant, index, issues));
    const first = input.participants[0];
    const second = input.participants[1];
    if (isRecord(first) && first.color !== "red") issues.push(issue(["participants", 0, "color"], "invalid_value", "The first detail participant must be red."));
    if (isRecord(second) && second.color !== "blue") issues.push(issue(["participants", 1, "color"], "invalid_value", "The second detail participant must be blue."));
  }
  if (!isRecord(input.basis)) issues.push(issue(["basis"], "invalid_type", "Detail basis must be an object."));
  else validateBasis(input.basis, issues, context);

  if (isRecord(input.stationArea)) validateMarkerInvariant(input.stationArea, issues);
  if (isRecord(input.basis) && isRecord(input.stationArea)) {
    validateBasisBindings(input, input.basis, input.stationArea, issues, context);
  }
  if (Array.isArray(input.participants) && input.participants.length === 2 && isRecord(input.stationArea)) {
    validateParticipantBindings(input, input.stationArea, issues, context);
  }
  if (input.status === "no-result" && input.reason === null) issues.push(issue(["reason"], "required", "No-result detail responses must disclose a reason."));
  if (input.status === "ok" && input.reason !== null) issues.push(issue(["reason"], "invalid_value", "Successful detail responses must have a null no-result reason."));

  if (issues.length > 0 || !isDetailResponse(input)) {
    if (issues.length === 0) issues.push(issue([], "invalid_structure", "Station-area detail response structure is invalid."));
    return { success: false, issues };
  }
  return { success: true, data: input };
}

function validateMarker(value: Record<string, unknown>, path: Array<string | number>, issues: ScheduledValidationIssue[]): void {
  addUnknownKeys(value, MARKER_KEYS, path, issues);
  if (!isNonEmptyString(value.stationAreaId)) issues.push(issue([...path, "stationAreaId"], "invalid_value", "stationAreaId must be non-empty."));
  if (!isNonEmptyString(value.name)) issues.push(issue([...path, "name"], "invalid_value", "station-area name must be non-empty."));
  if (value.mode !== "sbahn" && value.mode !== "ubahn" && value.mode !== "tram" && value.mode !== "bus") issues.push(issue([...path, "mode"], "invalid_enum", "station-area mode is invalid."));
  if (!isCoordinate(value.coordinate)) issues.push(issue([...path, "coordinate"], "invalid_coordinate", "station-area coordinate is invalid."));
  else if (!isWithinOfficialMunichBoundary(value.coordinate)) issues.push(issue([...path, "coordinate"], "outside_official_munich_boundary", "station-area coordinate must be inside Munich."));
  if (isRecord(value.coordinate)) addUnknownKeys(value.coordinate, ["latitude", "longitude"], [...path, "coordinate"], issues);
  if (!isClassification(value.classification)) issues.push(issue([...path, "classification"], "invalid_enum", "station-area classification is invalid."));
  if (!isNullableWholeSecond(value.redArrivalSeconds)) issues.push(issue([...path, "redArrivalSeconds"], "invalid_value", "redArrivalSeconds must be a whole minute (in seconds) or null."));
  if (!isNullableWholeSecond(value.blueArrivalSeconds)) issues.push(issue([...path, "blueArrivalSeconds"], "invalid_value", "blueArrivalSeconds must be a whole minute (in seconds) or null."));
  if (value.fasterParticipant !== null && value.fasterParticipant !== "red" && value.fasterParticipant !== "blue") issues.push(issue([...path, "fasterParticipant"], "invalid_enum", "fasterParticipant is invalid."));
  if (typeof value.withinSelectedTolerance !== "boolean") issues.push(issue([...path, "withinSelectedTolerance"], "invalid_type", "withinSelectedTolerance must be boolean."));
}

function validateMarkerInvariant(value: Record<string, unknown>, issues: ScheduledValidationIssue[]): void {
  const red = value.redArrivalSeconds;
  const blue = value.blueArrivalSeconds;
  if (value.classification === "unclassified" && (red !== null || blue !== null || value.fasterParticipant !== null || value.withinSelectedTolerance !== false)) issues.push(issue(["stationArea"], "inconsistent", "Unclassified markers must have null arrivals and false tolerance."));
  if (value.classification !== "unclassified" && red === null && blue === null) issues.push(issue(["stationArea"], "inconsistent", "Classified markers must expose a reachable arrival."));
}

function validateBasisBindings(
  input: Record<string, unknown>,
  basis: Record<string, unknown>,
  marker: Record<string, unknown>,
  issues: ScheduledValidationIssue[],
  context: StationAreaDetailsValidationContext,
): void {
  if (basis.contractVersion !== "meeet-meeting/v3") issues.push(issue(["basis", "contractVersion"], "invalid_value", "Detail basis must identify meeet-meeting/v3."));
  if (context.request !== undefined && basis.searchStartAt !== context.request.searchStartAt) issues.push(issue(["basis", "searchStartAt"], "inconsistent", "Detail basis start must match the v3 request."));
  if (context.request !== undefined && basis.selectedTolerancePercent !== context.request.tolerancePercent) issues.push(issue(["basis", "selectedTolerancePercent"], "inconsistent", "Detail basis tolerance must match the v3 request."));
  if (context.request !== undefined && basis.changeTimeSeconds !== CHANGE_TIME_PRESETS[context.request.changeTimePreset]) issues.push(issue(["basis", "changeTimeSeconds"], "inconsistent", "Detail basis change time must match the v3 request preset."));
  if (basis.deterministicSelectionPolicy !== SCHEDULED_DETAIL_SELECTION_POLICY) issues.push(issue(["basis", "deterministicSelectionPolicy"], "invalid_value", "Detail selection policy is not canonical."));
  if (context.artifactIdentity !== undefined) {
    for (const field of ["feedId", "timeZone", "scheduleContentHash", "compiledArtifactId"] as const) {
      if (isRecord(basis.schedule) && basis.schedule[field] !== context.artifactIdentity[field]) issues.push(issue(["basis", "schedule", field], "inconsistent", "Detail schedule identity does not match the calculation reference."));
    }
  }
  if (context.selectedMarker !== undefined && !sameMarker(marker, context.selectedMarker)) issues.push(issue(["stationArea"], "inconsistent", "Detail marker must exactly match the cached v3 selected marker."));
  const selectedTolerance = basis.selectedTolerancePercent;
  if (!isSelectedTolerance(selectedTolerance)) return;
  const red = marker.redArrivalSeconds;
  const blue = marker.blueArrivalSeconds;
  const expected = deriveMarker(red, blue, selectedTolerance);
  if (marker.classification !== expected.classification || marker.fasterParticipant !== expected.fasterParticipant || marker.withinSelectedTolerance !== expected.withinSelectedTolerance) {
    issues.push(issue(["stationArea"], "inconsistent", "Marker classification, faster participant, and tolerance must derive from the two marker totals."));
  }
  if (input.status === "no-result" && marker.classification !== "unclassified") issues.push(issue(["stationArea"], "inconsistent", "No-result detail markers must be unclassified."));
}

function getMarkerArrivalSeconds(marker: Record<string, unknown>, color: "red" | "blue"): unknown {
  return color === "red" ? marker.redArrivalSeconds : marker.blueArrivalSeconds;
}

function validateParticipantBindings(
  input: Record<string, unknown>,
  marker: Record<string, unknown>,
  issues: ScheduledValidationIssue[],
  context: StationAreaDetailsValidationContext,
): void {
  const participants = input.participants;
  if (!Array.isArray(participants)) return;
  participants.forEach((value, index) => {
    if (!isRecord(value)) return;
    const color = index === 0 ? "red" : "blue";
    const selectedTotal = getMarkerArrivalSeconds(marker, color);
    const available = isWholeSecond(selectedTotal);
    const participantPath = ["participants", index];
    const terminal = isRecord(value.terminal) ? value.terminal : undefined;
    if (available) {
      if (value.status !== "available") issues.push(issue([...participantPath, "status"], "inconsistent", "A reachable marker requires an available detail participant."));
      if (value.unavailableReason !== null) issues.push(issue([...participantPath, "unavailableReason"], "inconsistent", "Available detail participants must have a null unavailable reason."));
      if (terminal === undefined) {
        issues.push(issue([...participantPath, "terminal"], "invalid_type", "Available detail participants require a terminal."));
      } else {
        if (terminal.totalSeconds !== selectedTotal) issues.push(issue([...participantPath, "terminal", "totalSeconds"], "inconsistent", "Terminal total must exactly match the cached marker."));
        const expectedArrivalAt = context.request === undefined ? null : expectedArrival(context.request.searchStartAt, selectedTotal);
        if (typeof terminal.arrivalAt !== "string" || parseWholeInstant(terminal.arrivalAt) === null) {
          issues.push(issue([...participantPath, "terminal", "arrivalAt"], "invalid_datetime", "Available terminal arrivalAt must be a canonical whole-second instant."));
        } else if (expectedArrivalAt !== null && terminal.arrivalAt !== expectedArrivalAt) {
          issues.push(issue([...participantPath, "terminal", "arrivalAt"], "inconsistent", "Terminal arrivalAt must equal searchStartAt plus marker totalSeconds."));
        }
      }
      if (value.itinerary === null || !Array.isArray(value.itinerary) || value.itinerary.length === 0) {
        issues.push(issue([...participantPath, "itinerary"], "invalid_type", "Available detail participants require a non-empty itinerary."));
      } else {
        const searchStartEpochSeconds = context.request === undefined ? null : parseWholeInstant(context.request.searchStartAt);
        if (searchStartEpochSeconds !== null) {
          const first = value.itinerary[0];
          const last = value.itinerary[value.itinerary.length - 1];
          if (isRecord(first) && typeof first.startEpochSeconds === "number" && first.startEpochSeconds !== searchStartEpochSeconds) {
            issues.push(issue([...participantPath, "itinerary", 0, "startEpochSeconds"], "inconsistent", "The first itinerary leg must start at the search start."));
          }
          if (isRecord(last) && typeof last.endEpochSeconds === "number" && Math.abs(last.endEpochSeconds - (searchStartEpochSeconds + selectedTotal)) > 60) {
            issues.push(issue([...participantPath, "itinerary"], "inconsistent", "The itinerary final arrival must equal searchStart plus marker totalSeconds."));
          }
        }
      }
    } else {
      if (value.status !== "unavailable") issues.push(issue([...participantPath, "status"], "inconsistent", "An unreachable marker requires an unavailable detail participant."));
      if (value.unavailableReason === null) issues.push(issue([...participantPath, "unavailableReason"], "inconsistent", "Unavailable detail participants must disclose an explicit reason."));
      const expectedUnavailableReason = input.status === "no-result"
        ? input.reason
        : marker.classification === "unclassified" ? "station-area-unclassified" : "station-area-unavailable-for-participant";
      if (value.unavailableReason !== expectedUnavailableReason) issues.push(issue([...participantPath, "unavailableReason"], "inconsistent", "Unavailable reason must match the cached detail status and marker."));
      if (terminal === undefined) issues.push(issue([...participantPath, "terminal"], "invalid_type", "Unavailable detail participants require a null terminal."));
      else if (terminal.totalSeconds !== null || terminal.arrivalAt !== null) issues.push(issue([...participantPath, "terminal"], "inconsistent", "Unavailable detail participants must have null terminal fields."));
      if (value.itinerary !== null) issues.push(issue([...participantPath, "itinerary"], "inconsistent", "Unavailable detail participants must have a null itinerary."));
    }
    if (context.request !== undefined) {
      const expected = context.request.participants[index];
      if (expected !== undefined && (value.id !== expected.id || !sameOrigin(value.origin, expected.origin))) issues.push(issue(["participants", index], "inconsistent", "Detail participant identity must match the v3 request."));
    }
  });
}

function validateParticipant(value: unknown, index: number, issues: ScheduledValidationIssue[]): void {
  const path = ["participants", index];
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Detail participant must be an object."));
    return;
  }
  addUnknownKeys(value, PARTICIPANT_KEYS, path, issues);
  if (!isNonEmptyString(value.id)) issues.push(issue([...path, "id"], "invalid_value", "Detail participant id is invalid."));
  if (value.color !== "red" && value.color !== "blue") issues.push(issue([...path, "color"], "invalid_enum", "Detail participant color is invalid."));
  if (!isRecord(value.origin) || typeof value.origin.label !== "string" || typeof value.origin.latitude !== "number" || typeof value.origin.longitude !== "number") issues.push(issue([...path, "origin"], "invalid_value", "Detail participant origin is invalid."));
  else addUnknownKeys(value.origin, ["label", "latitude", "longitude"], [...path, "origin"], issues);
  if (value.status !== "available" && value.status !== "unavailable") issues.push(issue([...path, "status"], "invalid_enum", "Detail participant status is invalid."));
  if (value.unavailableReason !== null && value.unavailableReason !== "no-access-seeds" && value.unavailableReason !== "no-reachable-stations" && value.unavailableReason !== "station-area-unclassified" && value.unavailableReason !== "station-area-unavailable-for-participant") issues.push(issue([...path, "unavailableReason"], "invalid_enum", "Detail unavailable reason is invalid."));
  if (!isRecord(value.terminal)) issues.push(issue([...path, "terminal"], "invalid_type", "Detail terminal must be an object."));
  else {
    addUnknownKeys(value.terminal, TERMINAL_KEYS, [...path, "terminal"], issues);
    if (!isNullableWholeSecond(value.terminal.totalSeconds) || !isNullableString(value.terminal.arrivalAt)) issues.push(issue([...path, "terminal"], "invalid_value", "Detail terminal fields are invalid."));
  }
  validateItinerary(value.itinerary, path, issues);
}

const ITINERARY_LEG_KEYS_WALK = ["kind", "fromAreaId", "toAreaId", "fromAreaName", "toAreaName", "startEpochSeconds", "endEpochSeconds"] as const;
const ITINERARY_LEG_KEYS_TRANSIT = ["kind", "fromAreaId", "toAreaId", "fromAreaName", "toAreaName", "line", "routeType", "headsign", "tripId", "startEpochSeconds", "endEpochSeconds"] as const;

function validateItinerary(value: unknown, path: Array<string | number>, issues: ScheduledValidationIssue[]): void {
  if (value === null) return;
  if (!Array.isArray(value)) {
    issues.push(issue([...path, "itinerary"], "invalid_type", "Itinerary must be null or an array of legs."));
    return;
  }
  value.forEach((leg, index) => {
    const legPath = [...path, "itinerary", index];
    if (!isRecord(leg)) {
      issues.push(issue(legPath, "invalid_type", "Itinerary leg must be an object."));
      return;
    }
    if (leg.kind === "walk") {
      addUnknownKeys(leg, ITINERARY_LEG_KEYS_WALK, legPath, issues);
      if (leg.fromAreaId !== null && !isNonEmptyString(leg.fromAreaId)) issues.push(issue([...legPath, "fromAreaId"], "invalid_value", "walk fromAreaId must be a string or null."));
      if (!isNonEmptyString(leg.toAreaId)) issues.push(issue([...legPath, "toAreaId"], "invalid_value", "walk toAreaId must be a non-empty string."));
      if (leg.fromAreaName !== null && typeof leg.fromAreaName !== "string") issues.push(issue([...legPath, "fromAreaName"], "invalid_value", "walk fromAreaName must be a string or null."));
      if (typeof leg.toAreaName !== "string") issues.push(issue([...legPath, "toAreaName"], "invalid_value", "walk toAreaName must be a string."));
      if (!isEpochSecond(leg.startEpochSeconds) || !isEpochSecond(leg.endEpochSeconds)) issues.push(issue(legPath, "invalid_value", "walk leg timestamps must be whole seconds."));
      else if (leg.endEpochSeconds < leg.startEpochSeconds) issues.push(issue(legPath, "inconsistent", "walk leg end must not precede start."));
    } else if (leg.kind === "transit") {
      addUnknownKeys(leg, ITINERARY_LEG_KEYS_TRANSIT, legPath, issues);
      if (!isNonEmptyString(leg.fromAreaId)) issues.push(issue([...legPath, "fromAreaId"], "invalid_value", "transit fromAreaId must be a non-empty string."));
      if (!isNonEmptyString(leg.toAreaId)) issues.push(issue([...legPath, "toAreaId"], "invalid_value", "transit toAreaId must be a non-empty string."));
      if (typeof leg.fromAreaName !== "string") issues.push(issue([...legPath, "fromAreaName"], "invalid_value", "transit fromAreaName must be a string."));
      if (typeof leg.toAreaName !== "string") issues.push(issue([...legPath, "toAreaName"], "invalid_value", "transit toAreaName must be a string."));
      if (typeof leg.line !== "string") issues.push(issue([...legPath, "line"], "invalid_value", "transit line must be a string."));
      if (typeof leg.routeType !== "number" || !Number.isFinite(leg.routeType)) issues.push(issue([...legPath, "routeType"], "invalid_value", "transit routeType must be a number."));
      if (typeof leg.headsign !== "string") issues.push(issue([...legPath, "headsign"], "invalid_value", "transit headsign must be a string."));
      if (!isNonEmptyString(leg.tripId)) issues.push(issue([...legPath, "tripId"], "invalid_value", "transit tripId must be a non-empty string."));
      if (!isEpochSecond(leg.startEpochSeconds) || !isEpochSecond(leg.endEpochSeconds)) issues.push(issue(legPath, "invalid_value", "transit leg timestamps must be whole seconds."));
      else if (leg.endEpochSeconds < leg.startEpochSeconds) issues.push(issue(legPath, "inconsistent", "transit leg end must not precede start."));
    } else {
      issues.push(issue(legPath, "invalid_enum", "Itinerary leg kind must be walk or transit."));
    }
  });
}

function isEpochSecond(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value); }

function validateBasis(value: Record<string, unknown>, issues: ScheduledValidationIssue[], context: StationAreaDetailsValidationContext): void {
  addUnknownKeys(value, BASIS_KEYS, ["basis"], issues);
  if (value.contractVersion !== "meeet-meeting/v3") issues.push(issue(["basis", "contractVersion"], "invalid_value", "Basis contractVersion must be meeet-meeting/v3."));
  if (typeof value.searchStartAt !== "string" || parseWholeInstant(value.searchStartAt) === null) issues.push(issue(["basis", "searchStartAt"], "invalid_datetime", "Basis searchStartAt must be a canonical whole-second instant."));
  if (!isSelectedTolerance(value.selectedTolerancePercent)) issues.push(issue(["basis", "selectedTolerancePercent"], "invalid_enum", "Basis selected tolerance is invalid."));
  if (value.changeTimeSeconds !== 180 && value.changeTimeSeconds !== 300 && value.changeTimeSeconds !== 600) issues.push(issue(["basis", "changeTimeSeconds"], "invalid_enum", "Basis change time must be a supported preset."));
  if (value.routingHorizonSeconds !== 86_400 || typeof value.walkingVelocityMetersPerSecond !== "number" || !Number.isFinite(value.walkingVelocityMetersPerSecond) || value.walkingVelocityMetersPerSecond <= 0 || value.walkingSecondsRoundingRule !== WALKING_SECONDS_ROUNDING_RULE || typeof value.transferRadiusMeters !== "number" || !Number.isFinite(value.transferRadiusMeters) || value.transferRadiusMeters <= 0) issues.push(issue(["basis"], "invalid_value", "Basis routing options are invalid."));
  if (value.deterministicSelectionPolicy !== SCHEDULED_DETAIL_SELECTION_POLICY) issues.push(issue(["basis", "deterministicSelectionPolicy"], "invalid_value", "Basis selection policy is invalid."));
  if (!isRecord(value.schedule)) issues.push(issue(["basis", "schedule"], "invalid_type", "Basis schedule provenance is required."));
  else validateSchedule(value.schedule, issues, context);
  if (!isRecord(value.accessProvider) || !isAccessProvider(value.accessProvider)) issues.push(issue(["basis", "accessProvider"], "invalid_value", "Basis access provenance must be non-live access-only metadata."));
  else validateAccessProvider(value.accessProvider, issues);
}

function validateSchedule(value: Record<string, unknown>, issues: ScheduledValidationIssue[], context: StationAreaDetailsValidationContext): void {
  addUnknownKeys(value, ["contractVersion", "feedId", "timeZone", "scheduleContentHash", "compiledArtifactId", "serviceDateRange", "acquisition"], ["basis", "schedule"], issues);
  if (value.contractVersion !== SCHEDULED_ROUTING_CONTRACT_VERSION) issues.push(issue(["basis", "schedule", "contractVersion"], "invalid_value", "Schedule provenance contractVersion is invalid."));
  for (const field of ["feedId", "timeZone", "scheduleContentHash", "compiledArtifactId"] as const) if (!isNonEmptyString(value[field])) issues.push(issue(["basis", "schedule", field], "invalid_value", "Schedule provenance field is invalid."));
  if (!isRecord(value.serviceDateRange) || !isDateString(value.serviceDateRange.firstDate) || !isDateString(value.serviceDateRange.lastDate) || value.serviceDateRange.firstDate > value.serviceDateRange.lastDate) issues.push(issue(["basis", "schedule", "serviceDateRange"], "invalid_value", "Schedule service-date range is invalid."));
  if (!isRecord(value.acquisition)) issues.push(issue(["basis", "schedule", "acquisition"], "invalid_type", "Schedule acquisition provenance is required."));
  else validateAcquisition(value.acquisition, issues);
  if (context.artifactIdentity !== undefined && (value.feedId !== context.artifactIdentity.feedId || value.timeZone !== context.artifactIdentity.timeZone || value.scheduleContentHash !== context.artifactIdentity.scheduleContentHash || value.compiledArtifactId !== context.artifactIdentity.compiledArtifactId)) issues.push(issue(["basis", "schedule"], "inconsistent", "Schedule provenance does not match artifact identity."));
}

function validateAcquisition(value: Record<string, unknown>, issues: ScheduledValidationIssue[]): void {
  addUnknownKeys(value, ["sourceUrl", "retrievedAt", "rawArchiveByteSize", "rawArchiveSha256", "feedVersion", "feedValidFrom", "feedValidUntil", "attribution", "officialAttribution", "officialLicense", "officialProvenance"], ["basis", "schedule", "acquisition"], issues);
  for (const field of ["sourceUrl", "retrievedAt", "rawArchiveSha256", "feedVersion", "attribution", "officialAttribution"] as const) if (!isNonEmptyString(value[field])) issues.push(issue(["basis", "schedule", "acquisition", field], "invalid_value", "Acquisition provenance field is invalid."));
  if (!isDateString(value.feedValidFrom) || !isDateString(value.feedValidUntil) || value.feedValidFrom > value.feedValidUntil) issues.push(issue(["basis", "schedule", "acquisition"], "invalid_value", "Acquisition feed validity dates are invalid."));
  if (typeof value.rawArchiveByteSize !== "number" || !Number.isSafeInteger(value.rawArchiveByteSize) || value.rawArchiveByteSize < 0 || !isRecord(value.officialLicense) || !isNonEmptyString(value.officialLicense.name) || !isNonEmptyString(value.officialLicense.url) || !isRecord(value.officialProvenance) || (value.officialProvenance.source !== "feed" && value.officialProvenance.source !== "meeet-policy") || (value.officialProvenance.policyId !== null && value.officialProvenance.policyId !== "mvv-cc-by-4.0-fallback/v1")) issues.push(issue(["basis", "schedule", "acquisition"], "invalid_value", "Acquisition license provenance is invalid."));
  if (isRecord(value.officialLicense)) addUnknownKeys(value.officialLicense, ["name", "url"], ["basis", "schedule", "acquisition", "officialLicense"], issues);
  if (isRecord(value.officialProvenance)) addUnknownKeys(value.officialProvenance, ["source", "policyId"], ["basis", "schedule", "acquisition", "officialProvenance"], issues);
}

function isAccessProvider(value: Record<string, unknown>): boolean {
  const provenance = value.provenance;
  return isNonEmptyString(value.name) && (value.deployment === "fixture" || value.deployment === "self-hosted" || value.deployment === "managed" || value.deployment === "unknown") && (value.dataKind === "access" || value.dataKind === "demo-static") && value.liveData === false && isNonEmptyString(value.asOf) && isNonEmptyString(value.notes) && isRecord(provenance) && provenance.role === "access" && provenance.liveData === false && provenance.dataKind === value.dataKind && provenance.deployment === value.deployment && isNonEmptyString(provenance.provider) && isNonEmptyString(provenance.version) && provenance.version === value.asOf && provenance.feeds === null;
}

function validateAccessProvider(value: Record<string, unknown>, issues: ScheduledValidationIssue[]): void {
  addUnknownKeys(value, ["name", "deployment", "dataKind", "liveData", "asOf", "notes", "provenance"], ["basis", "accessProvider"], issues);
  if (!isRecord(value.provenance)) return;
  addUnknownKeys(value.provenance, ["role", "provider", "deployment", "dataKind", "liveData", "sourceUrl", "license", "attribution", "version", "retrievedAt", "notes", "feeds"], ["basis", "accessProvider", "provenance"], issues);
  if (isRecord(value.provenance.license)) addUnknownKeys(value.provenance.license, ["name", "url"], ["basis", "accessProvider", "provenance", "license"], issues);
  if (value.provenance.sourceUrl !== null && !isNonEmptyString(value.provenance.sourceUrl)) issues.push(issue(["basis", "accessProvider", "provenance", "sourceUrl"], "invalid_value", "Access provenance sourceUrl must be a URL or null."));
  if (value.provenance.license !== null && (!isRecord(value.provenance.license) || !isNonEmptyString(value.provenance.license.name) || !isNonEmptyString(value.provenance.license.url))) issues.push(issue(["basis", "accessProvider", "provenance", "license"], "invalid_value", "Access provenance license is invalid."));
  for (const field of ["attribution", "version", "retrievedAt", "notes"] as const) if (!isNonEmptyString(value.provenance[field])) issues.push(issue(["basis", "accessProvider", "provenance", field], "invalid_value", "Access provenance field is invalid."));
  if (value.provenance.feeds !== null) issues.push(issue(["basis", "accessProvider", "provenance", "feeds"], "invalid_value", "Access provenance feeds must be null."));
}

function deriveMarker(red: unknown, blue: unknown, tolerance: 5 | 10 | 15): { classification: string; fasterParticipant: "red" | "blue" | null; withinSelectedTolerance: boolean } {
  if (!isWholeSecond(red) && !isWholeSecond(blue)) return { classification: "unclassified", fasterParticipant: null, withinSelectedTolerance: false };
  if (!isWholeSecond(red)) return { classification: "blue", fasterParticipant: "blue", withinSelectedTolerance: false };
  if (!isWholeSecond(blue)) return { classification: "red", fasterParticipant: "red", withinSelectedTolerance: false };
  const fair = isScheduledToleranceSatisfied(red, blue, tolerance);
  return { classification: fair ? "fair" : red < blue ? "red" : "blue", fasterParticipant: red === blue ? null : red < blue ? "red" : "blue", withinSelectedTolerance: fair };
}

function sameMarker(value: Record<string, unknown>, marker: ScheduledMeetingStationAreaDto): boolean {
  return value.stationAreaId === marker.stationAreaId && value.name === marker.name && value.mode === marker.mode && sameCoordinate(value.coordinate, marker.coordinate) && value.classification === marker.classification && value.redArrivalSeconds === marker.redArrivalSeconds && value.blueArrivalSeconds === marker.blueArrivalSeconds && value.fasterParticipant === marker.fasterParticipant && value.withinSelectedTolerance === marker.withinSelectedTolerance;
}

function sameCoordinate(value: unknown, expected: { readonly latitude: number; readonly longitude: number }): boolean {
  return isRecord(value) && value.latitude === expected.latitude && value.longitude === expected.longitude;
}

function sameOrigin(value: unknown, expected: { readonly label: string; readonly latitude: number; readonly longitude: number }): boolean {
  return isRecord(value) && value.label === expected.label && value.latitude === expected.latitude && value.longitude === expected.longitude;
}

function parseWholeInstant(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)) return null;
  const epoch = Date.parse(value) / 1_000;
  return Number.isSafeInteger(epoch) ? epoch : null;
}

function expectedArrival(searchStartAt: string, elapsedSeconds: number): string | null {
  const start = parseWholeInstant(searchStartAt);
  if (start === null) return null;
  return new Date((start + elapsedSeconds) * 1_000).toISOString();
}

function isDetailResponse(value: unknown): value is StationAreaDetailsResponseDto {
  return isRecord(value) && value.contractVersion === STATION_AREA_DETAILS_CONTRACT_VERSION && (value.status === "ok" || value.status === "no-result") && (value.reason === null || value.reason === "no-access-seeds" || value.reason === "no-reachable-stations") && isRecord(value.stationArea) && Array.isArray(value.participants) && value.participants.length === 2 && isRecord(value.basis);
}

function isClassification(value: unknown): value is "red" | "blue" | "fair" | "unclassified" {
  return value === "red" || value === "blue" || value === "fair" || value === "unclassified";
}

function isSelectedTolerance(value: unknown): value is 5 | 10 | 15 { return value === 5 || value === 10 || value === 15; }
function isDateString(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value); }
/** The scheduled calculation is minute-aligned end to end: seconds must be a multiple of 60. */
function isWholeSecond(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value % 60 === 0; }
function isNullableWholeSecond(value: unknown): boolean { return value === null || isWholeSecond(value); }
function isNullableString(value: unknown): boolean { return value === null || typeof value === "string"; }
function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim() !== ""; }
function isCoordinate(value: unknown): value is { readonly latitude: number; readonly longitude: number } { return isRecord(value) && typeof value.latitude === "number" && Number.isFinite(value.latitude) && value.latitude >= -90 && value.latitude <= 90 && typeof value.longitude === "number" && Number.isFinite(value.longitude) && value.longitude >= -180 && value.longitude <= 180; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function addUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: Array<string | number>, issues: ScheduledValidationIssue[]): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(issue([...path, key], "unrecognized_key", "Unknown response field is not permitted.")); }
function issue(path: Array<string | number>, code: string, message: string): ScheduledValidationIssue { return { path, code, message }; }
function failure(path: Array<string | number>, code: string, message: string): StationAreaDetailsValidationResult { return { success: false, issues: [issue(path, code, message)] }; }

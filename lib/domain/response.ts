import { MEETING_TIME_ZONE, TOLERANCE_PERCENT_OPTIONS } from "./types.ts";
import { isWithinOfficialMunichBoundary } from "./boundary.ts";
import { haversineDistanceKm } from "./geo.ts";
import type {
  MeetingCalculationResponse,
  MeetingParticipant,
  ProviderDeploymentKind,
} from "./types.ts";

export const MAX_CALCULATION_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_STRING_LENGTH = 512;
const CONTRACT_VERSION = "meeet-meeting/v2";

export interface ResponseValidationIssue {
  path: Array<string | number>;
  code: string;
  message: string;
}

export type SafeMeetingResponse =
  | { success: true; data: MeetingCalculationResponse }
  | { success: false; issues: readonly ResponseValidationIssue[] };

export function validateMeetingCalculationResponse(value: unknown): SafeMeetingResponse {
  const issues: ResponseValidationIssue[] = [];
  if (!isRecord(value)) return invalid(issue([], "invalid_type", "Calculation response must be an object."));
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || new TextEncoder().encode(serialized).byteLength > MAX_CALCULATION_RESPONSE_BYTES) {
      return invalid(issue([], "too_large", "Calculation response exceeds the client response-size limit."));
    }
  } catch {
    return invalid(issue([], "invalid_json", "Calculation response is not serializable JSON."));
  }
  requireKeys(value, ["contractVersion", "status", "requestSnapshot", "fairLocations", "routePatterns", "sourceQueries", "metadata"], [], issues);
  if (value.contractVersion !== CONTRACT_VERSION) issues.push(issue(["contractVersion"], "invalid_value", "Unknown meeting calculation contract version."));
  if (value.status !== "ok") issues.push(issue(["status"], "invalid_discriminator", "The canonical meeting response status must be ok."));
  validateSnapshot(value.requestSnapshot, ["requestSnapshot"], issues);
  validateRoutePatterns(value.routePatterns, ["routePatterns"], issues);
  validateSourceQueries(value.sourceQueries, value.requestSnapshot, ["sourceQueries"], issues);
  validateFairLocations(value.fairLocations, value.requestSnapshot, value.routePatterns, ["fairLocations"], issues);
  validateMetadata(value.metadata, ["metadata"], issues);
  if (issues.length > 0) return { success: false, issues };
  if (!isCanonicalResponse(value)) return invalid(issue([], "invalid_discriminator", "Calculation response is not a canonical v2 response."));
  return { success: true, data: value };
}

export function parseMeetingCalculationResponse(value: unknown): MeetingCalculationResponse | null {
  const result = validateMeetingCalculationResponse(value);
  return result.success ? result.data : null;
}

export function assertMeetingCalculationResponse(value: unknown): MeetingCalculationResponse {
  const result = validateMeetingCalculationResponse(value);
  if (!result.success) throw new Error("The calculation response failed its DTO validation.");
  return result.data;
}

function validateSnapshot(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "requestSnapshot must be an object."));
    return;
  }
  requireKeys(value, ["participants", "arrivalAt", "selectedTolerancePercent", "effectiveTolerancePercent", "timeZone"], path, issues);
  if (!Array.isArray(value.participants) || value.participants.length !== 2) {
    issues.push(issue(path.concat("participants"), "invalid_length", "Snapshot must contain exactly two participants."));
  } else {
    const ids = new Set<string>();
    value.participants.forEach((participant, index) => {
      const parsed = validateParticipant(participant, path.concat("participants", index), issues);
      if (parsed) {
        if (!isWithinOfficialMunichBoundary(parsed.location)) issues.push(issue(path.concat("participants", index, "location"), "outside_munich", "Participant origins must be inside Munich."));
        if (ids.has(parsed.id)) issues.push(issue(path.concat("participants", index, "id"), "duplicate", "Participant ids must be unique."));
        ids.add(parsed.id);
      }
    });
  }
  validateIsoInstant(value.arrivalAt, path.concat("arrivalAt"), issues);
  validateSelectedTolerance(value.selectedTolerancePercent, path.concat("selectedTolerancePercent"), issues);
  validateEffectiveTolerance(value.effectiveTolerancePercent, value.selectedTolerancePercent, path.concat("effectiveTolerancePercent"), issues);
  if (value.timeZone !== MEETING_TIME_ZONE) issues.push(issue(path.concat("timeZone"), "invalid_value", "Only Europe/Berlin is supported."));
}

function validateParticipant(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): MeetingParticipant | null {
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
  if (value.mode !== "transit") issues.push(issue(path.concat("mode"), "invalid_value", "Only transit participants are supported."));
  if (typeof value.id !== "string" || !isRecord(value.location) || typeof value.location.label !== "string" || typeof value.location.latitude !== "number" || typeof value.location.longitude !== "number" || value.mode !== "transit") return null;
  return { id: value.id, location: { label: value.location.label, latitude: value.location.latitude, longitude: value.location.longitude }, mode: "transit" };
}

function validateRoutePatterns(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(issue(path, "invalid_length", "routePatterns must contain at least one normalized Route Pattern."));
    return;
  }
  const ids = new Set<string>();
  value.forEach((pattern, index) => {
    const patternPath = path.concat(index);
    if (!isRecord(pattern)) {
      issues.push(issue(patternPath, "invalid_type", "Route Pattern must be an object."));
      return;
    }
    requireKeys(pattern, ["id", "kind", "transitStops", "lines", "parts", "provenance"], patternPath, issues);
    validateString(pattern.id, patternPath.concat("id"), issues, 1);
    if (typeof pattern.id === "string") {
      if (ids.has(pattern.id)) issues.push(issue(patternPath.concat("id"), "duplicate", "Route Pattern ids must be unique."));
      ids.add(pattern.id);
    }
    if (pattern.kind !== "transit" && pattern.kind !== "walk-only") issues.push(issue(patternPath.concat("kind"), "invalid_value", "Unknown Route Pattern kind."));
    if (!Array.isArray(pattern.transitStops)) issues.push(issue(patternPath.concat("transitStops"), "invalid_type", "transitStops must be an array."));
    else pattern.transitStops.forEach((stop, stopIndex) => validateEndpoint(stop, patternPath.concat("transitStops", stopIndex), issues, true));
    if (!Array.isArray(pattern.lines)) issues.push(issue(patternPath.concat("lines"), "invalid_type", "lines must be an array."));
    else pattern.lines.forEach((line, lineIndex) => validateLine(line, patternPath.concat("lines", lineIndex), issues));
    if (!Array.isArray(pattern.parts) || pattern.parts.length === 0) issues.push(issue(patternPath.concat("parts"), "invalid_length", "A Route Pattern must contain parts."));
    else pattern.parts.forEach((part, partIndex) => validateJourneyPart(part, patternPath.concat("parts", partIndex), issues));
    if (!Array.isArray(pattern.provenance) || pattern.provenance.length === 0) {
      issues.push(issue(patternPath.concat("provenance"), "invalid_length", "Route Pattern provenance is required."));
    } else {
      pattern.provenance.forEach((provenance, provenanceIndex) => validateProvenance(provenance, patternPath.concat("provenance", provenanceIndex), issues));
    }
    if (pattern.kind === "walk-only" && Array.isArray(pattern.lines) && pattern.lines.length !== 0) issues.push(issue(patternPath.concat("lines"), "invalid_value", "Walk-only patterns cannot contain transit lines."));
    if (pattern.kind === "transit" && Array.isArray(pattern.lines) && pattern.lines.length === 0) issues.push(issue(patternPath.concat("lines"), "invalid_value", "Transit patterns must contain a line."));
    validatePatternSequence(pattern, patternPath, issues);
  });
}

function validatePatternSequence(pattern: Record<string, unknown>, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!Array.isArray(pattern.parts) || !Array.isArray(pattern.transitStops) || !Array.isArray(pattern.lines)) return;
  const transitStops = pattern.transitStops;
  const lines = pattern.lines;
  const transitParts = pattern.parts.filter((part): part is Record<string, unknown> => isRecord(part) && part.kind === "transit");
  const expectedStops = transitParts.flatMap((part) => [part.from, ...(Array.isArray(part.intermediateStops) ? part.intermediateStops : []), part.to]);
  const expectedLines = transitParts.map((part) => part.line);
  if (expectedStops.length !== transitStops.length || expectedStops.some((stop, index) => !isRecord(stop) || !isRecord(transitStops[index]) || stop.stationGlobalId !== transitStops[index].stationGlobalId)) {
    issues.push(issue(path.concat("transitStops"), "mismatched_sequence", "Route Pattern transitStops must preserve every ordered transit occurrence."));
  }
  if (expectedLines.length !== lines.length || expectedLines.some((line, index) => !isRecord(line) || !isRecord(lines[index]) || line.identity !== lines[index].identity || line.type !== lines[index].type)) {
    issues.push(issue(path.concat("lines"), "mismatched_sequence", "Route Pattern lines must preserve the ordered transit-part sequence."));
  }
}

function validateSourceQueries(value: unknown, snapshot: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  const anchors = ["de:09162:6", "de:09162:50", "de:09162:70", "de:09162:1170", "de:09162:190", "de:09162:350"] as const;
  const participants = isRecord(snapshot) && Array.isArray(snapshot.participants) ? snapshot.participants : [];
  const participantIds = participants.flatMap((participant) => isRecord(participant) && typeof participant.id === "string" ? [participant.id] : []);
  const arrivalAt = isRecord(snapshot) && typeof snapshot.arrivalAt === "string" ? snapshot.arrivalAt : null;
  if (!Array.isArray(value) || value.length !== 14) {
    issues.push(issue(path, "invalid_length", "sourceQueries must contain exactly fourteen direct and anchor queries."));
    return;
  }
  const expected = [
    { direction: "participant-1-to-participant-2", origin: participantIds[0], destination: participantIds[1] },
    { direction: "participant-2-to-participant-1", origin: participantIds[1], destination: participantIds[0] },
  ].flatMap(({ direction, origin, destination }) => [
    { direction, origin, destination, searchKind: "direct", anchor: null },
    ...anchors.map((anchor) => ({ direction, origin, destination, searchKind: "anchor", anchor })),
  ]);
  const seen = new Set<string>();
  value.forEach((query, index) => {
    const queryPath = path.concat(index);
    if (!isRecord(query)) {
      issues.push(issue(queryPath, "invalid_type", "Source query provenance must be an object."));
      return;
    }
    requireKeys(query, ["direction", "searchKind", "originParticipantId", "destinationParticipantId", "anchorStationGlobalId", "viaDwellTimeInMinutes", "arrivalAt", "journeyCount", "source"], queryPath, issues);
    if (query.direction !== "participant-1-to-participant-2" && query.direction !== "participant-2-to-participant-1") issues.push(issue(queryPath.concat("direction"), "invalid_value", "Unknown source query direction."));
    if (query.searchKind !== "direct" && query.searchKind !== "anchor") issues.push(issue(queryPath.concat("searchKind"), "invalid_value", "Unknown source query kind."));
    validateString(query.originParticipantId, queryPath.concat("originParticipantId"), issues, 1);
    validateString(query.destinationParticipantId, queryPath.concat("destinationParticipantId"), issues, 1);
    validateIsoInstant(query.arrivalAt, queryPath.concat("arrivalAt"), issues);
    validateFiniteInteger(query.journeyCount, queryPath.concat("journeyCount"), issues, 0);
    validateString(query.source, queryPath.concat("source"), issues, 1);
    if (query.anchorStationGlobalId !== null) validateString(query.anchorStationGlobalId, queryPath.concat("anchorStationGlobalId"), issues, 1);
    if (query.viaDwellTimeInMinutes !== null && query.viaDwellTimeInMinutes !== 10) issues.push(issue(queryPath.concat("viaDwellTimeInMinutes"), "invalid_value", "Anchor source queries must use a ten-minute dwell."));
    if (query.searchKind === "direct" && (query.anchorStationGlobalId !== null || query.viaDwellTimeInMinutes !== null)) issues.push(issue(queryPath, "invalid_value", "Direct source queries must not contain anchor settings."));
    if (query.searchKind === "anchor" && (typeof query.anchorStationGlobalId !== "string" || !anchors.includes(query.anchorStationGlobalId as typeof anchors[number]) || query.viaDwellTimeInMinutes !== 10)) issues.push(issue(queryPath, "invalid_value", "Anchor source queries must name one exact anchor and use a ten-minute dwell."));
    if (query.arrivalAt !== arrivalAt) issues.push(issue(queryPath.concat("arrivalAt"), "mismatched_snapshot", "Source query arrivalAt must match the request snapshot."));
    const key = `${query.direction}|${query.searchKind}|${query.anchorStationGlobalId ?? "direct"}|${query.originParticipantId}|${query.destinationParticipantId}`;
    if (seen.has(key)) issues.push(issue(queryPath, "duplicate", "Source query provenance entries must be unique."));
    seen.add(key);
  });
  const expectedKeys = expected.map((query) => `${query.direction}|${query.searchKind}|${query.anchor ?? "direct"}|${query.origin}|${query.destination}`);
  expectedKeys.forEach((key, index) => {
    if (!seen.has(key)) issues.push(issue(path, "missing_query", `Missing expected source query ${index}.`));
  });
}

function validateFairLocations(value: unknown, snapshot: unknown, patterns: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(issue(path, "invalid_length", "fairLocations must contain at least one location."));
    return;
  }
  const ids = new Set<string>();
  const participantIds = isRecord(snapshot) && Array.isArray(snapshot.participants)
    ? new Set(snapshot.participants.flatMap((participant) => isRecord(participant) && typeof participant.id === "string" ? [participant.id] : []))
    : new Set<string>();
  const snapshotArrival = isRecord(snapshot) && typeof snapshot.arrivalAt === "string" ? Date.parse(snapshot.arrivalAt) : Number.NaN;
  const snapshotSelected = isRecord(snapshot) ? snapshot.selectedTolerancePercent : undefined;
  const snapshotEffective = isRecord(snapshot) ? snapshot.effectiveTolerancePercent : undefined;
  const patternIds = Array.isArray(patterns) ? new Set(patterns.flatMap((pattern) => isRecord(pattern) && typeof pattern.id === "string" ? [pattern.id] : [])) : new Set<string>();
  value.forEach((location, index) => {
    const locationPath = path.concat(index);
    if (!isRecord(location)) {
      issues.push(issue(locationPath, "invalid_type", "Fair Location must be an object."));
      return;
    }
    requireKeys(location, ["id", "label", "kind", "physicalIdentity", "coordinate", "journeys", "differenceMilliseconds", "selectedTolerancePercent", "effectiveTolerancePercent", "sourceRoutePatternIds"], locationPath, issues);
    validateString(location.id, locationPath.concat("id"), issues, 1);
    validateString(location.label, locationPath.concat("label"), issues, 1);
    validateString(location.physicalIdentity, locationPath.concat("physicalIdentity"), issues, 1);
    if (typeof location.id === "string") {
      if (ids.has(location.id)) issues.push(issue(locationPath.concat("id"), "duplicate", "Fair Location ids must be unique."));
      ids.add(location.id);
    }
    if (location.kind !== "station" && location.kind !== "walking-endpoint" && location.kind !== "origin") issues.push(issue(locationPath.concat("kind"), "invalid_value", "Unknown Fair Location kind."));
    validateCoordinate(location.coordinate, locationPath.concat("coordinate"), issues);
    if (isCoordinateRecord(location.coordinate) && !isWithinOfficialMunichBoundary(location.coordinate)) issues.push(issue(locationPath.concat("coordinate"), "outside_munich", "Fair Locations must be inside Munich."));
    validateSelectedTolerance(location.selectedTolerancePercent, locationPath.concat("selectedTolerancePercent"), issues);
    validateEffectiveTolerance(location.effectiveTolerancePercent, location.selectedTolerancePercent, locationPath.concat("effectiveTolerancePercent"), issues);
    if (location.selectedTolerancePercent !== snapshotSelected) issues.push(issue(locationPath.concat("selectedTolerancePercent"), "mismatched_snapshot", "Fair Location selected tolerance must equal the request snapshot."));
    if (location.effectiveTolerancePercent !== snapshotEffective) issues.push(issue(locationPath.concat("effectiveTolerancePercent"), "mismatched_snapshot", "Fair Location effective tolerance must equal the request snapshot."));
    if (location.physicalIdentity !== location.id) issues.push(issue(locationPath.concat("physicalIdentity"), "mismatched_identity", "Fair Location id and physicalIdentity must agree."));
    validateFiniteInteger(location.differenceMilliseconds, locationPath.concat("differenceMilliseconds"), issues, 0);
    if (!Array.isArray(location.journeys) || location.journeys.length !== 2) {
      issues.push(issue(locationPath.concat("journeys"), "invalid_length", "A Fair Location must contain two planned participant journeys."));
    } else {
      const journeyIds = new Set<string>();
      location.journeys.forEach((journey, journeyIndex) => {
        const journeyPath = locationPath.concat("journeys", journeyIndex);
        if (!isRecord(journey)) {
          issues.push(issue(journeyPath, "invalid_type", "Planned participant journey must be an object."));
          return;
        }
        requireKeys(journey, ["participantId", "mode", "plannedDepartureAt", "plannedArrivalAt", "plannedDurationMilliseconds", "source"], journeyPath, issues);
        validateString(journey.participantId, journeyPath.concat("participantId"), issues, 1);
        if (typeof journey.participantId === "string") {
          if (journeyIds.has(journey.participantId)) issues.push(issue(journeyPath.concat("participantId"), "duplicate", "Journey participant ids must be unique."));
          journeyIds.add(journey.participantId);
          if (!participantIds.has(journey.participantId)) issues.push(issue(journeyPath.concat("participantId"), "unknown_participant", "Journey references an unknown participant."));
        }
        if (journey.mode !== "transit") issues.push(issue(journeyPath.concat("mode"), "invalid_value", "Only transit journeys are supported."));
        validateIsoInstant(journey.plannedDepartureAt, journeyPath.concat("plannedDepartureAt"), issues);
        validateIsoInstant(journey.plannedArrivalAt, journeyPath.concat("plannedArrivalAt"), issues);
        validateFiniteInteger(journey.plannedDurationMilliseconds, journeyPath.concat("plannedDurationMilliseconds"), issues, 0);
        if (typeof journey.plannedDurationMilliseconds === "number" && journey.plannedDurationMilliseconds > 24 * 60 * 60 * 1_000) issues.push(issue(journeyPath.concat("plannedDurationMilliseconds"), "out_of_range", "Planned journey duration must not exceed 24 hours."));
        validateString(journey.source, journeyPath.concat("source"), issues, 1);
        if (typeof journey.plannedArrivalAt === "string" && Number.isFinite(snapshotArrival) && Date.parse(journey.plannedArrivalAt) > snapshotArrival) issues.push(issue(journeyPath.concat("plannedArrivalAt"), "after_arrival_at", "Planned journey must arrive no later than arrivalAt."));
        if (typeof journey.plannedDepartureAt === "string" && typeof journey.plannedArrivalAt === "string" && typeof journey.plannedDurationMilliseconds === "number" && Date.parse(journey.plannedArrivalAt) - Date.parse(journey.plannedDepartureAt) !== journey.plannedDurationMilliseconds) issues.push(issue(journeyPath, "incoherent_duration", "Planned duration must equal planned arrival minus planned departure."));
      });
      if (journeyIds.size !== 2) issues.push(issue(locationPath.concat("journeys"), "invalid_participants", "Journeys must cover both participants."));
      if (Array.isArray(location.journeys) && location.journeys.every(isJourneyShape)) {
        const difference = Math.abs(location.journeys[0].plannedDurationMilliseconds - location.journeys[1].plannedDurationMilliseconds);
        if (difference !== location.differenceMilliseconds) issues.push(issue(locationPath.concat("differenceMilliseconds"), "incoherent_difference", "Difference must equal the absolute planned duration difference."));
        if (typeof location.effectiveTolerancePercent === "number" && !isFairPairInteger(location.journeys[0].plannedDurationMilliseconds, location.journeys[1].plannedDurationMilliseconds, location.effectiveTolerancePercent)) issues.push(issue(locationPath, "not_fair", "Fair Location journeys do not satisfy the exact tolerance rule."));
      }
    }
    if (!Array.isArray(location.sourceRoutePatternIds) || location.sourceRoutePatternIds.length === 0) issues.push(issue(locationPath.concat("sourceRoutePatternIds"), "invalid_length", "Every Fair Location must retain source Route Pattern ids."));
    else {
      const sourceIds = new Set<string>();
      location.sourceRoutePatternIds.forEach((id, idIndex) => {
      validateString(id, locationPath.concat("sourceRoutePatternIds", idIndex), issues, 1);
        if (typeof id === "string") {
          if (sourceIds.has(id)) issues.push(issue(locationPath.concat("sourceRoutePatternIds", idIndex), "duplicate", "Fair Location source Route Pattern ids must be unique."));
          sourceIds.add(id);
          if (!patternIds.has(id)) issues.push(issue(locationPath.concat("sourceRoutePatternIds", idIndex), "unknown_pattern", "Fair Location references an unknown Route Pattern."));
        }
      });
      const coordinate = isCoordinateRecord(location.coordinate) ? location.coordinate : null;
      if (coordinate && Array.isArray(patterns) && !location.sourceRoutePatternIds.some((id) => typeof id === "string" && patterns.some((pattern) => isRecord(pattern) && pattern.id === id && patternSupportsCoordinate(pattern, coordinate)))) {
        issues.push(issue(locationPath.concat("sourceRoutePatternIds"), "unsupported_location", "Fair Location coordinate is not present in its source Route Patterns."));
      }
    }
  });
}

function isFairPairInteger(first: number, second: number, tolerancePercent: number): boolean {
  return 100 * Math.abs(first - second) <= tolerancePercent * (first + second);
}

function patternSupportsCoordinate(pattern: Record<string, unknown>, coordinate: { latitude: number; longitude: number }): boolean {
  const endpoints: unknown[] = [
    ...(Array.isArray(pattern.transitStops) ? pattern.transitStops : []),
    ...(Array.isArray(pattern.parts) ? pattern.parts.flatMap((part) => isRecord(part) ? [part.from, ...(Array.isArray(part.intermediateStops) ? part.intermediateStops : []), part.to] : []) : []),
  ];
  return endpoints.some((endpoint) => isRecord(endpoint) && isCoordinateRecord(endpoint.coordinate) && haversineDistanceKm(endpoint.coordinate, coordinate) * 1_000 <= 50);
}

function validateJourneyPart(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Journey part must be an object."));
    return;
  }
  requireKeys(value, ["kind", "from", "to", "intermediateStops", "line", "plannedDepartureAt", "plannedArrivalAt"], path, issues);
  if (value.kind !== "transit" && value.kind !== "walking") issues.push(issue(path.concat("kind"), "invalid_value", "Unknown Journey part kind."));
  validateEndpoint(value.from, path.concat("from"), issues, true);
  validateEndpoint(value.to, path.concat("to"), issues, true);
  if (!Array.isArray(value.intermediateStops)) issues.push(issue(path.concat("intermediateStops"), "invalid_type", "intermediateStops must be an array."));
  else value.intermediateStops.forEach((stop, index) => validateEndpoint(stop, path.concat("intermediateStops", index), issues, true));
  if (value.line === null) {
    if (value.kind === "transit") issues.push(issue(path.concat("line"), "invalid_value", "Transit parts must contain a line."));
  } else validateLine(value.line, path.concat("line"), issues);
  if (value.kind === "walking" && value.line !== null) issues.push(issue(path.concat("line"), "invalid_value", "Walking parts must not contain a transit line."));
  validateIsoInstant(value.plannedDepartureAt, path.concat("plannedDepartureAt"), issues);
  validateIsoInstant(value.plannedArrivalAt, path.concat("plannedArrivalAt"), issues);
}

function validateEndpoint(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[], requireStationOrNull: boolean): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Journey endpoint must be an object."));
    return;
  }
  requireKeys(value, ["stationGlobalId", "coordinate"], path, issues, ["label"]);
  if (value.label !== undefined) validateString(value.label, path.concat("label"), issues, 1);
  if (value.stationGlobalId !== null) validateString(value.stationGlobalId, path.concat("stationGlobalId"), issues, 1);
  if (requireStationOrNull && value.stationGlobalId !== null && typeof value.stationGlobalId !== "string") issues.push(issue(path.concat("stationGlobalId"), "invalid_type", "stationGlobalId must be a string or null."));
  validateCoordinate(value.coordinate, path.concat("coordinate"), issues);
}

function validateLine(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Transit line must be an object."));
    return;
  }
  requireKeys(value, ["identity", "type"], path, issues);
  validateString(value.identity, path.concat("identity"), issues, 1);
  validateString(value.type, path.concat("type"), issues, 1);
}

function validateProvenance(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Route Pattern provenance must be an object."));
    return;
  }
  requireKeys(value, ["direction", "searchKind", "anchorStationGlobalId"], path, issues);
  if (value.direction !== "participant-1-to-participant-2" && value.direction !== "participant-2-to-participant-1") issues.push(issue(path.concat("direction"), "invalid_value", "Unknown Route Pattern direction."));
  if (value.searchKind !== "direct" && value.searchKind !== "anchor") issues.push(issue(path.concat("searchKind"), "invalid_value", "Unknown Route Pattern search kind."));
  if (value.anchorStationGlobalId !== null) validateString(value.anchorStationGlobalId, path.concat("anchorStationGlobalId"), issues, 1);
  if (value.searchKind === "direct" && value.anchorStationGlobalId !== null) issues.push(issue(path.concat("anchorStationGlobalId"), "invalid_value", "Direct provenance cannot contain an anchor station."));
  if (value.searchKind === "anchor" && value.anchorStationGlobalId === null) issues.push(issue(path.concat("anchorStationGlobalId"), "invalid_value", "Anchor provenance must contain an anchor station."));
}

function validateMetadata(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "metadata must be an object."));
    return;
  }
  requireKeys(value, ["routing", "boundary", "provenance"], path, issues);
  validateDescriptor(value.routing, path.concat("routing"), issues);
  validateBoundary(value.boundary, path.concat("boundary"), issues);
  if (!isRecord(value.provenance)) issues.push(issue(path.concat("provenance"), "invalid_type", "metadata provenance is required."));
  else {
    requireKeys(value.provenance, ["routing", "boundary"], path.concat("provenance"), issues);
    validateProvenanceMetadata(value.provenance.routing, path.concat("provenance", "routing"), issues);
    validateBoundary(value.provenance.boundary, path.concat("provenance", "boundary"), issues);
    if (isRecord(value.routing) && !deepEqualJson(value.routing.provenance, value.provenance.routing)) issues.push(issue(path.concat("provenance", "routing"), "mismatched_duplicate", "Routing provenance duplicates must be identical."));
    if (!deepEqualJson(value.boundary, value.provenance.boundary)) issues.push(issue(path.concat("provenance", "boundary"), "mismatched_duplicate", "Boundary provenance duplicates must be identical."));
  }
}

function validateDescriptor(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "routing provider descriptor is required."));
    return;
  }
  requireKeys(value, ["name", "deployment", "dataKind", "liveData", "asOf", "notes", "provenance"], path, issues);
  validateString(value.name, path.concat("name"), issues, 1);
  validateString(value.deployment, path.concat("deployment"), issues, 1);
  validateProviderDeployment(value.deployment, path.concat("deployment"), issues);
  validateString(value.dataKind, path.concat("dataKind"), issues, 1);
  validateRoutingDataKind(value.dataKind, value.deployment, value.liveData, path, issues);
  if (typeof value.liveData !== "boolean") issues.push(issue(path.concat("liveData"), "invalid_type", "liveData must be boolean."));
  validateString(value.asOf, path.concat("asOf"), issues, 1);
  validateString(value.notes, path.concat("notes"), issues, 1);
  validateProvenanceMetadata(value.provenance, path.concat("provenance"), issues);
  if (isRecord(value.provenance) && (value.provenance.deployment !== value.deployment || value.provenance.dataKind !== value.dataKind || value.provenance.liveData !== value.liveData)) {
    issues.push(issue(path.concat("provenance"), "mismatched_metadata", "Routing descriptor and provenance must agree on deployment and data kind."));
  }
}

function validateProvenanceMetadata(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "routing provenance is required."));
    return;
  }
  requireKeys(value, ["role", "provider", "deployment", "dataKind", "liveData", "sourceUrl", "license", "attribution", "version", "retrievedAt", "notes", "feeds"], path, issues);
  if (value.role !== "routing") issues.push(issue(path.concat("role"), "invalid_value", "routing provenance role must be routing."));
  validateString(value.provider, path.concat("provider"), issues, 1);
  validateString(value.deployment, path.concat("deployment"), issues, 1);
  validateProviderDeployment(value.deployment, path.concat("deployment"), issues);
  validateRoutingDataKind(value.dataKind, value.deployment, value.liveData, path, issues);
  validateHttpsOrNull(value.sourceUrl, path.concat("sourceUrl"), issues);
  validateLicenseOrNull(value.license, path.concat("license"), issues);
  validateString(value.attribution, path.concat("attribution"), issues, 1);
  validateString(value.version, path.concat("version"), issues, 1);
  if (value.dataKind === "demo-static" && value.retrievedAt === "fixture-static") validateString(value.retrievedAt, path.concat("retrievedAt"), issues, 1);
  else validateIsoInstant(value.retrievedAt, path.concat("retrievedAt"), issues);
  validateString(value.notes, path.concat("notes"), issues, 1);
  if (value.feeds !== null) issues.push(issue(path.concat("feeds"), "invalid_value", "Canonical direct MVG provenance does not claim feed or realtime provenance."));
}

function validateRoutingDataKind(
  dataKind: unknown,
  deployment: unknown,
  liveData: unknown,
  path: Array<string | number>,
  issues: ResponseValidationIssue[],
): void {
  const fixture = dataKind === "demo-static" && deployment === "fixture" && liveData === false;
  const scheduled = dataKind === "scheduled" && deployment !== "fixture" && liveData === false;
  if (!fixture && !scheduled) issues.push(issue(path, "invalid_value", "Routing metadata must be coherent demo-static fixture data or scheduled non-live data."));
}

function validateProviderDeployment(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isProviderDeployment(value)) issues.push(issue(path, "invalid_enum", "Provider deployment is outside the ProviderDeploymentKind contract."));
}

function isProviderDeployment(value: unknown): value is ProviderDeploymentKind {
  return value === "fixture" || value === "self-hosted" || value === "managed" || value === "unknown";
}

function validateBoundary(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Munich boundary provenance is required."));
    return;
  }
  requireKeys(value, ["name", "sourceUrl", "metadataUrl", "retrievedAt", "contentHash", "metadataContentHash", "districtCount", "license", "attribution", "legalBoundary"], path, issues);
  validateString(value.name, path.concat("name"), issues, 1);
  validateHttpsOrNull(value.sourceUrl, path.concat("sourceUrl"), issues);
  validateHttpsOrNull(value.metadataUrl, path.concat("metadataUrl"), issues);
  validateString(value.retrievedAt, path.concat("retrievedAt"), issues, 1);
  validateHash(value.contentHash, path.concat("contentHash"), issues);
  validateHash(value.metadataContentHash, path.concat("metadataContentHash"), issues);
  if (value.districtCount !== 25 || value.legalBoundary !== false) issues.push(issue(path, "invalid_value", "Boundary metadata must identify the non-legal 25-district Munich application boundary."));
  validateRequiredLicense(value.license, path.concat("license"), issues);
  validateString(value.attribution, path.concat("attribution"), issues, 1);
}

function validateRequiredLicense(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "missing_provenance", "Official boundary metadata requires a non-null licence."));
    return;
  }
  requireKeys(value, ["name", "url"], path, issues);
  validateString(value.name, path.concat("name"), issues, 1);
  validateHttpsOrNull(value.url, path.concat("url"), issues);
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
  if (typeof latitude !== "number" || typeof longitude !== "number" || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) issues.push(issue(path, "invalid_coordinate", "Coordinates must be finite WGS84 values."));
}

function validateSelectedTolerance(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (typeof value !== "number" || !(TOLERANCE_PERCENT_OPTIONS as readonly number[]).includes(value)) issues.push(issue(path, "invalid_value", "Selected tolerance must be 5, 10, or 15."));
}

function validateEffectiveTolerance(value: unknown, selected: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 5 || value > 100 || typeof selected !== "number" || value < selected || (value - selected) % 5 !== 0) issues.push(issue(path, "invalid_value", "Effective tolerance must escalate from the selected value in five-point steps through 100."));
}

function validateFiniteInteger(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[], minimum: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value) || value < minimum) issues.push(issue(path, "invalid_integer", "Value must be a finite integer in the allowed range."));
}

function validateIsoInstant(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) issues.push(issue(path, "invalid_datetime", "Timestamp must be a canonical UTC ISO instant."));
}

function validateString(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[], minimum: number): void {
  if (typeof value !== "string" || value.length < minimum || value.length > MAX_STRING_LENGTH) issues.push(issue(path, "invalid_string", "String is missing or outside the allowed size."));
}

function validateHttpsOrNull(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (value !== null && (typeof value !== "string" || !value.startsWith("https://") || value.length > MAX_STRING_LENGTH)) issues.push(issue(path, "invalid_url", "URL must be null or HTTPS."));
}

function validateLicenseOrNull(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (value === null) return;
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "License must be null or an object."));
    return;
  }
  requireKeys(value, ["name", "url"], path, issues);
  validateString(value.name, path.concat("name"), issues, 1);
  validateHttpsOrNull(value.url, path.concat("url"), issues);
}

function validateHash(value: unknown, path: Array<string | number>, issues: ResponseValidationIssue[]): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) issues.push(issue(path, "invalid_hash", "Content hash must be a SHA-256 hex string."));
}

function isJourneyShape(value: unknown): value is { plannedDurationMilliseconds: number } {
  return isRecord(value) && typeof value.plannedDurationMilliseconds === "number";
}

function isCanonicalResponse(value: unknown): value is MeetingCalculationResponse {
  return isRecord(value) && value.contractVersion === CONTRACT_VERSION && value.status === "ok";
}

function isCoordinateRecord(value: unknown): value is { latitude: number; longitude: number } {
  return isRecord(value) && typeof value.latitude === "number" && typeof value.longitude === "number" && Number.isFinite(value.latitude) && Number.isFinite(value.longitude);
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => deepEqualJson(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && deepEqualJson(left[key], right[key]));
  }
  return false;
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

function issue(path: Array<string | number>, code: string, message: string): ResponseValidationIssue {
  return { path, code, message };
}

function invalid(singleIssue: ResponseValidationIssue): SafeMeetingResponse {
  return { success: false, issues: [singleIssue] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

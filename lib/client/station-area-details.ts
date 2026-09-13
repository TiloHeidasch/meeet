import { canonicalSearchStartMinute, type MeetingRequest, type MeetingResponse, type MeetingStationArea } from "./meeting-response.ts";

export type StationAreaDetail = {
  readonly contractVersion: "meeet-station-area-details/v1";
  readonly status: "ok" | "no-result";
  readonly reason: "no-access-seeds" | "no-reachable-stations" | null;
  readonly stationArea: MeetingStationArea;
  readonly participants: readonly [DetailParticipant, DetailParticipant];
  readonly basis: DetailBasis;
  readonly calculationRef: string;
};
export type DetailParticipant = {
  readonly id: string;
  readonly color: "red" | "blue";
  readonly origin: { readonly label: string; readonly latitude: number; readonly longitude: number };
  readonly status: "available" | "unavailable";
  readonly unavailableReason: "no-access-seeds" | "no-reachable-stations" | "station-area-unclassified" | "station-area-unavailable-for-participant" | null;
  readonly terminal: { readonly totalSeconds: number | null; readonly arrivalAt: string | null };
  readonly itinerary: readonly ItineraryLeg[] | null;
};
export type ItineraryLeg =
  | {
      readonly kind: "walk";
      readonly fromAreaId: string | null;
      readonly toAreaId: string;
      readonly fromAreaName: string | null;
      readonly toAreaName: string;
      readonly startEpochSeconds: number;
      readonly endEpochSeconds: number;
    }
  | {
      readonly kind: "transit";
      readonly fromAreaId: string;
      readonly toAreaId: string;
      readonly fromAreaName: string;
      readonly toAreaName: string;
      readonly line: string;
      readonly routeType: number;
      readonly headsign: string;
      readonly tripId: string;
      readonly startEpochSeconds: number;
      readonly endEpochSeconds: number;
    };
export type Coordinate = { readonly latitude: number; readonly longitude: number };
export type DetailBasis = { readonly contractVersion: "meeet-meeting/v3"; readonly searchStartAt: string; readonly selectedTolerancePercent: 5 | 10 | 15; readonly routingHorizonSeconds: 86400; readonly walkingVelocityMetersPerSecond: number; readonly walkingSecondsRoundingRule: string; readonly transferRadiusMeters: number; readonly changeTimeSeconds: 180 | 300 | 600; readonly deterministicSelectionPolicy: "earliest-arrival/canonical-scan-first/v1"; readonly schedule: Record<string, unknown>; readonly accessProvider: Record<string, unknown> };
type Result = { success: true; data: StationAreaDetail } | { success: false; message: string };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
const string = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
// The scheduled calculation is minute-aligned end to end: seconds must be a multiple of 60.
const wholeMinuteSeconds = (value: unknown): value is number => whole(value) && value % 60 === 0;
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const instant = (value: unknown): value is string => string(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value) && Number.isFinite(Date.parse(value));
const date = (value: unknown): value is string => string(value) && /^\d{4}-\d{2}-\d{2}$/.test(value);
const CHANGE_TIME_SECONDS = { quick: 180, medium: 300, long: 600 } as const;
function coordinate(value: unknown): value is Coordinate { return isRecord(value) && exact(value, ["latitude", "longitude"]) && typeof value.latitude === "number" && Number.isFinite(value.latitude) && value.latitude >= -90 && value.latitude <= 90 && typeof value.longitude === "number" && Number.isFinite(value.longitude) && value.longitude >= -180 && value.longitude <= 180; }
function sameCoordinate(first: unknown, second: Coordinate): boolean { return coordinate(first) && first.latitude === second.latitude && first.longitude === second.longitude; }
function sameMarker(first: unknown, second: MeetingStationArea): boolean { return isRecord(first) && exact(first, ["stationAreaId", "name", "coordinate", "mode", "classification", "redArrivalSeconds", "blueArrivalSeconds", "fasterParticipant", "withinSelectedTolerance"]) && first.stationAreaId === second.stationAreaId && first.name === second.name && first.mode === second.mode && sameCoordinate(first.coordinate, second.coordinate) && first.classification === second.classification && first.redArrivalSeconds === second.redArrivalSeconds && first.blueArrivalSeconds === second.blueArrivalSeconds && first.fasterParticipant === second.fasterParticipant && first.withinSelectedTolerance === second.withinSelectedTolerance; }
function sameOrigin(value: unknown, expected: MeetingRequest["participants"][number]["origin"]): boolean { return isRecord(value) && exact(value, ["label", "latitude", "longitude"]) && value.label === expected.label && value.latitude === expected.latitude && value.longitude === expected.longitude; }
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
function sameValue(first: unknown, second: unknown): boolean { return JSON.stringify(canonical(first)) === JSON.stringify(canonical(second)); }
function isParticipantAvailable(marker: MeetingStationArea, index: 0 | 1): boolean { const arrival = index === 0 ? marker.redArrivalSeconds : marker.blueArrivalSeconds; return arrival !== null; }
function validParticipant(value: unknown): value is DetailParticipant { return isRecord(value) && exact(value, ["id", "color", "origin", "status", "unavailableReason", "terminal", "itinerary"]) && string(value.id) && (value.color === "red" || value.color === "blue") && isRecord(value.origin) && exact(value.origin, ["label", "latitude", "longitude"]) && string(value.origin.label) && typeof value.origin.latitude === "number" && Number.isFinite(value.origin.latitude) && typeof value.origin.longitude === "number" && Number.isFinite(value.origin.longitude) && (value.status === "available" || value.status === "unavailable") && (value.unavailableReason === null || ["no-access-seeds", "no-reachable-stations", "station-area-unclassified", "station-area-unavailable-for-participant"].includes(String(value.unavailableReason))) && isRecord(value.terminal) && exact(value.terminal, ["totalSeconds", "arrivalAt"]) && (value.terminal.totalSeconds === null || wholeMinuteSeconds(value.terminal.totalSeconds)) && (value.terminal.arrivalAt === null || instant(value.terminal.arrivalAt)) && (value.itinerary === undefined || value.itinerary === null || validItinerary(value.itinerary)); }
function validSchedule(value: unknown): value is Record<string, unknown> { if (!isRecord(value) || !exact(value, ["contractVersion", "feedId", "timeZone", "scheduleContentHash", "compiledArtifactId", "serviceDateRange", "acquisition"]) || value.contractVersion !== "meeet-scheduled-routing/v1" || !string(value.feedId) || !string(value.timeZone) || !string(value.scheduleContentHash) || !string(value.compiledArtifactId) || !isRecord(value.serviceDateRange) || !exact(value.serviceDateRange, ["firstDate", "lastDate"]) || !date(value.serviceDateRange.firstDate) || !date(value.serviceDateRange.lastDate) || !isRecord(value.acquisition)) return false; return exact(value.acquisition, ["sourceUrl", "retrievedAt", "rawArchiveByteSize", "rawArchiveSha256", "feedVersion", "feedValidFrom", "feedValidUntil", "attribution", "officialAttribution", "officialLicense", "officialProvenance"]) && string(value.acquisition.sourceUrl) && instant(value.acquisition.retrievedAt) && whole(value.acquisition.rawArchiveByteSize) && string(value.acquisition.rawArchiveSha256) && string(value.acquisition.feedVersion) && date(value.acquisition.feedValidFrom) && date(value.acquisition.feedValidUntil) && string(value.acquisition.attribution) && string(value.acquisition.officialAttribution) && isRecord(value.acquisition.officialLicense) && exact(value.acquisition.officialLicense, ["name", "url"]) && string(value.acquisition.officialLicense.name) && string(value.acquisition.officialLicense.url) && isRecord(value.acquisition.officialProvenance) && exact(value.acquisition.officialProvenance, ["source", "policyId"]) && ["feed", "meeet-policy"].includes(String(value.acquisition.officialProvenance.source)) && (value.acquisition.officialProvenance.policyId === null || value.acquisition.officialProvenance.policyId === "mvv-cc-by-4.0-fallback/v1"); }
function validAccess(value: unknown): value is Record<string, unknown> { if (!isRecord(value) || !exact(value, ["name", "deployment", "dataKind", "liveData", "asOf", "notes", "provenance"]) || !string(value.name) || !["fixture", "self-hosted", "managed", "unknown"].includes(String(value.deployment)) || !["access", "demo-static"].includes(String(value.dataKind)) || value.liveData !== false || !string(value.asOf) || !string(value.notes) || !isRecord(value.provenance)) return false; const p = value.provenance; return exact(p, ["role", "provider", "deployment", "dataKind", "liveData", "sourceUrl", "license", "attribution", "version", "retrievedAt", "notes", "feeds"]) && p.role === "access" && p.liveData === false && p.deployment === value.deployment && p.dataKind === value.dataKind && string(p.provider) && string(p.version) && p.version === value.asOf && p.feeds === null; }
function expectedArrival(start: string, seconds: number): string { return new Date(Date.parse(start) + seconds * 1000).toISOString(); }
function validTerminal(participant: DetailParticipant, request: MeetingRequest): boolean { if (participant.status === "unavailable") return participant.unavailableReason !== null && participant.terminal.totalSeconds === null && participant.terminal.arrivalAt === null; if (participant.unavailableReason !== null || participant.terminal.totalSeconds === null || participant.terminal.arrivalAt === null) return false; return participant.terminal.arrivalAt === expectedArrival(canonicalSearchStartMinute(request.searchStartAt), participant.terminal.totalSeconds); }
function validItinerary(value: unknown): value is readonly ItineraryLeg[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const leg of value) {
    if (!isRecord(leg)) return false;
    if (leg.kind === "walk") {
      if (!exact(leg, ["kind", "fromAreaId", "toAreaId", "fromAreaName", "toAreaName", "startEpochSeconds", "endEpochSeconds"])) return false;
      if (!(leg.fromAreaId === null || typeof leg.fromAreaId === "string")) return false;
      if (typeof leg.toAreaId !== "string") return false;
      if (!(leg.fromAreaName === null || typeof leg.fromAreaName === "string")) return false;
      if (typeof leg.toAreaName !== "string") return false;
    } else if (leg.kind === "transit") {
      if (!exact(leg, ["kind", "fromAreaId", "toAreaId", "fromAreaName", "toAreaName", "line", "routeType", "headsign", "tripId", "startEpochSeconds", "endEpochSeconds"])) return false;
      if (typeof leg.fromAreaId !== "string" || leg.fromAreaId === "") return false;
      if (typeof leg.toAreaId !== "string" || leg.toAreaId === "") return false;
      if (typeof leg.fromAreaName !== "string" || leg.fromAreaName === "") return false;
      if (typeof leg.toAreaName !== "string" || leg.toAreaName === "") return false;
      if (typeof leg.line !== "string" || leg.line === "") return false;
      if (typeof leg.routeType !== "number" || !Number.isFinite(leg.routeType)) return false;
      if (typeof leg.headsign !== "string") return false;
      if (typeof leg.tripId !== "string" || leg.tripId === "") return false;
    } else return false;
    if (typeof leg.startEpochSeconds !== "number" || !Number.isFinite(leg.startEpochSeconds) || leg.startEpochSeconds < 0) return false;
    if (typeof leg.endEpochSeconds !== "number" || !Number.isFinite(leg.endEpochSeconds) || leg.endEpochSeconds < 0) return false;
    if (leg.endEpochSeconds < leg.startEpochSeconds) return false;
  }
  return true;
}

export function validateStationAreaDetails(value: unknown, response: MeetingResponse, request: MeetingRequest, calculationRef: string, selectedId: string): Result {
  if (!isRecord(value) || !exact(value, ["contractVersion", "status", "reason", "stationArea", "participants", "basis"]) || value.contractVersion !== "meeet-station-area-details/v1" || (value.status !== "ok" && value.status !== "no-result") || (value.reason !== null && value.reason !== "no-access-seeds" && value.reason !== "no-reachable-stations") || !Array.isArray(value.participants) || value.participants.length !== 2 || !isRecord(value.basis)) return { success: false, message: "The station-area details could not be verified." };
  const marker = response.stationAreas.find((area) => area.stationAreaId === selectedId); if (!marker || !sameMarker(value.stationArea, marker) || value.status !== response.status || value.reason !== response.reason) return { success: false, message: "The station-area details do not match this meeting surface." };
  const basis = value.basis; const responseSchedule = response.metadata.schedule; const responseAccess = response.metadata.accessProvider; if (!exact(basis, ["contractVersion", "searchStartAt", "selectedTolerancePercent", "routingHorizonSeconds", "walkingVelocityMetersPerSecond", "walkingSecondsRoundingRule", "transferRadiusMeters", "changeTimeSeconds", "deterministicSelectionPolicy", "schedule", "accessProvider"]) || basis.contractVersion !== "meeet-meeting/v3" || basis.searchStartAt !== canonicalSearchStartMinute(request.searchStartAt) || basis.selectedTolerancePercent !== request.tolerancePercent || basis.routingHorizonSeconds !== 86400 || !number(basis.walkingVelocityMetersPerSecond) || !string(basis.walkingSecondsRoundingRule) || !number(basis.transferRadiusMeters) || basis.changeTimeSeconds !== CHANGE_TIME_SECONDS[request.changeTimePreset] || basis.deterministicSelectionPolicy !== "earliest-arrival/canonical-scan-first/v1" || !validSchedule(basis.schedule) || !validAccess(basis.accessProvider) || !sameValue(basis.schedule, responseSchedule) || !sameValue(basis.accessProvider, responseAccess)) return { success: false, message: "The station-area calculation basis could not be verified." };
  if (!validParticipant(value.participants[0]) || !validParticipant(value.participants[1])) return { success: false, message: "The station-area participants could not be verified." };
  const participants = [value.participants[0], value.participants[1]] as const; const expectedUnavailable = (index: 0 | 1) => isParticipantAvailable(marker, index) ? null : value.status === "no-result" ? value.reason : marker.classification === "unclassified" ? "station-area-unclassified" : "station-area-unavailable-for-participant"; if (participants[0].color !== "red" || participants[1].color !== "blue" || participants[0].id !== request.participants[0].id || participants[1].id !== request.participants[1].id || !sameOrigin(participants[0].origin, request.participants[0].origin) || !sameOrigin(participants[1].origin, request.participants[1].origin) || participants[0].terminal.totalSeconds !== marker.redArrivalSeconds || participants[1].terminal.totalSeconds !== marker.blueArrivalSeconds || (participants[0].status === "available") !== (expectedUnavailable(0) === null) || (participants[1].status === "available") !== (expectedUnavailable(1) === null) || participants[0].unavailableReason !== expectedUnavailable(0) || participants[1].unavailableReason !== expectedUnavailable(1) || !validTerminal(participants[0], request) || !validTerminal(participants[1], request)) return { success: false, message: "The station-area evidence timeline could not be verified." };
  const expectedClassification = marker.redArrivalSeconds === null && marker.blueArrivalSeconds === null ? "unclassified" : marker.redArrivalSeconds === null ? "blue" : marker.blueArrivalSeconds === null ? "red" : Math.abs(marker.redArrivalSeconds - marker.blueArrivalSeconds) * 100 <= (marker.redArrivalSeconds + marker.blueArrivalSeconds) * Number(basis.selectedTolerancePercent) ? "fair" : marker.redArrivalSeconds < marker.blueArrivalSeconds ? "red" : "blue";
  if (marker.classification !== expectedClassification || (value.status === "no-result" && (value.reason === null || marker.classification !== "unclassified"))) return { success: false, message: "The station-area classification could not be reconciled." };
  for (const participant of participants) {
    const itinerary = participant.itinerary ?? null;
    if (participant.status === "unavailable") {
      if (itinerary !== null) return { success: false, message: "The station-area itinerary could not be verified." };
    } else if (itinerary !== null) {
      const total = participant.terminal.totalSeconds;
      if (total === null) return { success: false, message: "The station-area itinerary could not be verified." };
      const startEpoch = Date.parse(canonicalSearchStartMinute(request.searchStartAt)) / 1000;
      let lastEnd = -Infinity;
      for (const leg of itinerary) { lastEnd = Math.max(lastEnd, leg.endEpochSeconds); }
      if (Math.abs(lastEnd - (startEpoch + total)) > 60) return { success: false, message: "The station-area itinerary could not be verified." };
    }
  }
  return { success: true, data: { contractVersion: "meeet-station-area-details/v1", status: value.status, reason: value.reason, stationArea: marker, participants, basis: basis as DetailBasis, calculationRef } };
}
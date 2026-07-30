import "server-only";

import { isWithinOfficialMunichBoundary } from "./boundary.ts";
import {
  InvalidRoutingRequestError,
  ProviderNotConfiguredError,
  ProviderUnavailableError,
} from "./meeting.ts";
import type { MeetingProviders } from "./providers.ts";
import type { ValidationIssue } from "../validation/meeting.ts";
import { parseMeetingCalculationInput } from "../validation/meeting.ts";
import type {
  GeoJsonLineString,
  LocationCoordinate,
  MeetingParticipant,
  RouteAlternative,
  SelectedVenueRouteLeg,
  SelectedVenueRouteResponse,
  SelectedVenueRouteStep,
  SelectedVenueRouteVenue,
  RoutingMatrixCell,
  TravelMode,
} from "./types.ts";
import { assertSelectedVenueRouteResponse } from "./selected-venue-response.ts";

export const MAX_SELECTED_VENUE_REQUEST_BODY_BYTES = 32 * 1024;
const MAX_SELECTED_VENUE_ID_LENGTH = 64;
const MAX_SELECTED_VENUE_NAME_LENGTH = 512;
const MAX_SELECTED_VENUE_ROUTE_PARTS = 100;

export interface SelectedVenueRouteInput {
  selectedPoi: SelectedVenueRouteVenue;
  participants: readonly MeetingParticipant[];
  departureAt: string;
}

export type SelectedVenueRouteInputResult =
  | { success: true; data: SelectedVenueRouteInput }
  | { success: false; issues: readonly ValidationIssue[] };

/** Parse and normalize the public request body before any provider call. */
export function parseSelectedVenueRouteInput(
  input: unknown,
  now = new Date(),
): SelectedVenueRouteInputResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return {
      success: false,
      issues: [issue([], "invalid_type", "Request body must be a JSON object.")],
    };
  }

  addUnknownKeyIssues(
    input,
    ["selectedPoi", "participants", "departureAt"],
    [],
    issues,
  );
  const hasSelectedPoi = Object.prototype.hasOwnProperty.call(input, "selectedPoi");
  const venue = parseVenue(
    hasSelectedPoi ? input.selectedPoi : undefined,
    ["selectedPoi"],
    issues,
  );

  const participantValue = input.participants;
  if (!Array.isArray(participantValue)) {
    issues.push(issue(["participants"], "invalid_type", "participants must be an array containing 2 to 4 participants."));
  } else {
    participantValue.forEach((participant, index) => {
      if (!isRecord(participant) || typeof participant.id !== "string" || participant.id.trim().length === 0) {
        issues.push(issue(["participants", index, "id"], "invalid_type", "Each participant must have a non-empty id."));
      }
    });
  }

  const participantInput = {
    participants: participantValue,
    ...(Object.prototype.hasOwnProperty.call(input, "departureAt")
      ? { departureAt: input.departureAt }
      : {}),
  };
  const parsedParticipants = parseMeetingCalculationInput(participantInput, now);
  if (!parsedParticipants.success) issues.push(...parsedParticipants.issues);

  if (issues.length > 0 || !venue || !parsedParticipants.success) {
    return { success: false, issues };
  }
  return {
    success: true,
    data: {
      selectedPoi: venue,
      participants: parsedParticipants.data.participants,
      departureAt: parsedParticipants.data.departureAt,
    },
  };
}

/** Route all participants to one selected POI and project the client DTO. */
export async function calculateSelectedVenueRoutes(
  input: SelectedVenueRouteInput,
  providers: MeetingProviders,
  signal?: AbortSignal,
): Promise<SelectedVenueRouteResponse> {
  const supportedModes = new Set(providers.routing.capabilities.supportedModes);
  const matrixParticipants = input.participants.filter((participant) =>
    supportedModes.has(participant.mode),
  );
  if (matrixParticipants.length > providers.routing.capabilities.maxParticipants) {
    throw new InvalidRoutingRequestError(
      "The request exceeds the selected routing provider participant limit.",
      [
        issue(
          ["participants"],
          "provider_participant_limit",
          `The selected routing provider supports at most ${providers.routing.capabilities.maxParticipants} participants.`,
        ),
      ],
    );
  }
  if (
    matrixParticipants.length > providers.routing.capabilities.maxMatrixEntries
  ) {
    throw new InvalidRoutingRequestError(
      "The request exceeds the selected routing provider matrix limit.",
      [
        issue(
          ["participants"],
          "provider_matrix_limit",
          "The selected routing provider cannot route this participant set in one bounded request.",
        ),
      ],
    );
  }

  const matrix = matrixParticipants.length > 0
    ? await invokeRoutingProvider(() => providers.routing.getTravelTimeMatrix({
      participants: matrixParticipants.map((participant) => ({
        participantId: participant.id,
        origin: participant.location,
        mode: participant.mode,
      })),
      destinations: [{
        id: input.selectedPoi.id,
        coordinate: toCoordinate(input.selectedPoi.coordinates),
        sampleKind: "center",
      }],
      departureAt: input.departureAt,
      signal,
    }))
    : null;
  const matrixByParticipant = matrix
    ? validateAndIndexVenueMatrix(matrix, matrixParticipants, input.selectedPoi.id, input.departureAt)
    : new Map<string, RoutingMatrixCell>();

  const detailedAlternatives = new Map<string, RouteAlternative | null>();
  if (providers.routeAlternatives) {
    const transitParticipants = input.participants.filter((participant) => participant.mode === "transit");
    const details = await Promise.all(
      transitParticipants.map((participant) =>
        invokeRoutingProvider(() => providers.routeAlternatives!.discoverRouteAlternatives({
          origin: participant.location,
          destination: toCoordinate(input.selectedPoi.coordinates),
          departureAt: input.departureAt,
          signal,
        })),
      ),
    );
    details.forEach((result, index) => {
      if (!result || !Array.isArray(result.alternatives)) {
        throw new ProviderUnavailableError("routing");
      }
      detailedAlternatives.set(
        transitParticipants[index].id,
        selectEarliestAlternative(result.alternatives),
      );
    });
  }

  const legs = input.participants.map((participant) => {
    const alternative = detailedAlternatives.get(participant.id);
    if (participant.mode === "transit" && alternative) {
      return safelyProjectDetailedLeg(
        participant,
        input.selectedPoi,
        input.departureAt,
        alternative,
        providers.routeAlternatives?.descriptor.name ?? providers.routing.descriptor.name,
      );
    }
    return projectSummaryLeg(
      participant,
      input.selectedPoi,
      input.departureAt,
      matrixByParticipant.get(participant.id) ?? null,
      providers.routing.descriptor.name,
    );
  });

  return assertSelectedVenueRouteResponse({
    contractVersion: "meeet-venue-routes/v1",
    status: "ok",
    departureAt: input.departureAt,
    venue: input.selectedPoi,
    legs,
  });
}

function safelyProjectDetailedLeg(
  participant: MeetingParticipant,
  venue: SelectedVenueRouteVenue,
  departureAt: string,
  alternative: RouteAlternative,
  source: string,
): SelectedVenueRouteLeg {
  try {
    return projectDetailedLeg(participant, venue, departureAt, alternative, source);
  } catch (error) {
    if (error instanceof ProviderUnavailableError) throw error;
    throw new ProviderUnavailableError("routing");
  }
}

export type SelectedVenueRouteApiErrorCode =
  | "MALFORMED_JSON"
  | "INVALID_REQUEST"
  | "REQUEST_TOO_LARGE"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_UNAVAILABLE"
  | "ROUTE_CALCULATION_FAILED";

export interface SelectedVenueRouteApiErrorResponse {
  error: {
    code: SelectedVenueRouteApiErrorCode;
    message: string;
    issues?: readonly ValidationIssue[];
  };
}

export async function handleSelectedVenueRoutesPost(
  request: Request,
  providers: MeetingProviders,
): Promise<Response> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_SELECTED_VENUE_REQUEST_BODY_BYTES) {
    return jsonError(
      413,
      "REQUEST_TOO_LARGE",
      `Request body must not exceed ${MAX_SELECTED_VENUE_REQUEST_BODY_BYTES} bytes.`,
    );
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return jsonError(400, "MALFORMED_JSON", "Request body could not be read as JSON.");
  }
  if (new TextEncoder().encode(bodyText).byteLength > MAX_SELECTED_VENUE_REQUEST_BODY_BYTES) {
    return jsonError(
      413,
      "REQUEST_TOO_LARGE",
      `Request body must not exceed ${MAX_SELECTED_VENUE_REQUEST_BODY_BYTES} bytes.`,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return jsonError(400, "MALFORMED_JSON", "Request body must contain valid JSON.");
  }
  const parsed = parseSelectedVenueRouteInput(body, new Date());
  if (!parsed.success) {
    return jsonError(400, "INVALID_REQUEST", "Request body failed validation.", parsed.issues);
  }

  try {
    return Response.json(
      await calculateSelectedVenueRoutes(parsed.data, providers, request.signal),
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof InvalidRoutingRequestError) {
      return jsonError(400, "INVALID_REQUEST", error.message, error.issues);
    }
    if (error instanceof ProviderNotConfiguredError) {
      return jsonError(
        503,
        "PROVIDER_NOT_CONFIGURED",
        "The selected venue routing provider is not configured for this deployment.",
      );
    }
    if (error instanceof ProviderUnavailableError) {
      return jsonError(
        503,
        "PROVIDER_UNAVAILABLE",
        "The selected venue route provider is currently unavailable.",
      );
    }
    return jsonError(
      500,
      "ROUTE_CALCULATION_FAILED",
      "Selected venue routes could not be calculated.",
    );
  }
}

function parseVenue(
  value: unknown,
  path: Array<string | number>,
  issues: ValidationIssue[],
): SelectedVenueRouteVenue | undefined {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "selectedPoi must be an object."));
    return undefined;
  }
  addUnknownKeyIssues(value, ["id", "name", "coordinates", "category", "address", "source"], path, issues);
  const id = parseBoundedString(value.id, path.concat("id"), MAX_SELECTED_VENUE_ID_LENGTH, issues, "id");
  const name = parseBoundedString(value.name, path.concat("name"), MAX_SELECTED_VENUE_NAME_LENGTH, issues, "name");
  const coordinates = parsePosition(value.coordinates, path.concat("coordinates"), issues);
  const category = value.category === "food" || value.category === "drink"
    ? value.category
    : undefined;
  if (value.category !== undefined && value.category !== "food" && value.category !== "drink") {
    issues.push(issue(path.concat("category"), "invalid_enum", "category must be food or drink."));
  }
  const address = parseOptionalString(value.address, path.concat("address"), 512, issues, "address");
  const source = parseOptionalString(value.source, path.concat("source"), 512, issues, "source");
  if (!coordinates || !isWithinOfficialMunichBoundary(toCoordinate(coordinates))) {
    if (coordinates) {
      issues.push(issue(path.concat("coordinates"), "outside_official_munich_boundary", "The selected venue must be inside the official Munich application boundary."));
    }
  }
  if (!id || !name || !coordinates || issues.some((item) => item.path.join(".") === path.join(".") + ".coordinates" && item.code === "outside_official_munich_boundary")) {
    return undefined;
  }
  return {
    id,
    name,
    coordinates,
    ...(category === undefined ? {} : { category }),
    ...(address === undefined ? {} : { address }),
    ...(source === undefined ? {} : { source }),
  };
}

function projectDetailedLeg(
  participant: MeetingParticipant,
  venue: SelectedVenueRouteVenue,
  departureAt: string,
  alternative: RouteAlternative,
  source: string,
): SelectedVenueRouteLeg {
  if (alternative.parts.length === 0 || alternative.parts.length > MAX_SELECTED_VENUE_ROUTE_PARTS) {
    throw new ProviderUnavailableError("routing");
  }
  const steps: SelectedVenueRouteStep[] = alternative.parts.map((part) => {
    const departureTimestamp = Date.parse(part.effectiveDepartureAt);
    const arrivalTimestamp = Date.parse(part.effectiveArrivalAt);
    if (!Number.isFinite(departureTimestamp) || !Number.isFinite(arrivalTimestamp) || arrivalTimestamp < departureTimestamp) {
      throw new ProviderUnavailableError("routing");
    }
    const lineLabel = part.line.identity === part.line.type
      ? part.line.type
      : `${part.line.identity} (${part.line.type})`;
    return {
      kind: "transit",
      instruction: `Take ${lineLabel} from stop ${part.from.id} to stop ${part.to.id}.`,
      from: part.from.coordinate,
      to: part.to.coordinate,
      fromStopId: part.from.id,
      toStopId: part.to.id,
      line: part.line,
      departureAt: new Date(departureTimestamp).toISOString(),
      arrivalAt: new Date(arrivalTimestamp).toISOString(),
      durationMinutes: roundMinutes((arrivalTimestamp - departureTimestamp) / 60_000),
    };
  });
  const arrivalTimestamp = Date.parse(alternative.effectiveArrivalAt);
  const requestedDepartureTimestamp = Date.parse(departureAt);
  if (!Number.isFinite(arrivalTimestamp) || !Number.isFinite(requestedDepartureTimestamp) || arrivalTimestamp < requestedDepartureTimestamp) {
    throw new ProviderUnavailableError("routing");
  }
  const durationMinutes = roundMinutes((arrivalTimestamp - requestedDepartureTimestamp) / 60_000);
  if (durationMinutes > 24 * 60) throw new ProviderUnavailableError("routing");
  return {
    participantId: participant.id,
    mode: "transit",
    status: "detailed",
    summary: `Public transport to ${venue.name} (${formatMinutes(durationMinutes)}).`,
    durationMinutes,
    steps,
    geometry: createStopSequenceGeometry(alternative),
    source,
  };
}

function projectSummaryLeg(
  participant: MeetingParticipant,
  venue: SelectedVenueRouteVenue,
  departureAt: string,
  cell: RoutingMatrixCell | null,
  defaultSource: string,
): SelectedVenueRouteLeg {
  const durationMinutes = cell?.status === "ok" && cell.minutes !== null
    ? roundMinutes(cell.minutes)
    : null;
  const modeLabel = modeName(participant.mode);
  const summary = durationMinutes === null
    ? `${modeLabel} route duration to ${venue.name} is unavailable.`
    : `${modeLabel} to ${venue.name} (${formatMinutes(durationMinutes)}).`;
  const arrivalAt = durationMinutes === null
    ? null
    : addMinutes(departureAt, durationMinutes);
  const step: SelectedVenueRouteStep = {
    kind: "summary",
    instruction: summary,
    from: {
      latitude: participant.location.latitude,
      longitude: participant.location.longitude,
    },
    to: toCoordinate(venue.coordinates),
    fromStopId: null,
    toStopId: null,
    line: null,
    departureAt: durationMinutes === null ? null : departureAt,
    arrivalAt,
    durationMinutes,
  };
  return {
    participantId: participant.id,
    mode: participant.mode,
    status: "summary",
    summary,
    durationMinutes,
    steps: [step],
    geometry: null,
    source: cell?.source ?? defaultSource,
  };
}

function createStopSequenceGeometry(alternative: RouteAlternative): GeoJsonLineString | null {
  const coordinates: Array<[number, number]> = [];
  for (const part of alternative.parts) {
    if (!part.from.coordinate || !part.to.coordinate ||
      !isValidCoordinate(part.from.coordinate) || !isValidCoordinate(part.to.coordinate) ||
      !isWithinOfficialMunichBoundary(part.from.coordinate) ||
      !isWithinOfficialMunichBoundary(part.to.coordinate)) {
      return null;
    }
    appendCoordinate(coordinates, part.from.coordinate);
    appendCoordinate(coordinates, part.to.coordinate);
  }
  return coordinates.length >= 2
    ? { type: "LineString", coordinates }
    : null;
}

function appendCoordinate(
  positions: Array<[number, number]>,
  coordinate: LocationCoordinate,
): void {
  const position: [number, number] = [coordinate.longitude, coordinate.latitude];
  const previous = positions[positions.length - 1];
  if (!previous || previous[0] !== position[0] || previous[1] !== position[1]) positions.push(position);
}

function selectEarliestAlternative(
  alternatives: readonly RouteAlternative[],
): RouteAlternative | null {
  if (!Array.isArray(alternatives)) throw new ProviderUnavailableError("routing");
  const valid = alternatives.filter((alternative) => {
    if (!alternative || !Array.isArray(alternative.parts) || alternative.parts.length === 0) {
      throw new ProviderUnavailableError("routing");
    }
    const arrival = Date.parse(alternative.effectiveArrivalAt);
    const departure = Date.parse(alternative.effectiveDepartureAt);
    return Number.isFinite(arrival) && Number.isFinite(departure) && arrival >= departure;
  });
  return valid.reduce<RouteAlternative | null>((earliest, alternative) => {
    if (!earliest) return alternative;
    const arrival = Date.parse(alternative.effectiveArrivalAt);
    const earliestArrival = Date.parse(earliest.effectiveArrivalAt);
    return arrival < earliestArrival ||
      (arrival === earliestArrival && alternative.itineraryIdentity.localeCompare(earliest.itineraryIdentity) < 0)
      ? alternative
      : earliest;
  }, null);
}

function validateAndIndexVenueMatrix(
  response: Awaited<ReturnType<NonNullable<MeetingProviders["routing"]>["getTravelTimeMatrix"]>>,
  participants: readonly MeetingParticipant[],
  destinationId: string,
  departureAt: string,
): Map<string, RoutingMatrixCell> {
  if (
    !response ||
    response.contractVersion !== "meeet-routing-gateway/v1" ||
    response.departureAt !== departureAt ||
    !Array.isArray(response.travelTimes) ||
    response.travelTimes.length !== participants.length
  ) {
    throw new ProviderUnavailableError("routing");
  }
  const expectedModes = new Map(participants.map((participant) => [participant.id, participant.mode]));
  const cells = new Map<string, RoutingMatrixCell>();
  for (const cell of response.travelTimes) {
    if (
      !expectedModes.has(cell.participantId) ||
      expectedModes.get(cell.participantId) !== cell.mode ||
      cell.destinationId !== destinationId ||
      typeof cell.source !== "string" ||
      cell.source.trim().length === 0 ||
      (cell.status === "ok" &&
        (cell.minutes === null || !Number.isFinite(cell.minutes) || cell.minutes < 0 || cell.minutes > 24 * 60)) ||
      (cell.status === "unreachable" && cell.minutes !== null) ||
      (cell.status !== "ok" && cell.status !== "unreachable") ||
      cells.has(cell.participantId)
    ) {
      throw new ProviderUnavailableError("routing");
    }
    cells.set(cell.participantId, cell);
  }
  if (cells.size !== participants.length) throw new ProviderUnavailableError("routing");
  return cells;
}

async function invokeRoutingProvider<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ProviderUnavailableError || error instanceof ProviderNotConfiguredError) {
      throw error;
    }
    throw new ProviderUnavailableError("routing");
  }
}

function parsePosition(
  value: unknown,
  path: Array<string | number>,
  issues: ValidationIssue[],
): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2 ||
    typeof value[0] !== "number" || !Number.isFinite(value[0]) || value[0] < -180 || value[0] > 180 ||
    typeof value[1] !== "number" || !Number.isFinite(value[1]) || value[1] < -90 || value[1] > 90) {
    issues.push(issue(path, "invalid_coordinate", "coordinates must be [longitude, latitude] WGS84 values."));
    return undefined;
  }
  return [value[0], value[1]];
}

function parseBoundedString(
  value: unknown,
  path: Array<string | number>,
  maximum: number,
  issues: ValidationIssue[],
  label: string,
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maximum) {
    issues.push(issue(path, "invalid_string", `${label} must be a non-empty string of at most ${maximum} characters.`));
    return undefined;
  }
  return value.trim();
}

function parseOptionalString(
  value: unknown,
  path: Array<string | number>,
  maximum: number,
  issues: ValidationIssue[],
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  return parseBoundedString(value, path, maximum, issues, label);
}

function addUnknownKeyIssues(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: Array<string | number>,
  issues: ValidationIssue[],
): void {
  Object.keys(value).forEach((key) => {
    if (!allowedKeys.includes(key)) issues.push(issue(path.concat(key), "unknown_key", `Unknown field ${key} is not allowed.`));
  });
}

function toCoordinate(position: [number, number]): LocationCoordinate {
  return { latitude: position[1], longitude: position[0] };
}

function isValidCoordinate(coordinate: LocationCoordinate): boolean {
  return Number.isFinite(coordinate.latitude) && Number.isFinite(coordinate.longitude) &&
    coordinate.latitude >= -90 && coordinate.latitude <= 90 &&
    coordinate.longitude >= -180 && coordinate.longitude <= 180;
}

function modeName(mode: TravelMode): string {
  return mode === "transit" ? "Public transport" : mode === "bike" ? "Bike" : "Car";
}

function formatMinutes(minutes: number): string {
  return `${minutes.toFixed(1).replace(/\.0$/, "")} min`;
}

function roundMinutes(minutes: number): number {
  return Number(minutes.toFixed(1));
}

function addMinutes(departureAt: string, minutes: number): string | null {
  const timestamp = Date.parse(departureAt);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp + minutes * 60_000).toISOString();
}

function issue(
  path: Array<string | number>,
  code: string,
  message: string,
): ValidationIssue {
  return { path, code, message };
}

function jsonError(
  status: number,
  code: SelectedVenueRouteApiErrorCode,
  message: string,
  issues?: readonly ValidationIssue[],
): Response {
  const response: SelectedVenueRouteApiErrorResponse = {
    error: { code, message, ...(issues ? { issues } : {}) },
  };
  return Response.json(response, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

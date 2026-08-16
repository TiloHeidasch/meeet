import { ProviderNotConfiguredError, ProviderUnavailableError, type MeetingProviders } from "./providers.ts";
import type { ScheduledValidationIssue } from "../validation/meeting-v3.ts";
import { calculateScheduledMeetingWithBasis, deepFreeze, type ScheduledCalculationBasis } from "./scheduled-routing/meeting.ts";
import { buildScheduledStationAreaCatalog } from "./scheduled-routing/surface.ts";
import {
  parseScheduledMeetingRequest,
  validateScheduledMeetingResponse,
} from "../validation/meeting-v3.ts";
import { ScheduleArtifactUnavailableError } from "./scheduled-routing/artifact.ts";
import {
  createScheduledCalculationDeadline,
  scheduledCalculationAdmission,
  SCHEDULED_CALCULATION_CONCURRENCY,
  SCHEDULED_CALCULATION_DEADLINE_MS,
  type ScheduledCalculationAdmission,
  type ScheduledDeadlineOptions,
  type ScheduledCalculationDeadline,
} from "./scheduled-admission.ts";
import { ProviderConfigurationError } from "../providers/config.ts";
import {
  STATION_AREA_CALCULATION_REF_HEADER,
  stationAreaCalculationBasisCache,
  isStationAreaCalculationBasisCacheLimitError,
  type StationAreaCalculationBasisCache,
} from "./station-area-details-cache.ts";
import {
  createScheduledRoutingWindow,
  routeScheduledSelectedBoardingStop,
  SCHEDULED_DETAIL_SELECTION_POLICY,
} from "./scheduled-routing/router.ts";
import type { ScheduledMeetingRequest, ScheduledMeetingStationAreaDto } from "../validation/meeting-v3.ts";
import {
  STATION_AREA_DETAILS_CONTRACT_VERSION,
  type StationAreaDetailParticipantDto,
  type StationAreaDetailsBasisDto,
  type StationAreaDetailsResponseDto,
} from "./station-area-details-contract.ts";
import { validateStationAreaDetailsResponse } from "../validation/station-area-details-v1.ts";

export {
  ScheduledCalculationAdmission,
  ScheduledCalculationAdmissionError,
  ScheduledCalculationDeadlineError,
} from "./scheduled-admission.ts";
export const DEFAULT_SCHEDULED_CALCULATION_CONCURRENCY = SCHEDULED_CALCULATION_CONCURRENCY;
export const DEFAULT_SCHEDULED_CALCULATION_DEADLINE_MS = SCHEDULED_CALCULATION_DEADLINE_MS;

export const MAX_MEETING_REQUEST_BODY_BYTES = 32 * 1024;

export type MeetingApiErrorCode =
  | "MALFORMED_JSON"
  | "INVALID_REQUEST"
  | "REQUEST_TOO_LARGE"
  | "TEMPORARILY_UNAVAILABLE"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_UNAVAILABLE"
  | "CALCULATION_FAILED"
  | "INVALID_CALCULATION_REF"
  | "CALCULATION_REF_EXPIRED"
  | "CALCULATION_REF_MISMATCH"
  | "STATION_AREA_NOT_FOUND"
  | "DETAIL_FAILED";

export interface MeetingApiErrorResponse {
  error: {
    code: MeetingApiErrorCode;
    message: string;
    issues?: readonly ScheduledValidationIssue[];
  };
}

export type MeetingProvidersSource = MeetingProviders | (() => MeetingProviders);

export interface HandleMeetingPostOptions {
  readonly admission?: ScheduledCalculationAdmission;
  readonly deadline?: ScheduledDeadlineOptions;
  /** Flat aliases keep the server test seam convenient without changing policy. */
  readonly deadlineMs?: number;
  readonly now?: () => number;
  readonly deadlineSignal?: AbortSignal;
  readonly basisCache?: StationAreaCalculationBasisCache;
}

export async function handleMeetingPost(
  request: Request,
  providersSource: MeetingProvidersSource,
  options: HandleMeetingPostOptions = {},
): Promise<Response> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && isTooLargeContentLength(declaredLength)) {
    return jsonError(
      413,
      "REQUEST_TOO_LARGE",
      `Request body must not exceed ${MAX_MEETING_REQUEST_BODY_BYTES} bytes.`,
    );
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return jsonError(400, "MALFORMED_JSON", "Request body could not be read as JSON.");
  }

  if (new TextEncoder().encode(bodyText).byteLength > MAX_MEETING_REQUEST_BODY_BYTES) {
    return jsonError(
      413,
      "REQUEST_TOO_LARGE",
      `Request body must not exceed ${MAX_MEETING_REQUEST_BODY_BYTES} bytes.`,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return jsonError(400, "MALFORMED_JSON", "Request body must contain valid JSON.");
  }

  const parsedScheduled = parseScheduledMeetingRequest(body);
  if (!parsedScheduled.success) {
    return jsonError(400, "INVALID_REQUEST", "Request body must use the meeet-meeting/v3 scheduled contract.", parsedScheduled.issues);
  }
  const release = (options.admission ?? scheduledCalculationAdmission).tryAcquire();
  if (release === null) {
    return jsonError(503, "TEMPORARILY_UNAVAILABLE", "A scheduled meeting calculation is already in progress. Please try again shortly.");
  }
  let deadline: ScheduledCalculationDeadline | undefined;
  try {
    deadline = createScheduledCalculationDeadline({
      ...options.deadline,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.deadlineSignal === undefined ? {} : { deadlineSignal: options.deadlineSignal }),
      requestSignal: request.signal,
    });
    deadline.check();
    const providers = typeof providersSource === "function" ? providersSource() : providersSource;
    deadline.check();
    const calculationProviders = withDeadlineCheckedAccess(providers, deadline);
    const calculation = await calculateScheduledMeetingWithBasis(parsedScheduled.data, {
      artifact: calculationProviders.scheduledArtifact,
      access: calculationProviders.scheduledAccess,
      deadlineCheck: deadline.check,
    }, deadline.signal);
    const result = calculation.response;
    deadline.check();
    const stationAreaCatalog = calculationProviders.scheduledArtifact === undefined
      ? undefined
      : buildScheduledStationAreaCatalog(calculationProviders.scheduledArtifact, deadline.check);
    if (!validateScheduledMeetingResponse(result, parsedScheduled.data, { stationAreaCatalog, deadlineCheck: deadline.check }).success) {
      return jsonError(500, "CALCULATION_FAILED", "The scheduled meeting response failed validation.");
    }
    deadline.check();
    const basisCache = options.basisCache ?? stationAreaCalculationBasisCache;
    let calculationReference: string;
    try {
      calculationReference = basisCache.put(calculation.basis);
    } catch (error) {
      if (isStationAreaCalculationBasisCacheLimitError(error)) {
        return Response.json(result, { status: 200 });
      }
      throw error;
    }
    deadline.check();
    return Response.json(result, { status: 200, headers: { [STATION_AREA_CALCULATION_REF_HEADER]: calculationReference } });
  } catch (error) {
    if (error instanceof ProviderConfigurationError) throw error;
    if (deadline?.isExpired()) {
      return jsonError(503, "TEMPORARILY_UNAVAILABLE", "The scheduled meeting calculation exceeded its 30-second deadline. Please try again shortly.");
    }
    return scheduledErrorResponse(error);
  } finally {
    deadline?.dispose();
    release();
  }
}

export async function handleStationAreaDetailsPost(
  request: Request,
  stationAreaId: string,
  providersSource: MeetingProvidersSource,
  options: HandleMeetingPostOptions = {},
): Promise<Response> {
  if (stationAreaId.trim() === "") return jsonError(400, "INVALID_REQUEST", "stationAreaId must be non-empty.");
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && isTooLargeContentLength(declaredLength)) return jsonError(413, "REQUEST_TOO_LARGE", `Request body must not exceed ${MAX_MEETING_REQUEST_BODY_BYTES} bytes.`);
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return jsonError(400, "MALFORMED_JSON", "Request body could not be read as JSON.");
  }
  if (new TextEncoder().encode(bodyText).byteLength > MAX_MEETING_REQUEST_BODY_BYTES) return jsonError(413, "REQUEST_TOO_LARGE", `Request body must not exceed ${MAX_MEETING_REQUEST_BODY_BYTES} bytes.`);
  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return jsonError(400, "MALFORMED_JSON", "Request body must contain valid JSON.");
  }
  const parsedScheduled = parseScheduledMeetingRequest(body);
  if (!parsedScheduled.success) return jsonError(400, "INVALID_REQUEST", "Request body must use the meeet-meeting/v3 scheduled contract.", parsedScheduled.issues);
  const reference = request.headers.get(STATION_AREA_CALCULATION_REF_HEADER);
  if (reference === null || reference.trim() === "") return jsonError(400, "INVALID_CALCULATION_REF", `The ${STATION_AREA_CALCULATION_REF_HEADER} header is required.`);
  const basisCache = options.basisCache ?? stationAreaCalculationBasisCache;
  const basis = basisCache.get(reference);
  if (basis === undefined) return jsonError(410, "CALCULATION_REF_EXPIRED", "The calculation reference is missing or has expired. Recalculate the meeting surface.");
  if (!sameScheduledRequest(basis.canonicalRequest, parsedScheduled.data)) return jsonError(409, "CALCULATION_REF_MISMATCH", "The calculation reference does not match the supplied meeet-meeting/v3 request.");
  const marker = basis.stationAreas.find((candidate) => candidate.stationAreaId === stationAreaId);
  if (marker === undefined) return jsonError(404, "STATION_AREA_NOT_FOUND", "The requested station area is not in the cached calculation surface.");
  if (basis.status === "no-result" || marker.classification === "unclassified") {
    return unavailableStationAreaDetailsResponse(parsedScheduled.data, basis, marker);
  }

  const release = (options.admission ?? scheduledCalculationAdmission).tryAcquire();
  if (release === null) return jsonError(503, "TEMPORARILY_UNAVAILABLE", "A scheduled meeting calculation is already in progress. Please try again shortly.");
  let deadline: ScheduledCalculationDeadline | undefined;
  try {
    deadline = createScheduledCalculationDeadline({
      ...options.deadline,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.deadlineSignal === undefined ? {} : { deadlineSignal: options.deadlineSignal }),
      requestSignal: request.signal,
    });
    deadline.check();
    const providers = typeof providersSource === "function" ? providersSource() : providersSource;
    deadline.check();
    const artifact = providers.scheduledArtifact;
    if (artifact === undefined) throw new ProviderNotConfiguredError("routing");
    if (artifact.feedId !== basis.artifactIdentity.feedId || artifact.timeZone !== basis.artifactIdentity.timeZone || artifact.provenance.contentHash !== basis.artifactIdentity.scheduleContentHash || artifact.provenance.compiledArtifactId !== basis.artifactIdentity.compiledArtifactId) {
      return jsonError(409, "CALCULATION_REF_MISMATCH", "The calculation reference belongs to a different scheduled timetable artifact.");
    }
    const window = createScheduledRoutingWindow(artifact, parsedScheduled.data.searchStartAt, {
      walkingVelocityMetersPerSecond: basis.routingOptions.walkingVelocityMetersPerSecond,
      transferRadiusMeters: basis.routingOptions.transferRadiusMeters,
      deadlineCheck: deadline.check,
    });
    const participants: [StationAreaDetailParticipantDto, StationAreaDetailParticipantDto] = [
      detailParticipant("red", parsedScheduled.data.participants[0], marker, basis, artifact, window, deadline),
      detailParticipant("blue", parsedScheduled.data.participants[1], marker, basis, artifact, window, deadline),
    ];
    const detailBasis = makeDetailBasis(parsedScheduled.data, basis);
    const detail: StationAreaDetailsResponseDto = deepFreeze({
      contractVersion: STATION_AREA_DETAILS_CONTRACT_VERSION,
      status: basis.status,
      reason: basis.reason,
      stationArea: { ...marker },
      participants,
      basis: detailBasis,
    });
    deadline.check();
    const validation = validateStationAreaDetailsResponse(detail, { request: parsedScheduled.data, selectedMarker: marker, artifactIdentity: basis.artifactIdentity, selectedBoardingStops: selectedBoardingStopContext(artifact, marker) });
    if (!validation.success) return jsonError(500, "DETAIL_FAILED", "The station-area detail response failed strict validation.");
    return Response.json(detail, { status: 200 });
  } catch (error) {
    if (error instanceof ProviderConfigurationError) throw error;
    if (deadline?.isExpired()) return jsonError(503, "TEMPORARILY_UNAVAILABLE", "The scheduled station-area detail exceeded its 30-second deadline. Please try again shortly.");
    if (error instanceof RangeError) return jsonError(400, "INVALID_REQUEST", error.message);
    if (error instanceof ProviderUnavailableError || error instanceof ScheduleArtifactUnavailableError) return scheduledErrorResponse(error);
    return jsonError(500, "DETAIL_FAILED", "The scheduled station-area detail could not be completed.");
  } finally {
    deadline?.dispose();
    release();
  }
}

function getMarkerBoardingStopId(marker: ScheduledMeetingStationAreaDto, color: "red" | "blue"): string | null {
  return color === "red" ? marker.redBoardingStopId : marker.blueBoardingStopId;
}

function getMarkerArrivalSeconds(marker: ScheduledMeetingStationAreaDto, color: "red" | "blue"): number | null {
  return color === "red" ? marker.redArrivalSeconds : marker.blueArrivalSeconds;
}

function selectedBoardingStopContext(
  artifact: NonNullable<MeetingProviders["scheduledArtifact"]>,
  marker: ScheduledMeetingStationAreaDto,
): Partial<Record<"red" | "blue", { readonly boardingStopId: string; readonly coordinate: { readonly latitude: number; readonly longitude: number } }>> {
  const result: Partial<Record<"red" | "blue", { readonly boardingStopId: string; readonly coordinate: { readonly latitude: number; readonly longitude: number } }>> = {};
  for (const color of ["red", "blue"] as const) {
    const boardingStopId = getMarkerBoardingStopId(marker, color);
    const stop = boardingStopId === null ? undefined : artifact.boardingStops.find((candidate) => candidate.id === boardingStopId);
    if (stop !== undefined) result[color] = { boardingStopId: stop.id, coordinate: stop.coordinate };
  }
  return result;
}

function makeDetailBasis(
  request: ScheduledMeetingRequest,
  basis: ScheduledCalculationBasis,
): StationAreaDetailsBasisDto {
  return {
    contractVersion: "meeet-meeting/v3",
    searchStartAt: request.searchStartAt,
    selectedTolerancePercent: request.tolerancePercent,
    routingHorizonSeconds: basis.routingOptions.routingHorizonSeconds as 86_400,
    walkingVelocityMetersPerSecond: basis.routingOptions.walkingVelocityMetersPerSecond,
    walkingSecondsRoundingRule: basis.routingOptions.walkingSecondsRoundingRule,
    transferRadiusMeters: basis.routingOptions.transferRadiusMeters,
    deterministicSelectionPolicy: SCHEDULED_DETAIL_SELECTION_POLICY,
    schedule: basis.scheduleProvenance,
    accessProvider: basis.accessProvenance,
  };
}

function unavailableStationAreaDetailsResponse(
  request: ScheduledMeetingRequest,
  basis: ScheduledCalculationBasis,
  marker: ScheduledMeetingStationAreaDto,
): Response {
  const unavailableReason = basis.status === "no-result"
    ? basis.reason
    : "station-area-unclassified";
  const participants: [StationAreaDetailParticipantDto, StationAreaDetailParticipantDto] = [
    unavailableDetailParticipant(request.participants[0], "red", unavailableReason),
    unavailableDetailParticipant(request.participants[1], "blue", unavailableReason),
  ];
  const detail: StationAreaDetailsResponseDto = deepFreeze({
    contractVersion: STATION_AREA_DETAILS_CONTRACT_VERSION,
    status: basis.status,
    reason: basis.reason,
    stationArea: { ...marker },
    participants,
    basis: makeDetailBasis(request, basis),
  });
  const validation = validateStationAreaDetailsResponse(detail, { request, selectedMarker: marker });
  if (!validation.success) return jsonError(500, "DETAIL_FAILED", "The station-area detail response failed strict validation.");
  return Response.json(detail, { status: 200 });
}

function unavailableDetailParticipant(
  participant: ScheduledMeetingRequest["participants"][number],
  color: "red" | "blue",
  unavailableReason: StationAreaDetailParticipantDto["unavailableReason"],
): StationAreaDetailParticipantDto {
  if (unavailableReason === null) throw new Error("An unavailable detail participant requires a reason.");
  return {
    id: participant.id,
    color,
    origin: participant.origin,
    status: "unavailable",
    unavailableReason,
    terminal: { boardingStopId: null, totalSeconds: null, arrivalAt: null },
    segments: [],
  };
}

function detailParticipant(
  color: "red" | "blue",
  participant: ScheduledMeetingRequest["participants"][number],
  marker: ScheduledMeetingStationAreaDto,
  basis: ScheduledCalculationBasis,
  artifact: NonNullable<MeetingProviders["scheduledArtifact"]>,
  window: ReturnType<typeof createScheduledRoutingWindow>,
  deadline: ScheduledCalculationDeadline,
): StationAreaDetailParticipantDto {
  deadline.check();
  const selectedBoardingStopId = getMarkerBoardingStopId(marker, color);
  const selectedTotal = getMarkerArrivalSeconds(marker, color);
  const expectedAvailable = selectedBoardingStopId !== null && selectedTotal !== null;
  if (!expectedAvailable) {
    return {
      id: participant.id,
      color,
      origin: participant.origin,
      status: "unavailable",
      unavailableReason: basis.status === "no-result" ? basis.reason : marker.classification === "unclassified" ? "station-area-unclassified" : "station-area-unavailable-for-participant",
      terminal: { boardingStopId: null, totalSeconds: null, arrivalAt: null },
      segments: [],
    };
  }
  const route = routeScheduledSelectedBoardingStop(artifact, basis.canonicalAccessSeeds[color === "red" ? 0 : 1], selectedBoardingStopId, basis.canonicalRequest.searchStartAt, {
    walkingVelocityMetersPerSecond: basis.routingOptions.walkingVelocityMetersPerSecond,
    transferRadiusMeters: basis.routingOptions.transferRadiusMeters,
    deadlineCheck: deadline.check,
    origin: { latitude: participant.origin.latitude, longitude: participant.origin.longitude },
  }, window, basis.accessSeedCandidates[color === "red" ? 0 : 1]);
  if (route === null || route.totalSeconds !== selectedTotal || route.boardingStopId !== selectedBoardingStopId) throw new Error("Selected station-area route did not reconcile its cached marker.");
  return {
    id: participant.id,
    color,
    origin: participant.origin,
    status: "available",
    unavailableReason: null,
    terminal: { boardingStopId: route.boardingStopId, totalSeconds: route.totalSeconds, arrivalAt: route.arrivalAt },
    segments: route.segments,
  };
}

function sameScheduledRequest(left: ScheduledMeetingRequest, right: ScheduledMeetingRequest): boolean {
  return left.contractVersion === right.contractVersion && left.searchStartAt === right.searchStartAt && left.tolerancePercent === right.tolerancePercent && left.participants.length === right.participants.length && left.participants.every((participant, index) => {
    const other = right.participants[index];
    return other !== undefined && participant.id === other.id && participant.mode === other.mode && participant.origin.label === other.origin.label && participant.origin.latitude === other.origin.latitude && participant.origin.longitude === other.origin.longitude;
  });
}

function withDeadlineCheckedAccess(
  providers: MeetingProviders,
  deadline: ScheduledCalculationDeadline,
): MeetingProviders {
  const access = providers.scheduledAccess;
  if (access === undefined) return providers;
  return {
    ...providers,
    scheduledAccess: {
      descriptor: access.descriptor,
      async resolveAccessSeeds(input) {
        deadline.check();
        const seeds = await access.resolveAccessSeeds({ ...input, signal: deadline.signal });
        deadline.check();
        return seeds;
      },
    },
  };
}

function isTooLargeContentLength(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) > MAX_MEETING_REQUEST_BODY_BYTES;
}

function jsonError(
  status: number,
  code: MeetingApiErrorCode,
  message: string,
  issues?: readonly ScheduledValidationIssue[],
): Response {
  const response: MeetingApiErrorResponse = {
    error: { code, message, ...(issues ? { issues } : {}) },
  };
  return Response.json(response, { status });
}

function scheduledErrorResponse(error: unknown): Response {
  if (error instanceof RangeError) {
    return jsonError(400, "INVALID_REQUEST", error.message);
  }
  if (error instanceof ProviderUnavailableError) {
    return jsonError(503, "PROVIDER_UNAVAILABLE", "A required scheduled meeting-data provider is currently unavailable.");
  }
  if (error instanceof ScheduleArtifactUnavailableError) {
    return jsonError(503, "PROVIDER_UNAVAILABLE", "The configured scheduled timetable artifact is unavailable.");
  }
  if (error instanceof ProviderNotConfiguredError) {
    return jsonError(503, "PROVIDER_NOT_CONFIGURED", "The compiled schedule and MVG access provider are not configured for this deployment.");
  }
  return jsonError(500, "CALCULATION_FAILED", "The scheduled meeting calculation could not be completed.");
}

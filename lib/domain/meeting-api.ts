import { CALCULATION_PROGRESS_CONTRACT_VERSION } from "./calculation-progress-contract.ts";
import { ProviderNotConfiguredError, ProviderUnavailableError, type MeetingProviders } from "./providers.ts";
import type { ScheduledValidationIssue } from "../validation/meeting-v3.ts";
import {
  calculateScheduledMeetingWithBasis,
  deepFreeze,
  type ScheduledCalculationBasis,
  type ScheduledMeetingCalculationHooks,
} from "./scheduled-routing/meeting.ts";
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
  SCHEDULED_DETAIL_SELECTION_POLICY,
} from "./scheduled-routing/router.ts";
import { CHANGE_TIME_PRESETS, type ScheduledRoutingArtifact } from "./scheduled-routing/models.ts";
import { buildItinerary } from "./scheduled-routing/itinerary.ts";
import type {
  ScheduledMeetingRequest,
  ScheduledMeetingResponse,
  ScheduledMeetingStationAreaDto,
} from "../validation/meeting-v3.ts";
import {
  STATION_AREA_DETAILS_CONTRACT_VERSION,
  type StationAreaDetailParticipantDto,
  type StationAreaDetailsBasisDto,
  type StationAreaDetailsResponseDto,
} from "./station-area-details-contract.ts";
import { validateStationAreaDetailsResponse } from "../validation/station-area-details-v1.ts";
import { logError, logInfo } from "../log.ts";

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
  | "PROVIDER_CONFIGURATION_INVALID"
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

export interface ScheduledCalculationAdmissionLike {
  tryAcquire(): (() => void) | null;
}

export interface HandleMeetingPostOptions {
  readonly admission?: ScheduledCalculationAdmissionLike;
  readonly deadline?: ScheduledDeadlineOptions;
  /** Flat aliases keep the server test seam convenient without changing policy. */
  readonly deadlineMs?: number;
  readonly now?: () => number;
  readonly deadlineSignal?: AbortSignal;
  readonly basisCache?: StationAreaCalculationBasisCache;
}

export interface HandleMeetingStreamPostOptions extends HandleMeetingPostOptions {
  readonly heartbeatMs?: number;
}

export interface ScheduledCalculationErrorOutcome {
  readonly status: number;
  readonly code: MeetingApiErrorCode;
  readonly message: string;
  readonly issues?: readonly ScheduledValidationIssue[];
}

export type AcquiredScheduledMeetingCalculation = {
  readonly kind: "acquired";
  readonly parsed: ScheduledMeetingRequest;
  readonly release: () => void;
  readonly deadline: ScheduledCalculationDeadline;
  readonly basisCache: StationAreaCalculationBasisCache;
};

export type AcquireScheduledMeetingCalculationResult =
  | AcquiredScheduledMeetingCalculation
  | ({ readonly kind: "error" } & ScheduledCalculationErrorOutcome);

export type RunScheduledMeetingCalculationResult =
  | { readonly kind: "result"; readonly result: ScheduledMeetingResponse; readonly calculationRef: string | null }
  | ({ readonly kind: "error" } & ScheduledCalculationErrorOutcome);

const MEETING_STREAM_DEFAULT_HEARTBEAT_MS = 15_000;

export async function handleMeetingPost(
  request: Request,
  providersSource: MeetingProvidersSource,
  options: HandleMeetingPostOptions = {},
): Promise<Response> {
  const acquired = await acquireScheduledMeetingCalculation(request, options);
  if (acquired.kind === "error") {
    return jsonError(acquired.status, acquired.code, acquired.message, acquired.issues);
  }
  const run = await runScheduledMeetingCalculation(acquired, providersSource, {});
  if (run.kind === "error") {
    return jsonError(run.status, run.code, run.message, run.issues);
  }
  return Response.json(run.result, {
    status: 200,
    headers: run.calculationRef === null ? {} : { [STATION_AREA_CALCULATION_REF_HEADER]: run.calculationRef },
  });
}

export async function acquireScheduledMeetingCalculation(
  request: Request,
  options: HandleMeetingPostOptions = {},
): Promise<AcquireScheduledMeetingCalculationResult> {
  const startedAt = Date.now();
  const parsedScheduled = await parseMeetingRequestBody(request);
  if (parsedScheduled.kind === "error") return parsedScheduled;
  const release = (options.admission ?? scheduledCalculationAdmission).tryAcquire();
  if (release === null) {
    logError(`calculation: rejected (concurrency limit reached, elapsed=${Date.now() - startedAt}ms)`);
    return { kind: "error", ...errorOutcome(503, "TEMPORARILY_UNAVAILABLE", "A scheduled meeting calculation is already in progress. Please try again shortly.") };
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
    if (request.signal.aborted) {
      deadline.dispose();
      release();
      return { kind: "error", ...errorOutcome(503, "TEMPORARILY_UNAVAILABLE", "The scheduled meeting calculation was cancelled before it could start.") };
    }
  } catch (error) {
    deadline?.dispose();
    release();
    if (error instanceof ProviderConfigurationError) throw error;
    if (deadline?.isExpired()) {
      logError(`calculation: rejected (TEMPORARILY_UNAVAILABLE, elapsed=${Date.now() - startedAt}ms)`);
      return { kind: "error", ...errorOutcome(503, "TEMPORARILY_UNAVAILABLE", "The scheduled meeting calculation exceeded its 90-second deadline. Please try again shortly.") };
    }
    const outcome = scheduledErrorOutcome(error);
    logError(`calculation: rejected (${outcome.code}, elapsed=${Date.now() - startedAt}ms)`);
    return { kind: "error", ...outcome };
  }
  return {
    kind: "acquired",
    parsed: parsedScheduled.parsed,
    release,
    deadline,
    basisCache: options.basisCache ?? stationAreaCalculationBasisCache,
  };
}

export async function runScheduledMeetingCalculation(
  acquired: AcquiredScheduledMeetingCalculation,
  providersSource: MeetingProvidersSource,
  hooks: ScheduledMeetingCalculationHooks,
): Promise<RunScheduledMeetingCalculationResult> {
  const { parsed, release, deadline, basisCache } = acquired;
  const startedAt = Date.now();
  try {
    deadline.check();
    logInfo("calculation: started");
    const providers = typeof providersSource === "function" ? providersSource() : providersSource;
    deadline.check();
    const calculationProviders = withDeadlineCheckedAccess(providers, deadline);
    const loggingHooks: ScheduledMeetingCalculationHooks = {
      ...hooks,
      async onPhase(phase) {
        logInfo(`calculation: phase ${phase} (${Date.now() - startedAt}ms)`);
        await hooks.onPhase?.(phase);
      },
    };
    const calculation = await calculateScheduledMeetingWithBasis(parsed, {
      artifact: calculationProviders.scheduledArtifact,
      access: calculationProviders.scheduledAccess,
      deadlineCheck: deadline.check,
    }, deadline.signal, loggingHooks);
    const result = calculation.response;
    deadline.check();
    const stationAreaCatalog = calculation.stationAreaCatalog;
    logInfo(`calculation: phase validating-result (${Date.now() - startedAt}ms)`);
    await hooks.onPhase?.("validating-result");
    if (!validateScheduledMeetingResponse(result, parsed, { stationAreaCatalog, deadlineCheck: deadline.check }).success) {
      return { kind: "error", ...errorOutcome(500, "CALCULATION_FAILED", "The scheduled meeting response failed validation.") };
    }
    deadline.check();
    let calculationReference: string | null;
    try {
      calculationReference = basisCache.put(calculation.basis);
    } catch (error) {
      if (isStationAreaCalculationBasisCacheLimitError(error)) {
        calculationReference = null;
      } else {
        throw error;
      }
    }
    deadline.check();
    logInfo(`calculation: complete (status=${result.status}, reason=${result.reason}, stationAreas=${result.stationAreas.length}, elapsed=${Date.now() - startedAt}ms)`);
    return { kind: "result", result, calculationRef: calculationReference };
  } catch (error) {
    if (error instanceof ProviderConfigurationError) throw error;
    if (deadline.isExpired()) {
      logError(`calculation: failed (code=TEMPORARILY_UNAVAILABLE, elapsed=${Date.now() - startedAt}ms)`);
      return { kind: "error", ...errorOutcome(503, "TEMPORARILY_UNAVAILABLE", "The scheduled meeting calculation exceeded its 90-second deadline. Please try again shortly.") };
    }
    const outcome = scheduledErrorOutcome(error);
    logError(`calculation: failed (code=${outcome.code}, elapsed=${Date.now() - startedAt}ms)`);
    return { kind: "error", ...outcome };
  } finally {
    deadline.dispose();
    release();
  }
}

export async function handleMeetingStreamPost(
  request: Request,
  providersSource: MeetingProvidersSource,
  options: HandleMeetingStreamPostOptions = {},
): Promise<Response> {
  const acquired = await acquireScheduledMeetingCalculation(request, options);
  if (acquired.kind === "error") {
    return jsonError(acquired.status, acquired.code, acquired.message, acquired.issues);
  }
  let providers: MeetingProviders | undefined;
  let providerFactoryFailure: { readonly error: unknown } | null = null;
  try {
    acquired.deadline.check();
    try {
      providers = typeof providersSource === "function" ? providersSource() : providersSource;
    } catch (error) {
      if (error instanceof ProviderConfigurationError) throw error;
      // Generic factory failures retain the established stream contract: the
      // response starts as SSE and reports one safe terminal failure event.
      providerFactoryFailure = { error: normalizeProviderFactoryFailure() };
    }
    acquired.deadline.check();
  } catch (error) {
    acquired.deadline.dispose();
    acquired.release();
    if (error instanceof ProviderConfigurationError) throw error;
    if (acquired.deadline.isExpired()) {
      return jsonError(503, "TEMPORARILY_UNAVAILABLE", "The scheduled meeting calculation exceeded its 90-second deadline. Please try again shortly.");
    }
    const outcome = scheduledErrorOutcome(error);
    return jsonError(outcome.status, outcome.code, outcome.message, outcome.issues);
  }
  const resolvedProviders = providers;
  logInfo("calculation: stream started");
  const heartbeatMs = options.heartbeatMs ?? MEETING_STREAM_DEFAULT_HEARTBEAT_MS;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastWriteAt = Date.now();
      const write = async (chunk: string): Promise<void> => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
          lastWriteAt = Date.now();
        } catch {
          closed = true;
        }
      };
      const close = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // The consumer already cancelled or closed the stream.
        }
      };
      const heartbeat = setInterval(() => {
        if (closed) return;
        if (Date.now() - lastWriteAt >= heartbeatMs) {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
            lastWriteAt = Date.now();
          } catch {
            closed = true;
          }
        }
      }, heartbeatMs);
      if (typeof heartbeat === "object" && heartbeat !== null && "unref" in heartbeat && typeof heartbeat.unref === "function") {
        heartbeat.unref();
      }
      const hooks: ScheduledMeetingCalculationHooks = {
        async onPhase(phase) {
          await write(`event: progress\ndata: ${JSON.stringify({ contractVersion: CALCULATION_PROGRESS_CONTRACT_VERSION, phase })}\n\n`);
        },
        async onStationVerdict(verdict) {
          await write(`event: station-verdict\ndata: ${JSON.stringify({
            contractVersion: CALCULATION_PROGRESS_CONTRACT_VERSION,
            stationAreaId: verdict.stationAreaId,
            name: verdict.name,
            coordinate: verdict.coordinate,
            verdict: verdict.verdict,
          })}\n\n`);
        },
      };
      void (async () => {
        try {
          const run = providerFactoryFailure === null
            ? resolvedProviders === undefined
              ? await runScheduledMeetingCalculation(acquired, () => {
                throw new Error("The scheduled meeting provider factory returned no providers.");
              }, hooks)
              : await runScheduledMeetingCalculation(acquired, resolvedProviders, hooks)
            : await runScheduledMeetingCalculation(acquired, () => {
              throw providerFactoryFailure.error;
            }, hooks);
          if (run.kind === "error") {
            await write(`event: error\ndata: ${JSON.stringify({ code: run.code, message: run.message })}\n\n`);
          } else {
            if (run.calculationRef !== null) {
              await write(`event: ref\ndata: ${JSON.stringify({ calculationRef: run.calculationRef })}\n\n`);
            }
            await write(`event: result\ndata: ${JSON.stringify(run.result)}\n\n`);
          }
        } catch (error) {
          const configurationFailure = error instanceof ProviderConfigurationError;
          await write(`event: error\ndata: ${JSON.stringify({
            code: configurationFailure ? "PROVIDER_CONFIGURATION_INVALID" : "CALCULATION_FAILED",
            message: configurationFailure ? "Server provider configuration is invalid." : "The scheduled meeting calculation could not be completed.",
          })}\n\n`);
        } finally {
          clearInterval(heartbeat);
          close();
          logInfo("calculation: stream finished");
        }
      })();
    },
    cancel() {
      logInfo("calculation: stream cancelled (client disconnected)");
      // The client disconnected. Writes fail and stop; the request.signal abort
      // propagates through the deadline composite signal and aborts downstream
      // work, and the run's finally disposes the deadline and releases admission
      // exactly once. A disconnected stream never produces a meeting result.
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function handleStationAreaDetailsPost(
  request: Request,
  stationAreaId: string,
  providersSource: MeetingProvidersSource,
  options: HandleMeetingPostOptions = {},
): Promise<Response> {
  const startedAt = Date.now();
  logInfo(`details: request (stationAreaId=${stationAreaId})`);
  let response: Response | undefined;
  try {
    response = await handleStationAreaDetailsPostInner(request, stationAreaId, providersSource, options);
  } finally {
    if (response === undefined) {
      logInfo(`details: failed (elapsed=${Date.now() - startedAt}ms)`);
    } else {
      logInfo(`details: complete (status=${response.status}, elapsed=${Date.now() - startedAt}ms)`);
    }
  }
  return response;
}

async function handleStationAreaDetailsPostInner(
  request: Request,
  stationAreaId: string,
  providersSource: MeetingProvidersSource,
  options: HandleMeetingPostOptions = {},
): Promise<Response> {
  if (typeof stationAreaId !== "string" || stationAreaId.trim() === "") return jsonError(400, "INVALID_REQUEST", "stationAreaId must be non-empty.");
  const parsedScheduled = await parseMeetingRequestBody(request, { logAccepted: false });
  if (parsedScheduled.kind === "error") return jsonError(parsedScheduled.status, parsedScheduled.code, parsedScheduled.message, parsedScheduled.issues);
  const reference = request.headers.get(STATION_AREA_CALCULATION_REF_HEADER);
  if (reference === null || reference.trim() === "") return jsonError(400, "INVALID_CALCULATION_REF", `The ${STATION_AREA_CALCULATION_REF_HEADER} header is required.`);
  if (!isCalculationReferenceSyntaxValid(reference)) return jsonError(400, "INVALID_CALCULATION_REF", `The ${STATION_AREA_CALCULATION_REF_HEADER} header is malformed.`);
  const basisCache = options.basisCache ?? stationAreaCalculationBasisCache;
  const basis = basisCache.get(reference);
  if (basis === undefined) return jsonError(410, "CALCULATION_REF_EXPIRED", "The calculation reference is missing or has expired. Recalculate the meeting surface.");
  if (!sameScheduledRequest(basis.canonicalRequest, parsedScheduled.parsed)) return jsonError(409, "CALCULATION_REF_MISMATCH", "The calculation reference does not match the supplied meeet-meeting/v3 request.");
  const marker = basis.stationAreas.find((candidate) => candidate.stationAreaId === stationAreaId);
  if (marker === undefined) return jsonError(404, "STATION_AREA_NOT_FOUND", "The requested station area is not in the cached calculation surface.");
  if (basis.status === "no-result" || marker.classification === "unclassified") {
    return unavailableStationAreaDetailsResponse(parsedScheduled.parsed, basis, marker);
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
    const participants: [StationAreaDetailParticipantDto, StationAreaDetailParticipantDto] = [
      detailParticipant("red", 0, parsedScheduled.parsed.participants[0], marker, basis, artifact, parsedScheduled.parsed.searchStartAt),
      detailParticipant("blue", 1, parsedScheduled.parsed.participants[1], marker, basis, artifact, parsedScheduled.parsed.searchStartAt),
    ];
    const detailBasis = makeDetailBasis(parsedScheduled.parsed, basis);
    const detail: StationAreaDetailsResponseDto = deepFreeze({
      contractVersion: STATION_AREA_DETAILS_CONTRACT_VERSION,
      status: basis.status,
      reason: basis.reason,
      stationArea: { ...marker },
      participants,
      basis: detailBasis,
    });
    deadline.check();
    const validation = validateStationAreaDetailsResponse(detail, { request: parsedScheduled.parsed, selectedMarker: marker, artifactIdentity: basis.artifactIdentity });
    if (!validation.success) return jsonError(500, "DETAIL_FAILED", "The station-area detail response failed strict validation.");
    return Response.json(detail, { status: 200 });
  } catch (error) {
    if (error instanceof ProviderConfigurationError) throw error;
    if (deadline?.isExpired()) return jsonError(503, "TEMPORARILY_UNAVAILABLE", "The scheduled station-area detail exceeded its 90-second deadline. Please try again shortly.");
    if (error instanceof RangeError) return jsonError(400, "INVALID_REQUEST", error.message);
    if (error instanceof ProviderUnavailableError || error instanceof ScheduleArtifactUnavailableError) return scheduledErrorResponse(error);
    return jsonError(500, "DETAIL_FAILED", "The scheduled station-area detail could not be completed.");
  } finally {
    deadline?.dispose();
    release();
  }
}

function getMarkerArrivalSeconds(marker: ScheduledMeetingStationAreaDto, color: "red" | "blue"): number | null {
  return color === "red" ? marker.redArrivalSeconds : marker.blueArrivalSeconds;
}

function makeDetailBasis(
  request: ScheduledMeetingRequest,
  basis: ScheduledCalculationBasis,
): StationAreaDetailsBasisDto {
  return {
    contractVersion: "meeet-meeting/v3",
    searchStartAt: request.searchStartAt,
    selectedTolerancePercent: request.tolerancePercent,
    changeTimeSeconds: CHANGE_TIME_PRESETS[request.changeTimePreset],
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
    terminal: { totalSeconds: null, arrivalAt: null },
    itinerary: null,
  };
}

function detailParticipant(
  color: "red" | "blue",
  index: 0 | 1,
  participant: ScheduledMeetingRequest["participants"][number],
  marker: ScheduledMeetingStationAreaDto,
  basis: ScheduledCalculationBasis,
  artifact: ScheduledRoutingArtifact,
  searchStartAt: string,
): StationAreaDetailParticipantDto {
  const selectedTotal = getMarkerArrivalSeconds(marker, color);
  if (selectedTotal === null) {
    return {
      id: participant.id,
      color,
      origin: participant.origin,
      status: "unavailable",
      unavailableReason: basis.status === "no-result" ? basis.reason : marker.classification === "unclassified" ? "station-area-unclassified" : "station-area-unavailable-for-participant",
      terminal: { totalSeconds: null, arrivalAt: null },
      itinerary: null,
    };
  }
  const searchStartEpochSeconds = Date.parse(searchStartAt) / 1_000;
  const itinerary = buildItinerary(basis.itineraryGraph[index], marker.stationAreaId, artifact, searchStartEpochSeconds, participant.origin.label, selectedTotal);
  return {
    id: participant.id,
    color,
    origin: participant.origin,
    status: "available",
    unavailableReason: null,
    terminal: { totalSeconds: selectedTotal, arrivalAt: arrivalAtSecondsAfter(searchStartAt, selectedTotal) },
    itinerary,
  };
}

function arrivalAtSecondsAfter(searchStartAt: string, elapsedSeconds: number): string {
  const startEpochSeconds = Date.parse(searchStartAt) / 1_000;
  return new Date((startEpochSeconds + elapsedSeconds) * 1_000).toISOString();
}

function sameScheduledRequest(left: ScheduledMeetingRequest, right: ScheduledMeetingRequest): boolean {
  return left.contractVersion === right.contractVersion && left.searchStartAt === right.searchStartAt && left.tolerancePercent === right.tolerancePercent && left.changeTimePreset === right.changeTimePreset && left.participants.length === right.participants.length && left.participants.every((participant, index) => {
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

function isCalculationReferenceSyntaxValid(value: string): boolean {
  return value.length <= 256 && /^[A-Za-z0-9._~-]+$/.test(value);
}

function normalizeProviderFactoryFailure(): Error {
  return new Error("The scheduled meeting provider factory failed.");
}

type ParsedMeetingRequestResult =
  | { readonly kind: "parsed"; readonly parsed: ScheduledMeetingRequest }
  | ({ readonly kind: "error" } & ScheduledCalculationErrorOutcome);

async function parseMeetingRequestBody(
  request: Request,
  options: { readonly logAccepted?: boolean } = {},
): Promise<ParsedMeetingRequestResult> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && isTooLargeContentLength(declaredLength)) {
    return { kind: "error", ...errorOutcome(413, "REQUEST_TOO_LARGE", `Request body must not exceed ${MAX_MEETING_REQUEST_BODY_BYTES} bytes.`) };
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return { kind: "error", ...errorOutcome(400, "MALFORMED_JSON", "Request body could not be read as JSON.") };
  }

  if (new TextEncoder().encode(bodyText).byteLength > MAX_MEETING_REQUEST_BODY_BYTES) {
    return { kind: "error", ...errorOutcome(413, "REQUEST_TOO_LARGE", `Request body must not exceed ${MAX_MEETING_REQUEST_BODY_BYTES} bytes.`) };
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return { kind: "error", ...errorOutcome(400, "MALFORMED_JSON", "Request body must contain valid JSON.") };
  }

  const parsedScheduled = parseScheduledMeetingRequest(body);
  if (!parsedScheduled.success) {
    return { kind: "error", ...errorOutcome(400, "INVALID_REQUEST", "Request body must use the meeet-meeting/v3 scheduled contract.", parsedScheduled.issues) };
  }
  if (options.logAccepted !== false) {
    logInfo(`calculation: request accepted (contract=${parsedScheduled.data.contractVersion}, participants=${parsedScheduled.data.participants.length}, tolerance=${parsedScheduled.data.tolerancePercent}%, changeTimePreset=${parsedScheduled.data.changeTimePreset}, searchStartAt=${parsedScheduled.data.searchStartAt})`);
  }
  return { kind: "parsed", parsed: parsedScheduled.data };
}

export function providerConfigurationErrorResponse(): Response {
  return jsonError(503, "PROVIDER_CONFIGURATION_INVALID", "Server provider configuration is invalid.");
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

function errorOutcome(
  status: number,
  code: MeetingApiErrorCode,
  message: string,
  issues?: readonly ScheduledValidationIssue[],
): ScheduledCalculationErrorOutcome {
  return { status, code, message, ...(issues ? { issues } : {}) };
}

function scheduledErrorOutcome(error: unknown): ScheduledCalculationErrorOutcome {
  if (error instanceof RangeError) {
    return errorOutcome(400, "INVALID_REQUEST", error.message);
  }
  if (error instanceof ProviderUnavailableError) {
    return errorOutcome(503, "PROVIDER_UNAVAILABLE", "A required scheduled meeting-data provider is currently unavailable.");
  }
  if (error instanceof ScheduleArtifactUnavailableError) {
    return errorOutcome(503, "PROVIDER_UNAVAILABLE", "The configured scheduled timetable artifact is unavailable.");
  }
  if (error instanceof ProviderNotConfiguredError) {
    return errorOutcome(503, "PROVIDER_NOT_CONFIGURED", "The compiled schedule and MVG access provider are not configured for this deployment.");
  }
  return errorOutcome(500, "CALCULATION_FAILED", "The scheduled meeting calculation could not be completed.");
}

function scheduledErrorResponse(error: unknown): Response {
  const outcome = scheduledErrorOutcome(error);
  return jsonError(outcome.status, outcome.code, outcome.message, outcome.issues);
}

import { ProviderNotConfiguredError, ProviderUnavailableError, type MeetingProviders } from "./providers.ts";
import type { ScheduledValidationIssue } from "../validation/meeting-v3.ts";
import { calculateScheduledMeeting } from "./scheduled-routing/meeting.ts";
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
  | "CALCULATION_FAILED";

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
    const result = await calculateScheduledMeeting(parsedScheduled.data, {
      artifact: calculationProviders.scheduledArtifact,
      access: calculationProviders.scheduledAccess,
      deadlineCheck: deadline.check,
    }, deadline.signal);
    deadline.check();
    if (!validateScheduledMeetingResponse(result, parsedScheduled.data).success) {
      return jsonError(500, "CALCULATION_FAILED", "The scheduled meeting response failed validation.");
    }
    deadline.check();
    return Response.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof ProviderConfigurationError) throw error;
    if (deadline?.isExpired()) {
      return jsonError(503, "TEMPORARILY_UNAVAILABLE", "The scheduled meeting calculation exceeded its 90-second deadline. Please try again shortly.");
    }
    return scheduledErrorResponse(error);
  } finally {
    deadline?.dispose();
    release();
  }
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

import { ProviderNotConfiguredError, ProviderUnavailableError, type MeetingProviders } from "./providers.ts";
import type { ScheduledValidationIssue } from "../validation/meeting-v3.ts";
import { calculateScheduledMeeting } from "./scheduled-routing/meeting.ts";
import {
  parseScheduledMeetingRequest,
  validateScheduledMeetingResponse,
} from "../validation/meeting-v3.ts";
import { ScheduleArtifactUnavailableError } from "./scheduled-routing/artifact.ts";

export const MAX_MEETING_REQUEST_BODY_BYTES = 32 * 1024;

export type MeetingApiErrorCode =
  | "MALFORMED_JSON"
  | "INVALID_REQUEST"
  | "REQUEST_TOO_LARGE"
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

export class ScheduledCalculationAdmissionError extends Error {
  constructor(message = "A scheduled meeting calculation is already in progress.") {
    super(message);
    this.name = "ScheduledCalculationAdmissionError";
  }
}

export class ScheduledCalculationDeadlineError extends Error {
  constructor(message = "The scheduled meeting calculation exceeded its deadline.") {
    super(message);
    this.name = "ScheduledCalculationDeadlineError";
  }
}

export class ScheduledCalculationAdmission {
  private active = 0;
  constructor(private readonly limit: number) {}
  enter(): () => void {
    if (this.active >= this.limit) throw new ScheduledCalculationAdmissionError();
    this.active += 1;
    let released = false;
    return () => { if (!released) { released = true; this.active -= 1; } };
  }
}

export const DEFAULT_SCHEDULED_CALCULATION_CONCURRENCY = 1;
export const DEFAULT_SCHEDULED_CALCULATION_DEADLINE_MS = 90_000;
export const scheduledCalculationAdmission = new ScheduledCalculationAdmission(DEFAULT_SCHEDULED_CALCULATION_CONCURRENCY);

export async function handleMeetingPost(
  request: Request,
  providers: MeetingProviders,
  options: { readonly deadlineMs?: number; readonly admission?: ScheduledCalculationAdmission } = {},
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
  const deadlineMs = options.deadlineMs ?? DEFAULT_SCHEDULED_CALCULATION_DEADLINE_MS;
  const deadline = Date.now() + deadlineMs;
  const checkDeadline = () => { if (Date.now() > deadline) throw new ScheduledCalculationDeadlineError(); };
  let release: (() => void) | undefined;
  try {
    release = (options.admission ?? scheduledCalculationAdmission).enter();
    checkDeadline();
    const result = await calculateScheduledMeeting(parsedScheduled.data, {
      artifact: providers.scheduledArtifact,
      access: providers.scheduledAccess,
      deadlineAtEpochMilliseconds: deadline,
    }, request.signal);
    checkDeadline();
    if (!validateScheduledMeetingResponse(result, parsedScheduled.data).success) {
      return jsonError(500, "CALCULATION_FAILED", "The scheduled meeting response failed validation.");
    }
    return Response.json(result, { status: 200 });
  } catch (error) {
    return scheduledErrorResponse(error);
  } finally {
    release?.();
  }
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
  if (error instanceof ScheduledCalculationAdmissionError || error instanceof ScheduledCalculationDeadlineError) {
    return jsonError(503, "PROVIDER_UNAVAILABLE", error.message);
  }
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

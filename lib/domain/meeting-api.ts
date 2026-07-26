import {
  calculateMeeting,
  ProviderNotConfiguredError,
  ProviderUnavailableError,
  ResolvedLocationOutsideMunichError,
} from "./meeting.ts";
import type { MeetingProviders } from "./providers.ts";
import {
  parseMeetingCalculationInput,
  type ValidationIssue,
} from "../validation/meeting.ts";
import { assertMeetingCalculationResponse } from "./response.ts";

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
    issues?: readonly ValidationIssue[];
  };
}

export async function handleMeetingPost(
  request: Request,
  providers: MeetingProviders,
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

  const parsed = parseMeetingCalculationInput(body, new Date());
  if (!parsed.success) {
    return jsonError(
      400,
      "INVALID_REQUEST",
      "Request body failed validation.",
      parsed.issues,
    );
  }

  try {
    const result = await calculateMeeting(parsed.data, providers);
    return Response.json(assertMeetingCalculationResponse(result), { status: 200 });
  } catch (error) {
    if (error instanceof ResolvedLocationOutsideMunichError) {
      return jsonError(
        400,
        "INVALID_REQUEST",
        "A resolved participant location is outside the official Munich application boundary.",
        [
          {
            path: ["participants"],
            code: "resolved_location_outside_official_munich_boundary",
            message:
              "The resolved location must remain inside the official Munich district boundary.",
          },
        ],
      );
    }
    if (error instanceof ProviderUnavailableError) {
      return jsonError(
        503,
        "PROVIDER_UNAVAILABLE",
        "A required meeting-data provider is currently unavailable.",
      );
    }
    if (error instanceof ProviderNotConfiguredError) {
      return jsonError(
        503,
        "PROVIDER_NOT_CONFIGURED",
        "A required meeting-data provider is not configured for this deployment.",
      );
    }
    return jsonError(
      500,
      "CALCULATION_FAILED",
      "The meeting calculation could not be completed.",
    );
  }
}

function isTooLargeContentLength(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) > MAX_MEETING_REQUEST_BODY_BYTES;
}

function jsonError(
  status: number,
  code: MeetingApiErrorCode,
  message: string,
  issues?: readonly ValidationIssue[],
): Response {
  const response: MeetingApiErrorResponse = {
    error: { code, message, ...(issues ? { issues } : {}) },
  };
  return Response.json(response, { status });
}

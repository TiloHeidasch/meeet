import "server-only";

import { randomBytes } from "node:crypto";
import { getDefaultRouteFirstJobStore, getDefaultRouteFirstMeetingService, getDefaultRouteFirstTrustedDataProvider } from "./defaults.ts";
import { RouteFirstJobStore } from "./job-cache.ts";
import { parseRouteFirstClientSubmission, MAX_ROUTE_FIRST_CLIENT_SUBMISSION_BYTES, type RouteFirstClientSubmission } from "./request-contract.ts";
import { routeFirstRequestWithinWorkBudget, unavailableRouteFirstMeetingResult, type RouteFirstMeetingService } from "./meeting-service.ts";
import { sameSnapshot } from "./models.ts";
import { routeFirstClientSubmissionFingerprint } from "./fingerprint.ts";
import type { RouteFirstTrustedDataProvider } from "./trusted-assembly.ts";

export const ROUTE_FIRST_SESSION_COOKIE = "meeet_route_first_session";

export interface RouteFirstApiDependencies {
  readonly store: RouteFirstJobStore;
  readonly service: RouteFirstMeetingService;
  readonly trustedData: RouteFirstTrustedDataProvider;
}

function defaultDependencies(): RouteFirstApiDependencies {
  return { store: getDefaultRouteFirstJobStore(), service: getDefaultRouteFirstMeetingService(), trustedData: getDefaultRouteFirstTrustedDataProvider() };
}

function parseCookies(value: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of value?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

function validSessionId(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

function sessionFromRequest(request: Request): string | null {
  const value = parseCookies(request.headers.get("cookie")).get(ROUTE_FIRST_SESSION_COOKIE);
  return validSessionId(value) ? value : null;
}

function newSessionId(): string { return randomBytes(32).toString("base64url"); }

function cookieHeader(sessionId: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ROUTE_FIRST_SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function withHeaders(response: Response, sessionId?: string): Response {
  response.headers.set("Cache-Control", "no-store");
  if (sessionId) response.headers.set("Set-Cookie", cookieHeader(sessionId));
  return response;
}

function jsonError(status: number, code: string, message: string): Response {
  return withHeaders(Response.json({ error: { code, message } }, { status }));
}

async function readBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_ROUTE_FIRST_CLIENT_SUBMISSION_BYTES) throw new Error("too-large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_ROUTE_FIRST_CLIENT_SUBMISSION_BYTES) throw new Error("too-large");
  try { return JSON.parse(text) as unknown; } catch { throw new Error("malformed-json"); }
}

function unavailableResult(submission: RouteFirstClientSubmission, requestId: string, snapshot: RouteFirstTrustedDataProvider["snapshot"]): ReturnType<typeof unavailableRouteFirstMeetingResult> {
  return unavailableRouteFirstMeetingResult({ requestId, clientSubmission: submission, snapshot, routingSnapshots: [{ source: "MVG", snapshot }] });
}

export async function handleRouteFirstMeetingSubmit(request: Request, dependencies: RouteFirstApiDependencies = defaultDependencies()): Promise<Response> {
  let body: unknown;
  try { body = await readBody(request); } catch (error) {
    return jsonError(error instanceof Error && error.message === "too-large" ? 413 : 400, error instanceof Error && error.message === "too-large" ? "REQUEST_TOO_LARGE" : "MALFORMED_JSON", error instanceof Error && error.message === "too-large" ? "Route-first request body is too large." : "Route-first request body must be valid JSON.");
  }
  let submission: RouteFirstClientSubmission;
  try { submission = parseRouteFirstClientSubmission(body); } catch {
    return jsonError(400, "INVALID_ROUTE_FIRST_REQUEST", "Route-first request body failed validation.");
  }
  const sessionId = sessionFromRequest(request) ?? newSessionId();
  try {
    const envelope = dependencies.store.submit(sessionId, submission, dependencies.trustedData.snapshot, dependencies.trustedData.cacheScope, async (context, assembledSubmission) => {
      if (context.signal.aborted || Date.now() >= context.deadlineAt) return unavailableResult(assembledSubmission, context.requestId, dependencies.trustedData.snapshot);
      let assembled;
      try {
        assembled = await dependencies.trustedData.assemble(assembledSubmission, { ...context, sessionId });
      } catch {
        return unavailableResult(assembledSubmission, context.requestId, dependencies.trustedData.snapshot);
      }
      if (assembled.status === "unavailable") return unavailableResult(assembledSubmission, context.requestId, dependencies.trustedData.snapshot);
      const trustedRequest = assembled.request;
      if (assembled.cacheScope !== dependencies.trustedData.cacheScope || trustedRequest.requestId !== context.requestId ||
        trustedRequest.departureAt !== assembledSubmission.departureAt ||
        !sameSnapshot(trustedRequest.snapshot, dependencies.trustedData.snapshot) ||
        routeFirstClientSubmissionFingerprint(trustedRequest.clientSubmission) !== routeFirstClientSubmissionFingerprint(assembledSubmission) ||
        !routeFirstRequestWithinWorkBudget(trustedRequest, context.workBudget) || context.signal.aborted || Date.now() >= context.deadlineAt) {
        return unavailableResult(assembledSubmission, context.requestId, dependencies.trustedData.snapshot);
      }
      return dependencies.service.evaluate(trustedRequest);
    });
    return withHeaders(Response.json(dependencies.store.toClientEnvelope(envelope), { status: 202 }), sessionFromRequest(request) ? undefined : sessionId);
  } catch {
    return jsonError(500, "ROUTE_FIRST_SUBMIT_FAILED", "Route-first job submission failed.");
  }
}

export async function handleRouteFirstMeetingStatus(request: Request, jobId: string, dependencies: RouteFirstApiDependencies = defaultDependencies()): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(jobId)) return jsonError(400, "INVALID_JOB_ID", "Route-first job id is invalid.");
  const sessionId = sessionFromRequest(request);
  if (!sessionId) return jsonError(401, "SESSION_REQUIRED", "A route-first session is required.");
  try {
    const envelope = dependencies.store.get(sessionId, jobId);
    if (!envelope) return jsonError(404, "JOB_NOT_FOUND", "Route-first job was not found.");
    return withHeaders(Response.json(dependencies.store.toClientEnvelope(envelope), { status: 200 }));
  } catch {
    return jsonError(500, "ROUTE_FIRST_STATUS_FAILED", "Route-first job status could not be read.");
  }
}

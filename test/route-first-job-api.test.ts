import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRouteFirstClientJobEnvelope,
  canonicalEnumerationPolicyKey,
  canonicalRouteSnapshotKey,
  enumerateLooplessRoutes,
  projectedCoordinateMm,
  Rational,
  unavailableRouteFirstMeetingResult,
  type RouteFirstClientSubmission,
  type RouteEnumerationInput,
  type RouteFirstMeetingService,
  type RouteFirstMeetingServiceResult,
  type RouteFirstMeetingRequest,
  type RouteSnapshotIdentity,
} from "../lib/domain/route-first/index.ts";
import { handleRouteFirstMeetingStatus, handleRouteFirstMeetingSubmit, type RouteFirstApiDependencies } from "../lib/domain/route-first/api.ts";
import { RouteFirstJobStore } from "../lib/domain/route-first/job-cache.ts";
import { routeFirstClientSubmissionFingerprint } from "../lib/domain/route-first/fingerprint.ts";
import type { RouteFirstTrustedDataProvider } from "../lib/domain/route-first/trusted-assembly.ts";

const SNAPSHOT: RouteSnapshotIdentity = { contractVersion: "route-first-api-test/v2", manifestId: "manifest-api-test", graphDigest: "graph-api-test", inputDigest: "input-api-test" };
const SUBMISSION: RouteFirstClientSubmission = { participants: [{ participantId: "a", origin: { latitude: 48.1, longitude: 11.5 }, mode: "transit" }, { participantId: "b", origin: { latitude: 48.11, longitude: 11.51 }, mode: "bike" }], departureAt: "2026-08-03T10:00:00.000Z", tolerancePercent: "10" };

function unavailable(context: { requestId: string }, submission = SUBMISSION): RouteFirstMeetingServiceResult {
  return unavailableRouteFirstMeetingResult({ requestId: context.requestId, clientSubmission: submission, snapshot: SNAPSHOT, routingSnapshots: [{ source: "MVG", snapshot: SNAPSHOT }] });
}

function dependencies(store = new RouteFirstJobStore({ ttlMs: 1_000, maxEntries: 20 })): RouteFirstApiDependencies {
  const service: RouteFirstMeetingService = { evaluate: () => unavailable({ requestId: "never" }) };
  const trustedData: RouteFirstTrustedDataProvider = { snapshot: SNAPSHOT, cacheScope: "policy-test/v1", assemble: () => ({ status: "unavailable", reason: "provider-unavailable" }) };
  return { store, service, trustedData };
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  assert.ok(header);
  return header.split(";", 1)[0]!;
}

async function terminal(store: RouteFirstJobStore, cookie: string, jobId: string, deps = dependencies(store)): Promise<Record<string, unknown>> {
  for (let index = 0; index < 50; index += 1) {
    const response = await handleRouteFirstMeetingStatus(new Request("http://localhost", { headers: { cookie } }), jobId, deps);
    const body = await response.json() as Record<string, unknown>;
    if (["complete", "incomplete", "unavailable", "no-eligible-target", "failed", "expired"].includes(body.status as string)) return body;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("job did not finish");
}

test("work-budget-exhausted certificates remain incomplete through the store and API", async () => {
  const input = (participantId: "a" | "b", mode: "transit" | "bike"): RouteEnumerationInput => ({
    graph: {
      vertices: [{ id: "A", coordinate: projectedCoordinateMm(0, 0) }, { id: "T", coordinate: projectedCoordinateMm(1, 0) }],
      edges: [{ id: `${participantId}-edge`, fromVertexId: "A", toVertexId: "T", mode, duration: Rational.one(), distanceMm: Rational.one() }],
    },
    originVertexIds: ["A"],
    targetVertexIds: ["T"],
    policy: { policyId: `budget-${participantId}`, snapshot: SNAPSHOT, maxHops: 1, allowedModes: [mode], workBudget: BigInt(1) },
  });
  const inputs = { a: input("a", "transit"), b: input("b", "bike") };
  const exhausted = enumerateLooplessRoutes(inputs.a);
  assert.equal(exhausted.status, "incomplete");
  if (exhausted.status !== "incomplete") return;
  assert.equal(exhausted.certificate.workUnits, exhausted.certificate.workBudget);
  const store = new RouteFirstJobStore({ ttlMs: 1_000, maxEntries: 10, maxWorkUnits: BigInt(10) });
  const trustedData: RouteFirstTrustedDataProvider = {
    snapshot: SNAPSHOT,
    cacheScope: "budget/v1",
    assemble: (submission, context) => ({
      status: "ready",
      cacheScope: "budget/v1",
      request: {
        requestId: context.requestId,
        clientSubmission: submission,
        departureAt: submission.departureAt,
        snapshot: SNAPSHOT,
        enumerationJobs: [{ participantId: "a", input: inputs.a }, { participantId: "b", input: inputs.b }],
      } as unknown as RouteFirstMeetingRequest,
    }),
  };
  const service: RouteFirstMeetingService = {
    evaluate: (request) => ({
      status: "incomplete",
      provenance: {
        contractVersion: "route-first-meeting-service/v1",
        requestId: request.requestId,
        departureContext: SUBMISSION.departureAt,
        snapshot: SNAPSHOT,
        routingSnapshots: [{ source: "MVG", snapshot: SNAPSHOT }],
        calculationCompleteness: "incomplete",
        participantIds: ["a", "b"],
        participantModes: ["transit", "bike"],
        tolerancePercent: "10",
        requestFingerprint: routeFirstClientSubmissionFingerprint(SUBMISSION),
        policyFingerprints: [
          { participantId: "a", policyFingerprint: canonicalEnumerationPolicyKey(inputs.a.policy), snapshotFingerprint: canonicalRouteSnapshotKey(SNAPSHOT) },
          { participantId: "b", policyFingerprint: canonicalEnumerationPolicyKey(inputs.b.policy), snapshotFingerprint: canonicalRouteSnapshotKey(SNAPSHOT) },
        ],
      },
      participantId: "a",
      reason: exhausted.reason,
      enumerations: [
        { participantId: "a", status: "incomplete", certificate: exhausted.certificate },
        { participantId: "b", status: "unavailable", certificate: null },
      ],
    }),
  };
  const deps: RouteFirstApiDependencies = { store, service, trustedData };
  const response = await handleRouteFirstMeetingSubmit(new Request("http://localhost", { method: "POST", body: JSON.stringify(SUBMISSION), headers: { "content-type": "application/json" } }), deps);
  assert.equal(response.status, 202);
  const cookie = cookieFrom(response);
  const queued = await response.json() as Record<string, unknown>;
  const result = await terminal(store, cookie, String(queued.jobId), deps);
  assert.equal(result.status, "incomplete");
  assert.equal((result.result as Record<string, unknown>).status, "incomplete");
  assert.doesNotThrow(() => assertRouteFirstClientJobEnvelope(result, { jobId: String(queued.jobId), snapshot: SNAPSHOT }));
});

test("API accepts only minimal client submission, assembles trusted data, isolates sessions, and reports unavailable truthfully", async () => {
  const store = new RouteFirstJobStore({ ttlMs: 1_000, maxEntries: 20 });
  const baseDeps = dependencies(store);
  let assembledSubmission: unknown;
  const deps: RouteFirstApiDependencies = { ...baseDeps, trustedData: { ...baseDeps.trustedData, assemble: (submission) => { assembledSubmission = submission; return { status: "unavailable", reason: "provider-unavailable" }; } } };
  const post = await handleRouteFirstMeetingSubmit(new Request("http://localhost/api/route-first/meetings", { method: "POST", body: JSON.stringify(SUBMISSION), headers: { "content-type": "application/json" } }), deps);
  assert.equal(post.status, 202);
  assert.equal(post.headers.get("cache-control"), "no-store");
  const setCookie = post.headers.get("set-cookie");
  assert.ok(setCookie);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  if (process.env.NODE_ENV === "production") assert.match(setCookie, /Secure/);
  const cookie = cookieFrom(post);
  const queued = await post.json() as Record<string, unknown>;
  assert.equal(queued.durable, false);
  assert.equal(queued.activation, "blocked-until-durable-provider");
  const result = await terminal(store, cookie, String(queued.jobId));
  assert.equal(result.status, "unavailable");
  assert.deepEqual(Object.keys(assembledSubmission as object).sort(), ["departureAt", "participants", "tolerancePercent"]);
  assert.doesNotThrow(() => assertRouteFirstClientJobEnvelope(result, { jobId: String(queued.jobId), snapshot: SNAPSHOT }));
  const other = await handleRouteFirstMeetingStatus(new Request("http://localhost", { headers: { cookie: `${cookie.split("=", 1)[0]}=${"A".repeat(43)}` } }), String(queued.jobId), deps);
  assert.equal(other.status, 404);
  const poisoned = await handleRouteFirstMeetingSubmit(new Request("http://localhost", { method: "POST", body: JSON.stringify({ ...SUBMISSION, graph: {} }) }), deps);
  assert.equal(poisoned.status, 400);
  assert.equal(poisoned.headers.get("cache-control"), "no-store");
  const poisonedBody = await poisoned.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(poisonedBody), ["error"]);
  assert.deepEqual(Object.keys(poisonedBody.error as object).sort(), ["code", "message"]);
  assert.ok(JSON.stringify(poisonedBody).length < 1_024);
  assert.equal(JSON.stringify(poisonedBody).includes("48.1"), false);
  const sessionBody = await handleRouteFirstMeetingSubmit(new Request("http://localhost", { method: "POST", body: JSON.stringify({ ...SUBMISSION, sessionId: "A".repeat(43) }) }), deps);
  assert.equal(sessionBody.status, 400);
});

test("HTTP terminal cache failures remain sanitized and coordinate-free", async () => {
  const store = new RouteFirstJobStore({ ttlMs: 1_000, maxEntries: 10 });
  const trustedData: RouteFirstTrustedDataProvider = {
    snapshot: SNAPSHOT,
    cacheScope: "sanitized/v1",
    assemble: (submission, context) => ({
      status: "ready",
      cacheScope: "sanitized/v1",
      request: {
        requestId: context.requestId,
        clientSubmission: submission,
        departureAt: submission.departureAt,
        snapshot: SNAPSHOT,
        enumerationJobs: [{ participantId: "a", input: { policy: { workBudget: BigInt(1) } } }],
      } as unknown as RouteFirstMeetingRequest,
    }),
  };
  const service: RouteFirstMeetingService = { evaluate: () => unavailable({ requestId: "wrong-request" }) };
  const deps: RouteFirstApiDependencies = { store, service, trustedData };
  const post = await handleRouteFirstMeetingSubmit(new Request("http://localhost", { method: "POST", body: JSON.stringify(SUBMISSION) }), deps);
  assert.equal(post.status, 202);
  const cookie = cookieFrom(post);
  const queued = await post.json() as Record<string, unknown>;
  const body = await terminal(store, cookie, String(queued.jobId), deps);
  assert.equal(body.status, "failed");
  assert.equal(body.result && typeof body.result === "object" ? (body.result as Record<string, unknown>).message : undefined, "The route-first service failed.");
  assert.equal(JSON.stringify(body).includes("48.1"), false);
  assert.equal(JSON.stringify(body).includes("48.11"), false);
});

test("job cache uses store-owned abort/deadline, shared fills ignore caller abort, and expiry cancels hung work", async () => {
  let fills = 0;
  let observedSignal: AbortSignal | undefined;
  const store = new RouteFirstJobStore({ ttlMs: 40, maxFillDurationMs: 15, maxEntries: 5, maxConcurrentFills: 1 });
  const session = "S".repeat(43);
  const caller = new AbortController();
  const first = store.submit(session, SUBMISSION, SNAPSHOT, "policy/v1", async (context) => {
    fills += 1;
    observedSignal = context.signal;
    caller.abort();
    await new Promise<RouteFirstMeetingServiceResult>(() => undefined);
    return unavailable(context);
  });
  const duplicate = store.submit(session, SUBMISSION, SNAPSHOT, "policy/v1", () => unavailable({ requestId: "unused" }));
  assert.equal(first.jobId, duplicate.jobId);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(fills, 1);
  assert.equal(caller.signal.aborted, true);
  assert.equal(observedSignal?.aborted, true);
  assert.equal(store.get(session, first.jobId)?.status, "expired");
});

test("max-concurrency-one releases a hung fill and starts the next job with its own fill closure", async () => {
  const store = new RouteFirstJobStore({ ttlMs: 500, maxFillDurationMs: 20, maxEntries: 10, maxConcurrentFills: 1 });
  const session = "Q".repeat(43);
  const secondSubmission = { ...SUBMISSION, tolerancePercent: "15" };
  const started: string[] = [];
  let firstSignal: AbortSignal | undefined;
  const first = store.submit(session, SUBMISSION, SNAPSHOT, "scope/v1", async (context) => {
    started.push("first");
    firstSignal = context.signal;
    await new Promise<RouteFirstMeetingServiceResult>(() => undefined);
    return unavailable(context, SUBMISSION);
  });
  const second = store.submit(session, secondSubmission, SNAPSHOT, "scope/v1", (context, submission) => {
    started.push("second");
    return unavailable(context, submission);
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(started, ["first", "second"]);
  assert.equal(firstSignal?.aborted, true);
  const tombstone = store.get(session, first.jobId);
  assert.equal(tombstone?.status, "expired");
  assert.equal(JSON.stringify(tombstone).includes("48.1"), false);
  assert.equal(store.get(session, second.jobId)?.status, "unavailable");
});

test("cache keys bind snapshot/policy, capacity aborts fills, collisions do not reuse ids, and deep corruption is rejected", async () => {
  let now = 100;
  let firstSignal: AbortSignal | undefined;
  const ids = ["J".repeat(43), "J".repeat(43), "K".repeat(43), "L".repeat(43)];
  const store = new RouteFirstJobStore({ now: () => now, ttlMs: 1_000, maxEntries: 1, maxConcurrentFills: 1, jobIdFactory: () => ids.shift() ?? "M".repeat(43) });
  const session = "T".repeat(43);
  const pending = store.submit(session, SUBMISSION, SNAPSHOT, "policy/v1", async (context) => { firstSignal = context.signal; await new Promise<RouteFirstMeetingServiceResult>(() => undefined); return unavailable(context); });
  await new Promise((resolve) => setImmediate(resolve));
  const changed = store.submit(session, { ...SUBMISSION, tolerancePercent: "15" }, SNAPSHOT, "policy/v1", (context) => unavailable(context));
  assert.notEqual(pending.jobId, changed.jobId);
  assert.equal(firstSignal?.aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  now += 2_000;
  assert.equal(store.get(session, changed.jobId)?.status, "expired");
  const poisonStore = new RouteFirstJobStore({ ttlMs: 1_000 });
  const poison = poisonStore.submit(session, SUBMISSION, SNAPSHOT, "policy/v1", (context) => unavailable(context));
  await new Promise((resolve) => setImmediate(resolve));
  const validEnvelope = poisonStore.toClientEnvelope(poisonStore.get(session, poison.jobId)!);
  assert.throws(() => assertRouteFirstClientJobEnvelope({ ...validEnvelope, unknown: true }));
  const corruptedEnvelope = { ...validEnvelope, result: { ...validEnvelope.result!, provenance: { ...validEnvelope.result!.provenance, snapshot: { ...validEnvelope.result!.provenance.snapshot, graphDigest: "altered" } } } };
  assert.throws(() => assertRouteFirstClientJobEnvelope(corruptedEnvelope));
  poisonStore.replaceCachedPayloadForTesting(session, poison.jobId, { status: "complete", provenance: { snapshot: { graphDigest: "altered" } } });
  assert.equal(poisonStore.get(session, poison.jobId)?.status, "failed");
  const sanitized = poisonStore.toClientEnvelope(poisonStore.get(session, poison.jobId)!);
  assert.equal(sanitized.status, "failed");
  assert.equal(JSON.stringify(sanitized).includes("48.1"), false);
  assert.equal((sanitized.result as { message?: string }).message, "The route-first service failed.");
});

test("default runtime never invokes POI or external route adapters", async () => {
  const response = await handleRouteFirstMeetingSubmit(new Request("http://localhost", { method: "POST", body: JSON.stringify(SUBMISSION) }));
  assert.equal(response.status, 202);
  const cookie = cookieFrom(response);
  const queued = await response.json() as Record<string, unknown>;
  let result: Record<string, unknown> | undefined;
  for (let index = 0; index < 20; index += 1) {
    const status = await handleRouteFirstMeetingStatus(new Request("http://localhost", { headers: { cookie } }), String(queued.jobId));
    const body = await status.json() as Record<string, unknown>;
    if (body.status === "unavailable") { result = body; break; }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(result?.status, "unavailable");
});

test("trusted scope, full snapshot, canonical submission, and store budget are checked before service evaluation", async () => {
  let serviceCalls = 0;
  const store = new RouteFirstJobStore({ ttlMs: 500, maxEntries: 10, maxWorkUnits: BigInt(10) });
  const service: RouteFirstMeetingService = { evaluate: () => { serviceCalls += 1; return unavailable({ requestId: "never" }); } };
  const request = (context: { requestId: string }, snapshot: RouteSnapshotIdentity, scope: string, budget: bigint) => ({
    requestId: context.requestId,
    clientSubmission: SUBMISSION,
    departureAt: SUBMISSION.departureAt,
    departureContext: SUBMISSION.departureAt,
    tolerancePercent: SUBMISSION.tolerancePercent,
    snapshot,
    enumerationJobs: [{ participantId: "a", input: { policy: { workBudget: budget } } }],
  } as unknown as RouteFirstMeetingRequest);
  const trustedData: RouteFirstTrustedDataProvider = {
    snapshot: SNAPSHOT,
    cacheScope: "scope-a",
    assemble: (_submission, context) => ({ status: "ready", cacheScope: "scope-b", request: request(context, { ...SNAPSHOT, graphDigest: "different" }, "scope-b", BigInt(100)) }),
  };
  const response = await handleRouteFirstMeetingSubmit(new Request("http://localhost", { method: "POST", body: JSON.stringify(SUBMISSION) }), { store, service, trustedData });
  assert.equal(response.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serviceCalls, 0);
  const body = await response.json() as Record<string, unknown>;
  const cookie = cookieFrom(response);
  const status = await handleRouteFirstMeetingStatus(new Request("http://localhost", { headers: { cookie } }), String(body.jobId), { store, service, trustedData });
  assert.equal(status.status, 200);
  const statusBody = await status.json() as Record<string, unknown>;
  assert.equal(statusBody.status, "unavailable");
});

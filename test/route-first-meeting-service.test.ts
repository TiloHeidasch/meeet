import assert from "node:assert/strict";
import test from "node:test";

import {
  Rational,
  MAX_ROUTE_FIRST_AGGREGATE_WORK,
  assertRouteFirstClientJobEnvelope,
  enumerateLooplessRoutes,
  canonicalEnumeratedRoutePathKey,
  routeFirstRequiredWorkBudget,
  routeFirstRequestWithinWorkBudget,
  projectedCoordinateMm,
  runRouteFirstMeetingService,
  unavailableRouteEnumeration,
  type RouteEnumerationInput,
  type RouteEnumerationResult,
  type RouteFirstMeetingEnumerationProvider,
  type RouteFirstAlternateEvidence,
  type RouteFirstMeetingRequest,
  type RouteFirstMeetingServiceResult,
  type RouteSnapshotIdentity,
} from "../lib/domain/route-first/index.ts";
import { RouteFirstJobStore, toRouteFirstClientResult } from "../lib/domain/route-first/job-cache.ts";

const SNAPSHOT: RouteSnapshotIdentity = { contractVersion: "route-first-service-test/v2", manifestId: "manifest-service-test", graphDigest: "graph-service-test", inputDigest: "input-service-test" };
const C0 = projectedCoordinateMm(0, 0);
const CM = projectedCoordinateMm(500, 0);
const C1 = projectedCoordinateMm(1_000, 0);
const DEPARTURE = "2026-08-03T10:00:00.000Z";

const submission = {
  participants: [
    { participantId: "a", origin: { latitude: 48.1, longitude: 11.5 }, mode: "transit" as const },
    { participantId: "b", origin: { latitude: 48.11, longitude: 11.51 }, mode: "bike" as const },
  ],
  departureAt: DEPARTURE,
  tolerancePercent: "10",
};

function graphInput(participantId: "a" | "b"): RouteEnumerationInput {
  const mode = participantId === "a" ? "transit" as const : "bike" as const;
  return {
    graph: {
      vertices: [{ id: "A", coordinate: C0 }, { id: "M", coordinate: CM }, { id: "T", coordinate: C1 }],
      edges: [
        { id: `${participantId}-direct`, fromVertexId: "A", toVertexId: "T", mode, duration: Rational.from(10), distanceMm: Rational.from(1_000) },
        { id: `${participantId}-first`, fromVertexId: "A", toVertexId: "M", mode, duration: Rational.from(4), distanceMm: Rational.from(500) },
        { id: `${participantId}-last`, fromVertexId: "M", toVertexId: "T", mode, duration: Rational.from(6), distanceMm: Rational.from(500) },
      ],
    },
    originVertexIds: ["A"],
    targetVertexIds: ["T"],
    policy: { policyId: `policy-${participantId}`, snapshot: SNAPSHOT, maxHops: 2, allowedModes: [mode], workBudget: BigInt(10_000) },
  };
}

function journeyFor(participantId: "a" | "b", path: { vertexIds: readonly string[]; edgeIds: readonly string[]; duration: Rational; distanceMm: Rational; loopless: true }) {
  const mode = participantId === "a" ? "transit" as const : "bike" as const;
  const coordinates = new Map([["A", C0], ["M", CM], ["T", C1]]);
  let tau = Rational.zero();
  const occurrences: Array<{ occurrenceIndex: number; coordinate: typeof C0; tau: Rational; kind: "departure" | "arrival" | "vertex" }> = [{ occurrenceIndex: 0, coordinate: C0, tau, kind: "departure" }];
  const segments = path.edgeIds.map((edgeId, index) => {
    const from = coordinates.get(path.vertexIds[index]!)!;
    const to = coordinates.get(path.vertexIds[index + 1]!)!;
    const edgeDuration = index === 0 && path.edgeIds.length === 1 ? Rational.from(10) : index === 0 ? Rational.from(4) : Rational.from(6);
    const departureTau = tau;
    tau = tau.add(edgeDuration);
    occurrences.push({ occurrenceIndex: index + 1, coordinate: to, tau, kind: index === path.edgeIds.length - 1 ? "arrival" as const : "vertex" as const });
    return { id: `${participantId}-segment-${index}`, fromOccurrenceIndex: index, toOccurrenceIndex: index + 1, departureTau, arrivalTau: tau, distanceMm: path.edgeIds.length === 1 ? Rational.from(1_000) : Rational.from(500), mode, geometry: [from, to], timingModel: "piecewise-linear" as const };
  });
  return { id: `${participantId}-${path.edgeIds.join("-")}`, participantId, snapshot: SNAPSHOT, requestContext: { participantId, originVertexId: "A", destinationVertexId: "T", departureContext: DEPARTURE, snapshot: SNAPSHOT }, path: { vertexIds: path.vertexIds, edgeIds: path.edgeIds }, timingModel: "piecewise-linear" as const, occurrences, segments };
}

function targetProfiles(participantId: "a" | "b", edgeId: string, time: number) {
  return { participantId, participantIds: ["a", "b"], snapshot: SNAPSHOT, edgeId, timingModel: "piecewise-linear" as const, segments: [{ edgeId, startParam: Rational.zero(), endParam: Rational.one(), startTime: Rational.from(time), endTime: Rational.from(time), occurrenceIndex: 0 }] };
}

function baseRequest(): RouteFirstMeetingRequest {
  const jobs = (["a", "b"] as const).map((participantId) => ({ participantId, input: graphInput(participantId) }));
  const results = jobs.map((job) => enumerateLooplessRoutes(job.input));
  const journeys = results.flatMap((result, index) => result.status === "complete" ? result.paths.map((path) => journeyFor(jobs[index]!.participantId, path)) : []);
  const pathKeys = results.flatMap((result, index) => result.status === "complete" ? result.paths.map((path) => `${jobs[index]!.participantId}:${canonicalEnumeratedRoutePathKey(path)}`) : []).sort();
  return {
    requestId: "service-request",
    clientSubmission: submission,
    departureAt: DEPARTURE,
    departureContext: DEPARTURE,
    tolerancePercent: Rational.from(10),
    snapshot: SNAPSHOT,
    routingSnapshots: [{ source: "MVG", snapshot: SNAPSHOT }],
    participants: submission.participants.map((participant) => ({ ...participant, originVertexId: "A", destinationVertexId: "T" })),
    enumerationJobs: jobs,
    journeys,
    targetProfiles: [targetProfiles("a", "edge-a", 100), targetProfiles("b", "edge-a", 100), targetProfiles("a", "edge-b", 110), targetProfiles("b", "edge-b", 110)],
    eligibility: {
      topology: { snapshot: SNAPSHOT, vertices: [{ id: "v0", coordinate: C0, meetingEligible: true }, { id: "v1", coordinate: CM, meetingEligible: true }, { id: "v2", coordinate: C1, meetingEligible: true }], edges: [
        { id: "edge-a", fromVertexId: "v0", toVertexId: "v1", start: C0, end: CM, accessClass: "pedestrian", meetingEligible: true, legalIntervals: [{ start: Rational.zero(), end: Rational.one() }] },
        { id: "edge-b", fromVertexId: "v1", toVertexId: "v2", start: CM, end: C1, accessClass: "pedestrian", meetingEligible: true, legalIntervals: [{ start: Rational.zero(), end: Rational.one() }] },
      ] },
      accessibleIntervals: ["a", "b"].flatMap((participantId) => ["edge-a", "edge-b"].map((edgeId) => ({ snapshot: SNAPSHOT, participantId, edgeId, interval: { start: Rational.zero(), end: Rational.one() } }))),
      accessibleVertices: [],
    },
    familyContexts: pathKeys.map((pathKey, index) => ({ contextKey: `service-context-${index}`, skeletonKey: `service-skeleton-${index}`, geometryKey: `service-geometry-${index}`, participantIds: ["a", "b"], pathKeys: [pathKey], targetEdgeIds: ["edge-a", "edge-b"] })),
  };
}

function providerFor(request: RouteFirstMeetingRequest, overrides = new Map<string, RouteEnumerationResult>()): RouteFirstMeetingEnumerationProvider {
  return { enumerateRoutes(input) { return overrides.get(input.policy.policyId) ?? enumerateLooplessRoutes(input); } };
}

function expectStatus(result: RouteFirstMeetingServiceResult, status: RouteFirstMeetingServiceResult["status"]): void { assert.equal(result.status, status); }

test("complete processing covers every certified path, family, edge, geometry, and admitted provenance", () => {
  const request = baseRequest();
  const result = runRouteFirstMeetingService(request, providerFor(request));
  expectStatus(result, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.journeys.length, 4);
  assert.equal(result.corridors.length, 4);
  assert.equal(result.fairRegions.length, 2);
  assert.equal(result.fairRegionGeometry.length, 2);
  assert.equal(result.families.length, 4);
  assert.ok(result.corridors.every((corridor) => corridor.directionalGeometry.length > 1));
  assert.ok(result.corridors.every((corridor) => corridor.corridor.ambiguityEnvelope === null && corridor.envelopeGeometry.length === 0));
  assert.equal(result.admittedLandmarks.length, 0);
});

test("participant mode, policy, timing, and geometry are bound end-to-end", () => {
  const request = baseRequest();
  const policyMismatch = { ...request, enumerationJobs: request.enumerationJobs.map((job, index) => index === 0 ? { ...job, input: { ...job.input, policy: { ...job.input.policy, allowedModes: ["bike"] as const } } } : job) };
  const mismatch = runRouteFirstMeetingService(policyMismatch, providerFor(request));
  assert.notEqual(mismatch.status, "complete");
  const alteredJourney = { ...request, journeys: request.journeys.map((journey, index) => index === 0 ? { ...journey, segments: journey.segments.map((segment) => ({ ...segment, geometry: [C1, C0] })) } : journey) };
  const altered = runRouteFirstMeetingService(alteredJourney, providerFor(request));
  assert.notEqual(altered.status, "complete");
  const alteredTiming = { ...request, journeys: request.journeys.map((journey, index) => index === 0 ? { ...journey, segments: journey.segments.map((segment) => ({ ...segment, arrivalTau: Rational.from(9) })) } : journey) };
  const timing = runRouteFirstMeetingService(alteredTiming, providerFor(request));
  assert.notEqual(timing.status, "complete");
});

test("certified alternate evidence creates an alternate-only envelope and survives deep client validation", () => {
  const request = baseRequest();
  const primary = request.journeys[0]!;
  const alternateJourney = request.journeys[1]!;
  const enumeration = enumerateLooplessRoutes(request.enumerationJobs[0]!.input);
  assert.equal(enumeration.status, "complete");
  if (enumeration.status !== "complete") return;
  const alternatePath = enumeration.paths.find((path) => path.vertexIds.every((value, index) => value === alternateJourney.path.vertexIds[index]) && path.edgeIds.every((value, index) => value === alternateJourney.path.edgeIds[index]));
  const primaryPath = enumeration.paths.find((path) => path.vertexIds.every((value, index) => value === primary.path.vertexIds[index]) && path.edgeIds.every((value, index) => value === primary.path.edgeIds[index]));
  assert.ok(alternatePath);
  assert.ok(primaryPath);
  if (!alternatePath || !primaryPath) return;
  const context = { familyKey: "service-context", request: primary.requestContext, policy: request.enumerationJobs[0]!.input.policy };
  const reverseContext = { ...context, request: alternateJourney.requestContext };
  const bPrimary = request.journeys[2]!;
  const bAlternate = request.journeys[3]!;
  const bEnumeration = enumerateLooplessRoutes(request.enumerationJobs[1]!.input);
  assert.equal(bEnumeration.status, "complete");
  if (bEnumeration.status !== "complete") return;
  const bPrimaryPath = bEnumeration.paths.find((path) => path.edgeIds.join(",") === bPrimary.path.edgeIds.join(","))!;
  const bAlternatePath = bEnumeration.paths.find((path) => path.edgeIds.join(",") === bAlternate.path.edgeIds.join(","))!;
  const bContext = { familyKey: "service-context", request: bPrimary.requestContext, policy: request.enumerationJobs[1]!.input.policy };
  const bReverseContext = { ...bContext, request: bAlternate.requestContext };
  const allPathKeys = request.journeys.map((journey) => {
    const job = request.enumerationJobs.find((candidate) => candidate.participantId === journey.participantId)!;
    const participantEnumeration = enumerateLooplessRoutes(job.input);
    if (participantEnumeration.status !== "complete") throw new Error("test enumeration incomplete");
    const path = participantEnumeration.paths.find((candidate) => candidate.vertexIds.every((value, index) => value === journey.path.vertexIds[index]) && candidate.edgeIds.every((value, index) => value === journey.path.edgeIds[index]))!;
    return `${journey.participantId}:${canonicalEnumeratedRoutePathKey(path)}`;
  }).sort();
  const familyRequest = { ...request, familyContexts: [{ contextKey: "service-context", skeletonKey: "service-skeleton", geometryKey: "service-geometry", participantIds: ["a", "b"], pathKeys: allPathKeys, targetEdgeIds: ["edge-a", "edge-b"] }] };
  const alternateEvidence: RouteFirstAlternateEvidence[] = [
    { journeyId: primary.id, context, alternates: [{ complete: true, family: context, enumerationInput: request.enumerationJobs[0]!.input, enumeration, path: alternatePath, journey: alternateJourney }] },
    { journeyId: alternateJourney.id, context: reverseContext, alternates: [{ complete: true, family: reverseContext, enumerationInput: request.enumerationJobs[0]!.input, enumeration, path: primaryPath, journey: primary }] },
    { journeyId: bPrimary.id, context: bContext, alternates: [{ complete: true, family: bContext, enumerationInput: request.enumerationJobs[1]!.input, enumeration: bEnumeration, path: bAlternatePath, journey: bAlternate }] },
    { journeyId: bAlternate.id, context: bReverseContext, alternates: [{ complete: true, family: bReverseContext, enumerationInput: request.enumerationJobs[1]!.input, enumeration: bEnumeration, path: bPrimaryPath, journey: bPrimary }] },
  ];
  const alternateRequest = { ...familyRequest, alternateEvidence };
  assert.equal(routeFirstRequiredWorkBudget(alternateRequest), BigInt(80_000));
  assert.equal(routeFirstRequestWithinWorkBudget(alternateRequest, BigInt(40_000)), false);
  assert.equal(routeFirstRequestWithinWorkBudget(alternateRequest, BigInt(80_000)), true);
  const result = runRouteFirstMeetingService(alternateRequest, providerFor(request));
  const missingAlternate = runRouteFirstMeetingService(familyRequest, providerFor(request));
  expectStatus(missingAlternate, "incomplete");
  const wrongFamily = runRouteFirstMeetingService({ ...familyRequest, alternateEvidence: [{ journeyId: primary.id, context: { ...context, familyKey: "other-family" }, alternates: [{ complete: true, family: { ...context, familyKey: "other-family" }, enumerationInput: request.enumerationJobs[0]!.input, enumeration, path: alternatePath, journey: alternateJourney }] }] }, providerFor(request));
  expectStatus(wrongFamily, "incomplete");
  expectStatus(result, "complete");
  if (result.status !== "complete") return;
  assert.ok(result.corridors[0]!.corridor.ambiguityEnvelope);
  assert.deepEqual(result.corridors[0]!.alternateJourneyIds, [alternateJourney.id]);
  assert.ok(result.corridors[0]!.envelopeGeometry.length > 0);
  const clientResult = toRouteFirstClientResult(result);
  const envelope = (value: unknown) => ({ contractVersion: "route-first-job/v1", jobId: "A".repeat(43), status: "complete" as const, durable: false as const, runtimePersistence: "in-memory-process" as const, activation: "blocked-until-durable-provider" as const, expiresAt: 10, snapshot: SNAPSHOT, result: value });
  assert.doesNotThrow(() => assertRouteFirstClientJobEnvelope(envelope(clientResult)));
  const completeClient = clientResult as Extract<typeof clientResult, { status: "complete" }>;
  assert.throws(() => assertRouteFirstClientJobEnvelope(envelope({ ...completeClient, journeys: completeClient.journeys.map((journey, index) => index === 0 ? { ...journey, occurrences: [{ ...journey.occurrences[0]!, kind: "corrupt" as never }, ...journey.occurrences.slice(1)] } : journey) })));
  assert.throws(() => assertRouteFirstClientJobEnvelope(envelope({ ...completeClient, journeys: completeClient.journeys.map((journey, index) => index === 0 ? { ...journey, segments: journey.segments.map((segment, segmentIndex) => segmentIndex === 0 ? { ...segment, mode: "corrupt" as never } : segment) } : journey) })));
  assert.throws(() => assertRouteFirstClientJobEnvelope(envelope({ ...completeClient, journeys: completeClient.journeys.map((journey, index) => index === 0 ? { ...journey, segments: journey.segments.map((segment, segmentIndex) => segmentIndex === 0 ? { ...segment, distanceMm: "-1" } : segment) } : journey) })));
  assert.throws(() => assertRouteFirstClientJobEnvelope(envelope({ ...completeClient, provenance: { ...completeClient.provenance, departureContext: "different" } })));
  assert.throws(() => assertRouteFirstClientJobEnvelope(envelope({ ...completeClient, enumerations: completeClient.enumerations.map((entry, index) => index === 0 && entry.certificate ? { ...entry, certificate: { ...entry.certificate, workUnits: "0" } } : entry) })));
  assert.throws(() => assertRouteFirstClientJobEnvelope(envelope({ ...completeClient, fairRegions: completeClient.fairRegions.map((region, index) => index === 0 ? { ...region, kind: "corrupt" as never } : region) })));
  assert.throws(() => assertRouteFirstClientJobEnvelope(envelope({ ...completeClient, fairRegions: completeClient.fairRegions.map((region, index) => index === 0 ? { ...region, points: ["2"] } : region) })));
  assert.throws(() => assertRouteFirstClientJobEnvelope(envelope({ ...completeClient, components: completeClient.components.map((component, index) => index === 0 ? { ...component, edgeIntervals: component.edgeIntervals.length > 0 ? [{ ...component.edgeIntervals[0]!, interval: { start: "2", end: "2" } }] : [{ edgeId: "bad", interval: { start: "2", end: "2" } }] } : component) })));
  assert.throws(() => assertRouteFirstClientJobEnvelope(envelope({ ...completeClient, corridors: completeClient.corridors.map((corridor, index) => index === 0 ? { ...corridor, alternateJourneyIds: [completeClient.journeys.find((journey) => journey.participantId !== corridor.participantId)!.id] } : corridor) })));
});

test("missing journey, profile, topology, or family coverage is incomplete and never complete", () => {
  const request = baseRequest();
  const missingJourney = runRouteFirstMeetingService({ ...request, journeys: request.journeys.slice(0, -1) }, providerFor(request));
  expectStatus(missingJourney, "incomplete");
  const missingProfile = runRouteFirstMeetingService({ ...request, targetProfiles: request.targetProfiles.slice(0, -1) }, providerFor(request));
  expectStatus(missingProfile, "incomplete");
  const missingFamily = runRouteFirstMeetingService({ ...request, familyContexts: [] }, providerFor(request));
  expectStatus(missingFamily, "incomplete");
});

test("participant policy budgets plus certificate re-enumeration must fit one aggregate store budget", () => {
  const request = baseRequest();
  const perParticipant = MAX_ROUTE_FIRST_AGGREGATE_WORK - BigInt(1);
  const overBudget = { ...request, enumerationJobs: request.enumerationJobs.map((job) => ({ ...job, input: { ...job.input, policy: { ...job.input.policy, workBudget: perParticipant } } })) };
  const result = runRouteFirstMeetingService(overBudget, providerFor(request));
  expectStatus(result, "incomplete");
});

test("tampered certificates and unavailable providers cannot produce complete output", () => {
  const request = baseRequest();
  const valid = enumerateLooplessRoutes(request.enumerationJobs[0]!.input);
  assert.equal(valid.status, "complete");
  if (valid.status !== "complete") return;
  const tampered = Object.freeze({ ...valid, certificate: Object.freeze({ ...valid.certificate, graphFingerprint: "tampered" }) });
  const result = runRouteFirstMeetingService(request, providerFor(request, new Map([["policy-a", tampered]])));
  expectStatus(result, "failed");
  const unavailable = runRouteFirstMeetingService(request, providerFor(request, new Map([["policy-a", unavailableRouteEnumeration("not configured")]])));
  expectStatus(unavailable, "unavailable");
});

test("client rejects component-edge and landmark bindings that do not match certified topology", () => {
  const request = baseRequest();
  const result = runRouteFirstMeetingService(request, providerFor(request));
  expectStatus(result, "complete");
  if (result.status !== "complete") return;
  const clientResult = toRouteFirstClientResult(result);
  const envelope = (value: unknown) => ({ contractVersion: "route-first-job/v1", jobId: "B".repeat(43), status: "complete" as const, durable: false as const, runtimePersistence: "in-memory-process" as const, activation: "blocked-until-durable-provider" as const, expiresAt: 10, snapshot: SNAPSHOT, result: value });
  const completeClient = clientResult as Extract<typeof clientResult, { status: "complete" }>;
  type ClientComponent = (typeof completeClient.components)[number];
  const corruptComponent = (component: ClientComponent) => ({ ...component, edgeIntervals: [...component.edgeIntervals, { edgeId: "uncertified-edge", interval: { start: "0", end: "0" } }] });
  assert.throws(() => assertRouteFirstClientJobEnvelope(envelope({
    ...completeClient,
    components: completeClient.components.map(corruptComponent),
    families: completeClient.families.map((family) => ({ ...family, eligibleComponents: family.eligibleComponents.map(corruptComponent) })),
  })));
  assert.throws(() => assertRouteFirstClientJobEnvelope(envelope({
    ...completeClient,
    landmarkEvaluation: { ...completeClient.landmarkEvaluation, evaluated: false, landmarkIds: ["unevaluated-landmark"] },
  })));
  assert.throws(() => assertRouteFirstClientJobEnvelope(envelope({
    ...completeClient,
    landmarkEvaluation: { ...completeClient.landmarkEvaluation, evaluated: true, landmarkIds: ["unbound-landmark"] },
    admittedLandmarks: [{ id: "unbound-landmark", kind: "conditional-landmark", snapshot: SNAPSHOT, participantIds: ["a", "b"], vertexId: "unbound-vertex", scope: "all-participants" }],
  })));
});

test("cache sanitizes a complete result with corrupted certified topology bindings", async () => {
  const request = baseRequest();
  const store = new RouteFirstJobStore({ ttlMs: 1_000, maxEntries: 10 });
  const session = "C".repeat(43);
  const job = store.submit(session, request.clientSubmission, SNAPSHOT, "cache/v1", (context) => runRouteFirstMeetingService({ ...request, requestId: context.requestId }, providerFor(request)));
  let cached = store.get(session, job.jobId);
  for (let index = 0; index < 50 && cached?.status !== "complete"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    cached = store.get(session, job.jobId);
  }
  assert.equal(cached?.status, "complete");
  if (!cached?.result || cached.result.status !== "complete") return;
  const completeResult = cached.result;
  const corruptComponent = (component: (typeof completeResult.components)[number]) => ({ ...component, edgeIntervals: [...component.edgeIntervals, { edgeId: "uncertified-edge", interval: { start: Rational.zero(), end: Rational.zero() } }] });
  const invalid = {
    ...completeResult,
    components: completeResult.components.map(corruptComponent),
    families: completeResult.families.map((family) => ({ ...family, eligibleComponents: family.eligibleComponents.map(corruptComponent) })),
  };
  store.replaceCachedPayloadForTesting(session, job.jobId, invalid);
  const sanitized = store.get(session, job.jobId);
  assert.equal(sanitized?.status, "failed");
  assert.equal(JSON.stringify(sanitized).includes("uncertified-edge"), false);

  const secondRequest = { ...request, clientSubmission: { ...request.clientSubmission, tolerancePercent: "11" }, tolerancePercent: Rational.from(11) };
  const secondJob = store.submit(session, secondRequest.clientSubmission, SNAPSHOT, "cache/v1", (context) => runRouteFirstMeetingService({ ...secondRequest, requestId: context.requestId }, providerFor(secondRequest)));
  cached = store.get(session, secondJob.jobId);
  for (let index = 0; index < 50 && cached?.status !== "complete"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    cached = store.get(session, secondJob.jobId);
  }
  assert.equal(cached?.status, "complete");
  if (!cached?.result || cached.result.status !== "complete") return;
  const invalidLandmark = {
    ...cached.result,
    landmarkEvaluation: { ...cached.result.landmarkEvaluation, evaluated: true, landmarkIds: ["cached-landmark"] },
    admittedLandmarks: [{ id: "cached-landmark", kind: "conditional-landmark" as const, snapshot: SNAPSHOT, participantIds: ["a", "b"], vertexId: "uncertified-vertex", scope: "all-participants" as const }],
  };
  store.replaceCachedPayloadForTesting(session, secondJob.jobId, invalidLandmark);
  const sanitizedLandmark = store.get(session, secondJob.jobId);
  assert.equal(sanitizedLandmark?.status, "failed");
  assert.equal(JSON.stringify(sanitizedLandmark).includes("uncertified-vertex"), false);
});

test("inaccessible conditional landmarks are not admitted and no POI behavior exists", () => {
  const base = baseRequest();
  const request = { ...base, eligibility: { ...base.eligibility, topology: { ...base.eligibility.topology, vertices: [...base.eligibility.topology.vertices, { id: "v3", coordinate: projectedCoordinateMm(2_000, 0), meetingEligible: true }] } } };
  const inaccessible = { id: "landmark-v3", kind: "conditional-landmark" as const, evidence: { snapshot: SNAPSHOT, participantIds: ["a", "b"], vertexId: "v3", scope: "all-participants" as const } };
  const result = runRouteFirstMeetingService({ ...request, organicComponentDiversityMinimum: 99, conditionalLandmarks: [inaccessible] }, providerFor(request));
  expectStatus(result, "complete");
  if (result.status === "complete") assert.deepEqual(result.admittedLandmarks, []);
});

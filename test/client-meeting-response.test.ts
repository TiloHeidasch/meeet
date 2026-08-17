import assert from "node:assert/strict";
import test from "node:test";
import { validateMeetingResponse, type MeetingRequest } from "../lib/client/meeting-response.ts";

const request: MeetingRequest = {
  contractVersion: "meeet-meeting/v3",
  participants: [
    { id: "participant-1", mode: "transit", origin: { label: "Marienplatz", latitude: 48.1374, longitude: 11.5755 } },
    { id: "participant-2", mode: "transit", origin: { label: "Ostbahnhof", latitude: 48.1257, longitude: 11.605 } },
  ],
  tolerancePercent: 10,
  searchStartAt: "2026-08-11T08:05:00.000Z",
  changeTimePreset: "medium",
};

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const stationArea = { stationAreaId: "station-area-1", name: "Marienplatz", coordinate: { latitude: 48.137, longitude: 11.576 }, classification: "fair", redArrivalSeconds: 600, blueArrivalSeconds: 660, fasterParticipant: "red", withinSelectedTolerance: true };
  return {
    contractVersion: "meeet-meeting/v3", status: "ok", reason: null,
    participants: [
      { id: "participant-1", color: "red", mode: "transit", origin: request.participants[0].origin, accessSeeds: [] },
      { id: "participant-2", color: "blue", mode: "transit", origin: request.participants[1].origin, accessSeeds: [] },
    ],
    stationAreas: [stationArea],
    metadata: {
      schedule: { contractVersion: "meeet-scheduled-routing/v1", feedId: "fixture", timeZone: "Europe/Berlin", scheduleContentHash: "a".repeat(64), compiledArtifactId: "c".repeat(64), serviceDateRange: { firstDate: "2026-08-01", lastDate: "2026-08-31" }, acquisition: { sourceUrl: "https://example.test/feed.zip", retrievedAt: "2026-08-01T00:00:00Z", rawArchiveByteSize: 1, rawArchiveSha256: "b".repeat(64), feedVersion: "fixture", feedValidFrom: "2026-08-01", feedValidUntil: "2026-08-31", attribution: "Fixture", officialAttribution: "MVV", officialLicense: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" }, officialProvenance: { source: "feed", policyId: null } } },
      surface: { contractVersion: "meeet-scheduled-routing/v1", searchStartAt: request.searchStartAt, selectedTolerancePercent: request.tolerancePercent, scheduleContentHash: "a".repeat(64), compiledArtifactId: "c".repeat(64), feedId: "fixture", timeZone: "Europe/Berlin", routingHorizonSeconds: 86400, walkingVelocityMetersPerSecond: 1.4, walkingSecondsRoundingRule: "ceil(distanceMetres / velocityMetresPerSecond), with zero distance taking zero seconds", transferRadiusMeters: 100, accessSeedCounts: [0, 0], stationAreaCount: 1, connectionCount: 1, changeTimeSeconds: 300, coverage: "scheduled-service-day-local-radius/v1", representativePointBasis: "inside-clipped-cell/v1", classificationMethod: "representative-point-with-geometric-final-station-walking/v1", classificationBasis: "representative-point", finalWalkingMethod: "geometric-station-walking-estimate-not-navigation" },
      accessProvider: { name: "fixture", deployment: "fixture", dataKind: "demo-static", liveData: false, asOf: "fixture", notes: "fixture", provenance: { role: "access", provider: "fixture", deployment: "fixture", dataKind: "demo-static", liveData: false, sourceUrl: null, license: null, attribution: "fixture", version: "fixture", retrievedAt: "fixture", notes: "fixture", feeds: null } },
      stationAreas: { count: 1, coverage: "official-munich-boundary-with-connected-artifact-station-areas/v1", selection: "all-eligible-scheduled-station-areas/v1" }, coverage: "munich-clipped-scheduled-grid/v1",
    },
    ...overrides,
  };
}

test("client adapter rejects a non-v3 or structurally unsafe response", () => {
  assert.equal(validateMeetingResponse({ contractVersion: "meeet-meeting/v2" }, request).success, false);
  assert.equal(validateMeetingResponse({ ...response(), participants: [{ id: "only-one" }] }, request).success, false);
});

test("client adapter accepts a complete independent v3 response", () => {
  assert.equal(validateMeetingResponse(response(), request).success, true);
});

test("client adapter rejects station-area tampering and count mismatches", () => {
  const payload = response();
  (payload.stationAreas as Array<Record<string, unknown>>)[0]!.classification = "red";
  assert.equal(validateMeetingResponse(payload, request).success, false);
  const count = response();
  (((count.metadata as Record<string, unknown>).stationAreas as Record<string, unknown>).count as number) = 2;
  assert.equal(validateMeetingResponse(count, request).success, false);
  const pair = response();
  (pair.stationAreas as Array<Record<string, unknown>>)[0]!.fasterParticipant = "blue";
  assert.equal(validateMeetingResponse(pair, request).success, false);
  const outsideBoundary = response();
  (outsideBoundary.stationAreas as Array<Record<string, unknown>>)[0]!.coordinate = { latitude: 49, longitude: 11.576 };
  assert.equal(validateMeetingResponse(outsideBoundary, request).success, false);
  const outsideGeometry = response();
  (outsideGeometry.stationAreas as Array<Record<string, unknown>>)[0]!.coordinate = { latitude: 48.2, longitude: 11.7 };
  assert.equal(validateMeetingResponse(outsideGeometry, request).success, false);
});

test("client adapter accepts unclassified station areas in a no-result response", () => {
  const payload = response({ status: "no-result", reason: "no-access-seeds" });
  const area = (payload.stationAreas as Array<Record<string, unknown>>)[0]!;
  area.classification = "unclassified";
  area.redArrivalSeconds = null;
  area.blueArrivalSeconds = null;
  area.fasterParticipant = null;
  area.withinSelectedTolerance = false;
  assert.equal(validateMeetingResponse(payload, request).success, true);
});

test("client adapter rejects an ok station area with no arrivals", () => {
  const noArrivals = response();
  const area = (noArrivals.stationAreas as Array<Record<string, unknown>>)[0]!;
  area.classification = "red"; area.redArrivalSeconds = null; area.blueArrivalSeconds = null; area.fasterParticipant = null; area.withinSelectedTolerance = false;
  assert.equal(validateMeetingResponse(noArrivals, request).success, false);
});

test("client adapter binds no-access-seeds to an empty access-seed count", () => {
  const payload = response({ status: "no-result", reason: "no-access-seeds" });
  const area = (payload.stationAreas as Array<Record<string, unknown>>)[0]!;
  area.classification = "unclassified"; area.redArrivalSeconds = null; area.blueArrivalSeconds = null; area.fasterParticipant = null; area.withinSelectedTolerance = false;
  assert.equal(validateMeetingResponse(payload, request).success, true);
  ((payload.metadata as Record<string, unknown>).surface as Record<string, unknown>).accessSeedCounts = [1, 1];
  assert.equal(validateMeetingResponse(payload, request).success, false);
  const partiallyEmpty = response({ status: "no-result", reason: "no-access-seeds" });
  const partialArea = (partiallyEmpty.stationAreas as Array<Record<string, unknown>>)[0]!;
  partialArea.classification = "unclassified"; partialArea.redArrivalSeconds = null; partialArea.blueArrivalSeconds = null; partialArea.fasterParticipant = null; partialArea.withinSelectedTolerance = false;
  (partiallyEmpty.participants as Array<Record<string, unknown>>)[1]!.accessSeeds = [{ seedId: "seed-2", mvgStationId: "station-2", stationAreaId: "station-area-2", coordinate: { latitude: 48.137, longitude: 11.576 }, accessSeconds: 120, provenance: { source: "fixture-static", endpoint: "fixture", distanceMeters: 100, walkingSeconds: 120, note: "fixture" } }];
  ((partiallyEmpty.metadata as Record<string, unknown>).surface as Record<string, unknown>).accessSeedCounts = [0, 1];
  assert.equal(validateMeetingResponse(partiallyEmpty, request).success, true);
});

test("client adapter requires access seeds for no-reachable-stations", () => {
  const payload = response({ status: "no-result", reason: "no-reachable-stations" });
  const area = (payload.stationAreas as Array<Record<string, unknown>>)[0]!;
  area.classification = "unclassified"; area.redArrivalSeconds = null; area.blueArrivalSeconds = null; area.fasterParticipant = null; area.withinSelectedTolerance = false;
  assert.equal(validateMeetingResponse(payload, request).success, false);
});

test("client adapter rejects contradictory no-result station areas", () => {
  const payload = response({ status: "no-result", reason: "no-reachable-stations" });
  assert.equal(validateMeetingResponse(payload, request).success, false);
});

test("client adapter binds result start and tolerance to the submitted request", () => {
  const wrongStart = response();
  ((wrongStart.metadata as Record<string, unknown>).surface as Record<string, unknown>).searchStartAt = "2026-08-11T08:06:00.000Z";
  assert.equal(validateMeetingResponse(wrongStart, request).success, false);
  const wrongTolerance = response();
  ((wrongTolerance.metadata as Record<string, unknown>).surface as Record<string, unknown>).selectedTolerancePercent = 15;
  assert.equal(validateMeetingResponse(wrongTolerance, request).success, false);
  const wrongOrigin = response();
  (wrongOrigin.participants as Array<Record<string, unknown>>)[0].id = "another-origin";
  assert.equal(validateMeetingResponse(wrongOrigin, request).success, false);
});

test("client adapter rejects nested contract tampering", () => {
  const unknown = response();
  ((unknown.metadata as Record<string, unknown>).accessProvider as Record<string, unknown>).unexpected = true;
  assert.equal(validateMeetingResponse(unknown, request).success, false);
  const badId = response();
  ((badId.metadata as Record<string, unknown>).schedule as Record<string, unknown>).compiledArtifactId = "artifact";
  assert.equal(validateMeetingResponse(badId, request).success, false);
  const badRounding = response();
  ((badRounding.metadata as Record<string, unknown>).surface as Record<string, unknown>).walkingSecondsRoundingRule = "nearest";
  assert.equal(validateMeetingResponse(badRounding, request).success, false);
});

test("client adapter rejects contradictory access provenance and serialized counts", () => {
  const provider = response();
  const descriptor = provider.metadata as Record<string, unknown>;
  ((descriptor.accessProvider as Record<string, unknown>).provenance as Record<string, unknown>).role = "routing";
  assert.equal(validateMeetingResponse(provider, request).success, false);
  const counts = response();
  ((counts.metadata as Record<string, unknown>).surface as Record<string, unknown>).accessSeedCounts = [1, 0];
  assert.equal(validateMeetingResponse(counts, request).success, false);
});

test("client adapter rejects the retired grid-cell surface contract", () => {
  const legacyCells = response();
  legacyCells.cells = [{ id: "cell-1", geometry: { type: "MultiPolygon", coordinates: [[[[11.57, 48.13], [11.58, 48.13], [11.58, 48.14], [11.57, 48.14], [11.57, 48.13]]]] }, representativePoint: { latitude: 48.135, longitude: 11.575 }, classification: "fair", redArrivalSeconds: 600, blueArrivalSeconds: 660, fasterParticipant: "red", withinSelectedTolerance: true }];
  const legacyCellsResult = validateMeetingResponse(legacyCells, request);
  assert.equal(legacyCellsResult.success, false);
  if (!legacyCellsResult.success) {
    assert.ok(legacyCellsResult.issues.some((issue) => issue.path.includes("cells")));
  }
  const legacyGrid = response();
  (legacyGrid.metadata as Record<string, unknown>).grid = { columns: 24, rows: 16, cellCount: 1, geometry: "munich-clipped-surface-grid/v1" };
  const legacyGridResult = validateMeetingResponse(legacyGrid, request);
  assert.equal(legacyGridResult.success, false);
  if (!legacyGridResult.success) {
    assert.ok(legacyGridResult.issues.some((issue) => issue.path.includes("grid")));
  }
});

test("client adapter rejects an unsupported change-time preset", () => {
  const badPreset = { ...request, changeTimePreset: "instant" } as unknown as MeetingRequest;
  assert.equal(validateMeetingResponse(response(), badPreset).success, false);
});

test("client adapter binds the surface change time to the submitted preset", () => {
  const wrongSeconds = response();
  ((wrongSeconds.metadata as Record<string, unknown>).surface as Record<string, unknown>).changeTimeSeconds = 180;
  assert.equal(validateMeetingResponse(wrongSeconds, request).success, false);
  const missingSeconds = response();
  delete ((missingSeconds.metadata as Record<string, unknown>).surface as Record<string, unknown>).changeTimeSeconds;
  assert.equal(validateMeetingResponse(missingSeconds, request).success, false);
});

test("client adapter rejects the retired boarding-stop station-area shape", () => {
  const legacy = response();
  const area = (legacy.stationAreas as Array<Record<string, unknown>>)[0]!;
  area.redBoardingStopId = "red-stop";
  area.blueBoardingStopId = "blue-stop";
  assert.equal(validateMeetingResponse(legacy, request).success, false);
});

test("client adapter rejects the retired boarding-stop coverage string", () => {
  const legacy = response();
  (((legacy.metadata as Record<string, unknown>).stationAreas as Record<string, unknown>).coverage as string) = "official-munich-boundary-with-connected-artifact-boarding-stops/v1";
  assert.equal(validateMeetingResponse(legacy, request).success, false);
});

test("client adapter rejects retired boarding-stop identity on access seeds", () => {
  const legacy = response();
  (legacy.participants as Array<Record<string, unknown>>)[0]!.accessSeeds = [
    {
      seedId: "seed-1",
      mvgStationId: "station-1",
      stationAreaId: "station-area-1",
      boardingStopId: "stop-1",
      coordinate: { latitude: 48.137, longitude: 11.576 },
      accessSeconds: 120,
      provenance: { source: "fixture-static", endpoint: "fixture", distanceMeters: 100, walkingSeconds: 120, note: "fixture" },
    },
  ];
  assert.equal(validateMeetingResponse(legacy, request).success, false);
});

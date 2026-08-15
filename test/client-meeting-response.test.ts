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
};

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const cell = { id: "cell-1", geometry: { type: "MultiPolygon", coordinates: [[[[11.57, 48.13], [11.58, 48.13], [11.58, 48.14], [11.57, 48.14], [11.57, 48.13]]]] }, representativePoint: { latitude: 48.135, longitude: 11.575 }, classification: "fair", redArrivalSeconds: 600, blueArrivalSeconds: 660, fasterParticipant: "red", withinSelectedTolerance: true };
  return {
    contractVersion: "meeet-meeting/v3", status: "ok", reason: null,
    participants: [
      { id: "participant-1", color: "red", mode: "transit", origin: request.participants[0].origin, accessSeeds: [] },
      { id: "participant-2", color: "blue", mode: "transit", origin: request.participants[1].origin, accessSeeds: [] },
    ],
    cells: [cell],
    metadata: {
      schedule: { contractVersion: "meeet-scheduled-routing/v1", feedId: "fixture", timeZone: "Europe/Berlin", scheduleContentHash: "a".repeat(64), compiledArtifactId: "c".repeat(64), serviceDateRange: { firstDate: "2026-08-01", lastDate: "2026-08-31" }, acquisition: { sourceUrl: "https://example.test/feed.zip", retrievedAt: "2026-08-01T00:00:00Z", rawArchiveByteSize: 1, rawArchiveSha256: "b".repeat(64), feedVersion: "fixture", feedValidFrom: "2026-08-01", feedValidUntil: "2026-08-31", attribution: "Fixture", officialAttribution: "MVV", officialLicense: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" }, officialProvenance: { source: "feed", policyId: null } } },
      surface: { contractVersion: "meeet-scheduled-routing/v1", searchStartAt: request.searchStartAt, selectedTolerancePercent: request.tolerancePercent, scheduleContentHash: "a".repeat(64), compiledArtifactId: "c".repeat(64), feedId: "fixture", timeZone: "Europe/Berlin", routingHorizonSeconds: 86400, walkingVelocityMetersPerSecond: 1.4, walkingSecondsRoundingRule: "ceil(distanceMetres / velocityMetresPerSecond), with zero distance taking zero seconds", transferRadiusMeters: 100, accessSeedCounts: [0, 0], stationAreaCount: 1, boardingStopCount: 1, connectionCount: 1, coverage: "scheduled-service-day-local-radius/v1", representativePointBasis: "inside-clipped-cell/v1", classificationMethod: "representative-point-with-geometric-final-station-walking/v1", classificationBasis: "representative-point", finalWalkingMethod: "geometric-station-walking-estimate-not-navigation" },
      grid: { columns: 24, rows: 16, cellCount: 1, geometry: "munich-clipped-surface-grid/v1" },
      accessProvider: { name: "fixture", deployment: "fixture", dataKind: "demo-static", liveData: false, asOf: "fixture", notes: "fixture", provenance: { role: "access", provider: "fixture", deployment: "fixture", dataKind: "demo-static", liveData: false, sourceUrl: null, license: null, attribution: "fixture", version: "fixture", retrievedAt: "fixture", notes: "fixture", feeds: null } },
      coverage: "munich-clipped-scheduled-grid/v1",
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

test("client adapter rejects a cell whose classification contradicts arrivals", () => {
  const payload = response();
  (payload.cells as Array<Record<string, unknown>>)[0].classification = "red";
  assert.equal(validateMeetingResponse(payload, request).success, false);
});

test("client adapter rejects contradictory no-result cells", () => {
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
  const malformedGeometry = response();
  (((malformedGeometry.cells as Array<Record<string, unknown>>)[0]!.geometry as Record<string, unknown>).coordinates as unknown[][][][])[0]![0]![4] = [11.57, 48.131];
  assert.equal(validateMeetingResponse(malformedGeometry, request).success, false);
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

test("client adapter rejects a representative point on a hole boundary", () => {
  const payload = response();
  const cell = (payload.cells as Array<Record<string, unknown>>)[0]!;
  cell.geometry = {
    type: "MultiPolygon",
    coordinates: [[
      [[11.57, 48.13], [11.58, 48.13], [11.58, 48.14], [11.57, 48.14], [11.57, 48.13]],
      [[11.574, 48.134], [11.576, 48.134], [11.576, 48.136], [11.574, 48.136], [11.574, 48.134]],
    ]],
  };
  cell.representativePoint = { latitude: 48.134, longitude: 11.574 };
  assert.equal(validateMeetingResponse(payload, request).success, false);
});

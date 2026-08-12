import assert from "node:assert/strict";
import test from "node:test";
import { validateMeetingResponse, type MeetingRequest } from "../lib/client/meeting-response.ts";

const request: MeetingRequest = { contractVersion: "meeet-meeting/v3", participants: [
  { id: "participant-1", mode: "transit", origin: { label: "Marienplatz", latitude: 48.1374, longitude: 11.5755 } },
  { id: "participant-2", mode: "transit", origin: { label: "Ostbahnhof", latitude: 48.1257, longitude: 11.605 } },
], tolerancePercent: 10, searchStartAt: "2026-08-11T08:05:00.000Z" };

const originSeed = (id: string) => ({ seedId: id, mvgStationId: id, stationAreaId: id, coordinate: { latitude: 48.137, longitude: 11.576 }, accessSeconds: 120, provenance: { source: "fixture-static", endpoint: "fixture", distanceMeters: 100, walkingSeconds: 120, note: "Offline fixture." } });
const provenance = { role: "access", provider: "fixture", deployment: "fixture", dataKind: "demo-static", liveData: false, sourceUrl: "https://example.test/fixture", license: null, attribution: "Offline fixture", version: "fixture-v1", retrievedAt: "fixture-static", notes: "Offline fixture", feeds: null };
const acquisition = { sourceUrl: "https://example.test/fixture.zip", retrievedAt: "2026-08-01T00:00:00Z", rawArchiveByteSize: 1024, rawArchiveSha256: "a".repeat(64), feedVersion: "fixture-2026-08", feedValidFrom: "2026-08-01", feedValidUntil: "2026-08-31", attribution: "Fixture MVV", officialAttribution: "Fixture MVV", officialLicense: { name: "Fixture License", url: "https://example.test/license" }, officialProvenance: { source: "feed", policyId: null } };
const schedule = { contractVersion: "meeet-scheduled-routing/v1", feedId: "fixture-feed", timeZone: "Europe/Berlin", scheduleContentHash: "b".repeat(64), compiledArtifactId: "c".repeat(64), serviceDateRange: { firstDate: "2026-08-01", lastDate: "2026-08-31" }, acquisition };
const surface = { contractVersion: "meeet-scheduled-routing/v1", scheduleContentHash: schedule.scheduleContentHash, compiledArtifactId: schedule.compiledArtifactId, feedId: schedule.feedId, timeZone: "Europe/Berlin", searchStartAt: request.searchStartAt, routingHorizonSeconds: 86400, selectedTolerancePercent: 10, walkingVelocityMetersPerSecond: 1.4, walkingSecondsRoundingRule: "nearest-whole-second", transferRadiusMeters: 100, accessSeedCounts: [1, 1], stationAreaCount: 2, boardingStopCount: 2, connectionCount: 2, coverage: "scheduled-service-day-local-radius/v1", representativePointBasis: "inside-clipped-cell/v1", classificationMethod: "representative-point-with-geometric-final-station-walking/v1", classificationBasis: "representative-point", finalWalkingMethod: "geometric-station-walking-estimate-not-navigation" };
const cell = (id = "cell-1") => ({ id, geometry: { type: "MultiPolygon", coordinates: [[[[11.57, 48.13], [11.58, 48.13], [11.58, 48.14], [11.57, 48.14], [11.57, 48.13]]]] }, representativePoint: { latitude: 48.135, longitude: 11.575 }, classification: "fair", redArrivalSeconds: 600, blueArrivalSeconds: 660, fasterParticipant: "red", withinSelectedTolerance: true });

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const payload = { contractVersion: "meeet-meeting/v3", status: "ok", reason: null, participants: [
    { id: "participant-1", color: "red", mode: "transit", origin: request.participants[0].origin, accessSeeds: [originSeed("seed-red")] },
    { id: "participant-2", color: "blue", mode: "transit", origin: request.participants[1].origin, accessSeeds: [originSeed("seed-blue")] },
  ], cells: [cell()], metadata: { schedule, surface, grid: { columns: 24, rows: 16, cellCount: 1, geometry: "munich-clipped-surface-grid/v1" }, accessProvider: { name: "fixture access", deployment: "fixture", dataKind: "demo-static", liveData: false, asOf: "fixture-v1", notes: "Offline fixture", provenance }, coverage: "munich-clipped-scheduled-grid/v1" }, ...overrides };
  return structuredClone(payload);
}
test("accepts a complete valid v3 response", () => assert.equal(validateMeetingResponse(response(), request).success, true));
test("rejects a schedule with the wrong contract version", () => {
  const payload = response();
  ((payload.metadata as Record<string, unknown>).schedule as Record<string, unknown>).contractVersion = "gtfs-scheduled-routing/v1";
  assert.equal(validateMeetingResponse(payload, request).success, false);
  assert.equal(validateMeetingResponse(response(), request).success, true);
});
test("rejects wrong shape, missing acquisition, malformed metadata, and unknown keys", () => {
  assert.equal(validateMeetingResponse({ contractVersion: "meeet-meeting/v2" }, request).success, false);
  const missing = response(); delete ((missing.metadata as Record<string, unknown>).schedule as Record<string, unknown>).acquisition; assert.equal(validateMeetingResponse(missing, request).success, false);
  const malformed = response(); (malformed.metadata as Record<string, unknown>).accessProvider = { name: "broken" }; assert.equal(validateMeetingResponse(malformed, request).success, false);
  const unknown = response(); (unknown.metadata as Record<string, unknown>).surprise = true; assert.equal(validateMeetingResponse(unknown, request).success, false);
});
test("rejects invalid geometry and duplicate cells", () => {
  const geometry = response(); (((geometry.cells as Array<Record<string, unknown>>)[0]).geometry as Record<string, unknown>).type = "Polygon"; assert.equal(validateMeetingResponse(geometry, request).success, false);
  const duplicate = response({ cells: [cell(), cell()] }); (duplicate.metadata as Record<string, unknown>).grid = { ...(duplicate.metadata as Record<string, unknown>).grid as object, cellCount: 2 }; assert.equal(validateMeetingResponse(duplicate, request).success, false);
});
test("rejects derived-cell and no-result contradictions", () => {
  const derived = response(); (derived.cells as Array<Record<string, unknown>>)[0].classification = "red"; assert.equal(validateMeetingResponse(derived, request).success, false);
  const noResult = response({ status: "no-result", reason: "no-reachable-stations" }); assert.equal(validateMeetingResponse(noResult, request).success, false);
});
test("rejects request-origin and start tampering", () => {
  const origin = response(); (origin.participants as Array<Record<string, unknown>>)[0].id = "other"; assert.equal(validateMeetingResponse(origin, request).success, false);
  const start = response(); (start.metadata as Record<string, unknown>).surface = { ...surface, searchStartAt: "2026-08-11T08:06:00.000Z" }; assert.equal(validateMeetingResponse(start, request).success, false);
});
test("rejects every exact schedule/surface identity mismatch and wrong tolerance", () => {
  for (const field of ["feedId", "scheduleContentHash", "compiledArtifactId", "timeZone"] as const) {
    const payload = response(); assert.equal(validateMeetingResponse(payload, request).success, true);
    const metadata = payload.metadata as Record<string, unknown>;
    const scheduleValue = metadata.schedule as Record<string, unknown>;
    scheduleValue[field] = field === "timeZone" ? "UTC" : "other";
    assert.equal(validateMeetingResponse(payload, request).success, false);
    assert.equal(validateMeetingResponse(response(), request).success, true);
    const surfaceValue = (response().metadata as Record<string, unknown>).surface as Record<string, unknown>;
    const surfacePayload = response();
    (surfacePayload.metadata as Record<string, unknown>).surface = surfaceValue;
    surfaceValue[field] = field === "timeZone" ? "UTC" : "other";
    assert.equal(validateMeetingResponse(surfacePayload, request).success, false);
  }
  const tolerance = response(); assert.equal(validateMeetingResponse(tolerance, request).success, true);
  ((tolerance.metadata as Record<string, unknown>).surface as Record<string, unknown>).selectedTolerancePercent = 15;
  assert.equal(validateMeetingResponse(tolerance, request).success, false);
  assert.equal(validateMeetingResponse(response(), request).success, true);
});
test("rejects each surface seed count mismatch independently", () => {
  for (const index of [0, 1] as const) {
    const payload = response(); assert.equal(validateMeetingResponse(payload, request).success, true);
    const counts = [...((payload.metadata as Record<string, unknown>).surface as Record<string, unknown>).accessSeedCounts as [number, number]];
    counts[index] = counts[index]! + 1;
    ((payload.metadata as Record<string, unknown>).surface as Record<string, unknown>).accessSeedCounts = counts;
    assert.equal(validateMeetingResponse(payload, request).success, false);
    assert.equal(validateMeetingResponse(response(), request).success, true);
  }
});
test("rejects routing, scheduled, live, and contradictory access-provider claims", () => {
  const tamper = (change: (provider: Record<string, unknown>, provenance: Record<string, unknown>) => void) => {
    const payload = response();
    const provider = (payload.metadata as Record<string, unknown>).accessProvider as Record<string, unknown>;
    const providerProvenance = provider.provenance as Record<string, unknown>;
    change(provider, providerProvenance);
    assert.equal(validateMeetingResponse(payload, request).success, false);
  };
  tamper((_provider, providerProvenance) => { providerProvenance.role = "routing"; });
  tamper((provider, providerProvenance) => { provider.dataKind = "scheduled"; providerProvenance.dataKind = "scheduled"; });
  tamper((provider, providerProvenance) => { provider.liveData = true; providerProvenance.liveData = true; });
  tamper((provider, providerProvenance) => { provider.dataKind = "unknown"; providerProvenance.dataKind = "demo-static"; });
});

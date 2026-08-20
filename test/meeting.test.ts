import assert from "node:assert/strict";
import test from "node:test";

import {
  isWithinOfficialMunichBoundary,
  OFFICIAL_MUNICH_BOUNDARY,
  OFFICIAL_MUNICH_BOUNDARY_MANIFEST,
} from "../lib/domain/boundary.ts";
import { handleMeetingPost } from "../lib/domain/meeting-api.ts";
import { ScheduledCalculationAdmission } from "../lib/domain/scheduled-admission.ts";
import { fixtureProviders } from "../lib/fixtures/providers.ts";
import {
  FIXTURE_SCHEDULED_ACCESS_PROVIDER,
  FIXTURE_SCHEDULED_ARTIFACT,
} from "../lib/fixtures/scheduled-routing.ts";
import type { MeetingProviders } from "../lib/domain/providers.ts";

test("the official Munich application boundary remains a 25-district asset", () => {
  assert.equal(OFFICIAL_MUNICH_BOUNDARY.type, "FeatureCollection");
  assert.equal(OFFICIAL_MUNICH_BOUNDARY.features.length, 25);
  assert.equal(OFFICIAL_MUNICH_BOUNDARY_MANIFEST.districtCount, 25);
  assert.equal(OFFICIAL_MUNICH_BOUNDARY_MANIFEST.legalBoundary, false);
  assert.equal(isWithinOfficialMunichBoundary({ latitude: 48.1374, longitude: 11.5755 }), true);
  assert.equal(isWithinOfficialMunichBoundary({ latitude: 52.52, longitude: 13.405 }), false);
});

test("the API rejects the retired v2 request without invoking journey routing", async () => {
  const response = await handleMeetingPost(
    new Request("https://meeet.test/api/meeting/calculate", {
      method: "POST",
      body: JSON.stringify({
        participants: [
          { id: "one", mode: "transit", location: { label: "A", latitude: 48.1374, longitude: 11.5755 } },
          { id: "two", mode: "transit", location: { label: "B", latitude: 48.1400, longitude: 11.5700 } },
        ],
        arrivalAt: new Date(Date.now() + 3_600_000).toISOString(),
        tolerancePercent: 10,
      }),
    }),
    fixtureProviders,
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_REQUEST");
});

test("a successful scheduled calculation emits high-level [meeet] progress logs", async (t) => {
  const logMock = t.mock.method(console, "log");
  t.after(() => logMock.mock.restore());

  const providers: MeetingProviders = {
    ...fixtureProviders,
    scheduledArtifact: FIXTURE_SCHEDULED_ARTIFACT,
    scheduledAccess: FIXTURE_SCHEDULED_ACCESS_PROVIDER,
  };
  const response = await handleMeetingPost(
    new Request("https://meeet.test/api/meeting/calculate", {
      method: "POST",
      body: JSON.stringify({
        contractVersion: "meeet-meeting/v3",
        participants: [
          { id: "red", origin: { label: "Origin red", latitude: 48.1374, longitude: 11.5755 }, mode: "transit" },
          { id: "blue", origin: { label: "Origin blue", latitude: 48.1400, longitude: 11.5700 }, mode: "transit" },
        ],
        tolerancePercent: 10,
        changeTimePreset: "medium",
        searchStartAt: "2026-08-11T08:05:00+02:00",
      }),
      headers: { "content-type": "application/json" },
    }),
    providers,
  );
  assert.equal(response.status, 200);

  const lines = logMock.mock.calls.map((call) => String(call.arguments[0]));
  const expectedLifecycle = [
    "calculation: request accepted",
    "calculation: started",
    "calculation: phase access-seeds",
    "calculation: phase scheduled-routing",
    "calculation: phase station-area-evaluation",
    "calculation: phase validating-result",
    "calculation: complete",
  ];
  let cursor = -1;
  for (const fragment of expectedLifecycle) {
    const index = lines.findIndex((line, i) => i > cursor && line.includes("[meeet]") && line.includes(fragment));
    assert.ok(index !== -1, `expected a [meeet] ${fragment} log line`);
    cursor = index;
  }
});

test("refused admission emits a [meeet] concurrency rejection diagnostic", async (t) => {
  const errorMock = t.mock.method(console, "error");
  t.after(() => errorMock.mock.restore());

  const admission = new ScheduledCalculationAdmission();
  const release = admission.tryAcquire();
  assert.ok(release);
  try {
    const response = await handleMeetingPost(
      new Request("https://meeet.test/api/meeting/calculate", {
        method: "POST",
        body: JSON.stringify({
          contractVersion: "meeet-meeting/v3",
          participants: [
            { id: "red", origin: { label: "Origin red", latitude: 48.1374, longitude: 11.5755 }, mode: "transit" },
            { id: "blue", origin: { label: "Origin blue", latitude: 48.1400, longitude: 11.5700 }, mode: "transit" },
          ],
          tolerancePercent: 10,
          changeTimePreset: "medium",
          searchStartAt: "2026-08-11T08:05:00+02:00",
        }),
        headers: { "content-type": "application/json" },
      }),
      fixtureProviders,
      { admission },
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "TEMPORARILY_UNAVAILABLE");
    assert.ok(
      errorMock.mock.calls.some((call) => /\[meeet\].*calculation: rejected \(concurrency limit reached/.test(String(call.arguments[0]))),
      "expected a [meeet] calculation: rejected (concurrency limit reached) log line",
    );
  } finally {
    release();
  }
});

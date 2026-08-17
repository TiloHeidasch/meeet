import assert from "node:assert/strict";
import test from "node:test";

import { handleMeetingPost } from "../lib/domain/meeting-api.ts";
import {
  ScheduledCalculationAdmission,
  type ScheduledDeadlineOptions,
} from "../lib/domain/scheduled-admission.ts";
import { FIXTURE_SCHEDULED_ACCESS_PROVIDER, FIXTURE_SCHEDULED_ARTIFACT } from "../lib/fixtures/scheduled-routing.ts";
import {
  DEFAULT_SCHEDULED_MIN_MEMORY_GIB,
  ProviderConfigurationError,
  readProviderConfig,
  readScheduledCapability,
} from "../lib/providers/config.ts";
import type { MeetingProviders } from "../lib/domain/providers.ts";

const REQUEST = {
  contractVersion: "meeet-meeting/v3",
  participants: [
    { id: "red", origin: { label: "Red", latitude: 48.1374, longitude: 11.5755 }, mode: "transit" },
    { id: "blue", origin: { label: "Blue", latitude: 48.1400, longitude: 11.5700 }, mode: "transit" },
  ],
  tolerancePercent: 10,
  changeTimePreset: "medium",
  searchStartAt: "2026-08-11T08:05:00+02:00",
};

const PROVIDERS: MeetingProviders = {
  scheduledArtifact: FIXTURE_SCHEDULED_ARTIFACT,
  scheduledAccess: FIXTURE_SCHEDULED_ACCESS_PROVIDER,
};

function request(): Request {
  return new Request("https://meeet.test/api/meeting/calculate", {
    method: "POST",
    body: JSON.stringify(REQUEST),
    headers: { "content-type": "application/json" },
  });
}

test("admission rejects occupied calculations before a provider factory is invoked", async () => {
  const admission = new ScheduledCalculationAdmission();
  const release = admission.tryAcquire();
  assert.ok(release);
  let factoryCalls = 0;
  try {
    const response = await handleMeetingPost(request(), () => {
      factoryCalls += 1;
      return PROVIDERS;
    }, { admission });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "TEMPORARILY_UNAVAILABLE");
    assert.equal(factoryCalls, 0);
  } finally {
    release();
  }
});

test("admission releases its slot after completion and provider errors", async () => {
  const admission = new ScheduledCalculationAdmission();
  const failed = await handleMeetingPost(request(), () => {
    throw new Error("factory failure");
  }, { admission });
  assert.equal(failed.status, 500);
  const recovered = admission.tryAcquire();
  assert.ok(recovered);
  recovered();
});

test("deadline uses an injected clock and signal without waiting for the production budget", async () => {
  let now = 0;
  const deadline: ScheduledDeadlineOptions = { deadlineMs: 10, now: () => now };
  let accessCalls = 0;
  const response = await handleMeetingPost(request(), {
    scheduledArtifact: FIXTURE_SCHEDULED_ARTIFACT,
    scheduledAccess: {
      ...FIXTURE_SCHEDULED_ACCESS_PROVIDER,
      async resolveAccessSeeds(input) {
        accessCalls += 1;
        now = 11;
        return FIXTURE_SCHEDULED_ACCESS_PROVIDER.resolveAccessSeeds(input);
      },
    },
  }, { admission: new ScheduledCalculationAdmission(), deadline });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "TEMPORARILY_UNAVAILABLE");
  assert.equal(accessCalls, 1);
});

test("deadline can be deterministically pre-aborted before provider work", async () => {
  const controller = new AbortController();
  controller.abort();
  let accessCalls = 0;
  const response = await handleMeetingPost(request(), {
    scheduledArtifact: FIXTURE_SCHEDULED_ARTIFACT,
    scheduledAccess: {
      ...FIXTURE_SCHEDULED_ACCESS_PROVIDER,
      async resolveAccessSeeds(input) {
        accessCalls += 1;
        return FIXTURE_SCHEDULED_ACCESS_PROVIDER.resolveAccessSeeds(input);
      },
    },
  }, { admission: new ScheduledCalculationAdmission(), deadline: { deadlineSignal: controller.signal } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "TEMPORARILY_UNAVAILABLE");
  assert.equal(accessCalls, 0);
});

test("an aborted request releases admission for the next calculation", async () => {
  const admission = new ScheduledCalculationAdmission();
  const controller = new AbortController();
  controller.abort();
  const aborted = await handleMeetingPost(new Request("https://meeet.test/api/meeting/calculate", {
    method: "POST",
    body: JSON.stringify(REQUEST),
    signal: controller.signal,
  }), PROVIDERS, { admission });
  assert.equal(aborted.status, 503);
  const recovered = admission.tryAcquire();
  assert.ok(recovered);
  recovered();
});

test("deadline is checked again after synchronous calculation", async () => {
  let checks = 0;
  const admission = new ScheduledCalculationAdmission();
  const response = await handleMeetingPost(request(), PROVIDERS, {
    admission,
    deadline: { deadlineMs: 10, now: () => (checks++ >= 4 ? 11 : 0) },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "TEMPORARILY_UNAVAILABLE");
  const release = admission.tryAcquire();
  assert.ok(release);
  release();
});

test("scheduled capability is an allow-listed configuration check and never probes an artifact", () => {
  assert.deepEqual(readScheduledCapability({ MEEET_PROVIDER_MODE: "fixture" }), {
    scheduled: { configurationAvailable: true, unavailableReason: null },
  });
  assert.deepEqual(readScheduledCapability({ MEEET_PROVIDER_MODE: "configured" }), {
    scheduled: { configurationAvailable: false, unavailableReason: "schedule-artifact-not-configured" },
  });
  assert.deepEqual(readScheduledCapability({ MEEET_PROVIDER_MODE: "configured", MEEET_SCHEDULE_ARTIFACT_PATH: "/missing/artifact.json" }), {
    scheduled: { configurationAvailable: true, unavailableReason: null },
  });
  assert.deepEqual(readScheduledCapability({ MEEET_PROVIDER_MODE: "self-hosted-routing" }), {
    scheduled: { configurationAvailable: false, unavailableReason: "schedule-artifact-not-configured" },
  });
});

test("scheduled deployment policy is fixed at one request, 90 seconds, and at least 4 GiB", () => {
  const fixture = readProviderConfig({ MEEET_PROVIDER_MODE: "fixture" });
  assert.equal(fixture.scheduledConcurrency, 1);
  assert.equal(fixture.scheduledDeadlineMs, 90_000);
  assert.equal(fixture.scheduledMinMemoryGiB, DEFAULT_SCHEDULED_MIN_MEMORY_GIB);

  const configured = readProviderConfig({
    MEEET_PROVIDER_MODE: "configured",
    MEEET_SCHEDULE_ARTIFACT_PATH: "/missing/artifact.json",
    MEEET_SCHEDULED_MIN_MEMORY_GIB: "4",
  });
  assert.equal(configured.scheduledMinMemoryGiB, 4);
  for (const env of [
    { MEEET_PROVIDER_MODE: "fixture", MEEET_SCHEDULED_CONCURRENCY: "2" },
    { MEEET_PROVIDER_MODE: "fixture", MEEET_SCHEDULED_DEADLINE_MS: "89999" },
    { MEEET_PROVIDER_MODE: "configured", MEEET_SCHEDULED_MIN_MEMORY_GIB: "3" },
  ]) {
    assert.throws(() => readProviderConfig(env), ProviderConfigurationError);
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateScheduledMeetingWithBasis,
  type ScheduledCalculationStage,
} from "../lib/domain/scheduled-routing/meeting.ts";
import {
  FIXTURE_SCHEDULED_ACCESS_PROVIDER,
  FIXTURE_SCHEDULED_ARTIFACT,
} from "../lib/fixtures/scheduled-routing.ts";
import { parseScheduledMeetingRequest } from "../lib/validation/meeting-v3.ts";

// This literal MUST mirror the fixed REQUEST in scripts/profile-scheduled-calculation.ts
// (same participant origins — labels need not match — plus tolerancePercent,
// changeTimePreset, and searchStartAt) so the stage-order test stays comparable
// to the profiling baseline.
const V3_REQUEST = {
  contractVersion: "meeet-meeting/v3",
  participants: [
    { id: "red", origin: { label: "Origin red", latitude: 48.1374, longitude: 11.5755 }, mode: "transit" },
    { id: "blue", origin: { label: "Origin blue", latitude: 48.14, longitude: 11.57 }, mode: "transit" },
  ],
  tolerancePercent: 10,
  changeTimePreset: "medium",
  searchStartAt: "2026-08-11T08:05:00+02:00",
};

const EXPECTED_STAGE_ORDER: readonly ScheduledCalculationStage[] = [
  "access-seeds",
  "station-area-catalog",
  "routing-window",
  "scan-red",
  "scan-blue",
  "participant-surfaces",
  "station-area-evaluation",
  "response-build",
];

test("onStage reports every pipeline stage in canonical order", async () => {
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) throw new Error("Fixture request unexpectedly failed validation.");

  const stages: ScheduledCalculationStage[] = [];
  const calculation = await calculateScheduledMeetingWithBasis(parsed.data, {
    artifact: FIXTURE_SCHEDULED_ARTIFACT,
    access: FIXTURE_SCHEDULED_ACCESS_PROVIDER,
  }, undefined, {
    async onStage(stage) {
      stages.push(stage);
    },
  });

  assert.deepEqual(stages, EXPECTED_STAGE_ORDER);
  assert.equal(calculation.response.status, "ok");
});

test("onStage is optional and does not change the calculation result", async () => {
  const parsed = parseScheduledMeetingRequest(V3_REQUEST);
  assert.equal(parsed.success, true);
  if (!parsed.success) throw new Error("Fixture request unexpectedly failed validation.");

  const withHooks = await calculateScheduledMeetingWithBasis(parsed.data, {
    artifact: FIXTURE_SCHEDULED_ARTIFACT,
    access: FIXTURE_SCHEDULED_ACCESS_PROVIDER,
  }, undefined, {
    async onStage() {
      // Instrumentation only; must not alter the result.
    },
  });
  const withoutHooks = await calculateScheduledMeetingWithBasis(parsed.data, {
    artifact: FIXTURE_SCHEDULED_ARTIFACT,
    access: FIXTURE_SCHEDULED_ACCESS_PROVIDER,
  });

  assert.deepEqual(withHooks.response, withoutHooks.response);
});
import assert from "node:assert/strict";
import test from "node:test";

import {
  handleMeetingPost,
  handleMeetingStreamPost,
} from "../lib/domain/meeting-api.ts";
import { ScheduledCalculationAdmission } from "../lib/domain/scheduled-admission.ts";
import { InMemoryStationAreaCalculationBasisCache } from "../lib/domain/station-area-details-cache.ts";
import { FIXTURE_SCHEDULED_ACCESS_PROVIDER, FIXTURE_SCHEDULED_ARTIFACT } from "../lib/fixtures/scheduled-routing.ts";
import type { MeetingProviders } from "../lib/domain/providers.ts";

const REQUEST = {
  contractVersion: "meeet-meeting/v3",
  participants: [
    { id: "red", origin: { label: "Red", latitude: 48.1374, longitude: 11.5755 }, mode: "transit" },
    { id: "blue", origin: { label: "Blue", latitude: 48.1400, longitude: 11.5700 }, mode: "transit" },
  ],
  tolerancePercent: 10,
  searchStartAt: "2026-08-11T08:05:00+02:00",
};

const PROVIDERS: MeetingProviders = {
  scheduledArtifact: FIXTURE_SCHEDULED_ARTIFACT,
  scheduledAccess: FIXTURE_SCHEDULED_ACCESS_PROVIDER,
};

const STREAM_URL = "https://meeet.test/api/meeting/calculate/stream";
const JSON_URL = "https://meeet.test/api/meeting/calculate";

function streamRequest(signal?: AbortSignal): Request {
  return new Request(STREAM_URL, {
    method: "POST",
    body: JSON.stringify(REQUEST),
    headers: { "content-type": "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
}

function jsonRequest(): Request {
  return new Request(JSON_URL, {
    method: "POST",
    body: JSON.stringify(REQUEST),
    headers: { "content-type": "application/json" },
  });
}

interface SseFrame {
  event?: string;
  data?: string;
  comment?: string;
}

function parseSseFrames(body: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const rawFrame of body.split("\n\n")) {
    if (rawFrame.trim() === "") continue;
    const frame: SseFrame = {};
    for (const line of rawFrame.split("\n")) {
      if (line.startsWith(":")) {
        frame.comment = line.slice(1).trim();
      } else if (line.startsWith("event:")) {
        frame.event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        frame.data = line.slice("data:".length).trim();
      }
    }
    frames.push(frame);
  }
  return frames;
}

test("phases are emitted in order with the progress contract version", async () => {
  const response = await handleMeetingStreamPost(streamRequest(), PROVIDERS, { admission: new ScheduledCalculationAdmission() });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const body = await response.text();
  const frames = parseSseFrames(body);
  const progress = frames.filter((frame) => frame.event === "progress");
  assert.deepEqual(progress.map((frame) => JSON.parse(frame.data ?? "{}").phase), [
    "access-seeds",
    "scheduled-routing",
    "station-area-evaluation",
    "validating-result",
  ]);
  for (const frame of progress) {
    assert.equal(JSON.parse(frame.data ?? "{}").contractVersion, "meeet-calculation-progress/v1");
  }
  const events = frames.filter((frame) => frame.event !== undefined).map((frame) => frame.event);
  assert.deepEqual(events, ["progress", "progress", "progress", "progress", "ref", "result"]);
});

test("terminal result event deep-equals the JSON endpoint response for the same request", async () => {
  let refCounter = 0;
  const cache = new InMemoryStationAreaCalculationBasisCache({ referenceFactory: () => `stream-ref-${refCounter++}` });
  const streamResponse = await handleMeetingStreamPost(streamRequest(), PROVIDERS, {
    admission: new ScheduledCalculationAdmission(),
    basisCache: cache,
  });
  const body = await streamResponse.text();
  const frames = parseSseFrames(body);
  const refFrame = frames.find((frame) => frame.event === "ref");
  const resultFrame = frames.find((frame) => frame.event === "result");
  assert.ok(refFrame?.data);
  assert.ok(resultFrame?.data);
  assert.equal(JSON.parse(refFrame.data).calculationRef, "stream-ref-0");
  const streamResult = JSON.parse(resultFrame.data);

  const jsonResponse = await handleMeetingPost(jsonRequest(), PROVIDERS, {
    admission: new ScheduledCalculationAdmission(),
    basisCache: cache,
  });
  assert.equal(jsonResponse.status, 200);
  assert.equal(jsonResponse.headers.get("Meeet-Calculation-Ref"), "stream-ref-1");
  const jsonBody = await jsonResponse.json();
  assert.deepEqual(streamResult, jsonBody);
});

test("no-result request streams a terminal result event with status no-result", async () => {
  const noSeeds: MeetingProviders = {
    ...PROVIDERS,
    scheduledAccess: { ...FIXTURE_SCHEDULED_ACCESS_PROVIDER, resolveAccessSeeds: async () => [] },
  };
  const response = await handleMeetingStreamPost(streamRequest(), noSeeds, { admission: new ScheduledCalculationAdmission() });
  const body = await response.text();
  const frames = parseSseFrames(body);
  const resultFrame = frames.find((frame) => frame.event === "result");
  assert.ok(resultFrame?.data);
  const result = JSON.parse(resultFrame.data);
  assert.equal(result.status, "no-result");
  assert.equal(result.reason, "no-access-seeds");
});

test("invalid request returns a JSON 400 before any stream", async () => {
  const response = await handleMeetingStreamPost(new Request(STREAM_URL, {
    method: "POST",
    body: JSON.stringify({ ...REQUEST, tolerancePercent: 7 }),
  }), PROVIDERS, { admission: new ScheduledCalculationAdmission() });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal((await response.json()).error.code, "INVALID_REQUEST");
});

test("refused admission returns a JSON 503 before any stream", async () => {
  const admission = new ScheduledCalculationAdmission();
  const release = admission.tryAcquire();
  assert.ok(release);
  try {
    const response = await handleMeetingStreamPost(streamRequest(), PROVIDERS, { admission });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal((await response.json()).error.code, "TEMPORARILY_UNAVAILABLE");
  } finally {
    release();
  }
});

test("deadline exceeded streams a terminal error event with TEMPORARILY_UNAVAILABLE", async () => {
  let now = 0;
  const response = await handleMeetingStreamPost(streamRequest(), {
    ...PROVIDERS,
    scheduledAccess: {
      ...FIXTURE_SCHEDULED_ACCESS_PROVIDER,
      async resolveAccessSeeds(input) {
        now = 11;
        return FIXTURE_SCHEDULED_ACCESS_PROVIDER.resolveAccessSeeds(input);
      },
    },
  }, { admission: new ScheduledCalculationAdmission(), deadline: { deadlineMs: 10, now: () => now } });
  const body = await response.text();
  const frames = parseSseFrames(body);
  const errorFrame = frames.find((frame) => frame.event === "error");
  assert.ok(errorFrame?.data);
  const error = JSON.parse(errorFrame.data);
  assert.equal(error.code, "TEMPORARILY_UNAVAILABLE");
});

test("pre-aborted request signal returns a JSON 503 before any stream", async () => {
  const controller = new AbortController();
  controller.abort();
  const response = await handleMeetingStreamPost(streamRequest(controller.signal), PROVIDERS, { admission: new ScheduledCalculationAdmission() });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal((await response.json()).error.code, "TEMPORARILY_UNAVAILABLE");
});

test("disconnect mid-calculation releases admission exactly once", async () => {
  const admission = new ScheduledCalculationAdmission();
  const controller = new AbortController();
  const slowAccess: MeetingProviders = {
    ...PROVIDERS,
    scheduledAccess: {
      ...FIXTURE_SCHEDULED_ACCESS_PROVIDER,
      async resolveAccessSeeds(input) {
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) {
            resolve();
            return;
          }
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return FIXTURE_SCHEDULED_ACCESS_PROVIDER.resolveAccessSeeds(input);
      },
    },
  };
  const response = await handleMeetingStreamPost(streamRequest(controller.signal), slowAccess, { admission });
  assert.equal(response.status, 200);
  const textPromise = response.text();
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await textPromise;
  const release = admission.tryAcquire();
  assert.ok(release);
  release();
});

test("heartbeat comments keep the stream alive during slow access", async () => {
  const slowAccess: MeetingProviders = {
    ...PROVIDERS,
    scheduledAccess: {
      ...FIXTURE_SCHEDULED_ACCESS_PROVIDER,
      async resolveAccessSeeds(input) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return FIXTURE_SCHEDULED_ACCESS_PROVIDER.resolveAccessSeeds(input);
      },
    },
  };
  const response = await handleMeetingStreamPost(streamRequest(), slowAccess, {
    admission: new ScheduledCalculationAdmission(),
    heartbeatMs: 10,
  });
  const body = await response.text();
  assert.ok(body.includes(": heartbeat"));
});

test("provider factory throws a terminal error event with a safe message", async () => {
  const response = await handleMeetingStreamPost(streamRequest(), () => {
    throw new Error("secret internal detail: token=abc123");
  }, { admission: new ScheduledCalculationAdmission() });
  const body = await response.text();
  const frames = parseSseFrames(body);
  const errorFrame = frames.find((frame) => frame.event === "error");
  assert.ok(errorFrame?.data);
  const error = JSON.parse(errorFrame.data);
  assert.equal(error.code, "CALCULATION_FAILED");
  assert.ok(!error.message.includes("secret internal detail"));
});

test("every successful stream ends with exactly one terminal event and a trailing blank line", async () => {
  const response = await handleMeetingStreamPost(streamRequest(), PROVIDERS, { admission: new ScheduledCalculationAdmission() });
  const body = await response.text();
  const frames = parseSseFrames(body);
  const terminal = frames.filter((frame) => frame.event === "result" || frame.event === "error");
  assert.equal(terminal.length, 1);
  assert.ok(body.endsWith("\n\n"));
});

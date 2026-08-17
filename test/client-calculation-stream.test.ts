import assert from "node:assert/strict";
import test from "node:test";

import {
  CALCULATION_PROGRESS_CONTRACT_VERSION,
  CalculationStreamError,
  readCalculationStream,
} from "../lib/client/calculation-stream.ts";
import type {
  CalculationStreamEvent,
  StationVerdict,
} from "../lib/client/calculation-stream.ts";

const encoder = new TextEncoder();

const streamResponse = (chunks: string[]): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

const byteByByte = (text: string): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of encoder.encode(text)) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

const collect = async (response: Response, signal?: AbortSignal): Promise<CalculationStreamEvent[]> => {
  const events: CalculationStreamEvent[] = [];
  await readCalculationStream(response, (event) => events.push(event), signal);
  return events;
};

const progress = (phase: string) => `event: progress\ndata: ${JSON.stringify({ contractVersion: CALCULATION_PROGRESS_CONTRACT_VERSION, phase })}\n\n`;
const verdict = (stationAreaId: string, name: string, coordinate: { latitude: number; longitude: number }, verdictValue: StationVerdict["verdict"]) =>
  `event: station-verdict\ndata: ${JSON.stringify({ contractVersion: CALCULATION_PROGRESS_CONTRACT_VERSION, stationAreaId, name, coordinate, verdict: verdictValue })}\n\n`;

test("reads a full progress → station-verdict → ref → result sequence in order", async () => {
  const body = [
    progress("access-seeds"),
    progress("scheduled-routing"),
    progress("station-area-evaluation"),
    verdict("area-1", "Area 1", { latitude: 48.13, longitude: 11.58 }, "fair"),
    verdict("area-2", "Area 2", { latitude: 48.14, longitude: 11.56 }, "red"),
    progress("validating-result"),
    'event: ref\ndata: {"calculationRef":"calc-1"}\n\n',
    'event: result\ndata: {"status":"ok"}\n\n',
  ].join("");
  const events = await collect(streamResponse([body]));
  assert.deepEqual(events, [
    { kind: "progress", phase: "access-seeds" },
    { kind: "progress", phase: "scheduled-routing" },
    { kind: "progress", phase: "station-area-evaluation" },
    { kind: "station-verdict", verdict: { stationAreaId: "area-1", name: "Area 1", coordinate: { latitude: 48.13, longitude: 11.58 }, verdict: "fair" } },
    { kind: "station-verdict", verdict: { stationAreaId: "area-2", name: "Area 2", coordinate: { latitude: 48.14, longitude: 11.56 }, verdict: "red" } },
    { kind: "progress", phase: "validating-result" },
    { kind: "ref", calculationRef: "calc-1" },
    { kind: "result", result: { status: "ok" } },
  ]);
});

test("parses frames split across chunk boundaries", async () => {
  const body = 'event: progress\ndata: {"contractVersion":"meeet-calculation-progress/v1","phase":"access-seeds"}\n\nevent: ref\ndata: {"calculationRef":"calc-1"}\n\n';
  const byteEvents = await collect(byteByByte(body));
  assert.deepEqual(byteEvents, [
    { kind: "progress", phase: "access-seeds" },
    { kind: "ref", calculationRef: "calc-1" },
  ]);
  const splitEvents = await collect(streamResponse([
    'event: progr',
    'ess\ndata: {"contractVersion":"meeet-calculation-progress/v1","phase":"scheduled-rout',
    'ing"}\n\nevent: ref\ndata: {"calculationRef":"calc-',
    '1"}\n\n',
  ]));
  assert.deepEqual(splitEvents, [
    { kind: "progress", phase: "scheduled-routing" },
    { kind: "ref", calculationRef: "calc-1" },
  ]);
});

test("accepts CRLF line endings", async () => {
  const body = 'event: progress\r\ndata: {"contractVersion":"meeet-calculation-progress/v1","phase":"access-seeds"}\r\n\r\nevent: ref\r\ndata: {"calculationRef":"calc-1"}\r\n\r\n';
  const events = await collect(streamResponse([body]));
  assert.deepEqual(events, [
    { kind: "progress", phase: "access-seeds" },
    { kind: "ref", calculationRef: "calc-1" },
  ]);
});

test("ignores comment heartbeat frames", async () => {
  const body = ': keep-alive\n\n' + progress("access-seeds") + ': another heartbeat\n\n';
  const events = await collect(streamResponse([body]));
  assert.deepEqual(events, [{ kind: "progress", phase: "access-seeds" }]);
});

test("ignores unknown event types", async () => {
  const body = 'event: ping\ndata: {"hello":"world"}\n\n' + progress("access-seeds");
  const events = await collect(streamResponse([body]));
  assert.deepEqual(events, [{ kind: "progress", phase: "access-seeds" }]);
});

test("ignores unknown progress phases", async () => {
  const body = progress("future-phase") + progress("access-seeds");
  const events = await collect(streamResponse([body]));
  assert.deepEqual(events, [{ kind: "progress", phase: "access-seeds" }]);
});

test("throws on a station-verdict event with a wrong contract version", async () => {
  const body = 'event: station-verdict\ndata: {"contractVersion":"meeet-calculation-progress/v2","stationAreaId":"area-1","name":"Area 1","coordinate":{"latitude":48.13,"longitude":11.58},"verdict":"fair"}\n\n';
  await assert.rejects(collect(streamResponse([body])), (err) => err instanceof CalculationStreamError && err.message === "Unsupported calculation progress contract version.");
});

test("throws on a station-verdict event with coordinates outside the official Munich boundary", async () => {
  const outsideCoordinates = [
    // Latitude 49 is north of Munich
    verdict("area-outside-1", "Outside 1", { latitude: 49.0, longitude: 11.58 }, "fair"),
    // Longitude 11.7 is east of Munich
    verdict("area-outside-2", "Outside 2", { latitude: 48.2, longitude: 11.7 }, "red"),
  ];
  for (const frame of outsideCoordinates) {
    await assert.rejects(collect(streamResponse([frame])), (err) => err instanceof CalculationStreamError && err.message === "Invalid station-verdict event in calculation stream.");
  }
});

test("throws on a station-verdict event with invalid or missing fields", async () => {
  const invalidFields = [
    'event: station-verdict\ndata: {"contractVersion":"meeet-calculation-progress/v1","stationAreaId":"","name":"Area 1","coordinate":{"latitude":48.13,"longitude":11.58},"verdict":"fair"}\n\n',
    'event: station-verdict\ndata: {"contractVersion":"meeet-calculation-progress/v1","stationAreaId":"area-1","name":"","coordinate":{"latitude":48.13,"longitude":11.58},"verdict":"fair"}\n\n',
    'event: station-verdict\ndata: {"contractVersion":"meeet-calculation-progress/v1","stationAreaId":"area-1","name":"Area 1","coordinate":{"latitude":"invalid","longitude":11.58},"verdict":"fair"}\n\n',
    'event: station-verdict\ndata: {"contractVersion":"meeet-calculation-progress/v1","stationAreaId":"area-1","name":"Area 1","coordinate":{"latitude":48.13,"longitude":11.58},"verdict":"invalid-verdict"}\n\n',
    'event: station-verdict\ndata: {"contractVersion":"meeet-calculation-progress/v1","stationAreaId":"area-1","name":"Area 1"}\n\n',
  ];
  for (const body of invalidFields) {
    await assert.rejects(collect(streamResponse([body])), CalculationStreamError);
  }
});

test("throws on a progress event with a wrong contract version", async () => {
  const body = 'event: progress\ndata: {"contractVersion":"meeet-calculation-progress/v2","phase":"access-seeds"}\n\n';
  await assert.rejects(collect(streamResponse([body])), CalculationStreamError);
});

test("throws on malformed JSON data", async () => {
  const body = 'event: progress\ndata: {not-json}\n\n';
  await assert.rejects(collect(streamResponse([body])), CalculationStreamError);
});

test("parses a terminal error event", async () => {
  const body = 'event: error\ndata: {"code":"NO_MVG_ROUTE","message":"No MVG route found."}\n\n';
  const events = await collect(streamResponse([body]));
  assert.deepEqual(events, [{ kind: "error", code: "NO_MVG_ROUTE", message: "No MVG route found." }]);
});

test("resolves without events when the stream closes early", async () => {
  assert.deepEqual(await collect(streamResponse([])), []);
  assert.deepEqual(await collect(streamResponse([": heartbeat\n\n"])), []);
});

test("discards a trailing partial frame without a terminator", async () => {
  const body = progress("access-seeds") + 'event: ref\ndata: {"calculationRef":"calc-1"}';
  const events = await collect(streamResponse([body]));
  assert.deepEqual(events, [{ kind: "progress", phase: "access-seeds" }]);
});

test("throws when the content-type is not text/event-stream", async () => {
  const json = new Response("plain", { headers: { "content-type": "application/json" } });
  await assert.rejects(collect(json), CalculationStreamError);
  const missing = new Response("plain");
  await assert.rejects(collect(missing), CalculationStreamError);
});

test("passes the raw parsed result data through unchanged", async () => {
  const payload = { contractVersion: "meeet-meeting/v3", status: "ok", stationAreas: [{ id: "a", nested: { deep: [1, 2, 3] } }] };
  const events = await collect(streamResponse([`event: result\ndata: ${JSON.stringify(payload)}\n\n`]));
  assert.deepEqual(events, [{ kind: "result", result: payload }]);
  const scalar = await collect(streamResponse(['event: result\ndata: "just-a-string"\n\n']));
  assert.deepEqual(scalar, [{ kind: "result", result: "just-a-string" }]);
});

test("throws on a ref event with an empty calculationRef", async () => {
  const empty = 'event: ref\ndata: {"calculationRef":""}\n\n';
  await assert.rejects(collect(streamResponse([empty])), CalculationStreamError);
  const missing = 'event: ref\ndata: {}\n\n';
  await assert.rejects(collect(streamResponse([missing])), CalculationStreamError);
});

test("propagates an abort mid-read", async () => {
  const controller = new AbortController();
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(progress("access-seeds")));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const reading = readCalculationStream(response, () => {}, controller.signal);
  controller.abort();
  await assert.rejects(reading, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
});
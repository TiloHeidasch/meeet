// E2E functional calculation gate.
//
// Runs against a built and started meeet server (fixture provider mode with a
// freshly compiled fixture schedule artifact) and exercises the calculation
// journey the client actually uses at now + 5 minutes:
//   1. The non-streaming JSON `meeet-meeting/v3` endpoint (existing smoke).
//   2. The `meeet-meeting/v3` SSE stream: ordered progress phases, exactly one
//      terminal result, and the calculation reference used to fetch details.
//   3. The `meeet-station-area-details/v1` endpoint for a returned station
//      area, using the calculation reference from the stream.
// Plain Node ESM, no dependencies, no TypeScript.

const BASE_URL = process.env.MEEET_E2E_BASE_URL ?? "http://127.0.0.1:3000";

const CALCULATION_PROGRESS_PHASES = [
  "access-seeds",
  "scheduled-routing",
  "station-area-evaluation",
  "validating-result",
];

const REQUEST = {
  contractVersion: "meeet-meeting/v3",
  participants: [
    { id: "red", origin: { label: "Red", latitude: 48.1374, longitude: 11.5755 }, mode: "transit" },
    { id: "blue", origin: { label: "Blue", latitude: 48.14, longitude: 11.57 }, mode: "transit" },
  ],
  tolerancePercent: 10,
  changeTimePreset: "medium",
  searchStartAt: new Date(Math.floor((Date.now() + 5 * 60 * 1000) / 1000) * 1000).toISOString(),
};

function fail(assertion, detail) {
  console.error(`E2E FAILED: ${assertion}`);
  if (detail !== undefined) {
    console.error(JSON.stringify(detail, null, 2));
  }
  process.exit(1);
}

function assertScheduledMeetingResponse(body, label) {
  if (body.contractVersion !== "meeet-meeting/v3") {
    fail(`${label}: contractVersion is "meeet-meeting/v3"`, body.contractVersion);
  }
  if (body.status !== "ok") {
    fail(`${label}: status is "ok"`, body.status);
  }
  if (!Array.isArray(body.participants) || body.participants.length !== 2) {
    fail(`${label}: participants is an array of length 2`, body.participants);
  }
  const colors = body.participants.map((participant) => participant.color).sort();
  if (colors[0] !== "blue" || colors[1] !== "red") {
    fail(`${label}: participant colors are "red" and "blue"`, colors);
  }
  if (!Array.isArray(body.stationAreas) || body.stationAreas.length === 0) {
    fail(`${label}: stationAreas is a non-empty array`, body.stationAreas);
  }
  if (typeof body.metadata !== "object" || body.metadata === null) {
    fail(`${label}: metadata is an object`, body.metadata);
  }
}

// These three steps run sequentially and fully awaited, not in parallel: the
// server admits only one scheduled calculation at a time (SCHEDULED_CALCULATION_CONCURRENCY
// in lib/domain/scheduled-admission.ts), so an overlapping request would be
// rejected with 503 TEMPORARILY_UNAVAILABLE.

// 1. Existing JSON calculation smoke.

const jsonResponse = await fetch(`${BASE_URL}/api/meeting/calculate`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(REQUEST),
});

if (jsonResponse.status !== 200) {
  fail(`JSON calculate: HTTP status is 200 (got ${jsonResponse.status})`, await jsonResponse.text().catch(() => undefined));
}

const jsonBody = await jsonResponse.json();
assertScheduledMeetingResponse(jsonBody, "JSON calculate");

console.log(
  `E2E OK: v3 JSON calculation returned status "ok" with ${jsonBody.stationAreas.length} station areas for red/blue participants`,
);

// 2. SSE stream: ordered progress, exactly one terminal result, and a
//    calculation reference.

const streamResponse = await fetch(`${BASE_URL}/api/meeting/calculate/stream`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(REQUEST),
});

if (streamResponse.status !== 200) {
  fail(`SSE stream: HTTP status is 200 (got ${streamResponse.status})`, await streamResponse.text().catch(() => undefined));
}
if (streamResponse.body === null) {
  fail("SSE stream: response has a body");
}

const observedPhases = [];
let calculationRef = null;
let resultBody = null;
let resultCount = 0;
let errorEvent = null;

const decoder = new TextDecoder();
const reader = streamResponse.body.getReader();
let buffer = "";
let done = false;
while (!done) {
  const chunk = await reader.read();
  done = chunk.done;
  if (chunk.value !== undefined) buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n?/g, "\n");
  let separatorIndex;
  while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
    const frame = buffer.slice(0, separatorIndex);
    buffer = buffer.slice(separatorIndex + 2);
    if (frame.trim() === "" || frame.startsWith(":")) continue;
    const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (eventLine === undefined || dataLine === undefined) continue;
    const eventName = eventLine.slice("event: ".length);
    let data;
    try {
      data = JSON.parse(dataLine.slice("data: ".length));
    } catch (error) {
      fail(`SSE stream: "${eventName}" event data is valid JSON`, { dataLine, error: String(error) });
    }
    if (eventName === "progress") {
      observedPhases.push(data.phase);
    } else if (eventName === "ref") {
      calculationRef = data.calculationRef;
    } else if (eventName === "result") {
      resultCount += 1;
      resultBody = data;
    } else if (eventName === "error") {
      errorEvent = data;
    }
  }
}

if (errorEvent !== null) {
  fail("SSE stream: no error event", errorEvent);
}
if (observedPhases.join(",") !== CALCULATION_PROGRESS_PHASES.join(",")) {
  fail(`SSE stream: progress phases are ordered ${JSON.stringify(CALCULATION_PROGRESS_PHASES)}`, observedPhases);
}
if (resultCount !== 1) {
  fail("SSE stream: exactly one terminal result event", resultCount);
}
if (resultBody === null) {
  fail("SSE stream: a result event was received");
}
assertScheduledMeetingResponse(resultBody, "SSE stream result");
if (typeof calculationRef !== "string" || calculationRef.trim() === "") {
  fail("SSE stream: a calculation reference was received", calculationRef);
}

console.log(`E2E OK: v3 SSE stream produced ordered progress and one terminal result with a calculation reference`);

// 3. Station-area details for a returned station area, using the calculation
//    reference from the stream.

const targetStationArea = resultBody.stationAreas.find((area) => area.classification !== "unclassified")
  ?? resultBody.stationAreas[0];

const detailsResponse = await fetch(`${BASE_URL}/api/meeting/station-areas/${targetStationArea.stationAreaId}/details`, {
  method: "POST",
  headers: { "content-type": "application/json", "Meeet-Calculation-Ref": calculationRef },
  body: JSON.stringify(REQUEST),
});

if (detailsResponse.status !== 200) {
  fail(`Station-area details: HTTP status is 200 (got ${detailsResponse.status})`, await detailsResponse.text().catch(() => undefined));
}

const detailsBody = await detailsResponse.json();

if (detailsBody.contractVersion !== "meeet-station-area-details/v1") {
  fail(`Station-area details: contractVersion is "meeet-station-area-details/v1"`, detailsBody.contractVersion);
}
// The details basis mirrors the already-asserted "ok" top-level result status
// (lib/domain/scheduled-routing/meeting.ts), so "no-result" cannot occur here.
if (detailsBody.status !== "ok") {
  fail(`Station-area details: status is "ok"`, detailsBody.status);
}
if (typeof detailsBody.stationArea !== "object" || detailsBody.stationArea === null || detailsBody.stationArea.stationAreaId !== targetStationArea.stationAreaId) {
  fail("Station-area details: stationArea matches the requested station area", detailsBody.stationArea);
}
if (!Array.isArray(detailsBody.participants) || detailsBody.participants.length !== 2) {
  fail("Station-area details: participants is an array of length 2", detailsBody.participants);
}
const detailsColors = detailsBody.participants.map((participant) => participant.color).sort();
if (detailsColors[0] !== "blue" || detailsColors[1] !== "red") {
  fail('Station-area details: participant colors are "red" and "blue"', detailsColors);
}
if (typeof detailsBody.basis !== "object" || detailsBody.basis === null) {
  fail("Station-area details: basis is an object", detailsBody.basis);
}

console.log(
  `E2E OK: v1 station-area details returned status "${detailsBody.status}" for station area ${targetStationArea.stationAreaId}`,
);
process.exit(0);

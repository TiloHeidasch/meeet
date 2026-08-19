// E2E functional calculation gate.
//
// Runs against a built and started meeet server (fixture provider mode with a
// freshly compiled fixture schedule artifact) and performs one functional
// calculation through the public JSON endpoint at now + 5 minutes.
// Plain Node ESM, no dependencies, no TypeScript.

const BASE_URL = process.env.MEEET_E2E_BASE_URL ?? "http://127.0.0.1:3000";

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

const response = await fetch(`${BASE_URL}/api/meeting/calculate`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(REQUEST),
});

if (response.status !== 200) {
  fail(`HTTP status is 200 (got ${response.status})`, await response.text().catch(() => undefined));
}

const body = await response.json();

if (body.contractVersion !== "meeet-meeting/v3") {
  fail(`contractVersion is "meeet-meeting/v3"`, body.contractVersion);
}
if (body.status !== "ok") {
  fail(`status is "ok"`, body.status);
}
if (!Array.isArray(body.participants) || body.participants.length !== 2) {
  fail("participants is an array of length 2", body.participants);
}
const colors = body.participants.map((participant) => participant.color).sort();
if (colors[0] !== "blue" || colors[1] !== "red") {
  fail('participant colors are "red" and "blue"', colors);
}
if (!Array.isArray(body.stationAreas) || body.stationAreas.length === 0) {
  fail("stationAreas is a non-empty array", body.stationAreas);
}
if (typeof body.metadata !== "object" || body.metadata === null) {
  fail("metadata is an object", body.metadata);
}

console.log(
  `E2E OK: v3 calculation returned status "ok" with ${body.stationAreas.length} station areas for red/blue participants`,
);
process.exit(0);

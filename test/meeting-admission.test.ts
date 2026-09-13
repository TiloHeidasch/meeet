import assert from "node:assert/strict";
import test from "node:test";

import { createMeetingCalculatePost } from "../app/api/meeting/calculate/route.ts";
import { createMeetingStreamPost } from "../app/api/meeting/calculate/stream/route.ts";
import { createStationAreaDetailsPost } from "../app/api/meeting/station-areas/[stationAreaId]/details/route.ts";
import {
  handleMeetingPost,
  MAX_MEETING_REQUEST_BODY_BYTES,
} from "../lib/domain/meeting-api.ts";
import { ScheduledCalculationAdmission } from "../lib/domain/scheduled-admission.ts";
import { InMemoryStationAreaCalculationBasisCache } from "../lib/domain/station-area-details-cache.ts";
import { FIXTURE_SCHEDULED_ACCESS_PROVIDER, FIXTURE_SCHEDULED_ARTIFACT } from "../lib/fixtures/scheduled-routing.ts";
import { ProviderConfigurationError } from "../lib/providers/config.ts";
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
} as const;

const PROVIDERS: MeetingProviders = {
  scheduledArtifact: FIXTURE_SCHEDULED_ARTIFACT,
  scheduledAccess: FIXTURE_SCHEDULED_ACCESS_PROVIDER,
};

const CALCULATE_URL = "https://meeet.test/api/meeting/calculate";
const STREAM_URL = "https://meeet.test/api/meeting/calculate/stream";
const DETAILS_URL = "https://meeet.test/api/meeting/station-areas/fixture-c/details";

class CountingAdmission extends ScheduledCalculationAdmission {
  calls = 0;

  override tryAcquire(): (() => void) | null {
    this.calls += 1;
    return super.tryAcquire();
  }
}

class UnreadableRequest extends Request {
  override async text(): Promise<string> {
    throw new Error("body stream unavailable: secret transport detail");
  }
}

function request(url: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    body,
    headers,
  });
}

function validBody(): string {
  return JSON.stringify(REQUEST);
}

const bodyCases: Array<{
  name: string;
  makeRequest: (url: string) => Request;
  status: number;
  code: string;
}> = [
  {
    name: "declared oversized body",
    makeRequest: (url) => request(url, validBody(), { "content-length": String(MAX_MEETING_REQUEST_BODY_BYTES + 1) }),
    status: 413,
    code: "REQUEST_TOO_LARGE",
  },
  {
    name: "actual oversized body",
    makeRequest: (url) => request(url, "x".repeat(MAX_MEETING_REQUEST_BODY_BYTES + 1)),
    status: 413,
    code: "REQUEST_TOO_LARGE",
  },
  {
    name: "unreadable body",
    makeRequest: (url) => new UnreadableRequest(url, { method: "POST", body: validBody() }),
    status: 400,
    code: "MALFORMED_JSON",
  },
  {
    name: "malformed JSON body",
    makeRequest: (url) => request(url, "{"),
    status: 400,
    code: "MALFORMED_JSON",
  },
  {
    name: "blank body",
    makeRequest: (url) => request(url, " \t\n "),
    status: 400,
    code: "MALFORMED_JSON",
  },
  {
    name: "retired request contract",
    makeRequest: (url) => request(url, JSON.stringify({ participants: REQUEST.participants, arrivalAt: REQUEST.searchStartAt, tolerancePercent: 10 })),
    status: 400,
    code: "INVALID_REQUEST",
  },
  {
    name: "unknown v3 request field",
    makeRequest: (url) => request(url, JSON.stringify({ ...REQUEST, unexpected: true })),
    status: 400,
    code: "INVALID_REQUEST",
  },
];

test("calculate adapter rejects request bodies before provider or admission work", async () => {
  for (const testCase of bodyCases) {
    const admission = new CountingAdmission();
    let factoryCalls = 0;
    const post = createMeetingCalculatePost({
      admission,
      createProviders: () => {
        factoryCalls += 1;
        return PROVIDERS;
      },
    });
    const response = await post(testCase.makeRequest(CALCULATE_URL));
    assert.equal(response.status, testCase.status, testCase.name);
    assert.equal((await response.json()).error.code, testCase.code, testCase.name);
    assert.equal(factoryCalls, 0, `${testCase.name}: provider factory must not run`);
    assert.equal(admission.calls, 0, `${testCase.name}: admission must not run`);
  }
});

test("stream adapter rejects request bodies as JSON before SSE commencement or work", async () => {
  for (const testCase of bodyCases) {
    const admission = new CountingAdmission();
    let factoryCalls = 0;
    const post = createMeetingStreamPost({
      admission,
      createProviders: () => {
        factoryCalls += 1;
        return PROVIDERS;
      },
    });
    const response = await post(testCase.makeRequest(STREAM_URL));
    assert.equal(response.status, testCase.status, testCase.name);
    assert.equal(response.headers.get("content-type"), "application/json", testCase.name);
    assert.equal((await response.json()).error.code, testCase.code, testCase.name);
    assert.equal(factoryCalls, 0, `${testCase.name}: provider factory must not run`);
    assert.equal(admission.calls, 0, `${testCase.name}: admission must not run`);
  }
});

const detailInputCases: Array<{
  name: string;
  stationAreaId: string;
  makeRequest: () => Request;
  status: number;
  code: string;
}> = [
  {
    name: "declared oversized body",
    stationAreaId: "fixture-c",
    makeRequest: () => request(DETAILS_URL, validBody(), { "Meeet-Calculation-Ref": "missing", "content-length": String(MAX_MEETING_REQUEST_BODY_BYTES + 1) }),
    status: 413,
    code: "REQUEST_TOO_LARGE",
  },
  {
    name: "actual oversized body",
    stationAreaId: "fixture-c",
    makeRequest: () => request(DETAILS_URL, "x".repeat(MAX_MEETING_REQUEST_BODY_BYTES + 1), { "Meeet-Calculation-Ref": "missing" }),
    status: 413,
    code: "REQUEST_TOO_LARGE",
  },
  {
    name: "unreadable body",
    stationAreaId: "fixture-c",
    makeRequest: () => new UnreadableRequest(DETAILS_URL, { method: "POST", body: validBody(), headers: { "Meeet-Calculation-Ref": "missing" } }),
    status: 400,
    code: "MALFORMED_JSON",
  },
  {
    name: "malformed JSON body",
    stationAreaId: "fixture-c",
    makeRequest: () => request(DETAILS_URL, "{", { "Meeet-Calculation-Ref": "missing" }),
    status: 400,
    code: "MALFORMED_JSON",
  },
  {
    name: "missing calculation reference",
    stationAreaId: "fixture-c",
    makeRequest: () => request(DETAILS_URL, validBody()),
    status: 400,
    code: "INVALID_CALCULATION_REF",
  },
  {
    name: "blank calculation reference",
    stationAreaId: "fixture-c",
    makeRequest: () => request(DETAILS_URL, validBody(), { "Meeet-Calculation-Ref": " \t" }),
    status: 400,
    code: "INVALID_CALCULATION_REF",
  },
  {
    name: "malformed calculation reference",
    stationAreaId: "fixture-c",
    makeRequest: () => request(DETAILS_URL, validBody(), { "Meeet-Calculation-Ref": "not a reference" }),
    status: 400,
    code: "INVALID_CALCULATION_REF",
  },
  {
    name: "unknown calculation reference",
    stationAreaId: "fixture-c",
    makeRequest: () => request(DETAILS_URL, validBody(), { "Meeet-Calculation-Ref": "missing" }),
    status: 410,
    code: "CALCULATION_REF_EXPIRED",
  },
  {
    name: "invalid station area input",
    stationAreaId: " ",
    makeRequest: () => request(DETAILS_URL, validBody()),
    status: 400,
    code: "INVALID_REQUEST",
  },
  {
    name: "missing station area input",
    stationAreaId: undefined as unknown as string,
    makeRequest: () => request(DETAILS_URL, validBody()),
    status: 400,
    code: "INVALID_REQUEST",
  },
];

test("station-area details rejects invalid inputs before provider or admission work", async () => {
  for (const testCase of detailInputCases) {
    const admission = new CountingAdmission();
    let factoryCalls = 0;
    const post = createStationAreaDetailsPost({
      admission,
      createProviders: () => {
        factoryCalls += 1;
        return PROVIDERS;
      },
    });
    const response = await post(testCase.makeRequest(), { params: Promise.resolve({ stationAreaId: testCase.stationAreaId }) });
    assert.equal(response.status, testCase.status, testCase.name);
    assert.equal((await response.json()).error.code, testCase.code, testCase.name);
    assert.equal(factoryCalls, 0, `${testCase.name}: provider factory must not run`);
    assert.equal(admission.calls, 0, `${testCase.name}: admission must not run`);
  }
});

test("station-area details rejects an unknown nonblank station area before provider or admission work", async () => {
  const cache = new InMemoryStationAreaCalculationBasisCache({ referenceFactory: () => "admission-details-reference" });
  const calculated = await handleMeetingPost(request(CALCULATE_URL, validBody()), PROVIDERS, {
    basisCache: cache,
    admission: new ScheduledCalculationAdmission(),
  });
  assert.equal(calculated.status, 200);
  const reference = calculated.headers.get("Meeet-Calculation-Ref");
  assert.equal(reference, "admission-details-reference");

  const admission = new CountingAdmission();
  let factoryCalls = 0;
  const post = createStationAreaDetailsPost({
    admission,
    basisCache: cache,
    createProviders: () => {
      factoryCalls += 1;
      return PROVIDERS;
    },
  });
  const response = await post(
    request(DETAILS_URL, validBody(), { "Meeet-Calculation-Ref": reference! }),
    { params: Promise.resolve({ stationAreaId: "unknown-station-area" }) },
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "STATION_AREA_NOT_FOUND");
  assert.equal(factoryCalls, 0);
  assert.equal(admission.calls, 0);
});

test("all public adapters sanitize provider configuration failures", async () => {
  const fail = () => {
    throw new ProviderConfigurationError("secret internal configuration detail");
  };

  const calculateAdmission = new CountingAdmission();
  const calculate = await createMeetingCalculatePost({ createProviders: fail, admission: calculateAdmission })(request(CALCULATE_URL, validBody()));
  const streamAdmission = new CountingAdmission();
  const stream = await createMeetingStreamPost({ createProviders: fail, admission: streamAdmission })(request(STREAM_URL, validBody()));

  const cache = new InMemoryStationAreaCalculationBasisCache({ referenceFactory: () => "configuration-ref" });
  const calculation = await handleMeetingPost(request(CALCULATE_URL, validBody()), PROVIDERS, { basisCache: cache, admission: new ScheduledCalculationAdmission() });
  assert.equal(calculation.status, 200);
  const detailsAdmission = new CountingAdmission();
  const details = await createStationAreaDetailsPost({ createProviders: fail, basisCache: cache, admission: detailsAdmission })(request(DETAILS_URL, validBody(), { "Meeet-Calculation-Ref": "configuration-ref" }), { params: Promise.resolve({ stationAreaId: "fixture-c" }) });

  for (const response of [calculate, stream, details]) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("content-type"), "application/json");
    const body = await response.json();
    assert.deepEqual(body, {
      error: {
        code: "PROVIDER_CONFIGURATION_INVALID",
        message: "Server provider configuration is invalid.",
      },
    });
    assert.equal(JSON.stringify(body).includes("secret internal"), false);
  }
  for (const admission of [calculateAdmission, streamAdmission, detailsAdmission]) {
    const release = admission.tryAcquire();
    assert.ok(release, "provider configuration failure must release admission");
    release();
  }
});

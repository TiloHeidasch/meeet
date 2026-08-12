import assert from "node:assert/strict";
import test from "node:test";

import {
  isWithinOfficialMunichBoundary,
  OFFICIAL_MUNICH_BOUNDARY,
  OFFICIAL_MUNICH_BOUNDARY_MANIFEST,
} from "../lib/domain/boundary.ts";
import { handleMeetingPost } from "../lib/domain/meeting-api.ts";
import { fixtureProviders } from "../lib/fixtures/providers.ts";

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

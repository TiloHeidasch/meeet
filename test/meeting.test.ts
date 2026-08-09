import assert from "node:assert/strict";
import test from "node:test";

import {
  isWithinOfficialMunichBoundary,
  OFFICIAL_MUNICH_BOUNDARY,
  OFFICIAL_MUNICH_BOUNDARY_MANIFEST,
} from "../lib/domain/boundary.ts";
import { validateMeetingCalculationResponse } from "../lib/domain/response.ts";

test("the official Munich application boundary remains a 25-district asset", () => {
  assert.equal(OFFICIAL_MUNICH_BOUNDARY.type, "FeatureCollection");
  assert.equal(OFFICIAL_MUNICH_BOUNDARY.features.length, 25);
  assert.equal(OFFICIAL_MUNICH_BOUNDARY_MANIFEST.districtCount, 25);
  assert.equal(OFFICIAL_MUNICH_BOUNDARY_MANIFEST.legalBoundary, false);
  assert.equal(isWithinOfficialMunichBoundary({ latitude: 48.1374, longitude: 11.5755 }), true);
  assert.equal(isWithinOfficialMunichBoundary({ latitude: 52.52, longitude: 13.405 }), false);
});

test("the v2 response validator rejects legacy area and POI fields", () => {
  const result = validateMeetingCalculationResponse({
    contractVersion: "meeet-meeting/v2",
    status: "ok",
    requestSnapshot: {},
    fairLocations: [],
    routePatterns: [],
    metadata: {},
    corridor: {},
  });
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.issues.some((item) => item.code === "unknown_field" && item.path[0] === "corridor"));
});

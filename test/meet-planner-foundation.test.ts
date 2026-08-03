import assert from "node:assert/strict";
import test from "node:test";

import { canSubmitMeetingCalculation, getPlannerUiState, mapParticipantSource } from "../components/MeetPlanner.tsx";
import { canStartRouteFirstJob, routeFirstStatusLabel } from "../components/RouteFirstOverview.tsx";
import { routeFirstLineData, routeFirstLineFeatureId, routeFirstPointData, routeFirstPointFeatureId } from "../components/route-first-map-data.ts";

test("configured self-hosted foundation keeps calculation unavailable and controls non-operable", () => {
  const state = getPlannerUiState({
    mode: "self-hosted-routing",
    supportedModes: ["transit", "bike", "car"],
    routingFoundation: {
      state: "configured-foundation",
      calculationAvailable: false,
      reason: "calculation-not-migrated",
    },
  });

  assert.equal(state.calculationUnavailable, true);
  assert.equal(state.canCalculate, false);
  assert.equal(state.controlsDisabled, true);
  assert.equal(state.showModeSelector, false);
  assert.match(state.unavailableMessage, /meeting calculation requests are unavailable/);
  assert.match(state.unavailableMessage, /will not be sent/);
  assert.match(state.unavailableMessage, /Location search remains available/);

  // Exercise the same guard used at the submit/calculate boundary, rather than
  // only checking the labels and disabled presentation.
  assert.equal(canSubmitMeetingCalculation(state, "idle"), false);
  assert.equal(canSubmitMeetingCalculation(state, "error"), false);
  assert.equal(canSubmitMeetingCalculation(state, "loading"), false);

  const availableState = getPlannerUiState({ mode: "fixture", supportedModes: ["transit", "bike", "car"] });
  assert.equal(canSubmitMeetingCalculation(availableState, "idle"), true);
  assert.equal(canSubmitMeetingCalculation(availableState, "loading"), false);
});

test("route-first UI stays gated while polling remains explicitly cancellable", () => {
  assert.equal(canStartRouteFirstJob(false, "idle"), false);
  assert.equal(canStartRouteFirstJob(true, "idle"), true);
  assert.equal(canStartRouteFirstJob(true, "polling"), false);
  assert.equal(routeFirstStatusLabel("unavailable"), "Route-first is unavailable");
  assert.equal(routeFirstStatusLabel("incomplete"), "Route-first result is incomplete");
});

test("map source helpers refresh only certified adapter geometry", () => {
  const evidence = {
    lines: [{ source: "corridor", journeyId: "journey-a", geometry: { type: "LineString", coordinates: [[11.5, 48.1], [11.6, 48.2]] } }],
    points: [{ source: "midpoint", journeyId: "journey-a", geometry: { type: "Point", coordinates: [11.55, 48.15] } }],
  } as never;
  assert.deepEqual(routeFirstLineData(evidence).features[0]?.geometry.coordinates, [[11.5, 48.1], [11.6, 48.2]]);
  assert.equal(routeFirstLineData(null).features.length, 0);
  assert.deepEqual(routeFirstPointData(evidence).features[0]?.geometry.coordinates, [11.55, 48.15]);
  assert.equal(routeFirstPointData(null).features.length, 0);
  const repeatedLines = [
    { source: "fair-region", componentId: "component-a", edgeId: "edge-a", interval: { start: "0", end: "1/2" }, geometry: { type: "LineString", coordinates: [[11.5, 48.1], [11.6, 48.2]] } },
    { source: "fair-region", componentId: "component-a", edgeId: "edge-a", interval: { start: "1/2", end: "1" }, geometry: { type: "LineString", coordinates: [[11.6, 48.2], [11.7, 48.3]] } },
  ] as never;
  assert.notEqual(routeFirstLineFeatureId(repeatedLines[0], 0), routeFirstLineFeatureId(repeatedLines[1], 1));
  const repeatedPoint = { source: "fair-region-point", edgeId: "edge-a", geometry: { type: "Point", coordinates: [11.5, 48.1] } } as never;
  assert.notEqual(routeFirstPointFeatureId(repeatedPoint, 0), routeFirstPointFeatureId(repeatedPoint, 1));
  assert.deepEqual(mapParticipantSource(true, ["legacy"], ["current"]), ["current"]);
  assert.deepEqual(mapParticipantSource(false, ["legacy"], ["current"]), ["legacy"]);
});

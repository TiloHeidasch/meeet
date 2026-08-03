import { expect, test, type Page } from "@playwright/test";

const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const OPENFREEMAP_ORIGIN = "https://tiles.openfreemap.org";
const OFFLINE_MAP_STYLE = {
  version: 8,
  sprite: `${OPENFREEMAP_ORIGIN}/sprites/liberty`,
  sources: { planet: { type: "vector", url: `${OPENFREEMAP_ORIGIN}/planet.json` } },
  layers: [{ id: "offline-background", type: "background" }, { id: "offline-land", type: "fill", source: "planet", "source-layer": "landcover", paint: { "fill-color": "#ffffff" } }, { id: "offline-symbol", type: "symbol", source: "planet", "source-layer": "landcover", layout: { "icon-image": "fixture-icon" } }],
};
const OFFLINE_EMPTY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const SAMPLE_GRID = /Sample-grid approximation only/;
type ResponseRecord = { status: number; url: string };

const SEARCH_LOCATIONS = {
  Marienplatz: { label: "Marienplatz", latitude: 48.1374, longitude: 11.5755 },
  Ostbahnhof: { label: "Ostbahnhof", latitude: 48.1257, longitude: 11.605 },
  Odeonsplatz: { label: "Odeonsplatz", latitude: 48.1428, longitude: 11.5772 },
  Gärtnerplatz: { label: "Gärtnerplatz", latitude: 48.1316, longitude: 11.5754 },
  "Old place": { label: "Old place", latitude: 48.1374, longitude: 11.5755 },
  "New place": { label: "New place", latitude: 48.1257, longitude: 11.605 },
} as const;

type SearchLocation = (typeof SEARCH_LOCATIONS)[keyof typeof SEARCH_LOCATIONS];

async function openPlanner(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A fair place to meet." })).toBeVisible();
  const map = page.getByRole("region", { name: "Munich meeting area map" });
  await expect(map).toBeVisible();
  await expect(map.getByRole("button", { name: "Zoom in" })).toBeVisible();
}

async function mockLocationSearch(page: Page) {
  await page.route("**/api/locations/search**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q") ?? "";
    const location = SEARCH_LOCATIONS[query as keyof typeof SEARCH_LOCATIONS] ?? {
      label: query,
      latitude: SEARCH_LOCATIONS.Marienplatz.latitude,
      longitude: SEARCH_LOCATIONS.Marienplatz.longitude,
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ locations: [location] }),
    });
  });
}

async function selectLocation(
  page: Page,
  participantIndex: number,
  query: string,
  location: SearchLocation,
  viaKeyboard = false,
) {
  const combobox = page.getByRole("combobox", { name: "Munich starting point" }).nth(participantIndex);
  await combobox.fill(query);
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  if (viaKeyboard) {
    await combobox.press("ArrowDown");
    await expect(combobox).toHaveAttribute("aria-activedescendant", /location-result-/);
    await combobox.press("Enter");
  } else {
    await listbox.getByRole("button", { name: location.label, exact: true }).click();
  }
  await expect(combobox).toHaveValue(location.label);
}

async function selectDefaultLocations(page: Page, viaKeyboard = false) {
  await selectLocation(page, 0, "Marienplatz", SEARCH_LOCATIONS.Marienplatz, viaKeyboard);
  await selectLocation(page, 1, "Ostbahnhof", SEARCH_LOCATIONS.Ostbahnhof);
}

async function submitMeeting(page: Page) {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith("/api/meeting/calculate") &&
      candidate.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Find meeting area" }).click();
  return response;
}

function directRouteCandidateResponse() {
  const retrievedAt = "2026-07-25T08:00:00.000Z";
  const fixtureGeocoding = {
    name: "local-demo-fixture-geocoding",
    deployment: "fixture",
    dataKind: "demo-static",
    liveData: false,
    asOf: "e2e-fixture-v1",
    notes: "Local deterministic fixture geocoding.",
    provenance: {
      role: "geocoding",
      provider: "local-demo-fixture-geocoding",
      deployment: "fixture",
      dataKind: "demo-static",
      liveData: false,
      sourceUrl: null,
      license: null,
      attribution: "Local deterministic fixture geocoding.",
      version: "e2e-fixture-v1",
      retrievedAt: "fixture-static",
      notes: "Local deterministic fixture geocoding.",
      feeds: null,
    },
  };
  const fixturePoi = {
    name: "demo-static-poi-entries",
    deployment: "fixture",
    dataKind: "demo-static",
    liveData: false,
    asOf: "e2e-fixture-v1",
    notes: "Local deterministic fixture POIs.",
    provenance: {
      role: "poi",
      provider: "demo-static-poi-entries",
      deployment: "fixture",
      dataKind: "demo-static",
      liveData: false,
      sourceUrl: null,
      license: null,
      attribution: "Local deterministic fixture POIs.",
      version: "e2e-fixture-v1",
      retrievedAt: "fixture-static",
      notes: "Local deterministic fixture POIs.",
      feeds: null,
    },
  };
  const directRouting = {
    name: "mvg-direct-routing",
    deployment: "unknown",
    dataKind: "scheduled",
    liveData: false,
    asOf: "bgw-pt/v3",
    notes: "Unofficial MVG BGW PT v3 endpoint with no SLA; realtime is used when supplied on the final route part, invalid realtime fields ignored, and planned timestamps used as the fallback. Transit-only; coordinates snap within 1500 m with 75 m/min access and egress. Meeting searches use finite bidirectional alternatives, explicit Munich hub candidates, and at most 10 candidate centers in one matrix.",
    provenance: {
      role: "routing",
      provider: "mvg-direct-routing",
      deployment: "unknown",
      dataKind: "scheduled",
      liveData: false,
      sourceUrl: "https://www.mvg.de/api/bgw-pt/v3",
      license: null,
      attribution: "MVG BGW PT v3 routing; realtime is used when supplied on the final route part, invalid realtime fields ignored, and planned timestamps used as the fallback; unofficial endpoint, no SLA.",
      version: "bgw-pt/v3",
      retrievedAt,
      notes: "Unofficial MVG BGW PT v3 endpoint with no SLA; realtime is used when supplied on the final route part, invalid realtime fields ignored, and planned timestamps used as the fallback. Transit-only; coordinates snap within 1500 m with 75 m/min access and egress. Meeting searches use finite bidirectional alternatives, explicit Munich hub candidates, and at most 10 candidate centers in one matrix.",
      feeds: null,
    },
  };
  const routeTravelTimes = [
    { participantId: "participant-1", mode: "transit", minutes: 10, source: "mvg-direct-routing" },
    { participantId: "participant-2", mode: "transit", minutes: 10, source: "mvg-direct-routing" },
  ];
  const routeRange = {
    targetMinutes: 10,
    lowerMinutes: 9,
    upperMinutes: 11,
    observedMinMinutes: 10,
    observedMaxMinutes: 10,
    tolerancePercent: 10,
    isComparable: true,
  };
  const candidate = {
    id: "munich-hub:sendlinger-tor",
    kind: "fixed-hub",
    label: "Sendlinger Tor",
    coordinate: { latitude: 48.13333, longitude: 11.56667 },
    travelTimeRange: routeRange,
    travelTimes: routeTravelTimes,
    normalizedSpread: 0,
    maxTravelMinutes: 10,
  };
  const otherCandidate = {
    id: "route-station:midpoint",
    kind: "route-part-endpoint",
    label: "Midpoint station",
    coordinate: { latitude: 48.14, longitude: 11.57 },
    travelTimeRange: {
      targetMinutes: 11.5,
      lowerMinutes: 10.35,
      upperMinutes: 12.65,
      observedMinMinutes: 11,
      observedMaxMinutes: 12,
      tolerancePercent: 10,
      isComparable: true,
    },
    travelTimes: [
      { participantId: "participant-1", mode: "transit", minutes: 11, source: "mvg-direct-routing" },
      { participantId: "participant-2", mode: "transit", minutes: 12, source: "mvg-direct-routing" },
    ],
    normalizedSpread: 1 / 11.5,
    maxTravelMinutes: 12,
  };
  return {
    status: "ok",
    meetingPoint: candidate.coordinate,
    corridor: {
      type: "Feature",
      properties: {
        kind: "route-candidate-search-area",
        approximation: "route-candidate-search",
        verification: "candidate-centers-routed",
        tolerancePercent: 10,
        cellCount: 2,
        candidateCount: 2,
        bufferRadiusMeters: 350,
        boundaryName: "OFFICIAL_MUNICH_STADTBEZIRKE_APPLICATION_COLLECTION",
        geometryGuarantee: "Only candidate centers were routed; the 350m buffer interiors and POIs are not independently routed or proven comparable.",
      },
      geometry: {
        type: "MultiPolygon",
        coordinates: [[[
          [11.56, 48.13],
          [11.57, 48.13],
          [11.57, 48.14],
          [11.56, 48.14],
          [11.56, 48.13],
        ]]],
      },
    },
    travelTimeRange: routeRange,
    travelTimes: routeTravelTimes,
    pois: [{
      id: "venue-sendlinger",
      name: "Nearby venue",
      category: "food",
      coordinates: [11.5667, 48.1333],
      address: "Sendlinger Straße, München",
      source: "demo-static-poi-entries",
    }],
    candidates: [candidate, otherCandidate],
    requestSnapshot: {
      participants: [
        {
          id: "participant-1",
          location: { label: "Marienplatz", latitude: 48.1374, longitude: 11.5755 },
          mode: "transit",
        },
        {
          id: "participant-2",
          location: { label: "Ostbahnhof", latitude: 48.1257, longitude: 11.605 },
          mode: "transit",
        },
      ],
      tolerancePercent: 10,
      departureAt: retrievedAt,
      timeZone: "Europe/Berlin",
    },
    metadata: {
      source: {
        deployment: "unknown",
        dataKind: "scheduled",
        liveData: false,
        label: "Unofficial MVG routing with candidate centers + fixture coordinate resolution/static POIs",
      },
      approximation: "Route-candidate approximation only: returned candidate centers were routed for every participant and passed the median ± tolerance rule; the 350m POI buffers are clipped to the official Munich application boundary but their interiors are not independently routed or proven comparable.",
      providers: {
        geocoding: fixtureGeocoding,
        routing: directRouting,
        poi: fixturePoi,
      },
      boundary: {
        name: "OFFICIAL_MUNICH_STADTBEZIRKE_APPLICATION_COLLECTION",
        sourceUrl: "https://geoportal.muenchen.de/geoserver/gsm_wfs/ows?service=WFS",
        metadataUrl: "https://geoportal.muenchen.de/geoserver/gsm_wfs/ows?service=WFS&request=GetCapabilities",
        retrievedAt: "2026-07-26T07:59:12.816Z",
        contentHash: "53a161d53254979ba302d205757d18d72e6907d59d920f223066d28dc1c8b01b",
        metadataContentHash: "95b5f2b510794b4329a767dc1ed4b02c1ae2681dcb501cc48b0dd0fa7317db0d",
        districtCount: 25,
        license: { name: "DL-DE-BY-2.0", url: "https://www.govdata.de/dl-de/by-2-0" },
        attribution: "Landeshauptstadt München / GeodatenService München — Stadtbezirke",
        legalBoundary: false,
      },
      provenance: {
        boundary: {
          name: "OFFICIAL_MUNICH_STADTBEZIRKE_APPLICATION_COLLECTION",
          sourceUrl: "https://geoportal.muenchen.de/geoserver/gsm_wfs/ows?service=WFS",
          metadataUrl: "https://geoportal.muenchen.de/geoserver/gsm_wfs/ows?service=WFS&request=GetCapabilities",
          retrievedAt: "2026-07-26T07:59:12.816Z",
          contentHash: "53a161d53254979ba302d205757d18d72e6907d59d920f223066d28dc1c8b01b",
          metadataContentHash: "95b5f2b510794b4329a767dc1ed4b02c1ae2681dcb501cc48b0dd0fa7317db0d",
          districtCount: 25,
          license: { name: "DL-DE-BY-2.0", url: "https://www.govdata.de/dl-de/by-2-0" },
          attribution: "Landeshauptstadt München / GeodatenService München — Stadtbezirke",
          legalBoundary: false,
        },
        routing: directRouting.provenance,
        geocoding: fixtureGeocoding.provenance,
        poi: fixturePoi.provenance,
        map: { source: "client-configured", styleUrl: null, attribution: null },
      },
    },
  };
}

function directRouteNoCorridorResponse() {
  const response = directRouteCandidateResponse();
  return {
    status: "no-corridor" as const,
    reason: {
      code: "NO_COMPARABLE_ROUTE_CANDIDATE" as const,
      message: "No returned MVG route candidate or explicit Munich hub had all participants within the selected median ± tolerance window.",
    },
    requestSnapshot: response.requestSnapshot,
    metadata: response.metadata,
  };
}

test.describe("deterministic UI", () => {
test.beforeEach(async ({ page }) => {
  await page.route(`${DEFAULT_MAP_STYLE_URL}**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(OFFLINE_MAP_STYLE),
    }),
  );
  await page.route(`${OPENFREEMAP_ORIGIN}/planet.json**`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tilejson: "3.0.0", tiles: [`${OPENFREEMAP_ORIGIN}/planet/{z}/{x}/{y}.pbf`], minzoom: 0, maxzoom: 14 }) }));
  await page.route(`${OPENFREEMAP_ORIGIN}/sprites/liberty.json`, (route) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "{}" }));
  await page.route(`${OPENFREEMAP_ORIGIN}/sprites/liberty.png`, (route) => route.fulfill({ status: 200, contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: OFFLINE_EMPTY_PNG }));
  await page.route(`${OPENFREEMAP_ORIGIN}/planet/**/*.pbf**`, (route) => route.fulfill({ status: 200, contentType: "application/x-protobuf", body: Buffer.alloc(0) }));
  await mockLocationSearch(page);
});

test("default participants reach the local fixture result with provenance", async ({ page }) => {
  await openPlanner(page);
  await selectDefaultLocations(page);

  const response = await submitMeeting(page);
  expect(response.status()).toBe(200);
  await expect(page.getByText("Meeting area ready", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Local demo estimates · static demo venues", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No MVG/MVV timetable or realtime data is used.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Submitted request", { exact: true })).toBeVisible();
  await expect(page.getByText(SAMPLE_GRID)).toBeVisible();
});

test("route-candidate results present verified candidate centers and a limited candidate-area caveat", async ({ page }) => {
  await openPlanner(page);
  await selectDefaultLocations(page);
  await page.route("**/api/meeting/calculate", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(directRouteCandidateResponse()),
    }),
  );

  const response = await submitMeeting(page);
  expect(response.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Verified candidate centers" })).toBeVisible();
  await expect(page.getByText("Routed verified candidate centers", { exact: true })).toBeVisible();
  await expect(page.getByText("2 candidate centers passed the selected ±10% travel-time check.", { exact: true })).toBeVisible();
  await expect(page.getByText("Best candidate center: Sendlinger Tor", { exact: true })).toBeVisible();
  await expect(page.getByText("Sendlinger Tor · selected", { exact: true })).toBeVisible();
  await expect(page.getByText("Midpoint station", { exact: true })).toBeVisible();
  await expect(page.getByText("The map shows limited nearby-venue search buffers around these centers, not equal-time-proven areas.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Route-candidate approximation only: returned candidate centers were routed/)).toBeVisible();
  await expect(page.getByLabel("Interactive Munich map showing participants, routed candidate centers, and limited nearby-venue search buffers")).toBeVisible();
});

test("no-corridor route-candidate results announce no comparable meeting area on the map", async ({ page }) => {
  await openPlanner(page);
  await selectDefaultLocations(page);
  await page.route("**/api/meeting/calculate", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(directRouteNoCorridorResponse()),
    }),
  );

  const response = await submitMeeting(page);
  expect(response.status()).toBe(200);
  await expect(page.getByText("No comparable meeting area", { exact: true })).toBeVisible();
  const map = page.getByRole("region", { name: "Munich meeting area map" });
  await expect(map.getByLabel("Interactive Munich map showing participant starting points; no comparable meeting area was found")).toBeVisible();
  await expect(map.getByLabel("Interactive Munich map showing participant starting points; calculate a meeting area to see results")).toHaveCount(0);
});

test("missing map style override uses the default map and leaves controls usable", async ({ page }) => {
  await openPlanner(page);

  await expect(page.getByLabel("Munich starting point").first()).toBeEnabled();
  await expect(page.getByRole("radio", { name: /±5%/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Find meeting area" })).toBeEnabled();

  await selectDefaultLocations(page);
  await submitMeeting(page);
  await expect(page.getByText("Meeting area ready", { exact: true })).toBeVisible();
  const map = page.getByRole("region", { name: "Munich meeting area map" });
  await expect(map).toBeVisible();
  await expect(map.getByRole("button", { name: "Zoom in" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Add participant/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Find meeting area" })).toBeEnabled();
});

test("adding a participant and changing tolerance stales results before Update recalculates", async ({ page }) => {
  await openPlanner(page);
  await selectDefaultLocations(page);
  await submitMeeting(page);
  await expect(page.getByText("Meeting area ready", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Add participant/ }).click();
  await expect(page.getByText("Previous response — inputs changed.", { exact: true })).toBeVisible();
  await selectLocation(page, 2, "Gärtnerplatz", SEARCH_LOCATIONS.Gärtnerplatz);
  await page.getByRole("radio", { name: "Car" }).nth(2).focus();
  await page.keyboard.press("Space");
  await page.getByRole("radio", { name: /±15%/ }).focus();
  await page.keyboard.press("Space");

  await expect(page.getByText("Previous response — inputs changed.", { exact: true })).toBeVisible();
  const updateResponse = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith("/api/meeting/calculate") &&
      candidate.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Update", exact: true }).click();
  expect((await updateResponse).status()).toBe(200);
  await expect(page.getByText("Previous response — inputs changed.", { exact: true })).toHaveCount(0);
  const submittedRequest = page.getByText("Submitted request", { exact: true }).locator("..");
  await expect(submittedRequest).toBeVisible();
  await expect(submittedRequest).toContainText("±15%");
});

test("native travel-mode and tolerance radios respond to keyboard input", async ({ page }) => {
  await openPlanner(page);

  const firstTransit = page.getByRole("radio", { name: "Public transport" }).first();
  const firstBike = page.getByRole("radio", { name: "Bike" }).first();
  await firstTransit.focus();
  await page.keyboard.press("ArrowRight");
  await expect(firstBike).toBeChecked();

  const toleranceTen = page.getByRole("radio", { name: /±10%/ });
  const toleranceFifteen = page.getByRole("radio", { name: /±15%/ });
  await toleranceTen.focus();
  await page.keyboard.press("ArrowRight");
  await expect(toleranceFifteen).toBeChecked();
});

test("comboboxes support keyboard selection and safe Enter after results are cleared", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await openPlanner(page);

  const first = page.getByRole("combobox", { name: "Munich starting point" }).first();
  await first.fill("Marienplatz");
  const listbox = page.getByRole("listbox");
  await expect(listbox.getByRole("button", { name: "Marienplatz", exact: true })).toBeVisible();
  await first.press("ArrowDown");
  await first.fill("Odeonsplatz");
  await first.press("Enter");
  await expect(first).toHaveValue("Odeonsplatz");
  await expect(page.getByRole("listbox").getByRole("button", { name: "Odeonsplatz", exact: true })).toBeVisible();
  await page.getByRole("listbox").getByRole("button", { name: "Odeonsplatz", exact: true }).click();
  await selectLocation(page, 1, "Ostbahnhof", SEARCH_LOCATIONS.Ostbahnhof, true);
  await expect(pageErrors).toEqual([]);
});

test("a delayed old location lookup cannot repopulate results after replacement", async ({ page }) => {
  await page.unroute("**/api/locations/search**");
  let releaseOldResponse!: () => void;
  const oldResponseReleased = new Promise<void>((resolve) => {
    releaseOldResponse = resolve;
  });
  let finishOldLookup!: () => void;
  const oldLookupFinished = new Promise<void>((resolve) => {
    finishOldLookup = resolve;
  });
  await page.route("**/api/locations/search**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    if (query === "Old place") {
      await oldResponseReleased;
    }
    const location = SEARCH_LOCATIONS[query as keyof typeof SEARCH_LOCATIONS] ?? {
      label: query,
      latitude: SEARCH_LOCATIONS.Marienplatz.latitude,
      longitude: SEARCH_LOCATIONS.Marienplatz.longitude,
    };
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ locations: [location] }),
      });
    } catch {
      // The browser may abort the intentionally delayed request.
    } finally {
      if (query === "Old place") finishOldLookup();
    }
  });
  await openPlanner(page);

  const first = page.getByRole("combobox", { name: "Munich starting point" }).first();
  const searching = page.getByText("Searching Munich…", { exact: true });
  await first.fill("Marienplatz");
  await expect(page.getByRole("listbox").getByRole("button", { name: "Marienplatz", exact: true })).toBeVisible();
  await first.press("ArrowDown");
  await expect(first).toHaveAttribute("aria-activedescendant", /location-result-/);

  const oldRequest = page.waitForRequest((request) =>
    new URL(request.url()).searchParams.get("q") === "Old place",
  );
  await first.fill("Old place");
  await oldRequest;
  await expect(searching).toBeVisible();

  await first.fill("");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(first).not.toHaveAttribute("aria-activedescendant", /location-result-/);
  await expect(searching).toHaveCount(0);

  await first.fill("New place");
  await expect(page.getByRole("listbox").getByRole("button", { name: "New place", exact: true })).toBeVisible();
  releaseOldResponse();
  await oldLookupFinished;
  await expect(page.getByRole("listbox").getByRole("button", { name: "New place", exact: true })).toBeVisible();
  await expect(page.getByRole("listbox").getByRole("button", { name: "Old place", exact: true })).toHaveCount(0);
  await expect(searching).toHaveCount(0);
});

test("provider error response is announced while meeting controls remain available", async ({ page }) => {
  await openPlanner(page);
  await selectDefaultLocations(page);
  await page.route("**/api/meeting/calculate", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "PROVIDER_UNAVAILABLE",
          message: "A required meeting-data provider is currently unavailable.",
        },
      }),
    }),
  );

  await page.getByRole("button", { name: "Find meeting area" }).click();
  await expect(page.locator('[aria-live="polite"]')).toHaveText(
    "A required meeting-data provider is currently unavailable.",
  );
  await expect(page.getByLabel("Munich starting point").first()).toBeEnabled();
  await expect(page.getByRole("radio", { name: "Public transport" }).first()).toBeEnabled();
  await expect(page.getByRole("radio", { name: /±10%/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: /Add participant/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Find meeting area" })).toBeEnabled();
});

test("fixture mode hands off transit defaults without calling MVG", async ({ page }) => {
  let submitted: {
    participants?: Array<{
      mode?: string;
      location?: { label?: string; latitude?: number; longitude?: number };
    }>;
  } | undefined;
  await page.route("**/api/meeting/calculate", async (route) => {
    submitted = route.request().postDataJSON() as typeof submitted;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "Intercepted for a network-free UI check." } }),
    });
  });

  await page.goto("/");
  await expect(page.locator('[aria-live="polite"]')).toContainText("Local demo only: static venues, no MVG/MVV timetable or realtime data.");
  await expect(page.getByRole("radio", { name: "Public transport" })).toHaveCount(2);
  await selectDefaultLocations(page);
  await page.getByRole("button", { name: "Find meeting area" }).click();
  await expect(page.locator('[aria-live="polite"]')).toHaveText(
    "Intercepted for a network-free UI check.",
  );
  expect(submitted?.participants?.map((participant) => participant.mode)).toEqual([
    "transit",
    "bike",
  ]);
  expect(submitted?.participants?.map((participant) => participant.location?.label)).toEqual([
    "Marienplatz",
    "Ostbahnhof",
  ]);
  expect(submitted?.participants?.every((participant) =>
    typeof participant.location?.latitude === "number" &&
    typeof participant.location?.longitude === "number",
  )).toBe(true);
});

test("offline map style dependencies load without making the map unavailable", async ({ page }) => {
  const responses = new Map<string, ResponseRecord[]>();
  page.on("response", (response) => {
    const url = new URL(response.url());
    const path = url.pathname.toLowerCase();
    const kind = path === "/vendor/maplibre-gl/maplibre-gl-worker.mjs"
      ? "worker"
      : path === "/vendor/maplibre-gl/maplibre-gl-shared.mjs"
        ? "worker-shared"
        : url.origin !== OPENFREEMAP_ORIGIN
          ? undefined
          : path === "/styles/liberty"
            ? "style"
            : /(?:^|\/)planet(?:\.json)?$/.test(path)
              ? "tilejson"
              : /\/sprites\/[^/]+(?:@\dx)?\.json$/.test(path)
                ? "sprite-json"
                : /\/sprites\/[^/]+(?:@\dx)?\.png$/.test(path)
                  ? "sprite-png"
                  : /\/planet\/.+\.pbf$/.test(path)
                    ? "vector-tile"
                    : undefined;
    if (kind) responses.set(kind, [...(responses.get(kind) ?? []), { status: response.status(), url: response.url() }]);
  });

  await openPlanner(page);
  const map = page.getByRole("region", { name: "Munich meeting area map" });
  await expect(map).toHaveAttribute("data-map-state", "ready");
  const canvas = map.locator("canvas.maplibregl-canvas");
  await expect(canvas).toBeVisible();
  await expect(page.getByText("Map unavailable", { exact: true })).toHaveCount(0);

  // Exercise the sprite fixtures explicitly so this gate never depends on
  // whether a particular empty offline tile happens to request an icon.
  await page.evaluate(async (origin) => {
    await fetch(`${origin}/sprites/liberty.json`, { mode: "no-cors" });
    await fetch(`${origin}/sprites/liberty.png`, { mode: "no-cors" });
  }, OPENFREEMAP_ORIGIN);

  const canvasMatchesContainer = () => canvas.evaluate((element) => {
    const canvasElement = element as HTMLCanvasElement;
    const container = element.closest(".maplibregl-map");
    if (!container) return false;
    const canvasRect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const devicePixelRatio = window.devicePixelRatio || 1;
    const cssTolerance = 1;
    const backingTolerance = Math.max(2, Math.ceil(devicePixelRatio));
    return containerRect.width > 0 && containerRect.height > 0
      && Math.abs(canvasRect.width - containerRect.width) <= cssTolerance
      && Math.abs(canvasRect.height - containerRect.height) <= cssTolerance
      && Math.abs(canvasElement.width - Math.round(containerRect.width * devicePixelRatio)) <= backingTolerance
      && Math.abs(canvasElement.height - Math.round(containerRect.height * devicePixelRatio)) <= backingTolerance;
  });
  await expect.poll(canvasMatchesContainer, { message: "MapLibre canvas did not settle to its container size" }).toBe(true);

  const dimensions = await canvas.evaluate((element) => {
    const canvasElement = element as HTMLCanvasElement;
    const container = element.closest(".maplibregl-map");
    if (!container) throw new Error("MapLibre canvas has no container");
    const canvasRect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return {
      canvasCssWidth: canvasRect.width,
      canvasCssHeight: canvasRect.height,
      containerCssWidth: containerRect.width,
      containerCssHeight: containerRect.height,
      canvasBackingWidth: canvasElement.width,
      canvasBackingHeight: canvasElement.height,
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  });
  expect(Math.abs(dimensions.canvasCssWidth - dimensions.containerCssWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(dimensions.canvasCssHeight - dimensions.containerCssHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(dimensions.canvasBackingWidth - Math.round(dimensions.containerCssWidth * dimensions.devicePixelRatio)))
    .toBeLessThanOrEqual(Math.max(2, Math.ceil(dimensions.devicePixelRatio)));
  expect(Math.abs(dimensions.canvasBackingHeight - Math.round(dimensions.containerCssHeight * dimensions.devicePixelRatio)))
    .toBeLessThanOrEqual(Math.max(2, Math.ceil(dimensions.devicePixelRatio)));

  const localOrigin = new URL(page.url()).origin;
  const requiredResponses = [
    ["worker", localOrigin],
    ["worker-shared", localOrigin],
    ["style", OPENFREEMAP_ORIGIN],
    ["tilejson", OPENFREEMAP_ORIGIN],
    ["sprite-json", OPENFREEMAP_ORIGIN],
    ["sprite-png", OPENFREEMAP_ORIGIN],
    ["vector-tile", OPENFREEMAP_ORIGIN],
  ] as const;
  await expect.poll(
    () => requiredResponses.filter(([kind]) => !responses.get(kind)?.length).map(([kind]) => kind),
    { timeout: 15000, message: "required MapLibre/OpenFreeMap responses were not observed" },
  ).toEqual([]);
  for (const [kind, origin] of requiredResponses) {
    const records = responses.get(kind) ?? [];
    expect(records.every((record) => record.status === 200), `${kind} response status`).toBe(true);
    expect(records.every((record) => new URL(record.url).origin === origin), `${kind} response origin`).toBe(true);
  }
});
});

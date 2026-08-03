import { expect, test, type Page, type Response, type Route } from "@playwright/test";
import {
  assertRouteFirstClientJobEnvelope,
  type RouteFirstClientJobEnvelope,
  type RouteFirstClientJobStatus,
} from "@/lib/domain/route-first/client-contract";
import {
  routeFirstFixtureEnvelope,
} from "./route-first-fixtures";

const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const SEARCH_LOCATIONS = {
  Marienplatz: { label: "Marienplatz", latitude: 48.1374, longitude: 11.5755 },
  Ostbahnhof: { label: "Ostbahnhof", latitude: 48.1257, longitude: 11.605 },
  "New place": { label: "New place", latitude: 48.1428, longitude: 11.5772 },
  Odeonsplatz: { label: "Odeonsplatz", latitude: 48.14, longitude: 11.57 },
  Gärtnerplatz: { label: "Gärtnerplatz", latitude: 48.1316, longitude: 11.5754 },
} as const;

type SearchLocation = (typeof SEARCH_LOCATIONS)[keyof typeof SEARCH_LOCATIONS];

function assertValidEnvelope(value: unknown): RouteFirstClientJobEnvelope {
  return assertRouteFirstClientJobEnvelope(value);
}

async function fulfillEnvelope(route: Route, envelope: RouteFirstClientJobEnvelope) {
  assertValidEnvelope(envelope);
  await route.fulfill({
    status: envelope.status === "queued" ? 202 : 200,
    contentType: "application/json",
    body: JSON.stringify(envelope),
  });
}

async function installRouteFirstFixture(page: Page, statuses: readonly RouteFirstClientJobStatus[]) {
  let getCount = 0;
  let postCount = 0;
  await page.route("**/api/route-first/meetings", async (route) => {
    postCount += 1;
    await fulfillEnvelope(route, routeFirstFixtureEnvelope("queued"));
  });
  await page.route("**/api/route-first/meetings/*", async (route) => {
    const status = statuses[Math.min(getCount, statuses.length - 1)];
    getCount += 1;
    if (!status) throw new Error("The route-first fixture has no status for this poll.");
    await fulfillEnvelope(route, routeFirstFixtureEnvelope(status));
  });
  return {
    getCount: () => getCount,
    postCount: () => postCount,
  };
}

async function mockLocationSearch(page: Page) {
  await page.route("**/api/locations/search**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q") ?? "";
    const location: SearchLocation = SEARCH_LOCATIONS[query as keyof typeof SEARCH_LOCATIONS] ?? {
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

async function openPlanner(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A fair place to meet." })).toBeVisible();
  const map = page.getByRole("region", { name: "Munich meeting area map" });
  await expect(map).toBeVisible();
  await expect(map.getByRole("button", { name: "Zoom in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check route evidence" })).toBeVisible();
}

async function selectLocation(
  page: Page,
  participantIndex: number,
  query: string,
  location: SearchLocation,
) {
  const combobox = page.getByRole("combobox", { name: "Munich starting point" }).nth(participantIndex);
  await combobox.fill(query);
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  await listbox.getByRole("button", { name: location.label, exact: true }).click();
  await expect(combobox).toHaveValue(location.label);
}

async function selectDefaultLocations(page: Page) {
  await selectLocation(page, 0, "Marienplatz", SEARCH_LOCATIONS.Marienplatz);
  await selectLocation(page, 1, "Ostbahnhof", SEARCH_LOCATIONS.Ostbahnhof);
}

function routeFirstResponse(response: Response): boolean {
  const url = new URL(response.url());
  return url.pathname.startsWith("/api/route-first/meetings/");
}

async function responseEnvelope(response: Response): Promise<RouteFirstClientJobEnvelope> {
  return assertValidEnvelope(await response.json());
}

async function startRouteFirst(page: Page): Promise<RouteFirstClientJobEnvelope> {
  const postResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/route-first/meetings" && response.request().method() === "POST";
  });
  await page.getByRole("button", { name: "Check route evidence" }).click();
  return responseEnvelope(await postResponse);
}

async function assertNoLegacyOrProviderRequests(page: Page, requestUrls: readonly string[], allowedMeetingCalculations = 0) {
  const baseOrigin = new URL(page.url()).origin;
  const legacyRequests = requestUrls.filter((requestUrl) => {
    const pathname = new URL(requestUrl).pathname;
    return pathname === "/api/meeting/calculate" || pathname === "/api/meeting/venue-routes";
  });
  expect(legacyRequests.filter((requestUrl) => new URL(requestUrl).pathname === "/api/meeting/calculate")).toHaveLength(allowedMeetingCalculations);
  expect(legacyRequests.filter((requestUrl) => new URL(requestUrl).pathname === "/api/meeting/venue-routes")).toEqual([]);

  const externalProviderRequests = requestUrls.filter((requestUrl) => {
    const url = new URL(requestUrl);
    return url.origin !== baseOrigin && /(mvg|mvv|poi|routing|graphhopper|otp|geocod)/i.test(requestUrl);
  });
  expect(externalProviderRequests).toEqual([]);
}

function legacyMapLabel(page: Page) {
  return page.getByLabel(/Interactive Munich map showing participants, (sample-grid meeting cells, and food and drink venues|routed candidate centers, and limited nearby-venue search buffers)/);
}

test.describe("route-first browser lane", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      process.env.MEEET_PROVIDER_MODE === "mvg-direct-transit",
      "route-first browser evidence uses the established fixture test configuration",
    );
    await page.route(DEFAULT_MAP_STYLE_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ version: 8, sources: {}, layers: [] }),
      }),
    );
    await mockLocationSearch(page);
  });

  test("default route-first API stays non-durable and unavailable without touching legacy or provider paths", async ({ page }) => {
    const requestUrls: string[] = [];
    page.on("request", (request) => requestUrls.push(request.url()));

    await openPlanner(page);
    await selectDefaultLocations(page);
    const initial = await startRouteFirst(page);
    expect(initial.jobId).toBeTruthy();
    expect(initial.durable).toBe(false);
    expect(initial.runtimePersistence).toBe("in-memory-process");
    expect(initial.activation).toBe("blocked-until-durable-provider");

    let terminal = initial;
    while (!["complete", "incomplete", "unavailable", "no-eligible-target", "failed", "expired"].includes(terminal.status)) {
      terminal = await responseEnvelope(await page.waitForResponse((response) => response.request().method() === "GET" && routeFirstResponse(response)));
    }
    expect(terminal.status).toBe("unavailable");
    expect(terminal.durable).toBe(false);
    expect(terminal.activation).toBe("blocked-until-durable-provider");
    expect(terminal.result?.status).toBe("unavailable");
    await expect(page.getByRole("region", { name: "Routes before landmarks." }).locator("p").filter({ hasText: "Route-first is unavailable" })).toBeVisible();
    await expect(page.getByText("The configured route-first provider is not activated. No external route request was made by this UI.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("route-first-complete")).toHaveCount(0);
    await expect(page.getByText("Certified route evidence", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Interactive Munich map showing participant starting points; calculate a meeting area to see results")).toBeVisible();
    await assertNoLegacyOrProviderRequests(page, requestUrls);
  });

  test("queued, running, and complete synthetic jobs select keyboard-operable family evidence without legacy layers", async ({ page }) => {
    const requestUrls: string[] = [];
    page.on("request", (request) => requestUrls.push(request.url()));
    await installRouteFirstFixture(page, ["running", "complete"]);
    await openPlanner(page);
    await selectDefaultLocations(page);
    const initial = await startRouteFirst(page);
    expect(initial.status).toBe("queued");
    await expect(page.getByText("Checking route evidence…", { exact: true })).toBeVisible();
    await expect(page.getByTestId("route-first-complete")).toBeVisible();
    await expect(page.getByText("Certified route evidence", { exact: true })).toBeVisible();
    await expect(page.getByText("Each participant has a validated journey. The corridor is directional and the fair region is bound to this same snapshot.", { exact: true })).toBeVisible();
    await expect(page.getByText("primary alternative · transit", { exact: true })).toBeVisible();
    await expect(page.getByText("Certified alternatives are shown separately. An ambiguity envelope is not drawn.", { exact: true })).toBeVisible();
    await expect(page.getByText("The map shows only certified WGS84 geometry returned by the adapter for this selected family. Alternate routes are dashed; no envelope or omitted landmark is drawn.", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Interactive Munich map showing participant origins, selected-family certified routes, exact directional corridors, fair-region segments, and certified midpoint evidence")).toBeVisible();
    await expect(page.getByText("Routes to your venue", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Nearby venue", { exact: true })).toHaveCount(0);
    await expect(legacyMapLabel(page)).toHaveCount(0);

    const familyTwo = page.getByRole("radio", { name: /Family 2/ });
    await familyTwo.focus();
    await page.keyboard.press("Space");
    await expect(familyTwo).toBeChecked();
    await expect(page.getByText("primary alternative · walk → transit", { exact: true })).toBeVisible();
    await expect(page.getByText("primary alternative · transit", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Family evidence: browser-family-2-context", { exact: true })).toBeVisible();
    await expect(page.getByText("Family evidence: browser-family-1-context", { exact: true })).toHaveCount(0);
    await assertNoLegacyOrProviderRequests(page, requestUrls);
  });

  test("stopping route-first polling clears evidence and stops subsequent status requests", async ({ page }) => {
    const requestUrls: string[] = [];
    page.on("request", (request) => requestUrls.push(request.url()));
    const fixture = await installRouteFirstFixture(page, ["running"]);
    await openPlanner(page);
    await selectDefaultLocations(page);
    await startRouteFirst(page);
    await expect(page.getByText("Checking route evidence…", { exact: true })).toBeVisible();
    await expect.poll(() => fixture.getCount()).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Stop", exact: true }).focus();
    await page.keyboard.press("Enter");
    const countAfterStop = fixture.getCount();
    await expect(page.getByRole("region", { name: "Routes before landmarks." }).locator("p").filter({ hasText: "Route-first polling stopped" })).toBeVisible();
    await expect(page.getByText("Polling stopped. The non-durable job was not promoted to a meeting result.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("route-first-complete")).toHaveCount(0);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(fixture.getCount()).toBe(countAfterStop);
    await expect(page.getByLabel("Interactive Munich map showing participant starting points; calculate a meeting area to see results")).toBeVisible();
    await assertNoLegacyOrProviderRequests(page, requestUrls);
  });

  test("terminal failures and input replacement clear complete evidence and restore the legacy map", async ({ page }) => {
    const requestUrls: string[] = [];
    page.on("request", (request) => requestUrls.push(request.url()));
    const terminalStatuses = ["incomplete", "failed", "expired", "no-eligible-target"] as const;
    await installRouteFirstFixture(page, ["complete", ...terminalStatuses]);
    await openPlanner(page);
    await selectDefaultLocations(page);

    await page.getByRole("button", { name: "Find meeting area" }).click();
    await expect(page.getByText("Meeting area ready", { exact: true })).toBeVisible();
    await expect(legacyMapLabel(page)).toBeVisible();

    await startRouteFirst(page);
    await expect(page.getByTestId("route-first-complete")).toBeVisible();
    await expect(page.getByLabel("Interactive Munich map showing participant origins, selected-family certified routes, exact directional corridors, fair-region segments, and certified midpoint evidence")).toBeVisible();

    const replacementLocations = [
      SEARCH_LOCATIONS["New place"],
      SEARCH_LOCATIONS.Odeonsplatz,
      SEARCH_LOCATIONS["Gärtnerplatz"],
      SEARCH_LOCATIONS.Marienplatz,
    ];
    for (const [index, status] of terminalStatuses.entries()) {
      const location = replacementLocations[index]!;
      const first = page.getByRole("combobox", { name: "Munich starting point" }).first();
      await first.fill(location.label);
      await expect(page.getByRole("listbox")).toBeVisible();
      await page.getByRole("listbox").getByRole("button", { name: location.label, exact: true }).click();
      await expect(page.getByText("Previous response — inputs changed.", { exact: true })).toBeVisible();
      await expect(page.getByTestId("route-first-complete")).toHaveCount(0);
      await expect(page.getByText("Certified route evidence", { exact: true })).toHaveCount(0);
      await expect(legacyMapLabel(page)).toBeVisible();

      await startRouteFirst(page);
      if (status === "incomplete") {
        await expect(page.getByText("Evidence is incomplete for participant-1; no route corridor or landmark result is shown.", { exact: true })).toBeVisible();
      } else if (status === "failed") {
        await expect(page.getByText("The route-first check failed safely (service-error).", { exact: true })).toBeVisible();
      } else if (status === "expired") {
        await expect(page.getByRole("region", { name: "Routes before landmarks." }).locator("p").filter({ hasText: "Route-first is unavailable" })).toBeVisible();
      } else {
        await expect(page.getByText("No target passed the certified eligibility checks. No landmark is implied.", { exact: true })).toBeVisible();
      }
      await expect(page.getByTestId("route-first-complete")).toHaveCount(0);
      await expect(page.getByLabel("Interactive Munich map showing participant starting points; calculate a meeting area to see results")).toHaveCount(0);
      await expect(legacyMapLabel(page)).toBeVisible();
    }
    await assertNoLegacyOrProviderRequests(page, requestUrls, 1);
  });

  test("input replacement unmounts the old route-first poll so stale polling cannot continue", async ({ page }) => {
    const requestUrls: string[] = [];
    page.on("request", (request) => requestUrls.push(request.url()));
    const fixture = await installRouteFirstFixture(page, ["running"]);
    await openPlanner(page);
    await selectDefaultLocations(page);
    await startRouteFirst(page);
    await expect(page.getByText("Checking route evidence…", { exact: true })).toBeVisible();
    await expect.poll(() => fixture.getCount()).toBeGreaterThan(0);

    const first = page.getByRole("combobox", { name: "Munich starting point" }).first();
    await first.fill("New place");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.getByRole("listbox").getByRole("button", { name: "New place", exact: true }).click();
    await expect(page.getByText("Route-first meeting evidence", { exact: true })).toHaveCount(0);
    const countAfterReplacement = fixture.getCount();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(fixture.getCount()).toBe(countAfterReplacement);
    await expect(page.getByTestId("route-first-complete")).toHaveCount(0);
    await assertNoLegacyOrProviderRequests(page, requestUrls);
  });
});

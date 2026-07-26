import { expect, test, type Page } from "@playwright/test";

const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const OPENFREEMAP_ORIGIN = "https://tiles.openfreemap.org";
const SAMPLE_GRID = /Sample-grid approximation only/;
type ResponseRecord = { status: number; url: string };

async function openPlanner(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A fair place to meet." })).toBeVisible();
  const map = page.getByRole("region", { name: "Munich meeting area map" });
  await expect(map).toBeVisible();
  await expect(map.getByRole("button", { name: "Zoom in" })).toBeVisible();
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

test.describe("deterministic UI", () => {
test.beforeEach(async ({ page }) => {
  await page.route(DEFAULT_MAP_STYLE_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ version: 8, sources: {}, layers: [] }),
    }),
  );
});

test("default participants reach the local fixture result with provenance", async ({ page }) => {
  await openPlanner(page);

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

test("missing map style override uses the default map and leaves controls usable", async ({ page }) => {
  await openPlanner(page);

  await expect(page.getByLabel("Munich starting point").first()).toBeEnabled();
  await expect(page.getByRole("radio", { name: /±5%/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Find meeting area" })).toBeEnabled();

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
  await submitMeeting(page);
  await expect(page.getByText("Meeting area ready", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Add participant/ }).click();
  await expect(page.getByText("Previous response — inputs changed.", { exact: true })).toBeVisible();
  await page.getByLabel("Munich starting point").nth(2).selectOption({ label: "Gärtnerplatz" });
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

test("provider error response is announced while meeting controls remain available", async ({ page }) => {
  await openPlanner(page);
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

test("direct mode hands off transit-only defaults without calling MVG", async ({ page }) => {
  test.skip(
    process.env.MEEET_PROVIDER_MODE !== "mvg-direct-transit",
    "requires the browser server to be started in direct mode",
  );

  let submitted: { participants?: Array<{ mode?: string }> } | undefined;
  await page.route("**/api/meeting/calculate", async (route) => {
    submitted = route.request().postDataJSON() as typeof submitted;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "Intercepted for a network-free UI check." } }),
    });
  });

  await page.goto("/");
  await expect(page.getByText("MVG direct · public transport only", { exact: true })).toBeVisible();
  await expect(page.locator('[aria-live="polite"]')).toHaveText(
    "Scheduled MVG public transport · static demo venues · realtime ignored.",
  );
  await expect(page.getByRole("radio", { name: "Public transport" })).toHaveCount(2);
  await expect(page.getByRole("radio", { name: "Bike" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Car" })).toHaveCount(0);
  await page.getByRole("button", { name: "Find meeting area" }).click();
  await expect(page.locator('[aria-live="polite"]')).toHaveText(
    "Intercepted for a network-free UI check.",
  );
  expect(submitted?.participants?.map((participant) => participant.mode)).toEqual([
    "transit",
    "transit",
  ]);
});
});

test("live OpenFreeMap style dependencies load without making the map unavailable", async ({ page }) => {
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

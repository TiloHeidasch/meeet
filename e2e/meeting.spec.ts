import { expect, test, type Page } from "@playwright/test";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const MAP_ORIGIN = "https://tiles.openfreemap.org";
const LOCATIONS = {
  Marienplatz: { label: "Marienplatz", latitude: 48.1374, longitude: 11.5755 },
  Ostbahnhof: { label: "Ostbahnhof", latitude: 48.1257, longitude: 11.605 },
} as const;
const EMPTY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function v2Fixture(request: { arrivalAt: string; participants: Array<{ id: string; location: { label: string; latitude: number; longitude: number } }>; tolerancePercent: number }) {
  const arrival = Date.parse(request.arrivalAt);
  const departure = new Date(arrival - 600_000).toISOString();
  const point = { latitude: 48.1374, longitude: 11.5755 };
  const endpoint = (coordinate: { latitude: number; longitude: number }, stationGlobalId: string | null, label?: string) => ({ stationGlobalId, coordinate, ...(label ? { label } : {}) });
  const part = (participant: typeof request.participants[number]) => ({ kind: "transit", from: endpoint({ latitude: participant.location.latitude, longitude: participant.location.longitude }, `origin-${participant.id}`, participant.location.label), to: endpoint(point, "fair-stop", "Fixture stop"), intermediateStops: [], line: { identity: "fixture-line", type: "BUS" }, plannedDepartureAt: departure, plannedArrivalAt: request.arrivalAt });
  const routePatterns = request.participants.map((participant, index) => ({ id: `fixture-pattern-${index + 1}`, kind: "transit", transitStops: [endpoint({ latitude: participant.location.latitude, longitude: participant.location.longitude }, `origin-${participant.id}`, participant.location.label), endpoint(point, "fair-stop", "Fixture stop")], lines: [{ identity: "fixture-line", type: "BUS" }], parts: [part(participant)], provenance: [{ direction: index === 0 ? "participant-1-to-participant-2" : "participant-2-to-participant-1", searchKind: "direct", anchorStationGlobalId: null }] }));
  const journeys = request.participants.map((participant) => ({ participantId: participant.id, mode: "transit", plannedDepartureAt: departure, plannedArrivalAt: request.arrivalAt, plannedDurationMilliseconds: 600_000, source: "local-test-fixture" }));
  const boundaryLicense = { name: "DL-DE-BY-2.0", url: "https://www.govdata.de/dl-de/by-2-0" };
  const boundary = { name: "fixture-munich-boundary", sourceUrl: "https://example.test/boundary", metadataUrl: "https://example.test/boundary-metadata", retrievedAt: request.arrivalAt, contentHash: "0".repeat(64), metadataContentHash: "1".repeat(64), districtCount: 25, license: boundaryLicense, attribution: "Local test boundary", legalBoundary: false };
  const provenance = { role: "routing", provider: "local-test-fixture", deployment: "fixture", dataKind: "demo-static", liveData: false, sourceUrl: null, license: null, attribution: "Local test data; not MVG.", version: "fixture-v2", retrievedAt: request.arrivalAt, notes: "Browser fixture only; not MVG.", feeds: null };
  const anchors = ["de:09162:6", "de:09162:50", "de:09162:70", "de:09162:1170", "de:09162:190", "de:09162:350"];
  const sourceQueries = Array.from({ length: 14 }, (_, index) => ({ direction: index < 7 ? "participant-1-to-participant-2" : "participant-2-to-participant-1", searchKind: index % 7 === 0 ? "direct" : "anchor", originParticipantId: index < 7 ? "participant-1" : "participant-2", destinationParticipantId: index < 7 ? "participant-2" : "participant-1", anchorStationGlobalId: index % 7 === 0 ? null : anchors[(index % 7) - 1], viaDwellTimeInMinutes: index % 7 === 0 ? null : 10, arrivalAt: request.arrivalAt, journeyCount: 1, source: "local-test-fixture" }));
  return { contractVersion: "meeet-meeting/v2", status: "ok", requestSnapshot: { participants: request.participants.map((participant) => ({ ...participant, mode: "transit" })), arrivalAt: request.arrivalAt, selectedTolerancePercent: request.tolerancePercent, effectiveTolerancePercent: request.tolerancePercent === 5 ? 10 : request.tolerancePercent, timeZone: "Europe/Berlin" }, fairLocations: [{ id: "fair-stop", label: "Fixture station", kind: "station", physicalIdentity: "fair-stop", coordinate: point, journeys, differenceMilliseconds: 0, selectedTolerancePercent: request.tolerancePercent, effectiveTolerancePercent: request.tolerancePercent === 5 ? 10 : request.tolerancePercent, sourceRoutePatternIds: routePatterns.map((pattern) => pattern.id) }], routePatterns, sourceQueries, metadata: { routing: { name: "local-test-fixture", deployment: "fixture", dataKind: "demo-static", liveData: false, asOf: request.arrivalAt, notes: "Browser fixture only; not MVG.", provenance }, boundary, provenance: { routing: provenance, boundary } } };
}

async function setup(page: Page) {
  await page.route(MAP_STYLE, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: 8, sprite: `${MAP_ORIGIN}/sprites/liberty`, sources: {}, layers: [{ id: "background", type: "background" }] }) }));
  await page.route(`${MAP_ORIGIN}/sprites/liberty.json`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route(`${MAP_ORIGIN}/sprites/liberty.png`, (route) => route.fulfill({ status: 200, contentType: "image/png", body: EMPTY_PNG }));
  await page.route("**/api/locations/search**", async (route) => { const query = new URL(route.request().url()).searchParams.get("q") ?? ""; const location = LOCATIONS[query as keyof typeof LOCATIONS] ?? { label: query, latitude: 48.1374, longitude: 11.5755 }; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ locations: [location] }) }); });
  await page.route("**/api/meeting/calculate", async (route) => { const request = route.request().postDataJSON() as Parameters<typeof v2Fixture>[0]; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(v2Fixture(request)) }); });
}
async function selectOrigin(page: Page, index: number, name: keyof typeof LOCATIONS) { const input = page.getByRole("combobox", { name: "Munich starting point" }).nth(index); await input.fill(name); await page.getByRole("listbox").getByRole("button", { name, exact: true }).click(); await expect(input).toHaveValue(name); }
async function openPlanner(page: Page) { await page.goto("/"); await expect(page.getByRole("heading", { name: "A fair place to meet." })).toBeVisible(); await expect(page.getByRole("combobox", { name: "Munich starting point" })).toHaveCount(2); await expect(page.getByRole("region", { name: "Interactive Munich map showing two Munich participant origins" })).toBeVisible(); }

test.describe("canonical v2 meeting search", () => {
  test.beforeEach(async ({ page }) => { await setup(page); });

  test("renders exactly two transit origins and no legacy controls", async ({ page }) => {
    await openPlanner(page);
    await expect(page.locator("span").filter({ hasText: "Participant 1 origin" }).first()).toBeVisible();
    await expect(page.locator("span").filter({ hasText: "Participant 2 origin" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Add participant|Remove participant|Check route evidence/ })).toHaveCount(0);
    await expect(page.getByRole("radio", { name: /Public transport|Bike|Car/ })).toHaveCount(0);
    await expect(page.getByLabel("Arrival time")).toBeVisible();
    await expect(page.getByText("Public transport only · Local test/demo data · not MVG", { exact: true })).toBeVisible();
    await expect(page.getByText("Public transport only · MVG journeys", { exact: true })).toHaveCount(0);
  });

  test("submits arrivalAt and shows every verified location with effective tolerance", async ({ page }) => {
    await openPlanner(page);
    await selectOrigin(page, 0, "Marienplatz");
    await selectOrigin(page, 1, "Ostbahnhof");
    await expect(page.locator(".meeet-origin-marker")).toHaveCount(2);
    await page.getByLabel("Arrival time").fill("2026-08-09T18:30");
    await page.getByRole("radio", { name: /±5%/ }).check({ force: true });
    const request = page.waitForRequest((item) => item.url().endsWith("/api/meeting/calculate"));
    await page.getByRole("button", { name: "Find fair locations" }).click();
    const body = (await request).postDataJSON();
    expect(body.participants).toHaveLength(2);
    expect(body.participants.every((item: { mode: string }) => item.mode === "transit")).toBe(true);
    expect(typeof body.arrivalAt).toBe("string");
    expect(body.arrivalAt).toBe("2026-08-09T16:30:00.000Z");
    expect(body.tolerancePercent).toBe(5);
    await expect(page.getByText("Fair locations found", { exact: true })).toBeVisible();
    await expect(page.getByText(/effective/, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/verified location/)).toBeVisible();
    await expect(page.getByText(/Participant 1/).last()).toBeVisible();
    await expect(page.getByText(/Participant 2/).last()).toBeVisible();
    await expect(page.getByText(/Difference/).first()).toBeVisible();
    await expect(page.getByText("Source routes", { exact: false })).toHaveCount(0);
    await expect(page.getByText("corridor", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Nearby venue", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Inspect routes" }).click();
    await expect(page.getByText(/Stops: .*Fixture stop/, { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Local test/demo route pattern · not MVG", { exact: true }).first()).toBeVisible();
    await page.getByText("Sources & attribution", { exact: true }).click();
    await expect(page.getByText(/local-test-fixture.*Local test data; not MVG/, { exact: false })).toBeVisible();
    await expect(page.getByText("MVG public-transport journeys", { exact: true })).toHaveCount(0);
  });

  test("marker selection focuses its matching accessible card", async ({ page }) => {
    await openPlanner(page);
    await selectOrigin(page, 0, "Marienplatz");
    await selectOrigin(page, 1, "Ostbahnhof");
    await page.getByRole("button", { name: "Find fair locations" }).click();
    await expect(page.locator("article[id^='fair-location-']").first()).toBeVisible();
    const firstCard = page.locator("article[id^='fair-location-']").first();
    const id = await firstCard.getAttribute("id");
    expect(id).toBeTruthy();
    const marker = page.getByRole("button", { name: /Fair location 1:/ });
    await expect(marker).toBeVisible();
    await marker.evaluate((button) => (button as HTMLButtonElement).click());
    await expect(firstCard).toHaveClass(/border-\[#a64e39\]/);
  });

  test("input changes make the previous result stale", async ({ page }) => {
    await openPlanner(page);
    await selectOrigin(page, 0, "Marienplatz");
    await selectOrigin(page, 1, "Ostbahnhof");
    await page.getByRole("button", { name: "Find fair locations" }).click();
    await expect(page.getByText("Fair locations found", { exact: true })).toBeVisible();
    await page.getByLabel("Arrival time").fill("2099-01-01T10:00");
    await expect(page.getByText("Inputs changed. Update the fair locations.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Fair location 1:/ })).toHaveCount(0);
    await expect(page.locator("article[id^='fair-location-']")).toHaveCount(0);
  });

  test("origin markers are draggable and update the origin label", async ({ page }) => {
    await openPlanner(page);
    await selectOrigin(page, 0, "Marienplatz");
    await selectOrigin(page, 1, "Ostbahnhof");
    const marker = page.locator(".meeet-origin-marker").first();
    const box = await marker.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2 + 18);
    await page.mouse.up();
    await expect(page.getByRole("combobox", { name: "Munich starting point" }).first()).toHaveValue(/Pinned location/);
  });

  test("rejects a nonexistent Berlin daylight-saving arrival time", async ({ page }) => {
    await openPlanner(page);
    await selectOrigin(page, 0, "Marienplatz");
    await selectOrigin(page, 1, "Ostbahnhof");
    await page.getByLabel("Arrival time").fill("2026-03-29T02:30");
    await page.getByRole("button", { name: "Find fair locations" }).click();
    await expect(page.getByText(/Berlin arrival time does not exist/, { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: /Fair location/ })).toHaveCount(0);
  });
});

test("configured gateway capability is visibly unavailable", async ({ page }) => {
  test.skip(process.env.MEEET_PROVIDER_MODE !== "configured", "Run with MEEET_PROVIDER_MODE=configured for capability coverage");
  await setup(page);
  await page.goto("/");
  await expect(page.getByText("Meeting search unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText(/Only the MVG direct canonical provider can calculate/, { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Find fair locations" })).toBeDisabled();
});

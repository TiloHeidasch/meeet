import { expect, test, type Page } from "@playwright/test";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const MAP_ORIGIN = "https://tiles.openfreemap.org";
const LOCATIONS = {
  Marienplatz: { label: "Marienplatz", latitude: 48.1374, longitude: 11.5755 },
  Ostbahnhof: { label: "Ostbahnhof", latitude: 48.1257, longitude: 11.605 },
} as const;
const EMPTY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function v2Fixture(request: { arrivalAt: string; participants: Array<{ id: string; location: { label: string; latitude: number; longitude: number } }>; tolerancePercent: number }, noResult = false) {
  const arrival = Date.parse(request.arrivalAt);
  const points = [{ stationGlobalId: "fair-alpha", label: "Alpha station", coordinate: { latitude: 48.1374, longitude: 11.5755 } }, { stationGlobalId: "fair-zeta", label: "Zeta station", coordinate: { latitude: 48.136, longitude: 11.59 } }];
  const endpoint = (coordinate: { latitude: number; longitude: number }, stationGlobalId: string | null, label?: string) => ({ stationGlobalId, coordinate, ...(label ? { label } : {}) });
  const discoveryStops = [endpoint({ latitude: request.participants[0]!.location.latitude, longitude: request.participants[0]!.location.longitude }, "origin-participant-1", "Marienplatz"), ...points.map((point) => endpoint(point.coordinate, point.stationGlobalId, point.label)), endpoint({ latitude: request.participants[1]!.location.latitude, longitude: request.participants[1]!.location.longitude }, "origin-participant-2", "Ostbahnhof")];
  const routePatterns = noResult ? [] : [{ id: "fixture-origin-to-origin", kind: "transit", transitStops: discoveryStops, lines: [{ identity: "discovery-line", type: "BUS" }], parts: [{ kind: "transit", from: discoveryStops[0]!, to: discoveryStops[discoveryStops.length - 1]!, intermediateStops: discoveryStops.slice(1, -1), line: { identity: "discovery-line", type: "BUS" }, plannedDepartureAt: new Date(arrival - 1_200_000).toISOString(), plannedArrivalAt: request.arrivalAt }], provenance: [{ direction: "participant-1-to-participant-2", searchKind: "direct", anchorStationGlobalId: null }] }];
  const journey = (participant: typeof request.participants[number], point: typeof points[number], duration: number, line: string, leg: string) => { const origin = endpoint({ latitude: participant.location.latitude, longitude: participant.location.longitude }, `origin-${participant.id}`, participant.location.label); const destination = endpoint(point.coordinate, point.stationGlobalId, point.label); const departure = new Date(arrival - duration).toISOString(); const access = endpoint(origin.coordinate, `walk-${participant.id}`, `${leg} access`); return { participantId: participant.id, mode: "transit", plannedDepartureAt: departure, plannedArrivalAt: request.arrivalAt, plannedDurationMilliseconds: duration, source: "local-test-fixture", origin, destination, parts: [{ kind: "walking", from: origin, to: access, intermediateStops: [], line: null, plannedDepartureAt: departure, plannedArrivalAt: new Date(Date.parse(departure) + 120_000).toISOString() }, { kind: "transit", from: access, to: destination, intermediateStops: [endpoint(point.coordinate, `${point.stationGlobalId}-mid`, `${leg} interchange`)], line: { identity: line, type: "BUS" }, plannedDepartureAt: new Date(Date.parse(departure) + 120_000).toISOString(), plannedArrivalAt: request.arrivalAt }] }; };
  const journeysFor = (point: typeof points[number], durations: [number, number]) => request.participants.map((participant, index) => journey(participant, point, durations[index]!, index === 0 ? "P1 line" : "P2 line", index === 0 ? "Marienplatz" : "Ostbahnhof"));
  const locations = [{ id: "station:fair-alpha", label: "Alpha station", kind: "station", physicalIdentity: "station:fair-alpha", coordinate: points[0]!.coordinate, journeys: journeysFor(points[0]!, [600_000, 660_000]), differenceMilliseconds: 60_000, selectedTolerancePercent: request.tolerancePercent, effectiveTolerancePercent: request.tolerancePercent === 5 ? 10 : request.tolerancePercent, sourceRoutePatternIds: ["fixture-origin-to-origin"] }, { id: "station:fair-zeta", label: "Zeta station", kind: "station", physicalIdentity: "station:fair-zeta", coordinate: points[1]!.coordinate, journeys: journeysFor(points[1]!, [700_000, 760_000]), differenceMilliseconds: 60_000, selectedTolerancePercent: request.tolerancePercent, effectiveTolerancePercent: request.tolerancePercent === 5 ? 10 : request.tolerancePercent, sourceRoutePatternIds: ["fixture-origin-to-origin"] }];
  const boundaryLicense = { name: "DL-DE-BY-2.0", url: "https://www.govdata.de/dl-de/by-2-0" };
  const boundary = { name: "fixture-munich-boundary", sourceUrl: "https://example.test/boundary", metadataUrl: "https://example.test/boundary-metadata", retrievedAt: request.arrivalAt, contentHash: "0".repeat(64), metadataContentHash: "1".repeat(64), districtCount: 25, license: boundaryLicense, attribution: "Local test boundary", legalBoundary: false };
  const provenance = { role: "routing", provider: "local-test-fixture", deployment: "fixture", dataKind: "demo-static", liveData: false, sourceUrl: null, license: null, attribution: "Local test data; not MVG.", version: "fixture-v2", retrievedAt: request.arrivalAt, notes: "Browser fixture only; not MVG.", feeds: null };
  const anchors = ["de:09162:6", "de:09162:50", "de:09162:70", "de:09162:1170", "de:09162:190", "de:09162:350"];
  const sourceQueries = Array.from({ length: 14 }, (_, index) => ({ direction: index < 7 ? "participant-1-to-participant-2" : "participant-2-to-participant-1", searchKind: index % 7 === 0 ? "direct" : "anchor", originParticipantId: index < 7 ? "participant-1" : "participant-2", destinationParticipantId: index < 7 ? "participant-2" : "participant-1", anchorStationGlobalId: index % 7 === 0 ? null : anchors[(index % 7) - 1], viaDwellTimeInMinutes: index % 7 === 0 ? null : 10, arrivalAt: request.arrivalAt, journeyCount: 1, source: "local-test-fixture" }));
  const searchCoverage = { method: "midpoint-directed-local-minimum/v1", exhaustive: false, evaluatedStationOccurrenceCount: noResult ? 0 : 2, discoveredLocalMinimumOccurrenceCount: noResult ? 0 : 2, termination: noResult ? "no-transit-station-targets" : "local-minima-discovered", patterns: routePatterns.map((pattern) => ({ routePatternId: pattern.id, eligibleStationOccurrenceCount: noResult ? 0 : 4, startTransitStopIndex: noResult ? null : 1, evaluatedTransitStopIndexes: noResult ? [] : [1, 2], discoveredLocalMinimumTransitStopIndexes: noResult ? [] : [1, 2], termination: noResult ? "no-transit-station-targets" : "local-minima-discovered" })) } as const;
  return noResult ? { contractVersion: "meeet-meeting/v2", status: "no-result", reason: "no-transit-station-targets", requestSnapshot: { participants: request.participants.map((participant) => ({ ...participant, mode: "transit" })), arrivalAt: request.arrivalAt, selectedTolerancePercent: request.tolerancePercent, effectiveTolerancePercent: request.tolerancePercent, timeZone: "Europe/Berlin" }, fairLocations: [], routePatterns, sourceQueries, metadata: { routing: { name: "local-test-fixture", deployment: "fixture", dataKind: "demo-static", liveData: false, asOf: request.arrivalAt, notes: "Browser fixture only; not MVG.", provenance }, boundary, provenance: { routing: provenance, boundary } }, searchCoverage } : { contractVersion: "meeet-meeting/v2", status: "ok", requestSnapshot: { participants: request.participants.map((participant) => ({ ...participant, mode: "transit" })), arrivalAt: request.arrivalAt, selectedTolerancePercent: request.tolerancePercent, effectiveTolerancePercent: request.tolerancePercent === 5 ? 10 : request.tolerancePercent, timeZone: "Europe/Berlin" }, fairLocations: locations, routePatterns, sourceQueries, metadata: { routing: { name: "local-test-fixture", deployment: "fixture", dataKind: "demo-static", liveData: false, asOf: request.arrivalAt, notes: "Browser fixture only; not MVG.", provenance }, boundary, provenance: { routing: provenance, boundary } }, searchCoverage };
}

async function setup(page: Page, noResult = false) {
  const controls = { delayNextCalculation: false, failNextCalculation: false, nextNoResult: false };
  await page.route(MAP_STYLE, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: 8, sprite: `${MAP_ORIGIN}/sprites/liberty`, sources: {}, layers: [{ id: "background", type: "background" }] }) }));
  await page.route(`${MAP_ORIGIN}/sprites/liberty.json`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route(`${MAP_ORIGIN}/sprites/liberty.png`, (route) => route.fulfill({ status: 200, contentType: "image/png", body: EMPTY_PNG }));
  await page.route("**/api/locations/search**", async (route) => { const query = new URL(route.request().url()).searchParams.get("q") ?? ""; const location = LOCATIONS[query as keyof typeof LOCATIONS] ?? { label: query, latitude: 48.1374, longitude: 11.5755 }; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ locations: [location] }) }); });
  await page.route("**/api/meeting/calculate", async (route) => { const request = route.request().postDataJSON() as Parameters<typeof v2Fixture>[0]; if (controls.delayNextCalculation) { controls.delayNextCalculation = false; await new Promise((resolve) => setTimeout(resolve, 5000)); } if (controls.failNextCalculation) { controls.failNextCalculation = false; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "MVG is temporarily unavailable." } }) }); return; } try { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(v2Fixture(request, noResult || controls.nextNoResult)) }); } catch (error) { console.log("fixture route error", error); await route.abort(); } });
  return controls;
}
async function selectOrigin(page: Page, index: number, name: keyof typeof LOCATIONS) { const input = page.getByRole("combobox", { name: "Munich starting point" }).nth(index); await input.fill(name); await page.getByRole("listbox").getByRole("button", { name, exact: true }).click(); await expect(input).toHaveValue(name); }
async function changeArrival(page: Page) { const current = await page.getByLabel("Arrival time").inputValue(); const [date, clock] = current.split("T"); const [hour, minute] = clock!.split(":").map(Number); await page.getByLabel("Arrival time").fill(`${date}T${String(hour).padStart(2, "0")}:${String((minute! + 1) % 60).padStart(2, "0")}`); }
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
    await expect(page.getByText(/public transport/i).first()).toBeVisible();
    await expect(page.getByText("Public transport only · MVG journeys", { exact: true })).toHaveCount(0);
  });

  test("submits arrivalAt and shows sampled station locations with effective tolerance", async ({ page }) => {
    await openPlanner(page);
    await selectOrigin(page, 0, "Marienplatz");
    await selectOrigin(page, 1, "Ostbahnhof");
    await expect(page.locator(".meeet-origin-marker")).toHaveCount(2);
    const plannedArrival = await page.getByLabel("Arrival time").inputValue();
    await page.getByRole("radio", { name: /±5%/ }).check({ force: true });
    const request = page.waitForRequest((item) => item.url().endsWith("/api/meeting/calculate"));
    await page.getByRole("button", { name: "Find fair locations" }).click();
    const body = (await request).postDataJSON();
    expect(body.participants).toHaveLength(2);
    expect(body.participants.every((item: { mode: string }) => item.mode === "transit")).toBe(true);
    expect(typeof body.arrivalAt).toBe("string");
    expect(Date.parse(body.arrivalAt)).toBe(Date.parse(`${plannedArrival}:00+02:00`));
    expect(body.tolerancePercent).toBe(5);
    await expect(page.getByText("Fair locations found", { exact: true })).toBeVisible();
    await expect(page.getByText(/widened to/, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/Sampled Coverage/).first()).toBeVisible();
    await expect(page.getByText("Sampled Coverage & Route Pattern provenance", { exact: true })).toBeVisible();
    await page.getByText("Sampled Coverage & Route Pattern provenance", { exact: true }).click();
    await expect(page.getByText(/does not prove complete fair-location coverage/)).toBeVisible();
    await expect(page.getByText(/station stops evaluated/)).toBeVisible();
    await expect(page.getByText(/Participant 1/).last()).toBeVisible();
    await expect(page.getByText(/Participant 2/).last()).toBeVisible();
    await expect(page.getByText(/Difference/).first()).toBeVisible();
    await expect(page.getByText("Source routes", { exact: false })).toHaveCount(0);
    await expect(page.getByText("corridor", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Nearby venue", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Inspect destination Journeys" }).first().click();
    await expect(page.getByText("Participant 1 Origin → Alpha station", { exact: true })).toBeVisible();
    await expect(page.getByText("Participant 2 Origin → Alpha station", { exact: true })).toBeVisible();
    await expect(page.getByText("Local test/demo planned Journey · not MVG · Door-to-Door Travel Time", { exact: true })).toHaveCount(2);
    await expect(page.getByText(/Marienplatz access → Alpha station/)).toBeVisible();
    await expect(page.getByText(/Ostbahnhof access → Alpha station/)).toBeVisible();
    await expect(page.getByText(/P1 line/)).toBeVisible();
    await expect(page.getByText(/P2 line/)).toBeVisible();
    expect(await page.locator("section[aria-labelledby^='journey-']").first().getByText(/→/).count()).toBeGreaterThan(1);
    await expect(page.getByText("Show Sampled Coverage & Route Pattern provenance", { exact: true }).first()).toBeVisible();
    await page.getByText("Show Sampled Coverage & Route Pattern provenance", { exact: true }).first().click();
    await expect(page.getByText(/Local test\/demo Route Pattern discovery input.*not MVG or a participant Journey/, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/Marienplatz access → Alpha station/)).toHaveCount(1);
    await expect(page.getByText(/Stops sampled: Marienplatz .*Ostbahnhof/)).toBeVisible();
    await page.getByText("Sources & attribution", { exact: true }).click();
    await expect(page.getByText(/local-test-fixture.*Local test data; not MVG/, { exact: false })).toBeVisible();
    await expect(page.getByText("MVG public-transport journeys", { exact: true })).toHaveCount(0);
  });

  test("resolves a delayed replacement to an explicit no-result without restoring the Route-Derived Fair Location", async ({ page }) => {
    const controls = await setup(page);
    await openPlanner(page);
    await selectOrigin(page, 0, "Marienplatz");
    await selectOrigin(page, 1, "Ostbahnhof");
    await page.getByRole("button", { name: "Find fair locations" }).click();
    await expect(page.locator("article[id^='fair-location-']")).toHaveCount(2);
    await page.locator("article[id^='fair-location-']").first().getByRole("button").first().click();
    await page.getByRole("button", { name: "Inspect destination Journeys" }).first().click();
    await page.getByText("Show Sampled Coverage & Route Pattern provenance", { exact: true }).first().click();
    controls.nextNoResult = true;
    await changeArrival(page);
    controls.delayNextCalculation = true;
    await page.getByRole("button", { name: "Find fair locations" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Finding fair locations" })).toBeVisible();
    await expect(page.getByText("No transit station target found", { exact: true })).toBeVisible();
    await expect(page.getByText(/no in-boundary transit-station target/)).toBeVisible();
    await expect(page.getByText(/did not use an endpoint or origin fallback/)).toBeVisible();
    await page.getByText("Sampled Coverage & Route Pattern provenance", { exact: true }).click();
    await expect(page.getByText(/no transit-station targets/).first()).toBeVisible();
    await expect(page.locator("article[id^='fair-location-']")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Sampled station/ })).toHaveCount(0);
    await expect(page.getByText("Destination Journeys for", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Sampled Coverage & Route Pattern provenance", { exact: true })).toHaveCount(1);
    await expect(page.locator("[aria-label^='Sampled Coverage for']")).toHaveCount(0);
    await expect(page.locator(".meeet-origin-marker")).toHaveCount(2);
  });

  test("resolves a delayed replacement to an operational error without restoring the Route-Derived Fair Location", async ({ page }) => {
    const controls = await setup(page);
    await openPlanner(page);
    await selectOrigin(page, 0, "Marienplatz");
    await selectOrigin(page, 1, "Ostbahnhof");
    await page.getByRole("button", { name: "Find fair locations" }).click();
    await expect(page.locator("article[id^='fair-location-']")).toHaveCount(2);
    await page.locator("article[id^='fair-location-']").first().getByRole("button").first().click();
    await page.getByRole("button", { name: "Inspect destination Journeys" }).first().click();
    await page.getByText("Show Sampled Coverage & Route Pattern provenance", { exact: true }).first().click();
    await changeArrival(page);
    controls.delayNextCalculation = true;
    controls.failNextCalculation = true;
    await page.getByRole("button", { name: "Find fair locations" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Finding fair locations" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "MVG is temporarily unavailable" })).toBeVisible();
    await expect(page.locator("article[id^='fair-location-']")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Sampled station/ })).toHaveCount(0);
    await expect(page.getByText("Destination Journeys for", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Sampled Coverage & Route Pattern provenance", { exact: true })).toHaveCount(0);
    await expect(page.locator(".meeet-origin-marker")).toHaveCount(2);
  });

  test("marker selection focuses its matching accessible card", async ({ page }) => {
    await openPlanner(page);
    await selectOrigin(page, 0, "Marienplatz");
    await selectOrigin(page, 1, "Ostbahnhof");
    await page.getByRole("button", { name: "Find fair locations" }).click();
    await expect(page.locator("article[id^='fair-location-']").first()).toBeVisible();
    await expect(page.locator("article[id^='fair-location-']")).toHaveCount(2);
    const firstCard = page.locator("article[id^='fair-location-']").first();
    const id = await firstCard.getAttribute("id");
    expect(id).toBeTruthy();
    const marker = page.getByRole("button", { name: /Sampled station 1:/ });
    await expect(marker).toBeVisible();
    await marker.evaluate((button) => (button as HTMLButtonElement).click());
    await expect(firstCard).toHaveClass(/border-\[#a64e39\]/);
  });

  test("keeps Route-Derived Fair Location Door-to-Door Travel Time order and marker alignment", async ({ page }) => {
    await openPlanner(page);
    await selectOrigin(page, 0, "Marienplatz");
    await selectOrigin(page, 1, "Ostbahnhof");
    await page.getByRole("button", { name: "Find fair locations" }).click();
    const cards = page.locator("article[id^='fair-location-']");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0).getByText("Alpha station", { exact: true })).toBeVisible();
    await expect(cards.nth(1).getByText("Zeta station", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sampled station 1: station:fair-alpha" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sampled station 2: station:fair-zeta" })).toBeVisible();
    await page.getByRole("button", { name: "Sampled station 2: station:fair-zeta" }).evaluate((button) => (button as HTMLButtonElement).click());
    await expect(cards.nth(1)).toBeFocused();
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

  test("shows an accessible pending state and clears stale results during replacement calculation", async ({ page }) => {
    const controls = await setup(page);
    await openPlanner(page);
    await selectOrigin(page, 0, "Marienplatz");
    await selectOrigin(page, 1, "Ostbahnhof");
    await page.getByRole("button", { name: "Find fair locations" }).click();
    await expect(page.locator("article[id^='fair-location-']")).toHaveCount(2);
    await page.locator("article[id^='fair-location-']").first().getByRole("button").first().click();
    await page.getByRole("button", { name: "Inspect destination Journeys" }).first().click();
    await page.getByText("Show Sampled Coverage & Route Pattern provenance", { exact: true }).first().click();

    const currentArrival = await page.getByLabel("Arrival time").inputValue();
    const [date, clock] = currentArrival.split("T");
    const [hour, minute] = clock!.split(":").map(Number);
    await page.getByLabel("Arrival time").fill(`${date}T${String(hour).padStart(2, "0")}:${String((minute! + 1) % 60).padStart(2, "0")}`);
    // Keep the request in flight long enough to inspect the user-visible pending state.
    controls.delayNextCalculation = true;
    await page.getByRole("button", { name: "Find fair locations" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Finding fair locations" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Calculating…" })).toBeDisabled();
    await expect(page.getByRole("combobox", { name: "Munich starting point" }).nth(0)).toBeDisabled();
    await expect(page.getByRole("combobox", { name: "Munich starting point" }).nth(1)).toBeDisabled();
    await expect(page.getByLabel("Arrival time")).toBeDisabled();
    await expect(page.getByRole("radio")).toHaveCount(3);
    for (const radio of await page.getByRole("radio").all()) await expect(radio).toBeDisabled();
    await expect(page.getByText(/Checking .* for both origins/)).toBeVisible();
    await expect(page.locator("article[id^='fair-location-']")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Fair location 1:/ })).toHaveCount(0);
    await expect(page.locator(".meeet-origin-marker")).toHaveCount(2);
    await expect(page.getByText("Destination Journeys for", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Sampled Coverage & Route Pattern provenance", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Finding fair locations" })).toBeHidden();
    await expect(page.getByText("Fair locations found", { exact: true })).toBeVisible();
  });

  test("retains semantic pending feedback when reduced motion is requested", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const controls = await setup(page);
    await openPlanner(page);
    await selectOrigin(page, 0, "Marienplatz");
    await selectOrigin(page, 1, "Ostbahnhof");
    controls.delayNextCalculation = true;
    await page.getByRole("button", { name: "Find fair locations" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Finding fair locations" })).toBeVisible();
    await expect(page.getByText(/Checking .* for both origins/)).toBeVisible();
    const indicator = page.getByRole("status").filter({ hasText: "Finding fair locations" }).locator('[aria-hidden="true"]');
    await expect(indicator).toBeVisible();
    await expect.poll(async () => page.evaluate(() => getComputedStyle(document.querySelector('[role="status"] [aria-hidden="true"]')!).animationName)).toBe("none");
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
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 60);
    await page.mouse.up();
    await expect(page.getByRole("combobox", { name: "Munich starting point" }).first()).toHaveValue(/Pinned location/);
  });

  test("rejects a nonexistent Berlin daylight-saving arrival time", async ({ page }) => {
    await openPlanner(page);
    await selectOrigin(page, 0, "Marienplatz");
    await selectOrigin(page, 1, "Ostbahnhof");
    await page.getByLabel("Arrival time").fill("2026-03-29T02:30");
    await page.getByRole("button", { name: "Find fair locations" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /Berlin arrival time does not exist/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Fair location/ })).toHaveCount(0);
  });

  test("rejects an arrival outside the Berlin planning window without requesting a calculation", async ({ page }) => {
    await openPlanner(page);
    await selectOrigin(page, 0, "Marienplatz");
    await selectOrigin(page, 1, "Ostbahnhof");
    await page.getByLabel("Arrival time").fill("2099-01-01T10:00");
    const request = page.waitForRequest((item) => item.url().endsWith("/api/meeting/calculate"), { timeout: 1500 }).catch(() => null);
    await page.getByRole("button", { name: "Find fair locations" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /from now through the end of tomorrow in Berlin/ })).toBeVisible();
    expect(await request).toBeNull();
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

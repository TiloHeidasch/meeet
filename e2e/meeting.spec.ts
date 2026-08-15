import { expect, test, type Page } from "@playwright/test";
import { inflateSync } from "node:zlib";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const MAP_ORIGIN = "https://tiles.openfreemap.org";
const EMPTY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const LOCATIONS = { Marienplatz: { label: "Marienplatz", latitude: 48.1374, longitude: 11.5755 }, Ostbahnhof: { label: "Ostbahnhof", latitude: 48.1257, longitude: 11.605 } } as const;
const ring = (west: number, south: number, east: number, north: number) => [[[west, south], [east, south], [east, north], [west, north], [west, south]]] as const;
function pngColorCount(input: Buffer): number {
  let offset = 8; let width = 0; let height = 0; let colorType = 0; let idat = Buffer.alloc(0);
  while (offset < input.length) { const length = input.readUInt32BE(offset); const type = input.toString("ascii", offset + 4, offset + 8); const data = input.subarray(offset + 8, offset + 8 + length); if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]!; } if (type === "IDAT") idat = Buffer.concat([idat, data]); offset += length + 12; }
  const channels = colorType === 6 ? 4 : 3; const stride = width * channels; const raw = inflateSync(idat); const colors = new Set<string>(); let cursor = 0; let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) { const filter = raw[cursor++]!; const row = Buffer.from(raw.subarray(cursor, cursor + stride)); cursor += stride; for (let x = 0; x < stride; x++) { const left = x >= channels ? row[x - channels]! : 0; const up = previous[x]!; const upperLeft = x >= channels ? previous[x - channels]! : 0; if (filter === 1) row[x] = (row[x]! + left) & 255; else if (filter === 2) row[x] = (row[x]! + up) & 255; else if (filter === 3) row[x] = (row[x]! + Math.floor((left + up) / 2)) & 255; else if (filter === 4) { const estimate = left + up - upperLeft; const pa = Math.abs(estimate - left); const pb = Math.abs(estimate - up); const pc = Math.abs(estimate - upperLeft); row[x] = (row[x]! + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft)) & 255; } } for (let x = 0; x < width; x += 8) { const index = x * channels; colors.add(`${row[index]},${row[index + 1]},${row[index + 2]}`); } previous = row; }
  return colors.size;
}

function v3Fixture(request: { contractVersion: "meeet-meeting/v3"; participants: Array<{ id: string; origin: { label: string; latitude: number; longitude: number }; mode: "transit" }>; tolerancePercent: 5 | 10 | 15; searchStartAt: string }, reason: "ok" | "no-access-seeds" = "ok") {
  const geometry = (west: number, south: number, east: number, north: number) => ({ type: "MultiPolygon" as const, coordinates: [ring(west, south, east, north)] });
  const cells = [
    { id: "cell-red", geometry: geometry(11.54, 48.12, 11.57, 48.145), representativePoint: { latitude: 48.1325, longitude: 11.555 }, classification: "red" as const, redArrivalSeconds: 1200, blueArrivalSeconds: 2400, fasterParticipant: "red" as const, withinSelectedTolerance: false },
    { id: "cell-fair", geometry: geometry(11.57, 48.12, 11.60, 48.145), representativePoint: { latitude: 48.1325, longitude: 11.585 }, classification: "fair" as const, redArrivalSeconds: 1800, blueArrivalSeconds: 1860, fasterParticipant: "red" as const, withinSelectedTolerance: true },
    { id: "cell-blue", geometry: geometry(11.60, 48.12, 11.63, 48.145), representativePoint: { latitude: 48.1325, longitude: 11.615 }, classification: "blue" as const, redArrivalSeconds: 2500, blueArrivalSeconds: 1300, fasterParticipant: "blue" as const, withinSelectedTolerance: false },
  ];
  const acquisition = { sourceUrl: "https://example.test/mvv.zip", retrievedAt: "2026-08-01T00:00:00Z", rawArchiveByteSize: 100, rawArchiveSha256: "a".repeat(64), feedVersion: "mvv-fixture-2026-08", feedValidFrom: "2026-08-01", feedValidUntil: "2026-08-31", attribution: "Deterministic MVV fixture", officialAttribution: "MVV", officialLicense: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" }, officialProvenance: { source: "feed" as const, policyId: null } };
  const seed = (id: string, coordinate: { latitude: number; longitude: number }) => ({ seedId: id, mvgStationId: id, stationAreaId: id, coordinate, accessSeconds: 120, provenance: { source: "fixture-static" as const, endpoint: "fixture", distanceMeters: 100, walkingSeconds: 120, note: "Deterministic browser fixture." } });
  const schedule = { contractVersion: "meeet-scheduled-routing/v1", feedId: "mvv-fixture", timeZone: "Europe/Berlin", scheduleContentHash: "b".repeat(64), compiledArtifactId: "c".repeat(64), serviceDateRange: { firstDate: "2026-08-01", lastDate: "2026-08-31" }, acquisition };
  const surface = { contractVersion: "meeet-scheduled-routing/v1", scheduleContentHash: schedule.scheduleContentHash, compiledArtifactId: schedule.compiledArtifactId, feedId: schedule.feedId, timeZone: schedule.timeZone, searchStartAt: request.searchStartAt, routingHorizonSeconds: 86400, selectedTolerancePercent: request.tolerancePercent, walkingVelocityMetersPerSecond: 1.4, walkingSecondsRoundingRule: "ceil(distanceMetres / velocityMetresPerSecond), with zero distance taking zero seconds", transferRadiusMeters: 100, accessSeedCounts: [1, 1] as [number, number], stationAreaCount: 2, boardingStopCount: 2, connectionCount: 2, coverage: "scheduled-service-day-local-radius/v1" as const, representativePointBasis: "inside-clipped-cell/v1" as const, classificationMethod: "representative-point-with-geometric-final-station-walking/v1" as const, classificationBasis: "representative-point" as const, finalWalkingMethod: "geometric-station-walking-estimate-not-navigation" as const };
  const accessProvider = { name: "fixture MVG access", deployment: "fixture" as const, dataKind: "demo-static" as const, liveData: false, asOf: "fixture", notes: "Browser fixture", provenance: { role: "access" as const, provider: "fixture", deployment: "fixture" as const, dataKind: "demo-static" as const, liveData: false, sourceUrl: null, license: null, attribution: "Fixture", version: "fixture", retrievedAt: "fixture", notes: "Browser fixture", feeds: null } };
  return { contractVersion: "meeet-meeting/v3" as const, status: reason === "ok" ? "ok" as const : "no-result" as const, reason: reason === "ok" ? null : reason, participants: [{ id: request.participants[0]!.id, color: "red" as const, origin: request.participants[0]!.origin, mode: "transit" as const, accessSeeds: [seed("station-red", { latitude: 48.137, longitude: 11.576 })] }, { id: request.participants[1]!.id, color: "blue" as const, origin: request.participants[1]!.origin, mode: "transit" as const, accessSeeds: [seed("station-blue", { latitude: 48.126, longitude: 11.605 })] }], cells: reason === "ok" ? cells : cells.map((cell) => ({ ...cell, classification: "unclassified" as const, redArrivalSeconds: null, blueArrivalSeconds: null, fasterParticipant: null, withinSelectedTolerance: false })), metadata: { schedule, surface, grid: { columns: 24, rows: 16, cellCount: 3, geometry: "munich-clipped-surface-grid/v1" as const }, accessProvider, coverage: "munich-clipped-scheduled-grid/v1" as const } };
}

async function setup(page: Page, outcome: "ok" | "no-access-seeds" | "error" = "ok", failMapStyle = false, mockStyle = true) {
  if (mockStyle) await page.route(MAP_STYLE, (route) => failMapStyle ? route.fulfill({ status: 503, body: "fixture style unavailable" }) : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: 8, sources: { fixtureCartography: { type: "geojson", data: { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[11.54, 48.12], [11.63, 48.145]] }, properties: {} }] } } }, layers: [{ id: "background", type: "background" }, { id: "fixture-road", type: "line", source: "fixtureCartography", paint: { "line-color": "#526057", "line-width": 2 } }] }) }));
  await page.route(`${MAP_ORIGIN}/sprites/liberty.json`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })); await page.route(`${MAP_ORIGIN}/sprites/liberty.png`, (route) => route.fulfill({ status: 200, contentType: "image/png", body: EMPTY_PNG }));
  await page.route("**/api/locations/search**", async (route) => { const query = new URL(route.request().url()).searchParams.get("q") ?? ""; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ locations: [LOCATIONS[query as keyof typeof LOCATIONS] ?? { label: query, latitude: 48.1374, longitude: 11.5755 }] }) }); });
  await page.route("**/api/meeting/calculate", async (route) => { if (outcome === "error") { await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "scheduled service is temporarily unavailable." } }) }); return; } await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(v3Fixture(route.request().postDataJSON(), outcome)) }); });
}
async function selectOrigin(page: Page, index: number, name: keyof typeof LOCATIONS) { const input = page.getByRole("combobox", { name: `Participant ${index + 1} starting point` }); await input.fill(name); await page.getByRole("listbox").getByRole("button", { name, exact: true }).click(); await expect(input).toHaveValue(name); }
async function openPlanner(page: Page) { await page.goto("/"); await expect(page.getByRole("heading", { name: /Find the middle/ })).toBeVisible(); await expect(page.getByRole("combobox")).toHaveCount(2); }

test.describe("v3 Munich meeting surface", () => {
  test("renders the real configured OpenFreeMap style", async ({ page }, testInfo) => {
    const mapErrors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error" || message.text().includes("style")) mapErrors.push(message.text()); });
    await setup(page, "ok", false, false); await openPlanner(page);
    await testInfo.attach("real-map-diagnostics", { body: JSON.stringify(mapErrors, null, 2), contentType: "application/json" });
    await expect(page.locator(".map-frame")).toHaveAttribute("data-map-state", "ready");
    await expect(page.locator(".map-frame")).toHaveAttribute("data-map-style", "configured");
    await expect(page.locator(".maplibregl-ctrl-zoom-in")).toBeVisible();
    const layout = await page.locator(".map-frame").evaluate((frame) => {
      const canvas = frame.querySelector(".maplibregl-canvas") as HTMLCanvasElement | null;
      const zoom = frame.querySelector(".maplibregl-ctrl-zoom-in") as HTMLElement | null;
      if (!canvas || !zoom) return { aligned: false, painted: false, mapHit: false };
      const frameRect = frame.getBoundingClientRect(); const canvasRect = canvas.getBoundingClientRect(); const zoomRect = zoom.getBoundingClientRect();
      const center = document.elementsFromPoint((frameRect.left + frameRect.right) / 2, (frameRect.top + frameRect.bottom) / 2);
      const zoomStyle = getComputedStyle(zoom);
      return { aligned: Math.abs(canvasRect.left - frameRect.left) <= 2 && Math.abs(canvasRect.top - frameRect.top) <= 2 && Math.abs(canvasRect.width - frameRect.width) <= 2 && Math.abs(canvasRect.height - frameRect.height) <= 2, painted: zoomRect.width > 0 && zoomRect.height > 0 && zoomStyle.display !== "none" && zoomStyle.visibility !== "hidden" && Number(zoomStyle.opacity) > 0, mapHit: center.some((element) => element === canvas || element.classList.contains("maplibregl-map") || element.classList.contains("maplibregl-canvas-container")) };
    });
    expect(layout).toEqual({ aligned: true, painted: true, mapHit: true });
    await page.waitForTimeout(500);
    const visual = await page.locator(".map-frame").screenshot();
    await testInfo.attach("real-map-screenshot", { body: visual, contentType: "image/png" });
    expect(pngColorCount(visual)).toBeGreaterThan(1);
  });
  test("keeps a usable bare map when the configured style fails", async ({ page }, testInfo) => {
    const consoleErrors: string[] = []; const failedRequests: string[] = []; const httpErrors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("requestfailed", (request) => failedRequests.push(`${request.url()}: ${request.failure()?.errorText ?? "unknown"}`));
    page.on("response", (response) => { if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`); });
    await setup(page, "ok", true); await openPlanner(page);
    await testInfo.attach("map-diagnostics", { body: JSON.stringify({ consoleErrors, failedRequests, httpErrors }, null, 2), contentType: "application/json" });
    await expect(page.locator(".map-frame")).toHaveAttribute("data-map-state", "unavailable");
    await expect(page.locator(".map-frame")).toHaveAttribute("data-map-style", "configured");
    await expect(page.locator(".map-frame canvas")).toBeVisible();
    expect(httpErrors.some((entry) => entry.startsWith("503 "))).toBe(true);
  });
  test("two origins produce a red/blue/yellow surface with clear planning disclosures", async ({ page }) => {
    await setup(page); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof"); await expect(page.locator(".meeet-origin-marker")).toHaveCount(2); await page.getByRole("radio", { name: "±5%" }).check();
    const request = page.waitForRequest((item) => item.url().endsWith("/api/meeting/calculate")); await page.getByRole("button", { name: "Show meeting surface" }).click(); const body = (await request).postDataJSON(); expect(body.contractVersion).toBe("meeet-meeting/v3"); expect(body.participants).toHaveLength(2); expect(body.participants.every((participant: { mode: string }) => participant.mode === "transit")).toBe(true); expect(body.tolerancePercent).toBe(5); expect(body.searchStartAt).toMatch(/T\d{2}:\d{2}:\d{2}\.000Z$/);
    await expect(page.getByText("Surface ready", { exact: true })).toBeVisible(); await expect(page.locator(".map-frame")).toHaveAttribute("data-map-state", "ready"); await expect(page.locator(".map-frame")).toHaveAttribute("data-map-style", "configured"); await expect(page.locator(".maplibregl-ctrl-zoom-in")).toBeVisible(); await expect(page.getByText("Fair within tolerance", { exact: false })).toBeVisible(); await expect(page.getByText("Red is quicker", { exact: false })).toBeVisible(); await expect(page.getByText("Blue is quicker", { exact: false })).toBeVisible(); await page.getByText("About this meeting surface", { exact: true }).click(); await expect(page.getByText(/installed scheduled MVV feed for Munich/)).toBeVisible(); await expect(page.getByText(/interior representative point/)).toBeVisible(); await expect(page.getByText(/not walking directions/)).toBeVisible(); await expect(page.getByRole("region", { name: /red, blue and yellow travel-time cells/ })).toBeVisible();
  });
  test("shows an explicit no-result reason and retains the two origins", async ({ page }) => { await setup(page, "no-access-seeds"); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof"); await page.getByRole("button", { name: "Show meeting surface" }).click(); await expect(page.getByText("No meeting surface yet", { exact: true })).toBeVisible(); await expect(page.getByText(/No nearby MVG access seed could be resolved/)).toBeVisible(); await expect(page.locator(".meeet-origin-marker")).toHaveCount(2); });
  test("shows a scheduled-service error without stale surface claims", async ({ page }) => { await setup(page, "error"); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof"); await page.getByRole("button", { name: "Show meeting surface" }).click(); await expect(page.locator(".form-message[role='alert']")).toContainText("scheduled service is temporarily unavailable"); await expect(page.getByText("Surface ready", { exact: true })).toHaveCount(0); });
});

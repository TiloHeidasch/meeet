import { expect, test } from "@playwright/test";
import { inflateSync } from "node:zlib";
import http from "node:http";
import type net from "node:net";
import { STATION_ICON_PADDING, STATION_ICON_SPEC_RATIOS } from "../lib/client/station-icon-sizes";
import { LOCATIONS, v3Fixture, detailsFixture, ERROR_STREAM_FRAME, sseFrame, progressFrame, verdictFrame, progressStreamFrames, okStreamBody, setup, selectOrigin, openPlanner } from "./helpers";
import { CALCULATION_PROGRESS_PHASES } from "../lib/domain/calculation-progress-contract";

function pngColorCount(input: Buffer): number {
  let offset = 8; let width = 0; let height = 0; let colorType = 0; let idat = Buffer.alloc(0);
  while (offset < input.length) { const length = input.readUInt32BE(offset); const type = input.toString("ascii", offset + 4, offset + 8); const data = input.subarray(offset + 8, offset + 8 + length); if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]!; } if (type === "IDAT") idat = Buffer.concat([idat, data]); offset += length + 12; }
  const channels = colorType === 6 ? 4 : 3; const stride = width * channels; const raw = inflateSync(idat); const colors = new Set<string>(); let cursor = 0; let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) { const filter = raw[cursor++]!; const row = Buffer.from(raw.subarray(cursor, cursor + stride)); cursor += stride; for (let x = 0; x < stride; x++) { const left = x >= channels ? row[x - channels]! : 0; const up = previous[x]!; const upperLeft = x >= channels ? previous[x - channels]! : 0; if (filter === 1) row[x] = (row[x]! + left) & 255; else if (filter === 2) row[x] = (row[x]! + up) & 255; else if (filter === 3) row[x] = (row[x]! + Math.floor((left + up) / 2)) & 255; else if (filter === 4) { const estimate = left + up - upperLeft; const pa = Math.abs(estimate - left); const pb = Math.abs(estimate - up); const pc = Math.abs(estimate - upperLeft); row[x] = (row[x]! + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft)) & 255; } } for (let x = 0; x < width; x += 8) { const index = x * channels; colors.add(`${row[index]},${row[index + 1]},${row[index + 2]}`); } previous = row; }
  return colors.size;
}

async function createStreamingTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/stream`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

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
    await expect(page.locator(".map-frame canvas")).toBeVisible(); await expect(page.getByText(/station-area territory map is unavailable/)).toBeVisible(); await expect(page.getByText(/still available as a surface summary/)).toHaveCount(0);
    expect(httpErrors.some((entry) => entry.startsWith("503 "))).toBe(true);
  });
  test("two origins produce a red/blue/fair territory surface with clear planning disclosures", async ({ page }) => {
    await setup(page); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof"); await expect(page.locator(".meeet-origin-marker")).toHaveCount(2); await page.getByRole("radio", { name: "±5%" }).check();
    const request = page.waitForRequest((item) => item.url().endsWith("/api/meeting/calculate/stream")); await page.getByRole("button", { name: "meeet!" }).click(); const body = (await request).postDataJSON(); expect(body.contractVersion).toBe("meeet-meeting/v3"); expect(body.participants).toHaveLength(2); expect(body.participants.every((participant: { mode: string }) => participant.mode === "transit")).toBe(true); expect(body.tolerancePercent).toBe(5); expect(body.changeTimePreset).toBe("medium"); expect(body.searchStartAt).toMatch(/T\d{2}:\d{2}:\d{2}\.000Z$/);
    await expect(page.getByText("Surface ready", { exact: true })).toBeVisible(); await expect(page.locator(".map-frame")).toHaveAttribute("data-map-state", "ready"); await expect(page.locator(".map-frame")).toHaveAttribute("data-map-style", "configured"); await expect(page.locator(".map-frame")).toHaveAttribute("data-station-area-count", "4"); await expect(page.locator(".map-frame")).toHaveAttribute("data-station-marker-count", "4"); await expect(page.locator(".map-frame")).toHaveAttribute("data-territory-source", "shared"); await expect(page.locator(".map-frame")).toHaveAttribute("data-territory-fill-layers", "3"); const territoryFillOpacity = Number(await page.locator(".map-frame").getAttribute("data-territory-fill-opacity")); expect(Number.isFinite(territoryFillOpacity)).toBe(true); expect(territoryFillOpacity).toBeGreaterThan(0); expect(territoryFillOpacity).toBeLessThan(1); await expect(page.locator(".map-frame")).toHaveAttribute("data-territory-feature-count", "3"); await expect(page.locator(".maplibregl-ctrl-zoom-in")).toBeVisible();     await expect(page.getByText("Fair territory within tolerance", { exact: false })).toBeVisible(); await expect(page.getByText("Red is quicker", { exact: false })).toBeVisible(); await expect(page.getByText("Blue is quicker", { exact: false })).toBeVisible(); await expect(page.getByText("Gray markers are unclassified station areas", { exact: false })).toBeVisible(); await page.getByText("About this meeting surface", { exact: true }).click(); await expect(page.getByText(/installed scheduled MVV feed for Munich/)).toBeVisible(); await expect(page.getByText(/station areas into translucent territories/)).toBeVisible(); await expect(page.getByText(/not walking directions/)).toBeVisible(); await expect(page.getByRole("region", { name: /4 calculated station-area markers/ })).toBeVisible(); await selectOrigin(page, 0, "Ostbahnhof"); await expect(page.getByText("Surface ready", { exact: true })).toHaveCount(0); await expect(page.locator(".map-frame")).toHaveAttribute("data-territory-feature-count", "0");
  });
  test("shows an explicit no-result reason and retains the two origins", async ({ page }) => { await setup(page, "no-access-seeds"); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof"); await page.getByRole("button", { name: "meeet!" }).click(); await expect(page.getByText("No meeting surface yet", { exact: true })).toBeVisible(); await expect(page.getByText(/No nearby MVG access seed could be resolved/)).toBeVisible(); await expect(page.locator(".meeet-origin-marker")).toHaveCount(2); await expect(page.locator(".map-frame")).toHaveAttribute("data-station-area-count", "4"); await expect(page.locator(".map-frame")).toHaveAttribute("data-territory-feature-count", "0"); await expect(page.locator(".map-frame")).toHaveAttribute("data-territory-source", "shared"); await expect(page.getByRole("region", { name: /4 unclassified station-area markers/ })).toBeVisible(); await expect(page.getByText("Gray markers are unclassified station areas", { exact: false })).toBeVisible(); });
  test("shows a scheduled-service error without stale surface claims", async ({ page }) => { await setup(page, "error"); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof"); await page.getByRole("button", { name: "meeet!" }).click(); await expect(page.locator(".form-message[role='alert']")).toContainText("scheduled service is temporarily unavailable"); await expect(page.getByText("Surface ready", { exact: true })).toHaveCount(0); });
  test("selects every station area with native keyboard and exposes participant totals", async ({ page }) => { await setup(page); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof"); await page.getByRole("button", { name: "meeet!" }).click(); for (const id of ["area-red", "area-blue", "area-fair", "area-unclassified"]) { const area = page.locator(`[data-station-area-id="${id}"]`); await area.focus(); await page.keyboard.press("Enter"); await expect(area).toHaveAttribute("aria-pressed", "true"); await expect(page.getByRole("heading", { name: "Station-area details" })).toBeVisible(); } const fair = page.locator('[data-station-area-id="area-fair"]'); await fair.focus(); await page.keyboard.press("Enter"); await expect(page.getByRole("heading", { name: "Participant 1" })).toBeVisible(); await page.getByText("Schedule and access provenance", { exact: true }).click(); await expect(page.locator(".detail-provenance-copy")).toContainText("fixture"); await expect(page.locator(".detail-provenance-copy")).toContainText("MVV"); await expect(page.locator(".detail-provenance-copy")).toContainText("Fixture"); await page.keyboard.press("Space"); await expect(fair).toHaveAttribute("aria-pressed", "true"); await expect(page.locator('[data-station-area-id="area-unclassified"]')).toHaveCount(1); });
  test("supports selecting a non-default change-time preset and preserves it in details", async ({ page }) => {
    await setup(page); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof");
    await page.getByRole("radio", { name: "Quick 3 min" }).check();
    const streamReq = page.waitForRequest((item) => item.url().endsWith("/api/meeting/calculate/stream"));
    await page.getByRole("button", { name: "meeet!" }).click();
    const streamBody = (await streamReq).postDataJSON();
    expect(streamBody.changeTimePreset).toBe("quick");
    await expect(page.getByText("Surface ready", { exact: true })).toBeVisible();
    const fair = page.locator('[data-station-area-id="area-fair"]');
    const detailsReq = page.waitForRequest((item) => item.url().includes("/api/meeting/station-areas/area-fair/details"));
    await fair.click();
    const detailsBody = (await detailsReq).postDataJSON();
    expect(detailsBody.changeTimePreset).toBe("quick");
    await expect(page.locator(".station-detail-panel")).toContainText("Fair area");
    await expect(page.getByRole("heading", { name: "Participant 1" })).toBeVisible();
  });
  test("selects unclassified areas with explicit unavailable participant details", async ({ page }) => { await setup(page, "no-access-seeds"); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof"); await page.getByRole("button", { name: "meeet!" }).click(); const unclassified = page.locator('[data-station-area-id="area-unclassified"]'); await unclassified.click(); await expect(unclassified).toHaveAttribute("aria-pressed", "true"); await expect(page.getByRole("heading", { name: "Participant 1" })).toBeVisible(); await expect(page.getByRole("heading", { name: "Participant 2" })).toBeVisible(); await expect(page.getByText(/No nearby access seed was available/)).toHaveCount(2); });
  test("activates a station marker through the real MapLibre canvas pointer", async ({ page }) => { await setup(page); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof"); await page.getByRole("button", { name: "meeet!" }).click(); await expect(page.locator('.map-frame[data-map-state="ready"]')).toHaveAttribute("data-station-markers-ready", "true"); const canvas = page.locator(".maplibregl-canvas"); await canvas.scrollIntoViewIfNeeded(); const point = await page.evaluate(() => { const map = (window as unknown as { __meeetMap?: { project: (coordinate: [number, number]) => { x: number; y: number } } }).__meeetMap; if (!map) throw new Error("Map instance unavailable"); return map.project([11.585, 48.132]); }); const rect = await canvas.boundingBox(); if (!rect) throw new Error("Map canvas was not painted"); const request = page.waitForRequest((item) => item.url().includes("/api/meeting/station-areas/area-fair/details")); await page.mouse.click(rect.x + point.x, rect.y + point.y); await request; const fair = page.locator('[data-station-area-id="area-fair"]'); await expect(fair).toHaveAttribute("aria-pressed", "true"); await expect(page.locator(".station-detail-panel")).toContainText("Fair area"); await expect(page.locator(".station-detail-panel")).toContainText("30 min"); });
  test("activates a station marker through a real touch canvas pointer", async ({ browser }) => { const context = await browser.newContext({ baseURL: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3100"}`, hasTouch: true }); const page = await context.newPage(); try { await setup(page); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof"); await page.getByRole("button", { name: "meeet!" }).click(); await expect(page.locator('.map-frame[data-map-state="ready"]')).toHaveAttribute("data-station-markers-ready", "true"); const canvas = page.locator(".maplibregl-canvas"); await canvas.scrollIntoViewIfNeeded(); const point = await page.evaluate(() => { const map = (window as unknown as { __meeetMap?: { project: (coordinate: [number, number]) => { x: number; y: number } } }).__meeetMap; if (!map) throw new Error("Map instance unavailable"); return map.project([11.585, 48.132]); }); const rect = await canvas.boundingBox(); if (!rect) throw new Error("Map canvas was not painted"); const request = page.waitForRequest((item) => item.url().includes("/api/meeting/station-areas/area-fair/details")); await page.touchscreen.tap(rect.x + point.x, rect.y + point.y); await request; await expect(page.locator('[data-station-area-id="area-fair"]')).toHaveAttribute("aria-pressed", "true"); await expect(page.locator(".station-detail-panel")).toContainText("Fair area"); } finally { await context.close(); } });
  test("supports native touch-equivalent station selection", async ({ browser }) => { const context = await browser.newContext({ baseURL: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3100"}`, hasTouch: true }); const page = await context.newPage(); try { await setup(page); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof"); await page.getByRole("button", { name: "meeet!" }).click(); const fair = page.locator('[data-station-area-id="area-fair"]'); await fair.tap(); await expect(fair).toHaveAttribute("aria-pressed", "true"); await expect(page.getByRole("heading", { name: "Station-area details" })).toBeVisible(); } finally { await context.close(); } });
  test("does not show delayed evidence from a previous selection", async ({ page }) => { await setup(page); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof"); await page.getByRole("button", { name: "meeet!" }).click(); await page.unroute("**/api/meeting/station-areas/*/details"); await page.route("**/api/meeting/station-areas/*/details", async (route) => { const id = new URL(route.request().url()).pathname.split("/").at(-2)!; if (id === "area-fair") await new Promise((resolve) => setTimeout(resolve, 400)); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detailsFixture(route.request().postDataJSON(), id)) }); }); const fair = page.locator('[data-station-area-id="area-fair"]'); const red = page.locator('[data-station-area-id="area-red"]'); await fair.click(); await red.click(); await expect(red).toHaveAttribute("aria-pressed", "true"); await expect(page.locator(".station-detail-panel").getByText("Red area", { exact: true })).toBeVisible(); await expect(page.locator(".station-detail-panel").getByText("Fair area", { exact: true })).toHaveCount(0); });
  test("uses the native chooser when the map is unavailable", async ({ page }) => { await setup(page, "ok", true); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof"); await page.getByRole("button", { name: "meeet!" }).click(); await expect(page.locator(".map-frame")).toHaveAttribute("data-map-state", "unavailable"); const fair = page.locator('[data-station-area-id="area-fair"]'); await fair.click(); await expect(fair).toHaveAttribute("aria-pressed", "true"); await expect(page.getByRole("heading", { name: "Station-area details" })).toBeVisible(); });
  test("shows an explicit expired calculation reference and requires a manual recalculation", async ({ page }) => { let calculateCalls = 0; page.on("request", (request) => { if (request.url().includes("/api/meeting/calculate/stream")) calculateCalls += 1; }); await setup(page); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof"); await page.getByRole("button", { name: "meeet!" }).click(); await expect(page.locator(".station-area-panel")).toBeVisible(); await page.unroute("**/api/meeting/station-areas/*/details"); await page.route("**/api/meeting/station-areas/*/details", (route) => route.fulfill({ status: 410, contentType: "application/json", body: JSON.stringify({ error: { code: "CALCULATION_REF_EXPIRED", message: "The calculation reference is missing or has expired. Recalculate the meeting surface." } }) })); const fair = page.locator('[data-station-area-id="area-fair"]'); await fair.click(); await expect(page.getByText(/calculation reference has expired/)).toBeVisible(); await expect(page.getByRole("button", { name: "Recalculate meeting surface" })).toBeVisible(); await expect(page.locator(".station-detail-panel").getByText("30 min", { exact: false })).toHaveCount(0); await page.waitForTimeout(400); expect(calculateCalls).toBe(1); const recalculated = page.waitForResponse((response) => response.url().includes("/api/meeting/calculate/stream")); await page.getByRole("button", { name: "Recalculate meeting surface" }).click(); await recalculated; await expect(page.locator(".station-area-panel")).toBeVisible(); expect(calculateCalls).toBe(2); });
  test("keeps participant origins fixed while map pan and zoom stay interactive", async ({ page }) => { await setup(page); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof"); await page.getByRole("button", { name: "meeet!" }).click(); await expect(page.getByText("Surface ready", { exact: true })).toBeVisible(); await expect(page.getByText(/Drag to adjust/)).toHaveCount(0); const canvas = page.locator(".maplibregl-canvas"); await canvas.scrollIntoViewIfNeeded(); const canvasRect = await canvas.boundingBox(); if (!canvasRect) throw new Error("Map canvas was not painted"); const marker = page.locator(".meeet-origin-marker").first(); await expect(marker).toHaveAttribute("aria-label", "Participant 1 origin."); const box = await marker.boundingBox(); if (!box) throw new Error("Origin marker was not painted"); const geoBefore = await page.evaluate((point) => { const map = (window as unknown as { __meeetMap?: { unproject: (point: { x: number; y: number }) => { lat: number; lng: number } } }).__meeetMap; if (!map) throw new Error("Map instance unavailable"); return map.unproject(point); }, { x: box.x + box.width / 2 - canvasRect.x, y: box.y + box.height / 2 - canvasRect.y }); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 8 }); await page.mouse.up(); await page.evaluate(() => new Promise<void>((resolve) => { const map = (window as unknown as { __meeetMap?: { isMoving: () => boolean; once: (event: string, callback: () => void) => void } }).__meeetMap; if (!map || !map.isMoving()) { resolve(); return; } map.once("moveend", () => resolve()); })); const afterBox = await marker.boundingBox(); if (!afterBox) throw new Error("Origin marker disappeared after drag attempt"); const geoAfter = await page.evaluate((point) => { const map = (window as unknown as { __meeetMap?: { unproject: (point: { x: number; y: number }) => { lat: number; lng: number } } }).__meeetMap; if (!map) throw new Error("Map instance unavailable"); return map.unproject(point); }, { x: afterBox.x + afterBox.width / 2 - canvasRect.x, y: afterBox.y + afterBox.height / 2 - canvasRect.y }); expect(Math.abs(geoAfter.lat - geoBefore.lat)).toBeLessThan(0.0005); expect(Math.abs(geoAfter.lng - geoBefore.lng)).toBeLessThan(0.0005); await expect(page.getByText("Surface ready", { exact: true })).toBeVisible(); await expect(page.getByText("Your inputs changed", { exact: false })).toHaveCount(0); const enabled = await page.evaluate(() => { const map = (window as unknown as { __meeetMap?: { dragPan: { isEnabled: () => boolean }; scrollZoom: { isEnabled: () => boolean }; touchZoomRotate: { isEnabled: () => boolean } } }).__meeetMap; if (!map) throw new Error("Map instance unavailable"); return { dragPan: map.dragPan.isEnabled(), scrollZoom: map.scrollZoom.isEnabled(), touchZoomRotate: map.touchZoomRotate.isEnabled() }; }); expect(enabled).toEqual({ dragPan: true, scrollZoom: true, touchZoomRotate: true }); const beforePan = await page.evaluate(() => { const map = (window as unknown as { __meeetMap?: { getCenter: () => { lat: number; lng: number } } }).__meeetMap; if (!map) throw new Error("Map instance unavailable"); return map.getCenter(); }); await page.mouse.move(canvasRect.x + canvasRect.width / 2, canvasRect.y + canvasRect.height / 2); await page.mouse.down(); await page.mouse.move(canvasRect.x + canvasRect.width / 2 + 120, canvasRect.y + canvasRect.height / 2 + 80, { steps: 10 }); await page.mouse.up(); await page.waitForFunction((before) => { const map = (window as unknown as { __meeetMap?: { getCenter: () => { lat: number; lng: number } } }).__meeetMap; if (!map) return false; const center = map.getCenter(); return Math.abs(center.lat - before.lat) > 0.0001 || Math.abs(center.lng - before.lng) > 0.0001; }, beforePan); const afterPan = await page.evaluate(() => { const map = (window as unknown as { __meeetMap?: { getCenter: () => { lat: number; lng: number } } }).__meeetMap; if (!map) throw new Error("Map instance unavailable"); return map.getCenter(); }); expect(Math.abs(afterPan.lat - beforePan.lat) > 0.0001 || Math.abs(afterPan.lng - beforePan.lng) > 0.0001).toBe(true); const zoomBefore = await page.evaluate(() => { const map = (window as unknown as { __meeetMap?: { getZoom: () => number } }).__meeetMap; if (!map) throw new Error("Map instance unavailable"); return map.getZoom(); }); await page.mouse.move(canvasRect.x + canvasRect.width / 2, canvasRect.y + canvasRect.height / 2); await page.mouse.wheel(0, -400); await page.waitForFunction((before) => { const map = (window as unknown as { __meeetMap?: { getZoom: () => number } }).__meeetMap; return !!map && map.getZoom() > before; }, zoomBefore); const zoomAfter = await page.evaluate(() => { const map = (window as unknown as { __meeetMap?: { getZoom: () => number } }).__meeetMap; if (!map) throw new Error("Map instance unavailable"); return map.getZoom(); }); expect(zoomAfter).toBeGreaterThan(zoomBefore); await expect(page.locator(".meeet-origin-marker")).toHaveCount(2); });
  test("shows station names on marker hover and clears on pointer leave", async ({ page }) => {
    await setup(page); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof"); await page.getByRole("button", { name: "meeet!" }).click(); await expect(page.locator('.map-frame[data-map-state="ready"]')).toHaveAttribute("data-station-markers-ready", "true");
    const tooltip = page.locator("[data-station-tooltip]"); await expect(tooltip).toHaveCount(0);
    const canvas = page.locator(".maplibregl-canvas"); await canvas.scrollIntoViewIfNeeded(); const rect = await canvas.boundingBox(); if (!rect) throw new Error("Map canvas was not painted");
    const project = (lng: number, lat: number) => page.evaluate((coordinate) => { const map = (window as unknown as { __meeetMap?: { project: (coordinate: [number, number]) => { x: number; y: number } } }).__meeetMap; if (!map) throw new Error("Map instance unavailable"); return map.project(coordinate); }, [lng, lat] as [number, number]);
    const fair = await project(11.585, 48.132); await page.mouse.move(rect.x + fair.x, rect.y + fair.y); await expect(tooltip).toBeVisible(); await expect(tooltip).toContainText("Fair area");
    const away = await project(11.63, 48.145); await page.mouse.move(rect.x + away.x, rect.y + away.y); await expect(tooltip).toHaveCount(0);
    const unclassified = await project(11.59, 48.14); await page.mouse.move(rect.x + unclassified.x, rect.y + unclassified.y); await expect(tooltip).toBeVisible(); await expect(tooltip).toContainText("Unclassified area");
    await page.mouse.move(rect.x + away.x, rect.y + away.y); await expect(tooltip).toHaveCount(0);
  });
  test("clears the hover tooltip when the calculation becomes stale", async ({ page }) => {
    await setup(page); await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof"); await page.getByRole("button", { name: "meeet!" }).click(); await expect(page.locator('.map-frame[data-map-state="ready"]')).toHaveAttribute("data-station-markers-ready", "true");
    const tooltip = page.locator("[data-station-tooltip]"); const canvas = page.locator(".maplibregl-canvas"); await canvas.scrollIntoViewIfNeeded(); const rect = await canvas.boundingBox(); if (!rect) throw new Error("Map canvas was not painted");
    const project = (lng: number, lat: number) => page.evaluate((coordinate) => { const map = (window as unknown as { __meeetMap?: { project: (coordinate: [number, number]) => { x: number; y: number } } }).__meeetMap; if (!map) throw new Error("Map instance unavailable"); return map.project(coordinate); }, [lng, lat] as [number, number]);
    const fair = await project(11.585, 48.132); await page.mouse.move(rect.x + fair.x, rect.y + fair.y); await expect(tooltip).toBeVisible(); await expect(tooltip).toContainText("Fair area");
    await selectOrigin(page, 0, "Ostbahnhof"); await expect(tooltip).toHaveCount(0); await expect(page.locator(".map-frame")).toHaveAttribute("data-station-area-count", "0");
    const away = await project(11.63, 48.145); await page.mouse.move(rect.x + away.x, rect.y + away.y);
    await page.getByRole("button", { name: "meeet!" }).click(); await expect(page.locator(".map-frame")).toHaveAttribute("data-station-area-count", "4"); await expect(page.locator('.map-frame[data-map-state="ready"]')).toHaveAttribute("data-station-markers-ready", "true");
    await canvas.scrollIntoViewIfNeeded();
    const rectAfter = await canvas.boundingBox(); if (!rectAfter) throw new Error("Map canvas missing");
    const fairAfter = await project(11.585, 48.132);
    await page.mouse.move(rectAfter.x + fairAfter.x, rectAfter.y + fairAfter.y);
    await expect(tooltip).toBeVisible(); await expect(tooltip).toContainText("Fair area");
    const awayAfter = await project(11.63, 48.145); await page.mouse.move(rectAfter.x + awayAfter.x, rectAfter.y + awayAfter.y); await expect(tooltip).toHaveCount(0);
  });
  test("shows truthful progress phases while calculating", async ({ page }) => {
    await setup(page, "ok", false, true, 800);
    await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof");
    await page.getByRole("button", { name: "meeet!" }).click();
    const progress = page.locator('[data-testid="calculation-progress"]');
    await expect(progress).toBeVisible();
    await expect(progress.getByText("not live transit information")).toBeVisible();
    const phases = progress.locator(".progress-phases");
    for (const label of ["Finding nearby transit access", "Checking planned MVV journeys", "Comparing station areas", "Preparing the validated map"]) await expect(phases.getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByTestId("cancel-calculation")).toBeVisible();
    await expect(page.getByText("Surface ready", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Surface ready", { exact: true })).toBeVisible();
  });
  test("cancel returns to idle and preserves inputs", async ({ page }) => {
    await setup(page, "ok", false, true, 1200);
    await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof");
    await page.getByRole("button", { name: "meeet!" }).click();
    await expect(page.getByTestId("cancel-calculation")).toBeVisible();
    await page.getByTestId("cancel-calculation").click();
    await expect(page.getByRole("button", { name: "meeet!" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Participant 1 starting point" })).toHaveValue("Marienplatz");
    await expect(page.getByRole("combobox", { name: "Participant 2 starting point" })).toHaveValue("Ostbahnhof");
    await expect(page.locator('[data-testid="calculation-progress"]')).toHaveCount(0);
    await expect(page.getByText("Surface ready", { exact: true })).toHaveCount(0);
    await page.waitForTimeout(1900);
    await expect(page.getByText("Surface ready", { exact: true })).toHaveCount(0);
  });
  test("error terminal offers retry and retry succeeds", async ({ page }) => {
    await setup(page);
    await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof");
    let streamFailed = true;
    await page.unroute("**/api/meeting/calculate/stream");
    await page.route("**/api/meeting/calculate/stream", async (route) => { if (streamFailed) { streamFailed = false; await route.fulfill({ status: 200, contentType: "text/event-stream", body: ERROR_STREAM_FRAME }); return; } await route.fulfill({ status: 200, contentType: "text/event-stream", body: okStreamBody(route.request().postDataJSON()) }); });
    await page.getByRole("button", { name: "meeet!" }).click();
    await expect(page.locator(".form-message[role='alert']")).toContainText("scheduled service is temporarily unavailable");
    await expect(page.getByTestId("retry-calculation")).toBeVisible();
    await expect(page.getByText("Surface ready", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("Surface ready", { exact: true })).toBeVisible();
  });
  test("shows an HTTP error before the stream starts", async ({ page }) => {
    await setup(page);
    await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof");
    await page.unroute("**/api/meeting/calculate/stream");
    await page.route("**/api/meeting/calculate/stream", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "TEMPORARILY_UNAVAILABLE", message: "A scheduled meeting calculation is already in progress. Please try again shortly." } }) }));
    await page.getByRole("button", { name: "meeet!" }).click();
    await expect(page.locator(".form-message[role='alert']")).toContainText("A scheduled meeting calculation is already in progress. Please try again shortly.");
    await expect(page.locator('[data-testid="calculation-progress"]')).toHaveCount(0);
  });
  test("reduced motion keeps the progress panel truthful", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await setup(page, "ok", false, true, 800);
    await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof");
    await page.getByRole("button", { name: "meeet!" }).click();
    await expect(page.locator('[data-testid="calculation-progress"]')).toBeVisible();
    const duration = await page.locator(".progress-indicator").evaluate((element) => getComputedStyle(element).animationDuration);
    const durationSeconds = duration.endsWith("ms") ? Number.parseFloat(duration) / 1000 : Number.parseFloat(duration);
    expect(durationSeconds).toBeLessThan(0.001);
    await expect(page.getByText("Surface ready", { exact: true })).toBeVisible();
  });
  test("discards a stale stream's late result when a new calculation starts", async ({ page }) => {
    await setup(page);
    await openPlanner(page); await selectOrigin(page, 0, "Marienplatz"); await selectOrigin(page, 1, "Ostbahnhof");
    let streamCalls = 0;
    await page.unroute("**/api/meeting/calculate/stream");
    await page.route("**/api/meeting/calculate/stream", async (route) => {
      streamCalls += 1;
      if (streamCalls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        try { await route.fulfill({ status: 200, contentType: "text/event-stream", body: okStreamBody(route.request().postDataJSON(), "no-access-seeds") }); } catch { /* the client aborted the stale stream */ }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: okStreamBody(route.request().postDataJSON()) });
    });
    // Two submissions in the same task: the second starts while the first stream is
    // still in flight (before React re-renders the loading-disabled state), which is
    // exactly the race the stale-stream protection must survive.
    await page.evaluate(() => {
      const form = document.querySelector("form");
      if (!form) throw new Error("Planner form missing");
      form.requestSubmit();
      form.requestSubmit();
    });
    await expect(page.locator('[data-testid="calculation-progress"]')).toBeVisible();
    await expect(page.getByText("Surface ready", { exact: true })).toBeVisible();
    await page.waitForTimeout(2200);
    await expect(page.getByText("No meeting surface yet", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Surface ready", { exact: true })).toBeVisible();
    expect(streamCalls).toBe(2);
  });
  test("differentiates mode-specific station markers from drop-shaped origin markers", async ({ page }) => {
    await setup(page);
    await openPlanner(page);
    await selectOrigin(page, 0, "Marienplatz");
    await selectOrigin(page, 1, "Ostbahnhof");
    await page.getByRole("button", { name: "meeet!" }).click();
    await expect(page.locator('.map-frame[data-map-state="ready"]')).toHaveAttribute("data-station-markers-ready", "true");

    // Origin markers are drop-shaped pins without numeric labels
    const originMarkers = page.locator(".meeet-origin-marker");
    await expect(originMarkers).toHaveCount(2);
    const origin1 = originMarkers.first();
    const origin1Svg = origin1.locator("svg");
    await expect(origin1Svg).toBeVisible();
    const origin1Text = await origin1.textContent();
    expect(origin1Text?.trim()).toBe("");

    // Pin design per issue #49: white outer area, participant-colored inner fill, white middle circle
    const origin1Paths = await origin1Svg.evaluate((svg) => [...svg.querySelectorAll("path")].map((path) => path.getAttribute("fill")));
    expect(origin1Paths).toEqual(["#FFFFFF", "currentColor", "#FFFFFF"]);
    await expect(origin1).toHaveCSS("color", "rgb(232, 93, 74)");
    await expect(originMarkers.nth(1)).toHaveCSS("color", "rgb(61, 112, 201)");
    // Pin visual size is 200% of the 18px bus visual size; the button hit target is at least 44px wide
    const pinBox = await origin1Svg.boundingBox();
    if (!pinBox) throw new Error("Origin pin svg was not painted");
    expect(pinBox.width).toBeGreaterThan(35);
    expect(pinBox.width).toBeLessThan(37);
    const markerBox = await origin1.boundingBox();
    if (!markerBox) throw new Error("Origin marker was not painted");
    expect(markerBox.width).toBeGreaterThanOrEqual(44);

    // Participant pins are DOM markers above the canvas: no icon occludes them
    // (scroll the map into view first so the markers are inside the viewport for element hit-testing)
    await page.locator(".map-frame").evaluate((frame) => frame.scrollIntoView({ block: "center" }));
    const originPinsOnTop = await page.evaluate(() => {
      return [...document.querySelectorAll(".meeet-origin-marker")].map((marker) => {
        const rect = marker.getBoundingClientRect();
        const points = [
          { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
          { x: rect.x + 1, y: rect.y + 1 },
          { x: rect.x + rect.width - 1, y: rect.y + 1 },
          { x: rect.x + 1, y: rect.y + rect.height - 1 },
          { x: rect.x + rect.width - 1, y: rect.y + rect.height - 1 },
        ];
        return points.every((point) => {
          const top = document.elementsFromPoint(point.x, point.y)[0];
          return !!top && top.closest(".meeet-origin-marker") !== null;
        });
      });
    });
    expect(originPinsOnTop).toEqual([true, true]);

    // Station markers on MapLibre canvas use per-mode symbol layers
    const layerTypes = await page.evaluate(() => {
      const map = (window as unknown as { __meeetMap?: { getLayer: (id: string) => { type: string } | undefined; getLayoutProperty: (id: string, name: string) => unknown } }).__meeetMap;
      if (!map) throw new Error("Map instance unavailable");
      return ["meeet-stations-bus", "meeet-stations-tram", "meeet-stations-ubahn", "meeet-stations-sbahn"].map((id) => {
        const layer = map.getLayer(id);
        const image = map.getLayoutProperty(id, "icon-image");
        return { id, type: layer?.type, image };
      });
    });
    for (const layer of layerTypes) {
      expect(layer.type).toBe("symbol");
      expect(layer.image).toBeDefined();
    }

    // Strict paint order: bus < tram < ubahn < sbahn < selection outline; participant pins are DOM markers above the canvas (asserted above)
    const layerOrder = await page.evaluate(() => {
      const map = (window as unknown as { __meeetMap?: { getStyle: () => { layers: Array<{ id: string }> } } }).__meeetMap;
      if (!map) throw new Error("Map instance unavailable");
      return map.getStyle().layers.map((layer) => layer.id);
    });
    const indexOf = (id: string) => layerOrder.indexOf(id);
    expect(indexOf("meeet-stations-bus")).toBeGreaterThanOrEqual(0);
    expect(indexOf("meeet-stations-tram")).toBeGreaterThan(indexOf("meeet-stations-bus"));
    expect(indexOf("meeet-stations-ubahn")).toBeGreaterThan(indexOf("meeet-stations-tram"));
    expect(indexOf("meeet-stations-sbahn")).toBeGreaterThan(indexOf("meeet-stations-ubahn"));
    expect(indexOf("meeet-selected-station-area")).toBeGreaterThan(indexOf("meeet-stations-sbahn"));

    // Size hierarchy matches the issue #49 spec ratios: sbahn 150%, ubahn 133%, tram ~116%, bus 100% of the bus visual size
    // (visual size = image width / pixelRatio minus the padding on each side)
    const iconSizes = await page.evaluate((iconPadding: number) => {
      const map = (window as unknown as { __meeetMap?: { getImage: (id: string) => { data: { width: number }; pixelRatio: number } | undefined } }).__meeetMap;
      if (!map) throw new Error("Map instance unavailable");
      const visualSize = (id: string) => {
        const image = map.getImage(id);
        if (!image) throw new Error(`Image ${id} missing`);
        return image.data.width / image.pixelRatio - 2 * iconPadding;
      };
      return {
        sbahn: visualSize("meeet-station-sbahn-red"),
        ubahn: visualSize("meeet-station-ubahn-red"),
        tram: visualSize("meeet-station-tram-red"),
        bus: visualSize("meeet-station-bus-red"),
      };
    }, STATION_ICON_PADDING);
    expect(iconSizes.sbahn / iconSizes.bus).toBeCloseTo(STATION_ICON_SPEC_RATIOS.sbahn, 5);
    expect(iconSizes.ubahn / iconSizes.bus).toBeCloseTo(STATION_ICON_SPEC_RATIOS.ubahn, 5);
    expect(iconSizes.tram / iconSizes.bus).toBeCloseTo(STATION_ICON_SPEC_RATIOS.tram, 5);

    // Legend swatches for all classifications are visible
    for (const color of ["red", "blue", "fair", "neutral"]) {
      const swatch = page.locator(`.legend-swatch.${color}`);
      await expect(swatch).toBeVisible();
    }

    // Station list items visually reflect the mode glyphs
    const stationMarkers = page.locator(".station-area-marker");
    await expect(stationMarkers.first()).toBeVisible();
    const glyphSvg = stationMarkers.first().locator("svg.station-glyph");
    await expect(glyphSvg).toBeVisible();

    // Clicking station marker hit target on canvas selects the station area and updates details
    const canvas = page.locator(".maplibregl-canvas");
    await canvas.scrollIntoViewIfNeeded();
    const rect = await canvas.boundingBox();
    if (!rect) throw new Error("Map canvas was not painted");
    const point = await page.evaluate(() => {
      const map = (window as unknown as { __meeetMap?: { project: (coordinate: [number, number]) => { x: number; y: number } } }).__meeetMap;
      if (!map) throw new Error("Map instance unavailable");
      return map.project([11.585, 48.132]);
    });
    const request = page.waitForRequest((item) => item.url().includes("/api/meeting/station-areas/area-fair/details"));
    await page.mouse.click(rect.x + point.x, rect.y + point.y);
    await request;
    const fairArea = page.locator('[data-station-area-id="area-fair"]');
    await expect(fairArea).toHaveAttribute("aria-pressed", "true");
    const chevronTransform = await fairArea.locator(".station-chevron").evaluate((el) => getComputedStyle(el).transform);
    expect(chevronTransform).not.toBe("none");
    const glyphTransform = await fairArea.locator(".station-glyph").evaluate((el) => getComputedStyle(el).transform);
    expect(glyphTransform).toBe("none");
    await expect(page.locator(".station-detail-panel")).toContainText("Fair area");
  });

  test("discards progressive verdicts and shows error on terminal stream error", async ({ page }) => {
    await setup(page);
    await openPlanner(page);
    await selectOrigin(page, 0, "Marienplatz");
    await selectOrigin(page, 1, "Ostbahnhof");
    await page.unroute("**/api/meeting/calculate/stream");
    await page.route("**/api/meeting/calculate/stream", async (route) => {
      const requestData = route.request().postDataJSON();
      const body = `${progressStreamFrames(requestData)}${ERROR_STREAM_FRAME}`;
      await route.fulfill({ status: 200, contentType: "text/event-stream", body });
    });
    await page.getByRole("button", { name: "meeet!" }).click();
    await expect(page.locator(".form-message[role='alert']")).toContainText("scheduled service is temporarily unavailable");
    await expect(page.locator(".map-frame")).toHaveAttribute("data-station-area-count", "0");
    await expect(page.getByText("Surface ready", { exact: true })).toHaveCount(0);
  });

  test("discards progressive verdicts on cancel after markers are received", async ({ page }) => {
    let serverClosed = false;
    const server = await createStreamingTestServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write(progressFrame(CALCULATION_PROGRESS_PHASES[0]));
      res.write(progressFrame(CALCULATION_PROGRESS_PHASES[1]));
      res.write(progressFrame(CALCULATION_PROGRESS_PHASES[2]));
      res.write(verdictFrame({ stationAreaId: "area-red", name: "Red area", coordinate: { latitude: 48.132, longitude: 11.555 }, classification: "red" }));
      res.write(verdictFrame({ stationAreaId: "area-fair", name: "Fair area", coordinate: { latitude: 48.132, longitude: 11.585 }, classification: "fair" }));
      req.on("close", () => {
        serverClosed = true;
      });
    });

    try {
      await setup(page);
      await openPlanner(page);
      await selectOrigin(page, 0, "Marienplatz");
      await selectOrigin(page, 1, "Ostbahnhof");
      await page.unroute("**/api/meeting/calculate/stream");
      await page.route("**/api/meeting/calculate/stream", async (route) => {
        await route.continue({ url: server.url });
      });
      await page.getByRole("button", { name: "meeet!" }).click();
      await expect(page.locator(".map-frame")).toHaveAttribute("data-station-area-count", "2");
      await expect(page.locator(".map-frame")).toHaveAttribute("data-territory-feature-count", "0");
      await expect(page.getByText("Surface ready", { exact: true })).toHaveCount(0);
      await expect(page.getByTestId("cancel-calculation")).toBeVisible();
      await page.getByTestId("cancel-calculation").click();
      await expect(page.locator(".map-frame")).toHaveAttribute("data-station-area-count", "0");
      await expect(page.locator('[data-testid="calculation-progress"]')).toHaveCount(0);
      await expect(page.getByText("Surface ready", { exact: true })).toHaveCount(0);
      await expect.poll(() => serverClosed).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("progressively renders markers and reconciles conflicting verdicts with terminal result", async ({ page }) => {
    let deliverTerminalResult: () => void;
    const terminalGate = new Promise<void>((resolve) => { deliverTerminalResult = resolve; });
    const server = await createStreamingTestServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write(progressFrame(CALCULATION_PROGRESS_PHASES[0]));
      res.write(progressFrame(CALCULATION_PROGRESS_PHASES[1]));
      res.write(progressFrame(CALCULATION_PROGRESS_PHASES[2]));
      // Stream area-red initially as unclassified (a placeholder/conflicting verdict)
      res.write(verdictFrame({ stationAreaId: "area-red", name: "Red area", coordinate: { latitude: 48.132, longitude: 11.555 }, classification: "unclassified" }));
      res.write(verdictFrame({ stationAreaId: "area-fair", name: "Fair area", coordinate: { latitude: 48.132, longitude: 11.585 }, classification: "fair" }));
      let reqBody = "";
      req.on("data", (chunk) => { reqBody += chunk; });
      req.on("end", () => {
        void terminalGate.then(() => {
          let requestData: Parameters<typeof v3Fixture>[0];
          try {
            requestData = JSON.parse(reqBody);
          } catch {
            requestData = {
              contractVersion: "meeet-meeting/v3",
              participants: [
                { id: "participant-1", mode: "transit", origin: LOCATIONS.Marienplatz },
                { id: "participant-2", mode: "transit", origin: LOCATIONS.Ostbahnhof },
              ],
              tolerancePercent: 10,
              changeTimePreset: "medium",
              searchStartAt: new Date().toISOString(),
            };
          }
          // The authoritative fixture result overrides area-red to "red"
          const fixture = v3Fixture(requestData);
          res.write(verdictFrame({ stationAreaId: "area-blue", name: "Blue area", coordinate: { latitude: 48.132, longitude: 11.615 }, classification: "blue" }));
          res.write(verdictFrame({ stationAreaId: "area-unclassified", name: "Unclassified area", coordinate: { latitude: 48.14, longitude: 11.59 }, classification: "unclassified" }));
          res.write(progressFrame(CALCULATION_PROGRESS_PHASES[3]));
          res.write(sseFrame("ref", { calculationRef: "fixture-calculation-ref" }));
          res.write(sseFrame("result", fixture));
          res.end();
        });
      });
    });

    try {
      await setup(page);
      await openPlanner(page);
      await selectOrigin(page, 0, "Marienplatz");
      await selectOrigin(page, 1, "Ostbahnhof");
      await page.unroute("**/api/meeting/calculate/stream");
      await page.route("**/api/meeting/calculate/stream", async (route) => {
        await route.continue({ url: server.url });
      });
      await page.getByRole("button", { name: "meeet!" }).click();
      await expect(page.locator(".map-frame")).toHaveAttribute("data-station-area-count", "2");
      await expect(page.locator(".map-frame")).toHaveAttribute("data-territory-feature-count", "0");
      await expect(page.getByText("Surface ready", { exact: true })).toHaveCount(0);
      deliverTerminalResult!();
      await expect(page.getByText("Surface ready", { exact: true })).toBeVisible();
      await expect(page.locator(".map-frame")).toHaveAttribute("data-station-area-count", "4");
      await expect(page.locator(".map-frame")).toHaveAttribute("data-territory-feature-count", "3");
      // The station area index in the DOM reconciles with authoritative "red" classification
      const redAreaButton = page.locator('[data-station-area-id="area-red"]');
      await expect(redAreaButton).toHaveAttribute("data-station-area-classification", "red");
      await expect(redAreaButton).toContainText("Red territory");
    } finally {
      await server.close();
    }
  });
});

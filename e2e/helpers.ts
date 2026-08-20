import { expect, type Page } from "@playwright/test";
import { CALCULATION_PROGRESS_CONTRACT_VERSION, CALCULATION_PROGRESS_PHASES, type CalculationProgressPhase } from "../lib/domain/calculation-progress-contract";

export const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
export const MAP_ORIGIN = "https://tiles.openfreemap.org";
export const EMPTY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
export const LOCATIONS = { Marienplatz: { label: "Marienplatz", latitude: 48.1374, longitude: 11.5755 }, Ostbahnhof: { label: "Ostbahnhof", latitude: 48.1257, longitude: 11.605 } } as const;

export const PRESET_SECONDS = { quick: 180, medium: 300, long: 600 } as const;

export function v3Fixture(request: { contractVersion: "meeet-meeting/v3"; participants: Array<{ id: string; origin: { label: string; latitude: number; longitude: number }; mode: "transit" }>; tolerancePercent: 5 | 10 | 15; searchStartAt: string; changeTimePreset: "quick" | "medium" | "long" }, reason: "ok" | "no-access-seeds" = "ok") {
  const stationAreas = [
    { stationAreaId: "area-red", name: "Red area", coordinate: { latitude: 48.132, longitude: 11.555 }, mode: "sbahn" as const, classification: "red" as const, redArrivalSeconds: 1200, blueArrivalSeconds: null, fasterParticipant: "red" as const, withinSelectedTolerance: false },
    { stationAreaId: "area-fair", name: "Fair area", coordinate: { latitude: 48.132, longitude: 11.585 }, mode: "ubahn" as const, classification: "fair" as const, redArrivalSeconds: 1800, blueArrivalSeconds: 1860, fasterParticipant: "red" as const, withinSelectedTolerance: true },
    { stationAreaId: "area-blue", name: "Blue area", coordinate: { latitude: 48.132, longitude: 11.615 }, mode: "tram" as const, classification: "blue" as const, redArrivalSeconds: null, blueArrivalSeconds: 1260, fasterParticipant: "blue" as const, withinSelectedTolerance: false },
    { stationAreaId: "area-unclassified", name: "Unclassified area", coordinate: { latitude: 48.14, longitude: 11.59 }, mode: "bus" as const, classification: "unclassified" as const, redArrivalSeconds: null, blueArrivalSeconds: null, fasterParticipant: null, withinSelectedTolerance: false },
  ];
  const acquisition = { sourceUrl: "https://example.test/mvv.zip", retrievedAt: "2026-08-01T00:00:00.000Z", rawArchiveByteSize: 100, rawArchiveSha256: "a".repeat(64), feedVersion: "mvv-fixture-2026-08", feedValidFrom: "2026-08-01", feedValidUntil: "2026-08-31", attribution: "Deterministic MVV fixture", officialAttribution: "MVV", officialLicense: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" }, officialProvenance: { source: "feed" as const, policyId: null } };
  const seed = (id: string, coordinate: { latitude: number; longitude: number }) => ({ seedId: id, mvgStationId: id, stationAreaId: id, coordinate, accessSeconds: 120, provenance: { source: "fixture-static" as const, endpoint: "fixture", distanceMeters: 100, walkingSeconds: 120, note: "Deterministic browser fixture." } });
  const schedule = { contractVersion: "meeet-scheduled-routing/v1", feedId: "mvv-fixture", timeZone: "Europe/Berlin", scheduleContentHash: "b".repeat(64), compiledArtifactId: "c".repeat(64), serviceDateRange: { firstDate: "2026-08-01", lastDate: "2026-08-31" }, acquisition };
  const surface = { contractVersion: "meeet-scheduled-routing/v1", scheduleContentHash: schedule.scheduleContentHash, compiledArtifactId: schedule.compiledArtifactId, feedId: schedule.feedId, timeZone: schedule.timeZone, searchStartAt: request.searchStartAt, routingHorizonSeconds: 86400, selectedTolerancePercent: request.tolerancePercent, walkingVelocityMetersPerSecond: 1.4, walkingSecondsRoundingRule: "ceil(distanceMetres / velocityMetresPerSecond / 60) * 60, with zero distance taking zero seconds", transferRadiusMeters: 100, accessSeedCounts: reason === "no-access-seeds" ? [0, 0] as [number, number] : [1, 1] as [number, number], stationAreaCount: 2, connectionCount: 2, changeTimeSeconds: PRESET_SECONDS[request.changeTimePreset], coverage: "scheduled-service-day-local-radius/v1" as const, representativePointBasis: "station-area-coordinate/v1" as const, classificationMethod: "scheduled-arrival-comparison-with-selected-tolerance/v1" as const, classificationBasis: "scheduled-station-area-arrival/v1" as const, finalWalkingMethod: "scheduled-access-and-transfer-walking/v1" as const };
  const accessProvider = { name: "fixture MVG access", deployment: "fixture" as const, dataKind: "demo-static" as const, liveData: false, asOf: "fixture", notes: "Browser fixture", provenance: { role: "access" as const, provider: "fixture", deployment: "fixture" as const, dataKind: "demo-static" as const, liveData: false, sourceUrl: null, license: null, attribution: "Fixture", version: "fixture", retrievedAt: "fixture", notes: "Browser fixture", feeds: null } };
  return { contractVersion: "meeet-meeting/v3" as const, status: reason === "ok" ? "ok" as const : "no-result" as const, reason: reason === "ok" ? null : reason, participants: [{ id: request.participants[0]!.id, color: "red" as const, origin: request.participants[0]!.origin, mode: "transit" as const, accessSeeds: reason === "no-access-seeds" ? [] : [seed("station-red", { latitude: 48.137, longitude: 11.576 })] }, { id: request.participants[1]!.id, color: "blue" as const, origin: request.participants[1]!.origin, mode: "transit" as const, accessSeeds: reason === "no-access-seeds" ? [] : [seed("station-blue", { latitude: 48.126, longitude: 11.605 })] }], stationAreas: reason === "ok" ? stationAreas : stationAreas.map((area) => ({ ...area, classification: "unclassified" as const, redArrivalSeconds: null, blueArrivalSeconds: null, fasterParticipant: null, withinSelectedTolerance: false })), metadata: { schedule, surface, accessProvider, stationAreas: { count: 4, coverage: "official-munich-boundary-with-connected-artifact-station-areas/v1" as const, selection: "all-eligible-scheduled-station-areas/v1" as const }, coverage: "munich-scheduled-station-area-meeting/v1" as const } };
}
export function detailsFixture(request: { contractVersion: "meeet-meeting/v3"; participants: Array<{ id: string; origin: { label: string; latitude: number; longitude: number }; mode: "transit" }>; tolerancePercent: 5 | 10 | 15; searchStartAt: string; changeTimePreset: "quick" | "medium" | "long" }, areaId: string) {
  const area = v3Fixture(request).stationAreas.find((item) => item.stationAreaId === areaId)!;
  const fixture = v3Fixture(request);
  const schedule = { ...fixture.metadata.schedule, acquisition: { ...fixture.metadata.schedule.acquisition, retrievedAt: "2026-08-01T00:00:00.000Z" } };
  const participants = ["red", "blue"].map((color, index) => { const total = color === "red" ? area.redArrivalSeconds : area.blueArrivalSeconds; const origin = request.participants[index]!.origin; if (total === null) return { id: request.participants[index]!.id, color, origin, status: "unavailable", unavailableReason: area.classification === "unclassified" ? "station-area-unclassified" : "station-area-unavailable-for-participant", terminal: { totalSeconds: null, arrivalAt: null } }; const arrival = new Date(Date.parse(request.searchStartAt) + total * 1000).toISOString(); return { id: request.participants[index]!.id, color, origin, status: "available", unavailableReason: null, terminal: { totalSeconds: total, arrivalAt: arrival } }; });
  return { contractVersion: "meeet-station-area-details/v1", status: "ok", reason: null, stationArea: area, participants, basis: { contractVersion: "meeet-meeting/v3", searchStartAt: request.searchStartAt, selectedTolerancePercent: request.tolerancePercent, routingHorizonSeconds: 86400, walkingVelocityMetersPerSecond: 1.4, walkingSecondsRoundingRule: "ceil(distanceMetres / velocityMetresPerSecond / 60) * 60, with zero distance taking zero seconds", transferRadiusMeters: 100, changeTimeSeconds: PRESET_SECONDS[request.changeTimePreset], deterministicSelectionPolicy: "earliest-arrival/canonical-scan-first/v1", schedule, accessProvider: fixture.metadata.accessProvider } };
}

export const ERROR_STREAM_FRAME = 'event: error\ndata: {"code":"PROVIDER_UNAVAILABLE","message":"scheduled service is temporarily unavailable."}\n\n';

export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function progressFrame(phase: CalculationProgressPhase): string {
  return sseFrame("progress", { contractVersion: CALCULATION_PROGRESS_CONTRACT_VERSION, phase });
}

export function verdictFrame(area: { stationAreaId: string; name: string; coordinate: { latitude: number; longitude: number }; classification: string; mode?: string }): string {
  return sseFrame("station-verdict", {
    contractVersion: CALCULATION_PROGRESS_CONTRACT_VERSION,
    stationAreaId: area.stationAreaId,
    name: area.name,
    coordinate: area.coordinate,
    verdict: area.classification,
    ...(area.mode ? { mode: area.mode } : {}),
  });
}

export function progressStreamFrames(request?: Parameters<typeof v3Fixture>[0], outcome: "ok" | "no-access-seeds" = "ok"): string {
  const p1 = progressFrame(CALCULATION_PROGRESS_PHASES[0]);
  const p2 = progressFrame(CALCULATION_PROGRESS_PHASES[1]);
  const p3 = progressFrame(CALCULATION_PROGRESS_PHASES[2]);
  const verdicts = request
    ? v3Fixture(request, outcome).stationAreas.map(verdictFrame).join("")
    : "";
  const p4 = progressFrame(CALCULATION_PROGRESS_PHASES[3]);
  return `${p1}${p2}${p3}${verdicts}${p4}`;
}
export function okStreamBody(request: Parameters<typeof v3Fixture>[0], outcome: "ok" | "no-access-seeds" = "ok"): string { return `${progressStreamFrames(request, outcome)}event: ref\ndata: {"calculationRef":"fixture-calculation-ref"}\n\nevent: result\ndata: ${JSON.stringify(v3Fixture(request, outcome))}\n\n`; }

export async function setup(page: Page, outcome: "ok" | "no-access-seeds" | "error" = "ok", failMapStyle = false, mockStyle = true, streamDelayMs = 0) {
  if (mockStyle) await page.route(MAP_STYLE, (route) => failMapStyle ? route.fulfill({ status: 503, body: "fixture style unavailable" }) : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: 8, sources: { fixtureCartography: { type: "geojson", data: { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[11.54, 48.12], [11.63, 48.145]] }, properties: {} }] } } }, layers: [{ id: "background", type: "background" }, { id: "fixture-road", type: "line", source: "fixtureCartography", paint: { "line-color": "#526057", "line-width": 2 } }] }) }));
  await page.route(`${MAP_ORIGIN}/sprites/liberty.json`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })); await page.route(`${MAP_ORIGIN}/sprites/liberty.png`, (route) => route.fulfill({ status: 200, contentType: "image/png", body: EMPTY_PNG }));
  await page.route("**/api/locations/search**", async (route) => { const query = new URL(route.request().url()).searchParams.get("q") ?? ""; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ locations: [LOCATIONS[query as keyof typeof LOCATIONS] ?? { label: query, latitude: 48.1374, longitude: 11.5755 }] }) }); });
  await page.route("**/api/meeting/calculate/stream", async (route) => { if (streamDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, streamDelayMs)); try { if (outcome === "error") { await route.fulfill({ status: 200, contentType: "text/event-stream", body: ERROR_STREAM_FRAME }); return; } await route.fulfill({ status: 200, contentType: "text/event-stream", body: okStreamBody(route.request().postDataJSON(), outcome) }); } catch { /* the client aborted the request (e.g. cancel) */ } });
  await page.route("**/api/meeting/station-areas/*/details", async (route) => { const id = new URL(route.request().url()).pathname.split("/").at(-2)!; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detailsFixture(route.request().postDataJSON(), id)) }); });
}
export async function selectOrigin(page: Page, index: number, name: keyof typeof LOCATIONS) { const input = page.getByRole("combobox", { name: `Participant ${index + 1} starting point` }); await input.fill(name); await page.getByRole("listbox").getByRole("button", { name, exact: true }).click(); await expect(input).toHaveValue(name); }
export async function openPlanner(page: Page) { await page.goto("/"); await expect(page.getByRole("heading", { name: /Find the middle/ })).toBeVisible(); await expect(page.getByText("A better place to meeet", { exact: true })).toBeVisible(); await expect(page.getByRole("combobox")).toHaveCount(2); }

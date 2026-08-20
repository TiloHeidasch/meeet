import { expect, test, type Page } from "@playwright/test";
import { setup } from "./helpers";

const BASE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3100"}`;

async function openPlannerGerman(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Finde die Mitte/ })).toBeVisible();
  await expect(page.getByText("Ein besserer Ort zum Meeet", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(2);
}

async function selectGermanOrigin(page: Page, index: number, name: string) {
  const input = page.getByRole("combobox", { name: `Startpunkt von Teilnehmer ${index + 1}` });
  await input.fill(name);
  await page.getByRole("listbox").getByRole("button", { name, exact: true }).click();
  await expect(input).toHaveValue(name);
}

test.describe("client UI localization", () => {
  test("German browser preferences render the German UI", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, locale: "de-DE" });
    const page = await context.newPage();
    try {
      await setup(page, "ok", false, true, 800);
      await openPlannerGerman(page);
      await expect(page.getByText("München · MVV-Fahrplansuche", { exact: true })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Startpunkt von Teilnehmer 1" })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Startpunkt von Teilnehmer 2" })).toBeVisible();
      await expect(page.getByText("Geplanter Start", { exact: true })).toBeVisible();
      await expect(page.getByText("A better place to meeet", { exact: true })).toHaveCount(0);
      await selectGermanOrigin(page, 0, "Marienplatz");
      await selectGermanOrigin(page, 1, "Ostbahnhof");
      await page.getByRole("button", { name: "meeet!" }).click();
      await expect(page.getByText("Berechnung läuft…", { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("Non-German browser preferences fall back to English", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, locale: "fr-FR" });
    const page = await context.newPage();
    try {
      await setup(page);
      await page.goto("/");
      await expect(page.getByRole("heading", { name: /Find the middle/ })).toBeVisible();
      await expect(page.getByText("A better place to meeet", { exact: true })).toBeVisible();
      await expect(page.getByText("Munich · MVV scheduled search", { exact: true })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Participant 1 starting point" })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Participant 2 starting point" })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("German calculation renders German result, legend, and progress phases", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, locale: "de-DE" });
    const page = await context.newPage();
    try {
      await setup(page, "ok", false, true, 800);
      await openPlannerGerman(page);
      await selectGermanOrigin(page, 0, "Marienplatz");
      await selectGermanOrigin(page, 1, "Ostbahnhof");
      await page.getByRole("button", { name: "meeet!" }).click();
      const progress = page.locator('[data-testid="calculation-progress"]');
      await expect(progress).toBeVisible();
      const phases = progress.locator(".progress-phases");
      for (const label of ["Nahegelegene ÖPNV-Zugänge werden gesucht", "Geplante MVV-Verbindungen werden geprüft", "Stationsbereiche werden verglichen", "Die validierte Karte wird vorbereitet"]) {
        await expect(phases.getByText(label, { exact: true })).toBeVisible();
      }
      await expect(page.getByText("Fläche bereit", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Ein fairer Ort zum Meeet." })).toBeVisible();
      await expect(page.getByText("Rot ist schneller", { exact: false })).toBeVisible();
      await expect(page.getByText("Surface ready", { exact: true })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
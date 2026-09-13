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
      await expect(page.locator("html")).toHaveAttribute("lang", "de");
      await expect(page).toHaveTitle("meeet — einen fairen Treffpunkt finden");
      await expect(page.getByText("MVV-Gebiet · Münchner Meeting-Fläche", { exact: true })).toBeVisible();
      await expect(page.getByText("Geplante MVV-Fläche • Meeting in München • Startpunkte im MVV-Gebiet", { exact: true })).toBeVisible();
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

  test("German current-location control has a participant-specific name and localized success", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, locale: "de-DE" });
    const page = await context.newPage();
    try {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: (success: (position: unknown) => void) => success({ coords: { latitude: 48.137154, longitude: 11.576124 } }) } });
      });
      await setup(page, "ok"); await openPlannerGerman(page);
      await expect(page.getByRole("button", { name: "Meinen aktuellen Standort verwenden · Teilnehmer 1" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Meinen aktuellen Standort verwenden · Teilnehmer 2" })).toBeVisible();
      await page.getByRole("button", { name: "Meinen aktuellen Standort verwenden · Teilnehmer 1" }).click();
      await expect(page.getByRole("combobox", { name: "Startpunkt von Teilnehmer 1" })).toHaveValue("Koordinaten 48.13715, 11.57612");
      await expect(page.getByText("Aktueller Standort hinzugefügt", { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("German current-location permission errors are localized", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, locale: "de-DE" });
    const page = await context.newPage();
    try {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: (_success: unknown, failure: (error: unknown) => void) => failure({ code: 1 }) } });
      });
      await setup(page, "ok"); await openPlannerGerman(page);
      await page.getByRole("button", { name: "Meinen aktuellen Standort verwenden · Teilnehmer 2" }).click();
      await expect(page.locator("fieldset.origin-card").filter({ has: page.getByRole("combobox", { name: "Startpunkt von Teilnehmer 2" }) }).getByRole("alert")).toContainText("Der Standortzugriff wurde verweigert");
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
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page).toHaveTitle("meeet — find a fair meeting point");
      await expect(page.getByRole("heading", { name: /Find the middle/ })).toBeVisible();
      await expect(page.getByText("A better place to meeet", { exact: true })).toBeVisible();
      await expect(page.getByText("MVV area · Munich meeting surface", { exact: true })).toBeVisible();
      await expect(page.getByText("Scheduled MVV surface • Munich meeting • MVV-area origins", { exact: true })).toBeVisible();
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
      for (const label of ["Nahegelegene ÖPNV-Zugänge werden gesucht", "Geplante MVV-Verbindungen werden geprüft", "Treffpunkte werden verglichen", "Die validierte Karte wird vorbereitet"]) {
        await expect(phases.getByText(label, { exact: true })).toBeVisible();
      }
      await expect(page.getByText("Dein Ergebnis", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "1 fairer Treffpunkt gefunden" })).toBeVisible();
      await expect(page.getByText("Teilnehmer 1 kommt früher an", { exact: false })).toBeVisible();
      await expect(page.getByText("Meeting result", { exact: true })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("German missing-origin prompt references the MVV area", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, locale: "de-DE" });
    const page = await context.newPage();
    try {
      await setup(page, "ok", false, true, 800);
      await openPlannerGerman(page);
      await page.getByRole("button", { name: "meeet!" }).click();
      const fieldErrors = page.locator(".origin-card .input-error-text");
      await expect(fieldErrors).toHaveCount(2);
      await expect(fieldErrors).toHaveText([
        "Wähle einen Startpunkt im MVV-Gebiet.",
        "Wähle einen Startpunkt im MVV-Gebiet.",
      ]);
    } finally {
      await context.close();
    }
  });

  test("English missing-origin prompt references the MVV area", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, locale: "fr-FR" });
    const page = await context.newPage();
    try {
      await setup(page);
      await page.goto("/");
      await expect(page.getByRole("heading", { name: /Find the middle/ })).toBeVisible();
      await page.getByRole("button", { name: "meeet!" }).click();
      const fieldErrors = page.locator(".origin-card .input-error-text");
      await expect(fieldErrors).toHaveCount(2);
      await expect(fieldErrors).toHaveText([
        "Choose a starting point in the MVV area.",
        "Choose a starting point in the MVV area.",
      ]);
    } finally {
      await context.close();
    }
  });
});

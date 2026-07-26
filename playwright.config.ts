import { defineConfig } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "line",
  use: {
    baseURL,
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
    env: {
      MEEET_PROVIDER_MODE:
        process.env.MEEET_PROVIDER_MODE === "mvg-direct-transit"
          ? "mvg-direct-transit"
          : "fixture",
      MEEET_GEOCODING_ENDPOINT: "",
      MEEET_POI_ENDPOINT: "",
      MEEET_ROUTING_GATEWAY_URL: "",
      NEXT_PUBLIC_MAP_ATTRIBUTION: "",
      // An empty override exercises the built-in OpenFreeMap Liberty default.
      NEXT_PUBLIC_MAP_STYLE_URL: "",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: baseURL,
  },
});

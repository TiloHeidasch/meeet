import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_SCHEDULED_MIN_MEMORY_GIB,
  ProviderConfigurationError,
  readProviderConfig,
} from "../lib/providers/config.ts";

test("fixture configuration uses the deterministic scheduled memory default", () => {
  const config = readProviderConfig({ MEEET_PROVIDER_MODE: "fixture" });
  assert.equal(config.scheduledMinMemoryGiB, DEFAULT_SCHEDULED_MIN_MEMORY_GIB);
  assert.equal(config.scheduledMinMemoryGiB, 4);
});

test("configured scheduled configuration requires and exposes numeric memory capacity", () => {
  const config = readProviderConfig({
    MEEET_PROVIDER_MODE: "configured",
    MEEET_SCHEDULED_MIN_MEMORY_GIB: "4.5",
  });
  assert.equal(config.scheduledMinMemoryGiB, 4.5);
});

test("scheduled concurrency is capped at one active request", () => {
  assert.equal(readProviderConfig({
    MEEET_PROVIDER_MODE: "fixture",
    MEEET_SCHEDULED_CONCURRENCY: "1",
  }).scheduledConcurrency, 1);
  for (const mode of ["fixture", "configured"] as const) {
    assert.throws(
      () => readProviderConfig({
        MEEET_PROVIDER_MODE: mode,
        ...(mode === "configured" ? { MEEET_SCHEDULED_MIN_MEMORY_GIB: "4" } : {}),
        MEEET_SCHEDULED_CONCURRENCY: "2",
      }),
      (error: unknown) => error instanceof ProviderConfigurationError && /MEEET_SCHEDULED_CONCURRENCY/.test(error.message),
    );
  }
});

test("configured scheduled configuration rejects missing, non-numeric, and undersized memory capacity", () => {
  for (const value of [undefined, "not-a-number", "Infinity", "3.99"]) {
    assert.throws(
      () => readProviderConfig({
        MEEET_PROVIDER_MODE: "configured",
        ...(value === undefined ? {} : { MEEET_SCHEDULED_MIN_MEMORY_GIB: value }),
      }),
      (error: unknown) => error instanceof ProviderConfigurationError && /MEEET_SCHEDULED_MIN_MEMORY_GIB/.test(error.message),
    );
  }
});

const legacyScheduledKeys = [
  "MEEET_ROUTING_GATEWAY_URL",
  "MEEET_ROUTING_GATEWAY_TOKEN",
  "MEEET_ROUTING_MVG_SOURCE_URL",
  "MEEET_ROUTING_MVG_LICENSE",
  "MEEET_ROUTING_MVG_LICENSE_URL",
  "MEEET_ROUTING_MVG_ATTRIBUTION",
  "MEEET_ROUTING_MVG_VERSION",
  "MEEET_ROUTING_MVG_RETRIEVED_AT",
  "MEEET_ROUTING_MVV_SOURCE_URL",
  "MEEET_ROUTING_MVV_LICENSE",
  "MEEET_ROUTING_MVV_LICENSE_URL",
  "MEEET_ROUTING_MVV_ATTRIBUTION",
  "MEEET_ROUTING_MVV_VERSION",
  "MEEET_ROUTING_MVV_RETRIEVED_AT",
  "MEEET_POI_ENDPOINT",
  "MEEET_POI_TOKEN",
  "MEEET_POI_SOURCE_NAME",
  "MEEET_POI_SOURCE_URL",
  "MEEET_POI_LICENSE",
  "MEEET_POI_LICENSE_URL",
  "MEEET_POI_ATTRIBUTION",
  "MEEET_POI_VERSION",
  "MEEET_POI_RETRIEVED_AT",
  "MEEET_GEOCODING_ENDPOINT",
  "MEEET_GEOCODING_TOKEN",
  "MEEET_GEOCODING_SOURCE_NAME",
  "MEEET_GEOCODING_SOURCE_URL",
  "MEEET_GEOCODING_LICENSE",
  "MEEET_GEOCODING_LICENSE_URL",
  "MEEET_GEOCODING_ATTRIBUTION",
  "MEEET_GEOCODING_VERSION",
  "MEEET_GEOCODING_RETRIEVED_AT",
] as const;

for (const key of legacyScheduledKeys) {
  test(`rejects legacy scheduled provider setting ${key}`, () => {
    assert.throws(
      () => readProviderConfig({
        MEEET_PROVIDER_MODE: "fixture",
        [key]: "legacy-setting",
      }),
      (error: unknown) => error instanceof ProviderConfigurationError && error.message.includes(key),
    );
  });
}

test("page capability seam does not initialize the meeting provider factory or schedule artifact", () => {
  const page = readFileSync(join(process.cwd(), "app/page.tsx"), "utf8");
  assert.match(page, /readProviderConfig/);
  assert.doesNotMatch(page, /createMeetingProviders|loadScheduledArtifact/);
});

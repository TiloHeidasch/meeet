import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SCHEDULED_MIN_MEMORY_GIB,
  ProviderConfigurationError,
  readProviderConfig,
} from "../lib/providers/config.ts";

test("configured provider config defaults absent scheduled memory to the conservative policy", () => {
  const config = readProviderConfig({
    MEEET_PROVIDER_MODE: "configured",
    MEEET_SCHEDULE_ARTIFACT_PATH: "/tmp/missing-artifact.json",
  });
  assert.equal(config.scheduledMinMemoryGiB, DEFAULT_SCHEDULED_MIN_MEMORY_GIB);
  assert.equal(config.scheduledMinMemoryGiB, 4);
});

test("scheduled memory rejects supplied non-integer and undersized declarations", () => {
  for (const value of ["not-a-number", "4.5", "Infinity", "3.99", "3"]) {
    assert.throws(
      () => readProviderConfig({
        MEEET_PROVIDER_MODE: "configured",
        MEEET_SCHEDULED_MIN_MEMORY_GIB: value,
      }),
      (error: unknown) => error instanceof ProviderConfigurationError && /MEEET_SCHEDULED_MIN_MEMORY_GIB/.test(error.message),
    );
  }
});

test("one-concurrency and 90-second scheduled policy defaults remain unchanged", () => {
  const config = readProviderConfig({ MEEET_PROVIDER_MODE: "fixture" });
  assert.equal(config.scheduledConcurrency, 1);
  assert.equal(config.scheduledDeadlineMs, 90_000);
  assert.throws(
    () => readProviderConfig({ MEEET_PROVIDER_MODE: "fixture", MEEET_SCHEDULED_CONCURRENCY: "2" }),
    /MEEET_SCHEDULED_CONCURRENCY/,
  );
  assert.throws(
    () => readProviderConfig({ MEEET_PROVIDER_MODE: "fixture", MEEET_SCHEDULED_DEADLINE_MS: "89999" }),
    /MEEET_SCHEDULED_DEADLINE_MS/,
  );
});

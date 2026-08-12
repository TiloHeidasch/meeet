import "server-only";

import type { MeetingProviders } from "../domain/providers.ts";
import {
  readProviderConfig,
  type ProviderConfig,
  type ProviderEnvironment,
} from "./config.ts";
import { loadScheduledArtifact } from "../domain/scheduled-routing/artifact.ts";
import { FIXTURE_SCHEDULED_ACCESS_PROVIDER, FIXTURE_SCHEDULED_ARTIFACT } from "../fixtures/scheduled-routing.ts";
import { MvgScheduledAccessSeedProvider } from "./mvg-scheduled-access.ts";

export function createMeetingProviders(
  env: ProviderEnvironment = process.env,
): MeetingProviders {
  const config = readProviderConfig(env);
  if (config.mode === "fixture") {
    return withMapConfiguration({
      scheduledArtifact: FIXTURE_SCHEDULED_ARTIFACT,
      scheduledAccess: FIXTURE_SCHEDULED_ACCESS_PROVIDER,
      scheduledConcurrency: config.scheduledConcurrency,
      scheduledDeadlineMs: config.scheduledDeadlineMs,
    }, config);
  }
  return withMapConfiguration(withScheduledArtifact({
    scheduledAccess: new MvgScheduledAccessSeedProvider(config),
    scheduledConcurrency: config.scheduledConcurrency,
    scheduledDeadlineMs: config.scheduledDeadlineMs,
  }, config.scheduledArtifactPath), config);
}

function withMapConfiguration(
  providers: MeetingProviders,
  config: ProviderConfig,
): MeetingProviders {
  const descriptors = Object.getOwnPropertyDescriptors(providers);
  descriptors.mapConfiguration = {
    configurable: true,
    enumerable: true,
    writable: true,
    value: {
      source: "client-configured",
      styleUrl: config.mapStyleUrl,
      attribution: config.mapAttribution,
    },
  };
  return Object.defineProperties({}, descriptors) as MeetingProviders;
}

function withScheduledArtifact(
  providers: MeetingProviders,
  path: string | null,
): MeetingProviders {
  const descriptors = Object.getOwnPropertyDescriptors(providers);
  descriptors.scheduledArtifact = path === null
    ? { configurable: true, enumerable: true, writable: true, value: undefined }
    : {
        configurable: true,
        enumerable: true,
        writable: true,
        value: loadScheduledArtifact(path),
      };
  return Object.defineProperties({}, descriptors) as MeetingProviders;
}

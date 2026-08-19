import "server-only";

import type { MeetingProviders, PointToPointRoutingProvider } from "../domain/providers.ts";
import {
  CalculationUnavailableRoutingProvider,
  GraphHopperRoutingProvider,
  OtpGraphqlRoutingProvider,
} from "./self-hosted-routing.ts";
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
    const providers = config.scheduledArtifactPath === null
      ? { scheduledArtifact: FIXTURE_SCHEDULED_ARTIFACT, scheduledAccess: FIXTURE_SCHEDULED_ACCESS_PROVIDER }
      : withScheduledArtifact({ scheduledAccess: FIXTURE_SCHEDULED_ACCESS_PROVIDER }, config.scheduledArtifactPath);
    return withMapConfiguration(providers, config);
  }
  if (config.mode === "self-hosted-routing") {
    if (!config.selfHostedRouting) throw new Error("Self-hosted routing manifest configuration is missing.");
    return withMapConfiguration(withScheduledArtifact({
      scheduledAccess: new MvgScheduledAccessSeedProvider(config),
      routing: new CalculationUnavailableRoutingProvider(config.selfHostedRouting.snapshot),
      routingSnapshot: config.selfHostedRouting.snapshot,
      routingFoundation: {
        state: "configured-foundation",
        calculationAvailable: false,
        reason: "calculation-not-migrated",
        supportedModes: ["transit", "bike", "car"],
        snapshot: config.selfHostedRouting.snapshot,
        applicationState: config.selfHostedRouting.applicationState,
      },
    }, config.scheduledArtifactPath), config);
  }
  return withMapConfiguration(withScheduledArtifact({
    scheduledAccess: new MvgScheduledAccessSeedProvider(config),
  }, config.scheduledArtifactPath), config);
}

export interface SelfHostedRoutingAdapters {
  transit: PointToPointRoutingProvider;
  bikeCar: PointToPointRoutingProvider;
  snapshot: NonNullable<ProviderConfig["selfHostedRouting"]>["snapshot"];
  engineSnapshots: NonNullable<ProviderConfig["selfHostedRouting"]>["engineSnapshots"];
}

export function createSelfHostedRoutingAdapters(
  config: ProviderConfig,
  fetchImplementation?: typeof fetch,
): SelfHostedRoutingAdapters {
  if (config.mode !== "self-hosted-routing" || !config.selfHostedRouting) {
    throw new Error("Self-hosted routing adapters require self-hosted-routing provider configuration.");
  }
  return {
    transit: new OtpGraphqlRoutingProvider(config.selfHostedRouting, fetchImplementation),
    bikeCar: new GraphHopperRoutingProvider(config.selfHostedRouting, fetchImplementation),
    snapshot: config.selfHostedRouting.snapshot,
    engineSnapshots: config.selfHostedRouting.engineSnapshots,
  };
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

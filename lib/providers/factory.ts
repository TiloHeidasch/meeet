import "server-only";

import type { MeetingProviders, PointToPointRoutingProvider } from "../domain/providers.ts";
import { fixtureProviders } from "../fixtures/providers.ts";
import { GatewayRoutingProvider, HttpGeocodingProvider, HttpPoiProvider } from "./adapters.ts";
import { MvgDirectRoutingProvider } from "./mvg-direct.ts";
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
import { createUnconfiguredProviders } from "./unconfigured.ts";

export function createMeetingProviders(
  env: ProviderEnvironment = process.env,
): MeetingProviders {
  const config = readProviderConfig(env);
  if (config.mode === "fixture") {
    return withMapConfiguration(fixtureProviders, config);
  }
  if (config.mode === "mvg-direct-transit") {
    const direct = new MvgDirectRoutingProvider(config);
    return withMapConfiguration(
      {
        geocoding: fixtureProviders.geocoding,
        routing: direct,
        journey: direct,
        routeAlternatives: direct,
        poi: fixtureProviders.poi,
      },
      config,
    );
  }
  if (config.mode === "self-hosted-routing") {
    // The route-first adapters are intentionally exposed separately below.
    // Keep the existing meeting calculation on its current gateway seam until
    // the route-first domain migration is approved.
    if (!config.selfHostedRouting) throw new Error("Self-hosted routing manifest configuration is missing.");
    const configured = createConfiguredProviders(config);
    return withMapConfiguration({
      ...configured,
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
    }, config);
  }
  return withMapConfiguration(createConfiguredProviders(config), config);
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
  return {
    ...providers,
    mapConfiguration: {
      source: "client-configured",
      styleUrl: config.mapStyleUrl,
      attribution: config.mapAttribution,
    },
  };
}

function createConfiguredProviders(config: ProviderConfig): MeetingProviders {
  const unconfigured = createUnconfiguredProviders();
  return {
    geocoding: config.geocodingUrl
      ? new HttpGeocodingProvider(config)
      : unconfigured.geocoding,
    routing: config.routingGatewayUrl
      ? new GatewayRoutingProvider(config)
      : unconfigured.routing,
    poi: config.poiUrl ? new HttpPoiProvider(config) : unconfigured.poi,
  };
}

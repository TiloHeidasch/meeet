import "server-only";

import type { MeetingProviders } from "../domain/providers.ts";
import { fixtureProviders } from "../fixtures/providers.ts";
import { GatewayRoutingProvider, HttpGeocodingProvider, HttpPoiProvider } from "./adapters.ts";
import { MvgDirectRoutingProvider } from "./mvg-direct.ts";
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
    return withMapConfiguration(
      {
        geocoding: fixtureProviders.geocoding,
        routing: new MvgDirectRoutingProvider(config),
        poi: fixtureProviders.poi,
      },
      config,
    );
  }
  return withMapConfiguration(createConfiguredProviders(config), config);
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

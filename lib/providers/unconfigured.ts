import "server-only";

import {
  ProviderNotConfiguredError,
} from "../domain/meeting.ts";
import type {
  GeocodingProvider,
  MeetingProviders,
  PoiProvider,
  RoutingProvider,
} from "../domain/providers.ts";
import type {
  ProviderDescriptor,
  ProviderProvenance,
} from "../domain/types.ts";

const descriptorProvenance: ProviderProvenance = {
  role: "routing",
  provider: "unconfigured-provider",
  deployment: "unknown",
  dataKind: "unknown",
  liveData: false,
  sourceUrl: null,
  license: null,
  attribution: "No configured provider attribution.",
  version: "not-configured",
  retrievedAt: "not-configured",
  notes: "No provider endpoint is configured; this adapter deliberately has no public-service fallback.",
  feeds: null,
};
const descriptor: ProviderDescriptor = {
  name: "unconfigured-provider",
  deployment: "unknown",
  dataKind: "unknown",
  liveData: false,
  asOf: "not-configured",
  notes: "No provider endpoint is configured; this adapter deliberately has no public-service fallback.",
  provenance: descriptorProvenance,
};

class UnconfiguredGeocodingProvider implements GeocodingProvider {
  readonly descriptor = {
    ...descriptor,
    name: "unconfigured-geocoding-provider",
    provenance: { ...descriptorProvenance, role: "geocoding" as const },
  };

  async resolveLocation(): Promise<never> {
    throw new ProviderNotConfiguredError("geocoding");
  }
}

class UnconfiguredRoutingProvider implements RoutingProvider {
  readonly descriptor = { ...descriptor, name: "unconfigured-routing-provider" };

  async getTravelTimeMatrix(): Promise<never> {
    throw new ProviderNotConfiguredError("routing");
  }
}

class UnconfiguredPoiProvider implements PoiProvider {
  readonly descriptor = {
    ...descriptor,
    name: "unconfigured-poi-provider",
    provenance: { ...descriptorProvenance, role: "poi" as const },
  };

  async findFoodAndDrink(): Promise<never> {
    throw new ProviderNotConfiguredError("poi");
  }
}

export function createUnconfiguredProviders(): MeetingProviders {
  return {
    geocoding: new UnconfiguredGeocodingProvider(),
    routing: new UnconfiguredRoutingProvider(),
    poi: new UnconfiguredPoiProvider(),
  };
}

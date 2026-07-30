import "server-only";

import type {
  GeoJsonGeometry,
  MeetingLocation,
  MeetingPointOfInterest,
  ProviderDescriptor,
  ResolvedLocation,
  RoutingMatrixRequest,
  RoutingMatrixResponse,
  RouteAlternativeDiscoveryRequest,
  RouteAlternativeDiscoveryResult,
  MapConfigurationProvenance,
  RoutingProviderCapabilities,
} from "./types.ts";
import { TRAVEL_MODES } from "./types.ts";

export const FULL_ROUTING_PROVIDER_CAPABILITIES: RoutingProviderCapabilities = {
  supportedModes: TRAVEL_MODES,
  maxParticipants: 4,
  maxDestinations: 400,
  maxMatrixEntries: 1600,
};

/** Server-only boundary for replacing fixture geocoding in Phase 2. */
export interface GeocodingProvider {
  readonly descriptor: ProviderDescriptor;
  resolveLocation(location: MeetingLocation): Promise<ResolvedLocation>;
}

/**
 * Server-only bounded batch boundary for replacing fixture routing in Phase 2.
 * One request owns one departure instant and all requested participant modes.
 */
export interface RoutingProvider {
  readonly descriptor: ProviderDescriptor;
  readonly capabilities: RoutingProviderCapabilities;
  getTravelTimeMatrix(request: RoutingMatrixRequest): Promise<RoutingMatrixResponse>;
}

/** Separate bounded boundary for finite provider-returned route alternatives. */
export interface RouteAlternativeProvider {
  readonly descriptor: ProviderDescriptor;
  discoverRouteAlternatives(
    request: RouteAlternativeDiscoveryRequest,
  ): Promise<RouteAlternativeDiscoveryResult>;
}

/** Server-only boundary for replacing static demo POIs in Phase 2. */
export interface PoiProvider {
  readonly descriptor: ProviderDescriptor;
  findFoodAndDrink(
    corridor: GeoJsonGeometry,
  ): Promise<readonly MeetingPointOfInterest[]>;
}

export interface MeetingProviders {
  geocoding: GeocodingProvider;
  routing: RoutingProvider;
  poi: PoiProvider;
  routeAlternatives?: RouteAlternativeProvider;
  mapConfiguration?: MapConfigurationProvenance;
}

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
  RoutingFoundationCapability,
  RoutingSnapshot,
  PointToPointRoutingRequest,
  PointToPointRoutingResult,
  SelfHostedRoutingAdapterDescriptor,
} from "./types.ts";
import type { RouteEnumerationInput, RouteEnumerationResult } from "./route-first/index.ts";
import { TRAVEL_MODES } from "./types.ts";

export const FULL_ROUTING_PROVIDER_CAPABILITIES: RoutingProviderCapabilities = {
  supportedModes: TRAVEL_MODES,
  maxParticipants: 4,
  maxDestinations: 400,
  maxMatrixEntries: 1600,
};

export const UNAVAILABLE_ROUTING_PROVIDER_CAPABILITIES: RoutingProviderCapabilities = {
  supportedModes: [],
  maxParticipants: 0,
  maxDestinations: 0,
  maxMatrixEntries: 0,
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

/** Domain boundary for bounded route-first point-to-point adapters. */
export interface PointToPointRoutingProvider {
  readonly descriptor: SelfHostedRoutingAdapterDescriptor;
  route(request: PointToPointRoutingRequest): Promise<PointToPointRoutingResult>;
}

/** Pure domain boundary for a complete or honestly incomplete route enumeration. */
export interface RouteFirstEnumerationProvider {
  enumerateRoutes(input: RouteEnumerationInput): RouteEnumerationResult;
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
  /** Route-first snapshot identity; calculation does not consume it yet. */
  routingSnapshot?: RoutingSnapshot;
  routingFoundation?: RoutingFoundationCapability;
  mapConfiguration?: MapConfigurationProvenance;
}

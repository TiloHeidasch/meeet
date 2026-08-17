import "server-only";

import type {
  GeoJsonGeometry,
  MeetingLocation,
  MeetingPointOfInterest,
  ProviderDescriptor,
  ResolvedLocation,
  RoutingMatrixRequest,
  RoutingMatrixResponse,
  MapConfigurationProvenance,
  RoutingProviderCapabilities,
  RoutingFoundationCapability,
  RoutingSnapshot,
  PointToPointRoutingRequest,
  PointToPointRoutingResult,
  SelfHostedRoutingAdapterDescriptor,
  LocationCoordinate,
} from "./types.ts";
import type { RouteEnumerationInput, RouteEnumerationResult } from "./route-first/index.ts";
import { TRAVEL_MODES } from "./types.ts";
import type { ScheduledRoutingArtifact } from "./scheduled-routing/models.ts";

export class ProviderUnavailableError extends Error {
  readonly providerRole: "geocoding" | "routing" | "poi";

  constructor(providerRole: "geocoding" | "routing" | "poi") {
    super(`The ${providerRole} provider is unavailable.`);
    this.name = "ProviderUnavailableError";
    this.providerRole = providerRole;
  }
}

export class ProviderNotConfiguredError extends Error {
  readonly providerRole: "geocoding" | "routing" | "poi";

  constructor(providerRole: "geocoding" | "routing" | "poi") {
    super(`The ${providerRole} provider is not configured.`);
    this.name = "ProviderNotConfiguredError";
    this.providerRole = providerRole;
  }
}

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

export interface ScheduledAccessSeedProvenance {
  readonly source: "mvg-nearby" | "fixture-static";
  readonly endpoint: string;
  readonly distanceMeters: number;
  readonly walkingSeconds: number;
  readonly note: string;
}

export interface ScheduledAccessSeedCandidate {
  readonly seedId: string;
  readonly mvgStationId: string;
  readonly stationAreaId: string;
  readonly coordinate: LocationCoordinate;
  readonly accessSeconds: number;
  readonly provenance: ScheduledAccessSeedProvenance;
}

export interface ScheduledAccessSeedRequest {
  readonly origin: LocationCoordinate;
  readonly schedule: ScheduledRoutingArtifact;
  readonly signal?: AbortSignal;
}

/** Nearby access only; implementations must not expose or call journey routing. */
export interface ScheduledAccessSeedProvider {
  readonly descriptor: ProviderDescriptor;
  resolveAccessSeeds(request: ScheduledAccessSeedRequest): Promise<readonly ScheduledAccessSeedCandidate[]>;
}

export interface MeetingProviders {
  geocoding?: GeocodingProvider;
  routing?: RoutingProvider;
  poi?: PoiProvider;
  /** Route-first snapshot identity; calculation does not consume it yet. */
  routingSnapshot?: RoutingSnapshot;
  routingFoundation?: RoutingFoundationCapability;
  mapConfiguration?: MapConfigurationProvenance;
  scheduledArtifact?: ScheduledRoutingArtifact;
  scheduledAccess?: ScheduledAccessSeedProvider;
}

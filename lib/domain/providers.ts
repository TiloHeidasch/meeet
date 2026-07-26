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
} from "./types.ts";

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
  getTravelTimeMatrix(request: RoutingMatrixRequest): Promise<RoutingMatrixResponse>;
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
  mapConfiguration?: MapConfigurationProvenance;
}

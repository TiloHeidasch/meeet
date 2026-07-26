import { haversineDistanceKm, isPointInGeoJsonGeometry } from "../domain/geo.ts";
import type {
  MeetingLocation,
  MeetingPointOfInterest,
  ProviderDescriptor,
  ProviderProvenance,
  ResolvedLocation,
  RoutingMatrixCell,
  RoutingMatrixRequest,
  RoutingMatrixResponse,
  TravelMode,
} from "../domain/types.ts";
import type {
  GeocodingProvider,
  MeetingProviders,
  PoiProvider,
  RoutingProvider,
} from "../domain/providers.ts";
import { FIXTURE_POIS } from "./poi-data.ts";

export const FIXTURE_PROVIDER_VERSION = "munich-phase-1-demo-fixture-v2";
export const FIXTURE_APPROXIMATION_NOTICE =
  "Local deterministic approximation only. No external services are contacted; these fixtures contain neither MVG/MVV timetable data nor live data.";

const ROUTING_PROFILES: Record<
  TravelMode,
  { speedKmPerHour: number; fixedMinutes: number }
> = {
  transit: { speedKmPerHour: 25, fixedMinutes: 8 },
  bike: { speedKmPerHour: 17, fixedMinutes: 3 },
  car: { speedKmPerHour: 27, fixedMinutes: 4 },
};

function createDescriptor(
  name: string,
  role: "geocoding" | "routing" | "poi",
): ProviderDescriptor {
  const provenance: ProviderProvenance = {
    role,
    provider: name,
    deployment: "fixture",
    dataKind: "demo-static",
    liveData: false,
    sourceUrl: null,
    license: null,
    attribution: "Local deterministic demo fixture entries; no MVG/MVV feed data.",
    version: FIXTURE_PROVIDER_VERSION,
    retrievedAt: "fixture-static",
    notes: FIXTURE_APPROXIMATION_NOTICE,
    feeds: null,
  };
  return {
    name,
    deployment: "fixture",
    dataKind: "demo-static",
    liveData: false,
    asOf: FIXTURE_PROVIDER_VERSION,
    notes: FIXTURE_APPROXIMATION_NOTICE,
    provenance,
  };
}

export class FixtureGeocodingProvider implements GeocodingProvider {
  readonly descriptor = createDescriptor("local-demo-fixture-geocoding", "geocoding");

  async resolveLocation(location: MeetingLocation): Promise<ResolvedLocation> {
    return { ...location, source: this.descriptor.name };
  }
}

export class FixtureRoutingProvider implements RoutingProvider {
  readonly descriptor = createDescriptor("local-demo-fixture-routing", "routing");

  async getTravelTimeMatrix(
    request: RoutingMatrixRequest,
  ): Promise<RoutingMatrixResponse> {
    const travelTimes: RoutingMatrixCell[] = [];
    for (const participant of request.participants) {
      const profile = ROUTING_PROFILES[participant.mode];
      for (const destination of request.destinations) {
        const distanceKm = haversineDistanceKm(
          participant.origin,
          destination.coordinate,
        );
        const minutes =
          profile.fixedMinutes + (distanceKm / profile.speedKmPerHour) * 60;
        travelTimes.push({
          participantId: participant.participantId,
          destinationId: destination.id,
          mode: participant.mode,
          status: "ok",
          minutes: Number(minutes.toFixed(1)),
          source: this.descriptor.name,
        });
      }
    }

    return {
      contractVersion: "meeet-routing-gateway/v1",
      departureAt: request.departureAt,
      travelTimes,
    };
  }
}

export class FixturePoiProvider implements PoiProvider {
  readonly descriptor = createDescriptor("demo-static-food-and-drink-entries", "poi");

  async findFoodAndDrink(
    corridor: Parameters<typeof isPointInGeoJsonGeometry>[1],
  ): Promise<readonly MeetingPointOfInterest[]> {
    return FIXTURE_POIS.filter((poi) =>
      isPointInGeoJsonGeometry(poi.coordinates, corridor),
    );
  }
}

export const fixtureProviders: MeetingProviders = {
  geocoding: new FixtureGeocodingProvider(),
  routing: new FixtureRoutingProvider(),
  poi: new FixturePoiProvider(),
};

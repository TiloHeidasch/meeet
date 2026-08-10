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
  CoordinateJourney,
  CoordinateJourneyRequest,
  CoordinateJourneyResult,
  JourneyEndpoint,
} from "../domain/types.ts";
import type {
  GeocodingProvider,
  MeetingProviders,
  PoiProvider,
  CoordinateJourneyProvider,
  RoutingProvider,
} from "../domain/providers.ts";
import { FULL_ROUTING_PROVIDER_CAPABILITIES } from "../domain/providers.ts";
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

export class FixtureRoutingProvider implements RoutingProvider, CoordinateJourneyProvider {
  readonly descriptor = createDescriptor("local-demo-fixture-routing", "routing");
  readonly capabilities = FULL_ROUTING_PROVIDER_CAPABILITIES;

  async getCoordinateJourneys(
    request: CoordinateJourneyRequest,
  ): Promise<CoordinateJourneyResult> {
    const arrivalTimestamp = Date.parse(request.arrivalAt);
    if (!Number.isFinite(arrivalTimestamp)) throw new Error("Fixture journey requires a valid arrivalAt.");
    const viaCoordinate = request.viaStationGlobalId
      ? fixtureAnchorCoordinate(request.viaStationGlobalId)
      : null;
    const originStation: JourneyEndpoint = {
      stationGlobalId: `fixture:origin:${request.origin.latitude}:${request.origin.longitude}`,
      coordinate: request.origin,
    };
    const destinationStation: JourneyEndpoint = {
      stationGlobalId: `fixture:destination:${request.destination.latitude}:${request.destination.longitude}`,
      coordinate: request.destination,
    };
    const totalMilliseconds = Math.max(
      180_000,
      Math.round((5 + haversineDistanceKm(request.origin, request.destination) * 60 + (viaCoordinate ? 2 : 0)) * 60_000),
    );
    const departureTimestamp = arrivalTimestamp - totalMilliseconds;
    const walkMilliseconds = 60_000;
    const transitStart = departureTimestamp + walkMilliseconds;
    const transitEnd = arrivalTimestamp - walkMilliseconds;
    const transitStops = viaCoordinate
      ? [originStation, { stationGlobalId: request.viaStationGlobalId!, coordinate: viaCoordinate }, destinationStation]
      : [originStation, destinationStation];
    const parts = transitStops.slice(0, -1).map((from, index) => ({
      kind: "transit" as const,
      from,
      to: transitStops[index + 1],
      intermediateStops: [],
      line: { identity: "fixture-bus", type: "BUS" },
      geometry: null,
      plannedDepartureAt: new Date(transitStart + ((transitEnd - transitStart) * index) / (transitStops.length - 1)).toISOString(),
      plannedArrivalAt: new Date(transitStart + ((transitEnd - transitStart) * (index + 1)) / (transitStops.length - 1)).toISOString(),
    }));
    const journey: CoordinateJourney = {
      transitStops,
      parts: [
        {
          kind: "walking",
          from: { stationGlobalId: null, coordinate: request.origin },
          to: originStation,
          intermediateStops: [],
          line: null,
          geometry: null,
          plannedDepartureAt: new Date(departureTimestamp).toISOString(),
          plannedArrivalAt: new Date(transitStart).toISOString(),
        },
        ...parts,
        {
          kind: "walking",
          from: destinationStation,
          to: { stationGlobalId: null, coordinate: request.destination },
          intermediateStops: [],
          line: null,
          geometry: null,
          plannedDepartureAt: new Date(transitEnd).toISOString(),
          plannedArrivalAt: new Date(arrivalTimestamp).toISOString(),
        },
      ],
      plannedDepartureAt: new Date(departureTimestamp).toISOString(),
      plannedArrivalAt: new Date(arrivalTimestamp).toISOString(),
      plannedDurationMilliseconds: totalMilliseconds,
    };
    return { journeys: [journey], source: this.descriptor.name };
  }

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

function fixtureAnchorCoordinate(id: string): { latitude: number; longitude: number } {
  const coordinates: Record<string, { latitude: number; longitude: number }> = {
    "de:09162:6": { latitude: 48.1402, longitude: 11.5586 },
    "de:09162:50": { latitude: 48.1346, longitude: 11.5683 },
    "de:09162:70": { latitude: 48.1509, longitude: 11.5814 },
    "de:09162:1170": { latitude: 48.1186, longitude: 11.5894 },
    "de:09162:190": { latitude: 48.1533, longitude: 11.5386 },
    "de:09162:350": { latitude: 48.1734, longitude: 11.5461 },
  };
  return coordinates[id] ?? { latitude: 48.1374, longitude: 11.5755 };
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

const fixtureRouting = new FixtureRoutingProvider();

export const fixtureProviders: MeetingProviders = {
  geocoding: new FixtureGeocodingProvider(),
  routing: fixtureRouting,
  journey: fixtureRouting,
  poi: new FixturePoiProvider(),
};

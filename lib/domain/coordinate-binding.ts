import { haversineDistanceKm } from "./geo.ts";
import type {
  CoordinateJourneyPart,
  JourneyEndpoint,
  LocationCoordinate,
  ParticipantOriginEndpoint,
} from "./types.ts";

/** Coordinate binding for destinations, identified endpoints, and handoffs allows up to 100m. */
export const COORDINATE_BINDING_TOLERANCE_METRES = 100;
/** Public coordinate journeys may snap an anonymous participant origin within 100m. */
export const ANONYMOUS_PARTICIPANT_ORIGIN_SNAP_TOLERANCE_METRES = 100;

/**
 * Apply the canonical outer-endpoint policy without coupling the domain to a
 * routing adapter. An anonymous first or final walking participant origin may
 * be rebound within the public snap tolerance; the other outer endpoint remains
 * strictly bound.
 */
export function bindCoordinateJourneyEndpoints(
  parts: readonly CoordinateJourneyPart[],
  requestedOrigin: LocationCoordinate,
  requestedDestination: LocationCoordinate,
  participantOriginEndpoint: ParticipantOriginEndpoint,
): readonly CoordinateJourneyPart[] | null {
  if (participantOriginEndpoint !== "origin" && participantOriginEndpoint !== "destination") return null;
  const first = parts[0];
  const last = parts.at(-1);
  if (!first || !last) return null;

  const participantOrigin = participantOriginEndpoint === "origin"
    ? first.from
    : last.to;
  const requestedParticipantOrigin = participantOriginEndpoint === "origin"
    ? requestedOrigin
    : requestedDestination;
  const anonymousParticipantOrigin = participantOriginEndpoint === "origin"
    ? first.kind === "walking" && first.from.stationGlobalId === null
    : last.kind === "walking" && last.to.stationGlobalId === null;
  const boundParticipantOrigin = anonymousParticipantOrigin
    ? bindAnonymousParticipantOrigin(participantOrigin, requestedParticipantOrigin)
    : isWithinCoordinateBindingTolerance(participantOrigin.coordinate, requestedParticipantOrigin)
      ? participantOrigin
      : null;
  if (!boundParticipantOrigin) return null;

  const firstBound = participantOriginEndpoint === "origin"
    ? boundParticipantOrigin
    : isWithinCoordinateBindingTolerance(first.from.coordinate, requestedOrigin)
      ? first.from
      : null;
  const lastBound = participantOriginEndpoint === "destination"
    ? boundParticipantOrigin
    : isWithinCoordinateBindingTolerance(last.to.coordinate, requestedDestination)
      ? last.to
      : null;
  if (!firstBound || !lastBound) return null;
  if (firstBound === first.from && lastBound === last.to) return parts;
  return parts.map((part, index) => ({
    ...part,
    ...(index === 0 ? { from: firstBound } : {}),
    ...(index === parts.length - 1 ? { to: lastBound } : {}),
  }));
}

export function isWithinCoordinateBindingTolerance(
  first: LocationCoordinate,
  second: LocationCoordinate,
  toleranceMetres = COORDINATE_BINDING_TOLERANCE_METRES,
): boolean {
  return haversineDistanceKm(first, second) * 1_000 <= toleranceMetres;
}

function bindAnonymousParticipantOrigin(
  endpoint: JourneyEndpoint,
  requestedOrigin: LocationCoordinate,
): JourneyEndpoint | null {
  if (!isWithinCoordinateBindingTolerance(
    endpoint.coordinate,
    requestedOrigin,
    ANONYMOUS_PARTICIPANT_ORIGIN_SNAP_TOLERANCE_METRES,
  )) return null;
  return {
    ...endpoint,
    coordinate: {
      latitude: requestedOrigin.latitude,
      longitude: requestedOrigin.longitude,
    },
  };
}

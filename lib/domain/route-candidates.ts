import type {
  LocationCoordinate,
  RouteAlternative,
  RouteCandidate,
  RouteStationReference,
} from "./types.ts";

/**
 * Canonical identity for one timed itinerary. Coordinates and realtime are
 * deliberately excluded so the identity remains stable for the same payload.
 */
export function routeItineraryIdentity(alternative: Pick<
  RouteAlternative,
  "origin" | "destination" | "parts"
>): string {
  return `itinerary:${JSON.stringify({
    origin: alternative.origin.id,
    destination: alternative.destination.id,
    parts: alternative.parts.map((part) => ({
      from: part.from.id,
      to: part.to.id,
      lineIdentity: part.line.identity,
      lineType: part.line.type,
      plannedDepartureAt: part.plannedDepartureAt,
      plannedArrivalAt: part.plannedArrivalAt,
    })),
  })}`;
}

/** Structural path identity without planned timing or realtime state. */
export function routeStructuralPathIdentity(alternative: Pick<
  RouteAlternative,
  "origin" | "destination" | "parts"
>): string {
  return `path:${JSON.stringify({
    origin: alternative.origin.id,
    destination: alternative.destination.id,
    parts: alternative.parts.map((part) => ({
      from: part.from.id,
      to: part.to.id,
      lineIdentity: part.line.identity,
      lineType: part.line.type,
    })),
  })}`;
}

/** Select the actual route-part endpoint nearest the effective midpoint. */
export function selectRouteMidpointCandidate(
  alternative: RouteAlternative,
): RouteCandidate | null {
  const start = Date.parse(alternative.effectiveDepartureAt);
  const end = Date.parse(alternative.effectiveArrivalAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;

  const midpoint = start + (end - start) / 2;
  const endpoints: Array<{
    station: RouteStationReference;
    timestamp: number;
    order: number;
  }> = [];
  let order = 0;
  for (const part of alternative.parts) {
    addEndpoint(endpoints, part.from, part.effectiveDepartureAt, order++);
    addEndpoint(endpoints, part.to, part.effectiveArrivalAt, order++);
  }

  if (endpoints.length === 0) return null;
  endpoints.sort((left, right) => {
    const distance = Math.abs(left.timestamp - midpoint) - Math.abs(right.timestamp - midpoint);
    if (distance !== 0) return distance;
    const stationId = left.station.id.localeCompare(right.station.id);
    return stationId !== 0 ? stationId : left.order - right.order;
  });
  const selected = endpoints[0];
  const coordinate = selected.station.coordinate;
  if (!coordinate) return null;
  return {
    id: `route-station:${selected.station.id}`,
    kind: "route-part-endpoint",
    coordinate,
    label: selected.station.id,
    station: selected.station,
    alternativeIdentity: alternative.itineraryIdentity,
  };
}

/** Derive and deterministically deduplicate route-part endpoint candidates. */
export function deriveRouteCandidates(
  alternatives: readonly RouteAlternative[],
): readonly RouteCandidate[] {
  return deduplicateRouteCandidates(
    alternatives
      .map(selectRouteMidpointCandidate)
      .filter((candidate): candidate is RouteCandidate => candidate !== null),
  );
}

export function deduplicateRouteCandidates(
  candidates: readonly RouteCandidate[],
): readonly RouteCandidate[] {
  const ordered = [...candidates].sort(compareCandidates);
  const unique = new Map<string, RouteCandidate>();
  for (const candidate of ordered) {
    if (!unique.has(candidate.id)) unique.set(candidate.id, candidate);
  }
  return [...unique.values()];
}

/** Recompute both canonical identities after constructing a domain alternative. */
export function withRouteAlternativeIdentities(
  alternative: Omit<RouteAlternative, "itineraryIdentity" | "structuralPathIdentity">,
): RouteAlternative {
  return {
    ...alternative,
    itineraryIdentity: routeItineraryIdentity(alternative),
    structuralPathIdentity: routeStructuralPathIdentity(alternative),
  };
}

function addEndpoint(
  endpoints: Array<{
    station: RouteStationReference;
    timestamp: number;
    order: number;
  }>,
  station: RouteStationReference,
  timestampValue: string,
  order: number,
): void {
  const timestamp = Date.parse(timestampValue);
  if (
    !Number.isFinite(timestamp)
  ) {
    return;
  }
  endpoints.push({ station, timestamp, order });
}

function compareCandidates(left: RouteCandidate, right: RouteCandidate): number {
  const id = left.id.localeCompare(right.id);
  if (id !== 0) return id;
  const coordinate = compareCoordinates(left.coordinate, right.coordinate);
  if (coordinate !== 0) return coordinate;
  return (left.alternativeIdentity ?? "").localeCompare(right.alternativeIdentity ?? "");
}

function compareCoordinates(left: LocationCoordinate, right: LocationCoordinate): number {
  return left.latitude - right.latitude || left.longitude - right.longitude;
}

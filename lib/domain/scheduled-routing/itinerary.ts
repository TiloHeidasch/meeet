import "server-only";

import type { ScheduledRoutingArtifact, ItineraryEdge } from "./models.ts";
import type { ItineraryLeg } from "../station-area-details-contract.ts";

/**
 * Rebuilds a participant's certified itinerary legs to a selected station area
 * from the per-participant predecessor graph produced by the scheduled scan.
 *
 * The graph is the certified output of the same scan that set the marker
 * arrival, and the artifact is identity-checked at details time, so the
 * reconstructed legs are derived exclusively from the certified scheduled
 * result (MVV GTFS). Station-area granularity only (ADR 0003): legs reference
 * station areas, never boarding stops or platforms.
 *
 * Returns null when the chain is broken, cyclic, or inconsistent with the
 * certified total — callers fall back to omitting the itinerary rather than
 * sending unverifiable data.
 */
export function buildItinerary(
  graph: Readonly<Record<string, ItineraryEdge>> | undefined,
  targetAreaId: string,
  artifact: ScheduledRoutingArtifact,
  searchStartEpochSeconds: number,
  originLabel: string,
  totalSeconds: number,
): readonly ItineraryLeg[] | null {
  if (graph === undefined) return null;
  if (graph[targetAreaId] === undefined) return null;

  // Walk the predecessor chain back to the access seed.
  const chain: Array<{ readonly areaId: string; readonly edge: ItineraryEdge }> = [];
  let current: string | undefined = targetAreaId;
  const visited = new Set<string>();
  while (current !== undefined) {
    if (visited.has(current)) return null;
    visited.add(current);
    const edge: ItineraryEdge | undefined = graph[current];
    if (edge === undefined) return null;
    chain.push({ areaId: current, edge });
    if (edge.kind === "seed") break;
    current = edge.kind === "connection" ? edge.connection.fromStationAreaId : edge.fromAreaId;
  }
  // Reverse so legs run chronologically: access seed first, target last.
  chain.reverse();

  const areaNameById = new Map(artifact.stationAreas.map((area) => [area.id, area.name]));
  const nameOf = (id: string | null): string | null => (id === null ? null : areaNameById.get(id) ?? id);

  const legs: ItineraryLeg[] = [];
  let prevArrival = searchStartEpochSeconds;
  for (const { areaId, edge } of chain) {
    if (edge.kind === "seed") {
      const end = searchStartEpochSeconds + edge.accessSeconds;
      legs.push({
        kind: "walk",
        fromAreaId: null,
        toAreaId: edge.seedAreaId,
        fromAreaName: originLabel,
        toAreaName: nameOf(edge.seedAreaId) ?? edge.seedAreaId,
        startEpochSeconds: searchStartEpochSeconds,
        endEpochSeconds: end,
      });
      prevArrival = end;
    } else if (edge.kind === "connection") {
      const connection = edge.connection;
      legs.push({
        kind: "transit",
        fromAreaId: connection.fromStationAreaId,
        toAreaId: connection.toStationAreaId,
        fromAreaName: nameOf(connection.fromStationAreaId) ?? connection.fromStationAreaId,
        toAreaName: nameOf(connection.toStationAreaId) ?? connection.toStationAreaId,
        line: connection.lineShortName,
        routeType: connection.routeType,
        headsign: connection.headsign,
        tripId: connection.tripId,
        startEpochSeconds: connection.departureEpochSeconds,
        endEpochSeconds: connection.arrivalEpochSeconds,
      });
      prevArrival = connection.arrivalEpochSeconds;
    } else {
      legs.push({
        kind: "walk",
        fromAreaId: edge.fromAreaId,
        toAreaId: areaId,
        fromAreaName: nameOf(edge.fromAreaId) ?? edge.fromAreaId,
        toAreaName: nameOf(areaId) ?? areaId,
        startEpochSeconds: prevArrival,
        endEpochSeconds: edge.arrivalEpochSeconds,
      });
      prevArrival = edge.arrivalEpochSeconds;
    }
  }

  // Consistency with the certified marker: the final arrival must equal
  // searchStart + totalSeconds (authoritative). Walk rounding uses
  // ceilToWholeMinuteSeconds, so allow a one-bucket tolerance on the sum.
  const lastEnd = legs.length > 0 ? legs[legs.length - 1]!.endEpochSeconds : null;
  if (lastEnd === null) return null;
  if (Math.abs(lastEnd - (searchStartEpochSeconds + totalSeconds)) > 60) return null;
  return legs;
}

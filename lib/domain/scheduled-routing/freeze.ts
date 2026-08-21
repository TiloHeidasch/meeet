import "server-only";

import type { ScheduledRoutingArtifact, ScheduledRoute } from "./models.ts";

/**
 * Freeze the persisted scheduled artifact by its schema rather than walking
 * every object property. The explicit branches avoid the Object.values()
 * allocations of a generic recursive deep-freeze while retaining the
 * importer's and loader's immutable snapshot contract.
 */
export function freezeScheduledArtifact(artifact: ScheduledRoutingArtifact): ScheduledRoutingArtifact {
  Object.freeze(artifact.searchStartBounds);
  Object.freeze(artifact.serviceDateRange);

  Object.freeze(artifact.routes);
  for (const route of artifact.routes) Object.freeze(route);

  Object.freeze(artifact.trips);
  for (const trip of artifact.trips) Object.freeze(trip);

  Object.freeze(artifact.stationAreas);
  for (const area of artifact.stationAreas) {
    Object.freeze(area.coordinate);
    Object.freeze(area.transferNeighbors);
    for (const neighbor of area.transferNeighbors) Object.freeze(neighbor);
    Object.freeze(area);
  }

  Object.freeze(artifact.calendars);
  for (const calendar of artifact.calendars) {
    Object.freeze(calendar.weekdays);
    Object.freeze(calendar);
  }

  Object.freeze(artifact.exceptions);
  for (const exception of artifact.exceptions) Object.freeze(exception);

  Object.freeze(artifact.connections);
  for (const connection of artifact.connections) {
    freezeScheduledRoute(connection.line);
    Object.freeze(connection);
  }

  const provenance = artifact.provenance;
  Object.freeze(provenance.files);
  for (const file of provenance.files) Object.freeze(file);
  Object.freeze(provenance.acquisition.officialLicense);
  Object.freeze(provenance.acquisition.officialProvenance);
  Object.freeze(provenance.acquisition);
  Object.freeze(provenance);

  Object.freeze(artifact);
  return artifact;
}

function freezeScheduledRoute(route: ScheduledRoute): void {
  Object.freeze(route);
}

/**
 * Freeze the structural envelope of a value without traversing large arrays.
 *
 * The top-level object is frozen, and its non-Array object properties are
 * frozen recursively. Array properties are frozen only at the container level
 * (the array itself), and their elements are intentionally NOT frozen. This
 * keeps the immutable structural envelope (metadata, provenance, etc.) while
 * avoiding the cost of deep-freezing the large `stationAreas` / `accessSeeds`
 * arrays on every calculation (issue #73, Win 4).
 */
export function freezeEnvelope(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Object.isFrozen(value)) return;
  if (Array.isArray(value)) {
    Object.freeze(value);
    return;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child === null || typeof child !== "object") continue;
    if (Array.isArray(child)) {
      Object.freeze(child);
    } else {
      freezeEnvelope(child);
    }
  }
}

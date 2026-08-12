import type { BoundedMunichGrid } from "../types.ts";
import { createBoundedMunichGrid } from "../grid.ts";

export const SCHEDULED_SURFACE_GRID_COLUMNS = 24;
export const SCHEDULED_SURFACE_GRID_ROWS = 16;
export const MAX_SCHEDULED_SURFACE_CELLS = SCHEDULED_SURFACE_GRID_COLUMNS * SCHEDULED_SURFACE_GRID_ROWS;
export const MAX_SCHEDULED_SURFACE_DESTINATIONS = 2_048;
export const SCHEDULED_SURFACE_GRID_PROFILE = {
  columns: SCHEDULED_SURFACE_GRID_COLUMNS,
  rows: SCHEDULED_SURFACE_GRID_ROWS,
} as const;

/** A bounded clipped fill grid independent of routing-provider matrix limits. */
export function createScheduledSurfaceGrid(): BoundedMunichGrid {
  const grid = createBoundedMunichGrid(SCHEDULED_SURFACE_GRID_PROFILE, { enforceMatrixLimits: false });
  if (grid.cells.length > MAX_SCHEDULED_SURFACE_CELLS || grid.destinations.length > MAX_SCHEDULED_SURFACE_DESTINATIONS) throw new RangeError("The scheduled surface grid exceeds its bounded resource cap.");
  return grid;
}

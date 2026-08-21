import "server-only";

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

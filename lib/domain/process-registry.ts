import "server-only";

/**
 * Route handlers can be emitted into separate Next bundles.  A module
 * singleton is not sufficient in that case, while this registry remains
 * deliberately process-local (it is not a cross-worker/distributed store).
 */
export function getOrCreateProcessValue<T>(
  key: symbol,
  create: () => T,
  isValue: (value: unknown) => value is T,
): T {
  const globalWithRegistry = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const existing = globalWithRegistry[key];
  if (existing !== undefined) {
    if (!isValue(existing)) throw new Error("The Meeet process registry contains an invalid value.");
    return existing;
  }
  const created = create();
  Object.defineProperty(globalWithRegistry, key, {
    configurable: false,
    enumerable: false,
    value: created,
    writable: false,
  });
  return created;
}

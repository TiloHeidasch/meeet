import "server-only";

import { randomBytes } from "node:crypto";
import { deepFreeze, type ScheduledCalculationBasis } from "./scheduled-routing/meeting.ts";
import { getOrCreateProcessValue } from "./process-registry.ts";

export const STATION_AREA_CALCULATION_REF_HEADER = "Meeet-Calculation-Ref";
export const STATION_AREA_CALCULATION_BASIS_TTL_MS = 15 * 60_000;
export const STATION_AREA_CALCULATION_BASIS_MAX_ENTRIES = 32;
export const STATION_AREA_CALCULATION_BASIS_MAX_BYTES = 256 * 1024;

export class StationAreaCalculationBasisCacheLimitError extends Error {
  constructor(message = "The scheduled calculation basis exceeded its bounded cache size.") {
    super(message);
    this.name = "StationAreaCalculationBasisCacheLimitError";
  }
}

export function isStationAreaCalculationBasisCacheLimitError(value: unknown): value is StationAreaCalculationBasisCacheLimitError {
  return value instanceof StationAreaCalculationBasisCacheLimitError || (
    typeof value === "object" && value !== null &&
    (value as { name?: unknown }).name === "StationAreaCalculationBasisCacheLimitError"
  );
}

export interface StationAreaCalculationBasisCache {
  put(basis: ScheduledCalculationBasis): string;
  get(reference: string): ScheduledCalculationBasis | undefined;
  clear(): void;
}

interface CacheEntry {
  readonly basis: ScheduledCalculationBasis;
  readonly expiresAt: number;
  readonly bytes: number;
  readonly sequence: number;
}

export interface StationAreaCalculationBasisCacheOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly referenceFactory?: () => string;
}

export class InMemoryStationAreaCalculationBasisCache implements StationAreaCalculationBasisCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly referenceFactory: () => string;
  private sequence = 0;
  private bytes = 0;

  constructor(options: StationAreaCalculationBasisCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? STATION_AREA_CALCULATION_BASIS_TTL_MS;
    this.maxEntries = options.maxEntries ?? STATION_AREA_CALCULATION_BASIS_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? STATION_AREA_CALCULATION_BASIS_MAX_BYTES;
    this.referenceFactory = options.referenceFactory ?? (() => `mcr_${randomBytes(24).toString("base64url")}`);
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0 || !Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0 || !Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new RangeError("Calculation basis cache bounds must be positive safe integers.");
    }
  }

  put(basis: ScheduledCalculationBasis): string {
    this.evictExpired();
    const immutableBasis = deepFreeze(basis);
    const bytes = new TextEncoder().encode(JSON.stringify(immutableBasis)).byteLength;
    if (bytes > this.maxBytes) throw new StationAreaCalculationBasisCacheLimitError();
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.evictOldest();
    let reference = this.referenceFactory();
    while (this.entries.has(reference)) reference = this.referenceFactory();
    const entry: CacheEntry = {
      basis: immutableBasis,
      expiresAt: this.now() + this.ttlMs,
      bytes,
      sequence: this.sequence++,
    };
    this.entries.set(reference, entry);
    this.bytes += bytes;
    return reference;
  }

  get(reference: string): ScheduledCalculationBasis | undefined {
    if (reference.trim() === "") return undefined;
    const entry = this.entries.get(reference);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(reference);
      this.bytes -= entry.bytes;
      return undefined;
    }
    return entry.basis;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  get size(): number { return this.entries.size; }
  get byteSize(): number { return this.bytes; }

  private evictExpired(): void {
    for (const [reference, entry] of this.entries) {
      if (entry.expiresAt > this.now()) continue;
      this.entries.delete(reference);
      this.bytes -= entry.bytes;
    }
  }

  private evictOldest(): void {
    let oldestReference: string | undefined;
    let oldestSequence = Number.POSITIVE_INFINITY;
    for (const [reference, entry] of this.entries) {
      if (entry.sequence < oldestSequence) {
        oldestReference = reference;
        oldestSequence = entry.sequence;
      }
    }
    if (oldestReference === undefined) throw new StationAreaCalculationBasisCacheLimitError("The scheduled calculation basis cache could not evict an entry.");
    const entry = this.entries.get(oldestReference);
    this.entries.delete(oldestReference);
    if (entry !== undefined) this.bytes -= entry.bytes;
  }
}

export const stationAreaCalculationBasisCache = getOrCreateProcessValue(
  Symbol.for("meeet.station-area-calculation-basis-cache/v1"),
  () => new InMemoryStationAreaCalculationBasisCache(),
  isStationAreaCalculationBasisCache,
);

function isStationAreaCalculationBasisCache(value: unknown): value is StationAreaCalculationBasisCache {
  return value instanceof InMemoryStationAreaCalculationBasisCache || (
    typeof value === "object" && value !== null &&
    typeof (value as { put?: unknown }).put === "function" &&
    typeof (value as { get?: unknown }).get === "function" &&
    typeof (value as { clear?: unknown }).clear === "function"
  );
}

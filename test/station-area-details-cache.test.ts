import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryStationAreaCalculationBasisCache,
  StationAreaCalculationBasisCacheLimitError,
  jsonByteLength,
} from "../lib/domain/station-area-details-cache.ts";
import type { ScheduledCalculationBasis } from "../lib/domain/scheduled-routing/meeting.ts";

function basis(value: string): ScheduledCalculationBasis {
  return { value } as unknown as ScheduledCalculationBasis;
}

test("jsonByteLength matches the UTF-8 byte length of JSON.stringify", () => {
  const fixtures: unknown[] = [
    // Nested object.
    { a: 1, b: "two", c: [1, 2, 3], d: { e: true, f: null } },
    // Array with mixed element types.
    [1, "two", { three: 3 }, null, false],
    // String requiring JSON escaping: quotes, backslash, newline, non-ASCII.
    "has \"quotes\", \\backslash, \n newline, and é non-ascii",
    // Number (including fractional formatting).
    12345.67,
    // Booleans.
    true,
    false,
    // Null.
    null,
    // Object with an undefined-valued property (must be omitted, like JSON.stringify).
    { keep: "value", skip: undefined, also: 42 },
  ];
  for (const fixture of fixtures) {
    assert.equal(
      jsonByteLength(fixture),
      new TextEncoder().encode(JSON.stringify(fixture)).byteLength,
      `jsonByteLength must equal the serialized byte length for: ${JSON.stringify(fixture)}`,
    );
  }
});

test("cache expires entries using the injected clock and reclaims their bytes", () => {
  let now = 1_000;
  const cache = new InMemoryStationAreaCalculationBasisCache({
    now: () => now,
    ttlMs: 50,
    referenceFactory: () => "expiring",
  });
  const stored = basis("expiring");
  const bytes = jsonByteLength(stored);

  cache.put(stored);
  assert.equal(cache.size, 1);
  assert.equal(cache.byteSize, bytes);
  now += 49;
  assert.strictEqual(cache.get("expiring"), stored);
  now += 1;
  assert.equal(cache.get("expiring"), undefined);
  assert.equal(cache.size, 0);
  assert.equal(cache.byteSize, 0);
});

test("cache evicts the oldest entry at the entry bound and accounts for retained bytes", () => {
  const references = ["first", "second", "third"];
  const cache = new InMemoryStationAreaCalculationBasisCache({
    maxEntries: 2,
    referenceFactory: () => references.shift()!,
  });
  const first = basis("first");
  const second = basis("second");
  const third = basis("third");

  cache.put(first);
  cache.put(second);
  cache.put(third);

  assert.equal(cache.get("first"), undefined);
  assert.strictEqual(cache.get("second"), second);
  assert.strictEqual(cache.get("third"), third);
  assert.equal(cache.size, 2);
  assert.equal(cache.byteSize, jsonByteLength(second) + jsonByteLength(third));
});

test("cache evicts oldest entries until cumulative bytes fit and maintains accounting", () => {
  const references = ["first", "second", "third"];
  const first = basis("a");
  const second = basis("bb");
  const third = basis("ccc");
  const maxBytes = jsonByteLength(second) + jsonByteLength(third);
  const cache = new InMemoryStationAreaCalculationBasisCache({
    maxBytes,
    referenceFactory: () => references.shift()!,
  });

  cache.put(first);
  cache.put(second);
  cache.put(third);

  assert.equal(cache.get("first"), undefined);
  assert.strictEqual(cache.get("second"), second);
  assert.strictEqual(cache.get("third"), third);
  assert.equal(cache.byteSize, maxBytes);
});

test("cache rejects invalid bounds", () => {
  const invalidOptions = [
    { ttlMs: 0 },
    { ttlMs: 1.5 },
    { maxEntries: -1 },
    { maxEntries: Number.POSITIVE_INFINITY },
    { maxBytes: 0 },
    { maxBytes: Number.MAX_SAFE_INTEGER + 1 },
  ];

  for (const options of invalidOptions) {
    assert.throws(() => new InMemoryStationAreaCalculationBasisCache(options), RangeError);
  }
});

test("cache clearing removes all entries and resets byte accounting", () => {
  const references = ["first", "second"];
  const cache = new InMemoryStationAreaCalculationBasisCache({ referenceFactory: () => references.shift()! });
  cache.put(basis("first"));
  cache.put(basis("second"));

  cache.clear();

  assert.equal(cache.size, 0);
  assert.equal(cache.byteSize, 0);
  assert.equal(cache.get("first"), undefined);
  assert.equal(cache.get("second"), undefined);
});

test("cache rejects an oversized entry without storing or accounting for it", () => {
  const entry = basis("too-large");
  const cache = new InMemoryStationAreaCalculationBasisCache({
    maxBytes: jsonByteLength(entry) - 1,
    referenceFactory: () => "oversized",
  });

  assert.throws(() => cache.put(entry), StationAreaCalculationBasisCacheLimitError);
  assert.equal(cache.size, 0);
  assert.equal(cache.byteSize, 0);
  assert.equal(cache.get("oversized"), undefined);
});

test("cache retries opaque reference collisions until it receives an unused reference", () => {
  const references = ["collision", "collision", "replacement"];
  const cache = new InMemoryStationAreaCalculationBasisCache({ referenceFactory: () => references.shift()! });
  const original = basis("original");
  const replacement = basis("replacement");

  assert.equal(cache.put(original), "collision");
  assert.equal(cache.put(replacement), "replacement");
  assert.strictEqual(cache.get("collision"), original);
  assert.strictEqual(cache.get("replacement"), replacement);
});

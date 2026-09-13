import assert from "node:assert/strict";
import test from "node:test";

import { jsonByteLength } from "../lib/domain/station-area-details-cache.ts";

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

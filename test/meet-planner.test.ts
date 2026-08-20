import assert from "node:assert/strict";
import test from "node:test";
import { nextStart } from "../components/MeetPlanner.tsx";

test("nextStart returns a whole-minute UTC instant at least five minutes ahead", () => {
  const before = Date.now();
  const value = nextStart();
  const after = Date.now();
  const epoch = Date.parse(value);
  assert.equal(epoch % 60_000, 0);
  assert.ok(epoch >= before + 300_000, "start must be at least five minutes ahead");
  assert.ok(epoch <= after + 300_000 + 60_000, "start must be the next whole minute at most");
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createTraceId } from "../trace.js";

test("createTraceId uses deterministic trace format", () => {
  const traceId = createTraceId("who_is_on_my_roster", 0, "2026-02-07T02-11-12Z");
  assert.match(traceId, /^trace_who_is_on_my_roster_\d{3}_[a-z0-9_]+$/);
});

test("createTraceId normalizes special characters", () => {
  const traceId = createTraceId("Who is on my roster?!", 7, "2026-02-07T02-11-12Z");
  assert.equal(traceId, "trace_who_is_on_my_roster_007_02_07t02_11_12z");
});

test("createTraceId is run-scoped", () => {
  const first = createTraceId("best_waiver_adds", 0, "2026-02-07T02-11-12Z");
  const second = createTraceId("best_waiver_adds", 0, "2026-02-07T02-20-12Z");
  assert.notEqual(first, second);
});

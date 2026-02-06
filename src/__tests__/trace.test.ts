import test from "node:test";
import assert from "node:assert/strict";
import { createTraceId } from "../trace.js";

test("createTraceId uses deterministic trace format", () => {
  const traceId = createTraceId("who_is_on_my_roster", 0);
  assert.match(traceId, /^trace_who_is_on_my_roster_\d{3}$/);
});

test("createTraceId normalizes special characters", () => {
  const traceId = createTraceId("Who is on my roster?!", 7);
  assert.equal(traceId, "trace_who_is_on_my_roster_007");
});

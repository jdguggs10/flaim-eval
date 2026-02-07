import test from "node:test";
import assert from "node:assert/strict";
import { buildMcpHeaders } from "../runner.js";

test("buildMcpHeaders includes auth, run, and trace headers", () => {
  const headers = buildMcpHeaders(
    "token_123",
    "2026-02-06T18-10-04Z",
    "trace_who_is_on_my_roster_000"
  );

  assert.equal(headers.Authorization, "Bearer token_123");
  assert.equal(headers.Accept, "application/json, text/event-stream");
  assert.equal(headers["X-Flaim-Eval-Run"], "2026-02-06T18-10-04Z");
  assert.equal(
    headers["X-Flaim-Eval-Trace"],
    "trace_who_is_on_my_roster_000"
  );
});

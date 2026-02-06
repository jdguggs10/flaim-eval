import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTraceNeedles,
  fetchWorkerLogs,
  WORKER_NAMES,
} from "../cloudflare-logs.js";

test("buildTraceNeedles includes JSON and plain-text forms", () => {
  const traceId = "trace_who_is_on_my_roster_000";
  const needles = buildTraceNeedles(traceId);

  assert.equal(needles[0], `\"trace_id\":\"${traceId}\"`);
  assert.equal(needles[1], `trace_id=${traceId}`);
  assert.equal(needles[2], traceId);
});

test("fetchWorkerLogs queries all workers with ms timeframe and dedupes results", async (t) => {
  const prevAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const prevToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "acc_123";
  process.env.CLOUDFLARE_API_TOKEN = "token_123";

  const originalFetch = globalThis.fetch;
  const calls: Array<{
    workerName: string;
    needle?: string;
    timeframe: { from?: unknown; to?: unknown };
  }> = [];

  t.after(() => {
    process.env.CLOUDFLARE_ACCOUNT_ID = prevAccount;
    process.env.CLOUDFLARE_API_TOKEN = prevToken;
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      parameters?: { filters?: Array<{ key: string; value?: string }> };
      timeframe?: { from: unknown; to: unknown };
    };
    const filters = body.parameters?.filters || [];
    const workerName = filters.find((f) => f.key === "$metadata.service")?.value || "";
    const needle = filters.find((f) => f.key === "$metadata.message")?.value;

    calls.push({
      workerName,
      needle,
      timeframe: body.timeframe || { from: undefined, to: undefined },
    });

    const makeEvent = (id: string, message: string) => ({
      timestamp: 1738865400000,
      $metadata: { id, message, service: workerName },
      $workers: { wallTimeMs: 9, event: { response: { status: 200 } } },
    });

    let events: unknown[] = [];
    if (workerName === "fantasy-mcp") {
      if (needle?.includes("trace_who_is_on_my_roster_000")) {
        events = [makeEvent("shared-1", `trace_id=trace_who_is_on_my_roster_000`)];
      }
      if (needle === "eval=2026-02-06T18-10-04Z") {
        events = [makeEvent("shared-1", "eval=2026-02-06T18-10-04Z")];
      }
    }
    if (workerName === "espn-client" && needle?.includes("trace_who_is_on_my_roster_000")) {
      events = [makeEvent("espn-1", `{"trace_id":"trace_who_is_on_my_roster_000"}`)];
    }

    return Response.json({
      success: true,
      errors: [],
      result: {
        events: {
          count: events.length,
          events,
        },
      },
    });
  };

  const logs = await fetchWorkerLogs(
    new Date("2026-02-06T18:10:00.000Z"),
    new Date("2026-02-06T18:10:30.000Z"),
    "2026-02-06T18-10-04Z",
    "trace_who_is_on_my_roster_000"
  );

  const workersSeen = new Set(calls.map((call) => call.workerName));
  assert.deepEqual([...workersSeen].sort(), [...WORKER_NAMES].sort());

  assert.ok(calls.length >= WORKER_NAMES.length * 3);
  assert.ok(
    calls.every(
      (call) =>
        typeof call.timeframe.from === "number" &&
        typeof call.timeframe.to === "number"
    )
  );

  assert.equal(Object.keys(logs).length, 2);
  assert.equal(logs["fantasy-mcp"]?.length, 1);
  assert.equal(logs["espn-client"]?.length, 1);
  assert.ok(!logs["yahoo-client"]);
  assert.ok(!logs["auth-worker"]);
});

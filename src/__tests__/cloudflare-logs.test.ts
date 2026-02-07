import test from "node:test";
import assert from "node:assert/strict";
import {
  allowRunFallback,
  buildTraceNeedles,
  fetchWorkerLogs,
  WORKER_NAMES,
} from "../cloudflare-logs.js";

test("buildTraceNeedles includes only explicit trace markers", () => {
  const traceId = "trace_who_is_on_my_roster_000";
  const needles = buildTraceNeedles(traceId);

  assert.equal(needles[0], `\"trace_id\":\"${traceId}\"`);
  assert.equal(needles[1], `trace_id=${traceId}`);
  assert.equal(needles.length, 2);
});

test("allowRunFallback defaults to disabled", (t) => {
  const prev = process.env.FLAIM_EVAL_ALLOW_RUN_FALLBACK;
  delete process.env.FLAIM_EVAL_ALLOW_RUN_FALLBACK;
  t.after(() => {
    process.env.FLAIM_EVAL_ALLOW_RUN_FALLBACK = prev;
  });

  assert.equal(allowRunFallback(), false);
});

test("fetchWorkerLogs enforces strict trace filtering and maps structured source fields", async (t) => {
  const prevAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const prevToken = process.env.CLOUDFLARE_API_TOKEN;
  const prevFallback = process.env.FLAIM_EVAL_ALLOW_RUN_FALLBACK;
  process.env.CLOUDFLARE_ACCOUNT_ID = "acc_123";
  process.env.CLOUDFLARE_API_TOKEN = "token_123";
  delete process.env.FLAIM_EVAL_ALLOW_RUN_FALLBACK;

  const originalFetch = globalThis.fetch;
  const calls: Array<{
    workerName: string;
    needle?: string;
    traceId?: string;
    timeframe: { from?: unknown; to?: unknown };
  }> = [];

  t.after(() => {
    process.env.CLOUDFLARE_ACCOUNT_ID = prevAccount;
    process.env.CLOUDFLARE_API_TOKEN = prevToken;
    process.env.FLAIM_EVAL_ALLOW_RUN_FALLBACK = prevFallback;
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
    const traceId = filters.find((f) => f.key === "$metadata.traceId")?.value;

    calls.push({
      workerName,
      needle,
      traceId,
      timeframe: body.timeframe || { from: undefined, to: undefined },
    });

    const makeEvent = (
      id: string,
      message: string,
      extra: {
        traceId?: string;
        runId?: string;
        sourceStatus?: string;
      } = {}
    ) => ({
      timestamp: 1738865400000,
      source: {
        service: workerName,
        phase: "tool_end",
        run_id: extra.runId || "2026-02-06T18-10-04Z",
        trace_id: extra.traceId || "trace_who_is_on_my_roster_000",
        correlation_id: "cid-1",
        tool: "get_roster",
        sport: "baseball",
        league_id: "30201",
        status: extra.sourceStatus,
        duration_ms: 123,
      },
      $metadata: {
        id,
        message,
        service: workerName,
        traceId: extra.traceId || "trace_who_is_on_my_roster_000",
        requestId: "req-1",
        trigger: "POST /mcp",
      },
      $workers: { wallTimeMs: 9, event: { response: { status: 200 } } },
    });

    let events: unknown[] = [];
    if (workerName === "fantasy-mcp" && traceId === "trace_who_is_on_my_roster_000") {
      events = [
        makeEvent("f-trace-1", "/mcp"),
        makeEvent("f-cross-1", "/mcp cross", { traceId: "trace_other_999" }),
        makeEvent("f-old-run-1", "/mcp old run", { runId: "2026-02-06T18-05-00Z" }),
      ];
    }
    if (workerName === "fantasy-mcp") {
      if (needle?.includes("trace_who_is_on_my_roster_000")) {
        events = [
          makeEvent("shared-1", `trace_id=trace_who_is_on_my_roster_000`),
          makeEvent("shared-cross-1", "trace_id=trace_other_999", { traceId: "trace_other_999" }),
        ];
      }
    }
    if (workerName === "espn-client" && traceId === "trace_who_is_on_my_roster_000") {
      events = [
        {
          timestamp: 1738865400000,
          source: {
            service: "espn-client",
            phase: "execute_end",
            run_id: "2026-02-06T18-10-04Z",
            trace_id: "trace_who_is_on_my_roster_000",
            correlation_id: "cid-espn",
            tool: "get_roster",
            sport: "baseball",
            league_id: "30201",
            status: "true",
            duration_ms: 91,
          },
          $metadata: {
            id: "espn-trace-1",
            service: "espn-client",
            traceId: "trace_who_is_on_my_roster_000",
            requestId: "req-espn",
            trigger: "POST /execute",
          },
          $workers: { wallTimeMs: 10 },
        },
      ];
    }
    if (workerName === "espn-client" && needle?.includes("trace_who_is_on_my_roster_000")) {
      events = [makeEvent("espn-1", `{"trace_id":"trace_who_is_on_my_roster_000"}`, { sourceStatus: "202" })];
    }
    if (workerName === "auth-worker" && traceId === "trace_who_is_on_my_roster_000") {
      events = [makeEvent("auth-trace-1", "")];
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
  assert.equal(calls.some((call) => call.needle === "eval=2026-02-06T18-10-04Z"), false);
  assert.ok(
    calls.filter((call) => call.traceId === "trace_who_is_on_my_roster_000").length >=
      WORKER_NAMES.length
  );
  assert.ok(
    calls.every(
      (call) =>
        typeof call.timeframe.from === "number" &&
        typeof call.timeframe.to === "number"
    )
  );

  assert.equal(Object.keys(logs).length, 3);
  assert.equal(logs["fantasy-mcp"]?.length, 2);
  assert.equal(logs["espn-client"]?.length, 2);
  assert.equal(logs["auth-worker"]?.length, 1);
  assert.ok(!logs["yahoo-client"]);

  const fantasyMessages = (logs["fantasy-mcp"] || []).map((event) => event.message);
  assert.equal(fantasyMessages.some((message) => message?.includes("cross")), false);
  assert.equal(fantasyMessages.some((message) => message?.includes("old run")), false);

  const espnEventWithSourceStatus = (logs["espn-client"] || []).find(
    (event) => event.status_text === "true"
  );
  assert.equal(espnEventWithSourceStatus?.service, "espn-client");
  assert.equal(espnEventWithSourceStatus?.phase, "execute_end");
  assert.equal(espnEventWithSourceStatus?.correlation_id, "cid-espn");
  assert.equal(espnEventWithSourceStatus?.trace_id, "trace_who_is_on_my_roster_000");
  assert.equal(espnEventWithSourceStatus?.status, null);
});

test("fetchWorkerLogs can include run fallback when explicitly enabled", async (t) => {
  const prevAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const prevToken = process.env.CLOUDFLARE_API_TOKEN;
  const prevFallback = process.env.FLAIM_EVAL_ALLOW_RUN_FALLBACK;
  process.env.CLOUDFLARE_ACCOUNT_ID = "acc_123";
  process.env.CLOUDFLARE_API_TOKEN = "token_123";
  process.env.FLAIM_EVAL_ALLOW_RUN_FALLBACK = "1";

  const originalFetch = globalThis.fetch;
  const calls: Array<{ workerName: string; needle?: string }> = [];

  t.after(() => {
    process.env.CLOUDFLARE_ACCOUNT_ID = prevAccount;
    process.env.CLOUDFLARE_API_TOKEN = prevToken;
    process.env.FLAIM_EVAL_ALLOW_RUN_FALLBACK = prevFallback;
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      parameters?: { filters?: Array<{ key: string; value?: string }> };
    };
    const filters = body.parameters?.filters || [];
    const workerName = filters.find((f) => f.key === "$metadata.service")?.value || "";
    const needle = filters.find((f) => f.key === "$metadata.message")?.value;
    calls.push({ workerName, needle });

    let events: unknown[] = [];
    if (workerName === "fantasy-mcp" && needle === "eval=2026-02-06T18-10-04Z") {
      events = [
        {
          timestamp: 1738865400000,
          source: {
            service: "fantasy-mcp",
            phase: "tool_end",
            run_id: "2026-02-06T18-10-04Z",
            correlation_id: "cid-fallback",
          },
          $metadata: { id: "fallback-no-trace", service: "fantasy-mcp", message: "eval=2026-02-06T18-10-04Z" },
          $workers: { wallTimeMs: 9 },
        },
      ];
    }

    return Response.json({
      success: true,
      errors: [],
      result: { events: { count: events.length, events } },
    });
  };

  const logs = await fetchWorkerLogs(
    new Date("2026-02-06T18:10:00.000Z"),
    new Date("2026-02-06T18:10:30.000Z"),
    "2026-02-06T18-10-04Z",
    "trace_who_is_on_my_roster_000"
  );

  assert.equal(calls.some((call) => call.needle === "eval=2026-02-06T18-10-04Z"), true);
  assert.equal(logs["fantasy-mcp"]?.length, 1);
  assert.equal(logs["fantasy-mcp"]?.[0]?.trace_id, undefined);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildAttemptWindow, buildReenrichWindow, runCli } from "../enrich.js";
import type { TraceArtifact } from "../types.js";

const RUNS_ROOT = path.resolve(import.meta.dirname, "../../runs");

function makeTrace(overrides: Partial<TraceArtifact> = {}): TraceArtifact {
  return {
    schema_version: "1.1",
    run_id: "",
    trace_id: "",
    scenario_id: "scenario",
    timestamp_utc: "2026-02-07T00:00:00.000Z",
    model: "gpt-5-mini",
    prompt: "p",
    instructions_file: null,
    expected_tools: [],
    llm_response: {
      response_id: "resp_1",
      tool_calls: [],
      final_text: "",
      raw_output: [],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    },
    duration_ms: 1,
    notes: [],
    ...overrides,
  };
}

function writeRun(runId: string, trace: TraceArtifact): string {
  const runDir = path.join(RUNS_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(runDir, trace.trace_id), { recursive: true });

  fs.writeFileSync(
    path.join(runDir, "manifest.json"),
    JSON.stringify(
      {
        run_id: runId,
        traces: [{ scenario_id: trace.scenario_id, trace_id: trace.trace_id }],
      },
      null,
      2
    )
  );

  fs.writeFileSync(path.join(runDir, trace.trace_id, "trace.json"), JSON.stringify(trace, null, 2));
  return runDir;
}

function makeEvent(workerName: string, runId: string, traceId: string, id: string) {
  return {
    timestamp: 1738865400000,
    source: {
      service: workerName,
      phase: "tool_end",
      run_id: runId,
      trace_id: traceId,
      message: `${workerName} done`,
      duration_ms: 12,
    },
    $metadata: {
      id,
      service: workerName,
      traceId,
      message: `trace_id=${traceId}`,
      requestId: `${id}-req`,
      trigger: "POST /mcp",
    },
    $workers: { wallTimeMs: 3, event: { response: { status: 200 } } },
  };
}

test("buildAttemptWindow expands symmetrically for later attempts", () => {
  const base = {
    start: new Date("2026-02-07T00:00:00.000Z"),
    end: new Date("2026-02-07T00:05:00.000Z"),
  };

  const attempt1 = buildAttemptWindow(base, 1, 1000);
  const attempt3 = buildAttemptWindow(base, 3, 1000);

  assert.equal(attempt1.start.toISOString(), "2026-02-07T00:00:00.000Z");
  assert.equal(attempt1.end.toISOString(), "2026-02-07T00:05:00.000Z");
  assert.equal(attempt3.start.toISOString(), "2026-02-06T23:59:58.000Z");
  assert.equal(attempt3.end.toISOString(), "2026-02-07T00:05:02.000Z");
});

test("reenrich stops early when all expected workers are captured", async () => {
  const runId = `test-enrich-early-stop-${Date.now()}`;
  const traceId = "trace_early_stop_000";
  const trace = makeTrace({
    run_id: runId,
    trace_id: traceId,
    timestamp_utc: "2026-02-06T18:10:04.000Z",
    duration_ms: 24000,
    llm_response: {
      response_id: "resp_1",
      tool_calls: [{ tool_name: "get_user_session", args: {}, result_preview: "", result_full: "" }],
      final_text: "",
      raw_output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  });
  const runDir = writeRun(runId, trace);

  const prevArgv = [...process.argv];
  const prevAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const prevToken = process.env.CLOUDFLARE_API_TOKEN;
  const prevAttempts = process.env.FLAIM_EVAL_REENRICH_ATTEMPTS;
  const prevDelay = process.env.FLAIM_EVAL_REENRICH_DELAY_MS;
  const prevExpand = process.env.FLAIM_EVAL_REENRICH_WINDOW_EXPAND_MS;
  const originalFetch = globalThis.fetch;

  process.argv = [process.argv[0] || "node", "enrich.ts", runId];
  process.env.CLOUDFLARE_ACCOUNT_ID = "acc_123";
  process.env.CLOUDFLARE_API_TOKEN = "token_123";
  process.env.FLAIM_EVAL_REENRICH_ATTEMPTS = "4";
  process.env.FLAIM_EVAL_REENRICH_DELAY_MS = "1";
  process.env.FLAIM_EVAL_REENRICH_WINDOW_EXPAND_MS = "1000";

  const windowKeys = new Set<string>();

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      parameters?: { filters?: Array<{ key: string; value?: string }> };
      timeframe?: { from: number; to: number };
    };
    const workerName =
      body.parameters?.filters?.find((f) => f.key === "$metadata.service")?.value || "";

    const from = Number(body.timeframe?.from);
    const to = Number(body.timeframe?.to);
    windowKeys.add(`${from}|${to}`);

    const events =
      workerName === "fantasy-mcp" || workerName === "auth-worker"
        ? [makeEvent(workerName, runId, traceId, `${workerName}-a1`)]
        : [];

    return Response.json({
      success: true,
      errors: [],
      result: { events: { count: events.length, events } },
    });
  };

  try {
    await runCli();
  } finally {
    process.argv = prevArgv;
    process.env.CLOUDFLARE_ACCOUNT_ID = prevAccount;
    process.env.CLOUDFLARE_API_TOKEN = prevToken;
    process.env.FLAIM_EVAL_REENRICH_ATTEMPTS = prevAttempts;
    process.env.FLAIM_EVAL_REENRICH_DELAY_MS = prevDelay;
    process.env.FLAIM_EVAL_REENRICH_WINDOW_EXPAND_MS = prevExpand;
    globalThis.fetch = originalFetch;
  }

  const updated = JSON.parse(
    fs.readFileSync(path.join(runDir, traceId, "trace.json"), "utf8")
  ) as TraceArtifact;

  assert.equal(updated.enrichment?.attempts, 1);
  assert.deepEqual(updated.enrichment?.actual_workers, ["auth-worker", "fantasy-mcp"]);
  assert.deepEqual(updated.enrichment?.missing_workers, []);
  assert.equal(windowKeys.size, 1);

  fs.rmSync(runDir, { recursive: true, force: true });
});

test("reenrich keeps best coverage after exhausting retries and records missing workers", async () => {
  const runId = `test-enrich-retry-${Date.now()}`;
  const traceId = "trace_retry_000";
  const trace = makeTrace({
    run_id: runId,
    trace_id: traceId,
    timestamp_utc: "2026-02-06T18:10:04.000Z",
    duration_ms: 24000,
    llm_response: {
      response_id: "resp_1",
      tool_calls: [
        { tool_name: "get_user_session", args: {}, result_preview: "", result_full: "" },
        { tool_name: "get_roster", args: { platform: "espn" }, result_preview: "", result_full: "" },
      ],
      final_text: "",
      raw_output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  });
  const runDir = writeRun(runId, trace);

  const prevArgv = [...process.argv];
  const prevAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const prevToken = process.env.CLOUDFLARE_API_TOKEN;
  const prevAttempts = process.env.FLAIM_EVAL_REENRICH_ATTEMPTS;
  const prevDelay = process.env.FLAIM_EVAL_REENRICH_DELAY_MS;
  const prevExpand = process.env.FLAIM_EVAL_REENRICH_WINDOW_EXPAND_MS;
  const originalFetch = globalThis.fetch;

  process.argv = [process.argv[0] || "node", "enrich.ts", runId];
  process.env.CLOUDFLARE_ACCOUNT_ID = "acc_123";
  process.env.CLOUDFLARE_API_TOKEN = "token_123";
  process.env.FLAIM_EVAL_REENRICH_ATTEMPTS = "3";
  process.env.FLAIM_EVAL_REENRICH_DELAY_MS = "1";
  process.env.FLAIM_EVAL_REENRICH_WINDOW_EXPAND_MS = "1000";

  const attemptByWindow = new Map<string, number>();
  const attemptWindows = new Map<number, { from: number; to: number }>();
  let nextAttempt = 1;

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      parameters?: { filters?: Array<{ key: string; value?: string }> };
      timeframe?: { from: number; to: number };
    };

    const workerName =
      body.parameters?.filters?.find((f) => f.key === "$metadata.service")?.value || "";
    const from = Number(body.timeframe?.from);
    const to = Number(body.timeframe?.to);
    const key = `${from}|${to}`;

    let attempt = attemptByWindow.get(key);
    if (!attempt) {
      attempt = nextAttempt++;
      attemptByWindow.set(key, attempt);
      attemptWindows.set(attempt, { from, to });
    }

    const events: unknown[] = [];
    if (workerName === "fantasy-mcp") {
      events.push(makeEvent(workerName, runId, traceId, `${workerName}-a${attempt}`));
    }
    if (workerName === "espn-client" && attempt === 2) {
      events.push(makeEvent(workerName, runId, traceId, `${workerName}-a${attempt}`));
    }

    return Response.json({
      success: true,
      errors: [],
      result: { events: { count: events.length, events } },
    });
  };

  try {
    await runCli();
  } finally {
    process.argv = prevArgv;
    process.env.CLOUDFLARE_ACCOUNT_ID = prevAccount;
    process.env.CLOUDFLARE_API_TOKEN = prevToken;
    process.env.FLAIM_EVAL_REENRICH_ATTEMPTS = prevAttempts;
    process.env.FLAIM_EVAL_REENRICH_DELAY_MS = prevDelay;
    process.env.FLAIM_EVAL_REENRICH_WINDOW_EXPAND_MS = prevExpand;
    globalThis.fetch = originalFetch;
  }

  const updated = JSON.parse(
    fs.readFileSync(path.join(runDir, traceId, "trace.json"), "utf8")
  ) as TraceArtifact;

  assert.equal(updated.enrichment?.attempts, 3);
  assert.deepEqual(updated.enrichment?.actual_workers, ["espn-client", "fantasy-mcp"]);
  assert.deepEqual(updated.enrichment?.missing_workers, ["auth-worker"]);

  const baseWindow = buildReenrichWindow(trace);
  const expected1 = buildAttemptWindow(baseWindow, 1, 1000);
  const expected2 = buildAttemptWindow(baseWindow, 2, 1000);
  const expected3 = buildAttemptWindow(baseWindow, 3, 1000);

  const observed1 = attemptWindows.get(1);
  const observed2 = attemptWindows.get(2);
  const observed3 = attemptWindows.get(3);

  assert.ok(observed1 && observed2 && observed3);
  assert.equal(observed1?.from, expected1.start.getTime() - 30000);
  assert.equal(observed1?.to, expected1.end.getTime() + 30000);
  assert.equal(observed2?.from, expected2.start.getTime() - 30000);
  assert.equal(observed2?.to, expected2.end.getTime() + 30000);
  assert.equal(observed3?.from, expected3.start.getTime() - 30000);
  assert.equal(observed3?.to, expected3.end.getTime() + 30000);

  fs.rmSync(runDir, { recursive: true, force: true });
});

test("reenrich accumulates worker coverage across attempts", async () => {
  const runId = `test-enrich-merge-coverage-${Date.now()}`;
  const traceId = "trace_merge_coverage_000";
  const trace = makeTrace({
    run_id: runId,
    trace_id: traceId,
    timestamp_utc: "2026-02-06T18:10:04.000Z",
    duration_ms: 24000,
    llm_response: {
      response_id: "resp_1",
      tool_calls: [{ tool_name: "get_user_session", args: {}, result_preview: "", result_full: "" }],
      final_text: "",
      raw_output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  });
  const runDir = writeRun(runId, trace);

  const prevArgv = [...process.argv];
  const prevAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const prevToken = process.env.CLOUDFLARE_API_TOKEN;
  const prevAttempts = process.env.FLAIM_EVAL_REENRICH_ATTEMPTS;
  const prevDelay = process.env.FLAIM_EVAL_REENRICH_DELAY_MS;
  const prevExpand = process.env.FLAIM_EVAL_REENRICH_WINDOW_EXPAND_MS;
  const originalFetch = globalThis.fetch;

  process.argv = [process.argv[0] || "node", "enrich.ts", runId];
  process.env.CLOUDFLARE_ACCOUNT_ID = "acc_123";
  process.env.CLOUDFLARE_API_TOKEN = "token_123";
  process.env.FLAIM_EVAL_REENRICH_ATTEMPTS = "4";
  process.env.FLAIM_EVAL_REENRICH_DELAY_MS = "1";
  process.env.FLAIM_EVAL_REENRICH_WINDOW_EXPAND_MS = "1000";

  const attemptByWindow = new Map<string, number>();
  let nextAttempt = 1;

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      parameters?: { filters?: Array<{ key: string; value?: string }> };
      timeframe?: { from: number; to: number };
    };

    const workerName =
      body.parameters?.filters?.find((f) => f.key === "$metadata.service")?.value || "";
    const from = Number(body.timeframe?.from);
    const to = Number(body.timeframe?.to);
    const key = `${from}|${to}`;

    let attempt = attemptByWindow.get(key);
    if (!attempt) {
      attempt = nextAttempt++;
      attemptByWindow.set(key, attempt);
    }

    const events: unknown[] = [];
    if (workerName === "auth-worker" && attempt === 1) {
      events.push(makeEvent(workerName, runId, traceId, `${workerName}-a${attempt}`));
    }
    if (workerName === "fantasy-mcp" && attempt === 2) {
      events.push(makeEvent(workerName, runId, traceId, `${workerName}-a${attempt}`));
    }

    return Response.json({
      success: true,
      errors: [],
      result: { events: { count: events.length, events } },
    });
  };

  try {
    await runCli();
  } finally {
    process.argv = prevArgv;
    process.env.CLOUDFLARE_ACCOUNT_ID = prevAccount;
    process.env.CLOUDFLARE_API_TOKEN = prevToken;
    process.env.FLAIM_EVAL_REENRICH_ATTEMPTS = prevAttempts;
    process.env.FLAIM_EVAL_REENRICH_DELAY_MS = prevDelay;
    process.env.FLAIM_EVAL_REENRICH_WINDOW_EXPAND_MS = prevExpand;
    globalThis.fetch = originalFetch;
  }

  const updated = JSON.parse(
    fs.readFileSync(path.join(runDir, traceId, "trace.json"), "utf8")
  ) as TraceArtifact;

  assert.equal(updated.enrichment?.attempts, 2);
  assert.deepEqual(updated.enrichment?.actual_workers, ["auth-worker", "fantasy-mcp"]);
  assert.deepEqual(updated.enrichment?.missing_workers, []);

  fs.rmSync(runDir, { recursive: true, force: true });
});

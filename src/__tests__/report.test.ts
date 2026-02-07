import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../report.js";
import type { RunSummary, TraceArtifact } from "../types.js";

const RUNS_ROOT = path.resolve(import.meta.dirname, "../../runs");

function writeTrace(runDir: string, trace: TraceArtifact): void {
  const traceDir = path.join(runDir, trace.trace_id);
  fs.mkdirSync(path.join(traceDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(traceDir, "trace.json"), JSON.stringify(trace, null, 2));
  for (const [worker, events] of Object.entries(trace.server_logs || {})) {
    fs.writeFileSync(path.join(traceDir, "logs", `${worker}.json`), JSON.stringify(events, null, 2));
  }
}

function makeTrace(runId: string, traceId: string, scenarioId: string): TraceArtifact {
  return {
    schema_version: "1.1",
    run_id: runId,
    trace_id: traceId,
    scenario_id: scenarioId,
    timestamp_utc: "2026-02-07T02:28:06.000Z",
    model: "gpt-5-mini",
    prompt: "prompt",
    instructions_file: null,
    expected_tools: ["get_user_session"],
    llm_response: {
      response_id: "resp_1",
      tool_calls: [{ tool_name: "get_user_session", args: {}, result_preview: "", result_full: "" }],
      final_text: "ok",
      raw_output: [],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    },
    duration_ms: 1234,
    notes: [],
    enrichment: {
      mode: "reenrich",
      attempts: 2,
      strict_trace_isolation: true,
      expected_workers: ["auth-worker", "fantasy-mcp"],
      actual_workers: ["auth-worker", "fantasy-mcp"],
      missing_workers: [],
      generated_at: "2026-02-07T02:30:00.000Z",
    },
    server_logs: {
      "fantasy-mcp": [
        {
          timestamp: "2026-02-07T02:28:06.000Z",
          status: 200,
          wall_time_ms: 10,
          run_id: runId,
          trace_id: traceId,
        },
      ],
      "auth-worker": [
        {
          timestamp: "2026-02-07T02:28:06.100Z",
          status: 200,
          wall_time_ms: 2,
          run_id: runId,
          trace_id: traceId,
        },
      ],
    },
  };
}

function writeSummary(runDir: string, runId: string, traceId: string, scenarioId = "scenario_one"): RunSummary {
  const summary: RunSummary = {
    run_id: runId,
    model: "gpt-5-mini",
    total_scenarios: 1,
    completed: 1,
    errored: 0,
    total_duration_ms: 1234,
    total_tokens: { input: 10, output: 2, total: 12 },
    scenarios: [
      {
        id: scenarioId,
        trace_id: traceId,
        status: "ok",
        tool_calls: ["get_user_session"],
        expected_tools: ["get_user_session"],
        tools_match: true,
        expected_tools_hit: true,
        duration_ms: 1234,
      },
    ],
  };
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

test("report writes markdown with acceptance details", async () => {
  const runId = `test-report-pass-${Date.now()}`;
  const runDir = path.join(RUNS_ROOT, runId);
  const traceId = "trace_scenario_one_000_scope";
  fs.mkdirSync(runDir, { recursive: true });

  writeSummary(runDir, runId, traceId);
  writeTrace(runDir, makeTrace(runId, traceId, "scenario_one"));
  fs.writeFileSync(
    path.join(runDir, "acceptance-summary.json"),
    JSON.stringify(
      {
        run_id: runId,
        generated_at: "2026-02-07T02:32:29.845Z",
        final_status: "pass",
        fail_reasons: [],
        warn_reasons: [],
        totals: { traces: 1, events: 2, warnings: 0, failures: 0 },
      },
      null,
      2
    )
  );

  const prevArgv = [...process.argv];
  process.argv = [process.argv[0] || "node", "report.ts", runId];
  try {
    await runCli();
  } finally {
    process.argv = prevArgv;
  }

  const reportPath = path.join(runDir, "report.md");
  const report = fs.readFileSync(reportPath, "utf8");
  assert.match(report, /# Flaim Eval Report/);
  assert.match(report, /Acceptance status: PASS/);
  assert.match(report, /scenario_one/);
  assert.match(report, /trace_scenario_one_000_scope/);
  assert.match(report, /Final status: PASS/);

  fs.rmSync(runDir, { recursive: true, force: true });
});

test("report handles missing acceptance-summary", async () => {
  const runId = `test-report-no-accept-${Date.now()}`;
  const runDir = path.join(RUNS_ROOT, runId);
  const traceId = "trace_scenario_two_000_scope";
  fs.mkdirSync(runDir, { recursive: true });

  writeSummary(runDir, runId, traceId, "scenario_two");
  writeTrace(runDir, makeTrace(runId, traceId, "scenario_two"));

  const prevArgv = [...process.argv];
  process.argv = [process.argv[0] || "node", "report.ts", runId];
  try {
    await runCli();
  } finally {
    process.argv = prevArgv;
  }

  const reportPath = path.join(runDir, "report.md");
  const report = fs.readFileSync(reportPath, "utf8");
  assert.match(report, /Acceptance status: NOT GENERATED/);
  assert.match(report, /acceptance-summary\.json not found/);

  fs.rmSync(runDir, { recursive: true, force: true });
});

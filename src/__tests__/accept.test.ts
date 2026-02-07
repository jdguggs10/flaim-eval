import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../accept.js";
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

function writeRun(runId: string, traces: TraceArtifact[]): string {
  const runDir = path.join(RUNS_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });

  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify(
      {
        run_id: runId,
        model: "gpt-5-mini",
        total_scenarios: traces.length,
        completed: traces.length,
        errored: 0,
        total_duration_ms: 1,
        total_tokens: { input: 0, output: 0, total: 0 },
        scenarios: traces.map((trace) => ({
          id: trace.scenario_id,
          trace_id: trace.trace_id,
          status: "ok",
          tool_calls: trace.llm_response.tool_calls.map((c) => c.tool_name),
          expected_tools: [],
          tools_match: true,
          expected_tools_hit: true,
          duration_ms: 1,
        })),
      },
      null,
      2
    )
  );

  fs.writeFileSync(
    path.join(runDir, "manifest.json"),
    JSON.stringify(
      {
        run_id: runId,
        traces: traces.map((trace) => ({ scenario_id: trace.scenario_id, trace_id: trace.trace_id })),
      },
      null,
      2
    )
  );

  for (const trace of traces) {
    const traceDir = path.join(runDir, trace.trace_id);
    fs.mkdirSync(path.join(traceDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(traceDir, "trace.json"), JSON.stringify(trace, null, 2));
  }

  return runDir;
}

test("accept writes passing acceptance-summary for clean run", async () => {
  const runId = `test-accept-pass-${Date.now()}`;
  const trace = makeTrace({
    run_id: runId,
    trace_id: "trace_pass_000",
    scenario_id: "pass_scenario",
    llm_response: {
      response_id: "resp_1",
      tool_calls: [{ tool_name: "get_user_session", args: {}, result_preview: "", result_full: "" }],
      final_text: "",
      raw_output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
    server_logs: {
      "fantasy-mcp": [{ timestamp: "2026-02-07T00:00:00.000Z", status: 200, wall_time_ms: 1, trace_id: "trace_pass_000", run_id: runId }],
      "auth-worker": [{ timestamp: "2026-02-07T00:00:00.100Z", status: 200, wall_time_ms: 1, trace_id: "trace_pass_000", run_id: runId }],
    },
  });

  const runDir = writeRun(runId, [trace]);

  const prevArgv = [...process.argv];
  process.argv = [process.argv[0] || "node", "accept.ts", runId];

  try {
    await runCli();
  } finally {
    process.argv = prevArgv;
  }

  const acceptance = JSON.parse(
    fs.readFileSync(path.join(runDir, "acceptance-summary.json"), "utf8")
  ) as { final_status: string; fail_reasons: unknown[]; warn_reasons: unknown[] };

  assert.equal(acceptance.final_status, "pass");
  assert.equal(acceptance.fail_reasons.length, 0);
  assert.equal(acceptance.warn_reasons.length, 0);

  fs.rmSync(runDir, { recursive: true, force: true });
});

test("accept fails on trace contamination", async () => {
  const runId = `test-accept-fail-${Date.now()}`;
  const trace = makeTrace({
    run_id: runId,
    trace_id: "trace_fail_000",
    scenario_id: "fail_scenario",
    llm_response: {
      response_id: "resp_1",
      tool_calls: [{ tool_name: "get_user_session", args: {}, result_preview: "", result_full: "" }],
      final_text: "",
      raw_output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
    server_logs: {
      "fantasy-mcp": [
        {
          timestamp: "2026-02-07T00:00:00.000Z",
          status: 200,
          wall_time_ms: 1,
          trace_id: "trace_fail_000",
          run_id: runId,
          message: "trace_id=trace_other_999",
        },
      ],
      "auth-worker": [{ timestamp: "2026-02-07T00:00:00.100Z", status: 200, wall_time_ms: 1, trace_id: "trace_fail_000", run_id: runId }],
    },
  });

  const runDir = writeRun(runId, [trace]);

  const prevArgv = [...process.argv];
  const prevExit = process.exit;
  process.argv = [process.argv[0] || "node", "accept.ts", runId];
  process.exit = ((code?: number) => {
    throw new Error(`EXIT_${code ?? 0}`);
  }) as unknown as typeof process.exit;

  try {
    await assert.rejects(async () => runCli(), /EXIT_1/);
  } finally {
    process.argv = prevArgv;
    process.exit = prevExit;
  }

  const acceptance = JSON.parse(
    fs.readFileSync(path.join(runDir, "acceptance-summary.json"), "utf8")
  ) as { final_status: string; fail_reasons: Array<{ code: string }> };

  assert.equal(acceptance.final_status, "fail");
  assert.equal(acceptance.fail_reasons.some((reason) => reason.code === "TRACE_CONTAMINATION"), true);

  fs.rmSync(runDir, { recursive: true, force: true });
});

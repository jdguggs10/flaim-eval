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

function writeRun(
  runId: string,
  traces: TraceArtifact[],
  options: { summaryErrored?: number } = {}
): string {
  const summaryErrored = options.summaryErrored ?? 0;
  const runDir = path.join(RUNS_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });

  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify(
      {
        run_id: runId,
        model: "gpt-5-mini",
        total_scenarios: traces.length,
        completed: traces.length - summaryErrored,
        errored: summaryErrored,
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

async function runAcceptExpectPass(runId: string): Promise<void> {
  const prevArgv = [...process.argv];
  process.argv = [process.argv[0] || "node", "accept.ts", runId];
  try {
    await runCli();
  } finally {
    process.argv = prevArgv;
  }
}

async function runAcceptExpectFail(runId: string): Promise<void> {
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
}

function readAcceptance(runDir: string): {
  final_status: string;
  fail_reasons: Array<{ code: string }>;
  warn_reasons: Array<{ code: string }>;
  policy_version: string;
  decisions_applied?: unknown;
  traces?: Array<{ trace_id: string; fail_reasons: string[]; warn_reasons: string[] }>;
} {
  return JSON.parse(
    fs.readFileSync(path.join(runDir, "acceptance-summary.json"), "utf8")
  ) as {
    final_status: string;
    fail_reasons: Array<{ code: string }>;
    warn_reasons: Array<{ code: string }>;
    policy_version: string;
    decisions_applied?: unknown;
    traces?: Array<{ trace_id: string; fail_reasons: string[]; warn_reasons: string[] }>;
  };
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
  await runAcceptExpectPass(runId);
  const acceptance = readAcceptance(runDir);

  assert.equal(acceptance.final_status, "pass");
  assert.equal(acceptance.fail_reasons.length, 0);
  assert.equal(acceptance.warn_reasons.length, 0);
  assert.ok(acceptance.policy_version);
  assert.ok(acceptance.decisions_applied);

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
  await runAcceptExpectFail(runId);
  const acceptance = readAcceptance(runDir);

  assert.equal(acceptance.final_status, "fail");
  assert.equal(acceptance.fail_reasons.some((reason) => reason.code === "TRACE_CONTAMINATION"), true);

  fs.rmSync(runDir, { recursive: true, force: true });
});

test("accept fails when fantasy-mcp worker is missing", async () => {
  const runId = `test-accept-missing-fantasy-${Date.now()}`;
  const trace = makeTrace({
    run_id: runId,
    trace_id: "trace_missing_fantasy_000",
    llm_response: {
      response_id: "resp_1",
      tool_calls: [{ tool_name: "get_user_session", args: {}, result_preview: "", result_full: "" }],
      final_text: "",
      raw_output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
    server_logs: {
      "auth-worker": [
        { timestamp: "2026-02-07T00:00:00.000Z", status: 200, wall_time_ms: 1, trace_id: "trace_missing_fantasy_000", run_id: runId },
      ],
    },
  });

  const runDir = writeRun(runId, [trace]);
  await runAcceptExpectFail(runId);
  const acceptance = readAcceptance(runDir);

  assert.equal(acceptance.final_status, "fail");
  assert.equal(
    acceptance.fail_reasons.some((reason) => reason.code === "MISSING_FANTASY_MCP"),
    true
  );

  fs.rmSync(runDir, { recursive: true, force: true });
});

test("accept fails when auth-worker is missing for get_user_session traces", async () => {
  const runId = `test-accept-missing-auth-${Date.now()}`;
  const trace = makeTrace({
    run_id: runId,
    trace_id: "trace_missing_auth_000",
    llm_response: {
      response_id: "resp_1",
      tool_calls: [{ tool_name: "get_user_session", args: {}, result_preview: "", result_full: "" }],
      final_text: "",
      raw_output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
    server_logs: {
      "fantasy-mcp": [
        { timestamp: "2026-02-07T00:00:00.000Z", status: 200, wall_time_ms: 1, trace_id: "trace_missing_auth_000", run_id: runId },
      ],
    },
  });

  const runDir = writeRun(runId, [trace]);
  await runAcceptExpectFail(runId);
  const acceptance = readAcceptance(runDir);

  assert.equal(acceptance.final_status, "fail");
  assert.equal(
    acceptance.fail_reasons.some((reason) => reason.code === "MISSING_AUTH_WORKER"),
    true
  );

  fs.rmSync(runDir, { recursive: true, force: true });
});

test("accept keeps single downstream miss as warning when escalation thresholds are not met", async () => {
  const runId = `test-accept-warn-only-${Date.now()}`;

  const baseLogs = {
    "fantasy-mcp": [
      { timestamp: "2026-02-07T00:00:00.000Z", status: 200, wall_time_ms: 1, run_id: runId },
    ],
  };

  const traces: TraceArtifact[] = [
    makeTrace({
      run_id: runId,
      trace_id: "trace_warn_000",
      llm_response: {
        response_id: "resp_1",
        tool_calls: [{ tool_name: "get_roster", args: { platform: "espn" }, result_preview: "", result_full: "" }],
        final_text: "",
        raw_output: [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
      server_logs: baseLogs,
    }),
    makeTrace({
      run_id: runId,
      trace_id: "trace_ok_001",
      llm_response: {
        response_id: "resp_2",
        tool_calls: [{ tool_name: "get_standings", args: {}, result_preview: "", result_full: "" }],
        final_text: "",
        raw_output: [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
      server_logs: baseLogs,
    }),
    makeTrace({
      run_id: runId,
      trace_id: "trace_ok_002",
      llm_response: {
        response_id: "resp_3",
        tool_calls: [{ tool_name: "get_standings", args: {}, result_preview: "", result_full: "" }],
        final_text: "",
        raw_output: [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
      server_logs: baseLogs,
    }),
    makeTrace({
      run_id: runId,
      trace_id: "trace_ok_003",
      llm_response: {
        response_id: "resp_4",
        tool_calls: [{ tool_name: "get_standings", args: {}, result_preview: "", result_full: "" }],
        final_text: "",
        raw_output: [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
      server_logs: baseLogs,
    }),
    makeTrace({
      run_id: runId,
      trace_id: "trace_ok_004",
      llm_response: {
        response_id: "resp_5",
        tool_calls: [{ tool_name: "get_standings", args: {}, result_preview: "", result_full: "" }],
        final_text: "",
        raw_output: [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
      server_logs: baseLogs,
    }),
  ];

  const runDir = writeRun(runId, traces);
  await runAcceptExpectPass(runId);
  const acceptance = readAcceptance(runDir);

  assert.equal(acceptance.final_status, "pass");
  assert.equal(
    acceptance.warn_reasons.some((reason) => reason.code === "MISSING_ESPN_CLIENT"),
    true
  );
  assert.equal(
    acceptance.fail_reasons.some((reason) => reason.code === "DOWNSTREAM_COVERAGE_ESCALATION"),
    false
  );

  fs.rmSync(runDir, { recursive: true, force: true });
});

test("accept escalates repeated downstream missing-worker warnings to failure", async () => {
  const runId = `test-accept-downstream-escalation-${Date.now()}`;
  const traces: TraceArtifact[] = [
    makeTrace({
      run_id: runId,
      trace_id: "trace_escalate_000",
      llm_response: {
        response_id: "resp_1",
        tool_calls: [{ tool_name: "get_roster", args: { platform: "espn" }, result_preview: "", result_full: "" }],
        final_text: "",
        raw_output: [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
      server_logs: {
        "fantasy-mcp": [{ timestamp: "2026-02-07T00:00:00.000Z", status: 200, wall_time_ms: 1, run_id: runId }],
      },
    }),
    makeTrace({
      run_id: runId,
      trace_id: "trace_escalate_001",
      llm_response: {
        response_id: "resp_2",
        tool_calls: [{ tool_name: "get_roster", args: { platform: "espn" }, result_preview: "", result_full: "" }],
        final_text: "",
        raw_output: [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
      server_logs: {
        "fantasy-mcp": [{ timestamp: "2026-02-07T00:00:00.000Z", status: 200, wall_time_ms: 1, run_id: runId }],
      },
    }),
  ];

  const runDir = writeRun(runId, traces);
  await runAcceptExpectFail(runId);
  const acceptance = readAcceptance(runDir);

  assert.equal(acceptance.final_status, "fail");
  assert.equal(
    acceptance.fail_reasons.some((reason) => reason.code === "DOWNSTREAM_COVERAGE_ESCALATION"),
    true
  );

  fs.rmSync(runDir, { recursive: true, force: true });
});

test("accept fails when summary indicates errored scenarios", async () => {
  const runId = `test-accept-run-errors-${Date.now()}`;
  const trace = makeTrace({
    run_id: runId,
    trace_id: "trace_run_error_000",
    llm_response: {
      response_id: "resp_1",
      tool_calls: [],
      final_text: "",
      raw_output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
    server_logs: {
      "fantasy-mcp": [{ timestamp: "2026-02-07T00:00:00.000Z", status: 200, wall_time_ms: 1, trace_id: "trace_run_error_000", run_id: runId }],
    },
  });

  const runDir = writeRun(runId, [trace], { summaryErrored: 1 });
  await runAcceptExpectFail(runId);
  const acceptance = readAcceptance(runDir);

  assert.equal(acceptance.final_status, "fail");
  assert.equal(acceptance.fail_reasons.some((reason) => reason.code === "RUN_HAS_ERRORS"), true);

  fs.rmSync(runDir, { recursive: true, force: true });
});

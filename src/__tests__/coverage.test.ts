import test from "node:test";
import assert from "node:assert/strict";
import { getActualWorkers, getMissingWorkers, inferExpectedWorkers } from "../coverage.js";
import type { TraceArtifact } from "../types.js";

function makeTrace(toolCalls: Array<{ tool_name: string; args?: Record<string, unknown> }>): TraceArtifact {
  return {
    schema_version: "1.1",
    run_id: "run-1",
    trace_id: "trace-1",
    scenario_id: "s1",
    timestamp_utc: "2026-02-07T00:00:00.000Z",
    model: "gpt-5",
    prompt: "p",
    instructions_file: null,
    expected_tools: [],
    llm_response: {
      response_id: "r",
      tool_calls: toolCalls.map((call) => ({
        tool_name: call.tool_name,
        args: call.args || {},
        result_preview: "",
        result_full: "",
      })),
      final_text: "",
      raw_output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
    duration_ms: 1,
    notes: [],
  };
}

test("inferExpectedWorkers returns deterministic worker set", () => {
  const trace = makeTrace([
    { tool_name: "get_user_session", args: {} },
    { tool_name: "get_roster", args: { platform: "espn" } },
    { tool_name: "get_matchups", args: { platform: "yahoo" } },
    { tool_name: "get_league_info", args: { platform: "sleeper" } },
  ]);

  const expected = inferExpectedWorkers(trace);
  assert.deepEqual(expected, ["auth-worker", "espn-client", "fantasy-mcp", "sleeper-client", "yahoo-client"]);
});

test("getActualWorkers/getMissingWorkers compute coverage differences", () => {
  const trace = makeTrace([{ tool_name: "get_user_session", args: {} }]);
  trace.server_logs = {
    "fantasy-mcp": [],
    "auth-worker": [],
  };

  const expected = ["auth-worker", "espn-client", "fantasy-mcp"];
  const actual = getActualWorkers(trace);
  const missing = getMissingWorkers(expected, actual);

  assert.deepEqual(actual, ["auth-worker", "fantasy-mcp"]);
  assert.deepEqual(missing, ["espn-client"]);
});

import type { TraceArtifact } from "./types.js";

/**
 * Determine expected worker coverage from tool routing behavior.
 */
export function inferExpectedWorkers(trace: TraceArtifact): string[] {
  const expected = new Set<string>(["fantasy-mcp"]);
  const toolCalls = trace.llm_response.tool_calls;

  if (toolCalls.some((call) => call.tool_name === "get_user_session")) {
    expected.add("auth-worker");
  }

  if (toolCalls.some((call) => call.args?.platform === "espn")) {
    expected.add("espn-client");
  }

  if (toolCalls.some((call) => call.args?.platform === "yahoo")) {
    expected.add("yahoo-client");
  }

  return [...expected].sort();
}

export function getActualWorkers(trace: TraceArtifact): string[] {
  return Object.keys(trace.server_logs || {}).sort();
}

export function getMissingWorkers(expectedWorkers: string[], actualWorkers: string[]): string[] {
  const actualSet = new Set(actualWorkers);
  return expectedWorkers.filter((worker) => !actualSet.has(worker)).sort();
}

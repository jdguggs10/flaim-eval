/**
 * Scenario definition — loaded from scenarios/*.json
 */
export interface Scenario {
  id: string;
  prompt: string;
  description: string;
  expected_tools: string[];
  instructions?: string; // relative path to .md file in repo root
  tags: string[];
}

/**
 * Tool call captured from OpenAI response
 */
export interface CapturedToolCall {
  tool_name: string;
  args: Record<string, unknown>;
  result_preview: string;
  result_full: string;
}

/**
 * Server-side logs from Cloudflare Workers Observability (optional enrichment).
 */
export type ServerLogs = {
  [workerName: string]: Array<{
    timestamp: string;
    status: number;
    wall_time_ms: number;
    message?: string;
  }>;
};

/**
 * Per-scenario trace artifact — written to runs/<run_id>/<scenario_id>.json
 */
export interface TraceArtifact {
  schema_version: "1.0";
  run_id: string;
  trace_id: string;
  scenario_id: string;
  timestamp_utc: string;
  model: string;
  prompt: string;
  instructions_file: string | null;
  expected_tools: string[];
  llm_response: {
    response_id: string;
    tool_calls: CapturedToolCall[];
    final_text: string;
    raw_output: unknown[];
    usage: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    };
  };
  duration_ms: number;
  server_logs?: ServerLogs;
  notes: string[];
}

/**
 * Run manifest — written to runs/<run_id>/manifest.json
 */
export interface RunManifest {
  run_id: string;
  timestamp_utc: string;
  model: string;
  mcp_url: string;
  scenario_count: number;
  scenarios: string[];
  traces: Array<{ scenario_id: string; trace_id: string }>;
  instructions_files: string[];
}

/**
 * Run summary — written to runs/<run_id>/summary.json
 */
export interface RunSummary {
  run_id: string;
  model: string;
  total_scenarios: number;
  completed: number;
  errored: number;
  total_duration_ms: number;
  total_tokens: { input: number; output: number; total: number };
  scenarios: Array<{
    id: string;
    trace_id: string;
    status: "ok" | "error";
    tool_calls: string[];
    expected_tools: string[];
    tools_match: boolean;
    expected_tools_hit: boolean;
    duration_ms: number;
    error?: string;
  }>;
}

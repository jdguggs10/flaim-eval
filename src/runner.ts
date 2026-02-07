import OpenAI from "openai";
import type {
  Scenario,
  TraceArtifact,
  CapturedToolCall,
} from "./types.js";
import { loadInstructions } from "./scenarios.js";
import { allowRunFallback, isCloudflareConfigured, fetchWorkerLogs } from "./cloudflare-logs.js";
import { getActualWorkers, getMissingWorkers, inferExpectedWorkers } from "./coverage.js";

const DEFAULT_MODEL = "gpt-5-mini-2025-08-07";
const LOG_ENRICHMENT_ATTEMPTS = 15;
const LOG_ENRICHMENT_RETRY_DELAY_MS = 5000;

interface RunnerConfig {
  model?: string;
  mcpUrl: string;
  accessToken: string;
  runId: string;
  traceId: string;
}

export function buildMcpHeaders(
  accessToken: string,
  runId: string,
  traceId: string
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Flaim-Eval-Run": runId,
    "X-Flaim-Eval-Trace": traceId,
  };
}

/**
 * Truncate a string for artifact preview.
 */
function previewText(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

/**
 * Extract tool calls from the OpenAI response output items.
 */
function extractToolCalls(
  output: OpenAI.Responses.ResponseOutputItem[]
): CapturedToolCall[] {
  const calls: CapturedToolCall[] = [];

  for (const item of output) {
    if (item.type === "mcp_call") {
      const full = item.output ?? "";
      calls.push({
        tool_name: item.name,
        args: JSON.parse(item.arguments ?? "{}"),
        result_preview: full ? previewText(full) : "",
        result_full: full,
      });
    }
  }

  return calls;
}

/**
 * Extract final assistant text from response output.
 */
function extractFinalText(
  output: OpenAI.Responses.ResponseOutputItem[]
): string {
  const textItems = output.filter(
    (item): item is OpenAI.Responses.ResponseOutputMessage =>
      item.type === "message" && item.role === "assistant"
  );

  return textItems
    .flatMap((msg) =>
      msg.content
        .filter(
          (c): c is OpenAI.Responses.ResponseOutputText =>
            c.type === "output_text"
        )
        .map((c) => c.text)
    )
    .join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a single scenario against OpenAI with Flaim MCP tools.
 */
export async function runScenario(
  scenario: Scenario,
  config: RunnerConfig
): Promise<TraceArtifact> {
  const model = config.model || DEFAULT_MODEL;
  const openai = new OpenAI();

  // Build input messages
  const input: OpenAI.Responses.ResponseInput = [];

  // Optionally prepend instructions from a skill file
  const instructions = loadInstructions(scenario);
  if (instructions) {
    input.push({ role: "developer", content: instructions });
  }

  input.push({ role: "user", content: scenario.prompt });

  const scenarioStart = new Date();
  const startTime = Date.now();

  const response = await openai.responses.create({
    model,
    input,
    tools: [
      {
        type: "mcp",
        server_url: config.mcpUrl,
        server_label: "flaim",
        headers: buildMcpHeaders(config.accessToken, config.runId, config.traceId),
        require_approval: "never",
      },
    ],
    store: true,
    parallel_tool_calls: false,
  });

  const durationMs = Date.now() - startTime;

  // Extract structured data from response
  const toolCalls = extractToolCalls(response.output);
  const finalText = extractFinalText(response.output);

  const artifact: TraceArtifact = {
    schema_version: "1.1",
    run_id: config.runId,
    trace_id: config.traceId,
    scenario_id: scenario.id,
    timestamp_utc: new Date().toISOString(),
    model,
    prompt: scenario.prompt,
    instructions_file: scenario.instructions || null,
    expected_tools: scenario.expected_tools,
    llm_response: {
      response_id: response.id,
      tool_calls: toolCalls,
      final_text: finalText,
      raw_output: response.output as unknown[],
      usage: {
        input_tokens: response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
        total_tokens: response.usage?.total_tokens ?? 0,
      },
    },
    duration_ms: durationMs,
    notes: [],
  };

  // Optionally enrich with Cloudflare worker logs
  if (isCloudflareConfigured()) {
    const scenarioEnd = new Date();
    let lastError: Error | null = null;
    let enrichmentAttempts = 0;

    for (let attempt = 1; attempt <= LOG_ENRICHMENT_ATTEMPTS; attempt++) {
      enrichmentAttempts = attempt;
      try {
        const serverLogs = await fetchWorkerLogs(
          scenarioStart,
          scenarioEnd,
          config.runId,
          config.traceId
        );
        if (Object.keys(serverLogs).length > 0) {
          artifact.server_logs = serverLogs;
          break;
        }
      } catch (err) {
        lastError = err as Error;
      }

      if (attempt < LOG_ENRICHMENT_ATTEMPTS) {
        await sleep(LOG_ENRICHMENT_RETRY_DELAY_MS);
      }
    }

    if (!artifact.server_logs) {
      if (lastError) {
        artifact.notes.push(
          `Server log enrichment failed after ${enrichmentAttempts} attempts: ${lastError.message}`
        );
      } else {
        artifact.notes.push(
          `Server log enrichment returned no events for time window after ${enrichmentAttempts} attempts`
        );
      }
    }

    const expectedWorkers = inferExpectedWorkers(artifact);
    const actualWorkers = getActualWorkers(artifact);
    const missingWorkers = getMissingWorkers(expectedWorkers, actualWorkers);
    artifact.enrichment = {
      mode: "initial",
      attempts: enrichmentAttempts,
      strict_trace_isolation: !allowRunFallback(),
      expected_workers: expectedWorkers,
      actual_workers: actualWorkers,
      missing_workers: missingWorkers,
      generated_at: new Date().toISOString(),
    };
    artifact.notes.push(
      `Coverage expected=[${expectedWorkers.join(",")}] actual=[${actualWorkers.join(",")}] missing=[${missingWorkers.join(",")}]`
    );
  }

  return artifact;
}

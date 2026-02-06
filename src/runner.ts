import OpenAI from "openai";
import type {
  Scenario,
  TraceArtifact,
  CapturedToolCall,
} from "./types.js";
import { loadInstructions } from "./scenarios.js";

const DEFAULT_MODEL = "gpt-5-mini-2025-08-07";

interface RunnerConfig {
  model?: string;
  mcpUrl: string;
  accessToken: string;
  runId: string;
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

  const startTime = Date.now();

  const response = await openai.responses.create({
    model,
    input,
    tools: [
      {
        type: "mcp",
        server_url: config.mcpUrl,
        server_label: "flaim",
        headers: { Authorization: `Bearer ${config.accessToken}` },
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
    schema_version: "1.0",
    run_id: config.runId,
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

  return artifact;
}

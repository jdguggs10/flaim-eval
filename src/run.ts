import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { loadScenarios } from "./scenarios.js";
import { runScenario } from "./runner.js";
import { getEvalApiKey, refreshAccessToken } from "./auth.js";
import { isCloudflareConfigured } from "./cloudflare-logs.js";
import { createTraceId } from "./trace.js";
import { writeTraceArtifact } from "./artifacts.js";
import type { RunManifest, RunSummary, TraceArtifact } from "./types.js";

const MCP_URL = process.env.FLAIM_MCP_URL || "https://api.flaim.app/mcp";
const MODEL = process.env.FLAIM_EVAL_MODEL || "gpt-5-mini-2025-08-07";

async function main() {
  // Parse CLI args: optional scenario IDs to filter
  const filterIds = process.argv.slice(2).filter((a) => !a.startsWith("-"));

  console.log("=== Flaim Eval Harness ===\n");
  console.log(`Model:  ${MODEL}`);
  console.log(`MCP:    ${MCP_URL}`);
  console.log(`Server logs: ${isCloudflareConfigured() ? "enabled" : "disabled (set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN to enable)"}`);

  // Load scenarios
  const scenarios = loadScenarios(filterIds.length > 0 ? filterIds : undefined);
  console.log(`Scenarios: ${scenarios.length}\n`);

  if (scenarios.length === 0) {
    console.log("No scenarios found. Check scenarios/ directory.");
    process.exit(1);
  }

  // Get access token
  const apiKey = getEvalApiKey();
  let accessToken: string;
  if (apiKey) {
    console.log("Using eval API key (no OAuth needed).\n");
    accessToken = apiKey;
  } else {
    console.log("Refreshing access token...");
    try {
      accessToken = await refreshAccessToken();
      console.log("Token refreshed.\n");
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  }

  // Create run directory
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  const runDir = path.resolve(import.meta.dirname, "../runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const scenarioTraces = scenarios.map((scenario, index) => ({
    scenario_id: scenario.id,
    trace_id: createTraceId(scenario.id, index, runId),
  }));

  // Write manifest
  const manifest: RunManifest = {
    run_id: runId,
    timestamp_utc: new Date().toISOString(),
    model: MODEL,
    mcp_url: MCP_URL,
    scenario_count: scenarios.length,
    scenarios: scenarios.map((s) => s.id),
    traces: scenarioTraces,
    instructions_files: [...new Set(scenarios.map((s) => s.instructions).filter(Boolean))] as string[],
  };
  fs.writeFileSync(
    path.join(runDir, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  // Run scenarios sequentially
  const results: TraceArtifact[] = [];
  const summaryScenarios: RunSummary["scenarios"] = [];
  let totalTokens = { input: 0, output: 0, total: 0 };

  for (const [index, scenario] of scenarios.entries()) {
    const traceId = scenarioTraces[index]?.trace_id || createTraceId(scenario.id, index, runId);
    console.log(`--- ${scenario.id} ---`);
    console.log(`  Trace:  ${traceId}`);
    console.log(`  Prompt: "${scenario.prompt}"`);
    if (scenario.instructions) {
      console.log(`  Instructions: ${scenario.instructions}`);
    }

    try {
      const artifact = await runScenario(scenario, {
        model: MODEL,
        mcpUrl: MCP_URL,
        accessToken,
        runId,
        traceId,
      });

      writeTraceArtifact(runDir, artifact);

      // Log summary
      const toolNames = artifact.llm_response.tool_calls.map(
        (tc) => tc.tool_name
      );
      const toolsMatch =
        JSON.stringify(toolNames) ===
        JSON.stringify(scenario.expected_tools);
      const expectedToolsHit = scenario.expected_tools.every(
        (t) => toolNames.includes(t)
      );

      console.log(`  Tools called: ${toolNames.join(" → ") || "(none)"}`);
      console.log(`  Expected:     ${scenario.expected_tools.join(" → ")}`);
      console.log(`  Pass:         ${expectedToolsHit ? "✓" : "✗"}${expectedToolsHit && !toolsMatch ? "  (extra tools called)" : ""}`);
      console.log(`  Tokens: ${artifact.llm_response.usage.total_tokens}`);
      console.log(`  Duration: ${artifact.duration_ms}ms`);
      console.log(`  Final: ${artifact.llm_response.final_text.slice(0, 100)}...`);
      console.log();

      results.push(artifact);
      summaryScenarios.push({
        id: scenario.id,
        trace_id: traceId,
        status: "ok",
        tool_calls: toolNames,
        expected_tools: scenario.expected_tools,
        tools_match: toolsMatch,
        expected_tools_hit: expectedToolsHit,
        duration_ms: artifact.duration_ms,
      });

      totalTokens.input += artifact.llm_response.usage.input_tokens;
      totalTokens.output += artifact.llm_response.usage.output_tokens;
      totalTokens.total += artifact.llm_response.usage.total_tokens;
    } catch (err) {
      const msg = (err as Error).message;
      console.log(`  ERROR: ${msg}\n`);
      summaryScenarios.push({
        id: scenario.id,
        trace_id: traceId,
        status: "error",
        tool_calls: [],
        expected_tools: scenario.expected_tools,
        tools_match: false,
        expected_tools_hit: false,
        duration_ms: 0,
        error: msg,
      });
    }
  }

  // Write summary
  const totalDuration = results.reduce((sum, r) => sum + r.duration_ms, 0);
  const summary: RunSummary = {
    run_id: runId,
    model: MODEL,
    total_scenarios: scenarios.length,
    completed: summaryScenarios.filter((s) => s.status === "ok").length,
    errored: summaryScenarios.filter((s) => s.status === "error").length,
    total_duration_ms: totalDuration,
    total_tokens: totalTokens,
    scenarios: summaryScenarios,
  };
  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify(summary, null, 2)
  );

  // Final report
  // Calculate pass rate (expected tools hit)
  const passed = summaryScenarios.filter((s) => s.expected_tools_hit).length;

  console.log("=== Run Complete ===");
  console.log(`Run ID:    ${runId}`);
  console.log(`Artifacts: ${runDir}/`);
  console.log(`Passed:    ${passed}/${summary.total_scenarios}`);
  console.log(`Errored:   ${summary.errored}`);
  console.log(`Tokens:    ${totalTokens.total} (${totalTokens.input} in / ${totalTokens.output} out)`);
  console.log(`Duration:  ${totalDuration}ms`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

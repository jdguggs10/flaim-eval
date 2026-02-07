import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getMissingWorkers, inferExpectedWorkers } from "./coverage.js";
import type { RunSummary, TraceArtifact } from "./types.js";

type AcceptanceReason = {
  code?: string;
  message?: string;
  trace_ids?: string[];
};

type AcceptanceSummary = {
  run_id?: string;
  generated_at?: string;
  final_status?: string;
  fail_reasons?: AcceptanceReason[];
  warn_reasons?: AcceptanceReason[];
  totals?: {
    traces?: number;
    events?: number;
    warnings?: number;
    failures?: number;
  };
};

type TraceReportRow = {
  scenarioId: string;
  traceId: string;
  expectedWorkers: string[];
  actualWorkers: string[];
  missingWorkers: string[];
  totalEvents: number;
  retryAttempts: number;
  tracePath: string;
  logsDirPath: string;
  traceExists: boolean;
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function getRunDir(runId: string): string {
  return path.resolve(import.meta.dirname, "../runs", runId);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

function fmtList(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "none";
}

function fmtBool(value: boolean): string {
  return value ? "yes" : "no";
}

function fmtStatus(value: string | undefined): string {
  if (!value) return "unknown";
  return value.toUpperCase();
}

function fmtReasonList(reasons: AcceptanceReason[] | undefined): string[] {
  if (!reasons || reasons.length === 0) {
    return ["none"];
  }

  return reasons.map((reason) => {
    const code = reason.code || "UNKNOWN";
    const traces = reason.trace_ids && reason.trace_ids.length > 0 ? ` (traces: ${reason.trace_ids.join(", ")})` : "";
    const message = reason.message ? ` - ${reason.message}` : "";
    return `${code}${traces}${message}`;
  });
}

function buildTraceRows(runDir: string, summary: RunSummary): TraceReportRow[] {
  return summary.scenarios.map((scenario) => {
    const tracePath = path.join(runDir, scenario.trace_id, "trace.json");
    const logsDirPath = path.join(runDir, scenario.trace_id, "logs");
    const traceExists = fs.existsSync(tracePath);

    if (!traceExists) {
      return {
        scenarioId: scenario.id,
        traceId: scenario.trace_id,
        expectedWorkers: [],
        actualWorkers: [],
        missingWorkers: [],
        totalEvents: 0,
        retryAttempts: 0,
        tracePath,
        logsDirPath,
        traceExists: false,
      };
    }

    const trace = readJson<TraceArtifact>(tracePath);
    const expectedWorkers = trace.enrichment?.expected_workers || inferExpectedWorkers(trace);
    const actualWorkers = trace.enrichment?.actual_workers || Object.keys(trace.server_logs || {}).sort();
    const missingWorkers = trace.enrichment?.missing_workers || getMissingWorkers(expectedWorkers, actualWorkers);
    const totalEvents = Object.values(trace.server_logs || {}).reduce(
      (sum, events) => sum + events.length,
      0
    );

    return {
      scenarioId: scenario.id,
      traceId: scenario.trace_id,
      expectedWorkers,
      actualWorkers,
      missingWorkers,
      totalEvents,
      retryAttempts: trace.enrichment?.attempts ?? 0,
      tracePath,
      logsDirPath,
      traceExists: true,
    };
  });
}

function buildReportMarkdown(
  runId: string,
  runDir: string,
  summary: RunSummary,
  acceptance: AcceptanceSummary | null,
  traceRows: TraceReportRow[]
): string {
  const generatedAt = new Date().toISOString();
  const expectedToolsHit = summary.scenarios.filter((scenario) => scenario.expected_tools_hit).length;

  const lines: string[] = [];
  lines.push("# Flaim Eval Report");
  lines.push("");
  lines.push(`- Generated at: ${generatedAt}`);
  lines.push(`- Run ID: ${runId}`);
  lines.push(`- Model: ${summary.model}`);
  lines.push(`- Run directory: \`${runDir}\``);
  lines.push("");

  lines.push("## Overview");
  lines.push("");
  lines.push(`- Scenario completion: ${summary.completed}/${summary.total_scenarios} (errored: ${summary.errored})`);
  lines.push(`- Expected-tools pass count: ${expectedToolsHit}/${summary.total_scenarios}`);
  lines.push(
    `- Tokens: ${summary.total_tokens.total} (${summary.total_tokens.input} input / ${summary.total_tokens.output} output)`
  );
  lines.push(`- Total duration: ${summary.total_duration_ms} ms`);
  lines.push(`- Acceptance status: ${acceptance ? fmtStatus(acceptance.final_status) : "NOT GENERATED"}`);
  lines.push("");

  lines.push("## Scenario Results");
  lines.push("");
  lines.push("| Scenario | Trace ID | Status | Expected Tools Hit | Tools Called | Duration (ms) | Error |");
  lines.push("| --- | --- | --- | --- | --- | ---: | --- |");
  for (const scenario of summary.scenarios) {
    const toolsCalled = scenario.tool_calls.length > 0 ? scenario.tool_calls.join(" -> ") : "(none)";
    lines.push(
      `| ${escapeCell(scenario.id)} | ${escapeCell(scenario.trace_id)} | ${escapeCell(scenario.status)} | ${fmtBool(
        scenario.expected_tools_hit
      )} | ${escapeCell(toolsCalled)} | ${scenario.duration_ms} | ${escapeCell(scenario.error || "")} |`
    );
  }
  lines.push("");

  lines.push("## Acceptance");
  lines.push("");
  if (!acceptance) {
    lines.push("- acceptance-summary.json not found. Run `npm run accept -- <run_id>` to generate it.");
  } else {
    lines.push(`- Final status: ${fmtStatus(acceptance.final_status)}`);
    if (acceptance.generated_at) {
      lines.push(`- Generated at: ${acceptance.generated_at}`);
    }
    if (acceptance.totals) {
      lines.push(
        `- Totals: traces=${acceptance.totals.traces ?? 0}, events=${acceptance.totals.events ?? 0}, warnings=${
          acceptance.totals.warnings ?? 0
        }, failures=${acceptance.totals.failures ?? 0}`
      );
    }
    lines.push("- Fail reasons:");
    for (const reason of fmtReasonList(acceptance.fail_reasons)) {
      lines.push(`  - ${reason}`);
    }
    lines.push("- Warn reasons:");
    for (const reason of fmtReasonList(acceptance.warn_reasons)) {
      lines.push(`  - ${reason}`);
    }
  }
  lines.push("");

  lines.push("## Trace Coverage");
  lines.push("");
  lines.push("| Trace ID | Scenario | Trace Artifact | Expected Workers | Actual Workers | Missing Workers | Events | Enrichment Attempts |");
  lines.push("| --- | --- | --- | --- | --- | --- | ---: | ---: |");
  for (const row of traceRows) {
    lines.push(
      `| ${escapeCell(row.traceId)} | ${escapeCell(row.scenarioId)} | ${row.traceExists ? "yes" : "no"} | ${escapeCell(
        fmtList(row.expectedWorkers)
      )} | ${escapeCell(fmtList(row.actualWorkers))} | ${escapeCell(fmtList(row.missingWorkers))} | ${row.totalEvents} | ${row.retryAttempts} |`
    );
  }
  lines.push("");

  lines.push("## Artifact Paths");
  lines.push("");
  lines.push(`- Summary: \`${path.join(runDir, "summary.json")}\``);
  lines.push(`- Acceptance: \`${path.join(runDir, "acceptance-summary.json")}\``);
  for (const row of traceRows) {
    lines.push(`- ${row.traceId} trace: \`${row.tracePath}\``);
    lines.push(`- ${row.traceId} logs: \`${row.logsDirPath}\``);
  }
  lines.push("");

  return lines.join("\n");
}

export async function runCli() {
  const [, , runId] = process.argv;
  if (!runId) {
    fail("Usage: npm run report -- <run_id>");
  }

  const runDir = getRunDir(runId);
  if (!fs.existsSync(runDir)) {
    fail(`Run directory not found: ${runDir}`);
  }

  const summaryPath = path.join(runDir, "summary.json");
  if (!fs.existsSync(summaryPath)) {
    fail(`summary.json not found in run directory: ${runDir}`);
  }
  const summary = readJson<RunSummary>(summaryPath);

  const acceptancePath = path.join(runDir, "acceptance-summary.json");
  const acceptance = fs.existsSync(acceptancePath)
    ? readJson<AcceptanceSummary>(acceptancePath)
    : null;

  const traceRows = buildTraceRows(runDir, summary);
  const report = buildReportMarkdown(runId, runDir, summary, acceptance, traceRows);
  const outputPath = path.join(runDir, "report.md");
  fs.writeFileSync(outputPath, report);

  console.log(`Wrote report: ${outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error("Fatal:", error);
    process.exit(1);
  });
}

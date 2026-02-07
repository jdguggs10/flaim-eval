import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inferExpectedWorkers, getMissingWorkers } from "./coverage.js";
import type { RunSummary, ServerLogEvent, TraceArtifact } from "./types.js";

const POLICY_VERSION = "2026-02-07.1";
const ESCALATION_MIN_TRACES = 2;
const ESCALATION_RATIO = 0.2;

type Reason = {
  code: string;
  message: string;
  trace_ids: string[];
};

type TraceAssessment = {
  trace_id: string;
  scenario_id: string;
  retry_attempts: number;
  expected_workers: string[];
  actual_workers: string[];
  missing_workers: string[];
  total_events: number;
  fail_reasons: string[];
  warn_reasons: string[];
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

function extractTraceIds(runDir: string): string[] {
  const manifestPath = path.join(runDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = readJson<{ traces?: Array<{ trace_id: string }> }>(manifestPath);
    if (manifest.traces?.length) {
      return manifest.traces.map((trace) => trace.trace_id);
    }
  }

  return fs
    .readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("trace_"))
    .map((entry) => entry.name)
    .sort();
}

function parseTraceIdsFromMessage(message: string | undefined): string[] {
  if (!message) return [];
  const matches = [...message.matchAll(/trace_id(?:=|":")([A-Za-z0-9_.-]+)/g)];
  return matches.map((match) => match[1]);
}

function parseRunIdsFromMessage(message: string | undefined): string[] {
  if (!message) return [];
  const matches = [...message.matchAll(/eval=([A-Za-z0-9:T.-]+Z)/g)];
  return matches.map((match) => match[1]);
}

function analyzeTraceIsolation(
  events: ServerLogEvent[],
  expectedTraceId: string,
  expectedRunId: string
): { traceMismatchCount: number; runMismatchCount: number } {
  let traceMismatchCount = 0;
  let runMismatchCount = 0;

  for (const event of events) {
    const traceCandidates = new Set<string>();
    if (event.trace_id) {
      traceCandidates.add(event.trace_id);
    }
    for (const traceId of parseTraceIdsFromMessage(event.message)) {
      traceCandidates.add(traceId);
    }

    if ([...traceCandidates].some((traceId) => traceId !== expectedTraceId)) {
      traceMismatchCount += 1;
    }

    const runCandidates = new Set<string>();
    if (event.run_id) {
      runCandidates.add(event.run_id);
    }
    for (const runId of parseRunIdsFromMessage(event.message)) {
      runCandidates.add(runId);
    }

    if ([...runCandidates].some((runId) => runId !== expectedRunId)) {
      runMismatchCount += 1;
    }
  }

  return { traceMismatchCount, runMismatchCount };
}

function addReason(bucket: Map<string, Reason>, code: string, message: string, traceId: string): void {
  const existing = bucket.get(code);
  if (existing) {
    if (!existing.trace_ids.includes(traceId)) {
      existing.trace_ids.push(traceId);
      existing.trace_ids.sort();
    }
    return;
  }

  bucket.set(code, {
    code,
    message,
    trace_ids: [traceId],
  });
}

function assessTrace(trace: TraceArtifact): TraceAssessment {
  const expectedWorkers = trace.enrichment?.expected_workers || inferExpectedWorkers(trace);
  const actualWorkers = Object.keys(trace.server_logs || {}).sort();
  const missingWorkers = getMissingWorkers(expectedWorkers, actualWorkers);
  const retryAttempts = trace.enrichment?.attempts ?? 0;

  const failReasons: string[] = [];
  const warnReasons: string[] = [];

  if (missingWorkers.includes("fantasy-mcp")) {
    failReasons.push("MISSING_FANTASY_MCP");
  }

  if (expectedWorkers.includes("auth-worker") && missingWorkers.includes("auth-worker")) {
    failReasons.push("MISSING_AUTH_WORKER");
  }

  if (expectedWorkers.includes("espn-client") && missingWorkers.includes("espn-client")) {
    warnReasons.push("MISSING_ESPN_CLIENT");
  }

  if (expectedWorkers.includes("yahoo-client") && missingWorkers.includes("yahoo-client")) {
    warnReasons.push("MISSING_YAHOO_CLIENT");
  }

  let totalEvents = 0;
  let traceMismatchCount = 0;
  let runMismatchCount = 0;

  for (const workerEvents of Object.values(trace.server_logs || {})) {
    totalEvents += workerEvents.length;
    const isolation = analyzeTraceIsolation(workerEvents, trace.trace_id, trace.run_id);
    traceMismatchCount += isolation.traceMismatchCount;
    runMismatchCount += isolation.runMismatchCount;
  }

  if (traceMismatchCount > 0) {
    failReasons.push("TRACE_CONTAMINATION");
  }

  if (runMismatchCount > 0) {
    failReasons.push("RUN_ID_MISMATCH");
  }

  return {
    trace_id: trace.trace_id,
    scenario_id: trace.scenario_id,
    retry_attempts: retryAttempts,
    expected_workers: expectedWorkers,
    actual_workers: actualWorkers,
    missing_workers: missingWorkers,
    total_events: totalEvents,
    fail_reasons: [...new Set(failReasons)].sort(),
    warn_reasons: [...new Set(warnReasons)].sort(),
  };
}

export async function runCli() {
  const [, , runId] = process.argv;

  if (!runId) {
    fail("Usage: npm run accept -- <run_id>");
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
  const traceIds = extractTraceIds(runDir);

  const assessments: TraceAssessment[] = [];

  for (const traceId of traceIds) {
    const tracePath = path.join(runDir, traceId, "trace.json");
    if (!fs.existsSync(tracePath)) {
      fail(`Trace artifact missing: ${tracePath}`);
    }

    const trace = readJson<TraceArtifact>(tracePath);
    assessments.push(assessTrace(trace));
  }

  const failBucket = new Map<string, Reason>();
  const warnBucket = new Map<string, Reason>();

  if (summary.errored > 0) {
    failBucket.set("RUN_HAS_ERRORS", {
      code: "RUN_HAS_ERRORS",
      message: `Run has ${summary.errored} errored scenarios.`,
      trace_ids: [],
    });
  }

  let downstreamWarnTraceCount = 0;

  for (const assessment of assessments) {
    let hasDownstreamWarn = false;

    for (const code of assessment.fail_reasons) {
      addReason(
        failBucket,
        code,
        `Trace ${assessment.trace_id} failed policy check: ${code}.`,
        assessment.trace_id
      );
    }

    for (const code of assessment.warn_reasons) {
      addReason(
        warnBucket,
        code,
        `Trace ${assessment.trace_id} warning: ${code}.`,
        assessment.trace_id
      );

      if (code === "MISSING_ESPN_CLIENT" || code === "MISSING_YAHOO_CLIENT") {
        hasDownstreamWarn = true;
      }
    }

    if (hasDownstreamWarn) {
      downstreamWarnTraceCount += 1;
    }
  }

  const downstreamWarnRatio = assessments.length > 0 ? downstreamWarnTraceCount / assessments.length : 0;
  if (
    downstreamWarnTraceCount >= ESCALATION_MIN_TRACES ||
    downstreamWarnRatio > ESCALATION_RATIO
  ) {
    failBucket.set("DOWNSTREAM_COVERAGE_ESCALATION", {
      code: "DOWNSTREAM_COVERAGE_ESCALATION",
      message:
        `Downstream worker warnings escalated to failure: ${downstreamWarnTraceCount} trace(s), ` +
        `${(downstreamWarnRatio * 100).toFixed(1)}% of run. Threshold: >=${ESCALATION_MIN_TRACES} traces or >${
          ESCALATION_RATIO * 100
        }%.`,
      trace_ids: assessments
        .filter((a) =>
          a.warn_reasons.includes("MISSING_ESPN_CLIENT") ||
          a.warn_reasons.includes("MISSING_YAHOO_CLIENT")
        )
        .map((a) => a.trace_id)
        .sort(),
    });
  }

  const failReasons = [...failBucket.values()].sort((a, b) => a.code.localeCompare(b.code));
  const warnReasons = [...warnBucket.values()].sort((a, b) => a.code.localeCompare(b.code));

  const acceptanceSummary = {
    schema_version: "1.0",
    policy_version: POLICY_VERSION,
    generated_at: new Date().toISOString(),
    run_id: runId,
    decisions_applied: {
      strict_trace_isolation_default: true,
      curated_structured_fields_default: true,
      acceptance_policy: "hybrid",
      downstream_escalation: {
        min_traces: ESCALATION_MIN_TRACES,
        ratio_gt: ESCALATION_RATIO,
      },
    },
    completion: {
      total_scenarios: summary.total_scenarios,
      completed: summary.completed,
      errored: summary.errored,
    },
    totals: {
      traces: assessments.length,
      events: assessments.reduce((sum, a) => sum + a.total_events, 0),
      warnings: warnReasons.length,
      failures: failReasons.length,
    },
    traces: assessments,
    fail_reasons: failReasons,
    warn_reasons: warnReasons,
    final_status: failReasons.length === 0 ? "pass" : "fail",
  };

  const outputPath = path.join(runDir, "acceptance-summary.json");
  fs.writeFileSync(outputPath, JSON.stringify(acceptanceSummary, null, 2));

  console.log(`Wrote acceptance summary: ${outputPath}`);
  console.log(`Final status: ${acceptanceSummary.final_status.toUpperCase()}`);

  if (acceptanceSummary.final_status === "fail") {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error("Fatal:", error);
    process.exit(1);
  });
}

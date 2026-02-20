import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { allowRunFallback, fetchWorkerLogs, isCloudflareConfigured } from "./cloudflare-logs.js";
import { readTraceArtifact, writeTraceArtifact } from "./artifacts.js";
import { getActualWorkers, getMissingWorkers, inferExpectedWorkers } from "./coverage.js";
import { mergeServerLogs } from "./logs-merge.js";
import type { RunManifest, TraceArtifact } from "./types.js";

const REENRICH_LOOKBACK_MS = 2 * 60 * 1000;
const REENRICH_LOOKAHEAD_MS = 5 * 60 * 1000;
const DEFAULT_REENRICH_ATTEMPTS = 6;
const DEFAULT_REENRICH_DELAY_MS = 15000;
const DEFAULT_WINDOW_EXPAND_MS = 30000;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return fallback;
}

function getReenrichAttempts(): number {
  return parsePositiveInt(process.env.FLAIM_EVAL_REENRICH_ATTEMPTS, DEFAULT_REENRICH_ATTEMPTS);
}

function getReenrichDelayMs(): number {
  return parsePositiveInt(process.env.FLAIM_EVAL_REENRICH_DELAY_MS, DEFAULT_REENRICH_DELAY_MS);
}

function getWindowExpandMs(): number {
  return parsePositiveInt(process.env.FLAIM_EVAL_REENRICH_WINDOW_EXPAND_MS, DEFAULT_WINDOW_EXPAND_MS);
}

export function buildReenrichWindow(trace: Pick<TraceArtifact, "timestamp_utc" | "duration_ms">): {
  start: Date;
  end: Date;
} {
  const endTime = new Date(trace.timestamp_utc);
  if (Number.isNaN(endTime.getTime())) {
    throw new Error(`Invalid trace timestamp: ${trace.timestamp_utc}`);
  }
  const start = new Date(
    endTime.getTime() - Math.max(trace.duration_ms, 0) - REENRICH_LOOKBACK_MS
  );
  const end = new Date(endTime.getTime() + REENRICH_LOOKAHEAD_MS);
  return { start, end };
}

export function buildAttemptWindow(
  baseWindow: { start: Date; end: Date },
  attempt: number,
  expandMs: number
): { start: Date; end: Date } {
  const expandBy = Math.max(0, attempt - 1) * Math.max(0, expandMs);
  return {
    start: new Date(baseWindow.start.getTime() - expandBy),
    end: new Date(baseWindow.end.getTime() + expandBy),
  };
}

function readManifest(runDir: string): RunManifest | null {
  const manifestPath = path.join(runDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as RunManifest;
}

export function resolveTraceIds(
  runDir: string,
  requestedTraceId?: string
): string[] {
  if (requestedTraceId) {
    return [requestedTraceId];
  }

  const manifest = readManifest(runDir);
  if (manifest?.traces?.length) {
    return manifest.traces.map((trace) => trace.trace_id);
  }

  return fs
    .readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("trace_"))
    .map((entry) => entry.name)
    .sort();
}

type EnrichResult = {
  attempts: number;
  expectedWorkers: string[];
  actualWorkers: string[];
  missingWorkers: string[];
};

async function enrichTrace(runDir: string, traceId: string): Promise<EnrichResult> {
  const artifact = readTraceArtifact(runDir, traceId);
  const expectedWorkers = inferExpectedWorkers(artifact);
  const maxAttempts = getReenrichAttempts();
  const delayMs = getReenrichDelayMs();
  const expandMs = getWindowExpandMs();

  const baseWindow = buildReenrichWindow(artifact);
  let attemptsUsed = 0;
  let selectedLogs = artifact.server_logs || {};
  let selectedActualWorkers = getActualWorkers({ ...artifact, server_logs: selectedLogs });
  let selectedMissingWorkers = getMissingWorkers(expectedWorkers, selectedActualWorkers);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsUsed = attempt;
    const { start, end } = buildAttemptWindow(baseWindow, attempt, expandMs);

    const logs = await fetchWorkerLogs(start, end, artifact.run_id, artifact.trace_id);
    selectedLogs = mergeServerLogs(selectedLogs, logs);
    selectedActualWorkers = Object.keys(selectedLogs).sort();
    selectedMissingWorkers = getMissingWorkers(expectedWorkers, selectedActualWorkers);

    if (selectedMissingWorkers.length === 0) {
      break;
    }

    if (attempt < maxAttempts) {
      await sleep(delayMs);
    }
  }

  const now = new Date().toISOString();
  const workerCount = Object.keys(selectedLogs).length;

  if (workerCount > 0) {
    artifact.server_logs = selectedLogs;
    artifact.notes.push(
      `Re-enriched worker logs at ${now} (${workerCount} workers, attempts=${attemptsUsed}).`
    );
  } else {
    artifact.notes.push(
      `Re-enrichment found no worker logs at ${now} (attempts=${attemptsUsed}).`
    );
  }

  artifact.enrichment = {
    mode: "reenrich",
    attempts: attemptsUsed,
    strict_trace_isolation: !allowRunFallback(),
    expected_workers: expectedWorkers,
    actual_workers: selectedActualWorkers,
    missing_workers: selectedMissingWorkers,
    generated_at: now,
  };

  artifact.notes.push(
    `Coverage expected=[${expectedWorkers.join(",")}] actual=[${selectedActualWorkers.join(",")}] missing=[${selectedMissingWorkers.join(",")}]`
  );

  writeTraceArtifact(runDir, artifact);

  return {
    attempts: attemptsUsed,
    expectedWorkers,
    actualWorkers: selectedActualWorkers,
    missingWorkers: selectedMissingWorkers,
  };
}

export async function runCli() {
  const [, , runId, traceId] = process.argv;

  if (!runId) {
    fail("Usage: npm run enrich -- <run_id> [trace_id]");
  }

  if (!isCloudflareConfigured()) {
    fail(
      "Cloudflare log enrichment is disabled. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN."
    );
  }

  const runDir = path.resolve(import.meta.dirname, "../runs", runId);
  if (!fs.existsSync(runDir)) {
    fail(`Run directory not found: ${runDir}`);
  }

  const traceIds = resolveTraceIds(runDir, traceId);
  if (traceIds.length === 0) {
    fail(`No traces found in run directory: ${runDir}`);
  }

  let completed = 0;
  let failed = 0;
  for (const id of traceIds) {
    process.stdout.write(`Re-enriching ${id}... `);
    try {
      const result = await enrichTrace(runDir, id);
      completed += 1;
      process.stdout.write(
        `ok (attempts=${result.attempts}, missing=${result.missingWorkers.length ? result.missingWorkers.join(",") : "none"})\n`
      );
    } catch (error) {
      failed += 1;
      process.stdout.write(`failed (${(error as Error).message})\n`);
    }
  }

  console.log(`Done. Updated ${completed}/${traceIds.length} traces.`);
  if (failed > 0) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error("Fatal:", error);
    process.exit(1);
  });
}

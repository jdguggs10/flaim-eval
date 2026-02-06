import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fetchWorkerLogs, isCloudflareConfigured } from "./cloudflare-logs.js";
import { readTraceArtifact, writeTraceArtifact } from "./artifacts.js";
import type { RunManifest, TraceArtifact } from "./types.js";

const REENRICH_LOOKBACK_MS = 2 * 60 * 1000;
const REENRICH_LOOKAHEAD_MS = 5 * 60 * 1000;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
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

async function enrichTrace(runDir: string, traceId: string): Promise<void> {
  const artifact = readTraceArtifact(runDir, traceId);
  const { start, end } = buildReenrichWindow(artifact);
  const logs = await fetchWorkerLogs(start, end, artifact.run_id, artifact.trace_id);
  const workerCount = Object.keys(logs).length;
  const now = new Date().toISOString();

  if (workerCount > 0) {
    artifact.server_logs = logs;
    artifact.notes.push(`Re-enriched worker logs at ${now} (${workerCount} workers).`);
  } else {
    artifact.notes.push(`Re-enrichment found no worker logs at ${now}.`);
  }

  writeTraceArtifact(runDir, artifact);
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
      await enrichTrace(runDir, id);
      completed += 1;
      process.stdout.write("ok\n");
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

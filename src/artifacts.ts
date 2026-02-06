import fs from "node:fs";
import path from "node:path";
import type { TraceArtifact } from "./types.js";

export function getTraceDir(runDir: string, traceId: string): string {
  return path.join(runDir, traceId);
}

export function writeTraceArtifact(runDir: string, artifact: TraceArtifact): void {
  const traceDir = getTraceDir(runDir, artifact.trace_id);
  fs.mkdirSync(traceDir, { recursive: true });
  fs.writeFileSync(
    path.join(traceDir, "trace.json"),
    JSON.stringify(artifact, null, 2)
  );

  const logsDir = path.join(traceDir, "logs");
  const serverLogs = artifact.server_logs || {};
  const workerNames = Object.keys(serverLogs);

  if (workerNames.length === 0) {
    return;
  }

  fs.mkdirSync(logsDir, { recursive: true });
  const expectedFiles = new Set(workerNames.map((name) => `${name}.json`));

  for (const workerName of workerNames) {
    fs.writeFileSync(
      path.join(logsDir, `${workerName}.json`),
      JSON.stringify(serverLogs[workerName], null, 2)
    );
  }

  for (const file of fs.readdirSync(logsDir)) {
    if (!expectedFiles.has(file)) {
      fs.unlinkSync(path.join(logsDir, file));
    }
  }
}

export function readTraceArtifact(runDir: string, traceId: string): TraceArtifact {
  const tracePath = path.join(getTraceDir(runDir, traceId), "trace.json");
  return JSON.parse(fs.readFileSync(tracePath, "utf8")) as TraceArtifact;
}

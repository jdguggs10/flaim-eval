const TRACE_PREFIX = "trace";
const RUN_SCOPE_LEN = 16;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function scopeRunId(runId: string): string {
  const scoped = slugify(runId);
  if (!scoped) {
    return "run";
  }
  const tail = scoped.slice(-RUN_SCOPE_LEN).replace(/^_+/, "");
  return tail || "run";
}

/**
 * Build a deterministic per-question trace ID.
 */
export function createTraceId(scenarioId: string, index: number, runId: string): string {
  const safeScenario = slugify(scenarioId) || "scenario";
  const safeIndex = String(index).padStart(3, "0");
  const runScope = scopeRunId(runId);
  return `${TRACE_PREFIX}_${safeScenario}_${safeIndex}_${runScope}`;
}

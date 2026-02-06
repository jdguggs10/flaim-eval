const TRACE_PREFIX = "trace";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

/**
 * Build a deterministic per-question trace ID.
 */
export function createTraceId(scenarioId: string, index: number): string {
  const safeScenario = slugify(scenarioId) || "scenario";
  const safeIndex = String(index).padStart(3, "0");
  return `${TRACE_PREFIX}_${safeScenario}_${safeIndex}`;
}

import type { ServerLogEvent, ServerLogs } from "./types.js";

function eventKey(event: ServerLogEvent): string {
  return [
    event.timestamp,
    event.service || "",
    event.phase || "",
    event.request_id || "",
    event.trace_id || "",
    event.run_id || "",
    event.tool || "",
    event.message || "",
    event.status === null || typeof event.status === "undefined" ? "" : String(event.status),
    event.status_text || "",
    typeof event.duration_ms === "number" ? String(event.duration_ms) : "",
  ].join("|");
}

function dedupeEvents(events: ServerLogEvent[]): ServerLogEvent[] {
  const seen = new Set<string>();
  const deduped: ServerLogEvent[] = [];

  for (const event of events) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }

  return deduped;
}

export function mergeServerLogs(current: ServerLogs, incoming: ServerLogs): ServerLogs {
  const merged: ServerLogs = {};

  for (const [workerName, events] of Object.entries(current || {})) {
    if (events.length > 0) {
      merged[workerName] = [...events];
    }
  }

  for (const [workerName, events] of Object.entries(incoming || {})) {
    if (events.length === 0) continue;
    const existing = merged[workerName] || [];
    merged[workerName] = dedupeEvents([...existing, ...events]);
  }

  return merged;
}

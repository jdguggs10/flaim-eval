/**
 * Optional Cloudflare Workers Observability log enrichment.
 *
 * When CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are set,
 * fetches worker invocation logs for the time window of each scenario run.
 *
 * Uses the Workers Observability Telemetry Query API:
 * POST /accounts/{account_id}/workers/observability/telemetry/query
 */

import type { ServerLogEvent, ServerLogs } from "./types.js";

export const WORKER_NAMES = [
  "fantasy-mcp",
  "espn-client",
  "yahoo-client",
  "sleeper-client",
  "auth-worker",
];
const TIME_PADDING_MS = 30000;

interface CloudflareConfig {
  accountId: string;
  apiToken: string;
}

interface ObservabilitySource {
  service?: string;
  phase?: string;
  run_id?: string;
  trace_id?: string;
  correlation_id?: string;
  tool?: string;
  sport?: string;
  league_id?: string;
  path?: string;
  method?: string;
  status?: string;
  message?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

interface ObservabilityEvent {
  timestamp?: number;
  source?: ObservabilitySource;
  $workers?: {
    wallTimeMs?: number;
    outcome?: string;
    requestId?: string;
    event?: {
      response?: { status?: number };
    };
    [key: string]: unknown;
  };
  $metadata?: {
    id?: string;
    requestId?: string;
    traceId?: string;
    trigger?: string;
    message?: string;
    service?: string;
    type?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface TelemetryQueryResponse {
  success: boolean;
  errors: Array<{ message: string }>;
  result?: {
    events?: {
      count?: number;
      events?: ObservabilityEvent[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

export function isCloudflareConfigured(): boolean {
  return !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);
}

export function allowRunFallback(): boolean {
  return process.env.FLAIM_EVAL_ALLOW_RUN_FALLBACK === "1";
}

function getConfig(): CloudflareConfig {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  }
  return { accountId, apiToken };
}

export function buildTraceNeedles(traceId: string): string[] {
  return [`\"trace_id\":\"${traceId}\"`, `trace_id=${traceId}`];
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function getEventTraceId(event: ObservabilityEvent): string | undefined {
  return event.$metadata?.traceId || event.source?.trace_id;
}

function getEventRunId(event: ObservabilityEvent): string | undefined {
  return event.source?.run_id;
}

function hasMatchingTrace(event: ObservabilityEvent, traceId: string): boolean {
  const eventTrace = getEventTraceId(event);
  return eventTrace === traceId;
}

function parseRunIdsFromMessage(message: string | undefined): string[] {
  if (!message) return [];
  const matches = [...message.matchAll(/eval=([A-Za-z0-9:T.-]+Z)/g)];
  return matches.map((match) => match[1]);
}

function hasMatchingRun(event: ObservabilityEvent, evalRunId: string): boolean {
  const runCandidates = new Set<string>();

  const sourceRun = getEventRunId(event);
  if (sourceRun) {
    runCandidates.add(sourceRun);
  }

  for (const runId of parseRunIdsFromMessage(event.$metadata?.message)) {
    runCandidates.add(runId);
  }

  for (const runId of parseRunIdsFromMessage(event.source?.message)) {
    runCandidates.add(runId);
  }

  if (runCandidates.size === 0) {
    return false;
  }

  return [...runCandidates].every((runId) => runId === evalRunId);
}

function dedupeEvents(events: ObservabilityEvent[]): ObservabilityEvent[] {
  const seen = new Set<string>();
  const deduped: ObservabilityEvent[] = [];

  for (const event of events) {
    const key = event.$metadata?.id
      ? `id:${event.$metadata.id}`
      : `fallback:${event.timestamp || ""}|${event.$metadata?.requestId || ""}|${event.$metadata?.message || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }

  return deduped;
}

async function queryWorkerLogs(
  config: CloudflareConfig,
  workerName: string,
  startTime: Date,
  endTime: Date,
  extraFilters: Array<{ key: string; operation: string; type: string; value: string }> = []
): Promise<ObservabilityEvent[]> {
  const from = startTime.getTime() - TIME_PADDING_MS;
  const to = endTime.getTime() + TIME_PADDING_MS;

  const filters: Array<{ key: string; operation: string; type: string; value: string }> = [
    {
      key: "$metadata.service",
      operation: "eq",
      type: "string",
      value: workerName,
    },
  ];

  filters.push(...extraFilters);

  const body = {
    queryId: `flaim-eval-${workerName}`,
    view: "events",
    limit: 200,
    parameters: {
      datasets: ["cloudflare-workers"],
      filters,
      calculations: [],
      groupBys: [],
    },
    timeframe: { from, to },
  };

  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/workers/observability/telemetry/query`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "no body");
    throw new Error(`Cloudflare API ${response.status}: ${text}`);
  }

  const data = (await response.json()) as TelemetryQueryResponse;
  if (!data.success) {
    throw new Error(`Cloudflare query failed: ${data.errors?.map((e) => e.message).join(", ")}`);
  }

  return data.result?.events?.events ?? [];
}

async function queryWorkerLogsForTrace(
  config: CloudflareConfig,
  workerName: string,
  startTime: Date,
  endTime: Date,
  evalRunId: string,
  traceId: string
): Promise<ObservabilityEvent[]> {
  const strictTraceEvents = await queryWorkerLogs(config, workerName, startTime, endTime, [
    {
      key: "$metadata.traceId",
      operation: "eq",
      type: "string",
      value: traceId,
    },
  ]);

  const traceNeedles = buildTraceNeedles(traceId);
  const traceNeedleBatches = await Promise.all(
    traceNeedles.map((needle) =>
      queryWorkerLogs(config, workerName, startTime, endTime, [
        {
          key: "$metadata.message",
          operation: "includes",
          type: "string",
          value: needle,
        },
      ])
    )
  );

  const strictEvents = dedupeEvents([...strictTraceEvents, ...traceNeedleBatches.flat()]).filter(
    (event) => hasMatchingTrace(event, traceId) && hasMatchingRun(event, evalRunId)
  );

  if (!allowRunFallback() || workerName !== "fantasy-mcp") {
    return strictEvents;
  }

  const runFallbackEvents = await queryWorkerLogs(config, workerName, startTime, endTime, [
    {
      key: "$metadata.message",
      operation: "includes",
      type: "string",
      value: `eval=${evalRunId}`,
    },
  ]);

  const fallbackEvents = dedupeEvents(runFallbackEvents).filter((event) => {
    if (!hasMatchingRun(event, evalRunId)) {
      return false;
    }

    const eventTrace = getEventTraceId(event);
    if (!eventTrace) {
      return true;
    }
    return eventTrace === traceId;
  });

  return dedupeEvents([...strictEvents, ...fallbackEvents]);
}

function toLogEvent(event: ObservabilityEvent): ServerLogEvent {
  const statusFromWorkers = event.$workers?.event?.response?.status;
  const statusFromSource = parseNumber(event.source?.status);
  const status = typeof statusFromWorkers === "number" ? statusFromWorkers : statusFromSource ?? null;

  const durationFromSource = parseNumber(event.source?.duration_ms);

  return {
    timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
    status,
    wall_time_ms: event.$workers?.wallTimeMs ?? 0,
    message: event.$metadata?.message || event.source?.message,

    service: event.source?.service || event.$metadata?.service,
    phase: typeof event.source?.phase === "string" ? event.source.phase : undefined,
    run_id: typeof event.source?.run_id === "string" ? event.source.run_id : undefined,
    trace_id: getEventTraceId(event),
    correlation_id:
      typeof event.source?.correlation_id === "string" ? event.source.correlation_id : undefined,
    tool: typeof event.source?.tool === "string" ? event.source.tool : undefined,
    sport: typeof event.source?.sport === "string" ? event.source.sport : undefined,
    league_id: typeof event.source?.league_id === "string" ? event.source.league_id : undefined,
    path: typeof event.source?.path === "string" ? event.source.path : undefined,
    method: typeof event.source?.method === "string" ? event.source.method : undefined,
    outcome: typeof event.$workers?.outcome === "string" ? event.$workers.outcome : undefined,
    request_id:
      event.$metadata?.requestId ||
      (typeof event.$workers?.requestId === "string" ? event.$workers.requestId : undefined),
    trigger: typeof event.$metadata?.trigger === "string" ? event.$metadata.trigger : undefined,
    status_text: typeof event.source?.status === "string" ? event.source.status : undefined,
    duration_ms: durationFromSource,
  };
}

export async function fetchWorkerLogs(
  startTime: Date,
  endTime: Date,
  evalRunId: string,
  traceId: string
): Promise<ServerLogs> {
  const config = getConfig();
  const logs: ServerLogs = {};

  const results = await Promise.allSettled(
    WORKER_NAMES.map(async (workerName) => {
      const events = await queryWorkerLogsForTrace(
        config,
        workerName,
        startTime,
        endTime,
        evalRunId,
        traceId
      );
      return { workerName, events };
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value.events.length > 0) {
      logs[result.value.workerName] = result.value.events.map(toLogEvent);
    }
  }

  return logs;
}

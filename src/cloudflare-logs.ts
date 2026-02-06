/**
 * Optional Cloudflare Workers Observability log enrichment.
 *
 * When CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are set,
 * fetches worker invocation logs for the time window of each scenario run.
 *
 * Uses the Workers Observability Telemetry Query API:
 * POST /accounts/{account_id}/workers/observability/telemetry/query
 */

import type { ServerLogs } from "./types.js";

export const WORKER_NAMES = [
  "fantasy-mcp",
  "espn-client",
  "yahoo-client",
  "auth-worker",
];
const TIME_PADDING_MS = 30000;

interface CloudflareConfig {
  accountId: string;
  apiToken: string;
}

export function isCloudflareConfigured(): boolean {
  return !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);
}

function getConfig(): CloudflareConfig {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  }
  return { accountId, apiToken };
}

interface ObservabilityEvent {
  timestamp?: number;
  $workers?: {
    wallTimeMs?: number;
    event?: {
      response?: { status?: number };
    };
    [key: string]: unknown;
  };
  $metadata?: {
    id?: string;
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

export function buildTraceNeedles(traceId: string): string[] {
  return [
    `\"trace_id\":\"${traceId}\"`,
    `trace_id=${traceId}`,
    traceId,
  ];
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

function dedupeEvents(events: ObservabilityEvent[]): ObservabilityEvent[] {
  const seen = new Set<string>();
  const deduped: ObservabilityEvent[] = [];

  for (const event of events) {
    const key = event.$metadata?.id
      ? `id:${event.$metadata.id}`
      : `fallback:${event.timestamp || ""}|${event.$metadata?.message || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }

  return deduped;
}

async function queryWorkerLogsForTrace(
  config: CloudflareConfig,
  workerName: string,
  startTime: Date,
  endTime: Date,
  evalRunId: string,
  traceId: string
): Promise<ObservabilityEvent[]> {
  // Primary path: Cloudflare stores request trace header as structured metadata.
  const traceEvents = await queryWorkerLogs(config, workerName, startTime, endTime, [
    {
      key: "$metadata.traceId",
      operation: "eq",
      type: "string",
      value: traceId,
    },
  ]);

  const needles = [...buildTraceNeedles(traceId)];

  // Legacy fallback for fantasy-mcp logs that may only carry eval run tag.
  if (workerName === "fantasy-mcp") {
    needles.push(`eval=${evalRunId}`);
  }

  const needleBatches = await Promise.all(
    needles.map((needle) =>
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

  return dedupeEvents([...traceEvents, ...needleBatches.flat()]);
}

function toLogEvent(event: ObservabilityEvent): {
  timestamp: string;
  status: number;
  wall_time_ms: number;
  message?: string;
} {
  return {
    timestamp: event.timestamp
      ? new Date(event.timestamp).toISOString()
      : new Date().toISOString(),
    status: event.$workers?.event?.response?.status ?? 0,
    wall_time_ms: event.$workers?.wallTimeMs ?? 0,
    message: event.$metadata?.message,
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

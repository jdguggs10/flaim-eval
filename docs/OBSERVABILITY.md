# Observability Contract

This is the canonical observability contract between `flaim-eval` and Flaim workers.

## Request headers (sent by eval runner)

- `X-Flaim-Eval-Run`: stable run ID for the full eval execution.
- `X-Flaim-Eval-Trace`: per-scenario (per question) trace ID.

## Worker propagation expectation

Headers must be preserved through:

1. `fantasy-mcp` ingress
2. `fantasy-mcp` -> `espn-client` / `yahoo-client`
3. `fantasy-mcp` -> `auth-worker`

## Required structured fields in logs

For eval-path logs, workers should emit JSON with:

- `service`
- `phase`
- `run_id`
- `trace_id`
- `correlation_id`

Additional fields (`tool`, `status`, `duration_ms`, `sport`, `league_id`) are recommended.

## Query model used by `flaim-eval`

`src/cloudflare-logs.ts` queries all workers with:

1. `"$metadata.service" == <worker>`
2. Primary filter: `"$metadata.traceId" == <trace_id>`
3. Message fallback: trace needles only (`trace_id` forms)
4. Optional legacy fallback: run-level message needle (`eval=<run_id>`) only when `FLAIM_EVAL_ALLOW_RUN_FALLBACK=1`

Strict trace post-filtering is always applied to prevent contamination.

Timeframe is sent as epoch milliseconds and responses are read from `result.events.events`.

## Artifact contract

Per trace:

- `runs/<run_id>/<trace_id>/trace.json`
- `runs/<run_id>/<trace_id>/logs/<worker>.json`

`server_logs` inside `trace.json` is optional; traces remain valid when no logs are present.

Each normalized log event preserves core compatibility fields:

- `timestamp`, `status`, `wall_time_ms`, `message`

And may include structured fields from observability payloads:

- `service`, `phase`, `run_id`, `trace_id`, `correlation_id`
- `tool`, `sport`, `league_id`, `path`, `method`
- `request_id`, `trigger`, `outcome`, `duration_ms`, `status_text`

## Distillation rule

The relevance boundary is trace ID. Events lacking the target trace should not appear in that trace artifact.

Low-signal entries (for example request path-only messages) may still appear if they carry the correct trace metadata.

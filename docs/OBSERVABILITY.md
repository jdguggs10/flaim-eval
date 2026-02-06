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
3. Legacy fallback: message includes trace/run needles

Timeframe is sent as epoch milliseconds and responses are read from `result.events.events`.

## Artifact contract

Per trace:

- `runs/<run_id>/<trace_id>/trace.json`
- `runs/<run_id>/<trace_id>/logs/<worker>.json`

`server_logs` inside `trace.json` is optional; traces remain valid when no logs are present.

## Distillation rule

The relevance boundary is trace ID. Events lacking the target trace should not appear in that trace artifact.

Low-signal entries (for example request path-only messages) may still appear if they carry the correct trace metadata.

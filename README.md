# flaim-eval

MCP eval harness and skill development workspace for [Flaim](https://github.com/jdguggs10/flaim).

Two purposes:
1. **Debugging** — Fire prompts at OpenAI with Flaim's MCP tools, capture the full tool-call chain in a single artifact.
2. **Skill development** — Iterate on instruction `.md` files and test how they change model behavior.

## Quick start

```bash
npm install
cp .env.example .env       # add OPENAI_API_KEY
npm run bootstrap           # one-time OAuth setup (opens browser)
npm run eval                # run all scenarios
npm run eval who_is_on_my_roster  # run one scenario
npm run enrich -- <run_id> [trace_id]  # re-fetch delayed Cloudflare logs only
```

## Trace artifact layout

Each scenario writes into a per-trace directory:

```text
runs/<run_id>/
  manifest.json
  summary.json
  trace_<scenario>_<idx>/
    trace.json
    logs/
      fantasy-mcp.json
      espn-client.json
      yahoo-client.json
      auth-worker.json
```

`trace.json` includes:
- `run_id`
- `trace_id`
- tool calls and final model text
- optional `server_logs` keyed by worker name

## Observability contract

The runner sends both headers on each MCP question:
- `X-Flaim-Eval-Run`
- `X-Flaim-Eval-Trace`

Workers should propagate these headers and emit structured JSON logs containing:
- `service`
- `phase`
- `run_id`
- `trace_id`
- `correlation_id`

## Design doc

See `docs/dev/mcp-eval-observability-scope.md` in the Flaim repo.

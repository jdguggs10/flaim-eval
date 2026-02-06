# flaim-eval

MCP eval harness and skill-development workspace for [Flaim](https://github.com/jdguggs10/flaim).

## What it does
1. Debugs model + MCP behavior by capturing full tool-call traces.
2. Validates server-side observability for each eval question using per-trace log enrichment.
3. Supports prompt/instruction iteration through repeatable scenario runs.

## Quick start

```bash
npm install
cp .env.example .env
# add OPENAI_API_KEY, FLAIM_REFRESH_TOKEN, FLAIM_CLIENT_ID

npm run bootstrap
npm run eval
npm run eval who_is_on_my_roster
npm run enrich -- <run_id> [trace_id]
```

## Docs

- `docs/INDEX.md`: entry point and doc map.
- `docs/OPERATIONS.md`: daily usage and command flows.
- `docs/OBSERVABILITY.md`: trace/log contract and filtering model.
- `docs/TROUBLESHOOTING.md`: failure modes and recovery.
- `docs/ACCEPTANCE.md`: formal E2E validation checklist.

## Artifact layout

```text
runs/<run_id>/
  manifest.json
  summary.json
  acceptance-summary.json            # optional, when formal validation is run
  trace_<scenario>_<idx>/
    trace.json
    logs/
      fantasy-mcp.json
      espn-client.json
      yahoo-client.json
      auth-worker.json
```

## Related design docs

- Flaim scope/design reference:
  - `/Users/ggugger/Code/flaim/docs/dev/mcp-eval-observability-scope.md`

# Troubleshooting

## `eval` succeeds but logs are empty

Checks:

1. Verify Cloudflare env vars are set in `.env`.
2. Verify token has Workers observability query permissions.
3. Run:
   - `npm run enrich -- <run_id>`

Cause is often indexing delay, not missing propagation.

## Trace contamination in per-trace artifacts

Checks:

1. Confirm `FLAIM_EVAL_ALLOW_RUN_FALLBACK` is unset or `0`.
2. Re-run enrichment:
   - `npm run enrich -- <run_id>`
3. Run acceptance:
   - `npm run accept -- <run_id>`

If contamination remains in strict mode, inspect worker trace propagation.

## Only `fantasy-mcp` logs appear

Checks:

1. Confirm trace-aware code is deployed on downstream workers.
2. Confirm `X-Flaim-Eval-Trace` is propagated through gateway routing.
3. Confirm query uses `"$metadata.traceId"` filter (not message-only filter).

## Missing one expected downstream worker

This can be valid if the scenario never routed to that platform.

Use `trace.json` tool args to determine expected platform:

- If no tool call used `platform: "yahoo"`, missing `yahoo-client` is expected.
- If no tool call used `platform: "espn"`, missing `espn-client` is expected.
- If no tool call used `platform: "sleeper"`, missing `sleeper-client` is expected.

## OAuth failures (`401` / refresh errors)

**Recommended fix:** Set `FLAIM_EVAL_API_KEY` in `.env` to bypass OAuth entirely. The API key never expires and requires no browser interaction.

If using OAuth:
1. Re-run `npm run bootstrap`.
2. Ensure `FLAIM_CLIENT_ID` and `FLAIM_REFRESH_TOKEN` are current in `.env`.
3. Confirm target auth base URL is correct (`FLAIM_AUTH_BASE_URL`).

## Cloudflare query errors

Common causes:

1. Wrong account ID.
2. Insufficient API token permissions.
3. Invalid filter operation/key combinations.

Use a narrow timeframe and test one worker first.

## Cross-trace contamination suspicion

1. Search all logs for other trace IDs.
2. Search for mismatched `eval=<run_id>` tags.
3. Re-run `enrich` to refresh stale files before concluding contamination.

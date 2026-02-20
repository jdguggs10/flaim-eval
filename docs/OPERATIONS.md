# Operations Guide

This document is the day-to-day runbook for `flaim-eval`.

## Prerequisites

1. Node + npm available.
2. `.env` configured:
   - `OPENAI_API_KEY`
   - **Either** `FLAIM_EVAL_API_KEY` (recommended) **or** `FLAIM_CLIENT_ID` + `FLAIM_REFRESH_TOKEN`
3. Optional (for server logs):
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_API_TOKEN`

## First-time setup

1. `npm install`
2. `cp .env.example .env`
3. Set `FLAIM_EVAL_API_KEY` in `.env` (get from project maintainer) — **done, skip bootstrap**.

If you don't have an API key, fall back to OAuth:
3b. `npm run bootstrap` — registers a client and completes OAuth consent via browser.

## Standard run flow

1. Execute scenarios:

```bash
npm run eval
```

Or a single scenario:

```bash
npm run eval who_is_on_my_roster
```

2. Capture delayed logs:

```bash
npm run enrich -- <run_id>
```

Optional single trace:

```bash
npm run enrich -- <run_id> <trace_id>
```

3. Evaluate run acceptance:

```bash
npm run accept -- <run_id>
```

4. Generate a human-readable markdown report:

```bash
npm run report -- <run_id>
```

## What to inspect per run

1. `runs/<run_id>/summary.json`
2. Each `runs/<run_id>/<trace_id>/trace.json`
3. `runs/<run_id>/<trace_id>/logs/*.json`
4. `runs/<run_id>/acceptance-summary.json`

## Expected worker coverage by scenario behavior

- Always: `fantasy-mcp`
- If `get_user_session` appears: `auth-worker`
- If tool args include `platform: "espn"`: `espn-client`
- If tool args include `platform: "yahoo"`: `yahoo-client`
- If tool args include `platform: "sleeper"`: `sleeper-client`

Worker presence is trace-dependent; not every trace should contain all workers.

## Operational expectation: enrichment timing

Cloudflare indexing can lag. Treat immediate post-`eval` logs as provisional and run `enrich` before final review.

## Isolation + retry defaults

- Strict trace isolation is enabled by default. Legacy run-level fallback is disabled unless `FLAIM_EVAL_ALLOW_RUN_FALLBACK=1`.
- Re-enrichment retries are coverage-aware and tunable:
  - `FLAIM_EVAL_REENRICH_ATTEMPTS` (default `6`)
  - `FLAIM_EVAL_REENRICH_DELAY_MS` (default `15000`)
  - `FLAIM_EVAL_REENRICH_WINDOW_EXPAND_MS` (default `30000`)

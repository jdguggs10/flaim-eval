# Operations Guide

This document is the day-to-day runbook for `flaim-eval`.

## Prerequisites

1. Node + npm available.
2. `.env` configured:
   - `OPENAI_API_KEY`
   - `FLAIM_CLIENT_ID`
   - `FLAIM_REFRESH_TOKEN`
3. Optional (for server logs):
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_API_TOKEN`

## First-time setup

1. `npm install`
2. `cp .env.example .env`
3. `npm run bootstrap`

`bootstrap` registers a client, completes OAuth consent, and gives refresh credentials for headless eval runs.

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

## What to inspect per run

1. `runs/<run_id>/summary.json`
2. Each `runs/<run_id>/<trace_id>/trace.json`
3. `runs/<run_id>/<trace_id>/logs/*.json`

## Expected worker coverage by scenario behavior

- Always: `fantasy-mcp`
- If `get_user_session` appears: `auth-worker`
- If tool args include `platform: "espn"`: `espn-client`
- If tool args include `platform: "yahoo"`: `yahoo-client`

Worker presence is trace-dependent; not every trace should contain all four workers.

## Operational expectation: enrichment timing

Cloudflare indexing can lag. Treat immediate post-`eval` logs as provisional and run `enrich` before final review.

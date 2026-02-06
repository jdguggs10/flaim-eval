# Formal E2E Acceptance Checklist

Use this protocol before declaring observability changes production-ready.

## Step 1: Pre-checks

1. `npm test`
2. `npm run type-check`
3. Verify `.env` has OpenAI + OAuth creds.
4. Verify Cloudflare env vars are present for log validation.

## Step 2: Execute full run

```bash
npm run eval
```

Record the generated `run_id`.

## Step 3: Re-enrich all traces

```bash
npm run enrich -- <run_id>
```

## Step 4: Validate coverage per trace

For each trace:

1. Open `trace.json` and list called tools + platforms.
2. Verify expected workers are present in `logs/`.
3. Confirm missing workers are explainable by routing behavior.

## Step 5: Validate isolation

1. Ensure no log event in a trace file references a different trace ID.
2. Ensure no event carries a different run ID tag.

## Step 6: Emit acceptance artifact

Write:

- `runs/<run_id>/acceptance-summary.json`

Include:

1. Run completion status
2. Per-trace coverage
3. Isolation/contamination result
4. Total captured log events
5. Final pass/fail conclusion

## Pass criteria

1. All scenarios complete (`errored = 0`).
2. All traces have expected worker coverage for observed routing.
3. No cross-trace contamination detected.
4. Re-enrichment succeeds for all traces.

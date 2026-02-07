# flaim-eval Docs Index

Use this as the entry point for operating and extending the eval harness.

## Core docs

- `OPERATIONS.md`: end-to-end run workflow (`bootstrap`, `eval`, `enrich`).
- `OBSERVABILITY.md`: trace/log contract and Cloudflare query behavior.
- `TROUBLESHOOTING.md`: known failure patterns and fixes.
- `ACCEPTANCE.md`: formal E2E test protocol and pass/fail criteria.

## Ownership boundary

- `flaim-eval` owns detailed harness operations and runbooks.
- `/Users/ggugger/Code/flaim/docs` keeps only short contract summaries and links.

## Quick command reference

```bash
npm run bootstrap
npm run eval
npm run eval <scenario_id>
npm run enrich -- <run_id> [trace_id]
npm run accept -- <run_id>
npm run report -- <run_id>
npm test
npm run type-check
```

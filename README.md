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
```

## Design doc

See `docs/dev/mcp-eval-observability-scope.md` in the Flaim repo.

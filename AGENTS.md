# Agent instructions for agentproxy

## Current project shape

Agentproxy is a standalone OpenAI-compatible HTTP service backed by the official Cursor CLI (`cursor-agent`).

The active build surface is intentionally small:

- `src/server/openai.ts` - OpenAI-compatible HTTP handler and cursor-agent adapter
- `src/server/main.ts` - CLI entry point
- `src/proxy/server.ts` - server lifecycle wrapper
- `src/proxy/formatter.ts` - OpenAI response/chunk helpers
- `src/proxy/prompt-builder.ts` - OpenAI messages/tools to cursor-agent prompt text
- `src/streaming/*` - cursor-agent stream-json parsing and SSE conversion
- `Dockerfile`, `docker-entrypoint.sh`, `scripts/deploy-ghcr.sh` - container and GHCR deployment
- `tests/*.test.mjs` - active Node test suite (`openai-service`, `streaming`, `prompt-builder`, `performance`, `project-docs`)

The repository still contains historical OpenCode plugin and MCP bridge code under `src/plugin*`, `src/cli`, `src/mcp`, `src/tools`, and many older Bun tests. Treat those as legacy context unless a task explicitly asks to revive or migrate them.

## Commands

Use Node/npm for active work:

```bash
npm install
npm run build
npm test
```

Validate shell scripts when editing deployment files:

```bash
sh -n docker-entrypoint.sh
bash -n scripts/deploy-ghcr.sh
scripts/deploy-ghcr.sh --dry-run --image ghcr.io/example/agentproxy --tag test
```

Do not reintroduce Bun-only scripts for the active service workflow.

## Runtime expectations

- The service exposes `/health`, `/v1/models`, `/v1/models/{id}`, and `/v1/chat/completions`.
- Authentication is handled by `cursor-agent`, not by the OpenAI `Authorization` header.
- In containers, prefer `CURSOR_API_KEY` for unattended deployments.
- Browser login is supported by running the container with `login` and a persistent `/root/.cursor` volume.

## OpenAI/OpenClaw compatibility

Maintain compatibility with common OpenAI Chat Completions clients, including OpenClaw:

- Function tools must use `{ "type": "function", "function": { "name": "...", ... } }`.
- Support `tool_choice`: `"auto"`, `"none"`, `"required"`, and pinned function choices.
- Non-streaming tool responses should return `message.content: null`, `message.tool_calls`, and `finish_reason: "tool_calls"`.
- Streaming tool responses should emit `delta.tool_calls` and finish with `finish_reason: "tool_calls"`.
- Follow-up `role: "tool"` messages with `tool_call_id` must continue to be represented in the prompt.

## Change discipline

- Keep changes scoped to the active service unless the user explicitly asks to update legacy OpenCode functionality.
- Add or update Node tests in `tests/*.test.mjs` for behavior changes.
- Keep Docker docs and GHCR deployment examples aligned with `agentproxy`.

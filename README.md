# agentproxy

OpenAI-compatible HTTP service backed by `cursor-agent`.

Agentproxy lets OpenAI-compatible clients talk to your Cursor subscription through the local Cursor CLI. It does not install or configure OpenCode plugins, MCP bridges, or tool runtimes.

## Requirements

- Node.js 22+
- `cursor-agent` installed and available on `PATH`
- Cursor authentication via:

```bash
cursor-agent login
```

The HTTP `Authorization` header is accepted for OpenAI client compatibility, but real authentication is handled by `cursor-agent`.

## Install and run

From source:

```bash
npm install
npm run build
npm run serve -- --port 32124 --workspace "$PWD"
```

After build, the package binary starts the service:

```bash
agentproxy --port 32124 --workspace "$PWD"
```

Default base URL:

```text
http://127.0.0.1:32124/v1
```

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Service health and workspace metadata |
| `GET` | `/v1/models` | OpenAI model list from `cursor-agent models` |
| `GET` | `/models` | Alias for `/v1/models` |
| `POST` | `/v1/chat/completions` | OpenAI chat completions |
| `POST` | `/chat/completions` | Alias for `/v1/chat/completions` |

Supported chat behavior:

- Non-streaming JSON chat completions
- Streaming Server-Sent Events (`stream: true`)
- `reasoning_content` deltas for Cursor thinking output
- OpenAI-shaped `usage` when cursor-agent reports token usage
- Function tool calls with OpenAI-compatible `tools`, `tool_choice`, `tool_calls`, `role: "tool"`, and `tool_call_id` follow-up turns
- Streaming tool-call deltas with final `finish_reason: "tool_calls"`
- `GET /v1/models/{id}` model lookup
- Best-effort `max_completion_tokens` / `max_tokens` prompt guidance

Tool compatibility notes:

- `tools` must be an array of `{ "type": "function", "function": { "name": "...", ... } }`.
- `tool_choice` supports `"auto"`, `"none"`, `"required"`, and pinned function choices such as `{ "type": "function", "function": { "name": "weather" } }`.
- If a client provides tools, only matching cursor-agent tool events are exposed back as OpenAI tool calls.
- With `tool_choice: "none"`, tool calls are suppressed.
- With `tool_choice: "required"` or a pinned function, the service returns an error if cursor-agent does not produce the required tool call.

## Example

```bash
curl http://127.0.0.1:32124/v1/chat/completions \
  -H 'Authorization: Bearer ignored' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "auto",
    "messages": [
      { "role": "user", "content": "Say hello in one sentence." }
    ]
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:32124/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "auto",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Think briefly, then answer." }
    ]
  }'
```

## Configuration

CLI flags:

| Flag | Default | Description |
| --- | --- | --- |
| `--host` | `127.0.0.1` | Host to bind |
| `--port` | `32124` | Port to bind; falls back to another local port if busy |
| `--workspace` | current directory | Workspace passed to `cursor-agent --workspace` |
| `--cursor-agent` | resolved from `CURSOR_AGENT_EXECUTABLE` or `PATH` | Cursor agent executable |
| `--request-timeout` | `0` | Request timeout in milliseconds; `0` disables |

Environment variables:

| Variable | Description |
| --- | --- |
| `HOST` | Default bind host |
| `PORT` | Default bind port |
| `CURSOR_ACP_WORKSPACE` | Default workspace |
| `CURSOR_AGENT_EXECUTABLE` | Cursor agent executable path |
| `CURSOR_ACP_REQUEST_TIMEOUT` | Default request timeout in milliseconds |
| `CURSOR_ACP_LOG_LEVEL=debug` | Enable debug logging |

## Docker image deployment

Build and publish the service image to GitHub Packages / GitHub Container Registry:

```bash
GHCR_TOKEN=ghp_xxx npm run docker:publish
```

The token must have `packages:write` permission. The script infers the default image from the GitHub remote, for example:

```text
ghcr.io/<owner>/<repo>
```

Published tags:

- `:<package.json version>`
- `:sha-<git sha>`
- `:latest`

Options:

```bash
scripts/deploy-ghcr.sh --image ghcr.io/acme/agentproxy --tag canary --no-latest
scripts/deploy-ghcr.sh --platform linux/amd64,linux/arm64
scripts/deploy-ghcr.sh --dry-run
```

The image includes the official Cursor CLI (`cursor-agent`) and starts the OpenAI-compatible service by default.

Unattended deployment should use a Cursor API key:

```bash
docker run --rm -p 32124:32124 \
  -e CURSOR_API_KEY="$CURSOR_API_KEY" \
  ghcr.io/<owner>/<repo>:latest
```

Then verify the OpenAI-compatible models endpoint:

```bash
curl http://127.0.0.1:32124/v1/models
```

For browser-based login, run the image once with a persistent Cursor config volume. The login command prints a URL because the image sets `NO_OPEN_BROWSER=1`:

```bash
docker volume create agentproxy-auth
docker run --rm -it \
  -v agentproxy-auth:/root/.cursor \
  ghcr.io/<owner>/<repo>:latest login

docker run --rm -p 32124:32124 \
  -v agentproxy-auth:/root/.cursor \
  ghcr.io/<owner>/<repo>:latest
```

Useful image commands:

```bash
docker run --rm -e CURSOR_API_KEY="$CURSOR_API_KEY" ghcr.io/<owner>/<repo>:latest status
docker run --rm -e CURSOR_API_KEY="$CURSOR_API_KEY" ghcr.io/<owner>/<repo>:latest models
```

## Development

```bash
npm install
npm run build
npm test
```

Coding-agent guidance lives in [`AGENTS.md`](AGENTS.md). It describes the active service files, legacy directories, validation commands, and OpenAI/OpenClaw compatibility expectations.

The service implementation lives in:

- `src/server/openai.ts` - OpenAI route handler and cursor-agent adapter
- `src/server/main.ts` - CLI entry point
- `src/proxy/server.ts` - reusable server lifecycle wrapper
- `src/streaming/*` - cursor-agent stream-json parsing and OpenAI SSE conversion
- `src/proxy/prompt-builder.ts` - OpenAI messages/tools to cursor-agent prompt text

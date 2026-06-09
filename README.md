# open-cursor

OpenAI-compatible HTTP service backed by `cursor-agent`.

This service lets OpenAI-compatible clients talk to your Cursor subscription through the local Cursor CLI. It does not install or configure OpenCode plugins, MCP bridges, or tool runtimes.

## Requirements

- Node.js or Bun
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
open-cursor --port 32124 --workspace "$PWD"
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
- Tool-call deltas are passed through when cursor-agent emits tool call events

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
scripts/deploy-ghcr.sh --image ghcr.io/acme/open-cursor --tag canary --no-latest
scripts/deploy-ghcr.sh --platform linux/amd64,linux/arm64
scripts/deploy-ghcr.sh --dry-run
```

The image contains the OpenAI-compatible Node service. Provide `cursor-agent` at runtime by extending the image or mounting the executable and setting `CURSOR_AGENT_EXECUTABLE`.

## Development

```bash
npm install
npm run build
npm test
```

The service implementation lives in:

- `src/server/openai.ts` - OpenAI route handler and cursor-agent adapter
- `src/server/main.ts` - CLI entry point
- `src/proxy/server.ts` - reusable server lifecycle wrapper
- `src/streaming/*` - cursor-agent stream-json parsing and OpenAI SSE conversion
- `src/proxy/prompt-builder.ts` - OpenAI messages/tools to cursor-agent prompt text

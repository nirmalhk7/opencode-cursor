#!/usr/bin/env node
import { createProxyServer } from "../proxy/server.js";

type ServeArgs = {
  host?: string;
  port?: number;
  workspaceDirectory?: string;
  cursorAgentPath?: string;
  requestTimeout?: number;
};

function printHelp() {
  console.log(`open-cursor OpenAI-compatible service

Usage:
  open-cursor [--host 127.0.0.1] [--port 32124] [--workspace /path/to/workspace]

Environment:
  HOST                       Host to bind (default: 127.0.0.1)
  PORT                       Port to bind (default: 32124, falls back if busy)
  CURSOR_ACP_WORKSPACE       Workspace passed to cursor-agent
  CURSOR_AGENT_EXECUTABLE    cursor-agent executable path
  CURSOR_ACP_REQUEST_TIMEOUT Request timeout in milliseconds (0 disables)

Endpoints:
  GET  /health
  GET  /v1/models
  POST /v1/chat/completions
`);
}

function readNext(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readNumber(value: string | undefined, name: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseArgs(argv: string[]): ServeArgs {
  const args: ServeArgs = {
    host: process.env.HOST,
    port: readNumber(process.env.PORT, "PORT"),
    workspaceDirectory: process.env.CURSOR_ACP_WORKSPACE,
    cursorAgentPath: process.env.CURSOR_AGENT_EXECUTABLE,
    requestTimeout: readNumber(process.env.CURSOR_ACP_REQUEST_TIMEOUT, "CURSOR_ACP_REQUEST_TIMEOUT"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--host") {
      args.host = readNext(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--port") {
      args.port = readNumber(readNext(argv, i, arg), arg);
      i += 1;
      continue;
    }
    if (arg === "--workspace") {
      args.workspaceDirectory = readNext(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--cursor-agent") {
      args.cursorAgentPath = readNext(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--request-timeout") {
      args.requestTimeout = readNumber(readNext(argv, i, arg), arg);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const server = createProxyServer({
    host: args.host ?? "127.0.0.1",
    port: args.port ?? 32124,
    workspaceDirectory: args.workspaceDirectory,
    cursorAgentPath: args.cursorAgentPath,
    requestTimeout: args.requestTimeout,
  });

  const baseURL = await server.start();
  const port = server.getPort();
  console.log(`OpenAI-compatible Cursor service listening at ${baseURL}`);
  console.log(`Health check: ${baseURL.replace(/\/v1$/, "")}/health`);

  const stop = async (signal: NodeJS.Signals) => {
    console.log(`\nReceived ${signal}; stopping service on port ${port ?? "unknown"}...`);
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

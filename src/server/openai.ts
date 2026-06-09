import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";

import { buildPromptFromMessages } from "../proxy/prompt-builder.js";
import {
  createChatCompletionChunk,
  createChatCompletionResponse,
  type OpenAiToolCall,
} from "../proxy/formatter.js";
import { LineBuffer } from "../streaming/line-buffer.js";
import { StreamToSseConverter, formatSseDone } from "../streaming/openai-sse.js";
import { parseStreamJsonLine } from "../streaming/parser.js";
import {
  extractText,
  extractThinking,
  inferToolName,
  isAssistantText,
  isResult,
  isThinking,
  isToolCall,
  type StreamJsonEvent,
  type StreamJsonToolCallEvent,
} from "../streaming/types.js";
import { createChatCompletionUsageChunk, extractOpenAiUsageFromResult, type OpenAiUsage } from "../usage.js";
import { formatShellCommandForPlatform, resolveCursorAgentBinary } from "../utils/binary.js";
import { formatErrorForUser, parseAgentError, stripAnsi } from "../utils/errors.js";
import { createLogger } from "../utils/logger.js";
import { MixedDeltaTracker } from "../streaming/delta-tracker.js";

const log = createLogger("openai-service");

const DEFAULT_WORKSPACE = process.env.CURSOR_ACP_WORKSPACE || process.cwd();
const DEFAULT_REQUEST_TIMEOUT_MS = 0;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
};

export interface OpenAiServiceOptions {
  workspaceDirectory?: string;
  cursorAgentPath?: string;
  requestTimeout?: number;
}

type ChatCompletionRequest = {
  model?: unknown;
  cursorModel?: unknown;
  messages?: unknown;
  stream?: unknown;
  tools?: unknown;
};

function jsonHeaders(extra: Record<string, string> = {}) {
  return {
    ...corsHeaders,
    "Content-Type": "application/json",
    ...extra,
  };
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, jsonHeaders());
  res.end(JSON.stringify(body));
}

function writeMethodNotAllowed(res: ServerResponse, allowed: string) {
  res.writeHead(405, jsonHeaders({ Allow: allowed }));
  res.end(JSON.stringify({ error: { message: "Method not allowed", type: "invalid_request_error" } }));
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeCursorModel(model: unknown, cursorModel?: unknown): string {
  const value = typeof cursorModel === "string" && cursorModel.trim()
    ? cursorModel
    : typeof model === "string" && model.trim()
      ? model
      : "auto";
  return value.replace(/^cursor-acp\//, "") || "auto";
}

function responseModelName(requestModel: unknown, cursorModel: string): string {
  return typeof requestModel === "string" && requestModel.trim()
    ? requestModel
    : cursorModel;
}

function toOpenAiError(message: string, status = 500) {
  return {
    error: {
      message,
      type: status >= 500 ? "server_error" : "invalid_request_error",
      code: null,
    },
  };
}

function parseChatCompletionRequest(raw: string): ChatCompletionRequest | null {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as ChatCompletionRequest;
  } catch {
    return null;
  }
}

function validateMessages(messages: unknown): Array<any> | null {
  if (!Array.isArray(messages)) {
    return null;
  }
  return messages;
}

function parseModelList(output: string) {
  const created = Math.floor(Date.now() / 1000);
  const models: Array<{ id: string; object: "model"; created: number; owned_by: "cursor" }> = [];

  for (const line of stripAnsi(output).split("\n")) {
    const match = line.match(/^([a-z0-9._/-]+)\s+-\s+.+?(?:\s+\((current|default)\))*\s*$/i);
    if (!match) {
      continue;
    }
    models.push({
      id: match[1],
      object: "model",
      created,
      owned_by: "cursor",
    });
  }

  if (models.length === 0) {
    models.push({
      id: "auto",
      object: "model",
      created,
      owned_by: "cursor",
    });
  }

  return { object: "list", data: models };
}

function createCursorAgentProcess(
  prompt: string,
  model: string,
  options: Required<OpenAiServiceOptions>,
): ChildProcessWithoutNullStreams {
  const cmd = [
    options.cursorAgentPath,
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--workspace",
    options.workspaceDirectory,
    "--model",
    model,
  ];

  const child = spawn(formatShellCommandForPlatform(cmd[0]), cmd.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  child.stdin.write(prompt);
  child.stdin.end();
  return child;
}

function eventToToolCall(event: StreamJsonToolCallEvent, index: number): OpenAiToolCall {
  const toolName = inferToolName(event) || "tool";
  const toolKey = Object.keys(event.tool_call ?? {})[0];
  const args = toolKey ? event.tool_call[toolKey]?.args : undefined;
  return {
    index,
    id: event.call_id ?? `call_${index}`,
    type: "function",
    function: {
      name: toolName,
      arguments: args ? JSON.stringify(args) : "",
    },
  };
}

export function extractCompletionFromStream(output: string): {
  assistantText: string;
  reasoningText: string;
  usage?: OpenAiUsage;
  toolCalls: OpenAiToolCall[];
} {
  const lines = output.split("\n");
  let assistantText = "";
  let reasoningText = "";
  let usage: OpenAiUsage | undefined;
  let sawAssistantPartials = false;
  let sawThinkingPartials = false;
  const toolCalls: OpenAiToolCall[] = [];
  const tracker = new MixedDeltaTracker();

  for (const line of lines) {
    const event = parseStreamJsonLine(line);
    if (!event) {
      continue;
    }

    if (isAssistantText(event)) {
      const text = extractText(event);
      if (!text) continue;

      const isPartial = typeof (event as any).timestamp_ms === "number";
      if (isPartial) {
        sawAssistantPartials = true;
        assistantText += tracker.nextText(text);
      } else if (!sawAssistantPartials) {
        assistantText = text;
      }
    }

    if (isThinking(event)) {
      const thinking = extractThinking(event);
      if (thinking) {
        const isPartial = typeof (event as any).timestamp_ms === "number";
        if (isPartial) {
          sawThinkingPartials = true;
          reasoningText += tracker.nextThinking(thinking);
        } else if (!sawThinkingPartials) {
          reasoningText = thinking;
        }
      }
    }

    if (isToolCall(event)) {
      toolCalls.push(eventToToolCall(event, toolCalls.length));
    }

    if (isResult(event)) {
      usage = extractOpenAiUsageFromResult(event) ?? usage;
    }
  }

  return { assistantText, reasoningText, usage, toolCalls };
}

async function handleModels(res: ServerResponse, options: Required<OpenAiServiceOptions>) {
  try {
    const output = execFileSync(options.cursorAgentPath, ["models"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    writeJson(res, 200, parseModelList(output));
  } catch (error) {
    log.error("Failed to list models", { error: String(error) });
    writeJson(res, 500, toOpenAiError("Failed to fetch models from cursor-agent"));
  }
}

function attachTimeout(child: ChildProcessWithoutNullStreams, timeout: number) {
  if (timeout <= 0) {
    return undefined;
  }
  return setTimeout(() => {
    child.kill("SIGTERM");
  }, timeout);
}

async function handleNonStreamingChat(
  res: ServerResponse,
  body: ChatCompletionRequest,
  options: Required<OpenAiServiceOptions>,
) {
  const messages = validateMessages(body.messages);
  if (!messages) {
    writeJson(res, 400, toOpenAiError("`messages` must be an array", 400));
    return;
  }

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const cursorModel = normalizeCursorModel(body.model, body.cursorModel);
  const responseModel = responseModelName(body.model, cursorModel);
  const prompt = buildPromptFromMessages(messages, tools);
  const child = createCursorAgentProcess(prompt, cursorModel, options);
  const timeout = attachTimeout(child, options.requestTimeout);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let spawnError: string | null = null;

  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
  child.on("error", (error) => {
    spawnError = error.message;
  });

  child.on("close", (code) => {
    if (timeout) clearTimeout(timeout);

    const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    const completion = extractCompletionFromStream(stdout);

    if (code !== 0 || spawnError) {
      const source =
        stderr
        || stdout
        || spawnError
        || `cursor-agent exited with code ${String(code ?? "unknown")} and no output`;
      const parsed = parseAgentError(source);
      const content = formatErrorForUser(parsed);
      writeJson(res, 200, createChatCompletionResponse(responseModel, content));
      return;
    }

    const content = completion.assistantText || stdout || stderr;
    writeJson(
      res,
      200,
      createChatCompletionResponse(
        responseModel,
        content,
        completion.reasoningText || undefined,
        completion.usage,
        completion.toolCalls,
      ),
    );
  });
}

async function handleStreamingChat(
  req: IncomingMessage,
  res: ServerResponse,
  body: ChatCompletionRequest,
  options: Required<OpenAiServiceOptions>,
) {
  const messages = validateMessages(body.messages);
  if (!messages) {
    writeJson(res, 400, toOpenAiError("`messages` must be an array", 400));
    return;
  }

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const cursorModel = normalizeCursorModel(body.model, body.cursorModel);
  const responseModel = responseModelName(body.model, cursorModel);
  const prompt = buildPromptFromMessages(messages, tools);
  const child = createCursorAgentProcess(prompt, cursorModel, options);
  const timeout = attachTimeout(child, options.requestTimeout);
  const id = `cursor-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const converter = new StreamToSseConverter(responseModel, { id, created });
  const lineBuffer = new LineBuffer();
  const stderrChunks: Buffer[] = [];
  let usage: OpenAiUsage | undefined;
  let streamEnded = false;
  let childClosed = false;
  let childExitCode: number | null = null;
  let spawnError: string | null = null;
  const chunkQueue: Buffer[] = [];
  let draining = false;

  const endStream = () => {
    if (streamEnded || res.writableEnded) {
      return;
    }
    res.write(formatSseDone());
    streamEnded = true;
    res.end();
  };

  const writeErrorChunk = (message: string) => {
    const chunk = createChatCompletionChunk(id, created, responseModel, message, true);
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    endStream();
  };

  req.on("aborted", () => {
    if (!streamEnded) {
      child.kill("SIGTERM");
    }
  });

  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
  child.on("error", (error) => {
    spawnError = error.message;
  });

  res.writeHead(200, {
    ...corsHeaders,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const handleEvent = (event: StreamJsonEvent) => {
    if (isResult(event)) {
      usage = extractOpenAiUsageFromResult(event) ?? usage;
    }
    for (const sse of converter.handleEvent(event)) {
      res.write(sse);
    }
  };

  const finishIfClosed = () => {
    if (!childClosed || streamEnded || res.writableEnded) {
      return;
    }

    for (const line of lineBuffer.flush()) {
      const event = parseStreamJsonLine(line);
      if (event) {
        handleEvent(event);
      }
    }

    if (timeout) clearTimeout(timeout);
    if (childExitCode !== 0 || spawnError) {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const source =
        stderr
        || spawnError
        || `cursor-agent exited with code ${String(childExitCode ?? "unknown")} and no output`;
      writeErrorChunk(formatErrorForUser(parseAgentError(source)));
      return;
    }

    const doneChunk = createChatCompletionChunk(id, created, responseModel, "", true);
    res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
    if (usage) {
      const usageChunk = createChatCompletionUsageChunk(id, created, responseModel, usage);
      res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
    }
    endStream();
  };

  const drainQueue = () => {
    if (draining) {
      return;
    }
    draining = true;
    try {
      while (chunkQueue.length > 0 && !streamEnded && !res.writableEnded) {
        const chunk = chunkQueue.shift()!;
        for (const line of lineBuffer.push(chunk)) {
          const event = parseStreamJsonLine(line);
          if (event) {
            handleEvent(event);
          }
        }
      }
      finishIfClosed();
    } finally {
      draining = false;
    }
  };

  child.stdout.on("data", (chunk) => {
    chunkQueue.push(Buffer.from(chunk));
    drainQueue();
  });

  child.on("close", (code) => {
    childClosed = true;
    childExitCode = code;
    drainQueue();
  });
}

export function createOpenAiRequestHandler(serviceOptions: OpenAiServiceOptions = {}) {
  const options: Required<OpenAiServiceOptions> = {
    workspaceDirectory: serviceOptions.workspaceDirectory ?? DEFAULT_WORKSPACE,
    cursorAgentPath: serviceOptions.cursorAgentPath ?? resolveCursorAgentBinary(),
    requestTimeout: serviceOptions.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };

  return async function openAiRequestHandler(req: IncomingMessage, res: ServerResponse) {
    try {
      const host = req.headers.host || "127.0.0.1";
      const url = new URL(req.url || "/", `http://${host}`);

      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }

      if (url.pathname === "/health") {
        if (req.method !== "GET") {
          writeMethodNotAllowed(res, "GET, OPTIONS");
          return;
        }
        writeJson(res, 200, {
          ok: true,
          service: "openai-compatible-cursor",
          workspaceDirectory: options.workspaceDirectory,
        });
        return;
      }

      if (url.pathname === "/v1/models" || url.pathname === "/models") {
        if (req.method !== "GET") {
          writeMethodNotAllowed(res, "GET, OPTIONS");
          return;
        }
        await handleModels(res, options);
        return;
      }

      if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions") {
        writeJson(res, 404, toOpenAiError(`Unsupported path: ${url.pathname}`, 404));
        return;
      }

      if (req.method !== "POST") {
        writeMethodNotAllowed(res, "POST, OPTIONS");
        return;
      }

      const requestBody = parseChatCompletionRequest(await readRequestBody(req));
      if (!requestBody) {
        writeJson(res, 400, toOpenAiError("Request body must be valid JSON", 400));
        return;
      }

      log.debug("chat completion request", {
        model: requestBody.model,
        stream: requestBody.stream === true,
      });

      if (requestBody.stream === true) {
        await handleStreamingChat(req, res, requestBody, options);
      } else {
        await handleNonStreamingChat(res, requestBody, options);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Unhandled request error", { error: message });
      if (!res.headersSent) {
        writeJson(res, 500, toOpenAiError(message));
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  };
}

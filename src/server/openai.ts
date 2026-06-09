import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";

import { buildPromptFromMessages } from "../proxy/prompt-builder.js";
import {
  createChatCompletionChunk,
  createChatCompletionRoleChunk,
  createChatCompletionResponse,
  type OpenAiToolCall,
} from "../proxy/formatter.js";
import { LineBuffer } from "../streaming/line-buffer.js";
import { StreamToSseConverter, formatSseChunk, formatSseDone } from "../streaming/openai-sse.js";
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
const execFileAsync = promisify(execFile);

const DEFAULT_REQUEST_TIMEOUT_MS = 0;
const MODEL_CACHE_TTL_MS = 30_000;
const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;

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

type ResolvedOpenAiServiceOptions = {
  workspaceDirectory?: string;
  cursorAgentPath: string;
  requestTimeout: number;
};

type ChatCompletionRequest = {
  model?: unknown;
  cursorModel?: unknown;
  messages?: unknown;
  stream?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
};

type ToolChoiceMode = "auto" | "none" | "required" | "function";

type PreparedChatRequest = {
  messages: Array<any>;
  tools: Array<any>;
  toolChoiceMode: ToolChoiceMode;
  requiredToolName?: string;
  cursorModel: string;
  responseModel: string;
  prompt: string;
};

type ModelList = {
  object: "list";
  data: Array<{ id: string; object: "model"; created: number; owned_by: "cursor" }>;
};

type ModelCacheEntry = {
  expiresAt: number;
  value?: ModelList;
  pending?: Promise<ModelList>;
};

const modelCache = new Map<string, ModelCacheEntry>();

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
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw new HttpError(413, `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeToolName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function validateFunctionTools(value: unknown): { tools: Array<any>; error?: string } {
  if (value === undefined) {
    return { tools: [] };
  }
  if (!Array.isArray(value)) {
    return { tools: [], error: "`tools` must be an array" };
  }

  const names = new Set<string>();
  for (const [index, tool] of value.entries()) {
    if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) {
      return { tools: [], error: `tools[${index}] must be a function tool` };
    }
    const name = tool.function.name;
    if (typeof name !== "string" || name.length === 0) {
      return { tools: [], error: `tools[${index}].function.name is required` };
    }
    const normalized = normalizeToolName(name);
    if (names.has(normalized)) {
      return { tools: [], error: `duplicate tool name: ${name}` };
    }
    names.add(normalized);
  }

  return { tools: value };
}

function normalizeToolChoice(
  value: unknown,
  tools: Array<any>,
): { mode: ToolChoiceMode; requiredToolName?: string; tools: Array<any>; error?: string } {
  if (value === undefined || value === null || value === "auto") {
    return { mode: "auto", tools };
  }
  if (value === "none") {
    return { mode: "none", tools: [] };
  }
  if (value === "required") {
    if (tools.length === 0) {
      return { mode: "required", tools, error: "`tool_choice: \"required\"` requires at least one tool" };
    }
    return { mode: "required", tools };
  }
  if (isRecord(value) && value.type === "function" && isRecord(value.function)) {
    const name = value.function.name;
    if (typeof name !== "string" || name.length === 0) {
      return { mode: "function", tools, error: "`tool_choice.function.name` is required" };
    }
    const selected = tools.find((tool) => normalizeToolName(tool.function.name) === normalizeToolName(name));
    if (!selected) {
      return { mode: "function", tools, error: `tool_choice references unknown tool: ${name}` };
    }
    return {
      mode: "function",
      requiredToolName: selected.function.name,
      tools: [selected],
    };
  }

  return {
    mode: "auto",
    tools,
    error: "`tool_choice` must be \"auto\", \"none\", \"required\", or a function choice",
  };
}

function buildToolChoiceInstruction(mode: ToolChoiceMode, requiredToolName?: string): string {
  if (mode === "required") {
    return "SYSTEM: tool_choice is required. You must call one of the provided function tools before producing a final answer.";
  }
  if (mode === "function" && requiredToolName) {
    return `SYSTEM: tool_choice requires the function tool "${requiredToolName}". You must call "${requiredToolName}" before producing a final answer.`;
  }
  return "";
}

function readCompletionTokenLimit(body: ChatCompletionRequest): number | undefined {
  const value = typeof body.max_completion_tokens === "number"
    ? body.max_completion_tokens
    : typeof body.max_tokens === "number"
      ? body.max_tokens
      : undefined;
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function buildCompatibilityInstructions(body: ChatCompletionRequest, mode: ToolChoiceMode, requiredToolName?: string): string[] {
  const instructions: string[] = [];
  const toolChoiceInstruction = buildToolChoiceInstruction(mode, requiredToolName);
  if (toolChoiceInstruction) {
    instructions.push(toolChoiceInstruction);
  }

  const tokenLimit = readCompletionTokenLimit(body);
  if (tokenLimit !== undefined) {
    instructions.push(`SYSTEM: Keep the completion within approximately ${tokenLimit} output tokens.`);
  }

  return instructions;
}

function prepareChatRequest(body: ChatCompletionRequest): { prepared?: PreparedChatRequest; error?: string } {
  const messages = validateMessages(body.messages);
  if (!messages) {
    return { error: "`messages` must be an array" };
  }

  const toolValidation = validateFunctionTools(body.tools);
  if (toolValidation.error) {
    return { error: toolValidation.error };
  }

  const toolChoice = normalizeToolChoice(body.tool_choice, toolValidation.tools);
  if (toolChoice.error) {
    return { error: toolChoice.error };
  }

  const cursorModel = normalizeCursorModel(body.model, body.cursorModel);
  const responseModel = responseModelName(body.model, cursorModel);
  const basePrompt = buildPromptFromMessages(messages, toolChoice.tools);
  const compatibilityInstructions = buildCompatibilityInstructions(body, toolChoice.mode, toolChoice.requiredToolName);
  const prompt = compatibilityInstructions.length > 0
    ? `${basePrompt}\n\n${compatibilityInstructions.join("\n\n")}`
    : basePrompt;

  return {
    prepared: {
      messages,
      tools: toolChoice.tools,
      toolChoiceMode: toolChoice.mode,
      requiredToolName: toolChoice.requiredToolName,
      cursorModel,
      responseModel,
      prompt,
    },
  };
}

function parseModelList(output: string): ModelList {
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

async function getModels(options: ResolvedOpenAiServiceOptions): Promise<ModelList> {
  const key = options.cursorAgentPath;
  const cached = modelCache.get(key);
  const now = Date.now();
  if (cached?.value && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached?.pending) {
    return cached.pending;
  }

  const pending = execFileAsync(options.cursorAgentPath, ["models"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  }).then(({ stdout }) => {
    const value = parseModelList(stdout);
    modelCache.set(key, {
      value,
      expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
    });
    return value;
  }).catch((error) => {
    modelCache.delete(key);
    throw error;
  });

  modelCache.set(key, {
    pending,
    expiresAt: now + MODEL_CACHE_TTL_MS,
  });
  return pending;
}

function createCursorAgentProcess(
  prompt: string,
  model: string,
  options: ResolvedOpenAiServiceOptions,
): ChildProcessWithoutNullStreams {
  const cmd = [
    options.cursorAgentPath,
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--model",
    model,
  ];
  if (options.workspaceDirectory) {
    cmd.push("--workspace", options.workspaceDirectory);
  }

  const child = spawn(formatShellCommandForPlatform(cmd[0]), cmd.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  child.stdin.write(prompt);
  child.stdin.end();
  return child;
}

function toOpenAiArguments(args: unknown): string {
  if (args === undefined) {
    return "{}";
  }
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return JSON.stringify(parsed);
    } catch {
      return JSON.stringify({ value: args });
    }
  }
  return JSON.stringify(args);
}

function eventToToolCall(
  event: StreamJsonToolCallEvent,
  index: number,
  allowedToolNames?: Set<string>,
): OpenAiToolCall | null {
  const toolName = inferToolName(event) || "tool";
  const resolvedToolName = resolveAllowedToolName(toolName, allowedToolNames);
  if (!resolvedToolName) {
    return null;
  }
  const toolKey = Object.keys(event.tool_call ?? {})[0];
  const payload = toolKey ? event.tool_call[toolKey] : undefined;
  const args = payload?.args ?? (
    payload && isRecord(payload)
      ? Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "result"))
      : undefined
  );
  return {
    index,
    id: event.call_id ?? `call_${index}`,
    type: "function",
    function: {
      name: resolvedToolName,
      arguments: toOpenAiArguments(args),
    },
  };
}

function resolveAllowedToolName(name: string, allowedToolNames?: Set<string>): string | null {
  if (!allowedToolNames) {
    return name;
  }
  if (allowedToolNames.size === 0) {
    return null;
  }
  if (allowedToolNames.has(name)) {
    return name;
  }
  const normalized = normalizeToolName(name);
  for (const allowed of allowedToolNames) {
    if (normalizeToolName(allowed) === normalized) {
      return allowed;
    }
  }
  return null;
}

function allowedToolNameSet(tools: Array<any>): Set<string> | undefined {
  return new Set(tools.map((tool) => tool.function.name));
}

function createToolCallDeltaChunk(
  id: string,
  created: number,
  model: string,
  toolCall: OpenAiToolCall,
) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [toolCall],
        },
        finish_reason: null,
      },
    ],
  };
}

export function extractCompletionFromStream(output: string): {
  assistantText: string;
  reasoningText: string;
  usage?: OpenAiUsage;
  toolCalls: OpenAiToolCall[];
};
export function extractCompletionFromStream(output: string, options: { allowedToolNames?: Set<string> }): {
  assistantText: string;
  reasoningText: string;
  usage?: OpenAiUsage;
  toolCalls: OpenAiToolCall[];
};
export function extractCompletionFromStream(
  output: string,
  options: { allowedToolNames?: Set<string> } = {},
): {
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
      const toolCall = eventToToolCall(event, toolCalls.length, options.allowedToolNames);
      if (toolCall) {
        toolCalls.push(toolCall);
      }
    }

    if (isResult(event)) {
      usage = extractOpenAiUsageFromResult(event) ?? usage;
    }
  }

  return { assistantText, reasoningText, usage, toolCalls };
}

async function handleModels(res: ServerResponse, options: ResolvedOpenAiServiceOptions) {
  try {
    writeJson(res, 200, await getModels(options));
  } catch (error) {
    log.error("Failed to list models", { error: String(error) });
    writeJson(res, 500, toOpenAiError("Failed to fetch models from cursor-agent"));
  }
}

async function handleModel(res: ServerResponse, options: ResolvedOpenAiServiceOptions, modelId: string) {
  try {
    const models = await getModels(options);
    const model = models.data.find((entry) => entry.id === modelId);
    if (!model) {
      writeJson(res, 404, toOpenAiError(`Model not found: ${modelId}`, 404));
      return;
    }
    writeJson(res, 200, model);
  } catch (error) {
    log.error("Failed to fetch model", { error: String(error), modelId });
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
  options: ResolvedOpenAiServiceOptions,
) {
  const { prepared, error } = prepareChatRequest(body);
  if (!prepared) {
    writeJson(res, 400, toOpenAiError(error ?? "Invalid chat completion request", 400));
    return;
  }

  const allowedNames = allowedToolNameSet(prepared.tools);
  const child = createCursorAgentProcess(prepared.prompt, prepared.cursorModel, options);
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
    const completion = extractCompletionFromStream(stdout, { allowedToolNames: allowedNames });

    if (code !== 0 || spawnError) {
      const source =
        stderr
        || stdout
        || spawnError
        || `cursor-agent exited with code ${String(code ?? "unknown")} and no output`;
      const parsed = parseAgentError(source);
      const content = formatErrorForUser(parsed);
      writeJson(res, 200, createChatCompletionResponse(prepared.responseModel, content));
      return;
    }

    if (
      prepared.toolChoiceMode === "function" &&
      !completion.toolCalls.some((toolCall) => toolCall.function.name === prepared.requiredToolName)
    ) {
      writeJson(
        res,
        502,
        toOpenAiError(`cursor-agent did not produce required tool call: ${prepared.requiredToolName}`),
      );
      return;
    }

    if (prepared.toolChoiceMode === "required" && completion.toolCalls.length === 0) {
      writeJson(res, 502, toOpenAiError("cursor-agent did not produce a required tool call"));
      return;
    }

    const content = completion.assistantText || "";
    writeJson(
      res,
      200,
      createChatCompletionResponse(
        prepared.responseModel,
        completion.toolCalls.length > 0 ? null : content,
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
  options: ResolvedOpenAiServiceOptions,
) {
  const { prepared, error } = prepareChatRequest(body);
  if (!prepared) {
    writeJson(res, 400, toOpenAiError(error ?? "Invalid chat completion request", 400));
    return;
  }

  const allowedNames = allowedToolNameSet(prepared.tools);
  const child = createCursorAgentProcess(prepared.prompt, prepared.cursorModel, options);
  const timeout = attachTimeout(child, options.requestTimeout);
  const id = `cursor-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const converter = new StreamToSseConverter(prepared.responseModel, { id, created });
  const lineBuffer = new LineBuffer();
  const stderrChunks: Buffer[] = [];
  let usage: OpenAiUsage | undefined;
  let sawToolCall = false;
  let sawRequiredToolCall = false;
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
    const chunk = createChatCompletionChunk(id, created, prepared.responseModel, message, true);
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
  res.write(`data: ${JSON.stringify(createChatCompletionRoleChunk(id, created, prepared.responseModel))}\n\n`);

  const handleEvent = (event: StreamJsonEvent) => {
    if (isResult(event)) {
      usage = extractOpenAiUsageFromResult(event) ?? usage;
    }
    if (isToolCall(event)) {
      const toolCall = eventToToolCall(event, 0, allowedNames);
      if (!toolCall) {
        return;
      }
      sawToolCall = true;
      if (!prepared.requiredToolName || toolCall.function.name === prepared.requiredToolName) {
        sawRequiredToolCall = true;
      }
      res.write(formatSseChunk(createToolCallDeltaChunk(id, created, prepared.responseModel, toolCall)));
      return;
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

    if (prepared.toolChoiceMode === "function" && !sawRequiredToolCall) {
      writeErrorChunk(`cursor-agent did not produce required tool call: ${prepared.requiredToolName}`);
      return;
    }

    if (prepared.toolChoiceMode === "required" && !sawToolCall) {
      writeErrorChunk("cursor-agent did not produce a required tool call");
      return;
    }

    const doneChunk = createChatCompletionChunk(
      id,
      created,
      prepared.responseModel,
      "",
      true,
      sawToolCall ? "tool_calls" : "stop",
    );
    res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
    if (usage) {
      const usageChunk = createChatCompletionUsageChunk(id, created, prepared.responseModel, usage);
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
  const options: ResolvedOpenAiServiceOptions = {
    workspaceDirectory: serviceOptions.workspaceDirectory,
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
          service: "agentproxy",
          workspaceDirectory: options.workspaceDirectory ?? null,
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

      const modelMatch = url.pathname.match(/^\/v1\/models\/([^/]+)$/) ?? url.pathname.match(/^\/models\/([^/]+)$/);
      if (modelMatch) {
        if (req.method !== "GET") {
          writeMethodNotAllowed(res, "GET, OPTIONS");
          return;
        }
        await handleModel(res, options, decodeURIComponent(modelMatch[1]));
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
        const status = error instanceof HttpError ? error.status : 500;
        writeJson(res, status, toOpenAiError(message, status));
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  };
}

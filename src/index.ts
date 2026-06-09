export { createProxyServer, findAvailablePort } from "./proxy/server.js";
export type { ProxyConfig, ProxyServer } from "./proxy/types.js";
export {
  createOpenAiRequestHandler,
  extractCompletionFromStream,
} from "./server/openai.js";
export type { OpenAiServiceOptions } from "./server/openai.js";
export { parseOpenAIRequest } from "./proxy/handler.js";
export type { ParsedRequest } from "./proxy/handler.js";
export { createChatCompletionResponse, createChatCompletionChunk } from "./proxy/formatter.js";
export type { OpenAiToolCall } from "./proxy/formatter.js";

// Utilities
export { createLogger } from "./utils/logger";
export type { Logger } from "./utils/logger";
export { parseAgentError, formatErrorForUser, stripAnsi } from "./utils/errors";
export type { ParsedError, ErrorType } from "./utils/errors";

// Streaming utilities
export { LineBuffer } from "./streaming/line-buffer.js";
export { parseStreamJsonLine } from "./streaming/parser.js";
export { DeltaTracker } from "./streaming/delta-tracker.js";
export { StreamToSseConverter, formatSseChunk, formatSseDone } from "./streaming/openai-sse.js";
export { StreamToAiSdkParts } from "./streaming/ai-sdk-parts.js";
export type {
  StreamJsonAssistantEvent,
  StreamJsonEvent,
  StreamJsonResultEvent,
  StreamJsonSystemEvent,
  StreamJsonThinkingEvent,
  StreamJsonToolCallEvent,
  StreamJsonUserEvent,
} from "./streaming/types.js";

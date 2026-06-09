import type { OpenAiUsage } from "../usage.js";

export type OpenAiToolCall = {
  index: number;
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export function createChatCompletionResponse(
  model: string,
  content: string,
  reasoningContent?: string,
  usage?: OpenAiUsage,
  toolCalls: OpenAiToolCall[] = [],
) {
  const response: {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
      index: number;
      message: {
        role: string;
        content: string;
        reasoning_content?: string;
        tool_calls?: OpenAiToolCall[];
      };
      finish_reason: string;
    }>;
    usage?: OpenAiUsage;
  } = {
    id: `cursor-acp-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      }
    ],
  };

  if (reasoningContent) {
    response.choices[0].message.reasoning_content = reasoningContent;
  }

  if (toolCalls.length > 0) {
    response.choices[0].message.tool_calls = toolCalls;
  }

  if (usage) {
    response.usage = usage;
  }

  return response;
}

export function createChatCompletionChunk(
  id: string,
  created: number,
  model: string,
  deltaContent: string,
  done = false,
) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: deltaContent ? { content: deltaContent } : {},
        finish_reason: done ? "stop" : null,
      }
    ],
  };
}

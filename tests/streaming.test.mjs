import assert from "node:assert/strict";
import { test } from "node:test";

import { DeltaTracker, MixedDeltaTracker } from "../dist/streaming/delta-tracker.js";
import { LineBuffer } from "../dist/streaming/line-buffer.js";
import { parseStreamJsonLine } from "../dist/streaming/parser.js";
import {
  StreamToSseConverter,
  formatSseChunk,
  formatSseDone,
} from "../dist/streaming/openai-sse.js";

const parseChunk = (chunk) => {
  const trimmed = chunk.trim();
  assert.match(trimmed, /^data: /);
  return JSON.parse(trimmed.replace(/^data:\s*/, ""));
};

test("LineBuffer buffers partial lines", () => {
  const buffer = new LineBuffer();

  assert.deepEqual(buffer.push("a"), []);
  assert.deepEqual(buffer.push("\n"), ["a"]);
  assert.deepEqual(buffer.push("b\nc"), ["b"]);
  assert.deepEqual(buffer.flush(), ["c"]);
});

test("LineBuffer handles CRLF line endings", () => {
  const buffer = new LineBuffer();

  assert.deepEqual(buffer.push("a\r\nb\r\n"), ["a", "b"]);
  assert.deepEqual(buffer.flush(), []);
});

test("LineBuffer ignores empty lines", () => {
  const buffer = new LineBuffer();

  assert.deepEqual(buffer.push("\n\n"), []);
  assert.deepEqual(buffer.flush(), []);
});

test("LineBuffer flushes remaining buffered content", () => {
  const buffer = new LineBuffer();

  assert.deepEqual(buffer.push("tail"), []);
  assert.deepEqual(buffer.flush(), ["tail"]);
  assert.deepEqual(buffer.flush(), []);
});

test("LineBuffer accepts Uint8Array input", () => {
  const buffer = new LineBuffer();
  const encoder = new TextEncoder();

  assert.deepEqual(buffer.push(encoder.encode("x\n")), ["x"]);
});

test("parseStreamJsonLine parses valid stream-json lines", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    },
  });

  const event = parseStreamJsonLine(line);
  assert.ok(event);
  assert.equal(event.type, "assistant");
});

test("parseStreamJsonLine returns null on invalid JSON", () => {
  assert.equal(parseStreamJsonLine("{invalid"), null);
});

test("parseStreamJsonLine returns null for non-object payloads", () => {
  assert.equal(parseStreamJsonLine("[]"), null);
  assert.equal(parseStreamJsonLine("null"), null);
});

test("parseStreamJsonLine returns null for empty lines", () => {
  assert.equal(parseStreamJsonLine("\n"), null);
  assert.equal(parseStreamJsonLine(""), null);
});

test("DeltaTracker returns full text for first event", () => {
  const tracker = new DeltaTracker();
  assert.equal(tracker.nextText("Hello"), "Hello");
});

test("DeltaTracker returns delta for appended text", () => {
  const tracker = new DeltaTracker();

  assert.equal(tracker.nextText("Hello"), "Hello");
  assert.equal(tracker.nextText("Hello world"), " world");
});

test("DeltaTracker returns only new suffix when prefix drifts", () => {
  const tracker = new DeltaTracker();

  assert.equal(tracker.nextText("Hello"), "Hello");
  assert.equal(tracker.nextText("Hi there"), "i there");
});

test("DeltaTracker returns empty string for duplicate event", () => {
  const tracker = new DeltaTracker();

  assert.equal(tracker.nextText("Hello world"), "Hello world");
  assert.equal(tracker.nextText("Hello world"), "");
});

test("DeltaTracker returns empty string when current is substring of previous", () => {
  const tracker = new DeltaTracker();

  assert.equal(tracker.nextText("Hello world"), "Hello world");
  assert.equal(tracker.nextText("Hello"), "");
});

test("DeltaTracker handles unicode text", () => {
  const tracker = new DeltaTracker();

  assert.equal(tracker.nextText("Hi 😀"), "Hi 😀");
  assert.equal(tracker.nextText("Hi 😀!!"), "!!");
});

test("DeltaTracker handles trailing whitespace drift without duplication", () => {
  const tracker = new DeltaTracker();

  assert.equal(tracker.nextText("Line one\n"), "Line one\n");
  assert.equal(tracker.nextText("Line one\nLine two"), "Line two");
});

test("DeltaTracker does not re-emit full text on mid-stream prefix mismatch", () => {
  const tracker = new DeltaTracker();
  const base = "The quick brown fox jumps over the lazy dog.";

  assert.equal(tracker.nextText(base), base);
  const drifted = "The quick brown fox  jumps over the lazy dog. And more.";
  const result = tracker.nextText(drifted);
  assert.ok(result.length < drifted.length);
  assert.notEqual(result, drifted);
});

test("DeltaTracker tracks thinking separately", () => {
  const tracker = new DeltaTracker();

  assert.equal(tracker.nextThinking("Thought 1"), "Thought 1");
  assert.equal(tracker.nextThinking("Thought 1 + more"), " + more");
  assert.equal(tracker.nextText("Answer"), "Answer");
});

test("DeltaTracker resets stored state", () => {
  const tracker = new DeltaTracker();

  assert.equal(tracker.nextText("Hello"), "Hello");
  tracker.reset();
  assert.equal(tracker.nextText("Hello"), "Hello");
});

test("MixedDeltaTracker handles mixed delta and accumulated text payloads", () => {
  const tracker = new MixedDeltaTracker();

  assert.equal(tracker.nextText("Hello"), "Hello");
  assert.equal(tracker.nextText(" world"), " world");
  assert.equal(tracker.nextText("Hello world!"), "!");
});

test("MixedDeltaTracker tracks thinking separately from assistant text", () => {
  const tracker = new MixedDeltaTracker();

  assert.equal(tracker.nextThinking("Plan"), "Plan");
  assert.equal(tracker.nextThinking(" more"), " more");
  assert.equal(tracker.nextText("Answer"), "Answer");
  assert.equal(tracker.nextThinking("Plan more carefully"), " carefully");
});

test("formatSseChunk and formatSseDone produce OpenAI SSE framing", () => {
  assert.equal(formatSseChunk({ ok: true }), 'data: {"ok":true}\n\n');
  assert.equal(formatSseDone(), "data: [DONE]\n\n");
});

test("StreamToSseConverter emits text deltas and tool calls", () => {
  const converter = new StreamToSseConverter("test-model", {
    id: "chunk-id",
    created: 123,
  });

  const first = converter.handleEvent({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    },
  });

  assert.equal(first.length, 1);
  assert.equal(parseChunk(first[0]).choices[0].delta.content, "Hello");

  const second = converter.handleEvent({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    },
  });

  assert.equal(parseChunk(second[0]).choices[0].delta.content, " world");

  const toolChunk = converter.handleEvent({
    type: "tool_call",
    call_id: "call_1",
    tool_call: {
      readToolCall: { args: { path: "/tmp/file" } },
    },
  });

  const toolDelta = parseChunk(toolChunk[0]).choices[0].delta;
  assert.equal(toolDelta.tool_calls[0].id, "call_1");
  assert.equal(toolDelta.tool_calls[0].function.name, "read");
  assert.equal(toolDelta.tool_calls[0].function.arguments, '{"path":"/tmp/file"}');
});

test("StreamToSseConverter emits thinking deltas from assistant message", () => {
  const converter = new StreamToSseConverter("test-model", {
    id: "chunk-id",
    created: 123,
  });

  const chunk = converter.handleEvent({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Plan" }],
    },
  });
  assert.equal(parseChunk(chunk[0]).choices[0].delta.reasoning_content, "Plan");
});

test("StreamToSseConverter emits thinking deltas from real thinking events", () => {
  const converter = new StreamToSseConverter("test-model", {
    id: "chunk-id",
    created: 123,
  });

  const first = converter.handleEvent({
    type: "thinking",
    subtype: "delta",
    text: "Analyzing",
    session_id: "test",
  });
  assert.equal(parseChunk(first[0]).choices[0].delta.reasoning_content, "Analyzing");

  const second = converter.handleEvent({
    type: "thinking",
    subtype: "delta",
    text: "Analyzing the problem",
    session_id: "test",
  });
  assert.equal(parseChunk(second[0]).choices[0].delta.reasoning_content, " the problem");
});

test("StreamToSseConverter does not duplicate thinking when partial events are followed by accumulated event", () => {
  const converter = new StreamToSseConverter("test-model", {
    id: "chunk-id",
    created: 123,
  });
  const now = Date.now();

  const first = converter.handleEvent({
    type: "assistant",
    timestamp_ms: now + 1,
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Let me think" }],
    },
  });
  assert.equal(parseChunk(first[0]).choices[0].delta.reasoning_content, "Let me think");

  const second = converter.handleEvent({
    type: "assistant",
    timestamp_ms: now + 2,
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: " about this" }],
    },
  });
  assert.equal(parseChunk(second[0]).choices[0].delta.reasoning_content, " about this");

  const final = converter.handleEvent({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Let me think about this" }],
    },
  });
  assert.deepEqual(final, []);
});

test("StreamToSseConverter does not duplicate text when partial events are followed by accumulated event", () => {
  const converter = new StreamToSseConverter("test-model", {
    id: "chunk-id",
    created: 123,
  });
  const now = Date.now();

  const first = converter.handleEvent({
    type: "assistant",
    timestamp_ms: now + 1,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    },
  });
  assert.equal(parseChunk(first[0]).choices[0].delta.content, "Hello");

  const second = converter.handleEvent({
    type: "assistant",
    timestamp_ms: now + 2,
    message: {
      role: "assistant",
      content: [{ type: "text", text: " world" }],
    },
  });
  assert.equal(parseChunk(second[0]).choices[0].delta.content, " world");

  const final = converter.handleEvent({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    },
  });
  assert.deepEqual(final, []);
});

test("StreamToSseConverter handles mixed delta and accumulated partial text events", () => {
  const converter = new StreamToSseConverter("test-model", {
    id: "chunk-id",
    created: 123,
  });
  const now = Date.now();

  const first = converter.handleEvent({
    type: "assistant",
    timestamp_ms: now + 1,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    },
  });
  const second = converter.handleEvent({
    type: "assistant",
    timestamp_ms: now + 2,
    message: {
      role: "assistant",
      content: [{ type: "text", text: " world" }],
    },
  });
  const third = converter.handleEvent({
    type: "assistant",
    timestamp_ms: now + 3,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello world!" }],
    },
  });

  assert.equal(parseChunk(first[0]).choices[0].delta.content, "Hello");
  assert.equal(parseChunk(second[0]).choices[0].delta.content, " world");
  assert.equal(parseChunk(third[0]).choices[0].delta.content, "!");
});

test("StreamToSseConverter handles accumulated-only events without duplication", () => {
  const converter = new StreamToSseConverter("test-model", {
    id: "chunk-id",
    created: 123,
  });

  const first = converter.handleEvent({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    },
  });
  assert.equal(parseChunk(first[0]).choices[0].delta.content, "Hello");

  const second = converter.handleEvent({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    },
  });
  assert.equal(parseChunk(second[0]).choices[0].delta.content, " world");

  const dup = converter.handleEvent({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    },
  });
  assert.deepEqual(dup, []);
});

test("StreamToSseConverter handles empty partial event followed by accumulated text", () => {
  const converter = new StreamToSseConverter("test-model", {
    id: "chunk-id",
    created: 123,
  });

  const emptyPartial = converter.handleEvent({
    type: "assistant",
    timestamp_ms: 1234567890,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "" }],
    },
  });
  assert.deepEqual(emptyPartial, []);

  const accumulated = converter.handleEvent({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    },
  });
  assert.equal(accumulated.length, 1);
  assert.equal(parseChunk(accumulated[0]).choices[0].delta.content, "Hello world");
});

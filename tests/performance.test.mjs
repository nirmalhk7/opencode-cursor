import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { buildPromptFromMessages } from "../dist/proxy/prompt-builder.js";
import { LineBuffer } from "../dist/streaming/line-buffer.js";
import { parseStreamJsonLine } from "../dist/streaming/parser.js";
import { createProxyServer } from "../dist/proxy/server.js";

const benchmark = (name, fn, maxMs) => {
  const start = performance.now();
  fn();
  const elapsed = performance.now() - start;
  assert.ok(
    elapsed < maxMs,
    `${name} took ${elapsed.toFixed(2)}ms, expected < ${maxMs}ms`,
  );
};

test("LineBuffer handles many small chunks without quadratic slowdown", () => {
  const line = `${"x".repeat(64)}\n`;
  const lineRepeats = 5_000;

  benchmark("LineBuffer 5k lines via single-byte chunks", () => {
    const buffer = new LineBuffer();
    let lineCount = 0;

    for (let repeat = 0; repeat < lineRepeats; repeat++) {
      for (let i = 0; i < line.length; i++) {
        for (const completed of buffer.push(line[i])) {
          lineCount += 1;
          assert.equal(completed.length, 64);
        }
      }
    }

    assert.equal(lineCount, lineRepeats);
    assert.deepEqual(buffer.flush(), []);
  }, 500);
});

test("LineBuffer processes realistic NDJSON stream quickly", () => {
  const event = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    },
  });
  const stream = `${event}\n`.repeat(5_000);

  benchmark("LineBuffer 5k NDJSON lines", () => {
    const buffer = new LineBuffer();
    let parsed = 0;

    for (let i = 0; i < stream.length; i += 16) {
      for (const line of buffer.push(stream.slice(i, i + 16))) {
        if (parseStreamJsonLine(line)) {
          parsed += 1;
        }
      }
    }

    for (const line of buffer.flush()) {
      if (parseStreamJsonLine(line)) {
        parsed += 1;
      }
    }

    assert.equal(parsed, 5_000);
  }, 500);
});

test("buildPromptFromMessages stays fast for large multi-turn conversations", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ];

  const messages = [];
  for (let i = 0; i < 200; i++) {
    messages.push({ role: "user", content: `Request ${i}` });
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: `call_${i}`, function: { name: "read", arguments: `{"path":"${i}.txt"}` } }],
    });
    messages.push({ role: "tool", tool_call_id: `call_${i}`, content: `contents ${i}` });
    messages.push({ role: "assistant", content: `Done ${i}` });
  }

  benchmark("buildPromptFromMessages 200 tool turns", () => {
    const prompt = buildPromptFromMessages(messages, tools);
    assert.ok(prompt.length > 10_000);
    assert.match(prompt, /TOOL_RESULT \(call_id: call_199\): contents 199/);
  }, 250);
});

test("proxy server starts quickly", async () => {
  const server = createProxyServer({ port: 0, cursorAgentPath: "/bin/false" });
  const start = performance.now();
  await server.start();
  const elapsed = performance.now() - start;

  assert.ok(elapsed < 500, `server start took ${elapsed.toFixed(2)}ms, expected < 500ms`);
  await server.stop();
});

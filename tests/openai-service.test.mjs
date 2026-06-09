import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createProxyServer } from "../dist/proxy/server.js";

function createFakeCursorAgent() {
  const dir = mkdtempSync(join(tmpdir(), "open-cursor-test-"));
  const agentPath = join(dir, "cursor-agent");
  writeFileSync(
    agentPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "models") {
  console.log("auto - Auto (default)");
  console.log("gpt-5.5 - GPT-5.5");
  process.exit(0);
}
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  if (input.includes("CALL_WEATHER")) {
    process.stdout.write(JSON.stringify({ type: "tool_call", call_id: "call_weather", tool_call: { weatherToolCall: { args: { location: "Paris", unit: "celsius" } } } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", usage: { inputTokens: 4, outputTokens: 0 } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ type: "assistant", timestamp_ms: Date.now(), message: { role: "assistant", content: [{ type: "thinking", thinking: "Plan" }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "assistant", timestamp_ms: Date.now() + 1, message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "assistant", timestamp_ms: Date.now() + 2, message: { role: "assistant", content: [{ type: "text", text: " world" }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 1 } }) + "\\n");
});
`,
  );
  chmodSync(agentPath, 0o755);
  return agentPath;
}

const agentPath = createFakeCursorAgent();
const server = createProxyServer({
  port: 32140,
  cursorAgentPath: agentPath,
  workspaceDirectory: "/tmp",
});
let baseURL;

before(async () => {
  baseURL = await server.start();
});

after(async () => {
  await server.stop();
});

test("serves health metadata", async () => {
  const response = await fetch(`${baseURL.replace(/\/v1$/, "")}/health`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "openai-compatible-cursor");
  assert.equal(body.workspaceDirectory, "/tmp");
});

test("lists cursor-agent models in OpenAI list format", async () => {
  const response = await fetch(`${baseURL}/models`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.object, "list");
  assert.deepEqual(body.data.map((model) => model.id), ["auto", "gpt-5.5"]);
});

test("returns a single model by id", async () => {
  const response = await fetch(`${baseURL}/models/gpt-5.5`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.id, "gpt-5.5");
  assert.equal(body.object, "model");
});

test("returns non-streaming chat completions", async () => {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: "Bearer test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "cursor-acp/auto",
      messages: [{ role: "user", content: "Say hello" }],
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "cursor-acp/auto");
  assert.equal(body.choices[0].message.content, "Hello world");
  assert.equal(body.choices[0].message.reasoning_content, "Plan");
  assert.equal(body.usage.total_tokens, 6);
});

test("returns non-streaming tool calls for matching function tools", async () => {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "auto",
      tool_choice: { type: "function", function: { name: "weather" } },
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { location: { type: "string" } },
              required: ["location"],
            },
          },
        },
      ],
      messages: [{ role: "user", content: "CALL_WEATHER" }],
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.equal(body.choices[0].message.content, null);
  assert.equal(body.choices[0].message.tool_calls[0].id, "call_weather");
  assert.equal(body.choices[0].message.tool_calls[0].function.name, "weather");
  assert.deepEqual(
    JSON.parse(body.choices[0].message.tool_calls[0].function.arguments),
    { location: "Paris", unit: "celsius" },
  );
});

test("honors tool_choice none by suppressing tool call output", async () => {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "auto",
      tool_choice: "none",
      tools: [{ type: "function", function: { name: "weather" } }],
      messages: [{ role: "user", content: "CALL_WEATHER" }],
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.choices[0].message.tool_calls, undefined);
  assert.equal(body.choices[0].message.content, "");
});

test("streams chat completions as OpenAI SSE chunks", async () => {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "auto",
      messages: [{ role: "user", content: "Say hello" }],
      stream: true,
    }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);

  const text = await response.text();
  assert.match(text, /"reasoning_content":"Plan"/);
  assert.match(text, /"content":"Hello"/);
  assert.match(text, /"content":" world"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /data: \[DONE\]/);
});

test("streams function tool calls with tool_calls finish reason", async () => {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "auto",
      messages: [{ role: "user", content: "CALL_WEATHER" }],
      stream: true,
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            description: "Get weather",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    }),
  });

  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /"role":"assistant"/);
  assert.match(text, /"tool_calls":\[/);
  assert.match(text, /"name":"weather"/);
  assert.match(text, /"finish_reason":"tool_calls"/);
  assert.match(text, /data: \[DONE\]/);
});

test("rejects invalid chat request bodies", async () => {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not json",
  });

  assert.equal(response.status, 400);
});

test("rejects unsupported tool declarations", async () => {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "auto",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "custom", name: "bad" }],
    }),
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error.message, /function tool/);
});

test("rejects tool_choice references to unknown tools", async () => {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "auto",
      messages: [{ role: "user", content: "Hi" }],
      tool_choice: { type: "function", function: { name: "missing" } },
      tools: [{ type: "function", function: { name: "weather" } }],
    }),
  });

  assert.equal(response.status, 400);
});

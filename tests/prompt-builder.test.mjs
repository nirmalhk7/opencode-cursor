import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPromptFromMessages } from "../dist/proxy/prompt-builder.js";

test("buildPromptFromMessages converts simple text messages", () => {
  const messages = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello" },
  ];
  const result = buildPromptFromMessages(messages, []);
  assert.equal(result, "SYSTEM: You are helpful.\n\nUSER: Hello");
});

test("buildPromptFromMessages handles array content parts", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "Part 1" },
        { type: "text", text: "Part 2" },
      ],
    },
  ];
  const result = buildPromptFromMessages(messages, []);
  assert.equal(result, "USER: Part 1\nPart 2");
});

test("buildPromptFromMessages includes tool definitions as system section", () => {
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
  const messages = [{ role: "user", content: "Read foo.txt" }];
  const result = buildPromptFromMessages(messages, tools);

  assert.match(result, /Available tools:/);
  assert.match(result, /- read: Read a file/);
  assert.match(result, /Parameters:/);
  assert.match(result, /USER: Read foo.txt/);
});

test("buildPromptFromMessages handles role:tool result messages", () => {
  const messages = [
    { role: "user", content: "Read the file" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", function: { name: "read", arguments: '{"path":"foo.txt"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "file contents here" },
  ];
  const result = buildPromptFromMessages(messages, []);

  assert.match(result, /TOOL_RESULT \(call_id: call_1\): file contents here/);
});

test("buildPromptFromMessages handles assistant messages with tool_calls", () => {
  const messages = [
    {
      role: "assistant",
      content: "Let me read that file.",
      tool_calls: [
        { id: "call_1", function: { name: "read", arguments: '{"path":"foo.txt"}' } },
      ],
    },
  ];
  const result = buildPromptFromMessages(messages, []);

  assert.match(result, /ASSISTANT: Let me read that file\./);
  assert.match(result, /tool_call\(id: call_1, name: read, args: \{"path":"foo\.txt"\}\)/);
});

test("buildPromptFromMessages handles assistant tool_calls without content", () => {
  const messages = [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", function: { name: "bash", arguments: '{"command":"ls"}' } },
      ],
    },
  ];
  const result = buildPromptFromMessages(messages, []);

  assert.match(result, /ASSISTANT: tool_call\(id: call_1, name: bash/);
  assert.doesNotMatch(result, /null/);
});

test("buildPromptFromMessages handles full multi-turn tool conversation", () => {
  const tools = [
    {
      type: "function",
      function: { name: "read", description: "Read a file", parameters: {} },
    },
  ];
  const messages = [
    { role: "system", content: "You are an assistant." },
    { role: "user", content: "Read foo.txt" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"path":"foo.txt"}' } }],
    },
    { role: "tool", tool_call_id: "c1", content: "hello world" },
    { role: "assistant", content: "The file contains: hello world" },
  ];
  const result = buildPromptFromMessages(messages, tools);

  assert.match(result, /Available tools:/);
  assert.match(result, /USER: Read foo.txt/);
  assert.match(result, /tool_call\(id: c1, name: read/);
  assert.match(result, /TOOL_RESULT \(call_id: c1\): hello world/);
  assert.match(result, /ASSISTANT: The file contains: hello world/);
});

test("buildPromptFromMessages skips non-text content parts", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "Hello" },
        { type: "image_url", image_url: { url: "data:..." } },
      ],
    },
  ];
  const result = buildPromptFromMessages(messages, []);
  assert.equal(result, "USER: Hello");
});

test("buildPromptFromMessages handles empty messages array", () => {
  assert.equal(buildPromptFromMessages([], []), "");
});

test("buildPromptFromMessages handles empty tools array", () => {
  const result = buildPromptFromMessages([{ role: "user", content: "Hi" }], []);
  assert.doesNotMatch(result, /Available tools:/);
  assert.equal(result, "USER: Hi");
});

test("buildPromptFromMessages appends continuation suffix after tool result messages", () => {
  const messages = [
    { role: "user", content: "Read the file" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", function: { name: "read", arguments: '{"path":"foo.txt"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "file contents here" },
  ];
  const result = buildPromptFromMessages(messages, []);

  assert.match(result, /TOOL_RESULT \(call_id: call_1\): file contents here/);
  assert.match(
    result,
    /The above tool calls have been executed\. Continue your response based on these results\./,
  );
});

test("buildPromptFromMessages does not append continuation suffix when no tool results present", () => {
  const messages = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
  ];
  const result = buildPromptFromMessages(messages, []);

  assert.doesNotMatch(result, /The above tool calls have been executed/);
});

test("buildPromptFromMessages appends continuation suffix once after multiple tool results", () => {
  const messages = [
    { role: "user", content: "Read both files" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", function: { name: "read", arguments: '{"path":"a.txt"}' } },
        { id: "call_2", function: { name: "read", arguments: '{"path":"b.txt"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "contents of a" },
    { role: "tool", tool_call_id: "call_2", content: "contents of b" },
  ];
  const result = buildPromptFromMessages(messages, []);

  assert.match(result, /TOOL_RESULT \(call_id: call_1\): contents of a/);
  assert.match(result, /TOOL_RESULT \(call_id: call_2\): contents of b/);

  const suffixCount = result.split("The above tool calls have been executed").length - 1;
  assert.equal(suffixCount, 1);
});

test("buildPromptFromMessages injects subagent guidance when task tool is present", () => {
  const taskTool = { function: { name: "task", description: "spawn a subagent", parameters: {} } };
  const prompt = buildPromptFromMessages(
    [{ role: "user", content: "analyze this repo" }],
    [taskTool],
    ["general-purpose", "codemachine"],
  );

  assert.match(prompt, /general-purpose/);
  assert.match(prompt, /codemachine/);
  assert.match(prompt, /subagent_type/);
});

test("buildPromptFromMessages does not inject subagent guidance without task tool", () => {
  const otherTool = { function: { name: "read", description: "read a file", parameters: {} } };
  const prompt = buildPromptFromMessages(
    [{ role: "user", content: "read a file" }],
    [otherTool],
    ["general-purpose"],
  );

  assert.doesNotMatch(prompt, /subagent_type/);
});

test("buildPromptFromMessages does not inject subagent guidance when subagentNames is empty", () => {
  const taskTool = { function: { name: "task", description: "spawn a subagent", parameters: {} } };
  const prompt = buildPromptFromMessages(
    [{ role: "user", content: "analyze" }],
    [taskTool],
    [],
  );

  assert.doesNotMatch(prompt, /subagent_type/);
});

test("buildPromptFromMessages works without third parameter", () => {
  const otherTool = { function: { name: "read", description: "read a file", parameters: {} } };
  assert.doesNotThrow(() => buildPromptFromMessages(
    [{ role: "user", content: "hello" }],
    [otherTool],
  ));
});

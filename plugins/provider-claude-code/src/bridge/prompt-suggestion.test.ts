import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { requestClaudePromptSuggestion } from "./prompt-suggestion.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

function sdkMessage(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage;
}

function setup() {
  let sdkOptions: Options | undefined;
  let emit: ((message: IteratorResult<SDKMessage>) => void) | undefined;
  let rejectNext: ((error: Error) => void) | undefined;
  const close = vi.fn(() => emit?.({ value: undefined, done: true }));
  queryMock.mockImplementation((args: { options: Options }) => {
    sdkOptions = args.options;
    return {
      close,
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<SDKMessage>>((resolve, reject) => {
            emit = resolve;
            rejectNext = reject;
          }),
        return: async () => ({ value: undefined, done: true }),
      }),
    };
  });
  const controller = new AbortController();
  const parentHook = vi.fn();
  const options = {
    cwd: "/tmp/prediction",
    systemPrompt: "Parent system prefix",
    model: "claude-fable-5-1",
    allowBypassPermissions: true,
    allowedTools: ["mcp__bb-bridge__write"],
    hooks: { UserPromptSubmit: [{ hooks: [parentHook] }] },
    settings: { autoMemoryEnabled: false },
  };
  return {
    controller,
    close,
    parentHook,
    options,
    fail: (error: Error) => rejectNext?.(error),
    finish: () => emit?.({ value: undefined, done: true }),
    run: () =>
      requestClaudePromptSuggestion({
        sessionOptions: options,
        providerSessionId: "parent-native-session",
        model: options.model,
        dynamicTools: [
          {
            name: "write",
            description: "Write data",
            inputSchema: { type: "object" },
          },
        ],
        prompt: "Predict the next user prompt",
        signal: controller.signal,
      }),
    sdkOptions: () => {
      if (!sdkOptions) throw new Error("Expected SDK query options");
      return sdkOptions;
    },
    message: (message: Record<string, unknown>) =>
      emit?.({ value: sdkMessage(message), done: false }),
    result: (result: string, subtype = "success", isError = false) =>
      emit?.({
        value: sdkMessage({
          type: "result",
          subtype,
          is_error: isError,
          result,
        }),
        done: false,
      }),
  };
}

beforeEach(() => {
  queryMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

it.each(["claude-opus-5-5", "claude-fable-5-1"])(
  "returns only a successful short result from the same-model nonpersisted fork (%s)",
  async (model) => {
    const fixture = setup();
    fixture.options.model = model;
    const pending = fixture.run();
    expect(fixture.sdkOptions()).toMatchObject({
      model,
      resume: "parent-native-session",
      systemPrompt: "Parent system prefix",
      forkSession: true,
      persistSession: false,
      promptSuggestions: false,
      maxTurns: 1,
      settings: { disableAllHooks: true },
    });
    expect(fixture.sdkOptions().allowedTools).toBeUndefined();
    expect(Object.keys(fixture.sdkOptions().hooks ?? {})).toEqual([
      "PreToolUse",
    ]);
    const raw = JSON.stringify({ suggestion: "Check the migration" });
    fixture.result(`  ${raw}  `);
    expect(await pending).toBe(raw);
    expect(fixture.parentHook).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalled();
  },
);

it("denies ToolSearch through the matcher-free SDK hook and rejects later text", async () => {
  const fixture = setup();
  const pending = fixture.run();
  const matcher = fixture.sdkOptions().hooks?.PreToolUse?.[0];
  const hook = matcher?.hooks[0];
  expect(matcher?.matcher).toBeUndefined();
  if (!hook) throw new Error("Expected prediction safety hook");
  const result = await hook(
    {
      hook_event_name: "PreToolUse",
      tool_name: "ToolSearch",
      tool_input: { query: "write" },
      tool_use_id: "tool-search",
      session_id: "fork",
      transcript_path: "/not-persisted",
      cwd: "/tmp/prediction",
    },
    "tool-search",
    { signal: new AbortController().signal },
  );
  expect(result).toMatchObject({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Prompt predictions cannot execute tools.",
    },
  });
  fixture.result("A prediction after attempting a tool");
  await expect(pending).rejects.toThrow("attempted a tool");
  expect(fixture.sdkOptions().abortController?.signal.aborted).toBe(true);
});

it("keeps the parent's MCP declaration but makes its operational forwarding inert", async () => {
  const fixture = setup();
  const pending = fixture.run();
  const server = fixture.sdkOptions().mcpServers?.["bb-bridge"];
  if (!server || server.type !== "sdk")
    throw new Error("Expected SDK MCP server");
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "prediction-test", version: "1.0.0" });
  try {
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools).toMatchObject([
      {
        name: "write",
        description: "Write data",
        inputSchema: { type: "object" },
      },
    ]);
    expect(
      await client.callTool({ name: "write", arguments: {} }),
    ).toMatchObject({
      isError: true,
      content: [
        { type: "text", text: "Prompt predictions cannot execute tools." },
      ],
    });
    fixture.result("Text after an attempted MCP call");
    await expect(pending).rejects.toThrow("attempted a tool");
  } finally {
    fixture.controller.abort();
    await client.close();
    await server.instance.close();
  }
});

it("aborts and closes an unresolved fork when canceled, without waiting for another SDK event", async () => {
  const fixture = setup();
  const pending = fixture.run();
  fixture.controller.abort();
  expect(await pending).toBeNull();
  expect(fixture.close).toHaveBeenCalled();
  expect(fixture.sdkOptions().abortController?.signal.aborted).toBe(true);
});

it.each([
  ["x".repeat(8001), "success", false],
  ["partial text", "error_max_turns", true],
  ["partial text", "success", true],
  ["   ", "success", false],
])(
  "rejects oversized, failed, or empty output",
  async (text, subtype, isError) => {
    const fixture = setup();
    const pending = fixture.run();
    fixture.result(text, subtype, isError);
    await expect(pending).rejects.toThrow("Prompt suggestion");
  },
);

it("bounds an upstream hang with real query cancellation rather than accepting partial output", async () => {
  vi.useFakeTimers();
  const fixture = setup();
  const pending = fixture.run();
  const rejection = expect(pending).rejects.toThrow("timed out");
  await vi.runAllTimersAsync();
  await rejection;
  expect(fixture.sdkOptions().abortController?.signal.aborted).toBe(true);
  expect(fixture.close).toHaveBeenCalled();
});

it("preserves a bounded JSON envelope for central decoding even when escaping exceeds the native-text limit", async () => {
  const fixture = setup();
  const pending = fixture.run();
  const raw = JSON.stringify({ suggestion: "\\".repeat(1000) });
  expect(raw.length).toBeGreaterThan(1000);
  fixture.result(raw);
  expect(await pending).toBe(raw);
});

it.each(["fallback", "oversized-stream"])(
  "closes the fork without accepting partial output after %s",
  async (kind) => {
    const fixture = setup();
    const pending = fixture.run();
    fixture.message(
      kind === "fallback"
        ? {
            type: "system",
            subtype: "model_refusal_fallback",
            original_model: "claude-fable-5-1",
            fallback_model: "claude-opus-5-5",
          }
        : {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "x".repeat(8001) },
            },
          },
    );
    await expect(pending).rejects.toThrow("Prompt suggestion");
    expect(fixture.close).toHaveBeenCalled();
  },
);

it.each(["startup", "stream"])(
  "propagates an unexpected SDK %s exception instead of returning no suggestion",
  async (phase) => {
    const fixture = setup();
    const error = new Error("Upstream authentication failed");
    if (phase === "startup")
      queryMock.mockImplementationOnce(() => {
        throw error;
      });
    const pending = fixture.run();
    const rejection = expect(pending).rejects.toBe(error);
    if (phase === "stream") fixture.fail(error);
    await rejection;
    if (phase === "stream") expect(fixture.close).toHaveBeenCalled();
  },
);

it("rejects an SDK abort exception that was not requested by the caller", async () => {
  const fixture = setup();
  const pending = fixture.run();
  fixture.fail(
    Object.assign(new Error("Query aborted"), { name: "AbortError" }),
  );
  await expect(pending).rejects.toThrow("Query aborted");
  expect(fixture.close).toHaveBeenCalled();
});

it("rejects a malformed successful result", async () => {
  const fixture = setup();
  const pending = fixture.run();
  fixture.message({
    type: "result",
    subtype: "success",
    is_error: false,
    result: 42,
  });
  await expect(pending).rejects.toThrow("SDK result failed");
  expect(fixture.close).toHaveBeenCalled();
});

it("fails when the fork ends without a result instead of reporting abstention", async () => {
  const fixture = setup();
  const pending = fixture.run();
  fixture.finish();
  await expect(pending).rejects.toThrow("stream ended without a result");
  expect(fixture.close).toHaveBeenCalled();
});

it("preserves an explicit JSON null envelope for central abstention decoding", async () => {
  const fixture = setup();
  const pending = fixture.run();
  fixture.result('{"suggestion":null}');
  expect(await pending).toBe('{"suggestion":null}');
});

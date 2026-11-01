import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { BridgeExecutionOptions } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

const THREAD_ID = "thr_prompt_sampling";
const FIRST_SOURCE = "creq_sampfirst2";
const SECOND_SOURCE = "creq_sampnext22";
const MODEL = "gpt-6.1-sol";
const PROMPT = "Suggest one short next user request.";
const requestSchema = z.object({
  id: z.string().optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
});
const deltaSchema = z.record(z.string(), z.unknown());
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  try {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

function configuration(sourceRequestId: string | null, automatic = true) {
  return { automatic, prompt: PROMPT, sourceRequestId };
}

function options(sourceRequestId: string | null, automatic = true) {
  return {
    ...FULL_ACCESS_SESSION_OPTIONS,
    model: MODEL,
    reasoningLevel: "high",
    serviceTier: "priority",
    promptSuggestions: configuration(sourceRequestId, automatic),
  } satisfies BridgeExecutionOptions;
}

function nativeTurn(
  id: string,
  status = "completed",
  threadId = "fixture-root",
) {
  return { threadId, turn: { id, status } };
}

async function setup(script: Record<string, unknown> = {}, resume = false) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-sampling-"));
  const requestLogPath = join(workspaceDir, "requests.jsonl");
  const scriptPath = join(workspaceDir, "script.json");
  writeFileSync(scriptPath, JSON.stringify({ requestLogPath, ...script }));
  stubFakeCodexAppServer(scriptPath);
  const harness = createBridgeJsonRpcTestHarness(handleLine);
  cleanups.push(async () => {
    try {
      harness.sendRequest(999_123, "thread/stop", {
        threadId: THREAD_ID,
        providerThreadId: "cleanup",
        intent: "release",
        activeTurnId: null,
      });
      await harness.waitForResponse(999_123);
    } finally {
      harness.restore();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
  harness.sendRequest(1, resume ? "thread/resume" : "thread/start", {
    threadId: THREAD_ID,
    ...(resume ? { providerThreadId: "resumed-codex-thread" } : {}),
    cwd: workspaceDir,
    instructionMode: "append",
    options: options(resume ? FIRST_SOURCE : null, false),
  });
  const started = await harness.waitForResponse(1);
  expect(started.error).toBeUndefined();
  const { providerThreadId } = z
    .object({ providerThreadId: z.string() })
    .parse(started.result);
  const requests = () =>
    readFileSync(requestLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => requestSchema.parse(JSON.parse(line)));
  const samples = () =>
    requests().filter((request) => request.method === "thread/sample");
  const deltas = () =>
    harness.messages.flatMap((message) =>
      message.method === "thread/delta"
        ? z.object({ deltas: z.array(deltaSchema) }).parse(message.params)
            .deltas
        : [],
    );
  const suggestions = () =>
    deltas().filter((delta) => delta.kind === "prompt.suggestion");
  function turn(
    id: number,
    source = FIRST_SOURCE,
    text = "Review this change",
    automatic = true,
  ) {
    harness.sendRequest(id, "turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      clientRequestId: source,
      input: [{ type: "text", text, mentions: [] }],
      options: options(source, automatic),
    });
    return harness.waitForResponse(id);
  }
  function sample(id = 3, requestId = "button-sample") {
    harness.sendRequest(id, "thread/prompt-suggestion/request", {
      threadId: THREAD_ID,
      providerThreadId,
      requestId,
      sourceTurnId: "bb-completed-turn",
      prompt: PROMPT,
    });
    return harness.waitForResponse(id);
  }
  async function configure(
    id: number,
    automatic: boolean,
    source = FIRST_SOURCE,
  ) {
    harness.sendRequest(id, "thread/prompt-suggestion/configure", {
      threadId: THREAD_ID,
      providerThreadId,
      configuration: configuration(source, automatic),
    });
    expect((await harness.waitForResponse(id)).error).toBeUndefined();
  }
  return {
    harness,
    providerThreadId,
    requests,
    samples,
    deltas,
    suggestions,
    turn,
    sample,
    configure,
  };
}

it("samples a settled root once despite duplicate and background completions, using only the native checkpoint and inherited settings", async () => {
  const root = nativeTurn("native-turn-one");
  const fixture = await setup({
    turns: [
      [
        {
          method: "turn/started",
          params: nativeTurn("native-turn-one", "inProgress"),
        },
        { method: "turn/completed", params: root },
        { method: "turn/completed", params: root },
        {
          method: "turn/completed",
          params: nativeTurn("agent-turn", "completed", "subagent-thread"),
          preserveThreadId: true,
        },
      ],
    ],
  });
  expect((await fixture.turn(2)).error).toBeUndefined();
  await vi.waitFor(() =>
    expect(fixture.suggestions()).toEqual([
      {
        kind: "prompt.suggestion",
        sourceRequestId: FIRST_SOURCE,
        model: MODEL,
        text: "Review the implementation",
      },
    ]),
  );
  expect(fixture.samples()).toHaveLength(1);
  expect(fixture.samples()[0]?.params).toEqual({
    threadId: fixture.providerThreadId,
    expectedTurnId: "native-turn-one",
    prompt: PROMPT,
  });
  expect(
    fixture.requests().filter((request) => request.method === "thread/start"),
  ).toHaveLength(1);
  const parentTurn = fixture
    .requests()
    .find((request) => request.method === "turn/start");
  expect(parentTurn?.params).toMatchObject({
    model: MODEL,
    serviceTier: "priority",
    input: [{ type: "text", text: "Review this change", text_elements: [] }],
  });
  expect(JSON.stringify(parentTurn?.params)).not.toContain(PROMPT);
  expect(
    fixture.requests().filter((request) => request.method === "turn/start"),
  ).toHaveLength(1);
});

it.each(["failed", "interrupted"])(
  "does not sample a %s root turn",
  async (status) => {
    const fixture = await setup({
      turns: [
        [
          {
            method: "turn/started",
            params: nativeTurn("failed-native", "inProgress"),
          },
          {
            method: "turn/completed",
            params: nativeTurn("failed-native", status),
          },
        ],
      ],
    });
    await fixture.turn(2);
    await vi.waitFor(() =>
      expect(
        fixture
          .deltas()
          .some(
            (delta) =>
              delta.kind === "turn.boundary" && delta.status === status,
          ),
      ).toBe(true),
    );
    const result = await fixture.sample();
    expect(result.error?.message).toContain(
      "latest successful completed source",
    );
    expect(fixture.samples()).toEqual([]);
    expect(fixture.suggestions()).toEqual([]);
  },
);

it("does not automatically sample manual compaction", async () => {
  const fixture = await setup();
  fixture.harness.sendRequest(2, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId: fixture.providerThreadId,
    clientRequestId: FIRST_SOURCE,
    input: [
      {
        type: "text",
        text: "/compact",
        mentions: [
          {
            start: 0,
            end: "/compact".length,
            resource: {
              kind: "command",
              trigger: "/",
              name: "compact",
              source: "command",
              origin: "builtin",
              label: "compact",
              argumentHint: null,
            },
          },
        ],
      },
    ],
    options: options(FIRST_SOURCE),
  });
  expect((await fixture.harness.waitForResponse(2)).error).toBeUndefined();
  await vi.waitFor(() =>
    expect(
      fixture.deltas().some((delta) => delta.kind === "turn.boundary"),
    ).toBe(true),
  );
  expect(
    fixture
      .requests()
      .filter((request) => request.method === "thread/compact/start"),
  ).toHaveLength(1);
  expect(
    fixture.requests().filter((request) => request.method === "turn/start"),
  ).toEqual([]);
  await fixture.configure(3, false);
  expect(fixture.samples()).toEqual([]);
  expect(fixture.suggestions()).toEqual([]);
});

it("samples on demand after resume using native turn metadata, not the BB sourceTurnId", async () => {
  const fixture = await setup(
    { sourceTurns: [{ id: "resumed-native-turn", status: "completed" }] },
    true,
  );
  const response = await fixture.sample();
  expect(response.error).toBeUndefined();
  expect(response.result).toEqual({
    sourceTurnId: "bb-completed-turn",
    text: "Review the implementation",
  });
  expect(fixture.samples()[0]?.params.expectedTurnId).toBe(
    "resumed-native-turn",
  );
  expect(
    fixture.requests().find((request) => request.method === "thread/turns/list")
      ?.params,
  ).toEqual({
    threadId: fixture.providerThreadId,
    limit: 1,
    sortDirection: "desc",
    itemsView: "notLoaded",
  });
  expect(
    fixture.requests().filter((request) => request.method === "thread/resume"),
  ).toHaveLength(1);
  expect(fixture.suggestions()).toEqual([]);
});

it.each([null, "x".repeat(8_001)])(
  "treats null or oversized text as one normal no-suggestion result",
  async (text) => {
    const fixture = await setup({ sample: { text } });
    await fixture.turn(2);
    await vi.waitFor(() =>
      expect(fixture.suggestions()).toEqual([
        {
          kind: "prompt.suggestion",
          sourceRequestId: FIRST_SOURCE,
          model: MODEL,
          text: null,
        },
      ]),
    );
    expect(fixture.samples()).toHaveLength(1);
  },
);

it("cancels native inference without delaying a new parent input and suppresses its late successful response", async () => {
  const fixture = await setup({
    samples: [
      {
        hold: true,
        ignoreCancel: true,
        completeOnNextTurn: true,
        text: "stale text",
      },
      { text: "fresh text" },
    ],
  });
  await fixture.turn(2);
  await vi.waitFor(() => expect(fixture.samples()).toHaveLength(1));
  const nativeRequestId = fixture.samples()[0]?.id;
  expect(
    (await fixture.turn(4, SECOND_SOURCE, "New input")).error,
  ).toBeUndefined();
  await vi.waitFor(() =>
    expect(fixture.suggestions()).toEqual([
      {
        kind: "prompt.suggestion",
        sourceRequestId: SECOND_SOURCE,
        model: MODEL,
        text: "fresh text",
      },
    ]),
  );
  await fixture.configure(5, false, SECOND_SOURCE);
  expect(
    fixture
      .requests()
      .filter((request) => request.method === "thread/sample/cancel")
      .map((request) => request.params),
  ).toContainEqual({ requestId: nativeRequestId });
  expect(fixture.samples()).toHaveLength(2);
  expect(
    fixture.requests().filter((request) => request.method === "turn/start"),
  ).toHaveLength(2);
});

it.each([true, false])(
  "cancels a pending automatic or manual sample on configuration updates without reconstructing the parent: automatic=%s",
  async (automatic) => {
    const fixture = await setup({ sample: { hold: true } });
    await fixture.turn(2, FIRST_SOURCE, "Review this change", automatic);
    const pending = automatic ? null : fixture.sample(6);
    await vi.waitFor(() => expect(fixture.samples()).toHaveLength(1));
    await fixture.configure(3, false);
    if (pending !== null)
      expect((await pending).error?.message).toContain("sample canceled");
    expect(
      fixture
        .requests()
        .some((request) => request.method === "thread/sample/cancel"),
    ).toBe(true);
    expect(fixture.suggestions()).toEqual([]);
    expect(
      fixture.requests().filter((request) => request.method === "thread/start"),
    ).toHaveLength(1);
    expect(
      (await fixture.turn(4, SECOND_SOURCE, "Continue", false)).error,
    ).toBeUndefined();
  },
);

it("cancels the matching manual request, rejects overlapping requests, and leaves the parent usable", async () => {
  const fixture = await setup(
    {
      sourceTurns: [{ id: "native-id", status: "completed" }],
      sample: { hold: true },
    },
    true,
  );
  const pending = fixture.sample(2);
  await vi.waitFor(() => expect(fixture.samples()).toHaveLength(1));
  expect((await fixture.sample(3, "other-request")).error?.message).toContain(
    "already pending",
  );
  fixture.harness.sendRequest(4, "thread/prompt-suggestion/cancel", {
    threadId: THREAD_ID,
    providerThreadId: fixture.providerThreadId,
    requestId: "button-sample",
  });
  expect((await fixture.harness.waitForResponse(4)).result).toEqual({});
  expect((await pending).error?.message).toContain("sample canceled");
  expect(
    fixture
      .requests()
      .find((request) => request.method === "thread/sample/cancel")?.params,
  ).toEqual({ requestId: fixture.samples()[0]?.id });
  expect(
    (await fixture.turn(5, SECOND_SOURCE, "Continue", false)).error,
  ).toBeUndefined();
});

it.each(["/wait-for-interrupt", "/late-start-interruptible"])(
  "rejects sampling while the parent is busy, including before its start notification: %s",
  async (text) => {
    const fixture = await setup({ neverStart: true });
    await fixture.turn(2, FIRST_SOURCE, text, false);
    expect((await fixture.sample()).error?.message).toContain("idle parent");
    expect(fixture.samples()).toEqual([]);
  },
);

it("reports unsupported native sampling without changing or breaking the parent", async () => {
  const fixture = await setup(
    {
      sourceTurns: [{ id: "native-id", status: "completed" }],
      sample: { error: { code: -32601, message: "Method not found" } },
    },
    true,
  );
  expect((await fixture.sample()).error?.message).toContain(
    "does not support native thread/sample",
  );
  expect(
    (await fixture.turn(4, SECOND_SOURCE, "Continue", false)).error,
  ).toBeUndefined();
  expect(
    fixture
      .requests()
      .some((request) => request.method === "thread/prediction/request"),
  ).toBe(false);
});

it("rejects UTF-8 oversized prompts before starting inference", async () => {
  const fixture = await setup(
    { sourceTurns: [{ id: "native-id", status: "completed" }] },
    true,
  );
  fixture.harness.sendRequest(2, "thread/prompt-suggestion/request", {
    threadId: THREAD_ID,
    providerThreadId: fixture.providerThreadId,
    requestId: "invalid-prompt",
    sourceTurnId: "bb-turn",
    prompt: "é".repeat(2_001),
  });
  expect((await fixture.harness.waitForResponse(2)).error?.code).toBe(-32602);
  expect(fixture.samples()).toEqual([]);
});

it("rejects a native response for another source turn", async () => {
  const fixture = await setup(
    {
      sourceTurns: [{ id: "native-id", status: "completed" }],
      sample: { sourceTurnId: "stale-native" },
    },
    true,
  );
  expect((await fixture.sample()).error?.message).toContain(
    "stale source turn",
  );
  expect(fixture.suggestions()).toEqual([]);
});

it("sends native cancel when the sample RPC times out rather than leaving inference running", async () => {
  const fixture = await setup(
    {
      sourceTurns: [{ id: "native-id", status: "completed" }],
      sample: { hold: true },
    },
    true,
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fixture.harness.sendRequest(2, "thread/prompt-suggestion/request", {
    threadId: THREAD_ID,
    providerThreadId: fixture.providerThreadId,
    requestId: "timed-sample",
    sourceTurnId: "bb-turn",
    prompt: PROMPT,
  });
  await vi.waitFor(() => expect(fixture.samples()).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(31_000);
  vi.useRealTimers();
  expect((await fixture.harness.waitForResponse(2)).error?.message).toContain(
    "did not answer thread/sample",
  );
  expect(
    fixture
      .requests()
      .find((request) => request.method === "thread/sample/cancel")?.params,
  ).toEqual({ requestId: fixture.samples()[0]?.id });
  expect(
    (await fixture.turn(4, SECOND_SOURCE, "Continue", false)).error,
  ).toBeUndefined();
});

it("cancels a prior sample when steering races with native turn completion", async () => {
  const fixture = await setup({
    sample: { hold: true },
    steerError: "The turn to steer is no longer active",
  });
  await fixture.turn(2);
  await vi.waitFor(() => expect(fixture.samples()).toHaveLength(1));
  fixture.harness.sendRequest(3, "turn/steer", {
    threadId: THREAD_ID,
    providerThreadId: fixture.providerThreadId,
    clientRequestId: SECOND_SOURCE,
    expectedTurnId: "turn-fx-1",
    input: [{ type: "text", text: "New direction", mentions: [] }],
    options: options(SECOND_SOURCE, false),
  });
  expect((await fixture.harness.waitForResponse(3)).error?.message).toContain(
    "no longer active",
  );
  expect(
    fixture
      .requests()
      .find((request) => request.method === "thread/sample/cancel")?.params,
  ).toEqual({ requestId: fixture.samples()[0]?.id });
  expect(fixture.suggestions()).toEqual([]);
});

it("cancels pending inference when releasing the loaded session", async () => {
  const fixture = await setup({ sample: { hold: true } });
  await fixture.turn(2);
  await vi.waitFor(() => expect(fixture.samples()).toHaveLength(1));
  fixture.harness.sendRequest(3, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: fixture.providerThreadId,
    intent: "release",
    activeTurnId: null,
  });
  expect((await fixture.harness.waitForResponse(3)).error).toBeUndefined();
  expect(
    fixture
      .requests()
      .find((request) => request.method === "thread/sample/cancel")?.params,
  ).toEqual({ requestId: fixture.samples()[0]?.id });
  expect(fixture.suggestions()).toEqual([]);
});

it("passes the raw prediction JSON envelope through without applying the normalized draft limit", async () => {
  const text = JSON.stringify({ suggestion: '"'.repeat(1_000) });
  const fixture = await setup({ sample: { text } });
  await fixture.turn(2);
  await vi.waitFor(() =>
    expect(fixture.suggestions()).toEqual([
      {
        kind: "prompt.suggestion",
        sourceRequestId: FIRST_SOURCE,
        model: MODEL,
        text,
      },
    ]),
  );
  expect(fixture.samples()).toHaveLength(1);
});

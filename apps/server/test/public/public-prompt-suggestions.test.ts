import { eq } from "drizzle-orm";
import { createDeferredPromise } from "@bb/test-helpers";
import {
  events,
  getPromptSuggestionModeOverride,
  setPromptSuggestionModeOverride,
  setThreadExecutionOverride,
  updateThread,
  threads,
} from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
  type PromptSuggestionState,
} from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { afterEach, expect, it, vi } from "vitest";
import { setPluginAgentContributions } from "../../src/services/plugins/plugin-agent-contributions.js";
import {
  synchronizePromptSuggestionEligibility,
  decodePromptSuggestion,
  resolvePromptSuggestionMode,
} from "../../src/services/threads/prompt-suggestions.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  registerHostRpcResponder,
  type HostRpcHandlerResult,
} from "../helpers/host-rpc.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function fixture(
  harness: TestAppHarness,
  providerId = "codex",
  model = "gpt-5",
) {
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId,
  });
  seedThreadRuntimeState(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: "provider-1",
    model,
  });
  const requestId = encodeClientTurnRequestIdNumber({ value: 1 });
  seedTurnStarted(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    turnId: "completed-1",
    sequence: 3,
  });
  seedEvent(harness.deps, {
    threadId: thread.id,
    sequence: 4,
    type: "turn/input/accepted",
    scope: turnScope("completed-1"),
    data: { providerThreadId: "provider-1", clientRequestId: requestId },
  });
  seedEvent(harness.deps, {
    threadId: thread.id,
    sequence: 5,
    type: "turn/completed",
    scope: turnScope("completed-1"),
    data: { providerThreadId: "provider-1", status: "completed" },
  });
  return { host, session, project, environment, thread, requestId };
}
async function state(
  harness: TestAppHarness,
  threadId: string,
): Promise<PromptSuggestionState> {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/prompt-suggestion`,
  );
  expect(response.status).toBe(200);
  return response.json();
}
async function postSuggestion(
  harness: TestAppHarness,
  args: ReturnType<typeof fixture>,
  overrides: {
    sourceRequestId?: string;
    model?: string;
    text?: string | null;
  } = {},
) {
  return harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness),
    body: JSON.stringify({
      sessionId: args.session.id,
      eventGroups: groupHostDaemonEvents([
        {
          threadId: args.thread.id,
          event: {
            type: "thread/promptSuggestion/updated",
            threadId: args.thread.id,
            scope: threadScope(),
            sourceRequestId: args.requestId,
            model: "gpt-5",
            text: '{"suggestion":"implement it"}',
            ...overrides,
          },
        },
      ]),
    }),
  });
}
afterEach(() => {
  setPluginAgentContributions(undefined);
  vi.restoreAllMocks();
});

it.each([
  null,
  "",
  "not JSON",
  '"do it"',
  '{"suggestion":"  "}',
  '{"suggestion":"go","extra":true}',
  JSON.stringify({ suggestion: "x".repeat(1001) }),
])(
  "rejects unsupported prediction output instead of treating it as abstention: %s",
  (output) => {
    expect(() => decodePromptSuggestion(output)).toThrow("invalid response");
  },
);
it("decodes only the supported short-message envelope or explicit abstention", () => {
  expect(decodePromptSuggestion('{"suggestion":null}')).toBeNull();
  expect(decodePromptSuggestion('{"suggestion":"  add the tests  "}')).toBe(
    "add the tests",
  );
});
it("consumes automatic predictions without persisting events and ignores stale source/model and dismissed results", async () => {
  await withTestHarness(async (harness) => {
    const args = fixture(harness);
    const before = harness.deps.db
      .select()
      .from(events)
      .where(eq(events.threadId, args.thread.id))
      .all();
    expect((await state(harness, args.thread.id)).text).toBeNull();
    expect((await postSuggestion(harness, args)).status).toBe(200);
    expect(await state(harness, args.thread.id)).toMatchObject({
      mode: "automatic",
      eligible: true,
      sourceTurnId: "completed-1",
      text: "implement it",
    });
    expect(
      harness.deps.db
        .select()
        .from(events)
        .where(eq(events.threadId, args.thread.id))
        .all(),
    ).toEqual(before);
    await postSuggestion(harness, args, {
      sourceRequestId: encodeClientTurnRequestIdNumber({ value: 2 }),
      text: '{"suggestion":"wrong source"}',
    });
    await postSuggestion(harness, args, {
      model: "other-model",
      text: '{"suggestion":"wrong model"}',
    });
    expect((await state(harness, args.thread.id)).text).toBe("implement it");
    const dismissed = await harness.app.request(
      `/api/v1/threads/${args.thread.id}/prompt-suggestion/dismiss`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceTurnId: "completed-1" }),
      },
    );
    expect(dismissed.status).toBe(200);
    await postSuggestion(harness, args);
    expect((await state(harness, args.thread.id)).text).toBeNull();
  });
});
it("keeps Claude native automatic text plain while all malformed Codex output is suppressed", async () => {
  await withTestHarness(async (harness) => {
    const args = fixture(harness, "claude-code", "claude-opus-5-5");
    await postSuggestion(harness, args, {
      model: "claude-opus-5-5",
      text: "write the implementation",
    });
    expect((await state(harness, args.thread.id)).text).toBe(
      "write the implementation",
    );
  });
});
it("re-evaluates eligibility for parentless plugin-managed cards even when they remain visible", async () => {
  await withTestHarness(async (harness) => {
    const args = fixture(harness);
    setPluginAgentContributions({
      listSkillRootContributions: () => [],
      listAgentTools: () => [],
      listInstructionContributions: () => [],
      findAgentTool: () => undefined,
      invokeAgentTool: async () => ({ success: false, contentItems: [] }),
      resolveMention: async () => ({ ok: false, error: "not found" }),
      resolveAgentConfiguration: async () => ({
        promptSuggestions: false,
        tools: [],
        selectedSkillIdsByPlugin: new Map(),
        dynamicInstructions: [],
      }),
    });
    setPromptSuggestionModeOverride(
      harness.deps.db,
      args.thread.id,
      "automatic",
    );
    await postSuggestion(harness, args);
    expect(await state(harness, args.thread.id)).toMatchObject({
      eligible: false,
      text: null,
    });
    const response = await harness.app.request(
      `/api/v1/threads/${args.thread.id}/prompt-suggestion/request`,
      { method: "POST" },
    );
    expect(response.status).toBe(409);
  });
});
it("rejects descendants and busy threads at the public request boundary", async () => {
  await withTestHarness(async (harness) => {
    const args = fixture(harness);
    const parent = seedThread(harness.deps, { projectId: args.project.id });
    updateThread(harness.deps.db, harness.deps.hub, args.thread.id, {
      parentThreadId: parent.id,
    });
    expect((await state(harness, args.thread.id)).eligible).toBe(false);
    expect(
      (
        await harness.app.request(
          `/api/v1/threads/${args.thread.id}/prompt-suggestion/request`,
          { method: "POST" },
        )
      ).status,
    ).toBe(409);
  });
});
it("persists only the mode override and restores model defaults when reset", async () => {
  await withTestHarness(async (harness) => {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      providerId: "claude-code",
      status: "pending",
    });
    setThreadExecutionOverride(harness.deps.db, {
      threadId: thread.id,
      modelOverride: "claude-fable-5-1",
      reasoningLevelOverride: null,
    });
    expect((await state(harness, thread.id)).mode).toBe("button");
    for (const mode of ["off", "automatic", null] as const) {
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/prompt-suggestion/mode`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode }),
        },
      );
      expect(response.status).toBe(200);
      expect(getPromptSuggestionModeOverride(harness.deps.db, thread.id)).toBe(
        mode,
      );
      expect((await state(harness, thread.id)).mode).toBe(mode ?? "button");
    }
    expect(
      harness.deps.db
        .select()
        .from(events)
        .where(eq(events.threadId, thread.id))
        .all(),
    ).toEqual([]);
  });
});
it("deduplicates button clicks and cancels a pending request without waiting for its inference result", async () => {
  await withTestHarness(async (harness) => {
    const args = fixture(harness);
    setPromptSuggestionModeOverride(harness.deps.db, args.thread.id, "button");
    let release!: (value: HostRpcHandlerResult) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const reply = new Promise<HostRpcHandlerResult>((resolve) => {
      release = resolve;
    });
    const responder = registerHostRpcResponder(harness, {
      hostId: args.host.id,
      sessionId: args.session.id,
      handle: ({ command }) => {
        if (command.type === "host.read_workspace_agent_context")
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        if (command.type === "thread.promptSuggestion.request") {
          markStarted();
          return reply;
        }
        if (command.type === "thread.promptSuggestion.cancel")
          return { ok: true, result: {} };
        throw new Error(`Unexpected command ${command.type}`);
      },
    });
    const first = harness.app.request(
      `/api/v1/threads/${args.thread.id}/prompt-suggestion/request`,
      { method: "POST" },
    );
    const second = harness.app.request(
      `/api/v1/threads/${args.thread.id}/prompt-suggestion/request`,
      { method: "POST" },
    );
    try {
      await started;
      expect((await state(harness, args.thread.id)).pending).toBe(true);
      await harness.app.request(
        `/api/v1/threads/${args.thread.id}/prompt-suggestion/dismiss`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceTurnId: "completed-1" }),
        },
      );
      expect((await state(harness, args.thread.id)).pending).toBe(false);
      expect(
        responder.requests.filter(
          ({ command }) => command.type === "thread.promptSuggestion.cancel",
        ),
      ).toHaveLength(1);
    } finally {
      release({
        ok: true,
        result: {
          sourceTurnId: "completed-1",
          text: '{"suggestion":"obsolete"}',
        },
      });
      await Promise.all([first, second]);
    }
    expect(
      responder.requests.filter(
        ({ command }) => command.type === "thread.promptSuggestion.request",
      ),
    ).toHaveLength(1);
    expect((await state(harness, args.thread.id)).text).toBeNull();
  });
});
it.each(['{"suggestion":null}', '{"suggestion":"check the tests"}'])(
  "decodes a manual prediction without creating a transcript event: %s",
  async (text) => {
    await withTestHarness(async (harness) => {
      const args = fixture(harness);
      setPromptSuggestionModeOverride(
        harness.deps.db,
        args.thread.id,
        "button",
      );
      const before = harness.deps.db
        .select()
        .from(events)
        .where(eq(events.threadId, args.thread.id))
        .all();
      const responder = registerHostRpcResponder(harness, {
        hostId: args.host.id,
        sessionId: args.session.id,
        handle: ({ command }) => {
          if (command.type === "host.read_workspace_agent_context")
            return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
          if (command.type === "thread.promptSuggestion.request")
            return { ok: true, result: { sourceTurnId: "completed-1", text } };
          throw new Error(`Unexpected command ${command.type}`);
        },
      });
      await state(harness, args.thread.id);
      await postSuggestion(harness, args);
      expect((await state(harness, args.thread.id)).text).toBeNull();
      expect(responder.requests).toHaveLength(0);
      const response = await harness.app.request(
        `/api/v1/threads/${args.thread.id}/prompt-suggestion/request`,
        { method: "POST" },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({
        text: text?.includes("check the tests") ? "check the tests" : null,
        pending: false,
      });
      expect(
        harness.deps.db
          .select()
          .from(events)
          .where(eq(events.threadId, args.thread.id))
          .all(),
      ).toEqual(before);
    });
  },
);
it.each([
  null,
  "malformed",
  '```json\n{"suggestion":null}\n```',
  '{"suggestion":"go","extra":true}',
  JSON.stringify({ suggestion: "x".repeat(1001) }),
])(
  "returns a retryable manual failure for invalid provider output: %s",
  async (text) => {
    await withTestHarness(async (harness) => {
      const args = fixture(harness);
      setPromptSuggestionModeOverride(
        harness.deps.db,
        args.thread.id,
        "button",
      );
      registerHostRpcResponder(harness, {
        hostId: args.host.id,
        sessionId: args.session.id,
        handle: ({ command }) => {
          if (command.type === "host.read_workspace_agent_context")
            return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
          if (command.type === "thread.promptSuggestion.request")
            return { ok: true, result: { sourceTurnId: "completed-1", text } };
          throw new Error(`Unexpected command ${command.type}`);
        },
      });
      const response = await harness.app.request(
        `/api/v1/threads/${args.thread.id}/prompt-suggestion/request`,
        { method: "POST" },
      );
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        code: "prompt_suggestion_failed",
        retryable: true,
      });
      expect(await state(harness, args.thread.id)).toMatchObject({
        text: null,
        pending: false,
      });
    });
  },
);
it.each([null, "malformed", '```json\n{"suggestion":null}\n```'])(
  "quietly drops invalid Automatic output without a visible failure: %s",
  async (text) => {
    await withTestHarness(async (harness) => {
      const args = fixture(harness);
      const warn = vi.spyOn(harness.deps.logger, "warn");
      const response = await postSuggestion(harness, args, { text });
      expect(response.status).toBe(200);
      expect(warn).toHaveBeenCalledWith(
        { threadId: args.thread.id, providerId: "codex" },
        "Automatic prompt suggestion returned an invalid response",
      );
      expect(await state(harness, args.thread.id)).toMatchObject({
        text: null,
        pending: false,
      });
    });
  },
);
it("rejects old source turns after a new accepted request and clears text when busy or model changes", async () => {
  await withTestHarness(async (harness) => {
    const args = fixture(harness);
    await postSuggestion(harness, args);
    harness.deps.db
      .update(threads)
      .set({ status: "active" })
      .where(eq(threads.id, args.thread.id))
      .run();
    expect((await state(harness, args.thread.id)).text).toBeNull();
    expect(
      (
        await harness.app.request(
          `/api/v1/threads/${args.thread.id}/prompt-suggestion/request`,
          { method: "POST" },
        )
      ).status,
    ).toBe(409);
    harness.deps.db
      .update(threads)
      .set({ status: "idle" })
      .where(eq(threads.id, args.thread.id))
      .run();
    setThreadExecutionOverride(harness.deps.db, {
      threadId: args.thread.id,
      modelOverride: "gpt-5.1",
      reasoningLevelOverride: null,
    });
    await postSuggestion(harness, args);
    expect((await state(harness, args.thread.id)).text).toBeNull();
    seedThreadRuntimeState(harness.deps, {
      threadId: args.thread.id,
      environmentId: args.environment.id,
      providerThreadId: "provider-1",
      sequenceStart: 6,
      model: "gpt-5.1",
    });
    await postSuggestion(harness, args, { model: "gpt-5.1" });
    expect(await state(harness, args.thread.id)).toMatchObject({
      text: null,
      sourceTurnId: null,
    });
  });
});

it("disables native auto at the idle boundary after a model advance without changing the user's mode", async () => {
  await withTestHarness(async (harness) => {
    const args = fixture(harness);
    const responder = registerHostRpcResponder(harness, {
      hostId: args.host.id,
      sessionId: args.session.id,
      handle: ({ command }) => {
        if (command.type === "host.read_workspace_agent_context")
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        if (command.type === "thread.promptSuggestion.configure")
          return { ok: true, result: {} };
        throw new Error(`Unexpected command ${command.type}`);
      },
    });
    setThreadExecutionOverride(harness.deps.db, {
      threadId: args.thread.id,
      modelOverride: "gpt-5.1",
      reasoningLevelOverride: null,
    });
    harness.deps.db
      .update(threads)
      .set({ status: "active" })
      .where(eq(threads.id, args.thread.id))
      .run();
    await synchronizePromptSuggestionEligibility(harness.deps, args.thread.id);
    expect(responder.requests).toHaveLength(0);
    harness.deps.db
      .update(threads)
      .set({ status: "idle" })
      .where(eq(threads.id, args.thread.id))
      .run();
    await synchronizePromptSuggestionEligibility(harness.deps, args.thread.id);
    expect(
      responder.requests
        .filter(
          ({ command }) => command.type === "thread.promptSuggestion.configure",
        )
        .map(({ command }) => command),
    ).toMatchObject([
      { configuration: { automatic: false, sourceRequestId: null } },
    ]);
    expect(
      getPromptSuggestionModeOverride(harness.deps.db, args.thread.id),
    ).toBeNull();
    expect((await state(harness, args.thread.id)).mode).toBe("automatic");
  });
});

it("keeps a newer automatic result when an old cancelled manual request fails late", async () => {
  await withTestHarness(async (harness) => {
    const args = fixture(harness);
    setPromptSuggestionModeOverride(harness.deps.db, args.thread.id, "button");
    let release!: (value: HostRpcHandlerResult) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const reply = new Promise<HostRpcHandlerResult>((resolve) => {
      release = resolve;
    });
    registerHostRpcResponder(harness, {
      hostId: args.host.id,
      sessionId: args.session.id,
      handle: ({ command }) => {
        if (command.type === "host.read_workspace_agent_context")
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        if (command.type === "thread.promptSuggestion.request") {
          markStarted();
          return reply;
        }
        if (command.type === "thread.promptSuggestion.cancel")
          return { ok: true, result: {} };
        throw new Error(`Unexpected command ${command.type}`);
      },
    });
    const old = harness.app.request(
      `/api/v1/threads/${args.thread.id}/prompt-suggestion/request`,
      { method: "POST" },
    );
    try {
      await started;
      await harness.app.request(
        `/api/v1/threads/${args.thread.id}/prompt-suggestion/dismiss`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceTurnId: "completed-1" }),
        },
      );
      seedThreadRuntimeState(harness.deps, {
        threadId: args.thread.id,
        environmentId: args.environment.id,
        providerThreadId: "provider-1",
        sequenceStart: 6,
      });
      seedTurnStarted(harness.deps, {
        threadId: args.thread.id,
        environmentId: args.environment.id,
        turnId: "completed-2",
        sequence: 8,
      });
      const requestId = encodeClientTurnRequestIdNumber({ value: 6 });
      seedEvent(harness.deps, {
        threadId: args.thread.id,
        sequence: 9,
        type: "turn/input/accepted",
        scope: turnScope("completed-2"),
        data: { providerThreadId: "provider-1", clientRequestId: requestId },
      });
      seedEvent(harness.deps, {
        threadId: args.thread.id,
        sequence: 10,
        type: "turn/completed",
        scope: turnScope("completed-2"),
        data: { providerThreadId: "provider-1", status: "completed" },
      });
      setPromptSuggestionModeOverride(
        harness.deps.db,
        args.thread.id,
        "automatic",
      );
      await postSuggestion(harness, args, {
        sourceRequestId: requestId,
        text: '{"suggestion":"newer prompt"}',
      });
      expect((await state(harness, args.thread.id)).text).toBe("newer prompt");
      release({
        ok: false,
        errorCode: "cancelled",
        errorMessage: "Old sample cancelled",
      });
      expect((await old).status).toBe(200);
      expect((await state(harness, args.thread.id)).text).toBe("newer prompt");
    } finally {
      release({
        ok: false,
        errorCode: "cancelled",
        errorMessage: "Old sample cancelled",
      });
      await old;
    }
  });
});

it.each(["fable", "claude-fable-5-1"])(
  "defaults the actual Fable model ID %s to Button without overriding explicit preferences",
  (model) => {
    expect(resolvePromptSuggestionMode("claude-code", model, null)).toBe(
      "button",
    );
    expect(resolvePromptSuggestionMode("claude-code", model, "automatic")).toBe(
      "automatic",
    );
    expect(resolvePromptSuggestionMode("claude-code", model, "off")).toBe(
      "off",
    );
  },
);

it("holds sends outside an acknowledged suggestion configuration transition", async () => {
  await withTestHarness(async (harness) => {
    const args = fixture(harness);
    const reached = createDeferredPromise<void>();
    const release = createDeferredPromise<void>();
    registerHostRpcResponder(harness, {
      hostId: args.host.id,
      sessionId: args.session.id,
      handle: async ({ command }) => {
        if (command.type === "host.read_workspace_agent_context")
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        if (command.type === "thread.promptSuggestion.configure") {
          reached.resolve();
          await release.promise;
          return { ok: true, result: {} };
        }
        throw new Error(`Unexpected command ${command.type}`);
      },
    });
    const configuring = harness.app.request(
      `/api/v1/threads/${args.thread.id}/prompt-suggestion/mode`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "off" }),
      },
    );
    try {
      await reached.promise;
      const response = await harness.app.request(
        `/api/v1/threads/${args.thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "auto",
            input: [{ type: "text", text: "racing input" }],
          }),
        },
      );
      expect(response.status).toBe(409);
      expect(
        getPromptSuggestionModeOverride(harness.deps.db, args.thread.id),
      ).toBeNull();
    } finally {
      release.resolve();
      expect((await configuring).status).toBe(200);
    }
    expect(
      getPromptSuggestionModeOverride(harness.deps.db, args.thread.id),
    ).toBe("off");
  });
});

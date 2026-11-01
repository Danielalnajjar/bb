import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { promptTextInput } from "./test/prompt-input.js";
import { UNSOLICITED_TURN_THREAD_ID_ENV } from "./test/bridges/unsolicited-turn-bridge.js";
import {
  waitForRuntimeState,
  createScriptedEchoLaunch,
  createScriptedEchoRequestRecord,
  createScriptedEchoRuntime,
  fullRuntimeOptions,
  scriptedEchoProcessEnv,
  wait,
  waitForRuntimeThreadEvent,
  waitForThreadTurnCompleted,
  waitForThreadTurnStarted,
  type CreateScriptedEchoLaunchOptions,
  type LaunchBoundAgentRuntime,
  type ScriptedEchoRequestRecord,
} from "./test/runtime-test-harness.js";

interface CreateContractRuntimeArgs {
  additionalWorkspaceWriteRoots?: readonly string[];
  env?: Record<string, string>;
  launch?: CreateScriptedEchoLaunchOptions;
  onEvent?: (event: ThreadEvent) => void;
  onStderr?: (line: string) => void;
  shellEnv?: Record<string, string>;
}

interface ContractRuntime {
  record: ScriptedEchoRequestRecord;
  runtime: LaunchBoundAgentRuntime;
}

const missingProviderThreadId = "t-missing";
const missingProviderThreadIdError =
  /No provider thread id available for t-missing/;
const acpLaunchSpec = {
  displayName: "Custom ACP",
  command: "custom-agent",
  args: ["serve"],
  env: { CUSTOM_AGENT_TOKEN: "token" },
};
const unsolicitedTurnBridgeModulePath = fileURLToPath(
  new URL("./test/bridges/unsolicited-turn-bridge.ts", import.meta.url),
);
const codexEmptyRolloutRenameError =
  "failed to set thread name: rollout at /tmp/new-rollout.jsonl is empty";

async function registerThreadWithoutProviderThreadId(
  runtime: LaunchBoundAgentRuntime,
): Promise<void> {
  await expect(
    runtime.resumeThread({
      environmentId: "env-1",
      threadId: missingProviderThreadId,
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    }),
  ).rejects.toThrow(missingProviderThreadIdError);
}

describe("createAgentRuntime command contracts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bb-runtime-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createContractRuntime(
    args: CreateContractRuntimeArgs = {},
  ): ContractRuntime {
    const record = createScriptedEchoRequestRecord();
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        env: { ...record.env, ...args.env },
        ...(args.additionalWorkspaceWriteRoots !== undefined
          ? {
              additionalWorkspaceWriteRoots: args.additionalWorkspaceWriteRoots,
            }
          : {}),
        onEvent: args.onEvent ?? (() => {}),
        ...(args.onStderr !== undefined ? { onStderr: args.onStderr } : {}),
        ...(args.shellEnv !== undefined ? { shellEnv: args.shellEnv } : {}),
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
      },
      ...(args.launch !== undefined ? { launch: args.launch } : {}),
    });
    return { record, runtime };
  }

  it.each(["loaded", "resumed"] as const)(
    "recovers a cleared suggestion source in a %s idle session without another turn",
    async (sessionState) => {
      const events: ThreadEvent[] = [];
      const { record, runtime } = createContractRuntime({
        onEvent: (event) => events.push(event),
      });
      const config = {
        ...fullRuntimeOptions,
        model: sessionState === "resumed" ? "changed-model" : "test-model",
        promptSuggestions: {
          automatic: false,
          prompt: "predict",
          sourceRequestId: "creq_23456789ab",
        },
      };
      const clearedConfiguration = {
        ...config.promptSuggestions,
        sourceRequestId: null,
      };
      let sourceTurnId = "bb-completed-1";
      try {
        if (sessionState === "loaded") {
          await runtime.startThread({
            environmentId: "env-1",
            threadId: "t1",
            projectId: "p1",
            providerId: "fake",
            options: config,
          });
          await runtime.runTurn({
            threadId: "t1",
            input: [promptTextInput({ text: "hello" })],
            clientRequestId: "creq_23456789ab",
            options: config,
          });
          const started = await waitForThreadTurnStarted({
            events,
            threadId: "t1",
            timeoutMs: 1000,
          });
          sourceTurnId = started.turnId;
          await waitForThreadTurnCompleted({
            events,
            threadId: "t1",
            turnId: sourceTurnId,
            timeoutMs: 1000,
          });
          await runtime.configurePromptSuggestions({
            threadId: "t1",
            configuration: clearedConfiguration,
          });
        } else {
          await runtime.resumeThread({
            environmentId: "env-1",
            threadId: "t1",
            projectId: "p1",
            providerId: "fake",
            providerThreadId: "provider-t1",
            options: { ...config, promptSuggestions: clearedConfiguration },
          });
        }
        await expect(
          runtime.requestPromptSuggestion({
            threadId: "t1",
            requestId: "prediction-1",
            sourceTurnId,
            prompt: "predict",
            options: config,
          }),
        ).resolves.toEqual({
          sourceTurnId,
          text: '{"suggestion":"continue"}',
        });
        expect(
          record.last("thread/prompt-suggestion/configure")?.params,
        ).toMatchObject({ configuration: config.promptSuggestions });
        expect(record.last("thread/stop")).toBeUndefined();
        expect(
          record.read().filter(({ method }) => method === "thread/resume"),
        ).toHaveLength(sessionState === "resumed" ? 1 : 0);
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it("rejects a stale source after clearing configuration when a newer completed turn is known", async () => {
    const events: ThreadEvent[] = [];
    const { record, runtime } = createContractRuntime({
      onEvent: (event) => events.push(event),
    });
    const staleConfig = {
      ...fullRuntimeOptions,
      promptSuggestions: {
        automatic: false,
        prompt: "predict",
        sourceRequestId: "creq_23456789ab",
      },
    };
    const currentConfig = {
      ...staleConfig,
      promptSuggestions: {
        ...staleConfig.promptSuggestions,
        sourceRequestId: "creq_3456789abc",
      },
    };
    try {
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: staleConfig,
      });
      await runtime.runTurn({
        threadId: "t1",
        input: [promptTextInput({ text: "new instruction" })],
        clientRequestId: "creq_3456789abc",
        options: currentConfig,
      });
      const { turnId } = await waitForThreadTurnStarted({
        events,
        threadId: "t1",
        timeoutMs: 1000,
      });
      await waitForThreadTurnCompleted({
        events,
        threadId: "t1",
        turnId,
        timeoutMs: 1000,
      });
      await runtime.configurePromptSuggestions({
        threadId: "t1",
        configuration: {
          ...currentConfig.promptSuggestions,
          sourceRequestId: null,
        },
      });
      await expect(
        runtime.requestPromptSuggestion({
          threadId: "t1",
          requestId: "stale-prediction",
          sourceTurnId: "bb-completed-old",
          prompt: "predict",
          options: staleConfig,
        }),
      ).rejects.toThrow("Prompt suggestion source changed");
      expect(record.last("thread/prompt-suggestion/request")).toBeUndefined();
      await expect(
        runtime.requestPromptSuggestion({
          threadId: "t1",
          requestId: "current-prediction",
          sourceTurnId: turnId,
          prompt: "predict",
          options: currentConfig,
        }),
      ).resolves.toEqual({
        sourceTurnId: turnId,
        text: '{"suggestion":"continue"}',
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it.each(["test-model", "changed-model"])(
    "does not overwrite a non-null suggestion source for requested model %s",
    async (model) => {
      const { runtime } = createContractRuntime();
      const config = {
        ...fullRuntimeOptions,
        promptSuggestions: {
          automatic: false,
          prompt: "predict",
          sourceRequestId: "creq_3456789abc",
        },
      };
      try {
        await runtime.startThread({
          environmentId: "env-1",
          threadId: "t1",
          projectId: "p1",
          providerId: "fake",
          options: config,
        });
        await expect(
          runtime.requestPromptSuggestion({
            threadId: "t1",
            requestId: "stale-prediction",
            sourceTurnId: "bb-completed-old",
            prompt: "predict",
            options: {
              ...config,
              model,
              promptSuggestions: {
                ...config.promptSuggestions,
                sourceRequestId: "creq_23456789ab",
              },
            },
          }),
        ).rejects.toThrow("Prompt suggestion source changed");
        await expect(
          runtime.requestPromptSuggestion({
            threadId: "t1",
            requestId: "current-prediction",
            sourceTurnId: "bb-completed-current",
            prompt: "predict",
            options: config,
          }),
        ).resolves.toEqual({
          sourceTurnId: "bb-completed-current",
          text: '{"suggestion":"continue"}',
        });
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it("cancels source recovery before a new parent turn and keeps the newer source", async () => {
    const events: ThreadEvent[] = [];
    const { record, runtime } = createContractRuntime({
      launch: {
        providerOptions: {
          scripted: { promptSuggestionConfigureWaitForCancel: true },
        },
      },
      onEvent: (event) => events.push(event),
    });
    const config = {
      ...fullRuntimeOptions,
      promptSuggestions: {
        automatic: false,
        prompt: "predict",
        sourceRequestId: "creq_23456789ab",
      },
    };
    const currentConfig = {
      ...config,
      promptSuggestions: {
        ...config.promptSuggestions,
        sourceRequestId: "creq_3456789abc",
      },
    };
    try {
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: {
          ...config,
          promptSuggestions: {
            ...config.promptSuggestions,
            sourceRequestId: null,
          },
        },
      });
      const prediction = runtime.requestPromptSuggestion({
        threadId: "t1",
        requestId: "old-prediction",
        sourceTurnId: "bb-completed-old",
        prompt: "predict",
        options: config,
      });
      await waitForRuntimeState({
        label: "source recovery waiting for cancellation",
        timeoutMs: 1000,
        predicate: () =>
          record.last("thread/prompt-suggestion/configure") !== undefined,
      });
      await runtime.runTurn({
        threadId: "t1",
        input: [promptTextInput({ text: "new instruction" })],
        clientRequestId: "creq_3456789abc",
        options: currentConfig,
      });
      await expect(prediction).resolves.toEqual({
        sourceTurnId: "bb-completed-old",
        text: null,
      });
      expect(record.last("thread/prompt-suggestion/request")).toBeUndefined();
      const { turnId } = await waitForThreadTurnStarted({
        events,
        threadId: "t1",
        timeoutMs: 1000,
      });
      await waitForThreadTurnCompleted({
        events,
        threadId: "t1",
        turnId,
        timeoutMs: 1000,
      });
      await expect(
        runtime.requestPromptSuggestion({
          threadId: "t1",
          requestId: "current-prediction",
          sourceTurnId: turnId,
          prompt: "predict",
          options: currentConfig,
        }),
      ).resolves.toEqual({
        sourceTurnId: turnId,
        text: '{"suggestion":"continue"}',
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it("starts a parent turn and cancels sampling while the prediction RPC is still pending", async () => {
    const { record, runtime } = createContractRuntime({
      launch: { scripted: { promptSuggestionWaitForCancel: true } },
    });
    const config = {
      ...fullRuntimeOptions,
      promptSuggestions: {
        automatic: false,
        prompt: "predict",
        sourceRequestId: "creq_23456789ab",
      },
    };
    try {
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: config,
      });
      const prediction = runtime.requestPromptSuggestion({
        threadId: "t1",
        requestId: "prediction-1",
        sourceTurnId: "bb-completed-1",
        prompt: "predict",
        options: config,
      });
      await waitForRuntimeState({
        label: "prediction request started",
        timeoutMs: 1000,
        predicate: () =>
          record.last("thread/prompt-suggestion/request") !== undefined,
      });
      await runtime.runTurn({
        threadId: "t1",
        input: [promptTextInput({ text: "new instruction" })],
        clientRequestId: "creq_3456789abc",
        options: {
          ...config,
          promptSuggestions: {
            ...config.promptSuggestions,
            sourceRequestId: "creq_3456789abc",
          },
        },
      });
      await expect(prediction).resolves.toEqual({
        sourceTurnId: "bb-completed-1",
        text: null,
      });
      expect(
        record.last("thread/prompt-suggestion/cancel")?.params,
      ).toMatchObject({ requestId: "prediction-1" });
      expect(record.last("turn/start")).toBeDefined();
    } finally {
      await runtime.shutdown();
    }
  });

  it("does not let a cancelled request's late error cancel a newer prediction", async () => {
    const { record, runtime } = createContractRuntime({
      launch: {
        scripted: {
          promptSuggestionWaitForCancel: true,
          promptSuggestionLateCancelError: true,
        },
      },
    });
    const config = {
      ...fullRuntimeOptions,
      promptSuggestions: {
        automatic: false,
        prompt: "predict",
        sourceRequestId: "creq_23456789ab",
      },
    };
    let newerOutcome: Promise<unknown> | null = null;
    try {
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: config,
      });
      const old = runtime.requestPromptSuggestion({
        threadId: "t1",
        requestId: "old-prediction",
        sourceTurnId: "bb-completed-1",
        prompt: "predict",
        options: config,
      });
      const oldOutcome = old.catch((error: unknown) => error);
      await waitForRuntimeState({
        label: "old prediction started",
        timeoutMs: 1000,
        predicate: () =>
          record.last("thread/prompt-suggestion/request") !== undefined,
      });
      await runtime.cancelPromptSuggestion({
        threadId: "t1",
        requestId: "old-prediction",
      });
      newerOutcome = runtime
        .requestPromptSuggestion({
          threadId: "t1",
          requestId: "new-prediction",
          sourceTurnId: "bb-completed-1",
          prompt: "predict",
          options: config,
        })
        .catch((error: unknown) => error);
      await expect(oldOutcome).resolves.toMatchObject({
        message: expect.stringContaining("Late cancelled prediction error"),
      });
      await runtime.listModels({ providerId: "fake" });
      expect(
        record
          .read()
          .filter(({ method }) => method === "thread/prompt-suggestion/cancel"),
      ).toHaveLength(1);
      expect(
        record.last("thread/prompt-suggestion/cancel")?.params,
      ).toMatchObject({ requestId: "old-prediction" });
    } finally {
      if (newerOutcome) {
        await runtime.cancelPromptSuggestion({
          threadId: "t1",
          requestId: "new-prediction",
        });
        await newerOutcome;
      }
      await runtime.shutdown();
    }
  });

  it("passes runtime workspace-write roots to the provider as provider options", async () => {
    const additionalWorkspaceWriteRoots = [
      "/repo/.git/worktrees/bb13",
      "/repo/.git/objects",
    ];
    const { record, runtime } = createContractRuntime({
      additionalWorkspaceWriteRoots,
    });

    try {
      await runtime.listModels({ providerId: "fake" });
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      expect(record.last("model/list")?.params).toEqual({
        providerOptions: { additionalWorkspaceWriteRoots },
        envVars: {},
      });
      expect(record.last("thread/start")?.params).toMatchObject({
        threadId: "t1",
        cwd: tmpDir,
        options: { providerOptions: { additionalWorkspaceWriteRoots } },
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it("expands contributed provider environment for model list against the server URL", async () => {
    const { record, runtime } = createContractRuntime({
      shellEnv: { BB_SERVER_URL: "http://server.test" },
    });

    try {
      await runtime.listModels({
        providerId: "fake",
        contributedEnv: [
          {
            name: "CODEX_OPENAI_BASE_URL",
            value: { serverPath: "/pool/v1" },
            source: { plugin: "account-pool" },
            reason: "pooled",
          },
          {
            name: "CODEX_POOL_AUTH_TOKEN",
            value: "machine-token",
            source: { plugin: "account-pool" },
            reason: "pooled",
          },
        ],
      });

      expect(record.last("model/list")?.params).toMatchObject({
        envVars: {
          CODEX_OPENAI_BASE_URL: "http://server.test/pool/v1",
          CODEX_POOL_AUTH_TOKEN: "machine-token",
        },
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it("passes a provider's declared launch spec on model list, start, and resume", async () => {
    const { record, runtime } = createContractRuntime();
    const bridgeLaunch = createScriptedEchoLaunch({
      providerOptions: { acpLaunchSpec },
    });

    try {
      await runtime.listModels({ providerId: "acp-custom", bridgeLaunch });
      await runtime.startThread({
        bridgeLaunch,
        environmentId: "env-1",
        threadId: "t-start",
        projectId: "p1",
        providerId: "acp-custom",
        options: fullRuntimeOptions,
      });
      await runtime.resumeThread({
        bridgeLaunch,
        environmentId: "env-1",
        threadId: "t-resume",
        projectId: "p1",
        providerThreadId: "provider-resume",
        providerId: "acp-custom",
        options: fullRuntimeOptions,
      });

      expect(record.last("model/list")?.params).toEqual({
        providerOptions: { acpLaunchSpec },
        envVars: {},
      });
      expect(record.last("thread/start")?.params).toMatchObject({
        threadId: "t-start",
        options: { providerOptions: { acpLaunchSpec } },
      });
      expect(record.last("thread/resume")?.params).toMatchObject({
        threadId: "t-resume",
        providerThreadId: "provider-resume",
        options: { providerOptions: { acpLaunchSpec } },
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it("launches the caller's bridge for archive and unarchive", async () => {
    const { record, runtime } = createContractRuntime();
    const bridgeLaunch = createScriptedEchoLaunch({
      pluginId: "provider-graduated",
    });

    try {
      await runtime.archiveThread({
        bridgeLaunch,
        threadId: "t-archive-bridge",
        providerId: "graduated",
        providerThreadId: "provider-explicit",
      });
      await runtime.unarchiveThread({
        bridgeLaunch,
        threadId: "t-archive-bridge",
        providerId: "graduated",
        providerThreadId: "provider-explicit",
      });

      const requests = record.read();
      expect(
        requests.filter((entry) => entry.method === "initialize"),
      ).toHaveLength(2);
      expect(requests).toContainEqual({
        method: "thread/archive",
        params: {
          threadId: "t-archive-bridge",
          providerThreadId: "provider-explicit",
        },
      });
      expect(requests).toContainEqual({
        method: "thread/unarchive",
        params: {
          threadId: "t-archive-bridge",
          providerThreadId: "provider-explicit",
        },
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it("uses a new provider process cache entry when the declared launch spec changes", async () => {
    const { record, runtime } = createContractRuntime();

    try {
      await runtime.listModels({
        providerId: "acp-custom",
        bridgeLaunch: createScriptedEchoLaunch({
          providerOptions: {
            acpLaunchSpec: { ...acpLaunchSpec, env: { CACHE_MARKER: "first" } },
          },
        }),
      });
      await runtime.listModels({
        providerId: "acp-custom",
        bridgeLaunch: createScriptedEchoLaunch({
          providerOptions: {
            acpLaunchSpec: {
              ...acpLaunchSpec,
              env: { CACHE_MARKER: "second" },
            },
          },
        }),
      });

      const requests = record.read();
      expect(
        requests.filter((entry) => entry.method === "initialize"),
      ).toHaveLength(2);
      expect(
        requests
          .filter((entry) => entry.method === "model/list")
          .map((entry) => entry.params),
      ).toEqual([
        {
          providerOptions: {
            acpLaunchSpec: { ...acpLaunchSpec, env: { CACHE_MARKER: "first" } },
          },
          envVars: {},
        },
        {
          providerOptions: {
            acpLaunchSpec: {
              ...acpLaunchSpec,
              env: { CACHE_MARKER: "second" },
            },
          },
          envVars: {},
        },
      ]);
    } finally {
      await runtime.shutdown();
    }
  }, 30000);

  it("prefixes provider rename titles and normalizes provider title events", async () => {
    const events: ThreadEvent[] = [];
    const { record, runtime } = createContractRuntime({
      onEvent: (event) => events.push(event),
    });

    try {
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      await runtime.renameThread({ threadId: "t1", title: "New Title" });
      await waitForRuntimeThreadEvent({
        events,
        label: "normalized provider title event",
        predicate: (event) =>
          event.type === "thread/name/updated" &&
          event.threadId === "t1" &&
          event.threadName === "New Title",
        runtime,
        threadId: "t1",
      });

      expect(record.last("thread/name/set")?.params).toEqual({
        threadId: "t1",
        providerThreadId: "prov-1",
        title: "[bb] New Title",
      });
      expect(events).not.toContainEqual(
        expect.objectContaining({
          threadName: "[bb] New Title",
          type: "thread/name/updated",
        }),
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it("does not retry a rename: the bridge owns the not-ready-rollout ladder", async () => {
    const { record, runtime } = createContractRuntime({
      launch: {
        scripted: {
          failMethods: [
            {
              method: "thread/name/set",
              message: codexEmptyRolloutRenameError,
              times: 1,
            },
          ],
        },
      },
    });

    try {
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "codex",
        options: fullRuntimeOptions,
      });

      await expect(
        runtime.renameThread({ threadId: "t1", title: "New Title" }),
      ).rejects.toThrow(/rollout at .+ is empty/i);
      expect(
        record.read().filter((entry) => entry.method === "thread/name/set"),
      ).toHaveLength(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("rejects unsupported thread rename instead of silently succeeding", async () => {
    const { record, runtime } = createContractRuntime({
      launch: { capabilities: { supportsThreadRename: false } },
    });

    try {
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      await expect(
        runtime.renameThread({ threadId: "t1", title: "New Title" }),
      ).rejects.toThrow(/does not support thread rename/);
      expect(record.last("thread/name/set")).toBeUndefined();
    } finally {
      await runtime.shutdown();
    }
  });

  it.each([
    { reportedCleared: true, label: "confirms success" },
    { reportedCleared: false, label: "reconciles a stale failure" },
  ])(
    "$label after a provider persists a delayed Goal clear",
    async ({ reportedCleared }) => {
      const events: ThreadEvent[] = [];
      const { record, runtime } = createContractRuntime({
        onEvent: (event) => events.push(event),
        launch: {
          scripted: {
            goalClearNotifyDelayMs: 600,
            goalClearReportsCleared: reportedCleared,
          },
        },
      });

      try {
        await runtime.startThread({
          environmentId: "env-1",
          threadId: "t-goal",
          projectId: "p1",
          providerId: "fake",
          options: fullRuntimeOptions,
        });
        let settled = false;
        const clearPromise = runtime.clearThreadGoal({
          threadId: "t-goal",
        });
        void clearPromise.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );

        await vi.waitFor(() => {
          expect(record.last("thread/goal/clear")).toBeDefined();
        });
        await wait(100);
        expect(settled).toBe(false);

        await expect(clearPromise).resolves.toEqual({ cleared: true });
        expect(events).toContainEqual(
          expect.objectContaining({
            threadId: "t-goal",
            type: "thread/extensionState/updated",
            kind: "provider-codex/goal",
            payload: null,
          }),
        );
      } finally {
        await runtime.shutdown();
      }
    },
    10_000,
  );

  it("rejects thread resume when providerThreadId cannot be resolved", async () => {
    const { record, runtime } = createContractRuntime();

    await registerThreadWithoutProviderThreadId(runtime);
    expect(record.last("thread/resume")).toBeUndefined();
    await runtime.shutdown();
  });

  it("rejects turn start when providerThreadId cannot be resolved", async () => {
    const { record, runtime } = createContractRuntime();

    await registerThreadWithoutProviderThreadId(runtime);
    await expect(
      runtime.runTurn({
        clientRequestId: "creq_222222224t",
        threadId: missingProviderThreadId,
        input: [promptTextInput({ text: "hello" })],
        options: fullRuntimeOptions,
      }),
    ).rejects.toThrow(missingProviderThreadIdError);
    expect(record.last("turn/start")).toBeUndefined();
    await runtime.shutdown();
  });

  it("rejects thread rename when providerThreadId cannot be resolved", async () => {
    const { record, runtime } = createContractRuntime();

    await registerThreadWithoutProviderThreadId(runtime);
    await expect(
      runtime.renameThread({
        threadId: missingProviderThreadId,
        title: "New Title",
      }),
    ).rejects.toThrow(missingProviderThreadIdError);
    expect(record.last("thread/name/set")).toBeUndefined();
    await runtime.shutdown();
  });

  it("propagates a bridge's archive and unarchive rejections verbatim", async () => {
    const { record, runtime } = createContractRuntime({
      env: scriptedEchoProcessEnv({
        failMethods: [
          {
            method: "thread/archive",
            message: "no rollout found for thread id provider-explicit",
          },
          {
            method: "thread/unarchive",
            message:
              "no archived rollout found for thread id provider-explicit",
          },
        ],
      }),
    });
    const bridgeLaunch = createScriptedEchoLaunch();

    try {
      await expect(
        runtime.archiveThread({
          bridgeLaunch,
          threadId: "t-archive-rejected",
          providerId: "fake",
          providerThreadId: "provider-explicit",
        }),
      ).rejects.toThrow("no rollout found for thread id provider-explicit");
      await expect(
        runtime.unarchiveThread({
          bridgeLaunch,
          threadId: "t-archive-rejected",
          providerId: "fake",
          providerThreadId: "provider-explicit",
        }),
      ).rejects.toThrow(
        "no archived rollout found for thread id provider-explicit",
      );
      expect(record.last("thread/archive")).toBeDefined();
      expect(record.last("thread/unarchive")).toBeDefined();
    } finally {
      await runtime.shutdown();
    }
  });

  function createArchivedSessionRuntime(
    args: {
      env?: Record<string, string>;
      exitAfterArchivedError?: boolean;
    } = {},
  ): ContractRuntime {
    return createContractRuntime({
      ...(args.env !== undefined ? { env: args.env } : {}),
      launch: {
        scripted: {
          archivedSession: true,
          ...(args.exitAfterArchivedError === true
            ? { exitAfterArchivedError: true }
            : {}),
        },
      },
    });
  }

  it("unarchives Codex sessions before retrying a resume", async () => {
    const { record, runtime } = createArchivedSessionRuntime();

    try {
      await expect(
        runtime.resumeThread({
          environmentId: "env-1",
          projectId: "p1",
          providerId: "codex",
          providerThreadId: "prov-archived-resume",
          threadId: "t-archived-resume",
          options: fullRuntimeOptions,
        }),
      ).resolves.toEqual({ providerThreadId: "prov-archived-resume" });

      const requests = record.read();
      expect(requests).toContainEqual({
        method: "thread/unarchive",
        params: {
          threadId: "t-archived-resume",
          providerThreadId: "prov-archived-resume",
        },
      });
      expect(
        requests.filter((entry) => entry.method === "thread/resume"),
      ).toHaveLength(2);
    } finally {
      await runtime.shutdown();
    }
  });

  it("reports the archived-session error when unarchiving fails", async () => {
    const { record, runtime } = createArchivedSessionRuntime({
      env: scriptedEchoProcessEnv({ unarchiveFails: true }),
    });

    try {
      await expect(
        runtime.resumeThread({
          environmentId: "env-1",
          projectId: "p1",
          providerId: "codex",
          providerThreadId: "prov-unarchive-fails",
          threadId: "t-unarchive-fails",
          options: fullRuntimeOptions,
        }),
      ).rejects.toThrow(/session prov-unarchive-fails is archived/);
      const requests = record.read();
      expect(requests).toContainEqual({
        method: "thread/unarchive",
        params: {
          threadId: "t-unarchive-fails",
          providerThreadId: "prov-unarchive-fails",
        },
      });
      expect(
        requests.filter((entry) => entry.method === "thread/resume"),
      ).toHaveLength(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("keeps the archived-session error when the provider exits mid-recovery", async () => {
    const { runtime } = createArchivedSessionRuntime({
      exitAfterArchivedError: true,
    });

    try {
      await expect(
        runtime.resumeThread({
          environmentId: "env-1",
          projectId: "p1",
          providerId: "codex",
          providerThreadId: "prov-exit-recovery",
          threadId: "t-exit-recovery",
          options: fullRuntimeOptions,
        }),
      ).rejects.toThrow(/session prov-exit-recovery is archived/);
    } finally {
      await runtime.shutdown();
    }
  });

  it("rejects turn steer when providerThreadId cannot be resolved", async () => {
    const events: ThreadEvent[] = [];
    const { runtime } = createContractRuntime({
      onEvent: (event) => events.push(event),
      env: { [UNSOLICITED_TURN_THREAD_ID_ENV]: missingProviderThreadId },
      launch: {
        modulePath: unsolicitedTurnBridgeModulePath,
        pluginId: "provider-unsolicited-turn",
      },
    });

    await registerThreadWithoutProviderThreadId(runtime);
    const { turnId } = await waitForThreadTurnStarted({
      events,
      label: "synthetic active turn without provider identity",
      providerId: "fake",
      runtime,
      threadId: missingProviderThreadId,
      timeoutMs: 1000,
    });
    expect(runtime.getActiveTurnId(missingProviderThreadId)).toBe(turnId);
    await expect(
      runtime.steerTurn({
        clientRequestId: "creq_222222224u",
        threadId: missingProviderThreadId,
        expectedTurnId: turnId,
        input: [promptTextInput({ text: "steer" })],
        options: fullRuntimeOptions,
      }),
    ).rejects.toThrow(missingProviderThreadIdError);
    await runtime.shutdown();
  });

  it("rejects unsupported execution options before they reach the provider", async () => {
    const { record, runtime } = createContractRuntime();

    await expect(
      runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: {
          ...fullRuntimeOptions,
          serviceTier: "fast",
        },
      }),
    ).rejects.toThrow(/does not support service tiers/);
    expect(record.last("thread/start")).toBeUndefined();
    await runtime.shutdown();
  });

  it("interrupts an active turn on stop and releases an idle thread", async () => {
    const events: ThreadEvent[] = [];
    const { record, runtime } = createContractRuntime({
      onEvent: (event) => events.push(event),
    });

    const startResult = await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await expect(runtime.stopThread({ threadId: "t1" })).resolves.toEqual({
      providerCheckpointId: null,
    });
    expect(record.last("thread/stop")?.params).toEqual({
      threadId: "t1",
      providerThreadId: startResult.providerThreadId,
      intent: "release",
      activeTurnId: null,
    });

    expect(runtime.hasThread("t1")).toBe(false);
    await runtime.resumeThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerThreadId: startResult.providerThreadId,
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222224v",
      threadId: "t1",
      input: [promptTextInput({ text: "delay:500" })],
      options: fullRuntimeOptions,
    });
    const { turnId } = await waitForThreadTurnStarted({
      events,
      providerId: "fake",
      runtime,
      threadId: "t1",
    });
    await runtime.stopThread({ threadId: "t1" });
    expect(record.last("thread/stop")?.params).toEqual({
      threadId: "t1",
      providerThreadId: startResult.providerThreadId,
      intent: "interrupt",
      activeTurnId: "turn-1",
    });
    await waitForThreadTurnCompleted({
      events,
      providerId: "fake",
      runtime,
      threadId: "t1",
      turnId,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        threadId: "t1",
        status: "interrupted",
      }),
    );

    await runtime.shutdown();
  });
});

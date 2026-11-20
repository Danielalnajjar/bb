import { eq } from "drizzle-orm";
import {
  createQueuedThreadMessage,
  getLatestSessionForHost,
  getQueuedThreadMessage,
  getLatestThreadSequence,
  getThread,
  listQueuedThreadMessages,
  listThreadIdsWithHostOfflineQueueWaits,
  getAppSettings,
  insertThreadPluginMetadata,
  setAppSettings,
  setQueuedThreadMessageWaitingOn,
  threads,
} from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  RESTART_RESUME_METADATA_KEY,
  threadScope,
  turnRequestEventDataSchema,
  turnScope,
} from "@bb/domain";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  groupHostDaemonEvents,
} from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredPromise } from "@bb/test-helpers";
import type { PluginHookName } from "@get-bb/plugin-sdk";
import { handleDaemonSocketClosed } from "../../src/internal/session-owner-side-effects.js";
import {
  invokePluginInline,
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import {
  createAppUpdateSendHold,
  releaseSendsHeldAcrossRestart,
} from "../../src/services/system/app-update-send-hold.js";
import { moveThreadStatus } from "../helpers/thread-status.js";
import {
  attemptQueuedMessageNow,
  runQueuedMessageDispatch,
} from "../../src/services/threads/queued-message-dispatch.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { retryFailedTurn } from "../../src/services/threads/turn-retry.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import {
  internalAuthHeaders,
  registerTestHostRpcCapture,
} from "../helpers/commands.js";
import { createUserQuestionPayload } from "../helpers/pending-interactions.js";
import { textInput } from "../helpers/prompt-input.js";
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
import { listEvents } from "@bb/db/testing";

const HOST_ID = "host-restart";
const RESUMED_WHILE_WORKING = expect.stringContaining(
  "bb restarted while you were working. The restart cut off your turn, not the user, even if your history says the user rejected it.",
);
const WORKSPACE_PATH = "/tmp/restart-resume-project";

afterEach(() => {
  setPluginHookProvider(undefined);
  vi.useRealTimers();
});

function installDispatchHook(
  handler: PluginHookRegistration<"message.dispatch">["handler"],
) {
  const hooks: { [K in PluginHookName]?: PluginHookRegistration<K>[] } = {
    "message.dispatch": [{ pluginId: "limiter", handler }],
  };
  setPluginHookProvider({
    listHooks: (hook) => hooks[hook] ?? [],
    invokeHook: (_registration, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
}

function continueAfterRestarts(harness: TestAppHarness, enabled: boolean) {
  setAppSettings(harness.db, {
    ...getAppSettings(harness.db),
    resumeThreadsAfterRestart: enabled,
  });
}

function seedHostWithProject(harness: TestAppHarness) {
  const { host, session } = seedHostSession(harness.deps, { id: HOST_ID });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
  });
  return { environment, host, project, session };
}

type HostFixture = ReturnType<typeof seedHostWithProject>;

function seedRunningThread(
  harness: TestAppHarness,
  fixture: HostFixture,
  args: { parentThreadId?: string; text?: string; turnId?: string } = {},
) {
  const thread = seedThread(harness.deps, {
    environmentId: fixture.environment.id,
    projectId: fixture.project.id,
    status: "active",
    ...(args.parentThreadId === undefined
      ? {}
      : { parentThreadId: args.parentThreadId }),
  });
  const providerThreadId = `provider-${thread.id}`;
  seedThreadRuntimeState(harness.deps, {
    environmentId: fixture.environment.id,
    inputText: args.text ?? "Do the thing",
    providerThreadId,
    threadId: thread.id,
  });
  const turnId = args.turnId ?? `turn-${thread.id}`;
  seedTurnStarted(harness.deps, {
    environmentId: fixture.environment.id,
    providerThreadId,
    threadId: thread.id,
    turnId,
  });
  const requestId = lastTurnRequest(harness, thread.id).requestId;
  seedEvent(harness.deps, {
    threadId: thread.id,
    environmentId: fixture.environment.id,
    providerThreadId,
    sequence: getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
    type: "turn/input/accepted",
    scope: turnScope(turnId),
    data: { providerThreadId, clientRequestId: requestId },
  });
  return { providerThreadId, requestId, thread, turnId };
}

function seedNextEvent(
  harness: TestAppHarness,
  fixture: HostFixture,
  args: {
    data: Record<string, unknown>;
    providerThreadId: string;
    threadId: string;
    turnId: string;
    type: "item/started" | "item/completed";
  },
) {
  seedEvent(harness.deps, {
    threadId: args.threadId,
    environmentId: fixture.environment.id,
    providerThreadId: args.providerThreadId,
    sequence:
      getLatestThreadSequence(harness.db, { threadId: args.threadId }) + 1,
    type: args.type,
    scope: turnScope(args.turnId),
    data: { providerThreadId: args.providerThreadId, ...args.data },
  });
}

function commandItem(args: {
  command: string;
  id: string;
  status: "pending" | "completed";
}) {
  return {
    item: {
      type: "commandExecution",
      id: args.id,
      command: args.command,
      cwd: "",
      status: args.status,
      approvalStatus: null,
    },
  };
}

function seedBackgroundCommand(
  harness: TestAppHarness,
  fixture: HostFixture,
  running: ReturnType<typeof seedRunningThread>,
  args: { command: string; description: string; id: string },
) {
  const toolCallId = `${args.id}-tool`;
  const base = {
    providerThreadId: running.providerThreadId,
    threadId: running.thread.id,
    turnId: running.turnId,
  };
  seedNextEvent(harness, fixture, {
    ...base,
    type: "item/started",
    data: commandItem({
      command: args.command,
      id: toolCallId,
      status: "pending",
    }),
  });
  seedNextEvent(harness, fixture, {
    ...base,
    type: "item/started",
    data: {
      item: {
        type: "backgroundTask",
        id: args.id,
        taskType: "local_bash",
        description: args.description,
        status: "pending",
        taskStatus: "running",
        skipTranscript: false,
        foreground: false,
        parentToolCallId: toolCallId,
      },
    },
  });
  seedNextEvent(harness, fixture, {
    ...base,
    type: "item/completed",
    data: commandItem({
      command: args.command,
      id: toolCallId,
      status: "completed",
    }),
  });
}

function settleBackgroundCommand(
  harness: TestAppHarness,
  fixture: HostFixture,
  running: ReturnType<typeof seedRunningThread>,
  args: { description: string; id: string; ownerStopped: boolean },
) {
  seedEvent(harness.deps, {
    threadId: running.thread.id,
    environmentId: fixture.environment.id,
    providerThreadId: running.providerThreadId,
    sequence:
      getLatestThreadSequence(harness.db, { threadId: running.thread.id }) + 1,
    type: "item/backgroundTask/completed",
    scope: threadScope(),
    data: {
      providerThreadId: running.providerThreadId,
      item: {
        type: "backgroundTask",
        id: args.id,
        taskType: "local_bash",
        description: args.description,
        status: "interrupted",
        taskStatus: "stopped",
        skipTranscript: false,
        foreground: false,
        parentToolCallId: `${args.id}-tool`,
        ...(args.ownerStopped ? { ownerStopped: true } : {}),
      },
    },
  });
}

function finishTurn(harness: TestAppHarness, threadId: string) {
  moveThreadStatus(harness.deps, { move: "run.succeeded", threadId });
}

let instanceCounter = 0;

async function restartDaemon(
  harness: TestAppHarness,
  fixture: HostFixture,
  instanceId = `instance-restarted-${++instanceCounter}`,
): Promise<string> {
  const response = await harness.app.request("/internal/session/open", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId: fixture.host.id }),
    body: JSON.stringify({
      hostId: fixture.host.id,
      instanceId,
      hostName: "Test Host",
      hasMachineCredential: false,
      platform: "darwin",
      dataDir: `/tmp/bb-host-data/${fixture.host.id}`,
      localApiPort: null,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      activeThreads: [],
      openThreadWork: [],
    }),
  });
  expect(response.status).toBe(201);
  const { sessionId } = (await response.json()) as { sessionId: string };
  registerTestHostRpcCapture(harness.deps, {
    hostId: fixture.host.id,
    sessionId,
  });
  await runQueuedMessageDispatch(harness.deps, {
    kind: "host-connected",
    hostId: fixture.host.id,
  });
  return sessionId;
}

async function patchRestartResumeMetadata(
  harness: TestAppHarness,
  threadId: string,
  patch: { set?: Record<string, unknown>; remove?: string[] },
  pluginId = "crew",
) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/plugin-metadata`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pluginId, ...patch }),
    },
  );
  expect(response.status).toBe(200);
}

function seedParentForRestart(harness: TestAppHarness, fixture: HostFixture) {
  const parent = seedThread(harness.deps, {
    environmentId: fixture.environment.id,
    projectId: fixture.project.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: fixture.environment.id,
    inputText: "Delegate the work",
    providerThreadId: `provider-${parent.id}`,
    threadId: parent.id,
  });
  return parent;
}

function runDueWake(harness: TestAppHarness) {
  return runQueuedMessageDispatch(harness.deps, {
    kind: "time-reached",
    now: Date.now(),
  });
}

async function expectRestartDelivered(
  harness: TestAppHarness,
  threadId: string,
  requestId: string,
) {
  await vi.waitFor(() => {
    expect(turnRequests(harness, threadId)).toHaveLength(2);
    expect(lastTurnRequest(harness, threadId)).toMatchObject({
      retryOfRequestId: requestId,
      retryAttempt: 2,
    });
    expect(queue(harness, threadId)).toEqual([]);
  });
}

function turnRequests(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "client/turn/requested")
    .map((event) => turnRequestEventDataSchema.parse(JSON.parse(event.data)));
}

function lastTurnRequest(harness: TestAppHarness, threadId: string) {
  const last = turnRequests(harness, threadId).at(-1);
  if (last === undefined) throw new Error("expected a turn request");
  return last;
}

function requestTexts(harness: TestAppHarness, threadId: string): string[] {
  return turnRequests(harness, threadId).map((request) => {
    const block = request.input[0];
    return block?.type === "text" ? block.text : "";
  });
}

function queue(harness: TestAppHarness, threadId: string) {
  return listQueuedThreadMessages(harness.db, threadId).map(
    toThreadQueuedMessage,
  );
}

function threadStatus(harness: TestAppHarness, threadId: string) {
  return getThread(harness.db, threadId)?.status;
}

function interruptionErrors(
  harness: TestAppHarness,
  threadId: string,
): { detail: string; message: string }[] {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "system/error")
    .map((event) => {
      const { detail, message } = JSON.parse(event.data) as {
        detail: string;
        message: string;
      };
      return { detail, message };
    })
    .filter((data) => data.message.startsWith("Thread interrupted"));
}

function interruptionErrorDetails(
  harness: TestAppHarness,
  threadId: string,
): string[] {
  return interruptionErrors(harness, threadId).map((data) => data.detail);
}

async function sweepPastResume(harness: TestAppHarness): Promise<void> {
  await runQueuedMessageDispatch(harness.deps, {
    kind: "time-reached",
    now: Date.now() + 120_000,
  });
}

async function finishTurnAndDrain(
  harness: TestAppHarness,
  threadId: string,
): Promise<void> {
  moveThreadStatus(harness.deps, { move: "run.succeeded", threadId });
  await runQueuedMessageDispatch(harness.deps, {
    kind: "thread-ready",
    threadId,
  });
}

async function sendMessage(
  harness: TestAppHarness,
  args: {
    mode: "auto" | "queue-if-active";
    text: string;
    threadId: string;
  },
): Promise<void> {
  const thread = getThread(harness.db, args.threadId);
  if (thread === null) throw new Error("expected a thread");
  await acceptThreadSendRequest(harness.deps, {
    payload: { input: textInput(args.text), mode: args.mode },
    thread,
  });
}

function requireRetryPayload(
  row: ReturnType<typeof queue>[number] | undefined,
) {
  if (row?.payload.kind !== "retry") {
    throw new Error("expected a retry row");
  }
  return row.payload;
}

async function failWithScheduledRetryBehindAMessage(harness: TestAppHarness) {
  const fixture = seedHostWithProject(harness);
  const { requestId, thread } = seedRunningThread(harness, fixture);
  moveThreadStatus(harness.deps, { move: "run.failed", threadId: thread.id });
  const failed = getThread(harness.db, thread.id);
  if (failed === null) throw new Error("expected a thread");
  await acceptThreadSendRequest(harness.deps, {
    payload: {
      input: textInput("Also update the docs"),
      mode: "auto",
      sendAt: Date.now() + 30_000,
    },
    thread: failed,
  });
  await retryFailedTurn(harness.deps, {
    thread: failed,
    request: {
      turnRequestId: requestId,
      sendAt: Date.now() + 60_000,
      reason: "Rate limited",
    },
  });
  return thread;
}

describe("retries going first", () => {
  it("puts a retry ahead of messages queued before it, and holds them behind it, with the experiment on", async () => {
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const thread = await failWithScheduledRetryBehindAMessage(harness);

      expect(queue(harness, thread.id).map((row) => row.payload.kind)).toEqual([
        "retry",
        "inline",
      ]);

      await sweepPastResume(harness);

      expect(requestTexts(harness, thread.id)).toEqual([
        "Do the thing",
        "Please continue.",
      ]);
      const [held, ...rest] = queue(harness, thread.id);
      expect(rest).toEqual([]);
      expect(held?.waitingOn).toEqual({ kind: "thread-busy" });

      await finishTurnAndDrain(harness, thread.id);
      expect(requestTexts(harness, thread.id)).toEqual([
        "Do the thing",
        "Please continue.",
        "Also update the docs",
      ]);
    });
  });

  it("leaves retry order and holding as before with the experiment off", async () => {
    await withTestHarness(async (harness) => {
      const thread = await failWithScheduledRetryBehindAMessage(harness);

      expect(queue(harness, thread.id).map((row) => row.payload.kind)).toEqual([
        "inline",
        "retry",
      ]);

      await sweepPastResume(harness);

      expect(requestTexts(harness, thread.id)).toEqual([
        "Do the thing",
        "Also update the docs",
      ]);
    });
  });
});

describe("resuming threads after a restart", () => {
  it("does not plan a held child and tells the parent it was interrupted", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const parent = seedParentForRestart(harness, fixture);
      const { thread } = seedRunningThread(harness, fixture, {
        parentThreadId: parent.id,
      });
      await patchRestartResumeMetadata(harness, thread.id, {
        set: {
          [RESTART_RESUME_METADATA_KEY]: { hold: true, reason: "Paused" },
        },
      });

      await restartDaemon(harness, fixture);

      expect(queue(harness, thread.id)).toEqual([]);
      expect(turnRequests(harness, thread.id)).toHaveLength(1);
      expect(interruptionErrorDetails(harness, thread.id)).toEqual([
        "Please retry the thread to continue.",
      ]);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() =>
        expect(requestTexts(harness, parent.id).at(-1)).toContain(
          "was interrupted because its host daemon restarted",
        ),
      );
    });
  });

  it("does not enqueue a planned retry when the hold lands during interruption", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const parent = seedParentForRestart(harness, fixture);
      const { thread } = seedRunningThread(harness, fixture, {
        parentThreadId: parent.id,
      });
      const notifyThread = harness.deps.hub.notifyThread.bind(harness.deps.hub);
      let heldAfterPlan = false;
      const notify = vi
        .spyOn(harness.deps.hub, "notifyThread")
        .mockImplementation((threadId, changes, metadata) => {
          if (
            !heldAfterPlan &&
            threadId === thread.id &&
            interruptionErrorDetails(harness, threadId).includes(
              "bb will resume the thread shortly.",
            )
          ) {
            insertThreadPluginMetadata(harness.db, {
              threadId,
              pluginId: "crew",
              metadata: { [RESTART_RESUME_METADATA_KEY]: { hold: true } },
            });
            heldAfterPlan = true;
          }
          notifyThread(threadId, changes, metadata);
        });
      try {
        await restartDaemon(harness, fixture);
      } finally {
        notify.mockRestore();
      }
      expect(heldAfterPlan).toBe(true);
      expect(queue(harness, thread.id)).toEqual([]);
      expect(turnRequests(harness, thread.id)).toHaveLength(1);
      expect(queue(harness, parent.id)[0]?.content[0]).toMatchObject({
        text: expect.stringContaining(
          "was interrupted because its host daemon restarted",
        ),
      });
    });
  });

  it.each(["insert", "append"])(
    "blocks the inline %s when the hold lands during the hook",
    async (boundary) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      await withTestHarness(async (harness) => {
        continueAfterRestarts(harness, true);
        const fixture = seedHostWithProject(harness);
        const { thread } = seedRunningThread(harness, fixture);
        const initialTime = Date.now();
        const entered = createDeferredPromise<void>();
        const release = createDeferredPromise<void>();
        installDispatchHook(async (context) => {
          if (context.thread.id !== thread.id) return { action: "proceed" };
          expect(context.queuedMessages).toEqual([]);
          entered.resolve();
          await release.promise;
          return { action: "proceed" };
        });

        const restarting = restartDaemon(harness, fixture);
        try {
          await Promise.race([
            entered.promise,
            restarting.then(() => {
              throw new Error("The inline hook was not reached");
            }),
          ]);
          expect(interruptionErrorDetails(harness, thread.id)).toEqual([
            "bb will resume the thread shortly.",
          ]);
          expect(queue(harness, thread.id)).toEqual([]);
          if (boundary === "append") {
            const replacement = getLatestSessionForHost(harness.db, {
              hostId: fixture.host.id,
            });
            expect(replacement).toMatchObject({ status: "active" });
            if (replacement === null)
              throw new Error("Expected the replacement session");
            expect(replacement.id).not.toBe(fixture.session.id);
            registerTestHostRpcCapture(harness.deps, {
              hostId: fixture.host.id,
              sessionId: replacement.id,
            });
            expect(harness.hub.hasDaemonForHost(fixture.host.id)).toBe(true);
            vi.setSystemTime(initialTime + 5_001);
          }
          await patchRestartResumeMetadata(harness, thread.id, {
            set: { [RESTART_RESUME_METADATA_KEY]: { hold: true } },
          });
        } finally {
          release.resolve();
          await restarting;
        }
        expect(queue(harness, thread.id)).toEqual([]);
        expect(turnRequests(harness, thread.id)).toHaveLength(1);
      });
    },
  );

  it.each(["proceed", "undated wait", "dated wait"])(
    "preserves a due restart retry when a claimed hook returns %s after the hold",
    async (decision) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      await withTestHarness(async (harness) => {
        continueAfterRestarts(harness, true);
        const fixture = seedHostWithProject(harness);
        const { thread, requestId } = seedRunningThread(harness, fixture);
        const initialTime = Date.now();
        await restartDaemon(harness, fixture);
        const [row] = listQueuedThreadMessages(harness.db, thread.id);
        if (row?.sendAt == null)
          throw new Error("Expected a scheduled restart retry");
        expect(row.sendAt).toBe(initialTime + 5_000);
        expect(row.retryOfTurnRequestId).toBe(requestId);
        vi.setSystemTime(row.sendAt);

        const entered = createDeferredPromise<void>();
        const release = createDeferredPromise<void>();
        let attempts = 0;
        installDispatchHook(async (context) => {
          if (context.thread.id !== thread.id) return { action: "proceed" };
          attempts++;
          if (attempts !== 1) return { action: "proceed" };
          expect(context.queuedMessages.map((message) => message.id)).toEqual([
            row.id,
          ]);
          entered.resolve();
          await release.promise;
          switch (decision) {
            case "undated wait":
              return { action: "wait", reason: "At capacity" };
            case "dated wait":
              return {
                action: "wait",
                reason: "At capacity",
                sendAt: Date.now() + 60_000,
              };
            default:
              return { action: "proceed" };
          }
        });
        const sweeping = runDueWake(harness);
        try {
          await Promise.race([
            entered.promise,
            sweeping.then(() => {
              throw new Error("The due hook was not reached");
            }),
          ]);
          expect(getQueuedThreadMessage(harness.db, row.id)).toMatchObject({
            state: "claimed",
            claimToken: expect.any(String),
          });
          await patchRestartResumeMetadata(harness, thread.id, {
            set: { [RESTART_RESUME_METADATA_KEY]: { hold: true } },
          });
        } finally {
          release.resolve();
          await sweeping;
        }
        expect(turnRequests(harness, thread.id)).toHaveLength(1);
        expect(getQueuedThreadMessage(harness.db, row.id)).toEqual({
          ...row,
          updatedAt: Date.now(),
        });
        await runDueWake(harness);
        expect(attempts).toBe(1);

        await patchRestartResumeMetadata(harness, thread.id, {
          set: { [RESTART_RESUME_METADATA_KEY]: { hold: false } },
        });
        await expectRestartDelivered(harness, thread.id, requestId);
        await runDueWake(harness);
        expect(attempts).toBe(2);
        expect(turnRequests(harness, thread.id)).toHaveLength(2);
      });
    },
  );

  it("reoffers only on last clear inside the plugin pacing window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const { requestId, thread } = seedRunningThread(harness, fixture);
      await restartDaemon(harness, fixture);
      const [row] = listQueuedThreadMessages(harness.db, thread.id);
      if (row?.sendAt == null)
        throw new Error("Expected a scheduled restart retry");
      vi.setSystemTime(row.sendAt);
      let attempts = 0;
      const reofferedAt = createDeferredPromise<number>();
      installDispatchHook((context) => {
        expect(context.queuedMessages.map((message) => message.id)).toEqual([
          row.id,
        ]);
        if (++attempts === 1) return { action: "wait", reason: "At capacity" };
        reofferedAt.resolve(Date.now());
        return { action: "proceed" };
      });
      await runDueWake(harness);
      const requeued = getQueuedThreadMessage(harness.db, row.id);
      expect(requeued).toMatchObject({
        state: "waiting",
        waitHolder: "plugin:limiter",
        sendAt: null,
        retryOfTurnRequestId: requestId,
      });
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
      expect(attempts).toBe(1);

      const hold = { set: { [RESTART_RESUME_METADATA_KEY]: { hold: true } } };
      await patchRestartResumeMetadata(harness, thread.id, hold);
      await patchRestartResumeMetadata(
        harness,
        thread.id,
        hold,
        "other-plugin",
      );
      await attemptQueuedMessageNow(harness.deps, row);
      const clear = { remove: [RESTART_RESUME_METADATA_KEY] };
      await patchRestartResumeMetadata(harness, thread.id, clear);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(attempts).toBe(1);
      expect(getQueuedThreadMessage(harness.db, row.id)).toEqual(requeued);

      await patchRestartResumeMetadata(
        harness,
        thread.id,
        clear,
        "other-plugin",
      );
      expect(await reofferedAt.promise).toBe(row.sendAt);
      await expectRestartDelivered(harness, thread.id, requestId);
      expect(attempts).toBe(2);
    });
  });

  it("reoffers an offline restart retry on release after a held reconnect", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const { thread, requestId } = seedRunningThread(harness, fixture);
      const instanceId = "replacement-daemon";
      vi.setSystemTime(Date.now() + 1);
      const sessionId = await restartDaemon(harness, fixture, instanceId);
      const [retry] = listQueuedThreadMessages(harness.db, thread.id);
      if (retry?.sendAt == null)
        throw new Error("Expected a scheduled restart retry");
      expect(retry.retryOfTurnRequestId).toBe(requestId);

      handleDaemonSocketClosed(harness.deps, { sessionId });
      expect(harness.hub.hasDaemonForHost(fixture.host.id)).toBe(false);
      vi.setSystemTime(retry.sendAt);
      await runDueWake(harness);
      const parked = getQueuedThreadMessage(harness.db, retry.id);
      expect(parked).toMatchObject({
        state: "waiting",
        sendAt: null,
        claimToken: null,
        retryOfTurnRequestId: requestId,
      });
      expect(queue(harness, thread.id)).toMatchObject([
        { id: retry.id, waitingOn: { kind: "host-offline" } },
      ]);
      expect(
        listThreadIdsWithHostOfflineQueueWaits(harness.db, fixture.host.id),
      ).toEqual([thread.id]);

      await patchRestartResumeMetadata(harness, thread.id, {
        set: { [RESTART_RESUME_METADATA_KEY]: { hold: true } },
      });
      const offers: string[][] = [];
      installDispatchHook((context) => {
        offers.push(context.queuedMessages.map(({ id }) => id));
        return { action: "proceed" };
      });
      await restartDaemon(harness, fixture, instanceId);
      expect(harness.hub.hasDaemonForHost(fixture.host.id)).toBe(true);
      expect(getQueuedThreadMessage(harness.db, retry.id)).toEqual(parked);
      expect(turnRequests(harness, thread.id)).toHaveLength(1);
      expect(offers).toEqual([]);

      await patchRestartResumeMetadata(harness, thread.id, {
        remove: [RESTART_RESUME_METADATA_KEY],
      });
      await expectRestartDelivered(harness, thread.id, requestId);
      expect(offers).toEqual([[retry.id]]);
    });
  });

  it("leaves an archived thread's offline restart retry untouched when the hold clears", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setImmediate", "clearImmediate"] });
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const { thread } = seedRunningThread(harness, fixture);
      const instanceId = "replacement-daemon";
      vi.setSystemTime(Date.now() + 1);
      const sessionId = await restartDaemon(harness, fixture, instanceId);
      const [retry] = listQueuedThreadMessages(harness.db, thread.id);
      if (retry?.sendAt == null)
        throw new Error("Expected a scheduled restart retry");
      await patchRestartResumeMetadata(harness, thread.id, {
        set: { [RESTART_RESUME_METADATA_KEY]: { hold: true } },
      });

      handleDaemonSocketClosed(harness.deps, { sessionId });
      expect(harness.hub.hasDaemonForHost(fixture.host.id)).toBe(false);
      vi.setSystemTime(retry.sendAt);
      const parked = setQueuedThreadMessageWaitingOn(harness.db, harness.hub, {
        id: retry.id,
        threadId: thread.id,
        waitingOn: { kind: "host-offline", hostName: fixture.host.name },
        sendAt: null,
      });
      expect(parked).toMatchObject({ state: "waiting", sendAt: null });
      const offeredThreadIds: string[] = [];
      installDispatchHook((context) => {
        offeredThreadIds.push(context.thread.id);
        return { action: "proceed" };
      });
      await restartDaemon(harness, fixture, instanceId);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.hub.hasDaemonForHost(fixture.host.id)).toBe(true);
      expect(getQueuedThreadMessage(harness.db, retry.id)).toEqual(parked);

      const archived = await harness.app.request(
        `/api/v1/threads/${thread.id}/archive-all`,
        { method: "POST" },
      );
      expect(archived.status, await archived.text()).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBe(Date.now());
      vi.setSystemTime(Date.now() + 1);

      await patchRestartResumeMetadata(harness, thread.id, {
        remove: [RESTART_RESUME_METADATA_KEY],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(getQueuedThreadMessage(harness.db, retry.id)).toEqual(parked);
      expect(turnRequests(harness, thread.id)).toHaveLength(1);
      expect(offeredThreadIds).not.toContain(thread.id);
    });
  });

  it("lets Send now override a restart hold", async () => {
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const { requestId, thread } = seedRunningThread(harness, fixture);
      await restartDaemon(harness, fixture);
      const [row] = queue(harness, thread.id);
      if (row === undefined) throw new Error("Expected a restart retry");
      await patchRestartResumeMetadata(harness, thread.id, {
        set: { [RESTART_RESUME_METADATA_KEY]: { hold: true } },
      });
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${row.id}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "auto" }),
        },
      );
      expect(response.status).toBe(200);
      await expectRestartDelivered(harness, thread.id, requestId);
    });
  });

  it("does not make other due work wait behind a held restart retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const { thread } = seedRunningThread(harness, fixture);
      await restartDaemon(harness, fixture);
      const [resume] = queue(harness, thread.id);
      if (resume?.sendAt == null)
        throw new Error("Expected a scheduled restart retry");
      await patchRestartResumeMetadata(harness, thread.id, {
        set: { [RESTART_RESUME_METADATA_KEY]: { hold: true } },
      });
      const dueAt = resume.sendAt + 100;
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            input: textInput("Take the new instruction"),
            mode: "auto",
            sendAt: dueAt,
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(queue(harness, thread.id)).toMatchObject([
        { id: resume.id },
        {
          payload: { kind: "inline" },
          sendAt: dueAt,
          waitingOn: { kind: "time" },
        },
      ]);
      vi.setSystemTime(dueAt);
      await runDueWake(harness);
      expect(requestTexts(harness, thread.id)).toEqual([
        "Do the thing",
        "Take the new instruction",
      ]);
      expect(
        lastTurnRequest(harness, thread.id).retryOfRequestId,
      ).toBeUndefined();
    });
  });

  it("reports a normal child interruption without altering its existing retry", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const parent = seedParentForRestart(harness, fixture);
      const { thread } = seedRunningThread(harness, fixture, {
        parentThreadId: parent.id,
      });
      const existing = createQueuedThreadMessage(harness.db, harness.deps.hub, {
        threadId: thread.id,
        content: textInput("Retry the earlier request"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        payload: {
          kind: "retry",
          retryOfTurnRequestId: encodeClientTurnRequestIdNumber({ value: 7 }),
          attempt: 2,
          reason: "Rate limited",
        },
        waitingOn: {
          kind: "plugin",
          pluginId: "limiter",
          reason: "At capacity",
        },
        sendAt: Date.now() + 60_000,
        systemNotice: null,
      });

      await vi.advanceTimersByTimeAsync(1);
      await restartDaemon(harness, fixture);

      expect(interruptionErrorDetails(harness, thread.id)).toEqual([
        "Please retry the thread to continue.",
      ]);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() =>
        expect(requestTexts(harness, parent.id).at(-1)).toContain(
          "was interrupted because its host daemon restarted",
        ),
      );
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([
        existing,
      ]);
      expect(turnRequests(harness, thread.id)).toHaveLength(1);
    });
  });

  it("adds the receipt line only for receipt-backed threads and ignores corrupt records", async () => {
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const receipt = seedRunningThread(harness, fixture).thread;
      const plain = seedRunningThread(harness, fixture).thread;
      await patchRestartResumeMetadata(harness, receipt.id, {
        set: {
          [RESTART_RESUME_METADATA_KEY]: { hold: false, receiptBacked: true },
        },
      });
      await patchRestartResumeMetadata(harness, plain.id, {
        set: {
          [RESTART_RESUME_METADATA_KEY]: { hold: false, receiptBacked: false },
        },
      });
      await patchRestartResumeMetadata(
        harness,
        plain.id,
        {
          set: {
            [RESTART_RESUME_METADATA_KEY]: {
              hold: true,
              receiptBacked: "not a boolean",
            },
          },
        },
        "corrupt-plugin",
      );
      const warn = vi.spyOn(harness.deps.logger, "warn");
      try {
        await restartDaemon(harness, fixture);
        const [withReceipt] = queue(harness, receipt.id);
        const [withoutReceipt] = queue(harness, plain.id);
        expect(withReceipt?.content[0]).toMatchObject({
          text: expect.stringContaining(
            "check `git status` and the receipt named in your existing instructions",
          ),
        });
        expect(withoutReceipt?.content[0]).toMatchObject({
          text: RESUMED_WHILE_WORKING,
        });
        expect(withoutReceipt?.content[0]).not.toMatchObject({
          text: expect.stringContaining("git status"),
        });
        expect(warn).toHaveBeenCalledWith(
          { threadId: plain.id, pluginId: "corrupt-plugin" },
          "Ignoring invalid restart resume metadata",
        );
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("queues a resume for a turn a daemon restart cut off, then resumes it", async () => {
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const { requestId, thread } = seedRunningThread(harness, fixture);

      await restartDaemon(harness, fixture);

      expect(threadStatus(harness, thread.id)).toBe("error");
      expect(interruptionErrors(harness, thread.id)).toEqual([
        {
          message: "Thread interrupted because bb restarted",
          detail: "bb will resume the thread shortly.",
        },
      ]);
      const [resume, ...rest] = queue(harness, thread.id);
      expect(rest).toEqual([]);
      expect(requireRetryPayload(resume)).toEqual({
        kind: "retry",
        retryOfTurnRequestId: requestId,
        attempt: 2,
        reason: "bb restarted",
      });
      expect(resume?.waitingOn).toEqual({ kind: "time" });
      expect(resume?.sendAt).toBeGreaterThan(Date.now());

      await sweepPastResume(harness);

      expect(threadStatus(harness, thread.id)).toBe("active");
      expect(queue(harness, thread.id)).toEqual([]);
      expect(lastTurnRequest(harness, thread.id)).toMatchObject({
        retryOfRequestId: requestId,
        retryAttempt: 2,
        input: [
          expect.objectContaining({
            text: RESUMED_WHILE_WORKING,
            visibility: "agent-only",
          }),
        ],
      });
    });
  });

  it.each(["queue-if-active", "auto"] as const)(
    "sends messages sent with mode %s during the restart after the resume, in order",
    async (mode) => {
      await withTestHarness(async (harness) => {
        continueAfterRestarts(harness, true);
        const fixture = seedHostWithProject(harness);
        const { thread } = seedRunningThread(harness, fixture);

        handleDaemonSocketClosed(harness.deps, {
          sessionId: fixture.session.id,
        });
        await sendMessage(harness, {
          mode,
          text: "First follow-up",
          threadId: thread.id,
        });
        await sendMessage(harness, {
          mode,
          text: "Second follow-up",
          threadId: thread.id,
        });
        await restartDaemon(harness, fixture);
        await runQueuedMessageDispatch(harness.deps, {
          kind: "thread-ready",
          threadId: thread.id,
        });

        expect(requestTexts(harness, thread.id)).toEqual(["Do the thing"]);
        expect(
          queue(harness, thread.id).map((row) => row.payload.kind),
        ).toEqual(["retry", "inline", "inline"]);

        await sweepPastResume(harness);
        await finishTurnAndDrain(harness, thread.id);
        await finishTurnAndDrain(harness, thread.id);

        expect(requestTexts(harness, thread.id)).toEqual([
          "Do the thing",
          RESUMED_WHILE_WORKING,
          "First follow-up",
          "Second follow-up",
        ]);
        expect(queue(harness, thread.id)).toEqual([]);
      });
    },
  );

  it("drops a pending resume when the user sends a message first", async () => {
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const { thread } = seedRunningThread(harness, fixture);

      await restartDaemon(harness, fixture);
      expect(queue(harness, thread.id).map((row) => row.payload.kind)).toEqual([
        "retry",
      ]);

      await sendMessage(harness, {
        mode: "auto",
        text: "Actually, do this instead",
        threadId: thread.id,
      });
      await sweepPastResume(harness);

      expect(requestTexts(harness, thread.id)).toEqual([
        "Do the thing",
        "Actually, do this instead",
      ]);
      expect(queue(harness, thread.id)).toEqual([]);
    });
  });

  it("resumes only turns the restart cut: not a manual stop, a pending question, or an archived thread", async () => {
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const running = seedRunningThread(harness, fixture);
      const stopped = seedRunningThread(harness, fixture);
      moveThreadStatus(harness.deps, {
        move: "stop.requested",
        threadId: stopped.thread.id,
      });
      const asking = seedRunningThread(harness, fixture);
      const registered =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: asking.thread.id,
            turnId: asking.turnId,
            providerId: "codex",
            providerThreadId: asking.providerThreadId,
            providerRequestId: "question-1",
            payload: createUserQuestionPayload(),
          },
        });
      expect(registered.outcome).not.toBe("rejected");
      const archived = seedRunningThread(harness, fixture);
      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, archived.thread.id))
        .run();

      await restartDaemon(harness, fixture);
      await sweepPastResume(harness);

      expect(requestTexts(harness, running.thread.id)).toEqual([
        "Do the thing",
        RESUMED_WHILE_WORKING,
      ]);
      for (const other of [stopped, asking, archived]) {
        expect(queue(harness, other.thread.id)).toEqual([]);
        expect(requestTexts(harness, other.thread.id)).toEqual([
          "Do the thing",
        ]);
      }
      expect(threadStatus(harness, stopped.thread.id)).toBe("idle");
      expect(threadStatus(harness, asking.thread.id)).toBe("error");
      expect(interruptionErrorDetails(harness, asking.thread.id)).toEqual([
        "Please retry the thread to continue.",
      ]);
    });
  });

  it("wakes an idle thread whose background command the restart stopped, naming the command", async () => {
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const waiting = seedRunningThread(harness, fixture, {
        text: "Run the migration",
      });
      seedBackgroundCommand(harness, fixture, waiting, {
        command: "./migrate.sh",
        description: "Run database migration",
        id: "task-migrate",
      });
      finishTurn(harness, waiting.thread.id);
      const quiet = seedRunningThread(harness, fixture);
      finishTurn(harness, quiet.thread.id);
      const archived = seedRunningThread(harness, fixture);
      seedBackgroundCommand(harness, fixture, archived, {
        command: "./archived.sh",
        description: "Archived job",
        id: "task-archived",
      });
      finishTurn(harness, archived.thread.id);
      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, archived.thread.id))
        .run();
      expect(threadStatus(harness, waiting.thread.id)).toBe("idle");

      await restartDaemon(harness, fixture);

      expect(requireRetryPayload(queue(harness, waiting.thread.id)[0])).toEqual(
        {
          kind: "retry",
          retryOfTurnRequestId: waiting.requestId,
          attempt: 2,
          reason: "bb restarted",
        },
      );
      expect(interruptionErrors(harness, waiting.thread.id)).toEqual([]);

      await sweepPastResume(harness);

      expect(threadStatus(harness, waiting.thread.id)).toBe("active");
      expect(lastTurnRequest(harness, waiting.thread.id)).toMatchObject({
        retryOfRequestId: waiting.requestId,
        retryAttempt: 2,
        input: [
          {
            type: "text",
            visibility: "agent-only",
            text: [
              "[bb system]",
              "",
              "bb restarted and may have stopped this background work: `./migrate.sh` (Run database migration). The user didn't stop it. Check whether it's still running and how far it got, then restart it only if that is safe.",
            ].join("\n"),
          },
        ],
      });
      for (const other of [quiet, archived]) {
        expect(queue(harness, other.thread.id)).toEqual([]);
        expect(turnRequests(harness, other.thread.id)).toHaveLength(1);
      }
    });
  });

  it("wakes an idle thread whose background command the daemon stopped as it shut down, once", async () => {
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const waiting = seedRunningThread(harness, fixture);
      seedBackgroundCommand(harness, fixture, waiting, {
        command: "gh pr checks 7131 --watch",
        description: "Wait for CI",
        id: "task-ci",
      });
      finishTurn(harness, waiting.thread.id);
      settleBackgroundCommand(harness, fixture, waiting, {
        description: "Wait for CI",
        id: "task-ci",
        ownerStopped: true,
      });

      await restartDaemon(harness, fixture);
      await sweepPastResume(harness);

      expect(requestTexts(harness, waiting.thread.id).at(-1)).toBe(
        [
          "[bb system]",
          "",
          "bb restarted and may have stopped this background work: `gh pr checks 7131 --watch` (Wait for CI). The user didn't stop it. Check whether it's still running and how far it got, then restart it only if that is safe.",
        ].join("\n"),
      );

      await finishTurnAndDrain(harness, waiting.thread.id);
      await restartDaemon(harness, fixture);
      await sweepPastResume(harness);

      expect(turnRequests(harness, waiting.thread.id)).toHaveLength(2);
      expect(queue(harness, waiting.thread.id)).toEqual([]);
    });
  });

  it("leaves an idle thread alone when its background command was stopped by the agent or the user", async () => {
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const waiting = seedRunningThread(harness, fixture);
      seedBackgroundCommand(harness, fixture, waiting, {
        command: "pnpm dev",
        description: "Dev server",
        id: "task-dev",
      });
      settleBackgroundCommand(harness, fixture, waiting, {
        description: "Dev server",
        id: "task-dev",
        ownerStopped: false,
      });
      finishTurn(harness, waiting.thread.id);

      await restartDaemon(harness, fixture);
      await sweepPastResume(harness);

      expect(queue(harness, waiting.thread.id)).toEqual([]);
      expect(turnRequests(harness, waiting.thread.id)).toHaveLength(1);
    });
  });

  it("lists several stopped background jobs one per line, naming at most ten", async () => {
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const waiting = seedRunningThread(harness, fixture);
      for (let index = 1; index <= 12; index += 1) {
        seedBackgroundCommand(harness, fixture, waiting, {
          command: `./job-${index}.sh`,
          description: `Job ${index}`,
          id: `task-${index}`,
        });
      }
      finishTurn(harness, waiting.thread.id);

      await restartDaemon(harness, fixture);
      await sweepPastResume(harness);

      expect(requestTexts(harness, waiting.thread.id).at(-1)).toBe(
        [
          "[bb system]",
          "",
          "bb restarted and may have stopped this background work:",
          ...Array.from(
            { length: 10 },
            (_, index) => `- \`./job-${index + 1}.sh\` (Job ${index + 1})`,
          ),
          "- and 2 more",
          "",
          "The user didn't stop them. Check whether each is still running and how far it got, then restart each only if that is safe.",
        ].join("\n"),
      );
    });
  });

  it("leaves an idle thread whose background command the restart stopped alone while the experiment is off", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedHostWithProject(harness);
      const waiting = seedRunningThread(harness, fixture);
      seedBackgroundCommand(harness, fixture, waiting, {
        command: "./migrate.sh",
        description: "Run database migration",
        id: "task-migrate",
      });
      finishTurn(harness, waiting.thread.id);

      await restartDaemon(harness, fixture);
      await sweepPastResume(harness);

      expect(threadStatus(harness, waiting.thread.id)).toBe("idle");
      expect(queue(harness, waiting.thread.id)).toEqual([]);
      expect(turnRequests(harness, waiting.thread.id)).toHaveLength(1);
    });
  });

  it("names the command a cut turn was running and the background work the restart stopped", async () => {
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const running = seedRunningThread(harness, fixture);
      seedBackgroundCommand(harness, fixture, running, {
        command: "pnpm dev",
        description: "Start the dev server",
        id: "task-dev",
      });
      seedNextEvent(harness, fixture, {
        providerThreadId: running.providerThreadId,
        threadId: running.thread.id,
        turnId: running.turnId,
        type: "item/started",
        data: commandItem({
          command: "pnpm db:migrate",
          id: "foreground-migrate",
          status: "pending",
        }),
      });

      await restartDaemon(harness, fixture);
      await sweepPastResume(harness);

      expect(requestTexts(harness, running.thread.id).at(-1)).toBe(
        [
          "[bb system]",
          "",
          "bb restarted while you were running `pnpm db:migrate`. The restart cut it off, not the user, even if your history says the user rejected it. Check what it finished, then continue the task, rerunning it only if that is safe. It also stopped this background work: `pnpm dev` (Start the dev server). Check how far it got, and restart it only if that is safe.",
        ].join("\n"),
      );
    });
  });

  it("stops resuming a turn after three restarts in a row cut it off", async () => {
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const { requestId, thread } = seedRunningThread(harness, fixture);

      for (const attempt of [2, 3, 4]) {
        await restartDaemon(harness, fixture);
        await sweepPastResume(harness);
        expect(lastTurnRequest(harness, thread.id)).toMatchObject({
          retryOfRequestId: requestId,
          retryAttempt: attempt,
        });
        expect(threadStatus(harness, thread.id)).toBe("active");
      }

      await restartDaemon(harness, fixture);
      await sweepPastResume(harness);

      expect(threadStatus(harness, thread.id)).toBe("error");
      expect(queue(harness, thread.id)).toEqual([]);
      expect(turnRequests(harness, thread.id)).toHaveLength(4);
      expect(interruptionErrorDetails(harness, thread.id).at(-1)).toBe(
        "Please retry the thread to continue.",
      );
    });
  });

  it("leaves cut threads in error while the experiment is off", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedHostWithProject(harness);
      const first = seedRunningThread(harness, fixture);

      await restartDaemon(harness, fixture);
      await sweepPastResume(harness);

      expect(threadStatus(harness, first.thread.id)).toBe("error");
      expect(queue(harness, first.thread.id)).toEqual([]);
      expect(requestTexts(harness, first.thread.id)).toEqual(["Do the thing"]);
      expect(interruptionErrorDetails(harness, first.thread.id)).toEqual([
        "Please retry the thread to continue.",
      ]);

      continueAfterRestarts(harness, true);
      const second = seedRunningThread(harness, fixture);
      await restartDaemon(harness, fixture);
      await sweepPastResume(harness);

      expect(requestTexts(harness, first.thread.id)).toEqual(["Do the thing"]);
      expect(requestTexts(harness, second.thread.id)).toEqual([
        "Do the thing",
        RESUMED_WHILE_WORKING,
      ]);
    });
  });

  it("tells the parent nothing when a child resumes, and tells it when the child finishes", async () => {
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const parent = seedThread(harness.deps, {
        environmentId: fixture.environment.id,
        projectId: fixture.project.id,
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: fixture.environment.id,
        inputText: "Delegate the work",
        providerThreadId: `provider-${parent.id}`,
        threadId: parent.id,
      });
      const child = seedRunningThread(harness, fixture, {
        parentThreadId: parent.id,
      });

      const sessionId = await restartDaemon(harness, fixture);
      await sweepPastResume(harness);

      expect(threadStatus(harness, child.thread.id)).toBe("active");
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(queue(harness, parent.id)).toEqual([]);
      expect(
        turnRequests(harness, parent.id).map((request) => request.initiator),
      ).toEqual(["user"]);

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: fixture.host.id }),
        body: JSON.stringify({
          sessionId,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: child.thread.id,
              event: {
                type: "turn/started",
                threadId: child.thread.id,
                providerThreadId: child.providerThreadId,
                scope: turnScope("resumed-turn"),
              },
            },
            {
              threadId: child.thread.id,
              event: {
                type: "turn/completed",
                threadId: child.thread.id,
                providerThreadId: child.providerThreadId,
                scope: turnScope("resumed-turn"),
                status: "completed",
              },
            },
          ]),
        }),
      });
      expect(response.status).toBe(200);

      await vi.waitFor(
        () =>
          expect(
            turnRequests(harness, parent.id).map(
              (request) => request.initiator,
            ),
          ).toEqual(["user", "system"]),
        { timeout: 10_000 },
      );
    });
  });
});

describe("holding sends while bb restarts to update", () => {
  function seedIdleThread(harness: TestAppHarness, fixture: HostFixture) {
    const seeded = seedRunningThread(harness, fixture);
    moveThreadStatus(harness.deps, {
      move: "run.succeeded",
      threadId: seeded.thread.id,
    });
    return seeded;
  }

  function waits(harness: TestAppHarness, threadId: string) {
    return queue(harness, threadId).map((row) => row.waitingOn?.kind ?? null);
  }

  it("holds a send while the restart is pending and sends it at once when the update is called off", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedHostWithProject(harness);
      const { thread } = seedIdleThread(harness, fixture);
      const sendHold = createAppUpdateSendHold(harness.deps);

      sendHold.hold();
      await sendMessage(harness, {
        mode: "auto",
        text: "Held follow-up",
        threadId: thread.id,
      });

      expect(requestTexts(harness, thread.id)).toEqual(["Do the thing"]);
      expect(waits(harness, thread.id)).toEqual(["app-update"]);

      sendHold.release();

      await vi.waitFor(() =>
        expect(requestTexts(harness, thread.id)).toEqual([
          "Do the thing",
          "Held follow-up",
        ]),
      );
      expect(queue(harness, thread.id)).toEqual([]);
    });
  });

  it("sends held messages after the restart, behind the resume, in order", async () => {
    await withTestHarness(async (harness) => {
      continueAfterRestarts(harness, true);
      const fixture = seedHostWithProject(harness);
      const running = seedRunningThread(harness, fixture);
      const idle = seedIdleThread(harness, fixture);

      createAppUpdateSendHold(harness.deps).hold();
      await sendMessage(harness, {
        mode: "auto",
        text: "First follow-up",
        threadId: running.thread.id,
      });
      await sendMessage(harness, {
        mode: "queue-if-active",
        text: "Second follow-up",
        threadId: running.thread.id,
      });
      await sendMessage(harness, {
        mode: "auto",
        text: "Idle follow-up",
        threadId: idle.thread.id,
      });
      expect(waits(harness, running.thread.id)).toEqual([
        "app-update",
        "app-update",
      ]);
      expect(waits(harness, idle.thread.id)).toEqual(["app-update"]);

      handleDaemonSocketClosed(harness.deps, {
        sessionId: fixture.session.id,
      });
      releaseSendsHeldAcrossRestart(harness.deps);
      await vi.waitFor(() =>
        expect([
          ...waits(harness, running.thread.id),
          ...waits(harness, idle.thread.id),
        ]).not.toContain("app-update"),
      );
      await restartDaemon(harness, fixture);

      expect(requestTexts(harness, idle.thread.id)).toEqual([
        "Do the thing",
        "Idle follow-up",
      ]);
      expect(
        queue(harness, running.thread.id).map((row) => row.payload.kind),
      ).toEqual(["retry", "inline", "inline"]);

      await sweepPastResume(harness);
      await finishTurnAndDrain(harness, running.thread.id);
      await finishTurnAndDrain(harness, running.thread.id);

      expect(requestTexts(harness, running.thread.id)).toEqual([
        "Do the thing",
        RESUMED_WHILE_WORKING,
        "First follow-up",
        "Second follow-up",
      ]);
      expect(queue(harness, running.thread.id)).toEqual([]);
    });
  });
});

import {
  claimQueuedThreadMessageGroup,
  getQueuedThreadMessage,
  getThread,
  listQueuedThreadMessages,
} from "@bb/db";
import { listEvents } from "@bb/db/testing";
import { turnRequestEventDataSchema, turnScope } from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { threadQueuedMessageListResponseSchema } from "@bb/server-contract";
import { createDeferredPromise } from "@bb/test-helpers";
import type { PluginHookName } from "@get-bb/plugin-sdk";
import { afterEach, expect, it, vi } from "vitest";
import {
  invokePluginInline,
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { retryFailedTurn } from "../../src/services/threads/turn-retry.js";
import {
  internalAuthHeaders,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedQueuedMessage,
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const PICKER = "subscription-picker";
const BUSY =
  "This thread is busy. Wait for the current turn to finish, then choose another account.";
const FOLLOW_UP = "Keep the original next-turn prompt";
const RECOVERY = "Retry the rate-limited request";
const PROTECTED = "Run the protected human prompt";
const TURN = "claude-turn";
const PROVIDER_THREAD = "claude-session";

function installPicker(
  handler: PluginHookRegistration<"message.dispatch">["handler"],
) {
  const hooks: { [K in PluginHookName]: PluginHookRegistration<K>[] } = {
    "message.dispatch": [{ pluginId: PICKER, handler }],
  };
  setPluginHookProvider({
    listHooks: (hook) => hooks[hook],
    invokeHook: (_id, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 1_000,
  });
}

afterEach(() => {
  setPluginHookProvider(undefined);
  vi.useRealTimers();
});

function turnRequests(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "client/turn/requested")
    .map((event) => turnRequestEventDataSchema.parse(JSON.parse(event.data)));
}

function seedClaude(harness: TestAppHarness) {
  vi.useFakeTimers({
    toFake: [
      "Date",
      "setTimeout",
      "clearTimeout",
      "setImmediate",
      "clearImmediate",
    ],
  });
  const { environment, host, session, thread } = seedThreadFixture(harness, {
    environment: { path: harness.config.dataDir },
    thread: { providerId: "claude-code", status: "active" },
  });
  seedThreadRuntimeState(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: PROVIDER_THREAD,
    inputText: RECOVERY,
    model: "test-provider-default",
  });
  seedTurnStarted(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: PROVIDER_THREAD,
    turnId: TURN,
  });
  return {
    threadId: thread.id,
    getThread: () => {
      const current = getThread(harness.db, thread.id);
      if (current === null) throw new Error("Missing Claude fixture thread");
      return current;
    },
    finish: async (status: "completed" | "failed") => {
      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: PROVIDER_THREAD,
                scope: turnScope(TURN),
                status,
              },
            },
          ]),
        }),
      });
      expect(response.status, await response.text()).toBe(200);
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

async function queueWhileBusy(harness: TestAppHarness) {
  const fixture = seedClaude(harness);
  let pinnedAccount = "original";
  const offers: Array<{ queuedIds: string[]; status: string; text: string }> =
    [];
  const switchConfirmed = createDeferredPromise<void>();
  const loadPicker = () =>
    installPicker(async (context) => {
      if (context.attempt !== "start-turn") return { action: "proceed" };
      offers.push({
        queuedIds: context.queuedMessages.map(({ id }) => id),
        status: context.thread.status,
        text: context.input.text,
      });
      if (context.thread.status === "active") {
        return { action: "wait", reason: BUSY };
      }
      await switchConfirmed.promise;
      pinnedAccount = "replacement";
      return { action: "proceed" };
    });

  loadPicker();
  const delivery = await acceptThreadSendRequest(harness.deps, {
    payload: {
      input: textInput(FOLLOW_UP),
      mode: "queue-if-active",
      model: "test-provider-default",
    },
    thread: fixture.getThread(),
  });
  expect(delivery.delivery).toBe("queued");
  const [row] = listQueuedThreadMessages(harness.db, fixture.threadId);
  expect(row).toMatchObject({
    waitingOn: JSON.stringify({
      kind: "plugin",
      pluginId: PICKER,
      reason: BUSY,
    }),
    sendAt: null,
  });
  expect(offers).toEqual([
    { queuedIds: [], status: "active", text: FOLLOW_UP },
  ]);
  if (row === undefined) throw new Error("Missing plugin-held row");
  return {
    ...fixture,
    row,
    loadPicker,
    offers,
    switchConfirmed,
    account: () => pinnedAccount,
  };
}

function reloadPicker(
  harness: TestAppHarness,
  fixture: Awaited<ReturnType<typeof queueWhileBusy>>,
): Promise<void> {
  fixture.loadPicker();
  const rechecked = createDeferredPromise<void>();
  setTimeout(
    () =>
      rechecked.resolve(
        runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" }),
      ),
    1_050,
  );
  return rechecked.promise;
}

async function observeIdleReoffer(reloadWhileBusy: boolean) {
  await withTestHarness(async (harness) => {
    const fixture = await queueWhileBusy(harness);
    if (reloadWhileBusy) {
      const rechecked = reloadPicker(harness, fixture);
      await vi.advanceTimersByTimeAsync(1_060);
      await rechecked;
      expect(fixture.offers.at(-1)).toEqual({
        queuedIds: [fixture.row.id],
        status: "active",
        text: FOLLOW_UP,
      });
    }
    const offersBeforeFinish = fixture.offers.length;
    await fixture.finish("completed");
    for (
      let elapsed = 0;
      elapsed < 1_100 && fixture.offers.length === offersBeforeFinish;
      elapsed += 50
    ) {
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(fixture.getThread().status).toBe("idle");
    expect(turnRequests(harness, fixture.threadId)).toHaveLength(1);
    expect(fixture.account()).toBe("original");

    fixture.switchConfirmed.resolve();
    if (fixture.offers.length > offersBeforeFinish) {
      await vi.waitFor(
        () => expect(turnRequests(harness, fixture.threadId)).toHaveLength(2),
        { timeout: 500 },
      );
    }
    const turns = turnRequests(harness, fixture.threadId);
    expect({
      offers: fixture.offers.slice(offersBeforeFinish),
      account: fixture.account(),
      resumed: turns.slice(1).map((turn) => turn.input),
      remaining: listQueuedThreadMessages(harness.db, fixture.threadId).map(
        ({ id }) => id,
      ),
    }).toEqual({
      offers: [
        { queuedIds: [fixture.row.id], status: "idle", text: FOLLOW_UP },
      ],
      account: "replacement",
      resumed: [textInput(FOLLOW_UP)],
      remaining: [],
    });
  });
}

it("skills#1536 reoffers the original prompt on natural idle", async () => {
  await observeIdleReoffer(false);
});

it("skills#1536 reoffers on natural idle after a picker reload while still busy", async () => {
  await observeIdleReoffer(true);
});

it("reoffers the original row once when the picker reloads after idle and waits for switch confirmation", async () => {
  await withTestHarness(async (harness) => {
    const fixture = await queueWhileBusy(harness);
    await fixture.finish("completed");
    const rechecked = reloadPicker(harness, fixture);
    const idleOffers = () =>
      fixture.offers.filter(({ status }) => status === "idle");
    for (
      let elapsed = 0;
      elapsed < 1_100 && idleOffers().length === 0;
      elapsed += 50
    ) {
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(idleOffers()).toContainEqual({
      queuedIds: [fixture.row.id],
      status: "idle",
      text: FOLLOW_UP,
    });
    expect(turnRequests(harness, fixture.threadId)).toHaveLength(1);
    expect(fixture.account()).toBe("original");

    fixture.switchConfirmed.resolve();
    await vi.advanceTimersByTimeAsync(1_060);
    await rechecked;
    expect(idleOffers()).toHaveLength(1);
    expect(fixture.account()).toBe("replacement");
    expect(turnRequests(harness, fixture.threadId).slice(1)).toMatchObject([
      { input: [{ type: "text", text: FOLLOW_UP }] },
    ]);
    expect(listQueuedThreadMessages(harness.db, fixture.threadId)).toEqual([]);
  });
});

it("skills#1536 keeps a busy-held next-turn prompt paused by Stop through a plugin wake", async () => {
  await withTestHarness(async (harness) => {
    const fixture = await queueWhileBusy(harness);
    const response = harness.app.request(
      `/api/v1/threads/${fixture.threadId}/stop`,
      {
        method: "POST",
      },
    );
    const stop = await waitForQueuedCommand(
      harness,
      ({ command }) =>
        command.type === "thread.stop" && command.threadId === fixture.threadId,
    );
    await reportQueuedCommandSuccess(harness, stop, {
      providerCheckpointId: null,
    });
    expect((await response).status).toBe(200);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(fixture.getThread().status).toBe("idle");
    expect(turnRequests(harness, fixture.threadId)).toHaveLength(1);
    expect(
      listQueuedThreadMessages(harness.db, fixture.threadId),
    ).toMatchObject([{ id: fixture.row.id }]);

    fixture.switchConfirmed.resolve();
    await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
    await runQueuedMessageDispatch(harness.deps, {
      kind: "time-reached",
      now: Date.now(),
    });
    expect({
      account: fixture.account(),
      turns: turnRequests(harness, fixture.threadId).length,
      remaining: listQueuedThreadMessages(harness.db, fixture.threadId).map(
        ({ id }) => id,
      ),
    }).toEqual({ account: "original", turns: 1, remaining: [fixture.row.id] });
  });
});

it.each(["plugin recheck", "due sweep"] as const)(
  "skills#1536 preserves retry not-before through %s",
  async (wake) => {
    await withTestHarness(async (harness) => {
      const fixture = seedClaude(harness);
      await fixture.finish("failed");
      const earlier = Date.now() + 500;
      const notBefore = Date.now() + 5_000;
      let hold = true;
      installPicker((context) => {
        if (context.initiator !== "system" || !hold)
          return { action: "proceed" };
        return {
          action: "wait",
          reason: BUSY,
          ...(wake === "due sweep" ? { recheckAt: earlier } : {}),
        };
      });
      const retry = await retryFailedTurn(harness.deps, {
        thread: fixture.getThread(),
        request: {
          turnRequestId: null,
          sendAt: notBefore,
          reason: "Rate limited",
        },
      });
      expect(retry.delivery).toBe("queued");
      hold = false;
      await vi.advanceTimersByTimeAsync(500);
      await runQueuedMessageDispatch(
        harness.deps,
        wake === "due sweep"
          ? { kind: "time-reached", now: Date.now() }
          : { kind: "plugin-recheck" },
      );
      const early = turnRequests(harness, fixture.threadId).slice(1);
      const deadline = listQueuedThreadMessages(harness.db, fixture.threadId)[0]
        ?.sendAt;

      await vi.advanceTimersByTimeAsync(4_500);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: Date.now(),
      });
      expect(turnRequests(harness, fixture.threadId).slice(1)).toMatchObject([
        {
          initiator: "system",
          retryAttempt: 2,
          input: [{ type: "text", text: RECOVERY }],
        },
      ]);
      expect({ early, deadline }).toEqual({ early: [], deadline: notBefore });
    });
  },
);

it.each(["before automation", "during automation"] as const)(
  "skills#1536 protects a human claim made %s",
  async (order) => {
    await withTestHarness(async (harness) => {
      const fixture = seedClaude(harness);
      await fixture.finish("failed");
      let pinnedAccount = "original";
      const readingAccount = createDeferredPromise<void>();
      const accountReady = createDeferredPromise<void>();
      const visibleQueue = async () => {
        const response = await harness.app.request(
          `/api/v1/threads/${fixture.threadId}/queued-messages`,
        );
        expect(response.status).toBe(200);
        return threadQueuedMessageListResponseSchema.parse(
          await response.json(),
        );
      };
      const claimProtected = () => {
        const row = seedQueuedMessage(harness.deps, {
          threadId: fixture.threadId,
          content: textInput(PROTECTED),
        });
        const claimed = claimQueuedThreadMessageGroup(
          harness.db,
          harness.hub,
          row.id,
          {
            kind: "explicit-send",
          },
        );
        expect(claimed).toMatchObject([{ id: row.id, state: "claimed" }]);
        return row;
      };
      installPicker(async (context) => {
        if (context.initiator !== "system") return { action: "proceed" };
        if ((await visibleQueue()).length > 0)
          return { action: "wait", reason: "Protected input is queued" };
        readingAccount.resolve();
        await accountReady.promise;
        if ((await visibleQueue()).length > 0)
          return { action: "wait", reason: "Protected input is queued" };
        pinnedAccount = "replacement";
        return { action: "proceed" };
      });

      const existing = order === "before automation" ? claimProtected() : null;
      const retry = retryFailedTurn(harness.deps, {
        thread: fixture.getThread(),
        request: { turnRequestId: null, sendAt: null, reason: "Rate limited" },
      });
      let protectedRow;
      try {
        await Promise.race([readingAccount.promise, retry]);
        protectedRow = existing ?? claimProtected();
      } finally {
        accountReady.resolve();
      }
      const result = await retry;

      expect(getQueuedThreadMessage(harness.db, protectedRow.id)).toMatchObject(
        {
          content: protectedRow.content,
          state: "claimed",
        },
      );
      expect({
        account: pinnedAccount,
        recoveryDelivery: result.delivery,
        turns: turnRequests(harness, fixture.threadId)
          .slice(1)
          .map((turn) => turn.input),
      }).toEqual({
        account: "original",
        recoveryDelivery: "queued",
        turns: [],
      });
    });
  },
);

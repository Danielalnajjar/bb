import { createHash, randomUUID } from "node:crypto";
import {
  advanceThreadPruning,
  appendDaemonEventsInTransaction,
  deriveStoredEventItemFields,
  findLastRootStoredTurnStarted,
  getLatestThreadSequence,
  getThread,
  hasRootTurnSupersessionAfter,
  listPendingInteractionsByThread,
  listQueuedThreadMessages,
  readThreadRunState,
  updateThread,
  type AppendDaemonEventInput,
} from "@bb/db";
import { listEvents } from "@bb/db/testing";
import {
  threadScope,
  turnRequestEventDataSchema,
  turnScope,
  type ThreadStatus,
} from "@bb/domain";
import {
  groupHostDaemonEvents,
  HOST_DAEMON_EVENT_IDS_HEADER,
  HOST_DAEMON_PROTOCOL_VERSION,
  type HostDaemonEventBatchResponse,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as coalescedNotices from "../../src/services/threads/coalesced-system-notices.js";
import * as lifecycleFinish from "../../src/services/threads/lifecycle/finish.js";
import { finishThreadLifecycle } from "../../src/services/threads/lifecycle/finish.js";
import * as lifecycleRun from "../../src/services/threads/lifecycle/run.js";
import * as queuedDispatch from "../../src/services/threads/queued-message-dispatch.js";
import { runThreadLifecycleTransaction } from "../../src/services/threads/lifecycle/run.js";
import { ENVIRONMENT_DIRECTORY_UPDATE_OPERATION } from "../../src/services/threads/thread-environment-directory.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { NotificationBuffer } from "../../src/services/lib/notification-buffer.js";
import {
  internalAuthHeaders,
  listQueuedThreadCommands,
  registerTestHostRpcCapture,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { createUserQuestionPayload } from "../helpers/pending-interactions.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEvent,
  seedThread,
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const TURN_ID = "replay-turn";
const NEXT_TURN_ID = "replay-next-turn";
const PROVIDER_THREAD_ID = "replay-provider-thread";
const RESULT_TEXT = "Replayed child result.";
const STEER_REQUEST_ID = "creq_23456789ab";
const AUTO_REQUEST_ID = "creq_3456789abc";
const OTHER_REQUEST_ID = "creq_456789abcd";
const NEXT_RESULT_TEXT = "Replayed follow-up result.";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function derivedRowId(hostId: string, eventId: string): string {
  return `evt_${createHash("sha256")
    .update(`${hostId}\0${eventId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function seedChild(
  harness: TestAppHarness,
  args: { status: ThreadStatus; turnStarted: boolean },
) {
  const {
    host,
    session,
    project,
    environment,
    thread: parent,
  } = seedThreadFixture(harness);
  seedThreadRuntimeState(harness.deps, {
    threadId: parent.id,
    environmentId: environment.id,
    providerThreadId: "replay-parent-provider-thread",
  });
  const child = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    parentThreadId: parent.id,
    status: args.status,
    title: "Replay child",
  });
  seedThreadRuntimeState(harness.deps, {
    threadId: child.id,
    environmentId: environment.id,
    providerThreadId: PROVIDER_THREAD_ID,
  });
  if (args.turnStarted) {
    seedTurnStarted(harness.deps, {
      threadId: child.id,
      environmentId: environment.id,
      providerThreadId: PROVIDER_THREAD_ID,
      turnId: TURN_ID,
    });
  }
  registerTestHostRpcCapture(harness.deps, {
    hostId: host.id,
    sessionId: session.id,
  });
  return { child, environment, host, parent, project, session };
}

function identified(
  event: HostDaemonEventEnvelope["event"],
  eventId: string = randomUUID(),
): HostDaemonEventEnvelope {
  return { threadId: event.threadId, event, eventId };
}

function started(threadId: string, turnId = TURN_ID) {
  return identified({
    type: "turn/started",
    threadId,
    providerThreadId: PROVIDER_THREAD_ID,
    scope: turnScope(turnId),
  });
}

function result(threadId: string, turnId = TURN_ID, text = RESULT_TEXT) {
  return identified({
    type: "item/completed",
    threadId,
    providerThreadId: PROVIDER_THREAD_ID,
    scope: turnScope(turnId),
    item: { id: `replay-result-${turnId}`, type: "agentMessage", text },
  });
}

function delta(threadId: string, text: string) {
  return identified({
    type: "item/agentMessage/delta",
    threadId,
    providerThreadId: PROVIDER_THREAD_ID,
    scope: turnScope(TURN_ID),
    itemId: `replay-result-${TURN_ID}`,
    delta: text,
  });
}

function completion(
  threadId: string,
  status: "completed" | "failed" = "completed",
  turnId = TURN_ID,
) {
  return identified({
    type: "turn/completed",
    threadId,
    providerThreadId: PROVIDER_THREAD_ID,
    scope: turnScope(turnId),
    status,
  });
}

function providerExit(threadId: string, scope = turnScope(TURN_ID)) {
  return identified({
    type: "system/error",
    threadId,
    scope,
    code: "provider_process_exited",
    message: "Provider process exited",
  });
}

function sendSteer(harness: TestAppHarness, threadId: string, hostId: string) {
  runThreadLifecycleTransaction(harness.deps, threadId, {
    type: "request.sent",
    request: {
      hostId,
      kind: "steer",
      requestId: STEER_REQUEST_ID,
      syncTitle: false,
    },
    now: Date.now(),
  });
}

async function admitNextTurn(
  harness: TestAppHarness,
  args: {
    environment: Parameters<typeof sendThreadMessage>[1]["environment"];
    threadId: string;
  },
) {
  const thread = getThread(harness.db, args.threadId);
  if (thread === null) throw new Error("Missing thread");
  await sendThreadMessage(harness.deps, {
    originPluginId: null,
    environment: args.environment,
    payload: {
      input: textInput("next turn"),
      mode: "start",
      model: "gpt-5",
      permissionMode: "full",
      reasoningLevel: "medium",
      serviceTier: "default",
    },
    thread,
    trigger: "user",
  });
}

function lifecycleStamps(
  harness: TestAppHarness,
  threadId: string,
  type: string,
) {
  return listEvents(harness.db, { threadId })
    .filter((row) => row.type === type)
    .map((row) => JSON.parse(row.data).lifecycleApplied ?? false);
}

async function postEvents(
  harness: TestAppHarness,
  args: {
    envelopes: HostDaemonEventEnvelope[];
    hostId: string;
    includeEventIds?: boolean;
    sessionId: string;
  },
): Promise<HostDaemonEventBatchResponse> {
  const response = await harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId: args.hostId }),
    body: JSON.stringify({
      sessionId: args.sessionId,
      eventGroups: groupHostDaemonEvents(args.envelopes, {
        includeEventIds: args.includeEventIds ?? true,
      }),
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as HostDaemonEventBatchResponse;
}

function appendWithoutEffects(
  harness: TestAppHarness,
  hostId: string,
  envelopes: HostDaemonEventEnvelope[],
): void {
  const inputs = envelopes.map((envelope): AppendDaemonEventInput => {
    const { scope, type, threadId, ...data } = envelope.event;
    if (envelope.eventId === undefined) {
      throw new Error("Expected an identified envelope");
    }
    return {
      threadId,
      environmentId: getThread(harness.db, threadId)?.environmentId ?? null,
      id: derivedRowId(hostId, envelope.eventId),
      providerThreadId:
        "providerThreadId" in envelope.event
          ? envelope.event.providerThreadId
          : null,
      scope,
      type,
      ...deriveStoredEventItemFields(envelope.event),
      data: JSON.stringify(data),
    };
  });
  harness.db.transaction((tx) => appendDaemonEventsInTransaction(tx, inputs), {
    behavior: "immediate",
  });
}

function observeEffects(threadId: string) {
  const noticeWrites = vi.spyOn(
    coalescedNotices,
    "writeCoalescedSystemNoticeInTransaction",
  );
  const lifecycleInputs = vi.spyOn(
    lifecycleRun,
    "runThreadLifecycleInTransaction",
  );
  const wakes = vi.spyOn(queuedDispatch, "runQueuedMessageDispatch");
  return {
    completionTransitions: () =>
      lifecycleInputs.mock.calls.filter(
        ([, id, input], index) =>
          id === threadId &&
          input.type === "turn.completed" &&
          lifecycleInputs.mock.results[index]?.type === "return" &&
          lifecycleInputs.mock.results[index].value.effects.some(
            (effect) =>
              effect.kind === "turn-ended" && effect.disposition !== "ignored",
          ),
      ).length,
    providerFailures: () =>
      lifecycleInputs.mock.calls.filter(
        ([, id, input]) => id === threadId && input.type === "provider.failed",
      ).length,
    noticeWrites: () => noticeWrites.mock.calls.length,
    wakes: () =>
      wakes.mock.calls
        .map(([, wake]) => wake)
        .filter((wake) => "threadId" in wake && wake.threadId === threadId)
        .map((wake) => wake.kind),
    reset: () => {
      noticeWrites.mockClear();
      lifecycleInputs.mockClear();
      wakes.mockClear();
    },
  };
}

function rowSummary(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId }).map((row) => ({
    id: row.id,
    type: row.type,
  }));
}

function eventTypeCount(
  harness: TestAppHarness,
  threadId: string,
  type: string,
): number {
  return listEvents(harness.db, { threadId }).filter((row) => row.type === type)
    .length;
}

function parentDelivery(harness: TestAppHarness, parentId: string) {
  return {
    queued: listQueuedThreadMessages(harness.db, parentId).length,
    results: listEvents(harness.db, { threadId: parentId })
      .filter((row) => row.type === "client/turn/requested")
      .map((row) => turnRequestEventDataSchema.parse(JSON.parse(row.data)))
      .filter((turn) => turn.initiator === "system")
      .map((turn) => JSON.stringify(turn.input).split(RESULT_TEXT).length - 1),
    submissions: listQueuedThreadCommands(harness, "turn.submit", parentId)
      .length,
  };
}

async function settleFollowUps() {
  await vi.advanceTimersByTimeAsync(2_000);
}

async function openSession(
  harness: TestAppHarness,
  hostId: string,
): Promise<{ eventIdsHeader: string | null; sessionId: string }> {
  const response = await harness.app.request("/internal/session/open", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId }),
    body: JSON.stringify({
      hostId,
      instanceId: "instance-replay-reopened",
      hostName: "Test Host",
      hasMachineCredential: false,
      platform: "darwin",
      dataDir: `/tmp/bb-host-data/${hostId}`,
      localApiPort: null,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      activeThreads: [],
      openThreadWork: [],
    }),
  });
  expect(response.status).toBe(201);
  const { sessionId } = (await response.json()) as { sessionId: string };
  registerTestHostRpcCapture(harness.deps, { hostId, sessionId });
  return {
    eventIdsHeader: response.headers.get(HOST_DAEMON_EVENT_IDS_HEADER),
    sessionId,
  };
}

describe("identified daemon event storage", () => {
  it("stores an identified event under its host-scoped derived row id", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      const envelope = delta(child.id, "Echo");

      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [envelope],
      });

      expect(
        rowSummary(harness, child.id).filter(
          (row) => row.type === "item/agentMessage/delta",
        ),
      ).toEqual([
        {
          id: derivedRowId(host.id, envelope.eventId ?? ""),
          type: "item/agentMessage/delta",
        },
      ]);
    });
  });

  it("stores a request without eventIds as before, including a repeated batch", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      const batch = [delta(child.id, "Echo\n"), delta(child.id, "Echo\n")];

      const first = await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: batch,
        includeEventIds: false,
      });
      const repeated = await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: batch,
        includeEventIds: false,
      });

      expect(first.acceptedEvents).toHaveLength(2);
      expect(repeated.acceptedEvents).toHaveLength(2);
      expect(eventTypeCount(harness, child.id, "item/agentMessage/delta")).toBe(
        4,
      );
    });
  });

  it("advertises event ids on session open and ignores a batch replayed through the new session", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, parent, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      vi.useFakeTimers();
      const batch = [
        delta(child.id, "Echo\n"),
        delta(child.id, "Echo\n"),
        result(child.id),
        completion(child.id),
      ];
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: batch,
      });
      expect(getThread(harness.db, child.id)?.status).toBe("idle");
      const reopened = await openSession(harness, host.id);
      await settleFollowUps();
      await vi.waitFor(() =>
        expect(parentDelivery(harness, parent.id)).toEqual({
          queued: 0,
          results: [1],
          submissions: 1,
        }),
      );
      const rowsBefore = rowSummary(harness, child.id);
      const effects = observeEffects(child.id);

      const replay = await postEvents(harness, {
        hostId: host.id,
        sessionId: reopened.sessionId,
        envelopes: batch,
      });
      await settleFollowUps();

      expect(reopened.eventIdsHeader).toBe("1");
      expect(replay).toEqual({ acceptedEvents: [], rejectedEvents: [] });
      expect(rowSummary(harness, child.id)).toEqual(rowsBefore);
      expect(effects.completionTransitions()).toBe(0);
      expect(effects.noticeWrites()).toBe(0);
      expect(effects.wakes()).toEqual([]);
      expect(parentDelivery(harness, parent.id)).toEqual({
        queued: 0,
        results: [1],
        submissions: 1,
      });
    });
  });
});

describe("replayed completions", () => {
  it("re-drives a pre-inserted unapplied completion once to idle with one parent notice", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, parent, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [result(child.id)],
      });
      const completed = completion(child.id);
      appendWithoutEffects(harness, host.id, [completed]);
      expect(getThread(harness.db, child.id)?.status).toBe("active");
      vi.useFakeTimers();
      const effects = observeEffects(child.id);

      const replay = await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [completed, completed],
      });
      await settleFollowUps();

      expect(replay.acceptedEvents).toEqual([]);
      expect(getThread(harness.db, child.id)?.status).toBe("idle");
      expect(effects.completionTransitions()).toBe(1);
      expect(effects.noticeWrites()).toBe(1);
      expect(
        listEvents(harness.db, { threadId: child.id })
          .filter((row) => row.type === "turn/completed")
          .map((row) => JSON.parse(row.data).parentNoticeHandled),
      ).toEqual([true]);
      await vi.waitFor(() =>
        expect(parentDelivery(harness, parent.id)).toEqual({
          queued: 0,
          results: [1],
          submissions: 1,
        }),
      );
    });
  });

  it("applies a completion id repeated inside one POST once", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      const completed = completion(child.id);
      const effects = observeEffects(child.id);

      const response = await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [result(child.id), completed, completed],
      });

      expect(response.acceptedEvents.map((event) => event.eventIndex)).toEqual([
        0, 1,
      ]);
      expect(getThread(harness.db, child.id)?.status).toBe("idle");
      expect(eventTypeCount(harness, child.id, "turn/completed")).toBe(1);
      expect(effects.completionTransitions()).toBe(1);
      expect(effects.noticeWrites()).toBe(1);
    });
  });

  it("does not re-drive a replayed completion after a newer root turn started", async () => {
    await withTestHarness(async (harness) => {
      const { child, environment, host, parent, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      const completed = completion(child.id);
      appendWithoutEffects(harness, host.id, [completed]);
      seedTurnStarted(harness.deps, {
        threadId: child.id,
        environmentId: environment.id,
        providerThreadId: PROVIDER_THREAD_ID,
        turnId: NEXT_TURN_ID,
      });
      const effects = observeEffects(child.id);

      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [completed],
      });

      expect(getThread(harness.db, child.id)?.status).toBe("active");
      expect(effects.completionTransitions()).toBe(0);
      expect(effects.noticeWrites()).toBe(0);
      expect(listQueuedThreadMessages(harness.db, parent.id)).toEqual([]);
    });
  });

  it("keeps a held completion unchanged when it is replayed after the parent consumed its notice", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, parent, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      runThreadLifecycleTransaction(harness.deps, child.id, {
        type: "request.sent",
        request: {
          hostId: host.id,
          kind: "steer",
          requestId: STEER_REQUEST_ID,
          syncTitle: false,
        },
        now: Date.now(),
      });
      vi.useFakeTimers();
      const completed = completion(child.id);
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [result(child.id), completed],
      });
      const held = { status: "completed", turnId: TURN_ID };
      expect(readThreadRunState(harness.db, child.id).heldCompletion).toEqual(
        held,
      );
      await settleFollowUps();
      await vi.waitFor(() =>
        expect(parentDelivery(harness, parent.id)).toEqual({
          queued: 0,
          results: [1],
          submissions: 1,
        }),
      );
      const effects = observeEffects(child.id);

      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [completed],
      });
      await settleFollowUps();

      expect(getThread(harness.db, child.id)?.status).toBe("active");
      expect(readThreadRunState(harness.db, child.id).heldCompletion).toEqual(
        held,
      );
      expect(effects.completionTransitions()).toBe(0);
      expect(effects.noticeWrites()).toBe(0);
      expect(effects.wakes()).toEqual([]);
      expect(parentDelivery(harness, parent.id)).toEqual({
        queued: 0,
        results: [1],
        submissions: 1,
      });
    });
  });

  it("repairs a replayed completion while a same-turn steer is outstanding", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      const completed = completion(child.id);
      appendWithoutEffects(harness, host.id, [result(child.id), completed]);
      runThreadLifecycleTransaction(harness.deps, child.id, {
        type: "request.sent",
        request: {
          hostId: host.id,
          kind: "steer",
          requestId: STEER_REQUEST_ID,
          syncTitle: false,
        },
        now: Date.now(),
      });
      const effects = observeEffects(child.id);

      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [completed],
      });

      expect(readThreadRunState(harness.db, child.id).heldCompletion).toEqual({
        status: "completed",
        turnId: TURN_ID,
      });
      expect(effects.completionTransitions()).toBe(1);
      expect(effects.noticeWrites()).toBe(1);
    });
  });

  it("does not re-drive a replayed completion after a different root turn was admitted", async () => {
    await withTestHarness(async (harness) => {
      const { child, environment, host, parent, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      const completed = completion(child.id);
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [result(child.id), completed],
      });
      const idleChild = getThread(harness.db, child.id);
      if (idleChild?.status !== "idle") throw new Error("Expected idle child");
      await sendThreadMessage(harness.deps, {
        originPluginId: null,
        environment,
        payload: {
          input: textInput("next turn"),
          mode: "start",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread: idleChild,
        trigger: "user",
      });
      const admitted = readThreadRunState(harness.db, child.id).requests;
      expect(admitted.map((request) => request.kind)).toEqual(["new-turn"]);
      expect(getThread(harness.db, child.id)?.status).toBe("active");
      const queuedBefore = listQueuedThreadMessages(harness.db, parent.id);
      vi.useFakeTimers();
      const effects = observeEffects(child.id);

      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [completed],
      });
      await settleFollowUps();

      expect(getThread(harness.db, child.id)?.status).toBe("active");
      expect(readThreadRunState(harness.db, child.id).requests).toEqual(
        admitted,
      );
      expect(effects.completionTransitions()).toBe(0);
      expect(effects.noticeWrites()).toBe(0);
      expect(effects.wakes()).toEqual([]);
      expect(
        listQueuedThreadMessages(harness.db, parent.id).map((row) => row.id),
      ).toEqual(queuedBefore.map((row) => row.id));
    });
  });

  it("repairs a replayed completion when an auto request that expected the earlier turn was accepted into it", async () => {
    await withTestHarness(async (harness) => {
      const { child, environment, host, parent, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [result(child.id), completion(child.id)],
      });
      expect(getThread(harness.db, child.id)?.status).toBe("idle");
      await admitNextTurn(harness, { environment, threadId: child.id });
      const submit = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === child.id,
      );
      await reportQueuedCommandSuccess(harness, submit, {
        trace: { spans: [] },
      });
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [started(child.id, NEXT_TURN_ID)],
      });
      const nextStart = findLastRootStoredTurnStarted(harness.db, {
        threadId: child.id,
      });
      expect(nextStart?.turnId).toBe(NEXT_TURN_ID);
      if (nextStart === null) throw new Error("Missing next turn start");
      const nextRequest = listEvents(harness.db, { threadId: child.id })
        .filter((row) => row.type === "client/turn/requested")
        .at(-1);
      if (nextRequest === undefined) throw new Error("Missing next request");
      seedEvent(harness.deps, {
        threadId: child.id,
        environmentId: environment.id,
        sequence:
          getLatestThreadSequence(harness.db, { threadId: child.id }) + 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          ...turnRequestEventDataSchema.parse(JSON.parse(nextRequest.data)),
          requestId: AUTO_REQUEST_ID,
          target: { kind: "auto", expectedTurnId: TURN_ID },
        },
      });
      const supersedesNextTurn = () =>
        hasRootTurnSupersessionAfter(harness.db, {
          afterSequence: nextStart.sequence,
          interruptionsSupersede: false,
          threadId: child.id,
          turnId: NEXT_TURN_ID,
        });
      expect(supersedesNextTurn()).toBe(true);
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [result(child.id, NEXT_TURN_ID, NEXT_RESULT_TEXT)],
      });
      const nextCompleted = completion(child.id, "completed", NEXT_TURN_ID);
      appendWithoutEffects(harness, host.id, [nextCompleted]);
      expect(getThread(harness.db, child.id)?.status).toBe("active");
      const nextResultDeliveries = () =>
        [
          ...listEvents(harness.db, { threadId: parent.id }).filter(
            (row) => row.type === "client/turn/requested",
          ),
          ...listQueuedThreadMessages(harness.db, parent.id),
        ]
          .map((row) => JSON.stringify(row).split(NEXT_RESULT_TEXT).length - 1)
          .reduce((total, count) => total + count, 0);
      const replayNextCompleted = async () => {
        const replay = await postEvents(harness, {
          hostId: host.id,
          sessionId: session.id,
          envelopes: [nextCompleted],
        });
        await settleFollowUps();
        expect(replay.acceptedEvents).toEqual([]);
      };
      vi.useFakeTimers();

      await replayNextCompleted();

      expect(getThread(harness.db, child.id)?.status).toBe("active");
      expect(nextResultDeliveries()).toBe(0);

      appendWithoutEffects(harness, host.id, [
        identified({
          type: "turn/input/accepted",
          threadId: child.id,
          providerThreadId: PROVIDER_THREAD_ID,
          clientRequestId: OTHER_REQUEST_ID,
          scope: turnScope(NEXT_TURN_ID),
        }),
        identified({
          type: "turn/input/accepted",
          threadId: child.id,
          providerThreadId: PROVIDER_THREAD_ID,
          clientRequestId: AUTO_REQUEST_ID,
          scope: turnScope(TURN_ID),
        }),
      ]);
      expect(supersedesNextTurn()).toBe(true);

      await replayNextCompleted();

      expect(getThread(harness.db, child.id)?.status).toBe("active");
      expect(nextResultDeliveries()).toBe(0);

      appendWithoutEffects(harness, host.id, [
        identified({
          type: "turn/input/accepted",
          threadId: child.id,
          providerThreadId: PROVIDER_THREAD_ID,
          clientRequestId: AUTO_REQUEST_ID,
          scope: turnScope(NEXT_TURN_ID),
        }),
      ]);
      expect(supersedesNextTurn()).toBe(false);

      await replayNextCompleted();

      expect(getThread(harness.db, child.id)?.status).toBe("idle");
      await vi.waitFor(() => expect(nextResultDeliveries()).toBe(1));
    });
  });

  it("delivers a late success once when an append-only completion after a recorded interruption is replayed", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, parent, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      vi.useFakeTimers();
      await finishThreadLifecycle(
        harness.deps,
        runThreadLifecycleTransaction(harness.deps, child.id, {
          type: "daemon.lost",
          reason: "host-daemon-restarted",
          resuming: false,
        }),
      );
      expect(listQueuedThreadMessages(harness.db, parent.id)).toHaveLength(1);
      const batch = [result(child.id), completion(child.id)];
      appendWithoutEffects(harness, host.id, batch);

      const replay = await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: batch,
      });
      await settleFollowUps();

      expect(replay.acceptedEvents).toEqual([]);
      await vi.waitFor(() =>
        expect(parentDelivery(harness, parent.id)).toEqual({
          queued: 0,
          results: [1],
          submissions: 1,
        }),
      );

      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: batch,
      });
      await settleFollowUps();

      expect(parentDelivery(harness, parent.id)).toEqual({
        queued: 0,
        results: [1],
        submissions: 1,
      });
    });
  });

  it("delivers no second failure when a held provider-exit batch is replayed after the parent consumed its notice", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, parent, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      sendSteer(harness, child.id, host.id);
      vi.useFakeTimers();
      const batch = [
        result(child.id),
        completion(child.id, "failed"),
        providerExit(child.id),
      ];
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: batch,
      });
      await settleFollowUps();
      await vi.waitFor(() =>
        expect(parentDelivery(harness, parent.id)).toMatchObject({
          queued: 0,
          submissions: 1,
        }),
      );
      const deliveredBefore = parentDelivery(harness, parent.id);
      expect(deliveredBefore.results).toHaveLength(1);
      expect(getThread(harness.db, child.id)?.status).toBe("error");
      expect(
        readThreadRunState(harness.db, child.id).heldCompletion,
      ).toBeNull();
      expect(lifecycleStamps(harness, child.id, "turn/completed")).toEqual([
        true,
      ]);

      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: batch,
      });
      await settleFollowUps();

      expect(getThread(harness.db, child.id)?.status).toBe("error");
      expect(
        readThreadRunState(harness.db, child.id).heldCompletion,
      ).toBeNull();
      expect(parentDelivery(harness, parent.id)).toEqual(deliveredBefore);
    });
  });

  it("publishes no second result when a released directory-continuation completion is replayed after its fallback was delivered", async () => {
    await withTestHarness(async (harness) => {
      const { child, environment, host, parent, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      seedEvent(harness.deps, {
        threadId: child.id,
        environmentId: environment.id,
        sequence:
          getLatestThreadSequence(harness.db, { threadId: child.id }) + 1,
        type: "system/operation",
        scope: turnScope(TURN_ID),
        data: {
          operation: ENVIRONMENT_DIRECTORY_UPDATE_OPERATION,
          status: "completed",
          message: "Moved the environment",
          operationId: "replay-directory-update",
          metadata: {
            nextEnvironmentId: "replay-elsewhere-environment",
            nextPath: "/tmp/replay-elsewhere",
          },
        },
      });
      sendSteer(harness, child.id, host.id);
      vi.useFakeTimers();
      const completed = completion(child.id);
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [result(child.id), completed],
      });
      await settleFollowUps();
      expect(readThreadRunState(harness.db, child.id).heldCompletion).toEqual({
        status: "completed",
        turnId: TURN_ID,
      });
      expect(lifecycleStamps(harness, child.id, "turn/completed")).toEqual([
        true,
      ]);
      expect(parentDelivery(harness, parent.id)).toEqual({
        queued: 0,
        results: [],
        submissions: 0,
      });
      await finishThreadLifecycle(
        harness.deps,
        runThreadLifecycleTransaction(harness.deps, child.id, {
          type: "request.answered",
          requestId: STEER_REQUEST_ID,
          answer: { kind: "accepted", threadStart: null },
        }),
      );
      await settleFollowUps();
      await vi.waitFor(() =>
        expect(parentDelivery(harness, parent.id)).toEqual({
          queued: 0,
          results: [1],
          submissions: 1,
        }),
      );
      expect(getThread(harness.db, child.id)?.status).toBe("idle");

      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [completed],
      });
      await settleFollowUps();

      expect(getThread(harness.db, child.id)?.status).toBe("idle");
      expect(parentDelivery(harness, parent.id)).toEqual({
        queued: 0,
        results: [1],
        submissions: 1,
      });
    });
  });

  it("runs no effect or notice when a lost-ack batch is retried after its deltas were pruned", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, parent, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      vi.useFakeTimers();
      const batch = [
        delta(child.id, "Replayed "),
        delta(child.id, "child "),
        delta(child.id, "result."),
        result(child.id),
        completion(child.id),
      ];
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: batch,
      });
      await settleFollowUps();
      await vi.waitFor(() =>
        expect(parentDelivery(harness, parent.id)).toEqual({
          queued: 0,
          results: [1],
          submissions: 1,
        }),
      );
      let removed = 0;
      for (let pass = 0; pass < 100; pass += 1) {
        const pruned = advanceThreadPruning(harness.db, "resolved-items");
        removed += pruned.removed;
        if (pruned.action === "cycle-complete") break;
      }
      expect(removed).toBeGreaterThan(0);
      const rowsAfterPrune = rowSummary(harness, child.id);
      const effects = observeEffects(child.id);

      const replay = await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: batch,
      });
      await settleFollowUps();

      expect(replay.acceptedEvents).toEqual([]);
      expect(rowSummary(harness, child.id)).toEqual(rowsAfterPrune);
      expect(effects.completionTransitions()).toBe(0);
      expect(effects.noticeWrites()).toBe(0);
      expect(parentDelivery(harness, parent.id)).toEqual({
        queued: 0,
        results: [1],
        submissions: 1,
      });
    });
  });
});

describe("replayed turn starts", () => {
  it("repairs a replayed start whose lifecycle never applied", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, session } = seedChild(harness, {
        status: "starting",
        turnStarted: false,
      });
      const start = started(child.id);
      appendWithoutEffects(harness, host.id, [start]);
      expect(getThread(harness.db, child.id)?.status).toBe("starting");
      vi.useFakeTimers();
      const effects = observeEffects(child.id);

      const replay = await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [start],
      });
      await settleFollowUps();

      expect(replay.acceptedEvents).toEqual([]);
      expect(getThread(harness.db, child.id)?.status).toBe("active");
      expect(effects.wakes()).toEqual(["turn-started"]);
    });
  });

  it("ends idle with one parent notice when an append-only start and completion are retried", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, parent, session } = seedChild(harness, {
        status: "starting",
        turnStarted: false,
      });
      const batch = [started(child.id), result(child.id), completion(child.id)];
      appendWithoutEffects(harness, host.id, batch);
      vi.useFakeTimers();
      const effects = observeEffects(child.id);

      const replay = await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: batch,
      });
      await settleFollowUps();

      expect(replay.acceptedEvents).toEqual([]);
      expect(getThread(harness.db, child.id)?.status).toBe("idle");
      expect(effects.completionTransitions()).toBe(1);
      expect(effects.noticeWrites()).toBe(1);
      await vi.waitFor(() =>
        expect(parentDelivery(harness, parent.id)).toEqual({
          queued: 0,
          results: [1],
          submissions: 1,
        }),
      );
    });
  });

  it("dispatches a turn-starting message once when the start of an admitted follow-up turn is replayed", async () => {
    await withTestHarness(async (harness) => {
      const { child, environment, host, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [result(child.id), completion(child.id)],
      });
      const idleChild = getThread(harness.db, child.id);
      if (idleChild?.status !== "idle") throw new Error("Expected idle child");
      await sendThreadMessage(harness.deps, {
        originPluginId: null,
        environment,
        payload: {
          input: textInput("next turn"),
          mode: "start",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread: idleChild,
        trigger: "user",
      });
      const activeChild = getThread(harness.db, child.id);
      if (activeChild?.status !== "active") {
        throw new Error("Expected active child");
      }
      const steer = textInput("steer into the follow-up turn");
      await expect(
        acceptThreadSendRequest(harness.deps, {
          payload: {
            input: steer,
            mode: "steer",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          },
          thread: activeChild,
        }),
      ).resolves.toMatchObject({
        delivery: "queued",
        queuedMessage: { waitingOn: { kind: "turn-starting" } },
      });
      const start = started(child.id, NEXT_TURN_ID);
      appendWithoutEffects(harness, host.id, [start]);
      vi.useFakeTimers();
      const steeredCommands = () =>
        listQueuedThreadCommands(harness, "turn.submit", child.id).filter(
          (command) => JSON.stringify(command).includes("follow-up turn"),
        );

      const replay = await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [start],
      });
      await settleFollowUps();

      expect(replay.acceptedEvents).toEqual([]);
      await vi.waitFor(() => expect(steeredCommands()).toHaveLength(1));
      expect(steeredCommands()).toEqual([
        expect.objectContaining({
          input: steer,
          target: { mode: "auto", expectedTurnId: NEXT_TURN_ID },
        }),
      ]);
      expect(listQueuedThreadMessages(harness.db, child.id)).toEqual([]);
    });
  });

  it("adds no second turn-started wake when an applied start is retried", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, session } = seedChild(harness, {
        status: "starting",
        turnStarted: false,
      });
      vi.useFakeTimers();
      const start = started(child.id);
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [start],
      });
      await settleFollowUps();
      expect(getThread(harness.db, child.id)?.status).toBe("active");
      const effects = observeEffects(child.id);

      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [start],
      });
      await settleFollowUps();

      expect(getThread(harness.db, child.id)?.status).toBe("active");
      expect(eventTypeCount(harness, child.id, "turn/started")).toBe(1);
      expect(effects.wakes()).toEqual([]);
    });
  });

  it("keeps a stopped thread idle when an append-only start from before the stop is replayed", async () => {
    await withTestHarness(async (harness) => {
      const { child, environment, host, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [result(child.id), completion(child.id)],
      });
      await admitNextTurn(harness, { environment, threadId: child.id });
      expect(getThread(harness.db, child.id)?.status).toBe("active");
      const start = started(child.id, NEXT_TURN_ID);
      appendWithoutEffects(harness, host.id, [start]);
      const stopping = harness.app.request(`/api/v1/threads/${child.id}/stop`, {
        method: "POST",
      });
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === child.id,
      );
      await reportQueuedCommandSuccess(harness, stop, {
        providerCheckpointId: null,
      });
      expect((await stopping).status).toBe(200);
      expect(getThread(harness.db, child.id)?.status).toBe("idle");
      expect(
        eventTypeCount(harness, child.id, "system/thread/interrupted"),
      ).toBe(1);
      vi.useFakeTimers();
      const effects = observeEffects(child.id);

      const replay = await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [start],
      });
      await settleFollowUps();

      expect(replay.acceptedEvents).toEqual([]);
      expect(getThread(harness.db, child.id)?.status).toBe("idle");
      expect(effects.wakes()).toEqual([]);
      expect(lifecycleStamps(harness, child.id, "turn/started")).toEqual([
        false,
        false,
      ]);
    });
  });

  it("applies a start once when a retry stamps it while the original POST is still applying earlier effects", async () => {
    await withTestHarness(async (harness) => {
      const { child, environment, host, project, session } = seedChild(
        harness,
        { status: "starting", turnStarted: false },
      );
      const sibling = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "starting",
        title: "Replay sibling",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: sibling.id,
        environmentId: environment.id,
        providerThreadId: "replay-sibling-provider-thread",
      });
      const siblingStart = identified({
        type: "turn/started",
        threadId: sibling.id,
        providerThreadId: "replay-sibling-provider-thread",
        scope: turnScope("replay-sibling-turn"),
      });
      const start = started(child.id);
      let releaseOriginal = () => {};
      const originalHeld = new Promise<void>((resolve) => {
        releaseOriginal = resolve;
      });
      let originalReachedGate = false;
      const finish = lifecycleFinish.finishThreadLifecycle;
      vi.spyOn(lifecycleFinish, "finishThreadLifecycle").mockImplementation(
        async (deps, outcome, options) => {
          if (outcome.threadId === sibling.id && !originalReachedGate) {
            originalReachedGate = true;
            await originalHeld;
          }
          return finish(deps, outcome, options);
        },
      );
      vi.useFakeTimers();
      const effects = observeEffects(child.id);

      const original = postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [siblingStart, start],
      });
      try {
        await vi.waitFor(() => expect(originalReachedGate).toBe(true));
        expect(lifecycleStamps(harness, child.id, "turn/started")).toEqual([
          false,
        ]);
        const retry = await postEvents(harness, {
          hostId: host.id,
          sessionId: session.id,
          envelopes: [start],
        });
        expect(retry.acceptedEvents).toEqual([]);
        expect(lifecycleStamps(harness, child.id, "turn/started")).toEqual([
          true,
        ]);
        await postEvents(harness, {
          hostId: host.id,
          sessionId: session.id,
          envelopes: [result(child.id), completion(child.id)],
        });
        expect(getThread(harness.db, child.id)?.status).toBe("idle");
      } finally {
        releaseOriginal();
      }
      const originalResponse = await original;
      await settleFollowUps();

      expect(originalResponse.acceptedEvents).toHaveLength(2);
      expect(getThread(harness.db, child.id)?.status).toBe("idle");
      expect(getThread(harness.db, sibling.id)?.status).toBe("active");
      expect(eventTypeCount(harness, child.id, "turn/started")).toBe(1);
      expect(lifecycleStamps(harness, child.id, "turn/started")).toEqual([
        true,
      ]);
      expect(effects.wakes().filter((kind) => kind === "turn-started")).toEqual(
        ["turn-started"],
      );
    });
  });
});

describe("replayed provider errors", () => {
  it("leaves a newer admitted turn untouched when a provider-exit batch is replayed", async () => {
    await withTestHarness(async (harness) => {
      const { child, environment, host, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      const batch = [completion(child.id, "failed"), providerExit(child.id)];
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: batch,
      });
      const exitedChild = getThread(harness.db, child.id);
      if (exitedChild === null) throw new Error("Missing child");
      expect(exitedChild.status).toBe("error");
      await sendThreadMessage(harness.deps, {
        originPluginId: null,
        environment,
        payload: {
          input: textInput("next turn"),
          mode: "start",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread: exitedChild,
        trigger: "user",
      });
      const admitted = readThreadRunState(harness.db, child.id).requests;
      expect(admitted.map((request) => request.kind)).toEqual(["new-turn"]);
      expect(getThread(harness.db, child.id)?.status).toBe("active");
      vi.useFakeTimers();
      const effects = observeEffects(child.id);
      const interruptions = vi.spyOn(
        harness.deps.pendingInteractions,
        "interruptPendingInteractionsForThreadIdsInTransaction",
      );

      const replay = await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: batch,
      });
      await settleFollowUps();

      expect(replay).toEqual({ acceptedEvents: [], rejectedEvents: [] });
      expect(getThread(harness.db, child.id)?.status).toBe("active");
      expect(readThreadRunState(harness.db, child.id).requests).toEqual(
        admitted,
      );
      expect(effects.completionTransitions()).toBe(0);
      expect(effects.providerFailures()).toBe(0);
      expect(interruptions).not.toHaveBeenCalled();
    });
  });

  it("runs no second provider failure when an applied provider-exit batch is replayed", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      const batch = [completion(child.id, "failed"), providerExit(child.id)];
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: batch,
      });
      const statusBefore = getThread(harness.db, child.id)?.status;
      const effects = observeEffects(child.id);
      const interruptions = vi.spyOn(
        harness.deps.pendingInteractions,
        "interruptPendingInteractionsForThreadIdsInTransaction",
      );

      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: batch,
      });

      expect(getThread(harness.db, child.id)?.status).toBe(statusBefore);
      expect(effects.providerFailures()).toBe(0);
      expect(interruptions).not.toHaveBeenCalled();
    });
  });

  it("interrupts a pending question in the commit that stamps a fresh provider exit", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      const registered =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: child.id,
            turnId: TURN_ID,
            providerId: getThread(harness.db, child.id)?.providerId ?? "",
            providerThreadId: PROVIDER_THREAD_ID,
            providerRequestId: "replay-exit-question",
            payload: createUserQuestionPayload(),
          },
        });
      expect(registered.outcome).not.toBe("rejected");
      const pendingStatuses = () =>
        listPendingInteractionsByThread(harness.db, {
          threadId: child.id,
        }).map((interaction) => interaction.status);
      expect(pendingStatuses()).toEqual(["pending"]);
      const exitStamps = () =>
        lifecycleStamps(harness, child.id, "system/error");
      let statusesAtCommit: string[] | null = null;
      const flush = NotificationBuffer.prototype.flushInto;
      vi.spyOn(NotificationBuffer.prototype, "flushInto").mockImplementation(
        function (this: NotificationBuffer, notifier) {
          if (statusesAtCommit === null && exitStamps().includes(true)) {
            statusesAtCommit = pendingStatuses();
            throw new Error("Crash after the provider-exit commit");
          }
          flush.call(this, notifier);
        },
      );

      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [providerExit(child.id)],
      });

      expect(statusesAtCommit).toEqual(["interrupted"]);
      expect(pendingStatuses()).toEqual(["interrupted"]);
      expect(exitStamps()).toEqual([true]);
    });
  });

  it("repairs an append-only provider-exit error once", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      const exit = providerExit(child.id);
      appendWithoutEffects(harness, host.id, [exit]);
      expect(getThread(harness.db, child.id)?.status).toBe("active");
      const effects = observeEffects(child.id);
      const interruptions = vi.spyOn(
        harness.deps.pendingInteractions,
        "interruptPendingInteractionsForThreadIdsInTransaction",
      );

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await postEvents(harness, {
          hostId: host.id,
          sessionId: session.id,
          envelopes: [exit],
        });
      }

      expect(getThread(harness.db, child.id)?.status).toBe("error");
      expect(effects.providerFailures()).toBe(1);
      expect(interruptions).toHaveBeenCalledTimes(1);
      expect(
        listEvents(harness.db, { threadId: child.id })
          .filter((row) => row.type === "system/error")
          .map((row) => JSON.parse(row.data).lifecycleApplied),
      ).toEqual([true]);
    });
  });

  it("leaves a newer run untouched when an append-only thread-scoped exit is replayed after the newer request left run state", async () => {
    await withTestHarness(async (harness) => {
      const { child, environment, host, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [result(child.id), completion(child.id)],
      });
      const exit = providerExit(child.id, threadScope());
      appendWithoutEffects(harness, host.id, [exit]);
      await admitNextTurn(harness, { environment, threadId: child.id });
      const submit = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === child.id,
      );
      await reportQueuedCommandSuccess(harness, submit, {
        trace: { spans: [] },
      });
      expect(readThreadRunState(harness.db, child.id).requests).toEqual([]);
      expect(getThread(harness.db, child.id)?.status).toBe("active");

      const replay = await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [exit],
      });

      expect(replay.acceptedEvents).toEqual([]);
      expect(getThread(harness.db, child.id)?.status).toBe("active");
      expect(lifecycleStamps(harness, child.id, "system/error")).toEqual([
        false,
      ]);
    });
  });

  it("keeps a newer run and its pending interaction when an append-only turn-scoped exit is replayed", async () => {
    await withTestHarness(async (harness) => {
      const { child, environment, host, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [completion(child.id, "failed")],
      });
      expect(getThread(harness.db, child.id)?.status).toBe("error");
      const exit = providerExit(child.id);
      appendWithoutEffects(harness, host.id, [exit]);
      await admitNextTurn(harness, { environment, threadId: child.id });
      const admitted = readThreadRunState(harness.db, child.id).requests;
      expect(admitted.map((request) => request.kind)).toEqual(["new-turn"]);
      expect(getThread(harness.db, child.id)?.status).toBe("active");
      seedTurnStarted(harness.deps, {
        threadId: child.id,
        environmentId: environment.id,
        providerThreadId: PROVIDER_THREAD_ID,
        turnId: NEXT_TURN_ID,
      });
      const registered =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: child.id,
            turnId: NEXT_TURN_ID,
            providerId: getThread(harness.db, child.id)?.providerId ?? "",
            providerThreadId: PROVIDER_THREAD_ID,
            providerRequestId: "replay-pending-question",
            payload: createUserQuestionPayload(),
          },
        });
      expect(registered.outcome).not.toBe("rejected");
      const pendingStatuses = () =>
        listPendingInteractionsByThread(harness.db, {
          threadId: child.id,
        }).map((interaction) => interaction.status);
      expect(pendingStatuses()).toEqual(["pending"]);

      const replay = await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [exit],
      });

      expect(replay.acceptedEvents).toEqual([]);
      expect(getThread(harness.db, child.id)?.status).toBe("active");
      expect(readThreadRunState(harness.db, child.id).requests).toEqual(
        admitted,
      );
      expect(pendingStatuses()).toEqual(["pending"]);
      expect(lifecycleStamps(harness, child.id, "system/error")).toEqual([
        false,
      ]);
    });
  });
});

describe("other replayed events", () => {
  it("repairs append-only accepted-input and title effects without reverting a later title", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, session } = seedChild(harness, {
        status: "active",
        turnStarted: true,
      });
      updateThread(harness.db, harness.hub, child.id, { title: null });
      runThreadLifecycleTransaction(harness.deps, child.id, {
        type: "request.sent",
        request: {
          hostId: host.id,
          kind: "steer",
          requestId: STEER_REQUEST_ID,
          syncTitle: false,
        },
        now: Date.now(),
      });
      const accepted = identified({
        type: "turn/input/accepted",
        threadId: child.id,
        providerThreadId: PROVIDER_THREAD_ID,
        clientRequestId: STEER_REQUEST_ID,
        scope: turnScope(TURN_ID),
      });
      const named = identified({
        type: "thread/name/updated",
        threadId: child.id,
        providerThreadId: PROVIDER_THREAD_ID,
        threadName: "First agent title",
        source: "agent",
        scope: threadScope(),
      });
      const phases = () =>
        readThreadRunState(harness.db, child.id).requests.map(
          (request) => request.phase,
        );
      appendWithoutEffects(harness, host.id, [accepted, named]);
      expect(phases()).toEqual(["sent"]);
      expect(getThread(harness.db, child.id)?.title).toBeNull();

      const repair = await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [accepted, named],
      });

      expect(repair.acceptedEvents).toEqual([]);
      expect(phases()).toEqual(["accepted"]);
      expect(getThread(harness.db, child.id)?.title).toBe("First agent title");
      updateThread(harness.db, harness.hub, child.id, {
        title: "Later title",
      });

      const replay = await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [accepted, named],
      });

      expect(replay.acceptedEvents).toEqual([]);
      expect(eventTypeCount(harness, child.id, "turn/input/accepted")).toBe(1);
      expect(eventTypeCount(harness, child.id, "thread/name/updated")).toBe(1);
      expect(phases()).toEqual(["accepted"]);
      expect(getThread(harness.db, child.id)?.title).toBe("Later title");
    });
  });
});

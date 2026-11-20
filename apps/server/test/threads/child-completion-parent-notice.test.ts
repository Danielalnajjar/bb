import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConnection,
  getLatestThreadSequence,
  getThread,
  listQueuedThreadMessages,
  readThreadRunState,
} from "@bb/db";
import { listEvents } from "@bb/db/testing";
import {
  turnRequestEventDataSchema,
  turnScope,
  type ThreadEventTurnStatus,
} from "@bb/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as coalescedNotices from "../../src/services/threads/coalesced-system-notices.js";
import { finishThreadLifecycle } from "../../src/services/threads/lifecycle/finish.js";
import { runThreadLifecycleTransaction } from "../../src/services/threads/lifecycle/run.js";
import * as threadCommands from "../../src/services/threads/thread-commands.js";
import {
  internalAuthHeaders,
  listQueuedThreadCommands,
  registerTestHostRpcCapture,
} from "../helpers/commands.js";
import {
  seedEvent,
  seedThread,
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  createTestDb,
  withTestHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

const TURN_ID = "child-turn";
const PROVIDER_THREAD_ID = "child-provider-thread";
const RESULT_TEXT = "Child result reached the parent.";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function seedActiveChild(harness: TestAppHarness) {
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
    providerThreadId: "parent-provider-thread",
  });
  const child = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    parentThreadId: parent.id,
    status: "active",
    title: "Worker child",
  });
  seedThreadRuntimeState(harness.deps, {
    threadId: child.id,
    environmentId: environment.id,
    providerThreadId: PROVIDER_THREAD_ID,
  });
  seedTurnStarted(harness.deps, {
    threadId: child.id,
    environmentId: environment.id,
    providerThreadId: PROVIDER_THREAD_ID,
    turnId: TURN_ID,
  });
  registerTestHostRpcCapture(harness.deps, {
    hostId: host.id,
    sessionId: session.id,
  });
  return { child, host, parent, session };
}

function resultEnvelope(threadId: string): HostDaemonEventEnvelope {
  return {
    threadId,
    event: {
      type: "item/completed",
      threadId,
      providerThreadId: PROVIDER_THREAD_ID,
      scope: turnScope(TURN_ID),
      item: { id: "result", type: "agentMessage", text: RESULT_TEXT },
    },
  };
}

function completionEnvelope(
  threadId: string,
  status: ThreadEventTurnStatus = "completed",
): HostDaemonEventEnvelope {
  return {
    threadId,
    event: {
      type: "turn/completed",
      threadId,
      providerThreadId: PROVIDER_THREAD_ID,
      scope: turnScope(TURN_ID),
      status,
    },
  };
}

async function postEvents(
  harness: TestAppHarness,
  args: {
    hostId: string;
    sessionId: string;
    envelopes: HostDaemonEventEnvelope[];
  },
): Promise<void> {
  const response = await harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId: args.hostId }),
    body: JSON.stringify({
      sessionId: args.sessionId,
      eventGroups: groupHostDaemonEvents(args.envelopes),
    }),
  });
  expect(response.status).toBe(200);
}

function parentResults(harness: TestAppHarness, parentId: string) {
  return listEvents(harness.db, { threadId: parentId })
    .filter((row) => row.type === "client/turn/requested")
    .map((row) => turnRequestEventDataSchema.parse(JSON.parse(row.data)))
    .filter((turn) => turn.initiator === "system")
    .map((turn) => ({
      kind: turn.systemMessageKind,
      resultCopies: JSON.stringify(turn.input).split(RESULT_TEXT).length - 1,
    }));
}

function parentDelivery(harness: TestAppHarness, parentId: string) {
  return {
    queued: listQueuedThreadMessages(harness.db, parentId).length,
    results: parentResults(harness, parentId),
    submissions: listQueuedThreadCommands(harness, "turn.submit", parentId)
      .length,
  };
}

function childCompletions(harness: TestAppHarness, childId: string) {
  return listEvents(harness.db, { threadId: childId })
    .filter((row) => row.type === "turn/completed")
    .map((row) => {
      const data = JSON.parse(row.data);
      return {
        status: data.status,
        handled: data.parentNoticeHandled === true,
      };
    });
}

async function deliverDueNotices() {
  await vi.advanceTimersByTimeAsync(2_000);
}

describe("child completion parent notice commit boundary", () => {
  it("commits the parent notice in the child's completion transaction", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "bb-child-notice-boundary-"));
    onTestFinished(() => rm(dataDir, { recursive: true }));
    const dbPath = join(dataDir, "bb.db");
    const template = createTestDb();
    try {
      await writeFile(dbPath, template.$client.serialize());
    } finally {
      template.$client.close();
    }
    const db = createConnection(dbPath);
    onTestFinished(() => {
      db.$client.close();
    });
    const reader = createConnection(dbPath);
    onTestFinished(() => {
      reader.$client.close();
    });

    await withTestHarness({ storage: { dataDir, db } }, async (harness) => {
      const { child, host, parent, session } = seedActiveChild(harness);
      const observations: unknown[] = [];
      const writeNotice =
        coalescedNotices.writeCoalescedSystemNoticeInTransaction;
      vi.spyOn(
        coalescedNotices,
        "writeCoalescedSystemNoticeInTransaction",
      ).mockImplementation((tx, args, now) => {
        const write = writeNotice(tx, args, now);
        observations.push({
          write: write.kind,
          writer: getThread(tx, child.id)?.status,
          reader: {
            child: getThread(reader, child.id)?.status,
            notices: listQueuedThreadMessages(reader, parent.id).length,
          },
        });
        return write;
      });

      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [resultEnvelope(child.id), completionEnvelope(child.id)],
      });

      expect(observations).toEqual([
        {
          write: "created",
          writer: "idle",
          reader: { child: "active", notices: 0 },
        },
      ]);
      expect({
        child: getThread(reader, child.id)?.status,
        notices: listQueuedThreadMessages(reader, parent.id).map(
          (row) => row.coalesceKey,
        ),
      }).toEqual({ child: "idle", notices: ["child-outcomes"] });
    });
  });
});

describe("child completion parent notice failures", () => {
  it("commits the child's completion when the parent's execution cannot be resolved", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, parent, session } = seedActiveChild(harness);
      vi.spyOn(threadCommands, "buildExecutionOptions").mockRejectedValueOnce(
        new Error("parent execution unavailable"),
      );
      const logError = vi.spyOn(harness.deps.logger, "error");

      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [resultEnvelope(child.id), completionEnvelope(child.id)],
      });

      expect(getThread(harness.db, child.id)?.status).toBe("idle");
      expect(childCompletions(harness, child.id)).toEqual([
        { status: "completed", handled: false },
      ]);
      expect(listQueuedThreadMessages(harness.db, parent.id)).toEqual([]);
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({
          childThreadId: child.id,
          parentThreadId: parent.id,
          turnStatus: "completed",
        }),
        "Failed to resolve parent execution for child turn notification",
      );
    });
  });

  it("rolls back only the notice savepoint when the notice write fails", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, parent, session } = seedActiveChild(harness);
      const writeNotice =
        coalescedNotices.writeCoalescedSystemNoticeInTransaction;
      vi.spyOn(
        coalescedNotices,
        "writeCoalescedSystemNoticeInTransaction",
      ).mockImplementationOnce((tx, args, now) => {
        writeNotice(tx, args, now);
        throw new Error("notice write failed");
      });
      const logError = vi.spyOn(harness.deps.logger, "error");

      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [resultEnvelope(child.id), completionEnvelope(child.id)],
      });

      expect(getThread(harness.db, child.id)?.status).toBe("idle");
      expect(childCompletions(harness, child.id)).toEqual([
        { status: "completed", handled: false },
      ]);
      expect(listQueuedThreadMessages(harness.db, parent.id)).toEqual([]);
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({
          childThreadId: child.id,
          parentThreadId: parent.id,
          turnStatus: "completed",
        }),
        "Failed to write parent child turn notification",
      );
    });
  });
});

describe("stock duplicate child completions", () => {
  it("delivers the result when a retry follows an appended but unapplied completion", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, parent, session } = seedActiveChild(harness);
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [resultEnvelope(child.id)],
      });
      seedEvent(harness.deps, {
        threadId: child.id,
        providerThreadId: PROVIDER_THREAD_ID,
        scope: turnScope(TURN_ID),
        sequence:
          getLatestThreadSequence(harness.db, { threadId: child.id }) + 1,
        type: "turn/completed",
        data: { providerThreadId: PROVIDER_THREAD_ID, status: "completed" },
      });
      expect(getThread(harness.db, child.id)?.status).toBe("active");

      vi.useFakeTimers();
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [completionEnvelope(child.id)],
      });
      await deliverDueNotices();

      expect(getThread(harness.db, child.id)?.status).toBe("idle");
      expect(childCompletions(harness, child.id)).toEqual([
        { status: "completed", handled: false },
        { status: "completed", handled: true },
      ]);
      await vi.waitFor(() =>
        expect(parentDelivery(harness, parent.id)).toEqual({
          queued: 0,
          results: [{ kind: "child-completed", resultCopies: 1 }],
          submissions: 1,
        }),
      );
    });
  });

  it("does not notify the parent again for a completion replayed after the notice was consumed", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, parent, session } = seedActiveChild(harness);
      vi.useFakeTimers();
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [resultEnvelope(child.id), completionEnvelope(child.id)],
      });
      await deliverDueNotices();
      await vi.waitFor(() =>
        expect(parentDelivery(harness, parent.id)).toEqual({
          queued: 0,
          results: [{ kind: "child-completed", resultCopies: 1 }],
          submissions: 1,
        }),
      );

      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [completionEnvelope(child.id)],
      });
      await deliverDueNotices();

      expect(childCompletions(harness, child.id)).toEqual([
        { status: "completed", handled: true },
        { status: "completed", handled: false },
      ]);
      expect(parentDelivery(harness, parent.id)).toEqual({
        queued: 0,
        results: [{ kind: "child-completed", resultCopies: 1 }],
        submissions: 1,
      });
    });
  });

  it("does not notify the parent again for a completion replayed while it is held", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, parent, session } = seedActiveChild(harness);
      runThreadLifecycleTransaction(harness.deps, child.id, {
        type: "request.sent",
        request: {
          hostId: host.id,
          kind: "steer",
          requestId: "creq_child_steer",
          syncTitle: false,
        },
        now: Date.now(),
      });
      vi.useFakeTimers();
      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [resultEnvelope(child.id), completionEnvelope(child.id)],
      });
      const held = { status: "completed", turnId: TURN_ID };
      expect(readThreadRunState(harness.db, child.id).heldCompletion).toEqual(
        held,
      );
      await deliverDueNotices();
      await vi.waitFor(() =>
        expect(parentDelivery(harness, parent.id)).toEqual({
          queued: 0,
          results: [{ kind: "child-completed", resultCopies: 1 }],
          submissions: 1,
        }),
      );

      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [completionEnvelope(child.id)],
      });
      await deliverDueNotices();

      expect(getThread(harness.db, child.id)?.status).toBe("active");
      expect(readThreadRunState(harness.db, child.id).heldCompletion).toEqual(
        held,
      );
      expect(childCompletions(harness, child.id)).toEqual([
        { status: "completed", handled: true },
        { status: "completed", handled: false },
      ]);
      expect(parentDelivery(harness, parent.id)).toEqual({
        queued: 0,
        results: [{ kind: "child-completed", resultCopies: 1 }],
        submissions: 1,
      });
    });
  });

  it("delivers the successful result once when two completions follow a server-recorded interruption", async () => {
    await withTestHarness(async (harness) => {
      const { child, host, parent, session } = seedActiveChild(harness);
      vi.useFakeTimers();
      await finishThreadLifecycle(
        harness.deps,
        runThreadLifecycleTransaction(harness.deps, child.id, {
          type: "daemon.lost",
          reason: "host-daemon-restarted",
          resuming: false,
        }),
      );
      expect(childCompletions(harness, child.id)).toEqual([
        { status: "interrupted", handled: false },
      ]);
      expect(listQueuedThreadMessages(harness.db, parent.id)).toHaveLength(1);

      await postEvents(harness, {
        hostId: host.id,
        sessionId: session.id,
        envelopes: [
          resultEnvelope(child.id),
          completionEnvelope(child.id),
          completionEnvelope(child.id),
        ],
      });
      await deliverDueNotices();

      expect(childCompletions(harness, child.id)).toEqual([
        { status: "interrupted", handled: false },
        { status: "completed", handled: true },
        { status: "completed", handled: false },
      ]);
      await vi.waitFor(() =>
        expect(parentDelivery(harness, parent.id)).toEqual({
          queued: 0,
          results: [{ kind: "child-completed", resultCopies: 1 }],
          submissions: 1,
        }),
      );
    });
  });
});

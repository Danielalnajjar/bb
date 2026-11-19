import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import {
  copyStoredThreadEventsInTransaction,
  createConnection,
  deleteThreadEventSuffixInTransaction,
  getDatabaseDataVersion,
  getThread,
  getThreadEventRewriteGeneration,
  insertEvents,
  listStoredEventRows,
  noopNotifier,
  setAppSettings,
} from "@bb/db";
import {
  DEFAULT_COMPLETED_TURN_DISPLAY,
  defaultAppSettings,
  encodeClientTurnRequestIdNumber,
  THREAD_CONTEXT_CLEAR_OPERATION,
  threadScope,
  turnScope,
} from "@bb/domain";
import { threadConversationOutlineResponseSchema } from "@bb/server-contract";
import { closeThreadReader } from "../../src/services/threads/thread-reads.js";
import { buildThreadConversationOutline } from "../../src/services/threads/timeline.js";
import { withTestHarness } from "../helpers/test-app.js";
import { seedEvent, seedThreadFixture } from "../helpers/seed.js";

function timelineCommand(threadId: string, environmentId: string) {
  return {
    threadId,
    environmentId,
    sequence: 10,
    providerThreadId: "provider-thread-1",
    type: "item/completed" as const,
    scope: turnScope("turn-1"),
    data: {
      item: {
        id: "command-1",
        type: "commandExecution" as const,
        command: "pwd",
        cwd: "/tmp/test",
        status: "completed" as const,
        approvalStatus: null,
        aggregatedOutput: "/tmp/test",
        exitCode: 0,
      },
    },
  };
}

describe("file-backed public outline reads", () => {
  it("matches a cold outline when an unresolved steer is rejected without changing thread status", async () => {
    await withTestHarness({ fileBackedDb: true }, async (harness) => {
      const { thread, environment } = seedThreadFixture(harness, {
        thread: { status: "idle" },
      });
      const url = `/api/v1/threads/${thread.id}/conversation-outline`;
      const common = {
        threadId: thread.id,
        environmentId: environment.id,
        scope: threadScope(),
      };
      const requestId = encodeClientTurnRequestIdNumber({ value: 1 });
      seedEvent(harness.deps, {
        ...common,
        sequence: 1,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          requestId,
          source: "tell",
          initiator: "user",
          senderThreadId: null,
          input: [{ type: "text", text: "Rejected steer", mentions: [] }],
          target: { kind: "steer", expectedTurnId: "turn-1" },
          request: { method: "turn/start", params: {} },
          execution: {
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
            serviceTier: "default",
          },
        },
      });
      expect(await (await harness.app.request(url)).json()).toEqual({
        items: [],
        maxSeq: 1,
      });
      seedEvent(harness.deps, {
        ...common,
        sequence: 2,
        type: "client/turn/rejected",
        data: {
          requestId,
          reason: "command_failed",
          message: "Steer rejected",
        },
      });
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      const coldDb = createConnection(harness.db.$client.name, {
        readonly: true,
      });
      try {
        const cold = buildThreadConversationOutline(coldDb, thread, {
          completedTurnDisplay: DEFAULT_COMPLETED_TURN_DISPLAY,
          includeClearedContextHistory: false,
          maxSeq: 2,
        });
        expect(cold.items).toEqual([
          expect.objectContaining({ preview: "Rejected steer", role: "user" }),
        ]);
        const warm = await harness.app.request(url);
        expect(warm.status).toBe(200);
        expect(await warm.json()).toEqual(cold);
      } finally {
        coldDb.$client.close();
      }
    });
  });

  it("keeps the earlier outline when its worker snapshots a clear after the setting changed", async () => {
    await withTestHarness({ fileBackedDb: true }, async (harness) => {
      const { thread, environment } = seedThreadFixture(harness);
      const url = `/api/v1/threads/${thread.id}/conversation-outline`;
      const common = {
        threadId: thread.id,
        environmentId: environment.id,
        scope: threadScope(),
      };
      seedEvent(harness.deps, {
        ...common,
        sequence: 1,
        type: "system/manager/user_message",
        data: { text: "Earlier task" },
      });
      const send = Worker.prototype.postMessage;
      const dispatch = vi.spyOn(Worker.prototype, "postMessage");
      dispatch.mockImplementationOnce(function (this: Worker, ...args) {
        setAppSettings(harness.db, {
          ...defaultAppSettings,
          keepHistoryAfterContextClear: true,
        });
        seedEvent(harness.deps, {
          ...common,
          sequence: 2,
          type: "system/operation",
          data: {
            operation: THREAD_CONTEXT_CLEAR_OPERATION,
            operationId: "clear",
            status: "completed",
            message: "Fresh context",
          },
        });
        send.apply(this, args);
      });
      try {
        const response = await harness.app.request(url);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          items: [expect.objectContaining({ preview: "Earlier task" })],
          maxSeq: 2,
        });
      } finally {
        dispatch.mockRestore();
      }
    });
  });

  it("does not write the database or lose cached outlines across independent reads and timeline-only appends", async () => {
    await withTestHarness({ fileBackedDb: true }, async (harness) => {
      const stable = seedThreadFixture(harness);
      const changing = seedThreadFixture(harness);
      seedEvent(harness.deps, {
        threadId: stable.thread.id,
        environmentId: stable.environment.id,
        sequence: 9,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "Stable response 😀" },
      });
      const url = `/api/v1/threads/${stable.thread.id}/conversation-outline`;
      const version = getDatabaseDataVersion(harness.db);
      const first = await harness.app.request(url);
      expect(first.status).toBe(200);
      const bytes = await first.text();
      expect(
        (
          await harness.app.request(
            `/api/v1/threads/${changing.thread.id}/conversation-outline`,
          )
        ).status,
      ).toBe(200);
      expect(getDatabaseDataVersion(harness.db)).toBe(version);
      await closeThreadReader(harness.db);
      seedEvent(
        harness.deps,
        timelineCommand(stable.thread.id, stable.environment.id),
      );
      const cached = await harness.app.request(url);
      expect(cached.status).toBe(200);
      expect(await cached.text()).toBe(
        bytes.replace(/"maxSeq":9}$/, '"maxSeq":10}'),
      );
    });
  });

  it("refreshes a previously read outline after a fork batch copies events", async () => {
    await withTestHarness({ fileBackedDb: true }, async (harness) => {
      const source = seedThreadFixture(harness);
      const fork = seedThreadFixture(harness);
      const path = `/api/v1/threads/${fork.thread.id}/conversation-outline`;
      seedEvent(harness.deps, {
        threadId: source.thread.id,
        environmentId: source.environment.id,
        sequence: 1,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "Copied fixture response" },
      });
      const initial = await harness.app.request(path);
      expect(await initial.json()).toEqual({ items: [], maxSeq: 0 });
      const rows = listStoredEventRows(harness.db, {
        threadId: source.thread.id,
      });
      harness.db.transaction((tx) =>
        copyStoredThreadEventsInTransaction(tx, {
          rows,
          targetEnvironmentId: fork.environment.id,
          targetThreadId: fork.thread.id,
        }),
      );
      const refreshed = await harness.app.request(path);
      expect(refreshed.status).toBe(200);
      const outline = threadConversationOutlineResponseSchema.parse(
        await refreshed.json(),
      );
      expect(outline.maxSeq).toBe(1);
      expect(outline.items).toEqual([
        expect.objectContaining({ preview: "Copied fixture response" }),
      ]);
    });
  });

  it("separates roles and rejects cached bytes after an external same-head rewrite", async () => {
    await withTestHarness({ fileBackedDb: true }, async (harness) => {
      const { thread, environment } = seedThreadFixture(harness);
      const url = `/api/v1/threads/${thread.id}/conversation-outline`;
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "Original response" },
      });
      const first = await harness.app.request(url);
      expect(await first.text()).toContain("Original response");
      const user = await harness.app.request(`${url}?role=user`);
      expect(await user.json()).toEqual({ items: [], maxSeq: 1 });
      const assistant = await harness.app.request(`${url}?role=assistant`);
      expect(await assistant.text()).toContain("Original response");
      const external = createConnection(harness.db.$client.name);
      try {
        external.transaction((tx) =>
          deleteThreadEventSuffixInTransaction(tx, {
            threadId: thread.id,
            cutoffSequence: 1,
            oldMaxSequence: 1,
          }),
        );
        insertEvents(external, noopNotifier, [
          {
            threadId: thread.id,
            sequence: 1,
            type: "system/manager/user_message",
            scope: threadScope(),
            itemId: null,
            itemKind: null,
            parentToolCallId: null,
            data: JSON.stringify({ text: "Replacement response" }),
          },
        ]);
      } finally {
        external.$client.close();
      }
      const rewritten = await harness.app.request(url);
      expect(rewritten.status).toBe(200);
      const rewrittenBytes = await rewritten.text();
      expect(rewrittenBytes).toContain("Replacement response");
      expect(rewrittenBytes).not.toContain("Original response");
      expect(
        threadConversationOutlineResponseSchema.parse(
          JSON.parse(rewrittenBytes),
        ).maxSeq,
      ).toBe(1);
    });
  });

  it("refreshes cached bytes and a frozen turn after a raw external update and local append", async () => {
    await withTestHarness({ fileBackedDb: true }, async (harness) => {
      const { thread, environment } = seedThreadFixture(harness);
      const url = `/api/v1/threads/${thread.id}/conversation-outline`;
      const common = {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
      };
      seedEvent(harness.deps, {
        ...common,
        sequence: 1,
        type: "turn/started",
        data: { providerThreadId: common.providerThreadId },
      });
      seedEvent(harness.deps, {
        ...common,
        sequence: 2,
        type: "item/completed",
        data: {
          item: { id: "answer", type: "agentMessage", text: "Original answer" },
        },
      });
      seedEvent(harness.deps, {
        ...common,
        sequence: 3,
        type: "turn/completed",
        data: { status: "completed" },
      });
      seedEvent(harness.deps, {
        ...common,
        scope: turnScope("turn-2"),
        sequence: 4,
        type: "turn/started",
        data: { providerThreadId: common.providerThreadId },
      });
      const first = await harness.app.request(url);
      expect(first.status).toBe(200);
      expect(await first.text()).toContain("Original answer");

      const before = getDatabaseDataVersion(harness.db);
      const generation = getThreadEventRewriteGeneration(thread.id);
      const external = createConnection(harness.db.$client.name);
      try {
        external.$client
          .prepare(
            "UPDATE events SET data = json_set(data, '$.item.text', ?) WHERE thread_id = ? AND sequence = 2",
          )
          .run("Updated answer", thread.id);
      } finally {
        external.$client.close();
      }
      const after = getDatabaseDataVersion(harness.db);
      expect(after).not.toBe(before);
      seedEvent(harness.deps, {
        ...timelineCommand(thread.id, environment.id),
        scope: turnScope("turn-2"),
        sequence: 5,
      });
      expect(getDatabaseDataVersion(harness.db)).toBe(after);
      expect(getThreadEventRewriteGeneration(thread.id)).toBe(generation);

      const refreshed = await harness.app.request(url);
      expect(refreshed.status).toBe(200);
      expect(await refreshed.json()).toMatchObject({
        items: [expect.objectContaining({ preview: "Updated answer" })],
        maxSeq: 5,
      });
    });
  });
});

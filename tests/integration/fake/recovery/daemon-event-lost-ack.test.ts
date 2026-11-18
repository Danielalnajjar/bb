import { listEvents } from "@bb/db/testing";
import { turnScope, type ThreadEvent } from "@bb/domain";
import {
  hostDaemonEventBatchResponseSchema,
  type HostDaemonEventBatchResponse,
} from "@bb/host-daemon-contract";
import {
  threadTimelineResponseSchema,
  type TimelineRow,
} from "@bb/server-contract";
import { afterEach, expect, it, vi } from "vitest";
import { createEventSink } from "../../../../apps/host-daemon/src/event-sink.js";
import { createServerClient } from "../../../../apps/host-daemon/src/server-client.js";
import {
  seedThreadFixture,
  seedTurnStarted,
} from "../../../../apps/server/test/helpers/seed.js";
import {
  createTestDaemonHostKey,
  testLogger,
  withTestHarness,
  type TestAppHarness,
} from "../../../../apps/server/test/helpers/test-app.js";

function assistantText(rows: readonly TimelineRow[]): string[] {
  return rows.flatMap((row) => {
    if (row.kind === "conversation" && row.role === "assistant")
      return [row.text];
    if (row.kind === "turn" && row.children !== null)
      return assistantText(row.children);
    return [];
  });
}

async function readAssistantText(harness: TestAppHarness, threadId: string) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/timeline`,
  );
  expect(response.status).toBe(200);
  return assistantText(
    threadTimelineResponseSchema.parse(await response.json()).rows,
  );
}

afterEach(() => vi.useRealTimers());

it.fails("T3 roadmap §2 D1: retries committed daemon event batches after losing HTTP acknowledgments", async () => {
  await withTestHarness(async (harness) => {
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
      thread: { status: "active" },
    });
    const ids = {
      threadId: thread.id,
      providerThreadId: "provider-replayed-events",
      scope: turnScope("turn-replayed-events"),
    };
    seedTurnStarted(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: ids.providerThreadId,
      turnId: "turn-replayed-events",
    });

    const receipts: HostDaemonEventBatchResponse[] = [];
    const transportErrors: string[] = [];
    const client = createServerClient({
      serverUrl: "http://127.0.0.1",
      hostKey: createTestDaemonHostKey({ hostId: host.id }),
      getSessionId: () => session.id,
      logger: testLogger,
      fetchFn: async (url, init) => {
        const response = await harness.app.request(url, init);
        if (!response.ok) {
          transportErrors.push(
            `${response.status} ${await response.clone().text()}`,
          );
          return response;
        }
        receipts.push(
          hostDaemonEventBatchResponseSchema.parse(
            await response.clone().json(),
          ),
        );
        if (receipts.length === 1 || receipts.length === 3) {
          throw new TypeError("Connection closed after SQLite committed");
        }
        return response;
      },
    });
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: testLogger,
      postEvents: client.postEvents,
    });
    const emit = (event: ThreadEvent) =>
      sink.emit({ threadId: thread.id, event });
    const text = "Echo\nEcho\n";
    try {
      emit({
        ...ids,
        type: "item/started",
        item: { id: "assistant", type: "agentMessage", text: "" },
      });
      const delta = {
        ...ids,
        type: "item/agentMessage/delta" as const,
        itemId: "assistant",
        delta: "Echo\n",
      };
      emit(delta);
      emit({ ...delta });
      await sink.flush();
      expect(transportErrors).toEqual([]);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.rejectedEvents).toEqual([]);
      expect(sink.listUndeliveredThreadIds()).toEqual([thread.id]);
      expect(await readAssistantText(harness, thread.id)).toEqual([text]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(receipts).toHaveLength(2);
      expect(sink.listUndeliveredThreadIds()).toEqual([]);
      const partialAfterRetry = await readAssistantText(harness, thread.id);

      emit({
        ...ids,
        type: "item/completed",
        item: { id: "assistant", type: "agentMessage", text },
      });
      emit({ ...ids, type: "turn/completed", status: "completed" });
      await sink.flush();
      expect(receipts).toHaveLength(3);
      expect(sink.listUndeliveredThreadIds()).toEqual([thread.id]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(receipts).toHaveLength(4);
      expect(sink.listUndeliveredThreadIds()).toEqual([]);
      const final = await readAssistantText(harness, thread.id);
      const persisted = listEvents(harness.db, { threadId: thread.id });
      const count = (type: string) =>
        persisted.filter((row) => row.type === type).length;

      expect({
        partialAfterRetry,
        final,
        starts: count("item/started"),
        deltas: count("item/agentMessage/delta"),
        itemCompletions: count("item/completed"),
        turnCompletions: count("turn/completed"),
      }).toEqual({
        partialAfterRetry: [text],
        final: [text],
        starts: 1,
        deltas: 2,
        itemCompletions: 1,
        turnCompletions: 1,
      });
    } finally {
      await sink.dispose();
    }
  });
});

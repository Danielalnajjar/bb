import { describe, expect, it } from "vitest";
import {
  createConnection,
  deleteThreadEventSuffixInTransaction,
  getDatabaseDataVersion,
  insertEvents,
  noopNotifier,
} from "@bb/db";
import { threadScope, turnScope } from "@bb/domain";
import { threadConversationOutlineResponseSchema } from "@bb/server-contract";
import { closeThreadReader } from "../../src/services/threads/thread-reads.js";
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
});

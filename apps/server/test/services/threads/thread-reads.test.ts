import { describe, expect, it, onTestFinished } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  defaultAppSettings,
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@bb/domain";
import {
  archiveThread,
  createConnection,
  createProject,
  createThread,
  deleteThreadEventSuffixInTransaction,
  getThreadEventRewriteGeneration,
  insertEvents,
  listThreadsWithPendingInteractionState,
  noopNotifier,
  searchThreadsWithPendingInteractionState,
  setAppSettings,
  upsertHost,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import {
  getThreadMessage,
  loadThreadConversationOutline,
} from "../../../src/services/threads/timeline.js";
import {
  closeThreadReader,
  readThreadData,
} from "../../../src/services/threads/thread-reads.js";

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "thread-reads-"));
  const filename = join(directory, "test.db");
  const seed = createMigratedConnection();
  try {
    writeFileSync(filename, seed.$client.serialize());
  } finally {
    seed.$client.close();
  }
  const db = createConnection(filename);
  onTestFinished(async () => {
    await closeThreadReader(db);
    db.$client.close();
    rmSync(directory, { recursive: true });
  });
  const host = upsertHost(db, noopNotifier, { name: "host" });
  const { project } = createProject(db, noopNotifier, {
    name: "project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/thread-reads" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
    title: "Search alpha",
    status: "idle",
  });
  const append = (sequence: number, text: string) =>
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence,
        type: "system/manager/user_message",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ text }),
      },
    ]);
  const outline = (role: "user" | "assistant" | null = null) =>
    readThreadData(db, {
      kind: "outline",
      threadId: thread.id,
      providerCompletedTurnDisplay: "collapse",
      providerDisplayName: null,
      eventRewriteGeneration: getThreadEventRewriteGeneration(thread.id),
      role,
    });
  return { db, thread, append, outline };
}

describe("thread read isolation", () => {
  it("returns exact outline bytes and role filtering after append and same-head rewrite", async () => {
    const { db, thread, append, outline } = setup();
    setAppSettings(db, {
      ...defaultAppSettings,
      keepHistoryAfterContextClear: true,
    });
    append(1, "alpha first 😀");
    const first = await outline();
    expect(first.kind).toBe("outline");
    if (first.kind !== "outline") throw new Error("Expected outline");
    const expected = loadThreadConversationOutline(db, thread, {
      completedTurnDisplay: "collapse",
      includeClearedContextHistory: true,
      maxSeq: 1,
    });
    expect(new TextDecoder().decode(first.bytes)).toBe(
      JSON.stringify(expected),
    );
    append(2, "alpha second");
    const second = await outline();
    expect(second.kind === "outline" && second.maxSeq).toBe(2);
    db.transaction((tx) =>
      deleteThreadEventSuffixInTransaction(tx, {
        threadId: thread.id,
        cutoffSequence: 2,
        oldMaxSequence: 2,
      }),
    );
    append(2, "alpha replaced");
    const replaced = await outline();
    if (replaced.kind !== "outline") throw new Error("Expected outline");
    expect(new TextDecoder().decode(replaced.bytes)).toContain(
      "alpha replaced",
    );
    expect(new TextDecoder().decode(replaced.bytes)).not.toContain(
      "alpha second",
    );
    const assistant = await outline("assistant");
    if (assistant.kind !== "outline") throw new Error("Expected outline");
    expect(new TextDecoder().decode(assistant.bytes)).toBe(
      new TextDecoder().decode(replaced.bytes),
    );
    const filtered = await outline("user");
    if (filtered.kind !== "outline") throw new Error("Expected outline");
    expect(JSON.parse(new TextDecoder().decode(filtered.bytes))).toEqual({
      items: [],
      maxSeq: 2,
    });
  });

  it("preserves search ranking, totals and match bytes across worker requests", async () => {
    const { db, append } = setup();
    append(1, "beta in another segment");
    for (const query of ["alpha", "alpha beta", "in", "missingneedle"]) {
      const expected = searchThreadsWithPendingInteractionState(db, {
        query,
        limitPerGroup: 20,
      });
      const result = await readThreadData(db, {
        kind: "search",
        query,
        limitPerGroup: 20,
      });
      expect(result).toEqual({ kind: "search", results: expected });
    }
  });

  it("rejects missing-thread work without losing subsequent requests and closes queued work", async () => {
    const { db } = setup();
    await expect(
      readThreadData(db, {
        kind: "outline",
        threadId: "missing",
        providerCompletedTurnDisplay: "collapse",
        providerDisplayName: null,
        eventRewriteGeneration: 0,
        role: null,
      }),
    ).rejects.toThrow("Thread not found");
    const search = readThreadData(db, {
      kind: "search",
      query: "alpha",
      limitPerGroup: 20,
    });
    await expect(search).resolves.toMatchObject({ kind: "search" });
  });

  it("returns message bytes with context, 404 ApiError, and same-head rewrite invalidation", async () => {
    const { db, thread } = setup();
    const requestEvent = (
      sequence: number,
      requestId: number,
      text: string,
    ) => ({
      threadId: thread.id,
      sequence,
      type: "client/turn/requested" as const,
      scope: threadScope(),
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: JSON.stringify({
        direction: "outbound",
        requestId: encodeClientTurnRequestIdNumber({ value: requestId }),
        input: [{ type: "text", text, mentions: [] }],
        target: { kind: "new-turn" },
        execution: {
          model: "gpt-4o-mini",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "fast",
          source: "client/turn/requested",
        },
        initiator: "user",
        senderThreadId: null,
        request: { method: "turn/start", params: {} },
        source: "tell",
      }),
    });
    const replyEvent = (
      sequence: number,
      requestId: number,
      itemId: string,
      text: string,
    ) => [
      {
        threadId: thread.id,
        sequence: sequence - 2,
        providerThreadId: "provider-thread-1",
        type: "turn/started" as const,
        scope: turnScope(`turn-${requestId}`),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({}),
      },
      {
        threadId: thread.id,
        sequence: sequence - 1,
        providerThreadId: "provider-thread-1",
        type: "turn/input/accepted" as const,
        scope: turnScope(`turn-${requestId}`),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          clientRequestId: encodeClientTurnRequestIdNumber({
            value: requestId,
          }),
        }),
      },
      {
        threadId: thread.id,
        sequence,
        providerThreadId: "provider-thread-1",
        type: "item/completed" as const,
        scope: turnScope(`turn-${requestId}`),
        itemId,
        itemKind: "agentMessage" as const,
        parentToolCallId: null,
        data: JSON.stringify({
          item: { type: "agentMessage", id: itemId, text },
        }),
      },
    ];
    insertEvents(db, noopNotifier, [
      requestEvent(1, 101, "prompt one"),
      ...replyEvent(4, 101, "a-1", "reply one 😀"),
      requestEvent(5, 102, "prompt two"),
      ...replyEvent(8, 102, "a-2", "reply two"),
    ]);

    const readMsg = (seq: number, before = 0, after = 0) =>
      readThreadData(db, {
        kind: "message",
        threadId: thread.id,
        providerCompletedTurnDisplay: "collapse",
        providerDisplayName: null,
        eventRewriteGeneration: getThreadEventRewriteGeneration(thread.id),
        seq,
        before,
        after,
      });

    const result = await readMsg(4, 1, 1);
    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("Expected message");
    const expected = getThreadMessage(db, thread, {
      completedTurnDisplay: "collapse",
      includeClearedContextHistory: false,
      maxSeq: 8,
      seq: 4,
      before: 1,
      after: 1,
    });
    expect(JSON.parse(new TextDecoder().decode(result.bytes))).toEqual(
      expected,
    );

    await expect(readMsg(99)).rejects.toMatchObject({
      status: 404,
      body: { code: "message_not_found" },
    });

    db.transaction((tx) =>
      deleteThreadEventSuffixInTransaction(tx, {
        threadId: thread.id,
        cutoffSequence: 8,
        oldMaxSequence: 8,
      }),
    );
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 8,
        providerThreadId: "provider-thread-1",
        type: "item/completed",
        scope: turnScope("turn-102"),
        itemId: "a-2",
        itemKind: "agentMessage",
        parentToolCallId: null,
        data: JSON.stringify({
          item: { type: "agentMessage", id: "a-2", text: "reply replaced" },
        }),
      },
    ]);
    const replaced = await readMsg(8);
    if (replaced.kind !== "message") throw new Error("Expected message");
    const decoded = new TextDecoder().decode(replaced.bytes);
    expect(decoded).toContain("reply replaced");
    expect(decoded).not.toContain("reply two");
  });

  it("offloads archived thread lists to the list lane and closes both lanes", async () => {
    const { db, thread } = setup();
    const archivedThread = createThread(db, noopNotifier, {
      projectId: thread.projectId,
      providerId: "codex",
      title: "Archived alpha",
      status: "idle",
    });
    archiveThread(db, noopNotifier, archivedThread.id);

    for (const options of [
      { includeHidden: true },
      { archived: true, includeHidden: false },
    ]) {
      const expected = listThreadsWithPendingInteractionState(db, options);
      const result = await readThreadData(db, { kind: "list", options });
      expect(result).toEqual({ kind: "list", threads: expected });
    }

    const pendingHeavy = readThreadData(db, {
      kind: "search",
      query: "alpha",
      limitPerGroup: 20,
    });
    const pendingList = readThreadData(db, {
      kind: "list",
      options: { archived: true },
    });
    const rejectedHeavy = expect(pendingHeavy).rejects.toThrow(
      "Thread reader closed",
    );
    const rejectedList = expect(pendingList).rejects.toThrow(
      "Thread reader closed",
    );
    await closeThreadReader(db);
    await rejectedHeavy;
    await rejectedList;
    await expect(
      readThreadData(db, { kind: "search", query: "alpha", limitPerGroup: 20 }),
    ).rejects.toThrow("Thread reader closed");
    await expect(
      readThreadData(db, { kind: "list", options: { archived: true } }),
    ).rejects.toThrow("Thread reader closed");
  });
});

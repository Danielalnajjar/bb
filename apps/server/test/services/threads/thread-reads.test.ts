import { describe, expect, it, onTestFinished } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { threadScope } from "@bb/domain";
import {
  createConnection,
  createProject,
  createThread,
  deleteThreadEventSuffixInTransaction,
  getThreadEventRewriteGeneration,
  insertEvents,
  noopNotifier,
  searchThreadsWithPendingInteractionState,
  upsertHost,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { loadThreadConversationOutline } from "../../../src/services/threads/timeline.js";
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
      completedTurnDisplay: "collapse",
      includeClearedContextHistory: true,
      providerDisplayName: null,
      eventRewriteGeneration: getThreadEventRewriteGeneration(thread.id),
      role,
    });
  return { db, thread, append, outline };
}

describe("thread read isolation", () => {
  it("returns exact outline bytes and role filtering after append and same-head rewrite", async () => {
    const { db, thread, append, outline } = setup();
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
        completedTurnDisplay: "collapse",
        includeClearedContextHistory: true,
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
    const pending = readThreadData(db, {
      kind: "search",
      query: "alpha",
      limitPerGroup: 20,
    });
    const rejected = expect(pending).rejects.toThrow("Thread reader closed");
    await closeThreadReader(db);
    await rejected;
    await expect(
      readThreadData(db, { kind: "search", query: "alpha", limitPerGroup: 20 }),
    ).rejects.toThrow("Thread reader closed");
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PERSONAL_PROJECT_ID, threadScope } from "@bb/domain";
import { createThread, insertEvents, noopNotifier } from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { initDb } from "../src/db.js";

it("clears obsolete derived outlines on startup without changing schema, migration history or source data", () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-outline-cache-"));
  const seed = createMigratedConnection();
  try {
    const thread = createThread(seed, noopNotifier, {
      projectId: PERSONAL_PROJECT_ID,
      providerId: "codex",
      status: "idle",
    });
    insertEvents(seed, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/manager/user_message",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ text: "Rebuild this response 😀" }),
      },
    ]);
    seed.$client
      .prepare("INSERT INTO thread_conversation_outlines VALUES (?, ?, ?)")
      .run(thread.id, "obsolete", "[]");
    const tables = [
      "sqlite_schema",
      "__drizzle_migrations",
      "threads",
      "events",
    ];
    const before = tables.map((table) =>
      seed.$client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
    const databasePath = join(dir, "bb.db");
    writeFileSync(databasePath, seed.$client.serialize());
    for (let startup = 0; startup < 2; startup += 1) {
      const db = initDb(databasePath);
      try {
        expect(
          db.$client
            .prepare("SELECT * FROM thread_conversation_outlines")
            .all(),
        ).toEqual([]);
        expect(
          tables.map((table) =>
            db.$client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
          ),
        ).toEqual(before);
      } finally {
        db.$client.close();
      }
    }
  } finally {
    seed.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

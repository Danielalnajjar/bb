import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { PERSONAL_PROJECT_ID, threadScope } from "@bb/domain";
import {
  createThread,
  insertEvents,
  migrate,
  noopNotifier,
} from "../src/index.js";
import { createMigratedConnection } from "../src/testing.js";

it("retires cached outlines on upgrade without modifying their source threads or events", () => {
  const db = createMigratedConnection();
  try {
    const thread = createThread(db, noopNotifier, {
      projectId: PERSONAL_PROJECT_ID,
      providerId: "codex",
      status: "idle",
    });
    insertEvents(db, noopNotifier, [
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
    const threadsBefore = db.$client
      .prepare("SELECT * FROM threads ORDER BY id")
      .all();
    const eventsBefore = db.$client
      .prepare("SELECT * FROM events ORDER BY id")
      .all();
    const missing = () =>
      db.$client
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'thread_conversation_outlines'",
        )
        .all();
    expect(missing()).toEqual([]);
    db.$client.exec(
      readFileSync(
        new URL("../drizzle/0110_many_kree.sql", import.meta.url),
        "utf8",
      ),
    );
    db.$client
      .prepare("INSERT INTO thread_conversation_outlines VALUES (?, ?, ?)")
      .run(thread.id, "obsolete", "[]");
    db.$client
      .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
      .run(1794794010571);
    migrate(db);
    migrate(db);
    expect(missing()).toEqual([]);
    expect(
      db.$client.prepare("SELECT * FROM threads ORDER BY id").all(),
    ).toEqual(threadsBefore);
    expect(
      db.$client.prepare("SELECT * FROM events ORDER BY id").all(),
    ).toEqual(eventsBefore);
  } finally {
    db.$client.close();
  }
});

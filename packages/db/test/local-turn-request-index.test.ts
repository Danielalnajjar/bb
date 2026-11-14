import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { threadScope } from "@bb/domain";
import { createConnection, type DbConnection } from "../src/connection.js";
import { createMigratedConnection } from "../src/testing.js";
import { initializeLocalTurnRequestIndex } from "../src/local-turn-request-index.js";
import {
  insertEvents,
  listStoredClientTurnRequestRowsByKeys,
} from "../src/data/events.js";
import { createProject } from "../src/data/projects.js";
import { createThread } from "../src/data/threads.js";
import { upsertHost } from "../src/data/hosts.js";
import { noopNotifier } from "../src/notifier.js";

const databases: DbConnection[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.$client.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true });
});

function setup(onDisk = false) {
  let db = createMigratedConnection();
  if (onDisk) {
    const directory = mkdtempSync(join(tmpdir(), "bb-local-request-index-"));
    directories.push(directory);
    const file = join(directory, "test.sqlite");
    writeFileSync(file, db.$client.serialize());
    db.$client.close();
    db = createConnection(file);
  }
  databases.push(db);
  const host = upsertHost(db, noopNotifier, { name: "test" });
  const { project } = createProject(db, noopNotifier, {
    name: "test",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const threads = Array.from({ length: 2 }, () =>
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    }),
  );
  for (const thread of threads) {
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ requestId: "creq_23456789ab" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "client/turn/requested",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ requestId: "creq_23456789aa" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "client/turn/requested",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ requestId: "creq_23456789ab" }),
      },
    ]);
  }
  const keys = [
    { threadId: threads[0]!.id, requestId: "creq_23456789ab" },
    { threadId: threads[0]!.id, requestId: "creq_23456789aa" },
    { threadId: threads[0]!.id, requestId: "creq_23456789ab" },
    { threadId: threads[1]!.id, requestId: "creq_23456789aa" },
    { threadId: threads[1]!.id, requestId: "creq_23456789az" },
  ];
  return { db, keys };
}

describe("local turn-request index", () => {
  it("preserves paired requests, duplicate events and sequence order without changing the migration journal", () => {
    const { db, keys } = setup();
    const baseline = listStoredClientTurnRequestRowsByKeys(db, { keys });
    expect(baseline).toHaveLength(4);
    const journal = db.$client
      .prepare("SELECT * FROM __drizzle_migrations")
      .all();
    initializeLocalTurnRequestIndex(db);
    initializeLocalTurnRequestIndex(db);
    expect(listStoredClientTurnRequestRowsByKeys(db, { keys })).toEqual(
      baseline,
    );
    expect(
      db.transaction((tx) =>
        listStoredClientTurnRequestRowsByKeys(tx, { keys }),
      ),
    ).toEqual(baseline);
    expect(
      db.$client.prepare("SELECT * FROM __drizzle_migrations").all(),
    ).toEqual(journal);
    const statements: string[] = [];
    const originalPrepare = db.$client.prepare.bind(db.$client);
    db.$client.prepare = ((query: string) => {
      statements.push(query);
      return originalPrepare(query);
    }) as typeof db.$client.prepare;
    try {
      listStoredClientTurnRequestRowsByKeys(db, { keys });
    } finally {
      db.$client.prepare = originalPrepare;
    }
    const query = statements.find((statement) =>
      statement.includes("INDEXED BY"),
    );
    expect(query).toBeDefined();
    const plan = db.$client
      .prepare(`EXPLAIN QUERY PLAN ${query}`)
      .all(
        ...[
          keys[0]!.threadId,
          keys[0]!.requestId,
          keys[1]!.requestId,
          keys[3]!.threadId,
          keys[3]!.requestId,
          keys[4]!.requestId,
        ],
      ) as { detail: string }[];
    expect(
      plan.filter(
        (row) =>
          row.detail.includes(
            "SEARCH events USING INDEX local_bb_turn_request_thread_request_sequence_idx",
          ) && row.detail.includes("<expr>=?"),
      ),
    ).toHaveLength(2);
  });

  it("continues using the original lookup when another writer prevents startup index creation", () => {
    const { db, keys } = setup(true);
    const baseline = listStoredClientTurnRequestRowsByKeys(db, { keys });
    const writer = new Database(db.$client.name);
    writer.exec("BEGIN IMMEDIATE");
    db.$client.pragma("busy_timeout = 1");
    const codes: string[] = [];
    try {
      initializeLocalTurnRequestIndex(db, {
        warn: (fields) => codes.push(fields.code),
      });
      expect(codes).toEqual(["SQLITE_BUSY"]);
      expect(listStoredClientTurnRequestRowsByKeys(db, { keys })).toEqual(
        baseline,
      );
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    expect(db.$client.inTransaction).toBe(false);
  });

  it("continues using the original lookup when index creation runs out of pages", () => {
    const { db, keys } = setup(true);
    const baseline = listStoredClientTurnRequestRowsByKeys(db, { keys });
    db.$client.exec("CREATE TABLE fill_space (data BLOB)");
    while (Number(db.$client.pragma("freelist_count", { simple: true })) > 0) {
      db.$client.exec("INSERT INTO fill_space VALUES (zeroblob(4096))");
    }
    const pages = db.$client.pragma("page_count", { simple: true });
    db.$client.pragma(`max_page_count = ${pages}`);
    const codes: string[] = [];
    initializeLocalTurnRequestIndex(db, {
      warn: (fields) => codes.push(fields.code),
    });
    expect(codes).toEqual(["SQLITE_FULL"]);
    expect(db.$client.inTransaction).toBe(false);
    expect(listStoredClientTurnRequestRowsByKeys(db, { keys })).toEqual(
      baseline,
    );
    expect(
      db.$client
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'local_bb_turn_request_thread_request_sequence_idx'",
        )
        .get(),
    ).toBeUndefined();
  });

  it("continues using the original lookup when expression evaluation interrupts the index build", () => {
    const { db, keys } = setup();
    const baseline = listStoredClientTurnRequestRowsByKeys(db, { keys });
    let interrupted = false;
    db.$client.function(
      "json_extract",
      { deterministic: true },
      (value, path) => {
        if (!interrupted) {
          interrupted = true;
          throw new Database.SqliteError("interrupted", "SQLITE_INTERRUPT");
        }
        const data = JSON.parse(String(value)) as { requestId?: string };
        return path === "$.requestId" ? (data.requestId ?? null) : null;
      },
    );
    const codes: string[] = [];
    initializeLocalTurnRequestIndex(db, {
      warn: (fields) => codes.push(fields.code),
    });
    expect(codes).toEqual(["SQLITE_INTERRUPT"]);
    expect(db.$client.inTransaction).toBe(false);
    expect(listStoredClientTurnRequestRowsByKeys(db, { keys })).toEqual(
      baseline,
    );
    expect(
      db.$client
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'local_bb_turn_request_thread_request_sequence_idx'",
        )
        .get(),
    ).toBeUndefined();
  });
});

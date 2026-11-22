import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  type ClientTurnRequestId,
} from "@bb/domain";
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
  const requestIdB = encodeClientTurnRequestIdNumber({
    value: 1,
  }) as ClientTurnRequestId;
  const requestIdA = encodeClientTurnRequestIdNumber({
    value: 2,
  }) as ClientTurnRequestId;
  const requestIdMissing = encodeClientTurnRequestIdNumber({
    value: 99,
  }) as ClientTurnRequestId;
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
        data: JSON.stringify({ requestId: requestIdB }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "client/turn/requested",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ requestId: requestIdA }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "client/turn/requested",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ requestId: requestIdB }),
      },
    ]);
  }
  const keys = [
    {
      threadId: threads[0]!.id,
      requestId: requestIdB,
      acceptedSequence: 10,
    },
    {
      threadId: threads[0]!.id,
      requestId: requestIdA,
      acceptedSequence: 10,
    },
    {
      threadId: threads[0]!.id,
      requestId: requestIdB,
      acceptedSequence: 10,
    },
    {
      threadId: threads[1]!.id,
      requestId: requestIdA,
      acceptedSequence: 10,
    },
    {
      threadId: threads[1]!.id,
      requestId: requestIdMissing,
      acceptedSequence: 10,
    },
  ];
  return { db, keys };
}

describe("local turn-request index", () => {
  it("preserves paired requests, duplicate keys and sequence order without changing the migration journal", () => {
    const { db, keys } = setup();
    const baseline = listStoredClientTurnRequestRowsByKeys(db, { keys });
    expect(baseline).toHaveLength(3);
    const journal = db.$client
      .prepare("SELECT * FROM __drizzle_migrations")
      .all();
    db.$client.exec(
      `CREATE INDEX local_bb_turn_request_thread_request_sequence_idx ON events(thread_id, json_extract(data, '$.requestId'), sequence) WHERE type='client/turn/requested'`,
    );
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
    const captured: { query: string; params: unknown[] }[] = [];
    const originalPrepare = db.$client.prepare.bind(db.$client);
    db.$client.prepare = ((query: string) => {
      const stmt = originalPrepare(query);
      if (query.includes("local_bb_turn_request_thread_request_sequence_idx")) {
        const originalAll = stmt.all.bind(stmt);
        stmt.all = ((...params: unknown[]) => {
          captured.push({ query, params });
          return originalAll(...params);
        }) as typeof stmt.all;
      }
      return stmt;
    }) as typeof db.$client.prepare;
    try {
      listStoredClientTurnRequestRowsByKeys(db, { keys });
    } finally {
      db.$client.prepare = originalPrepare;
    }
    expect(captured.length).toBeGreaterThan(0);
    const plan = db.$client
      .prepare(`EXPLAIN QUERY PLAN ${captured[0]!.query}`)
      .all(...captured[0]!.params) as { detail: string }[];
    expect(
      plan.some(
        (row) =>
          row.detail.includes(
            "SEARCH candidate USING INDEX local_bb_turn_request_thread_request_sequence_idx",
          ) && row.detail.includes("<expr>=?"),
      ),
    ).toBe(true);
  });

  it("keeps startup read-only with a missing index and a competing writer", () => {
    const { db, keys } = setup(true);
    const baseline = listStoredClientTurnRequestRowsByKeys(db, { keys });
    const writer = new Database(db.$client.name);
    writer.exec("BEGIN IMMEDIATE");
    try {
      initializeLocalTurnRequestIndex(db);
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
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });
});

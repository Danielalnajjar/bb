import Database from "better-sqlite3";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

const started = performance.now();
let database;
let outcome = "failed";
let code;
try {
  const [, , databasePath, busyTimeout = "2000"] = process.argv;
  if (typeof databasePath !== "string" || !isAbsolute(databasePath)) {
    throw Object.assign(new Error("An absolute database path is required"), {
      code: "INVALID_PATH",
    });
  }
  database = new Database(databasePath, {
    fileMustExist: true,
    timeout: Number(busyTimeout),
  });
  const findIndex = database.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'events'
      AND name = 'local_bb_turn_request_thread_request_sequence_idx'
  `);
  if (findIndex.get() === undefined) {
    database
      .transaction(() => {
        database.exec(`
        CREATE INDEX IF NOT EXISTS local_bb_turn_request_thread_request_sequence_idx
        ON events (thread_id, json_extract(data, '$.requestId'), sequence)
        WHERE type = 'client/turn/requested'
      `);
      })
      .immediate();
    outcome = "created";
  } else {
    outcome = "present";
  }
  if (findIndex.get() === undefined)
    throw new Error("Index missing after creation");
  code = "OK";
} catch (error) {
  outcome = "failed";
  code = typeof error?.code === "string" ? error.code : "ERROR";
  process.exitCode = 1;
} finally {
  database?.close();
  process.stdout.write(
    JSON.stringify({
      outcome,
      code,
      durationMs: Math.round(performance.now() - started),
    }) + "\n",
  );
}

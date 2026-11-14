import {
  rootConnectionOf,
  type DbConnection,
  type DbQueryConnection,
} from "./connection.js";

const indexedConnections = new WeakSet<DbConnection>();

interface LocalTurnRequestIndexLogger {
  warn(fields: { code: string }, message: string): void;
}

export function initializeLocalTurnRequestIndex(
  db: DbConnection,
  logger?: LocalTurnRequestIndexLogger,
): void {
  indexedConnections.delete(db);
  try {
    const findIndex = db.$client.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'events'
        AND name = 'local_bb_turn_request_thread_request_sequence_idx'
    `);
    if (findIndex.get() === undefined) {
      db.$client
        .transaction(() => {
          db.$client.exec(`
          CREATE INDEX IF NOT EXISTS local_bb_turn_request_thread_request_sequence_idx
          ON events (thread_id, json_extract(data, '$.requestId'), sequence)
          WHERE type = 'client/turn/requested'
        `);
        })
        .immediate();
    }
    indexedConnections.add(db);
  } catch (error) {
    const code =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "UNKNOWN";
    logger?.warn(
      { code },
      "Local turn-request index unavailable; using historical lookup",
    );
  }
}

export function hasLocalTurnRequestIndex(db: DbQueryConnection): boolean {
  const root = rootConnectionOf(db);
  return root !== undefined && indexedConnections.has(root);
}

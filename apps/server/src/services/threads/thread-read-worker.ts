import { ApiError } from "../../errors.js";
import { parentPort } from "node:worker_threads";
import {
  createConnection,
  getLatestStoredConversationOutlineSequence,
  getLatestThreadSequence,
  searchThreadsWithPendingInteractionState,
  type DbConnection,
} from "@bb/db";
import { requirePublicThread } from "../lib/entity-lookup.js";
import {
  materializeThreadConversationOutline,
  readThreadConversationOutline,
} from "./timeline.js";
import type {
  ThreadReadRequest,
  ThreadReadResponse,
  ThreadReadResult,
} from "./thread-read-contract.js";

if (parentPort === null) throw new Error("Missing thread-read worker port");
const port = parentPort;
let connection: { source: string; db: DbConnection } | null = null;

port.on("message", (request: ThreadReadRequest) => {
  let transient: DbConnection | null = null;
  try {
    const source = request.source;
    let db: DbConnection;
    if (typeof source === "string") {
      if (connection?.source !== source) {
        connection?.db.$client.close();
        connection = { source, db: createConnection(source) };
      }
      db = connection.db;
    } else {
      transient = createConnection(Buffer.from(source));
      db = transient;
    }
    const task = request.task;
    let result: ThreadReadResult;
    if (task.kind === "search") {
      result = {
        kind: "search",
        results: db.$client.transaction(() =>
          searchThreadsWithPendingInteractionState(db, task),
        )(),
      };
    } else {
      const snapshot = db.$client.transaction(() => {
        const thread = requirePublicThread(db, task.threadId);
        const options = {
          completedTurnDisplay: task.completedTurnDisplay,
          includeClearedContextHistory: task.includeClearedContextHistory,
          eventRewriteGeneration: task.eventRewriteGeneration,
          ...(task.providerDisplayName === null
            ? {}
            : { providerDisplayName: task.providerDisplayName }),
          maxSeq: getLatestThreadSequence(db, { threadId: thread.id }),
          outlineSequence: getLatestStoredConversationOutlineSequence(db, {
            threadId: thread.id,
          }),
        };
        return {
          selection: readThreadConversationOutline(db, thread, options),
        };
      })();
      materializeThreadConversationOutline(db, snapshot.selection.record);
      const response = {
        items:
          task.role === null
            ? snapshot.selection.response.items
            : snapshot.selection.response.items.filter(
                (item) => item.role === task.role,
              ),
        maxSeq: snapshot.selection.response.maxSeq,
      };
      result = {
        kind: "outline",
        bytes: new TextEncoder().encode(JSON.stringify(response)),
        maxSeq: response.maxSeq,
      };
    }
    port.postMessage(
      { id: request.id, ok: true, result } satisfies ThreadReadResponse,
      result.kind === "outline" ? [result.bytes.buffer] : [],
    );
  } catch (error) {
    port.postMessage({
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof ApiError
        ? { apiError: { status: error.status, body: error.body } }
        : {}),
    } satisfies ThreadReadResponse);
  } finally {
    transient?.$client.close();
  }
});

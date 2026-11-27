import { ApiError } from "../../errors.js";
import { parentPort, workerData } from "node:worker_threads";
import {
  createConnection,
  getAppSettings,
  getLatestThreadSequence,
  listThreadsWithPendingInteractionState,
  searchThreadsWithPendingInteractionState,
  type DbConnection,
} from "@bb/db";
import { DEFAULT_COMPLETED_TURN_DISPLAY } from "@bb/domain";
import { requirePublicThread } from "../lib/entity-lookup.js";
import {
  buildThreadConversationOutlineProjectionKey,
  getThreadMessage,
  loadThreadConversationOutline,
} from "./timeline.js";
import { takeEventLoopWorkWindowSnapshot } from "../system/event-loop-work.js";
import type {
  ThreadReadRequest,
  ThreadReadResponse,
  ThreadReadResult,
} from "./thread-read-contract.js";

if (parentPort === null) throw new Error("Missing thread-read worker port");
const port = parentPort;
const cacheSizeKib =
  typeof workerData === "object" &&
  workerData !== null &&
  "cacheSizeKib" in workerData &&
  typeof workerData.cacheSizeKib === "number" &&
  Number.isInteger(workerData.cacheSizeKib) &&
  workerData.cacheSizeKib > 0
    ? workerData.cacheSizeKib
    : undefined;
const connectionOptions = {
  readonly: true,
  ...(cacheSizeKib === undefined ? {} : { cacheSizeKib }),
};
let connection: { source: string; db: DbConnection } | null = null;

function resolveWorkerConversationOptions(
  db: DbConnection,
  task: Extract<ThreadReadRequest["task"], { kind: "outline" | "message" }>,
) {
  const thread = requirePublicThread(db, task.threadId);
  const settings = getAppSettings(db);
  return {
    thread,
    options: {
      completedTurnDisplay:
        settings.providerCompletedTurnDisplay[thread.providerId] ??
        task.providerCompletedTurnDisplay ??
        DEFAULT_COMPLETED_TURN_DISPLAY,
      includeClearedContextHistory: settings.keepHistoryAfterContextClear,
      eventRewriteGeneration: task.eventRewriteGeneration,
      ...(task.providerDisplayName === null
        ? {}
        : { providerDisplayName: task.providerDisplayName }),
      maxSeq: getLatestThreadSequence(db, { threadId: thread.id }),
      ...(task.serverDataVersion === undefined
        ? {}
        : { serverDataVersion: task.serverDataVersion }),
    },
  };
}

port.on("message", (request: ThreadReadRequest) => {
  let transient: DbConnection | null = null;
  try {
    const source = request.source;
    let db: DbConnection;
    if (typeof source === "string") {
      if (connection?.source !== source) {
        connection?.db.$client.close();
        connection = {
          source,
          db: createConnection(source, connectionOptions),
        };
      }
      db = connection.db;
    } else {
      transient = createConnection(Buffer.from(source), connectionOptions);
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
    } else if (task.kind === "list") {
      result = {
        kind: "list",
        threads: db.$client.transaction(() =>
          listThreadsWithPendingInteractionState(db, task.options),
        )(),
      };
    } else if (task.kind === "message") {
      const response = db.$client.transaction(() => {
        const { thread, options } = resolveWorkerConversationOptions(db, task);
        return getThreadMessage(db, thread, {
          ...options,
          seq: task.seq,
          before: task.before,
          after: task.after,
        });
      })();
      result = {
        kind: "message",
        bytes: new TextEncoder().encode(JSON.stringify(response)),
      };
    } else {
      const snapshot = db.$client.transaction(() => {
        const { thread, options } = resolveWorkerConversationOptions(db, task);
        return {
          response: loadThreadConversationOutline(db, thread, options),
          projectionKey: buildThreadConversationOutlineProjectionKey(
            thread,
            0,
            options,
          ),
        };
      })();
      const response = {
        items:
          task.role === null
            ? snapshot.response.items
            : snapshot.response.items.filter((item) => item.role === task.role),
        maxSeq: snapshot.response.maxSeq,
      };
      result = {
        kind: "outline",
        bytes: new TextEncoder().encode(JSON.stringify(response)),
        maxSeq: response.maxSeq,
        projectionKey: snapshot.projectionKey,
      };
    }
    port.postMessage(
      { id: request.id, ok: true, result } satisfies ThreadReadResponse,
      result.kind === "outline" || result.kind === "message"
        ? [result.bytes.buffer]
        : [],
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
    takeEventLoopWorkWindowSnapshot();
    transient?.$client.close();
  }
});

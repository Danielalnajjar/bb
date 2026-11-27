import { ApiError } from "../../errors.js";
import { Worker } from "node:worker_threads";
import type { DbConnection } from "@bb/db";
import { threadReadWorkerSource } from "../../generated/thread-read-worker.js";
import type {
  ThreadReadRequest,
  ThreadReadResponse,
  ThreadReadResult,
  ThreadReadTask,
} from "./thread-read-contract.js";

type ThreadReadLane = "heavy" | "list";
const LIST_READER_CACHE_SIZE_KIB = 32_768;

const readers = new WeakMap<DbConnection, Map<ThreadReadLane, ThreadReader>>();
const closed = new WeakSet<DbConnection>();

class ThreadReader {
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    {
      resolve: (result: ThreadReadResult) => void;
      reject: (error: Error) => void;
    }
  >();
  private nextId = 0;
  private failure: Error | null = null;

  constructor(
    private readonly db: DbConnection,
    private readonly lane: ThreadReadLane,
    cacheSizeKib?: number,
  ) {
    this.worker = new Worker(threadReadWorkerSource, {
      eval: true,
      execArgv: [],
      workerData: {
        moduleUrl: import.meta.url,
        ...(cacheSizeKib === undefined ? {} : { cacheSizeKib }),
      },
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("messageerror", (error) => this.fail(error));
    this.worker.on("exit", (code) =>
      this.fail(new Error(`Thread-read worker exited (${code})`)),
    );
    this.worker.on("message", (value: unknown) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("id" in value) ||
        typeof value.id !== "number" ||
        !("ok" in value) ||
        typeof value.ok !== "boolean" ||
        (value.ok
          ? !("result" in value) ||
            typeof value.result !== "object" ||
            value.result === null ||
            !("kind" in value.result) ||
            !["outline", "search", "message", "list"].includes(
              String(value.result.kind),
            )
          : !("message" in value) || typeof value.message !== "string")
      ) {
        this.fail(new Error("Invalid thread-read worker response"));
        return;
      }
      const response = value as ThreadReadResponse;
      const pending = this.pending.get(response.id);
      if (pending === undefined) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else if (response.apiError !== undefined) {
        const { status, body } = response.apiError;
        pending.reject(new ApiError(status, body.code, body.message, body));
      } else pending.reject(new Error(response.message));
      if (this.pending.size === 0) this.worker.unref();
    });
    this.worker.unref();
  }

  private fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    const byLane = readers.get(this.db);
    if (byLane?.get(this.lane) === this) {
      byLane.delete(this.lane);
      if (byLane.size === 0) readers.delete(this.db);
    }
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.worker.unref();
    void this.worker.terminate();
  }

  read(task: ThreadReadTask): Promise<ThreadReadResult> {
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.ref();
      try {
        this.worker.postMessage({
          id,
          source: this.db.$client.memory
            ? this.db.$client.serialize()
            : this.db.$client.name,
          task,
        } satisfies ThreadReadRequest);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
        if (this.pending.size === 0) this.worker.unref();
      }
    });
  }

  async close(): Promise<void> {
    this.fail(new Error("Thread reader closed"));
    await this.worker.terminate();
  }
}

export function readThreadData(
  db: DbConnection,
  task: ThreadReadTask,
): Promise<ThreadReadResult> {
  if (closed.has(db)) return Promise.reject(new Error("Thread reader closed"));
  const lane: ThreadReadLane = task.kind === "list" ? "list" : "heavy";
  let byLane = readers.get(db);
  if (byLane === undefined) {
    byLane = new Map();
    readers.set(db, byLane);
  }
  let reader = byLane.get(lane);
  if (reader === undefined) {
    reader = new ThreadReader(
      db,
      lane,
      lane === "list" ? LIST_READER_CACHE_SIZE_KIB : undefined,
    );
    byLane.set(lane, reader);
  }
  return reader.read(task);
}

export async function closeThreadReader(db: DbConnection): Promise<void> {
  closed.add(db);
  const byLane = readers.get(db);
  if (byLane === undefined) return;
  readers.delete(db);
  await Promise.all([...byLane.values()].map((reader) => reader.close()));
}

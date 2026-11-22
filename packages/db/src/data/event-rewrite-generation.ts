import { eq } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { threadConversationOutlines } from "../schema.js";

const generationsByThreadId = new Map<string, number>();
const timelineOrderingGenerationsByThreadId = new Map<string, number>();

export function getThreadEventRewriteGeneration(threadId: string): number {
  return generationsByThreadId.get(threadId) ?? 0;
}

export function bumpThreadEventRewriteGeneration(
  db: DbQueryConnection,
  threadId: string,
): void {
  db.delete(threadConversationOutlines)
    .where(eq(threadConversationOutlines.threadId, threadId))
    .run();
  generationsByThreadId.set(
    threadId,
    getThreadEventRewriteGeneration(threadId) + 1,
  );
}

export function getThreadTimelineOrderingGeneration(threadId: string): number {
  return timelineOrderingGenerationsByThreadId.get(threadId) ?? 0;
}

export function bumpThreadTimelineOrderingGeneration(threadId: string): void {
  timelineOrderingGenerationsByThreadId.set(
    threadId,
    getThreadTimelineOrderingGeneration(threadId) + 1,
  );
}

export function forgetThreadEventRewriteGenerations(): void {
  generationsByThreadId.clear();
  timelineOrderingGenerationsByThreadId.clear();
}

export function getDatabaseDataVersion(db: DbConnection): number {
  const version: unknown = db.$client.pragma("data_version", { simple: true });
  if (typeof version !== "number") {
    throw new Error("PRAGMA data_version did not return a number");
  }
  return version;
}

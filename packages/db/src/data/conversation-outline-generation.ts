import type { DbConnection } from "../connection.js";

const generations = new WeakMap<
  DbConnection,
  { next: number; threads: Map<string, number> }
>();
const MAX_THREADS = 128;

export function getConversationOutlineGeneration(
  db: DbConnection,
  threadId: string,
): number {
  let state = generations.get(db);
  if (state === undefined) {
    state = { next: 0, threads: new Map() };
    generations.set(db, state);
  }
  const token = state.threads.get(threadId) ?? ++state.next;
  state.threads.delete(threadId);
  state.threads.set(threadId, token);
  while (state.threads.size > MAX_THREADS)
    state.threads.delete(state.threads.keys().next().value!);
  return token;
}

export function invalidateConversationOutlineGeneration(
  db: DbConnection,
  threadId: string,
): void {
  const state = generations.get(db);
  if (state?.threads.has(threadId)) state.threads.set(threadId, ++state.next);
}

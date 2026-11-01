import { eq } from "drizzle-orm";
import type { PromptSuggestionMode } from "@bb/domain";
import type { DbConnection } from "../connection.js";
import { threadPromptSuggestionPreferences } from "../schema.js";

export function getPromptSuggestionModeOverride(
  db: DbConnection,
  threadId: string,
): PromptSuggestionMode | null {
  return (
    db
      .select({ mode: threadPromptSuggestionPreferences.mode })
      .from(threadPromptSuggestionPreferences)
      .where(eq(threadPromptSuggestionPreferences.threadId, threadId))
      .get()?.mode ?? null
  );
}

export function setPromptSuggestionModeOverride(
  db: DbConnection,
  threadId: string,
  mode: PromptSuggestionMode | null,
): void {
  if (mode === null) {
    db.delete(threadPromptSuggestionPreferences)
      .where(eq(threadPromptSuggestionPreferences.threadId, threadId))
      .run();
    return;
  }
  db.insert(threadPromptSuggestionPreferences)
    .values({ threadId, mode })
    .onConflictDoUpdate({
      target: threadPromptSuggestionPreferences.threadId,
      set: { mode },
    })
    .run();
}

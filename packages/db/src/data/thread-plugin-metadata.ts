import { and, eq, inArray, sql } from "drizzle-orm";
import {
  exceedsPluginMetadataLimit,
  parsePersistedPluginMetadata,
  RESTART_RESUME_METADATA_KEY,
  restartResumeMetadataSchema,
  type JsonObject,
} from "@bb/domain";
import type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
} from "../connection.js";
import { threadPluginMetadata } from "../schema.js";

const threadExecutionNamespace = "@bb/thread-execution";

export interface ThreadPluginMetadataPatch {
  threadId: string;
  pluginId: string;
  set: JsonObject;
  remove: readonly string[];
}

export interface ThreadPluginMetadataRead {
  metadata: JsonObject;
  corrupt: boolean;
}

export type ThreadPluginMetadataPatchResult =
  | { ok: true; metadata: JsonObject; replacedCorrupt: boolean }
  | { ok: false; reason: "too_large" };

function namespaceWhere(threadId: string, pluginId: string) {
  return and(
    eq(threadPluginMetadata.threadId, threadId),
    eq(threadPluginMetadata.pluginId, pluginId),
  );
}

export function getThreadPluginMetadata(
  db: DbQueryConnection,
  threadId: string,
  pluginId: string,
): ThreadPluginMetadataRead {
  const row = db
    .select({ metadataJson: threadPluginMetadata.metadataJson })
    .from(threadPluginMetadata)
    .where(namespaceWhere(threadId, pluginId))
    .get();
  if (row === undefined) return { metadata: {}, corrupt: false };
  const metadata = parsePersistedPluginMetadata(row.metadataJson);
  return metadata === undefined
    ? { metadata: {}, corrupt: true }
    : { metadata, corrupt: false };
}

export function getThreadCodexAutoCompactTokenLimit(
  db: DbQueryConnection,
  threadId: string,
): number | undefined {
  const { metadata } = getThreadPluginMetadata(
    db,
    threadId,
    threadExecutionNamespace,
  );
  const limit = metadata.codexAutoCompactTokenLimit;
  return typeof limit === "number" ? limit : undefined;
}

export function insertThreadCodexAutoCompactTokenLimit(
  db: DbTransaction,
  threadId: string,
  limit: number,
): void {
  insertThreadPluginMetadata(db, {
    threadId,
    pluginId: threadExecutionNamespace,
    metadata: { codexAutoCompactTokenLimit: limit },
  });
}

export function readRestartResumeFacts(
  db: DbQueryConnection,
  threadId: string,
  onInvalid?: (pluginId: string) => void,
): {
  hold: { pluginId: string; reason: string | null } | null;
  receiptBacked: boolean;
} {
  const metadata = threadPluginMetadata.metadataJson;
  const path = `$.${RESTART_RESUME_METADATA_KEY}`;
  const rows = db
    .select({
      pluginId: threadPluginMetadata.pluginId,
      value: sql<string | null>`case when json_valid(${metadata}) then
        case when json_type(${metadata}, ${path}) = 'object' then json_extract(${metadata}, ${path}) end
      end`,
    })
    .from(threadPluginMetadata)
    .where(
      and(
        eq(threadPluginMetadata.threadId, threadId),
        sql`case when json_valid(${metadata}) then json_type(${metadata}, ${path}) is not null else 1 end`,
      ),
    )
    .all();

  let hold: { pluginId: string; reason: string | null } | null = null;
  let receiptBacked = false;
  for (const { pluginId, value } of rows) {
    const parsed = restartResumeMetadataSchema.safeParse(
      value === null ? undefined : JSON.parse(value),
    );
    if (!parsed.success) {
      onInvalid?.(pluginId);
      continue;
    }
    if (parsed.data.hold && hold === null) {
      hold = { pluginId, reason: parsed.data.reason ?? null };
    }
    receiptBacked ||= parsed.data.receiptBacked === true;
  }
  return { hold, receiptBacked };
}

export function listThreadPluginMetadataRows(
  db: DbQueryConnection,
  threadId: string,
  pluginIds: readonly string[],
): Array<{ pluginId: string; metadataJson: string }> {
  if (pluginIds.length === 0) return [];
  return db
    .select({
      pluginId: threadPluginMetadata.pluginId,
      metadataJson: threadPluginMetadata.metadataJson,
    })
    .from(threadPluginMetadata)
    .where(
      and(
        eq(threadPluginMetadata.threadId, threadId),
        inArray(threadPluginMetadata.pluginId, [...pluginIds]),
      ),
    )
    .all();
}

export function listPluginThreadMetadata(
  db: DbQueryConnection,
  pluginId: string,
  threadIds: readonly string[],
): {
  threads: Array<{ threadId: string; metadata: JsonObject }>;
  corruptThreadIds: string[];
} {
  if (threadIds.length === 0) return { threads: [], corruptThreadIds: [] };
  const rows = db
    .select({
      threadId: threadPluginMetadata.threadId,
      metadataJson: threadPluginMetadata.metadataJson,
    })
    .from(threadPluginMetadata)
    .where(
      and(
        eq(threadPluginMetadata.pluginId, pluginId),
        inArray(threadPluginMetadata.threadId, [...threadIds]),
      ),
    )
    .all();
  const result: Array<{ threadId: string; metadata: JsonObject }> = [];
  const corruptThreadIds: string[] = [];
  for (const row of rows) {
    const metadata = parsePersistedPluginMetadata(row.metadataJson);
    if (metadata === undefined) {
      corruptThreadIds.push(row.threadId);
    } else {
      result.push({ threadId: row.threadId, metadata });
    }
  }
  return { threads: result, corruptThreadIds };
}

export function insertThreadPluginMetadata(
  db: DbConnection | DbTransaction,
  input: { threadId: string; pluginId: string; metadata: JsonObject },
): void {
  db.insert(threadPluginMetadata)
    .values({
      threadId: input.threadId,
      pluginId: input.pluginId,
      metadataJson: JSON.stringify(input.metadata),
    })
    .run();
}

export function patchThreadPluginMetadata(
  db: DbQueryConnection,
  input: ThreadPluginMetadataPatch,
): ThreadPluginMetadataPatchResult {
  return db.transaction(
    (tx) => {
      const existing = getThreadPluginMetadata(
        tx,
        input.threadId,
        input.pluginId,
      );
      const metadata: JsonObject = { ...existing.metadata, ...input.set };
      for (const key of input.remove) delete metadata[key];
      if (Object.keys(metadata).length === 0) {
        tx.delete(threadPluginMetadata)
          .where(namespaceWhere(input.threadId, input.pluginId))
          .run();
        return { ok: true, metadata, replacedCorrupt: existing.corrupt };
      }
      const metadataJson = JSON.stringify(metadata);
      if (exceedsPluginMetadataLimit(metadataJson)) {
        return { ok: false, reason: "too_large" };
      }
      tx.insert(threadPluginMetadata)
        .values({
          threadId: input.threadId,
          pluginId: input.pluginId,
          metadataJson,
        })
        .onConflictDoUpdate({
          target: [
            threadPluginMetadata.threadId,
            threadPluginMetadata.pluginId,
          ],
          set: { metadataJson },
        })
        .run();
      return { ok: true, metadata, replacedCorrupt: existing.corrupt };
    },
    { behavior: "immediate" },
  );
}

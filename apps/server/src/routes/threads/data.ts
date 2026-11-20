import {
  getAppSettings,
  getDatabaseDataVersion,
  getConversationOutlineGeneration,
  getThreadPluginMetadata,
  patchThreadPluginMetadata,
  getLatestThreadSequence,
  getThreadEventRewriteGeneration,
  listThreadQueuedMessagesIncludingClaims,
  type DbQueryConnection,
} from "@bb/db";
import type { Hono } from "hono";
import {
  PROMPT_HISTORY_ENTRY_LIMIT,
  RESTART_RESUME_METADATA_KEY,
  threadEventTypeSchema,
  type Thread,
  type ThreadEventType,
} from "@bb/domain";
import {
  publicApiRoutes,
  THREAD_EVENT_LIST_PAGE_SIZE,
  typedRoutes,
  type PublicApiSchema,
  type ThreadTimelineQuery,
} from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import { readThreadData } from "../../services/threads/thread-reads.js";
import type { ThreadReadResult } from "../../services/threads/thread-read-contract.js";
import { requirePublicThread } from "../../services/lib/entity-lookup.js";
import { callHostRetryableOnlineRpc } from "../../services/hosts/online-rpc.js";
import { requireThreadStorageTarget } from "../../services/threads/thread-storage.js";
import { toThreadQueuedMessage } from "../../services/threads/thread-queued-messages.js";
import { readLoggedRestartResumeFacts } from "../../services/threads/queue-waits.js";
import { requestQueuedMessageDispatch } from "../../services/threads/queued-message-dispatch.js";
import { isCompactionOfferEnabled } from "../../services/threads/compaction-offer.js";
import {
  readThreadContextWindowUsage,
  readThreadHeadState,
  resolveThreadHeadStateOptions,
} from "../../services/threads/thread-head-state.js";
import {
  buildThreadConversationOutlineProjectionKey,
  getThreadMessage,
  buildTimelineTurnSummaryDetails,
  THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT,
  THREAD_TIMELINE_SEGMENT_LIMIT_MAX,
} from "../../services/threads/timeline.js";
import type {
  ThreadTimelinePageKind,
  ThreadTimelinePageRequest,
} from "../../services/threads/timeline-pagination.js";
import {
  createThreadTimelineWindows,
  resolveThreadCompletedTurnDisplay,
  resolveThreadProviderDisplayName,
} from "../../services/threads/thread-timeline-windows.js";
import {
  findThreadEvent,
  getLatestTurnFinalOutput,
  listThreadEventRows,
} from "../../services/threads/thread-data.js";
import { listThreadPromptHistory } from "../../services/prompt-history.js";
import { tryResolveExistingThreadExecutionPlan } from "../../services/threads/thread-execution-plan.js";
import {
  parseBoundedPositiveOptionalInteger,
  parseInteger,
  parseOptionalInteger,
} from "../../services/lib/validation.js";
import { parsePathKindInclusion } from "../path-list-inclusion.js";
import {
  DEFAULT_PATH_LIST_EXCLUDE_NAMES,
  THREAD_STORAGE_PATH_LIST_INCLUDE_HIDDEN,
} from "../path-list-policy.js";
import { parseFileListLimit } from "../file-list-query.js";
import { createThreadDerivedCache } from "../../services/threads/thread-derived-cache.js";

function parseThreadEventTypes(
  value: string | undefined,
): ThreadEventType[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((type) => {
    const parsed = threadEventTypeSchema.safeParse(type);
    if (!parsed.success) {
      throw new ApiError(400, "invalid_request", "Invalid event type");
    }
    return parsed.data;
  });
}

function parseThreadTimelineSegmentLimit(
  defaultLimit: number,
  rawLimit: string | undefined,
): number {
  const limit = parseOptionalInteger(rawLimit, "segmentLimit") ?? defaultLimit;
  if (limit <= 0) {
    throw new ApiError(
      400,
      "invalid_request",
      "segmentLimit must be a positive integer",
    );
  }
  if (limit > THREAD_TIMELINE_SEGMENT_LIMIT_MAX) {
    throw new ApiError(
      400,
      "invalid_request",
      `segmentLimit must be less than or equal to ${THREAD_TIMELINE_SEGMENT_LIMIT_MAX}`,
    );
  }
  return limit;
}

function parseThreadTimelinePage(
  query: ThreadTimelineQuery,
): ThreadTimelinePageRequest {
  const hasBeforeAnchorSeq = query.beforeAnchorSeq !== undefined;
  const kind: ThreadTimelinePageKind = hasBeforeAnchorSeq ? "older" : "latest";
  const segmentLimit = parseThreadTimelineSegmentLimit(
    THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT,
    query.segmentLimit,
  );

  if (kind === "latest") {
    return {
      kind,
      segmentLimit,
    };
  }

  if (
    query.beforeAnchorSeq === undefined ||
    query.beforeAnchorId === undefined
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "beforeAnchorSeq and beforeAnchorId must be provided together",
    );
  }

  return {
    beforeCursor: {
      anchorSeq: parseInteger(query.beforeAnchorSeq, "beforeAnchorSeq"),
      anchorId: query.beforeAnchorId,
    },
    kind,
    segmentLimit,
  };
}

function outlineBody(
  cached: { bytes: Uint8Array<ArrayBuffer>; maxSeq: number },
  maxSeq: number,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        cached.bytes.subarray(
          0,
          cached.bytes.length - String(cached.maxSeq).length - 1,
        ),
      );
      controller.enqueue(new TextEncoder().encode(`${maxSeq}}`));
      controller.close();
    },
  });
}

export function registerThreadDataRoutes(app: Hono, deps: AppDeps): void {
  const { get, patch } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });
  const routes = publicApiRoutes.threads;
  const timelineWindows = createThreadTimelineWindows(deps);
  const conversationOutlineCache = createThreadDerivedCache<
    Extract<ThreadReadResult, { kind: "outline" }>
  >({ maxEntries: 128, bytes: null });
  const pendingConversationOutlines = new Map<
    string,
    ReturnType<typeof readThreadData>
  >();
  const resolveConversationRowsOptions = (thread: Thread) => {
    const providerDisplayName = resolveThreadProviderDisplayName(
      deps,
      thread.providerId,
    );
    const settings = getAppSettings(deps.db);
    return {
      completedTurnDisplay: resolveThreadCompletedTurnDisplay(
        deps,
        settings,
        thread.providerId,
      ),
      includeClearedContextHistory: settings.keepHistoryAfterContextClear,
      maxSeq: getLatestThreadSequence(deps.db, { threadId: thread.id }),
      ...(providerDisplayName === undefined ? {} : { providerDisplayName }),
    };
  };

  get(routes.pluginMetadata.get, (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const { metadata, corrupt } = getThreadPluginMetadata(
      deps.db,
      thread.id,
      query.pluginId,
    );
    if (corrupt) {
      deps.logger.warn(
        `Ignoring corrupt plugin metadata for thread ${thread.id}, plugin ${query.pluginId}`,
      );
    }
    return context.json(metadata);
  });

  patch(routes.pluginMetadata.update, (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const set = payload.set ?? {};
    const remove = payload.remove ?? [];
    const update = (db: DbQueryConnection) =>
      patchThreadPluginMetadata(db, {
        threadId: thread.id,
        pluginId: payload.pluginId,
        set,
        remove,
      });
    const touchesRestartResume =
      Object.hasOwn(set, RESTART_RESUME_METADATA_KEY) ||
      remove.includes(RESTART_RESUME_METADATA_KEY);
    const { result, released } = touchesRestartResume
      ? deps.db.transaction(
          (tx) => {
            const readFacts = () =>
              readLoggedRestartResumeFacts(
                { db: tx, logger: deps.logger },
                thread.id,
              );
            const wasHeld = readFacts().hold !== null;
            const result = update(tx);
            return {
              result,
              released: result.ok && wasHeld && readFacts().hold === null,
            };
          },
          { behavior: "immediate" },
        )
      : { result: update(deps.db), released: false };
    if (!result.ok) {
      throw new ApiError(
        413,
        "invalid_request",
        "pluginMetadata exceeds 256 KiB",
      );
    }
    if (result.replacedCorrupt) {
      deps.logger.warn(
        `Replaced corrupt plugin metadata for thread ${thread.id}, plugin ${payload.pluginId}`,
      );
    }
    if (released) {
      requestQueuedMessageDispatch(deps, {
        kind: "restart-resume-released",
        threadId: thread.id,
      });
    }
    return context.json(result.metadata);
  });

  get(routes.context, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json({
      usage: readThreadContextWindowUsage(deps.db, {
        compactionOfferEnabled: isCompactionOfferEnabled(
          deps,
          thread.providerId,
        ),
        threadId: thread.id,
      }),
    });
  });

  get(routes.headState, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      readThreadHeadState(
        deps.db,
        thread,
        resolveThreadHeadStateOptions(deps, thread.providerId),
      ),
    );
  });

  get(routes.timeline, (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      timelineWindows.read(
        thread,
        {
          deferContent: query.deferContent === "true",
          includeNestedRows: query.includeNestedRows === "true",
          page: parseThreadTimelinePage(query),
        },
        query.afterTag,
      ),
    );
  });

  get(routes.conversationOutline, async (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const outlineOptions = resolveConversationRowsOptions(thread);
    const role = query.role ?? null;
    const slot = JSON.stringify([thread.id, role]);
    const readVersion = () => ({
      dataVersion: getDatabaseDataVersion(deps.db),
      eventRewriteGeneration: getThreadEventRewriteGeneration(thread.id),
    });
    const keyFor = (current: Thread, options: typeof outlineOptions) =>
      JSON.stringify([
        getDatabaseDataVersion(deps.db),
        buildThreadConversationOutlineProjectionKey(
          current,
          getConversationOutlineGeneration(deps.db, current.id),
          options,
        ),
      ]);

    const version = readVersion();
    const cacheKey = keyFor(thread, outlineOptions);
    const cached = conversationOutlineCache.get(slot, cacheKey);
    if (cached !== undefined) {
      return context.body(outlineBody(cached, outlineOptions.maxSeq), 200, {
        "Content-Type": "application/json",
      });
    }
    const pendingKey = JSON.stringify([slot, cacheKey, outlineOptions.maxSeq]);
    const task = {
      kind: "outline" as const,
      threadId: thread.id,
      providerCompletedTurnDisplay:
        deps.providerRegistry.get(thread.providerId)?.info
          .completedTurnDisplay ?? null,
      providerDisplayName: outlineOptions.providerDisplayName ?? null,
      eventRewriteGeneration: version.eventRewriteGeneration,
      role,
    };
    let pending = pendingConversationOutlines.get(pendingKey);
    if (pending === undefined) {
      pending = readThreadData(deps.db, {
        ...task,
        serverDataVersion: version.dataVersion,
      }).finally(() => pendingConversationOutlines.delete(pendingKey));
      pendingConversationOutlines.set(pendingKey, pending);
    }
    let result = await pending;
    const currentVersion = readVersion();
    const versionChanged =
      currentVersion.dataVersion !== version.dataVersion ||
      currentVersion.eventRewriteGeneration !== version.eventRewriteGeneration;
    if (versionChanged) {
      result = await readThreadData(deps.db, {
        ...task,
        eventRewriteGeneration: currentVersion.eventRewriteGeneration,
      });
    }
    if (result.kind !== "outline")
      throw new Error("Unexpected outline response");
    const current = requirePublicThread(deps.db, thread.id);
    const currentOptions = resolveConversationRowsOptions(current);
    if (
      !versionChanged &&
      keyFor(current, currentOptions) === cacheKey &&
      result.projectionKey ===
        buildThreadConversationOutlineProjectionKey(current, 0, currentOptions)
    ) {
      conversationOutlineCache.store(slot, cacheKey, thread.id, {
        expiresAt: null,
        value: result,
      });
    }
    return context.body(result.bytes, 200, {
      "Content-Type": "application/json",
    });
  });

  get(routes.message, (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const seq = context.req.param("seq");
    if (!/^\d+$/.test(seq)) {
      throw new ApiError(
        400,
        "invalid_request",
        "Message seq must be a non-negative integer",
      );
    }
    return context.json(
      getThreadMessage(deps.db, thread, {
        ...resolveConversationRowsOptions(thread),
        seq: parseInteger(seq, "seq"),
        before: parseOptionalInteger(query.before, "before") ?? 0,
        after: parseOptionalInteger(query.after, "after") ?? 0,
      }),
    );
  });

  get(routes.timelineTurnSummaryDetails, (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const settings = getAppSettings(deps.db);
    return context.json(
      buildTimelineTurnSummaryDetails(deps.db, thread, {
        beforeCursor: query.beforeCursor,
        deferContent: query.deferContent === "true",
        itemId: query.itemId ?? null,
        completedTurnDisplay: resolveThreadCompletedTurnDisplay(
          deps,
          settings,
          thread.providerId,
        ),
        includeDiagnosticOperations: settings.showDiagnosticEvents,
        summarizeShellCommands: settings.summarizeShellCommands,
        providerDisplayName: resolveThreadProviderDisplayName(
          deps,
          thread.providerId,
        ),
        turnId: query.turnId,
        sourceSeqStart: parseInteger(query.sourceSeqStart, "sourceSeqStart"),
        sourceSeqEnd: parseInteger(query.sourceSeqEnd, "sourceSeqEnd"),
      }),
    );
  });

  get(routes.output, (context) => {
    requirePublicThread(deps.db, context.req.param("id"));
    return context.json({
      output: getLatestTurnFinalOutput(deps.db, context.req.param("id")),
    });
  });

  get(routes.queuedMessages, (context) => {
    const threadId = context.req.param("id");
    requirePublicThread(deps.db, threadId);
    return context.json(
      listThreadQueuedMessagesIncludingClaims(deps.db, threadId).map(
        toThreadQueuedMessage,
      ),
    );
  });

  get(routes.promptHistory, (context, query) => {
    const threadId = context.req.param("id");
    requirePublicThread(deps.db, threadId);
    const limit = parseBoundedPositiveOptionalInteger({
      defaultValue: PROMPT_HISTORY_ENTRY_LIMIT,
      max: PROMPT_HISTORY_ENTRY_LIMIT,
      name: "limit",
      value: query.limit,
    });

    return context.json(
      listThreadPromptHistory(deps, {
        threadId,
        limit,
      }),
    );
  });

  get(routes.events, (context, query) => {
    requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      listThreadEventRows(deps.db, {
        threadId: context.req.param("id"),
        afterSeq: parseOptionalInteger(query.afterSeq, "afterSeq"),
        beforeSeq: parseOptionalInteger(query.beforeSeq, "beforeSeq"),
        limit: parseBoundedPositiveOptionalInteger({
          defaultValue: THREAD_EVENT_LIST_PAGE_SIZE,
          max: THREAD_EVENT_LIST_PAGE_SIZE,
          name: "limit",
          value: query.limit,
        }),
        order: query.order,
        types: parseThreadEventTypes(query.types),
      }),
    );
  });

  get(routes.eventWait, async (context, query) => {
    const threadId = context.req.param("id");
    requirePublicThread(deps.db, threadId);

    const afterSeq = parseOptionalInteger(query.afterSeq, "afterSeq");
    const waitMs = Math.min(
      parseOptionalInteger(query.waitMs, "waitMs") ?? 30_000,
      60_000,
    );
    const parsedEventType = threadEventTypeSchema.safeParse(query.type);
    if (!parsedEventType.success) {
      throw new ApiError(400, "invalid_request", "Invalid event type");
    }
    const eventType = parsedEventType.data;

    const findMatch = () =>
      findThreadEvent(deps.db, { threadId, type: eventType, afterSeq });

    const deadline = Date.now() + waitMs;
    let match = findMatch();
    while (!match) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const waiter = deps.hub.registerThreadEventWaiter(threadId, remaining);
      match = findMatch();
      if (match) {
        waiter.cancel();
        break;
      }
      await waiter.promise;
      match = findMatch();
    }

    if (!match) {
      return new Response(null, { status: 204 });
    }

    return context.json(match);
  });

  get(routes.defaultExecutionOptions, async (context) => {
    const threadId = context.req.param("id");
    requirePublicThread(deps.db, threadId);
    return context.json(
      (
        await tryResolveExistingThreadExecutionPlan(deps, {
          executionSource: "client/turn/requested",
          input: {},
          threadId,
        })
      )?.resolvedExecution ?? null,
    );
  });

  get(routes.storageFiles, async (context, query) => {
    const target = await requireThreadStorageTarget(
      deps,
      context.req.param("id"),
    );
    const limit = parseFileListLimit(query.limit);

    try {
      const result = await callHostRetryableOnlineRpc(deps, {
        hostId: target.hostId,
        signal: context.req.raw.signal,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "host.list_files",
          followRootSymlink: false,
          path: target.storagePath,
          ...(query.query ? { query: query.query } : {}),
          limit,
          includeHidden: THREAD_STORAGE_PATH_LIST_INCLUDE_HIDDEN,
          respectGitIgnore: false,
          excludeNames: [...DEFAULT_PATH_LIST_EXCLUDE_NAMES],
        },
      });
      return context.json({
        files: result.files,
        truncated: result.truncated,
        storageRootPath: target.storagePath,
      });
    } catch (error) {
      if (error instanceof ApiError && error.body.code === "ENOENT") {
        return context.json({
          files: [],
          truncated: false,
          storageRootPath: target.storagePath,
        });
      }
      throw error;
    }
  });

  get(routes.storageLocation, async (context) => {
    const target = await requireThreadStorageTarget(
      deps,
      context.req.param("id"),
    );
    return context.json({
      hostId: target.hostId,
      storageRootPath: target.storagePath,
    });
  });

  get(routes.storagePaths, async (context, query) => {
    const target = await requireThreadStorageTarget(
      deps,
      context.req.param("id"),
    );
    const limit = parseFileListLimit(query.limit);
    const inclusion = parsePathKindInclusion({
      includeFiles: query.includeFiles,
      includeDirectories: query.includeDirectories,
    });

    try {
      const result = await callHostRetryableOnlineRpc(deps, {
        hostId: target.hostId,
        signal: context.req.raw.signal,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "host.list_paths",
          path: target.storagePath,
          ...(query.query ? { query: query.query } : {}),
          limit,
          includeFiles: inclusion.includeFiles,
          includeDirectories: inclusion.includeDirectories,
          includeHidden: THREAD_STORAGE_PATH_LIST_INCLUDE_HIDDEN,
          respectGitIgnore: false,
          excludeNames: [...DEFAULT_PATH_LIST_EXCLUDE_NAMES],
        },
      });
      return context.json({
        paths: result.paths,
        truncated: result.truncated,
        storageRootPath: target.storagePath,
      });
    } catch (error) {
      if (error instanceof ApiError && error.body.code === "ENOENT") {
        return context.json({
          paths: [],
          truncated: false,
          storageRootPath: target.storagePath,
        });
      }
      throw error;
    }
  });
}

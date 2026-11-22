import { performance } from "node:perf_hooks";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  appendDaemonEventsInTransaction,
  deriveStoredEventItemFields,
  findLastCompletedRootStoredTurn,
  findLastRootStoredTurnStarted,
  findLatestUnresolvedClientTurnRequestIdAfterSequence,
  findStoredEventReceipt,
  getLatestStoredThreadProvisioningStatus,
  getThread,
  getLatestThreadSequence,
  hasRootStoredTurnStarted,
  hasRootTurnSupersessionAfter,
  isEventLifecycleApplied,
  isTurnAimedAtByEarlierStop,
  listStoredTurnCompletedKeys,
  listThreadEnvironmentAssignmentsOnHost,
  markEventLifecycleApplied,
  MissingStoredTurnStartedError,
} from "@bb/db";
import type {
  AcceptedDaemonEvent,
  AppendDaemonEventInput,
  AppendDaemonEventsResult,
  DbQueryConnection,
  StoredEventReceipt,
} from "@bb/db";
import {
  hostDaemonEventBatchRequestSchema,
  ungroupHostDaemonEvents,
  typedRoutes,
  type HostDaemonEventBatchResponse,
  type HostDaemonEventEnvelope,
  type HostDaemonInternalSchema,
  type HostDaemonRejectedEvent,
} from "@bb/host-daemon-contract";
import {
  THREAD_SESSION_OPTIONS_STATE_KIND,
  THREAD_PROVIDER_MODEL_CATALOG_STATE_KIND,
  getThreadEventScopeTurnId,
  requireThreadEventScopeTurnId,
  type ClientTurnRequestId,
  type ThreadEventType,
} from "@bb/domain";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../types.js";
import {
  isActivePruneTriggerThreadEventType,
  maybePruneActiveThreadEventHistory,
} from "../services/system/event-pruning.js";
import {
  completeTurnLifecycle,
  executeTurnEndFollowUpBestEffort,
  type TurnEndFollowUp,
} from "../services/threads/turn-end-follow-ups.js";
import type {
  ThreadLifecycleEffect,
  ThreadLifecycleInput,
} from "../services/threads/lifecycle/machine.js";
import {
  runThreadLifecycleInTransaction,
  runThreadLifecycleTransaction,
  type ThreadLifecycleOutcome,
} from "../services/threads/lifecycle/run.js";
import { NotificationBuffer } from "../services/lib/notification-buffer.js";
import { finishThreadLifecycle } from "../services/threads/lifecycle/finish.js";
import { deferAfterResponse } from "../services/lib/response-deferral.js";
import { runtimeErrorLogFields } from "../services/lib/error-log-fields.js";
import { dropSettledThreadSessionOptionSelections } from "../services/threads/thread-session-options.js";
import { rememberSessionModelCatalog } from "../services/providers/session-model-catalog.js";
import {
  applyGeneratedThreadTitle,
  sanitizeGeneratedTitle,
} from "../services/threads/title-generation.js";
import {
  getInactiveSessionLogFields,
  requireAuthenticatedDaemonSession,
} from "./session-state.js";
import { getAuthenticatedDaemon } from "./auth.js";
import { validateExtensionPayloads } from "./extension-payloads.js";
import { validatePresentationIcons } from "./presentation-icons.js";
import {
  observeStreamTraceEventBatch,
  observeTurnTraceEventBatch,
} from "../services/system/turn-trace.js";

interface ToStoredEventArgs {
  envelope: HostDaemonEventEnvelope;
  environmentId: string | null;
  hostId: string;
}

interface ResolvePostableEventBatchEntriesArgs {
  hostId: string;
  events: HostDaemonEventEnvelope[];
}

interface PostableEventBatchEntry {
  envelope: HostDaemonEventEnvelope;
  environmentId: string | null;
  eventIndex: number;
}

interface ResolvePostableEventBatchEntriesResult {
  entries: PostableEventBatchEntry[];
  rejectedEvents: HostDaemonEventBatchResponse["rejectedEvents"];
}

interface RejectedDaemonEventSummary {
  count: number;
  threadIds: string[];
}

interface ResolveEventsToApplyArgs {
  acceptedEvents: AcceptedDaemonEvent[];
  db: AppDeps["db"];
  eventInputs: AppendDaemonEventInput[];
  events: HostDaemonEventEnvelope[];
  insertedEventIndexes: number[];
  replayedEventIndexes: number[];
}

interface EventLifecycleTarget {
  pendingInteractionsInterruptReason: string | null;
  replayReceiptId: string | null;
  sequence: number | null;
  threadId: string;
  turnId: string | null;
}

interface EventToApply {
  entry: HostDaemonEventEnvelope;
  replayReceiptId: string | null;
  sequence: number | null;
}

interface NotifyInsertedEventThreadsDeps {
  db: AppDeps["db"];
  hub: AppDeps["hub"];
}

interface NotifyInsertedEventThreadsArgs {
  eventInputs: AppendDaemonEventInput[];
  insertedInputIndexes: number[];
}

function preserveTerminalProvisioningStatus(
  deps: Pick<AppDeps, "db">,
  entry: PostableEventBatchEntry,
): PostableEventBatchEntry {
  const event = entry.envelope.event;
  if (event.type !== "system/thread-provisioning") {
    return entry;
  }
  const status = getLatestStoredThreadProvisioningStatus(deps.db, {
    provisioningId: event.provisioningId,
    threadId: entry.envelope.threadId,
  });
  if (status !== "completed" && status !== "failed" && status !== "cancelled") {
    return entry;
  }
  return {
    ...entry,
    envelope: {
      ...entry.envelope,
      event: { ...event, status },
    },
  };
}

function parseStoredBackgroundTaskItemStatus(data: string): string | undefined {
  const parsed: unknown = JSON.parse(data);
  if (parsed === null || typeof parsed !== "object" || !("item" in parsed)) {
    return undefined;
  }
  const item = parsed.item;
  if (item === null || typeof item !== "object" || !("status" in item)) {
    return undefined;
  }
  return typeof item.status === "string" ? item.status : undefined;
}

function eventInputChangesBackgroundActivity(
  input: AppendDaemonEventInput,
): boolean {
  if (input.itemKind !== "backgroundTask") {
    return false;
  }
  if (
    input.type === "item/started" ||
    input.type === "item/backgroundTask/completed"
  ) {
    return true;
  }
  if (input.type !== "item/backgroundTask/progress") {
    return false;
  }
  try {
    return parseStoredBackgroundTaskItemStatus(input.data) !== "pending";
  } catch {
    return false;
  }
}

interface ShouldApplyEventEffectArgs {
  completedTurnKeyLookup: Set<string>;
  entry: HostDaemonEventEnvelope;
  index: number;
  insertedEventIndexLookup: Set<number>;
}

interface ListCompletedTurnKeysForStartedEventsArgs {
  batchEvents: HostDaemonEventEnvelope[];
  db: AppDeps["db"];
  insertedEventIndexLookup: ReadonlySet<number>;
}

interface TurnKeyArgs {
  threadId: string;
  turnId: string;
}

interface ActivePruneCandidate {
  latestPrunableSequence: number;
  threadId: string;
}

interface ResolveActivePruneCandidatesArgs {
  acceptedEvents: AcceptedDaemonEvent[];
  events: HostDaemonEventEnvelope[];
  insertedEventIndexes: number[];
}

function isRootTurnStartedEvent(
  event: Extract<HostDaemonEventEnvelope["event"], { type: "turn/started" }>,
): boolean {
  return !event.parentToolCallId;
}

function resolveProviderIdentifiers(event: HostDaemonEventEnvelope["event"]): {
  providerThreadId: string | null;
} {
  switch (event.type) {
    case "thread/started":
    case "client/thread/start":
    case "client/turn/requested":
    case "client/turn/rejected":
    case "client/turn/start":
    case "system/error":
    case "system/manager/user_message":
    case "system/thread/interrupted":
    case "system/operation":
    case "system/interaction/lifecycle":
    case "system/permissionGrant/lifecycle":
    case "system/userQuestion/lifecycle":
    case "system/thread-provisioning":
    case "system/provider-turn-watchdog":
      return { providerThreadId: null };
    case "thread/identity":
    case "thread/name/updated":
    case "provider/warning":
    case "provider/modelFallback":
    case "provider/rateLimits/updated":
    case "provider.env-resolved":
    case "thread/compacted":
    case "thread/context/cleared":
    case "thread/goal/updated":
    case "thread/goal/cleared":
    case "thread/extensionState/updated":
    case "turn/started":
    case "turn/completed":
    case "turn/input/accepted":
    case "item/started":
    case "item/completed":
    case "item/backgroundTask/progress":
    case "item/backgroundTask/completed":
    case "item/delegation/progress":
    case "item/delegation/completed":
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/plan/delta":
    case "item/mcpToolCall/progress":
    case "item/toolCall/progress":
    case "thread/contextWindowUsage/updated":
    case "thread/tokenUsage/updated":
    case "turn/plan/updated":
    case "turn/diff/updated":
    case "turn/mainRun/updated":
    case "provider/error":
    case "provider/unhandled":
      return { providerThreadId: event.providerThreadId };
    default: {
      const exhaustive: never = event;
      throw new Error(
        `Unsupported event type: ${String((exhaustive as { type?: string }).type)}`,
      );
    }
  }
}

function daemonEventRowId(hostId: string, eventId: string): string {
  return `evt_${createHash("sha256")
    .update(`${hostId}\0${eventId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function toStoredEvent(args: ToStoredEventArgs): AppendDaemonEventInput {
  const envelope = args.envelope;
  const { scope, type, threadId, ...data } = envelope.event;
  return {
    threadId: envelope.threadId,
    environmentId: args.environmentId,
    ...(envelope.eventId === undefined
      ? {}
      : { id: daemonEventRowId(args.hostId, envelope.eventId) }),
    ...resolveProviderIdentifiers(envelope.event),
    scope,
    type,
    ...deriveStoredEventItemFields(envelope.event),
    data: JSON.stringify(data),
  };
}

function notifyInsertedEventThreads(
  deps: NotifyInsertedEventThreadsDeps,
  args: NotifyInsertedEventThreadsArgs,
): void {
  const eventTypesByThreadId = new Map<string, Set<ThreadEventType>>();
  const backgroundActivityThreadIds = new Set<string>();
  for (const index of args.insertedInputIndexes) {
    const eventInput = args.eventInputs[index];
    if (eventInput) {
      const eventTypes =
        eventTypesByThreadId.get(eventInput.threadId) ??
        new Set<ThreadEventType>();
      eventTypes.add(eventInput.type);
      eventTypesByThreadId.set(eventInput.threadId, eventTypes);
      if (eventInputChangesBackgroundActivity(eventInput)) {
        backgroundActivityThreadIds.add(eventInput.threadId);
      }
    }
  }
  for (const [threadId, eventTypes] of eventTypesByThreadId) {
    deps.hub.notifyThread(threadId, ["events-appended"], {
      ...(backgroundActivityThreadIds.has(threadId)
        ? { backgroundActivityChanged: true }
        : {}),
      eventTypes: Array.from(eventTypes),
      timelineSequence: getLatestThreadSequence(deps.db, { threadId }),
    });
  }
}

async function applyEventEffects(
  deps: LoggedPendingInteractionWorkSessionDeps,
  events: EventToApply[],
): Promise<TurnEndFollowUp[]> {
  const followUps: TurnEndFollowUp[] = [];
  const failedParentNotificationThreadIds = new Set<string>();
  for (const { entry, replayReceiptId, sequence } of events) {
    try {
      const event = entry.event;
      if (event.type === "turn/started") {
        if (!isRootTurnStartedEvent(event)) {
          continue;
        }
        const turnId = requireThreadEventScopeTurnId({
          type: event.type,
          scope: event.scope,
        });
        const outcome = runEventLifecycleTransaction(
          deps,
          {
            pendingInteractionsInterruptReason: null,
            replayReceiptId,
            sequence,
            threadId: entry.threadId,
            turnId,
          },
          {
            type: "turn.started",
            aimedAtByStop: isTurnAimedAtByEarlierStop(deps.db, {
              threadId: entry.threadId,
              turnId,
            }),
            turnId,
            now: Date.now(),
          },
        );
        if (outcome === null) continue;
        await finishLifecycleFromEvents(deps, outcome, followUps);
        continue;
      }

      if (event.type === "turn/input/accepted") {
        const outcome = runThreadLifecycleTransaction(deps, entry.threadId, {
          type: "request.accepted",
          requestId: event.clientRequestId,
        });
        await finishLifecycleFromEvents(deps, outcome, followUps);
        continue;
      }

      if (event.type === "thread/name/updated") {
        if (event.source === "agent") {
          const title = sanitizeGeneratedTitle(event.threadName);
          if (title !== null) {
            applyGeneratedThreadTitle(deps, {
              threadId: entry.threadId,
              title,
            });
          }
        }
        continue;
      }

      if (event.type === "thread/extensionState/updated") {
        if (event.kind === THREAD_PROVIDER_MODEL_CATALOG_STATE_KIND) {
          await rememberSessionModelCatalog(deps, entry);
        }
        if (event.kind === THREAD_SESSION_OPTIONS_STATE_KIND) {
          dropSettledThreadSessionOptionSelections(deps, {
            threadId: entry.threadId,
            environmentId:
              getThread(deps.db, entry.threadId)?.environmentId ?? null,
          });
        }
        continue;
      }

      if (event.type === "turn/mainRun/updated") {
        if (event.state === "idle") {
          followUps.push({
            kind: "queued-message-dispatch",
            wake: { kind: "thread-ready", threadId: entry.threadId },
          });
        }
        continue;
      }

      if (event.type === "turn/completed") {
        const turnId = requireThreadEventScopeTurnId({
          type: event.type,
          scope: event.scope,
        });
        const thread = getThread(deps.db, entry.threadId);
        if (
          thread === null ||
          sequence === null ||
          !hasRootStoredTurnStarted(deps.db, {
            threadId: entry.threadId,
            turnId,
          })
        ) {
          continue;
        }
        const aimedAtByStop = isTurnAimedAtByEarlierStop(deps.db, {
          threadId: entry.threadId,
          turnId,
        });
        if (aimedAtByStop && event.status !== "interrupted") {
          continue;
        }
        const { outcome, idleFollowUp } = await completeTurnLifecycle(deps, {
          aimedAtByStop,
          completionSequence: sequence,
          failedParentNotificationThreadIds,
          replayReceiptId,
          status: event.status,
          thread,
          turnId,
        });
        await finishLifecycleFromEvents(deps, outcome, followUps);
        if (idleFollowUp !== null) {
          followUps.push(idleFollowUp);
        }
        continue;
      }

      if (
        event.type === "system/error" &&
        (event.code === "provider_process_exited" ||
          event.code === "provider_turn_start_failed")
      ) {
        if (getThread(deps.db, entry.threadId) === null) {
          continue;
        }
        const outcome = runEventLifecycleTransaction(
          deps,
          {
            pendingInteractionsInterruptReason:
              event.code === "provider_process_exited"
                ? "Provider process exited while awaiting user interaction; retry the thread to continue"
                : null,
            replayReceiptId,
            sequence,
            threadId: entry.threadId,
            turnId: getThreadEventScopeTurnId(event.scope) ?? null,
          },
          {
            type: "provider.failed",
            unstartedRequestId:
              event.scope.kind === "thread"
                ? findUnstartedTurnRequestId(deps, entry.threadId)
                : null,
          },
        );
        if (outcome === null) continue;
        await finishLifecycleFromEvents(deps, outcome, followUps);
        continue;
      }
    } catch (error) {
      deps.logger.error(
        {
          err: error,
          eventType: entry.event.type,
          threadId: entry.threadId,
        },
        "Failed to apply event side effects",
      );
    }
  }
  return followUps;
}

function runEventLifecycleTransaction(
  deps: LoggedPendingInteractionWorkSessionDeps,
  target: EventLifecycleTarget,
  input: ThreadLifecycleInput,
): ThreadLifecycleOutcome | null {
  const notifications = new NotificationBuffer();
  const outcome = deps.db.transaction(
    (tx) => {
      if (
        (target.sequence !== null &&
          isEventLifecycleApplied(tx, {
            threadId: target.threadId,
            sequence: target.sequence,
          })) ||
        (target.replayReceiptId !== null &&
          !isReplayedLifecycleEffectDue(
            tx,
            findStoredEventReceipt(tx, target.replayReceiptId),
            target.turnId,
          ))
      ) {
        return null;
      }
      const outcome = runThreadLifecycleInTransaction(
        { ...deps, db: tx, hub: notifications },
        target.threadId,
        input,
      );
      if (target.pendingInteractionsInterruptReason !== null) {
        deps.pendingInteractions.interruptPendingInteractionsForThreadIdsInTransaction(
          { db: tx, hub: notifications },
          {
            threadIds: [target.threadId],
            reason: target.pendingInteractionsInterruptReason,
          },
        );
      }
      if (target.sequence !== null) {
        markEventLifecycleApplied(tx, {
          threadId: target.threadId,
          sequence: target.sequence,
        });
      }
      return outcome;
    },
    { behavior: "immediate" },
  );
  notifications.flushInto(deps.hub);
  return outcome;
}

function isReplayedLifecycleEffectDue(
  db: DbQueryConnection,
  receipt: StoredEventReceipt | null,
  turnId: string | null,
): boolean {
  if (receipt === null) return false;
  if (
    turnId !== null &&
    findLastRootStoredTurnStarted(db, { threadId: receipt.threadId })
      ?.turnId !== turnId
  ) {
    return false;
  }
  return !hasRootTurnSupersessionAfter(db, {
    afterSequence: receipt.sequence,
    interruptionsSupersede: true,
    threadId: receipt.threadId,
    turnId,
  });
}

const EVENT_DEFERRED_LIFECYCLE_EFFECTS: ReadonlySet<
  ThreadLifecycleEffect["kind"]
> = new Set(["drain-queue"]);

async function finishLifecycleFromEvents(
  deps: LoggedPendingInteractionWorkSessionDeps,
  outcome: ThreadLifecycleOutcome,
  followUps: TurnEndFollowUp[],
): Promise<void> {
  for (const effect of outcome.effects) {
    if (effect.kind === "drain-queue") {
      followUps.push({
        kind: "queued-message-dispatch",
        wake: { kind: effect.wake, threadId: outcome.threadId },
      });
    }
  }
  await finishThreadLifecycle(deps, outcome, {
    skip: EVENT_DEFERRED_LIFECYCLE_EFFECTS,
  });
}

function findUnstartedTurnRequestId(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): ClientTurnRequestId | null {
  const lastCompletedTurn = findLastCompletedRootStoredTurn(deps.db, {
    threadId,
  });
  return findLatestUnresolvedClientTurnRequestIdAfterSequence(deps.db, {
    afterSequence: lastCompletedTurn?.completedSequence ?? 0,
    threadId,
  });
}

function deferEventFollowUpBatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  followUps: TurnEndFollowUp[],
): void {
  if (followUps.length === 0) {
    return;
  }

  deferAfterResponse({
    config: deps.config,
    logger: deps.logger,
    name: "Event follow-up scheduling",
    work: async () => {
      await Promise.all(
        followUps.map((followUp) =>
          executeTurnEndFollowUpBestEffort(deps, followUp),
        ),
      );
    },
  });
}

function toTurnKey(args: TurnKeyArgs): string {
  return `${args.threadId}:${args.turnId}`;
}

function listCompletedTurnKeysForStartedEvents(
  args: ListCompletedTurnKeysForStartedEventsArgs,
): Set<string> {
  const startedTurnKeys: TurnKeyArgs[] = [];

  for (const entry of args.batchEvents) {
    if (entry.event.type !== "turn/started") {
      continue;
    }
    startedTurnKeys.push({
      threadId: entry.threadId,
      turnId: requireThreadEventScopeTurnId({
        type: entry.event.type,
        scope: entry.event.scope,
      }),
    });
  }

  if (startedTurnKeys.length === 0) {
    return new Set<string>();
  }

  const completedTurnKeys = new Set(
    listStoredTurnCompletedKeys(args.db, { keys: startedTurnKeys }).map(
      toTurnKey,
    ),
  );

  for (const [index, entry] of args.batchEvents.entries()) {
    if (
      !args.insertedEventIndexLookup.has(index) ||
      entry.event.type !== "turn/completed"
    ) {
      continue;
    }
    completedTurnKeys.delete(
      toTurnKey({
        threadId: entry.threadId,
        turnId: requireThreadEventScopeTurnId({
          type: entry.event.type,
          scope: entry.event.scope,
        }),
      }),
    );
  }
  return completedTurnKeys;
}

function shouldApplyEventEffect(args: ShouldApplyEventEffectArgs): boolean {
  const { entry } = args;

  if (entry.event.type === "turn/completed") {
    return args.insertedEventIndexLookup.has(args.index);
  }

  if (entry.event.type === "turn/started") {
    return !args.completedTurnKeyLookup.has(
      toTurnKey({
        threadId: entry.threadId,
        turnId: requireThreadEventScopeTurnId({
          type: entry.event.type,
          scope: entry.event.scope,
        }),
      }),
    );
  }

  return true;
}

function resolveReplayedEventToApply(
  args: ResolveEventsToApplyArgs,
  index: number,
  insertedRowIds: ReadonlySet<string>,
): EventToApply | "legacy" | null {
  const entry = args.events[index];
  const rowId = args.eventInputs[index]?.id;
  if (
    entry === undefined ||
    rowId === undefined ||
    (entry.event.type !== "turn/started" &&
      entry.event.type !== "turn/completed" &&
      entry.event.type !== "system/error")
  ) {
    return "legacy";
  }
  const receipt = findStoredEventReceipt(args.db, rowId);
  if (
    receipt === null ||
    receipt.type !== entry.event.type ||
    insertedRowIds.has(rowId)
  ) {
    return null;
  }
  const turnId = getThreadEventScopeTurnId(entry.event.scope) ?? null;
  if (receipt.threadId !== entry.threadId || receipt.turnId !== turnId) {
    return null;
  }
  if (
    entry.event.type === "turn/completed" &&
    receipt.status !== entry.event.status
  ) {
    return null;
  }
  return { entry, replayReceiptId: rowId, sequence: receipt.sequence };
}

function resolveEventsToApply(args: ResolveEventsToApplyArgs): EventToApply[] {
  const insertedEventIndexLookup = new Set(args.insertedEventIndexes);
  const replayedEventIndexLookup = new Set(args.replayedEventIndexes);
  const insertedRowIds = new Set(
    args.insertedEventIndexes.flatMap((index) => {
      const rowId = args.eventInputs[index]?.id;
      return rowId === undefined ? [] : [rowId];
    }),
  );
  const sequenceByEventIndex = new Map(
    args.insertedEventIndexes.map((eventIndex, acceptedIndex) => [
      eventIndex,
      args.acceptedEvents[acceptedIndex]?.sequence ?? null,
    ]),
  );
  const completedTurnKeyLookup = listCompletedTurnKeysForStartedEvents({
    batchEvents: args.events,
    db: args.db,
    insertedEventIndexLookup,
  });

  return args.events.flatMap((entry, index) => {
    if (replayedEventIndexLookup.has(index)) {
      const replayed = resolveReplayedEventToApply(args, index, insertedRowIds);
      if (replayed === null) return [];
      if (replayed !== "legacy") return [replayed];
    }
    return shouldApplyEventEffect({
      completedTurnKeyLookup,
      entry,
      index,
      insertedEventIndexLookup,
    })
      ? [
          {
            entry,
            replayReceiptId: null,
            sequence: sequenceByEventIndex.get(index) ?? null,
          },
        ]
      : [];
  });
}

function resolveActivePruneCandidates(
  args: ResolveActivePruneCandidatesArgs,
): ActivePruneCandidate[] {
  const latestPrunableSequenceByThreadId = new Map<string, number>();

  for (const [acceptedIndex, acceptedEvent] of args.acceptedEvents.entries()) {
    const inputIndex = args.insertedEventIndexes[acceptedIndex];
    if (inputIndex === undefined) {
      throw new Error("Missing inserted event index for accepted daemon event");
    }
    const entry = args.events[inputIndex];
    if (entry === undefined) {
      throw new Error("Missing daemon event for inserted event index");
    }
    if (!isActivePruneTriggerThreadEventType(entry.event.type)) {
      continue;
    }

    const previousSequence = latestPrunableSequenceByThreadId.get(
      entry.threadId,
    );
    if (
      previousSequence === undefined ||
      acceptedEvent.sequence > previousSequence
    ) {
      latestPrunableSequenceByThreadId.set(
        entry.threadId,
        acceptedEvent.sequence,
      );
    }
  }

  return [...latestPrunableSequenceByThreadId.entries()].map(
    ([threadId, latestPrunableSequence]) => ({
      threadId,
      latestPrunableSequence,
    }),
  );
}

function summarizeRejectedDaemonEvents(
  rejectedEvents: readonly HostDaemonRejectedEvent[],
): RejectedDaemonEventSummary {
  return {
    count: rejectedEvents.length,
    threadIds: [...new Set(rejectedEvents.map((event) => event.threadId))],
  };
}

function resolvePostableEventBatchEntries(
  deps: Pick<AppDeps, "db">,
  args: ResolvePostableEventBatchEntriesArgs,
): ResolvePostableEventBatchEntriesResult {
  const threadIds = [...new Set(args.events.map((entry) => entry.threadId))];
  if (threadIds.length === 0) {
    return {
      entries: [],
      rejectedEvents: [],
    };
  }

  const ownedThreads = listThreadEnvironmentAssignmentsOnHost(deps.db, {
    hostId: args.hostId,
    threadIds,
  });

  const canonicalEnvironmentIdByThreadId = new Map<string, string | null>();
  for (const ownedThread of ownedThreads) {
    canonicalEnvironmentIdByThreadId.set(
      ownedThread.threadId,
      ownedThread.environmentId,
    );
  }

  const entries: PostableEventBatchEntry[] = [];
  const rejectedEvents: HostDaemonRejectedEvent[] = [];
  for (const [eventIndex, entry] of args.events.entries()) {
    if (!canonicalEnvironmentIdByThreadId.has(entry.threadId)) {
      rejectedEvents.push({
        eventIndex,
        reason: "thread_not_owned_by_host",
        threadId: entry.threadId,
      });
      continue;
    }
    const canonicalEnvironmentId =
      canonicalEnvironmentIdByThreadId.get(entry.threadId) ?? null;
    entries.push({
      envelope: entry,
      environmentId: canonicalEnvironmentId,
      eventIndex,
    });
  }

  return {
    entries,
    rejectedEvents,
  };
}

interface DroppedLifecycleEvent {
  eventIndex: number;
  eventType: string;
  interactionId: string;
  threadId: string;
}

function lifecycleInteractionId(
  event: HostDaemonEventEnvelope["event"],
): string | null {
  switch (event.type) {
    case "system/interaction/lifecycle":
      return event.interaction.id;
    case "system/permissionGrant/lifecycle":
    case "system/userQuestion/lifecycle":
      return event.interactionId;
    default:
      return null;
  }
}

function dropInteractionLifecycleEvents(entries: PostableEventBatchEntry[]): {
  entries: PostableEventBatchEntry[];
  droppedLifecycleEvents: DroppedLifecycleEvent[];
} {
  const kept: PostableEventBatchEntry[] = [];
  const droppedLifecycleEvents: DroppedLifecycleEvent[] = [];
  for (const entry of entries) {
    const interactionId = lifecycleInteractionId(entry.envelope.event);
    if (interactionId === null) {
      kept.push(entry);
      continue;
    }
    droppedLifecycleEvents.push({
      eventIndex: entry.eventIndex,
      eventType: entry.envelope.event.type,
      interactionId,
      threadId: entry.envelope.threadId,
    });
  }
  return { entries: kept, droppedLifecycleEvents };
}

export function registerInternalEventRoutes(app: Hono, deps: AppDeps): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/session/events",
    hostDaemonEventBatchRequestSchema,
    async (context, payload) => {
      const receivedAt = performance.now();
      let session: ReturnType<typeof requireAuthenticatedDaemonSession>;
      try {
        session = requireAuthenticatedDaemonSession({
          context,
          db: deps.db,
          sessionId: payload.sessionId,
        });
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.body.code === "inactive_session"
        ) {
          deps.logger.info(
            getInactiveSessionLogFields(deps.db, {
              authenticatedHostId: getAuthenticatedDaemon(context).hostId,
              now: Date.now(),
              sessionId: payload.sessionId,
            }),
            "Daemon event batch for inactive session",
          );
        }
        throw error;
      }
      const events = ungroupHostDaemonEvents(payload.eventGroups);
      const { entries: ownedEntries, rejectedEvents } =
        resolvePostableEventBatchEntries(deps, {
          hostId: session.hostId,
          events,
        });
      const { entries, droppedLifecycleEvents } =
        dropInteractionLifecycleEvents(ownedEntries);
      if (droppedLifecycleEvents.length > 0) {
        deps.logger.warn(
          {
            hostId: session.hostId,
            sessionId: session.id,
            droppedEvents: droppedLifecycleEvents,
          },
          "Dropped daemon-posted interaction lifecycle events; the server is their only author",
        );
      }
      if (rejectedEvents.length > 0) {
        deps.logger.warn(
          {
            hostId: session.hostId,
            rejectedEvents: summarizeRejectedDaemonEvents(rejectedEvents),
            sessionId: session.id,
          },
          "Rejected daemon events for threads outside the session host",
        );
      }
      const validatedEnvelopes = validatePresentationIcons(
        deps,
        await validateExtensionPayloads(
          deps,
          entries.map((entry) => entry.envelope),
        ),
      );
      const labelledEntries = entries
        .map((entry, index) => {
          const validated = validatedEnvelopes[index];
          if (validated === undefined) {
            throw new Error(
              "Missing validated envelope for daemon event entry",
            );
          }
          return {
            ...entry,
            envelope: validated,
          };
        })
        .map((entry) => preserveTerminalProvisioningStatus(deps, entry));
      const eventInputs = labelledEntries.map((entry) => {
        return toStoredEvent({
          envelope: entry.envelope,
          environmentId: entry.environmentId,
          hostId: session.hostId,
        });
      });
      const postableEvents = labelledEntries.map((entry) => entry.envelope);
      let appendResult: AppendDaemonEventsResult;
      try {
        appendResult = deps.db.transaction(
          (tx) => appendDaemonEventsInTransaction(tx, eventInputs),
          { behavior: "immediate" },
        );
      } catch (error) {
        if (error instanceof MissingStoredTurnStartedError) {
          deps.logger.warn(
            {
              ...error.details,
              sessionId: session.id,
              ...runtimeErrorLogFields(deps.config, error),
            },
            "Rejected daemon event before turn/started",
          );
          throw new ApiError(409, "invalid_request", error.message);
        }
        throw error;
      }
      for (const index of appendResult.skippedTurnUnstartedInputIndexes) {
        const skipped = eventInputs[index];
        deps.logger.warn(
          {
            eventType: skipped?.type,
            threadId: skipped?.threadId,
            sessionId: session.id,
          },
          "Dropped orphan thread-state snapshot with no stored turn/started",
        );
      }
      const committedAt = performance.now();
      notifyInsertedEventThreads(deps, {
        eventInputs,
        insertedInputIndexes: appendResult.insertedInputIndexes,
      });
      const turnTraceBatch = {
        committedAt,
        events: postableEvents,
        notifiedAt: performance.now(),
        receivedAt,
      };
      observeTurnTraceEventBatch(turnTraceBatch);
      observeStreamTraceEventBatch(deps, turnTraceBatch);

      const followUps = await applyEventEffects(
        deps,
        resolveEventsToApply({
          acceptedEvents: appendResult.acceptedEvents,
          db: deps.db,
          eventInputs,
          events: postableEvents,
          insertedEventIndexes: appendResult.insertedInputIndexes,
          replayedEventIndexes: appendResult.replayedInputIndexes,
        }),
      );
      for (const candidate of resolveActivePruneCandidates({
        acceptedEvents: appendResult.acceptedEvents,
        events: postableEvents,
        insertedEventIndexes: appendResult.insertedInputIndexes,
      })) {
        maybePruneActiveThreadEventHistory(deps, candidate);
      }

      deferEventFollowUpBatch(deps, followUps);
      const response: HostDaemonEventBatchResponse = {
        acceptedEvents: appendResult.acceptedEvents.map(
          (acceptedEvent, acceptedIndex) => {
            const inputIndex = appendResult.insertedInputIndexes[acceptedIndex];
            if (inputIndex === undefined) {
              throw new Error(
                "Missing inserted event index for accepted daemon event",
              );
            }
            const entry = entries[inputIndex];
            if (entry === undefined) {
              throw new Error("Missing daemon event entry for accepted event");
            }
            return {
              eventIndex: entry.eventIndex,
              sequence: acceptedEvent.sequence,
              threadId: acceptedEvent.threadId,
            };
          },
        ),
        rejectedEvents,
      };
      const body = JSON.stringify(response);
      return context.body(body, 200, {
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/json",
      });
    },
  );
}

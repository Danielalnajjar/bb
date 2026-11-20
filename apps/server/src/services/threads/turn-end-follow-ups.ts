import { and, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import {
  events as storedEvents,
  findLastRootStoredTurnStarted,
  findStoredEventReceipt,
  getThread,
  hasHandledRootTurnCompletion,
  isEventLifecycleApplied,
  isStoredTurnContextCompactionOnly,
  isTurnAimedAtByEarlierStop,
  markEventLifecycleApplied,
  markTurnCompletionParentNoticeHandled,
  readThreadRunState,
  type DbQueryConnection,
  type DbTransaction,
} from "@bb/db";
import {
  systemThreadInterruptedEventDataSchema,
  type ChildThreadOutcome,
  type HeldTurnCompletionStatus,
  type ResolvedThreadExecutionOptions,
  type ThreadEventTurnStatus,
} from "@bb/domain";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import {
  announceChildThreadTurnNotificationWrite,
  queueChildThreadTurnNotificationBestEffort,
  writeChildThreadTurnNotificationInTransaction,
  type QueueChildThreadTurnNotificationArgs,
} from "./child-thread-notifications.js";
import type { CoalescedNoticeWrite } from "./coalesced-system-notices.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import {
  runThreadLifecycleInTransaction,
  type ThreadLifecycleOutcome,
} from "./lifecycle/run.js";
import { buildExecutionOptions } from "./thread-commands.js";
import { isParentNotifiableChildThread } from "./thread-parent.js";
import {
  continueAfterEnvironmentDirectoryUpdate,
  findEnvironmentDirectoryContinuation,
  type EnvironmentDirectoryContinuation,
} from "./environment-directory-continuation.js";
import {
  runQueuedMessageDispatch,
  type QueuedMessageDispatchWake,
} from "./queued-message-dispatch.js";
import {
  isCommandTimeoutError,
  runtimeErrorLogFields,
} from "../lib/error-log-fields.js";

interface HasThreadCommandFailureSystemErrorForTurnDeps {
  db: AppDeps["db"];
}

interface HasThreadCommandFailureSystemErrorForTurnArgs {
  threadId: string;
  turnId: string;
}

interface TurnKey {
  threadId: string;
  turnId: string;
}

interface AddParentTurnNotificationFollowUpArgs {
  failedParentNotificationThreadIds: Set<string>;
  followUps: TurnEndFollowUp[] | ParentTurnNotificationFollowUp[];
  thread: NonNullable<ReturnType<typeof getThread>>;
  turnStatus: ThreadEventTurnStatus;
  turnId: string | null;
  interruption?: ChildThreadOutcome["interruption"];
}

export interface ParentTurnNotificationFollowUp {
  kind: "parent-turn-notification";
  childThreadId: string;
  projectId: string;
  parentThreadId: string;
  title: string | null;
  turnStatus: ThreadEventTurnStatus;
  turnId: string | null;
  interruption?: ChildThreadOutcome["interruption"];
}

interface QueuedMessageDispatchFollowUp {
  kind: "queued-message-dispatch";
  wake: Extract<
    QueuedMessageDispatchWake,
    { kind: "thread-ready" } | { kind: "turn-started" }
  >;
}

interface EnvironmentDirectoryContinuationFollowUp {
  kind: "environment-directory-continuation";
  continuation: EnvironmentDirectoryContinuation;
  parentNotification: ParentTurnNotificationFollowUp | null;
  threadId: string;
}

export type TurnEndFollowUp =
  | EnvironmentDirectoryContinuationFollowUp
  | ParentTurnNotificationFollowUp
  | QueuedMessageDispatchFollowUp;

function hasThreadCommandFailureSystemErrorForTurn(
  deps: HasThreadCommandFailureSystemErrorForTurnDeps,
  args: HasThreadCommandFailureSystemErrorForTurnArgs,
): boolean {
  return (
    deps.db
      .select({ id: storedEvents.id })
      .from(storedEvents)
      .where(
        and(
          eq(storedEvents.threadId, args.threadId),
          eq(storedEvents.turnId, args.turnId),
          eq(storedEvents.scopeKind, "turn"),
          eq(storedEvents.type, "system/error"),
          sql`json_extract(${storedEvents.data}, '$.code') = 'thread_command_failed'`,
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function wasTurnManuallyStopped(
  deps: Pick<AppDeps, "db">,
  args: TurnKey,
): boolean {
  const turnStarted = deps.db
    .select({ sequence: storedEvents.sequence })
    .from(storedEvents)
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        eq(storedEvents.turnId, args.turnId),
        eq(storedEvents.type, "turn/started"),
      ),
    )
    .limit(1)
    .get();
  if (!turnStarted) return false;

  return (
    deps.db
      .select({ id: storedEvents.id })
      .from(storedEvents)
      .where(
        and(
          eq(storedEvents.threadId, args.threadId),
          eq(storedEvents.type, "system/thread/interrupted"),
          gt(storedEvents.sequence, turnStarted.sequence),
          sql`json_extract(${storedEvents.data}, '$.reason') = 'manual-stop'`,
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function getTurnInterruption(
  deps: Pick<AppDeps, "db">,
  args: TurnKey,
): ChildThreadOutcome["interruption"] {
  const turnStarted = deps.db
    .select({ sequence: storedEvents.sequence })
    .from(storedEvents)
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        eq(storedEvents.turnId, args.turnId),
        eq(storedEvents.type, "turn/started"),
      ),
    )
    .limit(1)
    .get();
  if (!turnStarted) {
    return undefined;
  }

  const turnCompleted = deps.db
    .select({ sequence: sql<number>`${storedEvents.sequence}` })
    .from(
      sql`${storedEvents} INDEXED BY events_thread_turn_type_item_sequence_idx`,
    )
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        eq(storedEvents.turnId, args.turnId),
        eq(storedEvents.type, "turn/completed"),
      ),
    )
    .orderBy(desc(storedEvents.sequence))
    .limit(1)
    .get();
  if (!turnCompleted) return undefined;

  const interruption = deps.db
    .select({ data: sql<string>`${storedEvents.data}` })
    .from(sql`${storedEvents} INDEXED BY events_thread_type_sequence_idx`)
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        eq(storedEvents.type, "system/thread/interrupted"),
        gt(storedEvents.sequence, turnStarted.sequence),
        lt(storedEvents.sequence, turnCompleted.sequence),
      ),
    )
    .orderBy(desc(storedEvents.sequence))
    .limit(1)
    .get();
  return interruption
    ? systemThreadInterruptedEventDataSchema.parse(
        JSON.parse(interruption.data),
      )
    : undefined;
}

export function addParentTurnNotificationFollowUp(
  args: AddParentTurnNotificationFollowUpArgs,
): void {
  if (!isParentNotifiableChildThread(args.thread, args.turnStatus)) {
    return;
  }
  if (args.turnStatus === "failed") {
    if (args.failedParentNotificationThreadIds.has(args.thread.id)) {
      return;
    }
    args.failedParentNotificationThreadIds.add(args.thread.id);
  }
  args.followUps.push({
    kind: "parent-turn-notification",
    childThreadId: args.thread.id,
    projectId: args.thread.projectId,
    parentThreadId: args.thread.parentThreadId,
    title: args.thread.title,
    turnStatus: args.turnStatus,
    turnId: args.turnId,
    ...(args.interruption ? { interruption: args.interruption } : {}),
  });
}

function parentTurnNotificationArgs(
  followUp: ParentTurnNotificationFollowUp,
): QueueChildThreadTurnNotificationArgs {
  return {
    childThread: {
      id: followUp.childThreadId,
      projectId: followUp.projectId,
      title: followUp.title,
    },
    parentThreadId: followUp.parentThreadId,
    turnStatus: followUp.turnStatus,
    turnId: followUp.turnId,
    ...(followUp.interruption ? { interruption: followUp.interruption } : {}),
  };
}

export async function executeTurnEndFollowUpBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  followUp: TurnEndFollowUp,
): Promise<void> {
  try {
    switch (followUp.kind) {
      case "parent-turn-notification":
        await queueChildThreadTurnNotificationBestEffort(
          deps,
          parentTurnNotificationArgs(followUp),
        );
        return;
      case "queued-message-dispatch":
        await runQueuedMessageDispatch(deps, followUp.wake);
        return;
      case "environment-directory-continuation": {
        await runQueuedMessageDispatch(deps, {
          kind: "thread-ready",
          threadId: followUp.threadId,
        });
        let continued = false;
        try {
          continued = await continueAfterEnvironmentDirectoryUpdate(deps, {
            ...followUp.continuation,
            threadId: followUp.threadId,
          });
        } finally {
          if (!continued && followUp.parentNotification) {
            await executeTurnEndFollowUpBestEffort(
              deps,
              followUp.parentNotification,
            );
          }
        }
        return;
      }
    }
  } catch (error) {
    if (isCommandTimeoutError(error)) {
      deps.logger.warn(
        {
          followUp,
          ...runtimeErrorLogFields(deps.config, error),
        },
        "Event follow-up deferred by host timeout",
      );
      return;
    }
    deps.logger.error(
      {
        err: error,
        followUp,
      },
      "Failed to run event follow-up",
    );
  }
}

type TurnEndThread = NonNullable<ReturnType<typeof getThread>>;

export interface TurnEndPlan {
  continuation: EnvironmentDirectoryContinuation | null;
  parentNotifications: ParentTurnNotificationFollowUp[];
}

export function planTurnEnd(
  deps: Pick<AppDeps, "db">,
  args: {
    aimedAtByStop: boolean;
    failedParentNotificationThreadIds: Set<string>;
    status: HeldTurnCompletionStatus;
    thread: TurnEndThread;
    turnId: string;
  },
): TurnEndPlan {
  const { thread, turnId } = args;
  if (args.aimedAtByStop) {
    return { continuation: null, parentNotifications: [] };
  }
  const continuation =
    args.status === "completed" &&
    !wasTurnManuallyStopped(deps, { threadId: thread.id, turnId })
      ? findEnvironmentDirectoryContinuation(deps, {
          threadId: thread.id,
          turnId,
        })
      : null;
  const parentNotifications: ParentTurnNotificationFollowUp[] = [];
  if (isParentNotifiableChildThread(thread, args.status)) {
    const alreadyHandledByCommandFailure =
      args.status === "failed" &&
      hasThreadCommandFailureSystemErrorForTurn(deps, {
        threadId: thread.id,
        turnId,
      });
    const interruption =
      args.status === "interrupted"
        ? getTurnInterruption(deps, { threadId: thread.id, turnId })
        : undefined;
    const manuallyStopped =
      interruption?.reason === "manual-stop" ||
      (args.status === "interrupted" &&
        wasTurnManuallyStopped(deps, { threadId: thread.id, turnId }));
    const compactionOnly =
      args.status === "completed" &&
      isStoredTurnContextCompactionOnly(deps.db, {
        threadId: thread.id,
        turnId,
      });
    if (
      !alreadyHandledByCommandFailure &&
      !manuallyStopped &&
      !compactionOnly
    ) {
      addParentTurnNotificationFollowUp({
        failedParentNotificationThreadIds:
          args.failedParentNotificationThreadIds,
        followUps: parentNotifications,
        thread,
        turnStatus: args.status,
        turnId,
        ...(interruption ? { interruption } : {}),
      });
    }
  }
  return { continuation, parentNotifications };
}

export function idleFollowUpForTurnEnd(
  plan: TurnEndPlan,
  args: { status: HeldTurnCompletionStatus; threadId: string },
): TurnEndFollowUp | null {
  if (args.status !== "completed") return null;
  if (plan.continuation !== null) {
    return {
      kind: "environment-directory-continuation",
      continuation: plan.continuation,
      parentNotification: plan.parentNotifications[0] ?? null,
      threadId: args.threadId,
    };
  }
  return {
    kind: "queued-message-dispatch",
    wake: { kind: "thread-ready", threadId: args.threadId },
  };
}

interface CompleteTurnLifecycleArgs {
  aimedAtByStop: boolean;
  completionSequence: number;
  failedParentNotificationThreadIds: Set<string>;
  replayReceiptId: string | null;
  status: HeldTurnCompletionStatus;
  thread: TurnEndThread;
  turnId: string;
}

interface ParentNoticeWrite {
  parentThreadId: string;
  write: CoalescedNoticeWrite;
}

function canRepairReplayedCompletion(
  tx: DbTransaction,
  args: CompleteTurnLifecycleArgs,
  receiptId: string,
): boolean {
  const threadId = args.thread.id;
  const receipt = findStoredEventReceipt(tx, receiptId);
  if (
    receipt === null ||
    receipt.type !== "turn/completed" ||
    receipt.threadId !== threadId ||
    receipt.turnId !== args.turnId ||
    receipt.status !== args.status ||
    receipt.sequence !== args.completionSequence
  ) {
    return false;
  }
  const latestStart = findLastRootStoredTurnStarted(tx, { threadId });
  if (latestStart?.turnId !== args.turnId) return false;
  if (readThreadRunState(tx, threadId).heldCompletion?.turnId === args.turnId) {
    return false;
  }
  return !hasRootTurnSupersessionAfter(tx, {
    afterSequence: latestStart.sequence,
    interruptionsSupersede: false,
    threadId,
    turnId: args.turnId,
  });
}

export function hasRootTurnSupersessionAfter(
  db: DbQueryConnection,
  args: {
    afterSequence: number;
    interruptionsSupersede: boolean;
    threadId: string;
    turnId: string | null;
  },
): boolean {
  const kind = sql`json_extract(${storedEvents.data}, '$.target.kind')`;
  const newerAdmission = and(
    eq(storedEvents.type, "client/turn/requested"),
    sql`${kind} <> 'steer'`,
    args.turnId === null
      ? undefined
      : sql`not (${kind} = 'auto' and (json_extract(${storedEvents.data}, '$.target.expectedTurnId') is ${args.turnId} or exists (
          select 1
          from events as accepted
          where accepted.thread_id = ${storedEvents.threadId}
            and accepted.type = 'turn/input/accepted'
            and json_extract(accepted.data, '$.clientRequestId') = json_extract(${storedEvents.data}, '$.requestId')
            and accepted.turn_id = ${args.turnId}
        )))`,
  );
  return (
    db
      .select({ found: sql<number>`1` })
      .from(sql`${storedEvents} INDEXED BY events_thread_type_sequence_idx`)
      .where(
        and(
          eq(storedEvents.threadId, args.threadId),
          inArray(
            storedEvents.type,
            args.interruptionsSupersede
              ? ["client/turn/requested", "system/thread/interrupted"]
              : ["client/turn/requested"],
          ),
          gt(storedEvents.sequence, args.afterSequence),
          args.interruptionsSupersede
            ? or(
                newerAdmission,
                eq(storedEvents.type, "system/thread/interrupted"),
              )
            : newerAdmission,
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function unchangedLifecycleOutcome(
  tx: DbTransaction,
  threadId: string,
): ThreadLifecycleOutcome {
  const thread = getThread(tx, threadId);
  return {
    effects: [],
    previousStatus: thread?.status ?? null,
    refusal: null,
    statusChanged: false,
    stopRoute: "none",
    thread,
    threadId,
  };
}

async function resolveParentNoticeExecution(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: CompleteTurnLifecycleArgs,
): Promise<ResolvedThreadExecutionOptions | null> {
  const { thread } = args;
  if (!isParentNotifiableChildThread(thread, args.status)) return null;
  const parent = getThread(deps.db, thread.parentThreadId);
  if (
    parent === null ||
    parent.archivedAt !== null ||
    parent.deletedAt !== null
  )
    return null;
  try {
    return await buildExecutionOptions(deps, {}, { threadId: parent.id });
  } catch (error) {
    deps.logger.error(
      {
        childThreadId: thread.id,
        parentThreadId: parent.id,
        turnStatus: args.status,
        err: error,
      },
      "Failed to resolve parent execution for child turn notification",
    );
    return null;
  }
}

function writeParentNoticeInSavepoint(
  deps: LoggedPendingInteractionWorkSessionDeps,
  tx: DbTransaction,
  followUp: ParentTurnNotificationFollowUp,
  execution: ResolvedThreadExecutionOptions,
): CoalescedNoticeWrite | null {
  try {
    return tx.transaction((savepoint) =>
      writeChildThreadTurnNotificationInTransaction(
        savepoint,
        parentTurnNotificationArgs(followUp),
        execution,
      ),
    );
  } catch (error) {
    deps.logger.error(
      {
        childThreadId: followUp.childThreadId,
        parentThreadId: followUp.parentThreadId,
        turnStatus: followUp.turnStatus,
        err: error,
      },
      "Failed to write parent child turn notification",
    );
    return null;
  }
}

export async function completeTurnLifecycle(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: CompleteTurnLifecycleArgs,
): Promise<{
  outcome: ThreadLifecycleOutcome;
  idleFollowUp: TurnEndFollowUp | null;
}> {
  const { status, thread, turnId } = args;
  const execution = await resolveParentNoticeExecution(deps, args);
  const notifications = new NotificationBuffer();
  const completed = deps.db.transaction(
    (tx) => {
      if (
        isEventLifecycleApplied(tx, {
          threadId: thread.id,
          sequence: args.completionSequence,
        }) ||
        (args.replayReceiptId !== null &&
          !canRepairReplayedCompletion(tx, args, args.replayReceiptId))
      ) {
        return {
          outcome: unchangedLifecycleOutcome(tx, thread.id),
          idleFollowUp: null,
          writes: [],
        };
      }
      const held = readThreadRunState(tx, thread.id).heldCompletion;
      const outcome = runThreadLifecycleInTransaction(
        { ...deps, db: tx, hub: notifications },
        thread.id,
        { type: "turn.completed", turnId, status },
      );
      markEventLifecycleApplied(tx, {
        threadId: thread.id,
        sequence: args.completionSequence,
      });
      const ended = outcome.effects.find(
        (effect) => effect.kind === "turn-ended",
      );
      const writes: ParentNoticeWrite[] = [];
      if (ended === undefined || ended.kind !== "turn-ended") {
        return { outcome, idleFollowUp: null, writes };
      }
      const plan = planTurnEnd(deps, {
        aimedAtByStop: args.aimedAtByStop,
        failedParentNotificationThreadIds:
          args.failedParentNotificationThreadIds,
        status,
        thread,
        turnId,
      });
      const idle =
        ended.disposition === "applied" && outcome.thread?.status === "idle";
      const idleFollowUp = idle
        ? idleFollowUpForTurnEnd(plan, { status, threadId: thread.id })
        : null;
      const noticesDue =
        plan.continuation === null || !(idle || ended.disposition === "held");
      const repeated =
        (held?.turnId === turnId && held.status === status) ||
        (ended.disposition === "ignored" &&
          hasHandledRootTurnCompletion(tx, {
            threadId: thread.id,
            turnId,
            status,
            throughSequence: args.completionSequence,
          }));
      if (noticesDue && !repeated && execution !== null) {
        for (const notification of plan.parentNotifications) {
          const write = writeParentNoticeInSavepoint(
            deps,
            tx,
            notification,
            execution,
          );
          if (write !== null) {
            writes.push({ parentThreadId: notification.parentThreadId, write });
          }
        }
      }
      const handedToContinuation =
        idleFollowUp?.kind === "environment-directory-continuation" &&
        idleFollowUp.parentNotification !== null;
      if (
        handedToContinuation ||
        writes.some(
          ({ write }) => write.kind === "created" || write.kind === "merged",
        )
      ) {
        markTurnCompletionParentNoticeHandled(tx, {
          threadId: thread.id,
          sequence: args.completionSequence,
        });
      }
      return { outcome, idleFollowUp, writes };
    },
    { behavior: "immediate" },
  );
  notifications.flushInto(deps.hub);
  for (const { parentThreadId, write } of completed.writes) {
    announceChildThreadTurnNotificationWrite(deps, parentThreadId, write);
  }
  return {
    outcome: completed.outcome,
    idleFollowUp: completed.idleFollowUp,
  };
}

export async function runReleasedTurnFollowUps(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    status: HeldTurnCompletionStatus;
    threadId: string;
    turnId: string;
  },
): Promise<void> {
  const thread = getThread(deps.db, args.threadId);
  if (thread === null) return;
  const plan = planTurnEnd(deps, {
    aimedAtByStop: isTurnAimedAtByEarlierStop(deps.db, {
      threadId: args.threadId,
      turnId: args.turnId,
    }),
    failedParentNotificationThreadIds: new Set(),
    status: args.status,
    thread,
    turnId: args.turnId,
  });
  const followUp = idleFollowUpForTurnEnd(plan, args);
  if (followUp !== null) {
    await executeTurnEndFollowUpBestEffort(deps, followUp);
  }
}

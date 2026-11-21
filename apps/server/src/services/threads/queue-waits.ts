import {
  afterCommit,
  moveQueuedThreadMessageToFrontInTransaction,
  clearQueuedThreadMessageWaitingOn,
  createQueuedThreadMessageInTransaction,
  getQueuedThreadMessage,
  getThread,
  isOrdinaryTurnEndQueuedMessage,
  noopNotifier,
  readRestartResumeFacts,
  requeueClaimedQueuedThreadMessages,
  setQueuedThreadMessageWaitingOn,
  type ClaimedQueuedThreadMessageRow,
  type DbConnection,
  type DbNotifier,
  type DbQueryConnection,
  type QueuedThreadMessageRow,
} from "@bb/db";
import { isRestartResumeRetry } from "@bb/domain";
import type {
  PromptInput,
  QueuedMessageDeliveryMode,
  QueuedMessagePayload,
  QueuedMessageSystemNotice,
  ResolvedThreadExecutionOptions,
  StartedOnBehalfOf,
  StoredQueuedMessageWaitingOn,
  Thread,
  ThreadCreateOrigin,
  ThreadQueuedMessage,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import {
  emitPluginMessageDispatched,
  emitPluginMessageQueued,
} from "../plugins/plugin-thread-events.js";
import {
  parseStoredQueuedThreadMessageWaitingOn,
  toThreadQueuedMessage,
} from "./thread-queued-messages.js";
import { assertThreadHostAcceptsWork } from "./thread-host-admission.js";

type QueueWaitDeps = {
  db: DbQueryConnection;
  hub: DbNotifier & Partial<Pick<AppDeps["hub"], "onChangedMessage">>;
  logger?: AppDeps["logger"];
};

export type TurnEndPluginHoldKind = "thread-busy" | "stopping";
type TurnEndPluginHold = Pick<
  QueuedThreadMessageRow,
  "waitingOn" | "sendAt"
> & {
  kind: TurnEndPluginHoldKind;
};

const turnEndPluginHolds = new Map<string, Map<string, TurnEndPluginHold>>();
const observedQueueHubs = new WeakSet<QueueWaitDeps["hub"]>();

function forgetTurnEndPluginHold(threadId: string, id: string): void {
  const holds = turnEndPluginHolds.get(threadId);
  if (holds?.delete(id) && holds.size === 0) {
    turnEndPluginHolds.delete(threadId);
  }
}

function currentTurnEndPluginHold(
  row: QueuedThreadMessageRow,
): TurnEndPluginHold | undefined {
  const hold = turnEndPluginHolds.get(row.threadId)?.get(row.id);
  return hold !== undefined &&
    row.waitHolder !== null &&
    row.waitingOn === hold.waitingOn &&
    row.sendAt === hold.sendAt
    ? hold
    : undefined;
}

function recordTurnEndPluginHold(
  deps: QueueWaitDeps,
  row: QueuedThreadMessageRow,
  kind: TurnEndPluginHoldKind | null,
): void {
  if (kind === null) {
    forgetTurnEndPluginHold(row.threadId, row.id);
    return;
  }
  const holds = turnEndPluginHolds.get(row.threadId) ?? new Map();
  holds.set(row.id, { kind, waitingOn: row.waitingOn, sendAt: row.sendAt });
  turnEndPluginHolds.set(row.threadId, holds);

  const { db, hub } = deps;
  if (hub.onChangedMessage === undefined || observedQueueHubs.has(hub)) return;
  observedQueueHubs.add(hub);
  hub.onChangedMessage((message) => {
    if (message.entity !== "thread") return;
    if (message.changes.includes("thread-deleted")) {
      turnEndPluginHolds.delete(message.id);
      return;
    }
    if (!message.changes.includes("queue-changed")) return;
    const holds = turnEndPluginHolds.get(message.id);
    if (holds === undefined) return;
    for (const id of holds.keys()) {
      const current = getQueuedThreadMessage(db, id);
      if (current === null || currentTurnEndPluginHold(current) === undefined) {
        forgetTurnEndPluginHold(message.id, id);
      }
    }
  });
}

export function isOrdinaryTurnEndPluginHold(
  row: QueuedThreadMessageRow,
): boolean {
  const hold = currentTurnEndPluginHold(row);
  return hold !== undefined && isOrdinaryTurnEndQueuedMessage(row, hold.kind);
}

export function isTurnEndPluginHoldReady(
  deps: Pick<QueueWaitDeps, "db">,
  threadId: string,
): boolean {
  if (!turnEndPluginHolds.has(threadId)) return false;
  const thread = getThread(deps.db, threadId);
  return (
    thread !== null &&
    thread.status !== "active" &&
    thread.status !== "stopping"
  );
}

export function releaseTurnEndPluginHolds(
  deps: { db: DbConnection; hub: DbNotifier },
  threadId: string,
): number {
  const holds = turnEndPluginHolds.get(threadId);
  if (holds === undefined || !isTurnEndPluginHoldReady(deps, threadId))
    return 0;
  let released = 0;
  for (const id of holds.keys()) {
    const row = getQueuedThreadMessage(deps.db, id);
    const hold = row === null ? undefined : currentTurnEndPluginHold(row);
    if (row === null || hold === undefined) {
      forgetTurnEndPluginHold(threadId, id);
      continue;
    }
    if (row.state !== "waiting" && row.state !== "scheduled") {
      continue;
    }
    const updated = setQueuedThreadMessageWaitingOn(deps.db, noopNotifier, {
      id,
      threadId,
      waitingOn: { kind: hold.kind },
      sendAt: null,
    });
    if (updated !== null) {
      forgetTurnEndPluginHold(threadId, id);
      released++;
    }
  }
  if (released > 0) deps.hub.notifyThread(threadId, ["queue-changed"]);
  return released;
}

export const QUEUED_MESSAGE_CLAIM_LOST_CODE = "queued_message_claim_lost";
export const QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE =
  "queued_message_auto_send_paused";
export const QUEUED_MESSAGE_RESTART_RESUME_HELD_CODE =
  "queued_message_restart_resume_held";

export function createQueuedMessageClaimLostError(): ApiError {
  return new ApiError(
    409,
    QUEUED_MESSAGE_CLAIM_LOST_CODE,
    "Queued message claim expired before it could be sent",
  );
}

export function createQueuedMessageAutoSendPausedError(): ApiError {
  return new ApiError(
    409,
    QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE,
    "Queued message auto-send was paused by a manual stop",
  );
}

export function createQueuedRestartResumeHeldError(): ApiError {
  return new ApiError(
    409,
    QUEUED_MESSAGE_RESTART_RESUME_HELD_CODE,
    "A plugin is holding this restart continuation",
  );
}

export function logInvalidRestartResumeMetadata(
  logger: AppDeps["logger"] | undefined,
  threadId: string,
  pluginId: string,
): void {
  logger?.warn(
    { threadId, pluginId },
    "Ignoring invalid restart resume metadata",
  );
}

export function readLoggedRestartResumeFacts(
  deps: Pick<QueueWaitDeps, "db" | "logger">,
  threadId: string,
): ReturnType<typeof readRestartResumeFacts> {
  return readRestartResumeFacts(deps.db, threadId, (pluginId) =>
    logInvalidRestartResumeMetadata(deps.logger, threadId, pluginId),
  );
}

export function assertRestartResumeNotHeld(
  deps: Pick<QueueWaitDeps, "db" | "logger">,
  threadId: string,
): void {
  if (readLoggedRestartResumeFacts(deps, threadId).hold !== null) {
    throw createQueuedRestartResumeHeldError();
  }
}

/** The message a queued row will carry, as the queueing site supplies it. */
export interface QueuedDispatchMessage {
  input: PromptInput[];
  execution: ResolvedThreadExecutionOptions;
  senderThreadId: string | null;
  /**
   * The provenance of the dispatch being queued, written onto the row so the
   * drain re-decides on what the first attempt saw rather than on null.
   */
  origin: ThreadCreateOrigin | null;
  originPluginId: string | null;
  requestedBy: StartedOnBehalfOf | null;
  payload: QueuedMessagePayload;
  /** Non-null only when core is queueing one of its own system notices. */
  systemNotice: QueuedMessageSystemNotice | null;
  deliveryMode: QueuedMessageDeliveryMode;
}

export interface RecordQueuedMessageWaitArgs {
  thread: Thread;
  message: QueuedDispatchMessage;
  placement: "back" | "front";
  waitingOn: StoredQueuedMessageWaitingOn;
  turnEndWait?: TurnEndPluginHoldKind | null;
  /**
   * The row's scheduled instant. Passed every time the wait is written rather
   * than left alone, because writing a wait is a fresh statement of when this
   * row may run: a `time` wait sets it, a plugin wait with a `sendAt` sets it,
   * and every other wait clears it by passing null.
   */
  sendAt: number | null;
  /**
   * Rows already claimed from the queue that this call is RETURNING rather
   * than creating. Present on every drain re-attempt; absent when an inline
   * send is queued for the first time.
   */
  claimed: readonly ClaimedQueuedThreadMessageRow[] | null;
}

/**
 * Records that a dispatch is waiting: the single place a queued row comes into
 * existence or has its wait rewritten.
 *
 * Creating and re-queueing are one function because they are one concept —
 * "this message is waiting, and here is why" — and because every caller reaches
 * it from the same place in {@link attemptDispatch}. The difference is only
 * whether a row already exists: a drain re-attempt hands back the rows it
 * claimed, an inline attempt has none yet.
 *
 * Returns the row the wait now sits on, or null when a re-queue lost its row
 * (deleted under the drain), which the caller treats as "nothing to do".
 */
export function recordQueuedMessageWait(
  deps: QueueWaitDeps,
  args: RecordQueuedMessageWaitArgs,
): ThreadQueuedMessage | null {
  const claimed = args.claimed ?? [];
  const leadClaim = claimed[0];
  let row: QueuedThreadMessageRow | null;

  if (leadClaim === undefined) {
    row = deps.db.transaction(
      (tx) => {
        if (isRestartResumeRetry(args.message.payload)) {
          assertRestartResumeNotHeld(
            { db: tx, logger: deps.logger },
            args.thread.id,
          );
        }
        assertThreadHostAcceptsWork(tx, args.thread);
        const created = createQueuedThreadMessageInTransaction(tx, {
          threadId: args.thread.id,
          content: args.message.input,
          senderThreadId: args.message.senderThreadId,
          origin: args.message.origin,
          originPluginId: args.message.originPluginId,
          requestedBy: args.message.requestedBy,
          model: args.message.execution.model,
          reasoningLevel: args.message.execution.reasoningLevel,
          permissionMode: args.message.execution.permissionMode,
          serviceTier: args.message.execution.serviceTier,
          waitingOn: args.waitingOn,
          sendAt: args.sendAt,
          payload: args.message.payload,
          systemNotice: args.message.systemNotice,
          deliveryMode: args.message.deliveryMode,
        });
        return args.placement === "front"
          ? moveQueuedThreadMessageToFrontInTransaction(tx, created)
          : created;
      },
      { behavior: "immediate" },
    );
    const written = row;
    afterCommit(deps.db, () => {
      recordTurnEndPluginHold(deps, written, args.turnEndWait ?? null);
    });
  } else {
    row = requeueClaimedQueuedThreadMessages(deps.db, deps.hub, {
      claims: claimed.map((claim) => ({
        id: claim.id,
        claimToken: claim.claimToken,
      })),
      threadId: args.thread.id,
      waitingOn: args.waitingOn,
      sendAt: args.sendAt,
      onRequeued: (rows) => {
        for (const row of rows) {
          recordTurnEndPluginHold(deps, row, args.turnEndWait ?? null);
        }
      },
    });
  }

  if (row === null) {
    // The claim no longer holds: the row was deleted under the drain, or a
    // stale-claim sweep reclaimed it. Either way there is no row left to queue.
    return null;
  }
  const entry = toThreadQueuedMessage(row);
  emitPluginMessageQueued(entry);
  deps.hub.notifyThread(args.thread.id, ["queue-changed"]);
  return entry;
}

/**
 * Records that a queued row's waits all cleared and it dispatched. Called
 * AFTER the row is consumed, so a plugin listening on `message.dispatched` sees
 * the row leave the queue rather than a row that is about to.
 */
export function settleQueueRowsDispatched(
  hub: DbNotifier,
  rows: readonly ClaimedQueuedThreadMessageRow[],
): void {
  for (const row of rows) {
    forgetTurnEndPluginHold(row.threadId, row.id);
  }
  const lead = rows[0];
  if (lead !== undefined) {
    emitPluginMessageDispatched(toThreadQueuedMessage(lead));
    hub.notifyThread(lead.threadId, ["queue-changed"]);
  }
}

/**
 * Drops a row's wait so the next drain re-attempts it. The row stays exactly
 * where it is in the queue; only its eligibility changes.
 */
export function clearQueuedMessageWait(
  deps: { db: DbConnection; hub: DbNotifier },
  args: { queuedMessageId: string; threadId: string },
): QueuedThreadMessageRow | null {
  const row = getQueuedThreadMessage(deps.db, args.queuedMessageId);
  const waitingOn =
    row === null ? null : parseStoredQueuedThreadMessageWaitingOn(row);
  if (
    waitingOn?.kind === "plugin" &&
    waitingOn.notBefore !== undefined &&
    waitingOn.notBefore > Date.now()
  ) {
    return setQueuedThreadMessageWaitingOn(deps.db, deps.hub, {
      id: args.queuedMessageId,
      threadId: args.threadId,
      waitingOn: { kind: "time" },
      sendAt: waitingOn.notBefore,
    });
  }
  return clearQueuedThreadMessageWaitingOn(deps.db, deps.hub, {
    id: args.queuedMessageId,
    threadId: args.threadId,
  });
}

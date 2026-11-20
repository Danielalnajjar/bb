# Fork backlog

Follow-up findings for this fork. GitHub issues are off on the fork, so findings that a change does not fix go here. Each entry gives the finding, its evidence, and why it was not fixed in the change that found it. Remove an entry when its fix merges.

## Restart continuations

- **Plugins get no typed signal that BB is continuing a cut turn.** A plugin that keeps per-turn state (Crew) has to infer from event order, the queue and retry ancestry that a restart-cut turn will be continued. Two residual races remain, and each costs at most one lead notice. In one, Crew is offline for an older failure when a restart cuts a newer turn. In the other, Crew is still handling a refused continuation when a later turn is cut. Fix: put the restart continuation on the failure or interruption event, or on the SDK thread response, then delete Crew's inference. It needs a plugin SDK change, which the queue-admission change (`fix/queue-admission-0501`) could not make.
- **A restart retry replay loses its input groups.** When the provider never accepted the original request, the native restart retry replays the original input blocks in order, separators included, but drops `inputGroups`. A restart retry is a single queued row, and the queue drain sends `inputGroups` only when it claims more than one row (`apps/server/src/services/threads/queued-messages.ts`, `inputGroups.length > 1`). This is stock 0.50.1 behavior, observed in the Q2 loopback acceptance run. Fix: store the original groups on the retry row and replay them.

## Queue admission

- **A restart hold that lands during a pending hook can meet a regrouped queue.** An automatic attempt claims a group that holds a restart retry. A plugin then sets the restart hold while the attempt's dispatch hook is still pending, a user regroups the rows, and the hook fails. After the claim is released, the failure recorder decides from the rebuilt group whether to record a failure on the attempted row (`apps/server/src/services/threads/queue-drain-failure.ts`). If the regroup moved the restart retry out of that row's group, the attempted row can be marked failed although a held restart retry was part of the attempt. All three events must coincide, and Send now or a retry recovers the row.

## Event durability

### B-01. A directory-continuation completion can permanently lose the parent result

A child turn completion can carry an environment-directory continuation. The completion transaction then stamps the completion row lifecycle-applied and parent-notice-handled, while the continuation and its fallback parent notice exist only in memory, in an after-response deferral. A server crash after the commit and before the deferral runs loses the parent's result permanently: a replay of the same identified completion is a no-op, and startup recovery does not scan settled idle children. Found by the ChatGPT Pro review of fork #11's pre-merge head (`49b15183d`); the paths below are unchanged at `8dbd3920347b5189c74ec082c5844daf6624a4c9`. Not fixed in #11: the fix needs a new durable obligation recovered at startup, which was outside #11's recorded scope, and the deferred continuation code is shared with other changes. The captain accepted it as a remaining risk.

**Trigger sequence**

1. A parent-notifiable child (`parentNotifications: "auto"`) runs a turn that includes a completed environment-directory update, so `findEnvironmentDirectoryContinuation` returns a continuation for the completion plan.
2. The child has no outstanding request answers, so `turn/completed` moves it to `idle`.
3. In `completeRootTurn`'s IMMEDIATE transaction:
   - `noticesDue` is false because the plan has a continuation and the child is idle, so no parent notice row is written;
   - `markEventLifecycleApplied` stamps the completion row;
   - `handedToContinuation` is true because the in-memory continuation carries a fallback parent notification, so `markTurnCompletionParentNoticeHandled` also stamps `parentNoticeHandled`.
4. The transaction commits. The continuation follow-up is handed to `deferAfterResponse`, which is memory only.
5. The server is killed (SIGKILL, OOM or a deploy) before the deferred callback runs.
6. After restart, the daemon retries the same identified completion. `isEventLifecycleApplied` is true, so the transaction returns unchanged and neither the continuation nor its fallback notice is rebuilt.
7. Startup recovery (`recoverThreadLifecyclesAfterRestart`) visits only threads awaiting turn-request answers, not this idle child.

Result: the parent never receives the child's result. A concrete fallback case: the child's current environment differs from the operation's recorded `nextEnvironmentId`, so `continueAfterEnvironmentDirectoryUpdate` would return false and deliver the parent result through the fallback. The crash loses that obligation.

On base 0.50.1 the same crash also loses the continuation, but an ID-less retry could re-send the notice through the ignored-completion path. With #11's stamps, a retry cannot.

**Locations (permalinks at `8dbd3920`)**

- Replay short-circuit: https://github.com/Danielalnajjar/bb/blob/8dbd3920347b5189c74ec082c5844daf6624a4c9/apps/server/src/services/threads/turn-end-follow-ups.ts#L593-L606
- Lifecycle stamp: https://github.com/Danielalnajjar/bb/blob/8dbd3920347b5189c74ec082c5844daf6624a4c9/apps/server/src/services/threads/turn-end-follow-ups.ts#L613-L616
- `noticesDue` with a continuation: https://github.com/Danielalnajjar/bb/blob/8dbd3920347b5189c74ec082c5844daf6624a4c9/apps/server/src/services/threads/turn-end-follow-ups.ts#L637-L638
- `parentNoticeHandled` stamped for an in-memory handoff: https://github.com/Danielalnajjar/bb/blob/8dbd3920347b5189c74ec082c5844daf6624a4c9/apps/server/src/services/threads/turn-end-follow-ups.ts#L661-L673
- Deferred continuation and fallback execution: https://github.com/Danielalnajjar/bb/blob/8dbd3920347b5189c74ec082c5844daf6624a4c9/apps/server/src/services/threads/turn-end-follow-ups.ts#L280-L298
- After-response deferral of follow-ups: https://github.com/Danielalnajjar/bb/blob/8dbd3920347b5189c74ec082c5844daf6624a4c9/apps/server/src/internal/events.ts#L655-L674
- Continuation decision (can return false and take the fallback): https://github.com/Danielalnajjar/bb/blob/8dbd3920347b5189c74ec082c5844daf6624a4c9/apps/server/src/services/threads/environment-directory-continuation.ts#L62-L93
- Startup recovery scope: https://github.com/Danielalnajjar/bb/blob/8dbd3920347b5189c74ec082c5844daf6624a4c9/apps/server/src/services/threads/thread-lifecycle.ts#L1324-L1332

**Proposed reproduction**

There is no automated reproduction yet. The existing crash test, `apps/server/test/threads/child-completion-crash-recovery.test.ts`, with its fixture `apps/server/test/threads/fixtures/child-notice-crash.ts`, cuts before and after the ordinary parent notice, not at this point. Proposed test, extending that harness:

1. Seed a parent and an auto-notify child. Give the child a completed environment-directory operation whose recorded `nextEnvironmentId` differs from the child's current environment, so the continuation must fall back to the parent notice.
2. In the forked fixture process, post the child's identified `turn/completed` and SIGKILL the process right after the completion transaction commits, before `deferAfterResponse` work runs. The existing fixture's IPC receipt pattern applies.
3. Reopen the database with `withTestHarness`, run `runStartupRecoverySweep`, replay the same identified completion through `/internal/session/events`, and run `runPeriodicSweeps` twice.
4. Expected: exactly one parent `child-completed` result (a queued row or a `client/turn/requested` system turn). Actual, by the code path above: none.

Also cover the release of a held, continuation-bearing completion.

**Pro review text (verbatim)**

> - **[B-01] Directory-continuation completions can permanently lose the parent result**
>   - **Severity:** BLOCKER
>   - **Location:** `apps/server/src/services/threads/turn-end-follow-ups.ts:L581-L675`; `apps/server/src/internal/events.ts:L656-L675`; `apps/server/src/services/threads/environment-directory-continuation.ts:L62-L93`.
>   - **Failure scenario:** A parent-notifiable child completes a turn containing a completed environment-directory update. With no outstanding request answers, the completion moves the child to `idle`. Because the plan contains a continuation, `noticesDue` is false, so the transaction writes no parent notice. Nevertheless, it stamps `lifecycleApplied`, and it stamps `parentNoticeHandled` merely because the returned in-memory continuation carries a fallback parent notification. Kill the server after this commit and before the deferred callback executes. On retry, `isEventLifecycleApplied` causes an immediate unchanged return, so neither the continuation nor its fallback notice is reconstructed. Startup recovery scans only threads with outstanding lifecycle work, not this settled idle child (`thread-lifecycle.ts:L1325-L1332`). For a concrete fallback case, let the child’s current environment differ from the operation’s recorded `nextEnvironmentId`: the continuation would return false and deliver the parent result, but the crash loses that obligation permanently.
>   - **Evidence:**
>     ```text
>     const noticesDue =
>       plan.continuation === null || !(idle || ended.disposition === "held");
>     ```
>     ```text
>     const handedToContinuation =
>       idleFollowUp?.kind === "environment-directory-continuation" &&
>       idleFollowUp.parentNotification !== null;
>     if (
>       handedToContinuation ||
>       writes.some(
>         ({ write }) => write.kind === "created" || write.kind === "merged",
>       )
>     ) {
>       markTurnCompletionParentNoticeHandled(tx, {
>         threadId: thread.id,
>         sequence: args.completionSequence,
>       });
>     }
>     ```
>     The lifecycle stamp is written at `turn-end-follow-ups.ts:L613-L616`; the replay short-circuit is at `L593-L605`. The continuation/fallback executes later at `L280-L298`.
>   - **Violates:** D2’s crash-durable parent-result guarantee and the claim that unfinished lifecycle effects can be repaired from row stamps. **Design-fitness category: simplification; verdict: UNDERPOWERED.**
>   - **Required fix:** Persist the continuation/fallback obligation in the completion transaction and recover it after restart. Set `parentNoticeHandled` only after a notice or a durable, recoverable handoff exists. Cover both ordinary completion and release of a held continuation-bearing completion.

> Test suggested by the same review:
>
> - **[T-01] Continuation/fallback crash durability — B-01.** Kill a file-backed server after the completion/stamp commit but before deferred continuation work. Restart and replay the same identified completion. Verify exactly one durable continuation or fallback parent result, including a moved-environment fallback and release of a held completion. Existing crash tests do not cut here.

Fix direction (from the review): persist the continuation or fallback obligation in the completion transaction, recover it after restart, and set `parentNoticeHandled` only once a notice or a durable, recoverable handoff exists. Cover both ordinary completion and release of a held continuation-bearing completion.

## Server move

- **A periodic queue pass that began before a server-move freeze can still send.** The sweep timer checks `isServerMoveFrozen` once, before it starts a registry pass (`apps/server/src/start-server.ts`). The queue jobs in that pass (`queued-message-auto-send` with its idle-thread, busy-notice and returned-host lanes, the due-scheduled sweep and the failed-retry sweep) do not check the freeze again before each offer, and neither does the targeted offer or the append preflight (`apps/server/src/services/threads/queued-message-dispatch.ts`, `thread-send.ts`). A freeze that lands while an earlier job in the pass is still running therefore does not stop the later jobs from consuming a row after the move snapshot, and the destination can then offer the same input again. The `serverMove` experiment is off both by default and for early adopters (`packages/domain/src/experiments.ts`). Found by the plan adversary review of the host-offline retry change (`fix/host-offline-retry-0501`); not fixed there because the gap is shared by every periodic queue lane, and a check in one lane would leave the others open. Fix: check the freeze in the sweep runner before each queue job and each item, or once in the shared automatic-offer path.

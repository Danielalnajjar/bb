## Verdict

Amend before discovery

Review mode: parallel subagents (GPT-5.6 Sol)
Plan reviewed: [`../exec-plan.md`](../exec-plan.md)
Repo context checked: the BB repository root — `docs/system-overview.md`; `packages/thread-view`; `packages/server-contract`; `packages/db/src/data/events.ts`; `packages/domain`; `apps/server/src/internal/events.ts`; `apps/app`; `plugins/provider-claude-code/src/bridge/bridge.ts`; `host-daemon-contract/test/contract.test.ts`; existing Vitest/RTL/SQLite/host-RPC/CLI harnesses. No `CONTEXT.md` or `docs/adr`.

## Material Findings

### Blocker

- [Code quality, Testing] Event and thread contract; Publication steps 2–4; Milestone 2 / DB/server #10; Validation no-ship first-send: imported-message rows are unspecified on `events.provider_thread_id`, and first-send proof only checks that “some UUID is resumed.”
  Why it matters: `getLastStoredProviderThreadId` returns the latest non-null `provider_thread_id` on any event, not the identity event. If imported-message rows store the source session UUID, `prepareReadyThreadTurnCommand` will `turn.submit` the source and create the two-writer failure v1 exists to prevent. A sketch that only asserts the stored identity stays green for a publish-that-never-resumes path, which cold-starts `thread.start`.
  Evidence: Plan writes `thread/identity` (owned UUID) then `system/imported-message` events and never pins `events.provider_thread_id` on those rows. Repo: `getLastStoredProviderThreadId` / `prepareReadyThreadTurnCommand` resume the latest non-null stored provider id.
  Amendment: State that `system/imported-message` and `system/thread-imported` are unscoped system events with null `events.provider_thread_id`; source session id and source message id live only in payload. Require a public-surface first-send proof via `withTestHarness` and `listQueuedThreadCommands`/`waitForQueuedCommand`: after a history-on publish, send one ordinary message and observe exactly one `turn.submit` whose `resumeContext.providerThreadId` is the owned UUID, `getLastProviderThreadId` equals that owned UUID, zero `thread.start`, and never the source UUID.

- [Testing] Milestone 2 proof; Provider/host sketches #4/#8; Validation no-ship source-safety: source-safety is not falsifiable under the repo’s existing SDK-mock pattern.
  Why it matters: Dual-write / source mutation is a permanent-harm no-ship. Every current Claude bridge test `vi.mock`s `forkSession`, so a mocked prepare/abort can report a new UUID and unchanged hashes without touching session files.
  Evidence: Plan M2 asks for unchanged source hashes on fixture stores. Repo Claude bridge tests already mock `forkSession` / related SDK methods.
  Amendment: Require a named plugin-package proof under `turbo run test` against a disposable `CLAUDE_CONFIG_DIR`/project store and the pinned bundled CLI: hash source and subagent files, call real `listSessions` / `forkSession` / `getSessionInfo` / `deleteSession` with no `vi.mock` of those SDK methods, assert source hashes unchanged, owned UUID ≠ source, and abort deletes only the verified owned fork. If the real SDK cannot run in CI, that is an explicit no-ship, not a mocked substitute.

### Major

- [Code quality, Architecture, Testing] Data Model `thread_id` / `canonical_source_claim`; D10; Acceptance #10: claim lifetime and `thread_id` retention are unnamed against the real thread lifecycle, and sketches only cover pre-publish abort.
  Why it matters: Public delete is `markThreadDeleted` then `finalizeStoppedThread` hard-deletes the thread row. A unique FK with `RESTRICT`/`NO ACTION` makes delete finalization throw; `ON DELETE CASCADE` deletes the provenance row the plan says survives; `ON DELETE SET NULL` breaks published-requires-non-null `thread_id`. If an aborted or deleted first import still holds `canonical_source_claim`, the next default import Opens existing against a gone thread. Archive vs delete is the uniqueness Interface of `provider_imports`; without one owner, release/keep decisions scatter and AC #10 cannot be implemented or proven.
  Evidence: Plan: `thread_id` “nullable then unique, foreign key to `threads` with deliberate retention semantics”; D10 / AC #10; abort sketches only. Repo: `markThreadDeleted`, `finalizeStoppedThread`, archive forwarder on owned UUID.
  Amendment: Pin the claim Interface in the domain/DB module in one place: (1) `thread_id` `onDelete` is `SET NULL` plus a non-published-or-reclaimed stage, or no FK and a logical id; (2) abort releases `canonical_source_claim`; (3) archive keeps the claim and **Open existing** (including archived) and uses the existing owned-UUID archive forwarder without touching the source; (4) `deletedAt` set releases `canonical_source_claim` so a later default import may create a new operation/fork; the import row remains as provenance (do not cascade-delete it); catalog classification treats a claim whose thread is deleted as not already-imported — never **Open existing** to a missing thread. Add M3/DB public-surface cases with explicit observables via `archiveThread`, `markThreadDeleted`, and `deleteThread`: archive keeps provenance GET-able and default re-import as Open existing without deleting the owned UUID; name whether soft-delete retains/tombstones the import row and whether the owned fork is deleted; apply the same named outcomes to hard delete/sweep; abort after published rejects with source and owned files unchanged.

- [Code quality] Operation State Machine — Abort transitions; App Cancel makes no mutation: abort is allowed only from `reserved`, `provider_prepared`, and `needs_attention`.
  Why it matters: `preparing`, `staging_history`, and `ready_to_commit` are the states where an owned fork already exists or is in flight. A user who cancels during prepare or history paging cannot use the specified abort route; the fork leaks, or they are stuck until the saga finishes. Resume-from-preparing is specified; cancel-from-preparing is not.
  Evidence: Plan transition graph: `reserved/provider_prepared/needs_attention -> aborting -> aborted`. Abort text assumes a “known owned prepared fork.”
  Amendment: Allow abort from every pre-published stage. From `preparing`, reconcile the marker first, then delete a verified owned fork or stay in `needs_attention` if the delete is ambiguous. Add that case to the DB/server test sketches.

- [Code quality] D7 inspector preview; App Inspector and consent; Operation step 4; App Cancel makes no mutation: preview from the owned/selected session, history only from the post-fork owned chain, and cancel with no provider mutation cannot all be true.
  Why it matters: Before prepare there is no owned fork. Preview from the source can differ from the remapped `forkSession` chain the user later gets. Preview from an owned fork means toggling history calls `forkSession` before commit, so Cancel is not mutation-free.
  Evidence: Plan D7 / inspector: “Turning it on fetches a bounded preview from the owned/selected session”; “Cancel makes no mutation.” Step 4: messages must be read from the owned fork.
  Amendment: Pick one and write it down. Recommended: pre-commit preview is a bounded source `getSessionMessages` read (no fork); the commit path restages from the owned fork; the inspector states that published history is the remapped owned chain and may omit or reorder relative to the preview. If preview must be the owned chain, turning history on is an explicit prepare, and Cancel must run abort.

- [Code quality, Architecture] Milestone 1/6; Published thread; Concrete Implementation Areas; Validation turbo filters; D11: two new thread-scoped event types are specified only for `packages/domain` and `apps/app`, but they belong to several closed graphs whose Module is `@bb/thread-view`.
  Why it matters: `listThreadSearchSegmentsForStoredEventArgs` only indexes three live event types, so new types produce no FTS unless publication writes segments and names a source kind. Thread-view event-decode and `apps/server/src/internal/events.ts` `assertNever` switches will fail or default-swallow. Projecting imported text as conversation user/assistant rows attaches edit/steer/retry. An app-only historical region is a second Adapter at a hypothetical Seam: remote and CLI clients would drop the events or treat them as live system rows. Acceptance 8/12 and reachable-on-remote-clients cannot be satisfied from the app Module alone. `@bb/thread-view` is not in the file list or turbo filters.
  Evidence: Plan event contract + Milestone 6 app projection. Repo: `@bb/thread-view` is the timeline Interface for server timeline HTTP, `bb thread show`, and the app; `packages/server-contract` timeline rows are a closed union.
  Amendment: Put the historical-region Interface in `@bb/thread-view` plus `packages/server-contract` timeline row types: decode the new events and emit first-class inert rows (one boundary plus ordered imported messages, no live tool/task/approval affordances). App and CLI only render those rows. Add `packages/thread-view`, `packages/db/src/data/events.ts`, and `apps/server/src/internal/events.ts` to Milestone 6, Concrete Implementation Areas, and Turbo typecheck/test filters. Require scope plus schema plus `ThreadEventDataByType`; decode/host-event cases that return null `providerThreadId`; a dedicated inert projection/timeline row kind; one FTS owner (extend the stored-event indexer or write segments only in the publication command, not both); and a new `imported_message` `ThreadSearchSourceKind` so search deep-links into the historical region.

- [Code quality] Provider Bridge — `session/import/prepare`; existing `thread/fork` in `plugins/provider-claude-code/src/bridge/bridge.ts`: the plan does not say prepare must not reuse `handleThreadFork` / `thread/fork`.
  Why it matters: Current `thread/fork` calls `forkSession` and then `createThreadSession` plus `session.start`, opening a live writer on the new UUID before BB has published or decided to keep the fork. Copying that handler gives two writers, or a live session that abort/`deleteSession` may not treat as a quiescent prepare artifact.
  Evidence: Plan prepare text lists `forkSession` / marker reconcile but never forbids delegation to `thread/fork`. Repo `handleThreadFork` starts a live `ThreadSession`.
  Amendment: `session/import/prepare` may call `forkSession` / `getSessionInfo` / marker list only. It must not create a `ThreadSession`, must not `session.start`, and must not delegate to `thread/fork`. Conformance: after prepare, no live bridge session exists for the owned UUID.

- [Architecture] D8; Public API list candidates by `hostId`; CLI `bb thread continue claude-code list --machine`; Candidate states; Pure/domain sketch 3: Ready/Mapping needed/Already in BB classification is specified as one domain Module, but the public list/inspect Interface is host-only.
  Why it matters: Environments are unique on `(projectId, hostId, path)`; two projects may attach the same folder. The product entry is project-scoped. Without project scope on the catalog Interface, classification cannot live in one server/domain Module without leaking BB environment inventory across the host Seam or duplicating mapping in app/CLI Adapters. A host+path match can bind the wrong project’s environment. CLI cannot reproduce the same Ready/exception grouping.
  Evidence: Plan public API lists by `hostId`; CLI takes `--machine` and no `--project`. Repo environments unique on `(projectId, hostId, path)`.
  Amendment: Require project scope (`projectId`) on list, inspect, and start. Domain classification joins source cwd/worktree identity to ready environments in that project on that host. Host/bridge still return only raw path/revision facts. CLI takes `--project` (required, like spawn) or the same project resolution other project-scoped thread commands use.

- [Testing] Milestone 3 proof; DB/server integration #4–#5; Validation AC #6: restart and idempotent-fork proof is assigned to the wrong surface and can be hidden by the host stub.
  Why it matters: A retry path that can fork twice is a no-ship, and process-kill convergence is AC #6. `:memory:` dies with the process, so sketch #5 cannot observe durable resume. A host-RPC stub that always returns the same owned UUID makes a second `forkSession` invisible.
  Evidence: Plan M3 promises in-memory SQLite public-route integration then kill/recreate the service after each phase.
  Amendment: Split the proof. In-memory server tests must use a stateful host-RPC fake that issues a new owned UUID only on a fresh prepare/fork and returns the same UUID on marker reconcile; lost-response/resume must persist one owned UUID and one thread, and a second fork must fail the test. Process kill/recreate belongs on a file-backed DB or the `@bb/integration-tests` fake/recovery harness (add that Turbo filter if used). Do not claim kill/recreate from `:memory:`.

- [Testing] D6; DB/server #6–#7 and React DOM #5; Validation AC #7: consent proofs stop at no imported events/FTS in the DB and a UI preview toggle.
  Why it matters: Hidden history indexing and remote leakage are no-ships. Proofs do not show a resume/retry cannot flip stored `includeReadableHistory` from false to true, and they do not observe public timeline, public search, thread GET, or plugin `thread.created`. Catalog/search-must-not-use-transcript-text is only implied on the provider list shape.
  Evidence: Plan D6 / sketches #6–#7 / React DOM #5. AC #7 no-ship for hidden history.
  Amendment: Add public-route negatives: resume/retry with `includeReadableHistory` true against a stored false leaves consent false and creates no imported events/FTS; consent-off GET timeline, GET search canary, and thread GET expose no imported text, and plugin `thread.created` fires once after commit with no message bodies; consent-on those same public GETs show the ordered projection/canary; list/inspect/start for host A reject host B’s session id; inspect without explicit preview consent returns no message text.

- [Testing] D4; Milestone 2; Validation no-ship (protocol change without version bump): M2 proof never asserts the host protocol version moved off 130.
  Why it matters: An old enrolled daemon can connect and then invalid-message-loop. Adding new online-RPC command types updates the exhaustive fixture `Record` (typecheck forces that) but leaves the version pin green if the version is not bumped. That is an explicit repo invariant and a plan no-ship.
  Evidence: Plan D4 increments `HOST_DAEMON_PROTOCOL_VERSION` from 130. Repo `host-daemon-contract/test/contract.test.ts` pins `expect(HOST_DAEMON_PROTOCOL_VERSION).toBe(130)`.
  Amendment: M2 proof must change the pinned contract assertion to the new version with a comment that session-import RPCs required the bump, add the new command types to `ONLINE_RPC_RESPONSE_RESULT_FIXTURES`, and keep the already-planned typed unsupported result for older bridges.

- [Restraint] Data Model `provider_import_messages`; Operation steps 4–5 (`staging_history`, `ready_to_commit`); D5/D11; DB sketches 5 and 7: the staging table plus two persisted mid-history stages fail Need, Authority, and Proportion.
  Why it matters: They replica a quiescent owned fork rather than preserve work that would otherwise be lost. A second table, cursor/upsert/delete-in-commit protocol, and two extra CAS states become a permanent saga surface; kill-after-staging tests then certify bookkeeping, and crash windows plus consent proofs get two sources that can disagree.
  Evidence: Plan `provider_import_messages` plus `staging_history` / `ready_to_commit`. Prepare already produces a quiescent owned fork that can be re-paged.
  Amendment: Delete `provider_import_messages` and the `staging_history` / `ready_to_commit` stages. After `provider_prepared`, the same begin/resume/commit step pages the owned fork into memory under existing size bounds and writes imported events plus FTS inside the publication transaction; a crash before commit re-pages from the fork. Keep `include_readable_history` on the operation row as the only consent authority.

- [Restraint] D9 post-publish rename; `session/import/finalize`; Operation step 7; Published thread / Thread Info cleanup status: an import-only finalize/rename lane fails Need, Ownership, and Proportion.
  Why it matters: Continuation identity is already independent of the Claude title. It adds a host mutation after the success path, a bridge/runtime/daemon command, a cleanup-issue field, and Thread Info cleanup UI for a property the plan says must not gate publication — a second title owner beside the BB thread title and `thread/name/set`.
  Evidence: Plan step 7 / D9 / `session/import/finalize` via `renameSession`. Existing owner: `thread/name/set`.
  Amendment: Keep the operation-marker title on the owned Claude session. Drop `session/import/finalize`, the post-publish rename, and rename-derived cleanup issues. Filter later catalogs by owned UUID (in-flight marker only before publish). If titles must later match BB, enable Claude `thread/name/set` as the existing owner after the thread exists.

- [Restraint] Operation State Machine, final paragraph (startup/reconnect reconciliation): silent startup auto-resume plus explicit Resume fails Ownership and Proportion.
  Why it matters: Two retry owners are scheduled for the same durable row. A boot/reconnect dispatcher that mutates the provider is a background queue under another name; it races the UI/CLI/SDK Resume path, can fork or delete while the user is looking at the same operation, and contradicts the plan’s own no-unseen-background-queue rule.
  Evidence: Plan: “Startup/reconnect reconciliation lists nonterminal operations. It may automatically resume only transitions proven idempotent. `preparing` always reconciles the operation marker.” Also: “v1 does not promise an unseen background queue.”
  Amendment: One resume owner: the begin/resume route and the SDK/CLI/UI that call it. Startup/reconnect may list nonterminal operations and surface Resume; they must not dispatch host mutations. `preparing` reconciles the marker only when that resume is invoked.

- [Restraint] Operation State Machine step 6 (Verify): runtime read-back that can reclassify a committed publish as `needs_attention` fails Need, Authority, and Proportion.
  Why it matters: Either `published` is no longer terminal, or the thread becomes queryable while the operation is held pre-publish — the half-published state the saga exists to forbid — and implementers will add repair states around a follow-up SELECT.
  Evidence: Plan step 6: failed public-query read-back marks `needs_attention` while retaining owned fork/thread IDs. Milestone 3: “no half-published thread is queryable.”
  Amendment: Delete runtime verify-and-reclassify. The publication transaction is the authority. Prove public-query read-back in tests. A lost HTTP response retries the same operation ID and returns the already-published thread.

### Minor

- [Testing] Test Sketches Before Implementation; Validation and Acceptance: the sketches tell implementers to invent setup and never require test-value rows for the no-ship proofs.
  Why it matters: A new parallel harness will mock the collaborator under test (SDK, host RPC, QueryClient) and the no-ship cases will become coverage theater.
  Evidence: Existing repo harnesses already cover the needed surfaces; plan sketches do not name them or require test-value rows.
  Amendment: Before new tests, reuse `withTestHarness`, `registerHostRpcResponder`, `listQueuedThreadCommands`, `createQueryClientTestHarness`, command-output-harness, `PersistentResponsiveDrawerShell` tests, `ProjectListActionButtons` tests, `withWriteAfterFirstRead`, and the integration recovery harness (extend those tests rather than adding siblings). For every new or materially changed no-ship proof (source-safety, first-send, one-fork, consent, abort/retention, protocol bump), require a test-value row: risk, surface, why it fails for no-op/inverted rule/wrong identity, mock boundary, and Turbo command.

## Plan Amendments

1. Pin `system/imported-message` and `system/thread-imported` as unscoped system events with null `events.provider_thread_id`; source session/message ids live only in payload. After a history-on publish, `getLastProviderThreadId` equals the owned UUID. First-send proof: one ordinary send yields exactly one `turn.submit` with `resumeContext.providerThreadId` = owned UUID, zero `thread.start`, never the source UUID.

2. Require a real-SDK source-safety proof in the plugin package (disposable `CLAUDE_CONFIG_DIR`, pinned bundled CLI, no `vi.mock` of `listSessions`/`forkSession`/`getSessionInfo`/`deleteSession`): source and subagent hashes unchanged, owned ≠ source, abort deletes only the verified owned fork. If the real SDK cannot run in CI, that is an explicit no-ship.

3. Specify claim/retention in one place: `thread_id` `onDelete` is `SET NULL` plus a non-published-or-reclaimed stage (or no FK / logical id); abort releases `canonical_source_claim`; archive keeps the claim and **Open existing** (including archived) via the owned-UUID archive forwarder and does not touch the source; `deletedAt` releases the claim so a later default import may create a new operation/fork; the import row remains as provenance; catalog treats a deleted-thread claim as not already-imported. Prove archive / soft-delete / hard-delete / post-publish abort with named public-surface observables.

4. Allow abort from every pre-published stage. From `preparing`, reconcile the marker first, then delete a verified owned fork or stay in `needs_attention` if delete is ambiguous. Add that case to DB/server sketches.

5. Resolve the preview contradiction in writing. Recommended: pre-commit preview is a bounded source `getSessionMessages` read (no fork); commit restages from the owned fork; inspector states published history is the remapped owned chain and may omit or reorder relative to preview. Alternative: history-on is an explicit prepare, and Cancel must run abort.

6. Put the historical-region Interface in `@bb/thread-view` plus `packages/server-contract` timeline row types (inert boundary + ordered imported messages, no live affordances). Add `packages/thread-view`, `packages/db/src/data/events.ts`, and `apps/server/src/internal/events.ts` to implementation areas and Turbo filters. Require scope + schema + `ThreadEventDataByType`; decode/host-event cases returning null `providerThreadId`; one FTS owner; new `imported_message` `ThreadSearchSourceKind`.

7. `session/import/prepare` may call `forkSession` / `getSessionInfo` / marker list only. It must not create a `ThreadSession`, must not `session.start`, and must not delegate to `thread/fork`. After prepare, no live bridge session exists for the owned UUID.

8. Require `projectId` on list, inspect, and start. Domain classification joins source cwd/worktree identity to ready environments in that project on that host. Host/bridge return only raw path/revision facts. CLI takes `--project` (or the same project resolution other project-scoped thread commands use).

9. Split restart / one-fork proof: in-memory tests use a stateful host-RPC fake (new owned UUID only on fresh prepare/fork; same UUID on marker reconcile; a second fork fails the test). Process kill/recreate belongs on a file-backed DB or `@bb/integration-tests` recovery harness. Do not claim kill/recreate from `:memory:`.

10. Add consent public-route negatives: resume/retry cannot broaden stored `includeReadableHistory`; consent-off GET timeline / search / thread GET expose no imported text; plugin `thread.created` fires once after commit with no message bodies; consent-on those GETs show the ordered projection; cross-host session ids are rejected; inspect without preview consent returns no message text.

11. M2 must change the pinned `HOST_DAEMON_PROTOCOL_VERSION` assertion off 130 with a comment that session-import RPCs required the bump, add new command types to `ONLINE_RPC_RESPONSE_RESULT_FIXTURES`, and keep the typed unsupported result for older bridges.

12. Delete `provider_import_messages` and the `staging_history` / `ready_to_commit` stages. After `provider_prepared`, the same begin/resume/commit step pages the owned fork into memory under existing size bounds and writes imported events plus FTS inside the publication transaction; a crash before commit re-pages from the fork. `include_readable_history` on the operation row is the only consent authority.

13. Drop `session/import/finalize`, the post-publish rename, and rename-derived cleanup issues. Keep the operation-marker title on the owned Claude session. Filter later catalogs by owned UUID (in-flight marker only before publish). If titles must later match BB, use existing `thread/name/set` after the thread exists.

14. One resume owner: the begin/resume route and the SDK/CLI/UI that call it. Startup/reconnect may list nonterminal operations and surface Resume; they must not dispatch host mutations. `preparing` reconciles the marker only when that resume is invoked.

15. Delete runtime verify-and-reclassify. The publication transaction is the authority. Prove public-query read-back in tests. A lost HTTP response retries the same operation ID and returns the already-published thread.

16. Before new tests, reuse `withTestHarness`, `registerHostRpcResponder`, `listQueuedThreadCommands`, `createQueryClientTestHarness`, command-output-harness, `PersistentResponsiveDrawerShell` tests, `ProjectListActionButtons` tests, `withWriteAfterFirstRead`, and the integration recovery harness. Require a test-value row for every new or materially changed no-ship proof.

## Lane Results

| Lane         | Result   | Notes                                                                                                                                                                                                                                                                 | Evidence                                                                                                                                                                                                          |
| ------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code quality | findings | Event identity, abort coverage, claim/FK retention, preview/mutation contradiction, closed event/search/timeline graphs, and prepare-vs-`thread/fork` were grounded in current source. One createThread finding was pre-refuted.                                      | Event contract + publication steps 2–4; abort graph; D7/D10/D11; `getLastStoredProviderThreadId`; `handleThreadFork`; `markThreadDeleted` / `finalizeStoppedThread`; `listThreadSearchSegmentsForStoredEventArgs` |
| Architecture | findings | No ADRs. Historical-region locality belongs in `@bb/thread-view`; catalog classification needs project scope; claim Interface must name archive vs delete. Host/bridge/runtime layering and the dedicated publication saga were not treated as defects.               | `@bb/thread-view` + `packages/server-contract` closed unions; environments unique on `(projectId, hostId, path)`; D8/D10                                                                                          |
| Testing      | findings | No Convex or Playwright suite; browser/iOS stays on the plan’s state-based-browser-qa lane. No-ship source-safety/first-send proofs are not falsifiable as written; restart, retention, consent, protocol-bump, and harness-reuse gaps remain.                        | M2/M3 proofs; `vi.mock` of `forkSession`; `:memory:` + constant-UUID stubs; `HOST_DAEMON_PROTOCOL_VERSION` pin at 130; existing harness names                                                                     |
| Restraint    | findings | Dedicated `provider_imports`, native fork, consent-off default, and additive bridge methods were treated as justified. Staging table, import-only finalize/rename, silent startup auto-resume, and runtime verify-and-reclassify fail the complexity burden of proof. | `provider_import_messages` + mid-history stages; D9 / `session/import/finalize`; startup auto-resume paragraph; step 6 Verify                                                                                     |

## Delta Review Triggers

- If amendment 12 (or discover-plan) deletes `provider_import_messages` and `staging_history`/`ready_to_commit`, rerun Code quality (abort transitions) and Testing (restart/staging sketches, AC #6). Those stages disappear; abort-from-staging and kill-after-staging proofs must be rewritten against the remaining pre-published stages.
- If discover-plan changes first-send resume to a dedicated identity-event lookup instead of last-non-null `provider_thread_id`, rerun Code quality (event identity) and Testing (first-send proof).
- If discover-plan keeps preview-from-owned-fork, rerun Code quality (cancel/mutation) and Restraint (prepare-on-toggle is a new mutation owner).
- If discover-plan keeps post-publish rename or invents a new title owner, rerun Restraint.
- If discover-plan changes claim lifetime (claim survives delete, or archive releases), rerun Architecture and Testing (AC #10).
- If discover-plan cannot run the real Claude SDK in CI, rerun Testing (source-safety no-ship becomes a process/CI finding, not a mocked substitute).

## Refuted by pre-verification

These were removed before synthesis. They are not in the totals or amendments.

- [Code quality] Public API “Do not call ordinary `createThread()`”; Publication transaction; Milestone 3: the plan bans HTTP/service `createThread()` but (allegedly) not `packages/db` `createThread()` / `createThreadRecord()`.
  Counterexample: D5 already says “Do not call ordinary `createThread()`. A dedicated DB command creates the idle thread, a factual provider identity event, durable provenance, the bounded historical marker/messages if consented, matching FTS segments, and terminal operation state in one immediate SQLite transaction. Notifications and plugin `thread.created` fire only after commit.” Publication step 1 requires “an idle visible thread row with no `sourceThreadId` and no `originKind`.” Milestone 3: no half-published thread is queryable. The only function named `createThread()` is `packages/db` `createThread()` (default status `starting`, own immediate transaction, `notifyThread` thread-created after that inner tx). HTTP is `createThreadFromRequest`; `createThreadRecord` calls `createThread()` then `emitPluginThreadCreated`. Following D5 forbids both helpers.

## Not Covered

- External library/API recency and best-pattern research; use `discover-plan`.
- GoalBuddy board quality; use `codex-goal-compiler` and GoalBuddy checker.
- Post-implementation diff correctness; review the actual diff after implementation.

## Next Step

Revise the plan with the 16 amendments above (especially the two blockers on resume identity / first-send proof and real-SDK source-safety) before `discover-plan`. After revision, run `discover-plan` for Claude Agent SDK session/fork/delete semantics, host-protocol bump practice, and FTS/timeline closed-union patterns; do not compile with `codex-goal-compiler`/GoalBuddy until those amendments are in the plan text.

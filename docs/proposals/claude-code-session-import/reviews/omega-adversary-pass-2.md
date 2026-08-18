# Adversarial Plan Review — Merged Findings

- **Run tag:** `omega-plan:20260818T044715Z-418101b1`
- **Call ID:** `omega_plan__adversary-merge__418101b1`
- **Stage:** `adversary`
- **Plan:** [`../exec-plan.md`](../exec-plan.md)
- **Verdict:** **not-ready**
- **Merge result:** 7 pre-verified inputs collapsed to **6** material root causes. The two crashDaemon / file-backed restart findings (assumptions high + criteria-gaming blocker) share one root cause: the named restart proof uses a helper that never kills the server process or its `:memory:` DB, and the done-condition can stay green without a pre-publication fresh-process GET. No other pair shares a root cause closely enough to merge without losing an independent failure mode.

## Severity totals

| Severity  | Count |
| --------- | ----: |
| Blocker   |     1 |
| High      |     4 |
| Medium    |     1 |
| Low       |     0 |
| **Total** | **6** |

Pre-refuted findings are excluded from these totals, the amendment list, and the verdict.

## Surviving findings

### 1. The named file-backed restart proof never kills the server, and the done-condition does not require a surviving pre-publication stage

- **Severity:** blocker
- **Lane:** criteria-gaming; assumptions
- **Plan location:** Milestone 3 proof; DB/server integration sketch 5; No-ship row “Duplicate fork” / “in-memory-only restart proof”; Operation State Machine startup/reconnect paragraph; Surprises (ordinary create is process-local); `tests/integration/helpers/harness.ts` `crashDaemon()`
- **Issue:** The plan names the existing `@bb/integration-tests` `crashDaemon` harness as the file-backed way to kill/recreate the server after `reserved`, `preparing`, and `provider_prepared`. That harness does neither. `IntegrationHarness.crashDaemon()` only tears down the host daemon (connection, localApi, runtimeManager, eventSink, lock). Recreate is a separate `startDaemon()`. There is no `crashServer` / `restartServer`. The same helper starts the server with `initDb(":memory:")`, so the operation row lives only in the server process. `idle-crash-restart.test.ts` already uses this exact pattern: crash daemon, wait for host disconnect, `startDaemon()`, continue — the server process and in-memory DB never die. Sketch 5 then only requires a later GET to expose some durable phase and explicit resume to converge to one UUID; it does not require the phase to still be `reserved` / `preparing` / `provider_prepared`, or fork count to stay zero until resume.
- **Why it matters:** The dedicated saga exists because ordinary `createThread()` recovery is process-local server cleanup (`forgetActiveThreadProvisionContext` plus `deleteThread` on provision failure). A lost HTTP response after `forkSession` and before `provider_prepared` is a server-process death problem. A worker who follows the named harness will write a daemon-crash test against a still-alive `:memory:` server: GET stays green, resume never proves file-backed CAS, and a second fork after real server death stays untested. The pass-1 amendment that deleted the “or” and named `crashDaemon` did not check what that function or that DB actually are. Two cheapest passes both satisfy the current sketch: (a) persist the row (or keep it in the still-living server), call `harness.crashDaemon()`, GET/resume against the never-restarted server; (b) restart the server and auto-resume every nonterminal import on boot so GET already shows `published`. Neither proves file-backed saga recovery or that begin/resume is the sole mutation owner.
- **Amendment:** Stop calling `crashDaemon` the server-restart proof. Require a helper that stops and recreates the server process against the same file-backed SQLite after `reserved`, `preparing`, and `provider_prepared`. Either (a) add an import-specific file-backed server harness — `initDb(tempFile)`, `crashServer` / `restartServer` that close and recreate the HTTP app against the same file — or (b) name a real process-kill surface such as `tests/qa` and require a file-backed server data dir. Fresh-process GET must still show that same pre-publication stage, fork count 0, and no thread. Only explicit resume may reconcile or publish. `crashDaemon` + `startDaemon()` may stay as a host-offline / lost-RPC case only; they cannot substitute for server restart. Keep the in-memory-only-restart no-ship. In-memory server tests cannot substitute for the kill-point.

### 2. Abort and prepare-compensation delete an owned fork that is already an externally writable Claude session

- **Severity:** high
- **Lane:** blast-radius
- **Plan location:** D9; Operation State Machine steps 2 and 5 (`source_changed` compensation `deleteSession`, and abort `deleteSession`); App Experience inspector disclosure; Test sketches DB/server #9 and Provider #8
- **Issue:** Abort and prepare-compensation treat `deleteSession` as safe, reversible saga cleanup after the owned fork is already an externally writable Claude session.
- **Why it matters:** Prepare calls `forkSession` immediately and leaves a normal marker-titled session in the user's Claude store. The plan already admits that session is visible and mutable from Claude Code, and it revision-checks the owned tuple only to refuse publication. Abort from every pre-published stage, and the `source_changed` path, still delete the uniquely verified owned UUID once the marker matches. A user who opens the newest Claude session and types, or whose Claude Code process touches `lastModified` / `fileSize`, is exactly the `owned_changed` case: commit will not publish, then Cancel / Abort / “Removing copy” deletes that work. Catalog listing strips BB marker sessions, so the destroyed fork cannot later be discovered or imported as a source. The existing abort proofs only cover independently removed forks and wrong-marker refusal, not an independently mutated fork. `deleteSession` is irreversible; the plan describes it as repeat-safe compensation.
- **Amendment:** Before any `deleteSession` of an owned fork (abort, retry cleanup, or `source_changed` compensation), re-read the owned revision tuple with the same `getSessionInfo(ownedId, { dir: sourceCwd })` used at prepare. If the tuple differs from the persisted prepare snapshot, the marker title is gone, or the session has newer user/assistant content, do not delete. CAS the operation to `needs_attention` with a typed `owned_externally_written` / `owned_changed` cause, keep or explicitly disclose the claim, and tell the user BB will not delete the modified Claude copy. Proven unchanged marker+revision remains the only delete authorization. Add a real-SDK test: mutate the owned fixture after prepare, call abort, assert source and owned hashes are unchanged and the public operation is `needs_attention` rather than `aborted`.

### 3. In-flight imports, unique claims, and provenance tombstones are outside the project/environment deletion graph

- **Severity:** high
- **Lane:** blast-radius
- **Plan location:** Data Model `provider_imports` (only `thread_id` is exempted from a cascading FK); Operation State Machine step 6 (claim release only via `markThreadDeleted` on published threads); Milestone 3 archive/delete/project-delete proofs
- **Issue:** In-flight import rows, unique canonical claims, and provenance tombstones are not in the project/environment deletion graph, and the schema instructions will either CASCADE-wipe them or block `deleteProject`.
- **Why it matters:** A `reserved` / `preparing` / `provider_prepared` operation holds the global `(host, provider, source)` canonical claim and may already own a Claude fork, but it has no `thread_id`. `beginProjectDeletion` / `advanceProjectDeletion` only walk threads through `markThreadDeleted`; `wouldCleanupEnvironment` / `countLiveThreadsInEnvironment` only count live threads, so a managed target worktree can retire and destroy while the saga is still prepared; `pruneDestroyedEnvironments` then hard-deletes the environment row after 7 days. Recovery UI lists nonterminal operations by selected project/host, so a deleted project hides the only abort surface while the claim still blocks default re-import into every project. House-style Drizzle FKs are `projectId` / `hostId` `ON DELETE CASCADE` and environment rows are physically deleted (`packages/db/src/schema.ts` `environments.projectId`, `threads.projectId`; `packages/db/src/data/sweeps.ts` `pruneDestroyedEnvironments`; `packages/db/src/data/projects.ts` `deleteProject`). The plan pins a non-cascading dangling `thread_id` and is silent on `target_project_id` / `target_environment_id` / `host_id`. Copying local conventions therefore either (a) CASCADE-deletes in-flight rows without abort, orphaning marker-titled forks and wiping published provenance tombstones at `deleteProject`, or (b) uses `RESTRICT` / `NO ACTION` and makes `deleteProject` throw after threads and environments are already gone. Public DELETE also applies `markThreadDeleted` and `finalizeStoppedThread` in two separate immediate transactions today (`apps/server/src/routes/threads/base.ts`), so a claim CAS that is merely “before `deleteThread`” can still crash-split `deletedAt` from reclaim and leave a unique claim with no live thread.
- **Amendment:** Pin import FKs the same way as `thread_id`: `target_project_id`, `target_environment_id`, and `host_id` are logical identifiers with no `ON DELETE CASCADE` (`SET NULL` or no FK). `beginProjectDeletion`, environment destroy/prune, and host destroy must enumerate nonterminal imports targeting that entity and, in the same immediate transaction as the lifecycle write, either run the existing abort/abandon claim release or CAS them to `abandoned` and clear `canonical_source_claim`. `wouldCleanupEnvironment` must treat a nonterminal import targeting that environment as a live pin, or destroy must abandon those imports first. `markThreadDeleted`'s `deletedAt` write and the reclaim CAS must be one immediate SQLite transaction, not two statements around `finalizeStoppedThread`. Tests: `provider_prepared` import then delete the target project — no FK failure, claim released or row abandoned, later default re-import succeeds, owned fork is aborted or explicitly disclosed as orphan; published tombstone remains readable by operation id after thread delete and after environment prune; crash/failure injection cannot observe `deletedAt` set with claim still unique.

### 4. Ready/mapping and first-send identity are not the same oracle, and D8 still allows a disposable-probe escape hatch

- **Severity:** high
- **Lane:** criteria-gaming
- **Plan location:** D8 including the disposable-probe escape hatch; Validation and Acceptance item 3; Operation State Machine commit step 4; first-send sketch 10 and acceptance item 9; Surprises on CLI 2.1.197 exact-cwd lookup
- **Issue:** Exact cwd/worktree mapping and first-send identity are not the same oracle. Ready/mapping classification has no path-equality rule in tests. Commit only revalidates ready/same host. First-send proof checks `resumeContext.providerThreadId === owned` and forbids `thread.start`, not resume path. Ordinary first send resumes `resumeContext.workspaceContext.path` from the thread environment (`thread-commands.ts`), not from import `source_cwd`. D8 lets a disposable probe relax exact-path matching before implementation.
- **Why it matters:** CLI 2.1.197 predates cross-directory session lookup, which is why D8 exists. Cheapest pass: treat any ready environment on the selected host as Ready, auto-pick the first one, and cite a probe that `listSessions` returned something without `{ dir: exactPath }`. Test 10 and acceptance 3/9 still pass. First send then resumes the owned UUID from a cwd the bundled CLI cannot locate, so native continuation fails while the no-ship first-send identity proof is green.
- **Amendment:** Ready iff a ready environment on that host has canonical path equal to the source lookup scope. Sibling, relocated, symlink-only, and same-worktree-different-path rows are Mapping needed. Remove the in-plan disposable-probe escape hatch, or write any probe result into the plan before code. First-send tests must assert `resumeContext.workspaceContext.path` equals the snapshotted source/target cwd. Commit must refuse if that path drifted.

### 5. “Create another copy” can go green without a second Claude fork

- **Severity:** high
- **Lane:** criteria-gaming
- **Plan location:** D10; DB/server integration sketch 3; no-ship “a retry path that can fork twice”
- **Issue:** D10 says Create another copy creates a second Claude fork, a new operation id, and no canonical claim. Sketch 3 says “observe a second operation but no duplicate owned UUID”, which is satisfied by a second row that shares the first owned UUID or never prepares/forks.
- **Why it matters:** The product escape hatch can lie while the named test goes green. Cheapest pass: insert operation 2 with `canonical_source_claim` null and `owned_provider_thread_id` null or copied from operation 1, skip the unique index while owned is null, never call `forkSession` a second time, and label the button. The retry-double-fork no-ship does not catch this because it is a different operation.
- **Amendment:** New-copy must observe a second `forkSession` (or a second distinct owned UUID), a second operation id, null canonical claim, unique-index success, and UI/CLI copy that it creates another Claude session. Sharing an owned UUID or skipping prepare fails the test.

### 6. The required Continue command has no palette done-condition

- **Severity:** medium
- **Lane:** criteria-gaming
- **Plan location:** Purpose; App Experience entry; Milestone 5; React DOM+events sketch 1; acceptance items 1-12; `packages/domain/src/app-keybindings.ts` `APP_COMMAND_IDS`
- **Issue:** The product requires Continue Claude Code beside New thread and in the command palette. This repo's palette is the closed `APP_COMMAND_IDS` / `APP_COMMAND_GROUPS` set (`thread.new` already lives there). Milestone 5 says “entry/command”, but the RTL list and acceptance items only cover `ProjectListActionButtons`. Browser QA starts from “entry”, which the sidebar button satisfies.
- **Why it matters:** A required user-facing entry has no done-condition. Cheapest pass: sidebar button plus RTL sketch 1. No `AppCommandId`, no `APP_COMMAND_GROUPS` row, no handler, no shortcut. Palette, search, and keyboard users never see the feature while Purpose and design D02 still claim they do.
- **Amendment:** Add a Continue command to `APP_COMMAND_IDS` and `APP_COMMAND_GROUPS`, a handler that opens the same route as the sidebar action, and an RTL case that invoking the command does so. Put that surface in acceptance, not only in prose.

## Deduped amendment list

1. Stop calling `crashDaemon` the server-restart proof. Require a helper that stops and recreates the server process against the same file-backed SQLite after `reserved`, `preparing`, and `provider_prepared` (`crashServer` / `restartServer` on `initDb(tempFile)`, or a named `tests/qa` process-kill surface with a file-backed server data dir). Fresh-process GET must still show that same pre-publication stage, fork count 0, and no thread; only explicit resume may reconcile or publish. `crashDaemon` + `startDaemon()` may extra-prove host-offline / lost-RPC only. Keep the in-memory-only-restart no-ship.
2. Before any `deleteSession` of an owned fork (abort, retry cleanup, or `source_changed` compensation), re-read the owned revision tuple with the same `getSessionInfo(ownedId, { dir: sourceCwd })` used at prepare. If the tuple differs, the marker title is gone, or the session has newer user/assistant content, do not delete: CAS to `needs_attention` with typed `owned_externally_written` / `owned_changed`, keep or disclose the claim, and tell the user BB will not delete the modified Claude copy. Proven unchanged marker+revision is the only delete authorization. Add a real-SDK test that mutates the owned fixture after prepare, calls abort, and asserts hashes unchanged plus public `needs_attention`.
3. Pin `target_project_id`, `target_environment_id`, and `host_id` as logical identifiers with no `ON DELETE CASCADE` (`SET NULL` or no FK), matching `thread_id`. Project/environment/host destroy must enumerate nonterminal imports in the same immediate transaction as the lifecycle write and abort/abandon them (clear `canonical_source_claim`). `wouldCleanupEnvironment` must treat a targeting nonterminal import as a live pin, or destroy must abandon those imports first. `markThreadDeleted`'s `deletedAt` write and the reclaim CAS must be one immediate SQLite transaction. Prove: `provider_prepared` then delete target project (no FK failure, claim released or row abandoned, later default re-import succeeds, owned fork aborted or disclosed as orphan); published tombstone readable by operation id after thread delete and environment prune; crash injection cannot observe `deletedAt` set with claim still unique.
4. Ready iff a ready environment on that host has canonical path equal to the source lookup scope; sibling, relocated, symlink-only, and same-worktree-different-path rows are Mapping needed. Remove the in-plan disposable-probe escape hatch, or write any probe result into the plan before code. First-send tests must assert `resumeContext.workspaceContext.path` equals the snapshotted source/target cwd. Commit must refuse if that path drifted.
5. New-copy must observe a second `forkSession` (or a second distinct owned UUID), a second operation id, null canonical claim, unique-index success, and UI/CLI copy that it creates another Claude session. Sharing an owned UUID or skipping prepare fails the test.
6. Add a Continue command to `APP_COMMAND_IDS` and `APP_COMMAND_GROUPS`, a handler that opens the same route as the sidebar action, and an RTL case that invoking the command does so. Put that surface in acceptance, not only in prose.

## Merge notes

| Input                                                                                 | Disposition                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| assumptions — `crashDaemon` is not a server restart; `:memory:` DB never dies         | **Merged** into finding 1                                                                                                                                          |
| criteria-gaming — sketch 5 can stay green without a pre-publication fresh-process GET | **Merged** into finding 1 (same root cause; blocker severity kept; combined amendment requires both a real server-kill helper and a surviving pre-publication GET) |
| blast-radius — abort/`deleteSession` of an externally mutated owned fork              | Kept as finding 2                                                                                                                                                  |
| blast-radius — import FKs / claims / tombstones outside the deletion graph            | Kept as finding 3                                                                                                                                                  |
| criteria-gaming — Ready/mapping vs first-send path oracle; D8 probe hatch             | Kept as finding 4                                                                                                                                                  |
| criteria-gaming — Create another copy can skip the second fork                        | Kept as finding 5                                                                                                                                                  |
| criteria-gaming — Continue command missing from `APP_COMMAND_IDS`                     | Kept as finding 6                                                                                                                                                  |

Finding 2 was not merged with prior-run “owned fork is a visible shared file” publication-CAS material: that root cause is refuse-to-publish; this one is refuse-to-delete after independent mutation. Sharing an owned-revision tuple does not make them one failure mode.

Nothing was dropped as immaterial.

## Refuted by pre-verification

None. The pre-refuted list was empty; no counterexamples were supplied. This section is excluded from severity totals, amendments, and the verdict.

## Verdict

**not-ready** — one blocker, four high-severity findings, and one medium-severity finding survive the root-cause merge. Under the requested rule, any surviving blocker or high requires `not-ready`.

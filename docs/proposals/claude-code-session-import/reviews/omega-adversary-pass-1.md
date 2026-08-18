# Adversarial Plan Review — Merged Findings

- **Run tag:** `omega-plan:20260818T042503Z-453db13a`
- **Call ID:** `omega_plan__adversary-merge__453db13a`
- **Stage:** `adversary`
- **Plan:** [`../exec-plan.md`](../exec-plan.md)
- **Verdict:** **not-ready**
- **Merge result:** 11 pre-verified inputs collapsed to **10** material root causes. The two delete-lifecycle findings (assumptions D10/test 11 + blast-radius claim/tombstone writers) share one root cause: the plan specifies archive/soft-delete/hard-delete/sweep stages the repo does not expose for idle imported threads. No other pair shares a root cause closely enough to merge without losing an independent failure mode.

## Severity totals

| Severity  |  Count |
| --------- | -----: |
| Blocker   |      1 |
| High      |      9 |
| Medium    |      0 |
| Low       |      0 |
| **Total** | **10** |

Pre-refuted findings are excluded from these totals, the amendment list, and the verdict.

## Surviving findings

### 1. Source-safety is a named no-ship, but the required gate can stay green without it

- **Severity:** blocker
- **Lane:** criteria-gaming
- **Plan location:** Milestone 2 proof; No-ship test-value row "Source mutation"; Acceptance item 4; Validation Turbo test `--filter=bb-plugin-provider-claude-code`
- **Issue:** Source-safety is the named no-ship proof, but acceptance treats an "explicit no-ship result" as a passing item, and the required Turbo script only runs `plugins/provider-claude-code/vitest.config.ts` (`src/**/*.test.ts`). Forbidding mocks of `listSessions` / `forkSession` / `getSessionInfo` / `deleteSession` does not pin the bundled CLI spawn, real session JSONL, or sidecar hashes.
- **Why it matters:** Cheapest pass: wrap the test in `describe.skipIf` so default Turbo is green, or call the four unmocked functions through a stub executable / empty dirs, then write "explicit no-ship: CI cannot run real Claude CLI" in the Milestone 7 ledger. Production prepare/abort still ships; a source-mutating bug would not fail a required gate.
- **Amendment:** Require the source-safety test in the default plugin vitest config the listed Turbo command runs. Assert the spawned binary is the SDK-pinned bundled CLI, not `pathToClaudeCodeExecutable` or a stub. Fixtures must be disposable Claude session files 0.3.197 `listSessions` can read. Hash source JSONL and every subagent/file-history sidecar. "Explicit no-ship" leaves Milestones 2 and 7 incomplete and forbids checking Progress/branch-ready; it is not a passing acceptance item.

### 2. Idle import delete is a same-request hard delete, so claim/tombstone hooks hang off stages that never exist

- **Severity:** high
- **Lane:** assumptions; blast-radius
- **Plan location:** D10 / Operation State Machine §§5–6 / test 11; Milestone 3 proof rows 9 and 11
- **Issue:** Claim release, tombstone updates, and test 11 are specified against a three-stage archive / soft-delete / hard-delete-sweep model the repo does not expose for idle imported threads, and against writers the plan never names. Public thread DELETE is not a durable soft-delete: the route `markThreadDeleted` then immediately `finalizeStoppedThread`; when `deletedAt` is set, `finalizeStoppedThreadInTransaction` calls `deleteThread` and removes the row. V1 publish is idle, so there is no stop to wait for and the thread row is gone before the HTTP handler returns. There is no later thread hard-delete sweep in `packages/db/src/data/sweeps.ts`. Project deletion in `apps/server/src/services/projects/project-deletion.ts` calls `markThreadDeleted` itself, then later `finalizeStoppedThread`. Events and FTS cascade-delete with the thread row. Release-the-claim is also unspecified at column level.
- **Why it matters:** Claim/tombstone tests that expect a live row with `deletedAt` after public delete will fail. Open-existing and default re-import after delete must treat the thread as missing, not soft-deleted. Hooking claim release on a lasting `deletedAt` state never runs for the idle imported thread this feature creates. If release is hung off the HTTP delete route, project deletion leaves a live `canonical_source_claim` pointing at a missing thread: default re-import is blocked and Open existing cannot open anything. If it is hung off a separate hard-delete stage, idle delete double-fires or the hook runs after the thread row is gone. Leaving `canonical_source_claim` populated on an aborted/reclaimed row still occupies the unique index and permanently blocks a later default import.
- **Amendment:** Rewrite D10 and test 11 against the real delete path: public DELETE of an idle published import is `markThreadDeleted` plus synchronous `finalizeStoppedThread` hard delete. Pin claim lifetime to one DB-module write used by every caller of `markThreadDeleted` (thread DELETE, `beginProjectDeletion`, `advanceProjectDeletion`). In that same transaction, before `finalizeStoppedThread` / `deleteThread`, CAS the import row: NULL `canonical_source_claim`, set `reclaimed` (post-publish) or `aborted` (pre-publish). Treat `thread_id` as a dangling logical id with no live row. Treat `deleteThread` as ordinary cascade / tombstone-preserving row removal, not a second import policy event. Drop the separate hard-delete/sweep stage for threads; keep Claude sessions because thread/discard only closes a live session. Name archive writers (`archiveThreadWithLifecycleEffects` and the environment/child cascades) as the retain-claim path — archive remains a live archived row and can still retain the claim and unarchive. Prove abort, public DELETE, and project deletion each then allow default re-import to insert a new claim.

### 3. The named `list_models` seam is not the production prepare/abort clone

- **Severity:** high
- **Lane:** assumptions
- **Plan location:** D15 / Provider Bridge and Host Runtime — clone `provider.list_models` through `resolveRuntimeBridgeLaunch` and `ensureProviderMaintenanceRuntime`
- **Issue:** The named `list_models` seam is not one function. Dispatch only calls `resolveRuntimeBridgeLaunch` then `options.listModels ?? defaultListModels`. `defaultListModels` creates a separate `AgentRuntime` per bridge key with `workspacePath` `process.cwd()` and never calls `ensureProviderMaintenanceRuntime`. Production `app.ts` injects `listModels` onto the dummy-`dataDir` maintenance runtime. The dispatch handler that already does both calls in one place is `thread.unarchive`, not `provider.list_models`.
- **Why it matters:** A worker that copies the dispatch-visible `list_models` handler gets `defaultListModels` in tests and any path without the app override: no singleton maintenance process, no shared serialization, workspace equals daemon cwd. Prepare/abort cloned that way can mutate the wrong Claude project directory. The plan points implementers at the wrong existing function.
- **Amendment:** Stop calling this the `list_models` seam. Specify the production clone as `thread.unarchive`: `resolveRuntimeBridgeLaunch` plus `runtimeManager.ensureProviderMaintenanceRuntime` in the dispatch handler itself. Always pass explicit source cwd/dir into session APIs; never inherit runtime `workspacePath`. If a `list_models`-style `options.*` override is used, name the `app.ts` injection and forbid `defaultListModels` for mutating prepare/abort. State that the maintenance runtime workspace is a dummy `dataDir` folder, not a user project.

### 4. Lost-response reconciliation reuses the privacy-filtered catalog and can fork twice

- **Severity:** high
- **Lane:** blast-radius
- **Plan location:** D9; Provider Bridge `listSessions` filter of BB-owned marker sessions; Prepare reconciliation
- **Issue:** Lost-response resume is supposed to find the prepared fork by operation title, but the only `listSessions` behavior the plan specifies is the user-facing catalog, which drops marker sessions and uses `includeProgrammatic: false`. The SDK list API has no title filter.
- **Why it matters:** After a timeout, crash, or protocol-bump daemon restart, the row stays `preparing` and the owned UUID was never persisted. Resume can only search by marker. Agent SDK 0.3.197 `listSessions` supports `dir` / `limit` / `offset` / `includeProgrammatic` only. The plan's candidate list explicitly filters BB-owned marker sessions and programmatic/sdk-ts sessions. Reusing that helper makes the just-created fork invisible. The plan then allows a second `forkSession` when zero results are proven, which creates a second irreversible Claude JSONL. Abort can uniquely verify at most one of them. That is the exact duplicate-fork failure the saga exists to prevent.
- **Amendment:** Split the two lists. Reconciliation must page an unfiltered scan (`includeProgrammatic: true`, do not drop marker titles, exhaust offsets), match `customTitle ===` the exact operation marker (not summary/firstPrompt), then `getSessionInfo(ownedId)`. Candidate catalog keeps the privacy filters and must not share that helper. A lost-response test must start from a catalog helper that would have hidden the marker and still return one fork.

### 5. Abort is not repeat-safe, so a missing fork permanently occupies the claim

- **Severity:** high
- **Lane:** blast-radius
- **Plan location:** Operation State Machine §5 Abort; Provider Bridge abort/`deleteSession`; D9 verify deletion
- **Issue:** Abort's rollback story is not idempotent. SDK `deleteSession` without a `sessionStore` throws if the session is not found, and the plan sends every ambiguous delete to `needs_attention` without releasing the claim.
- **Why it matters:** Abort is the only compensation for `preparing` / `provider_prepared` / `source_changed`. Real sequences: first abort already deleted the fork; resume/abort retries; the user deleted the marker-titled session in Claude Code; `getSessionInfo` already returned undefined. The next `deleteSession` throws. The plan treats that as ambiguous and keeps `needs_attention` with the canonical claim held. There is no abandon-without-delete path when the host is gone (host DELETE in `apps/server/src/routes/hosts.ts` does not touch import rows). A pre-publish operation can then block default re-import forever even though the Claude copy is already absent.
- **Amendment:** Make abort repeat-safe. If marker/owned lookup proves absence, treat `deleteSession`-not-found as success, release the claim, and mark `aborted`. Use `needs_attention` only for contradictory presence (still exists after delete, multiple marker hits, owned == source). Add an explicit pre-publish abandon on unreachable/destroyed host that releases the claim and does not assert the fork was deleted. Prove: abort twice; abort after the fork is already gone; abandon while host is offline; then default re-import succeeds.

### 6. The owned fork is a visible shared Claude file, not a frozen BB-private object

- **Severity:** high
- **Lane:** blast-radius
- **Plan location:** D9 source revision check; Operation State Machine §4 Commit; D1/D12 owned exclusivity
- **Issue:** The plan treats the owned fork as a frozen BB-private object from prepare through publish. It is an ordinary Claude session file in the shared store, titled with the operation marker, and only the source is revision-checked — and only around `forkSession`.
- **Why it matters:** `forkSession` writes `{newId}.jsonl` into the same projects dir Claude Code lists. `threadArchive` is already false on the Claude bridge, so nothing hides it. D14 removed post-publish rename, so the marker title is what the user sees. Between `provider_prepared` and `published`, commit pages `getSessionMessages` from that file and treats the result as publication authority, with no owned-revision tuple before/after the page. A concurrent Claude Code open, another BB process, or the user's session picker writing that file can tear the consented history or publish a chain that no longer matches the session the first `turn.submit` will resume. Source `source_changed` does not cover this window.
- **Amendment:** Snapshot an owned revision tuple at prepare persist. Re-read it immediately before history paging and immediately before the publish transaction. If it changes, do not publish: stay `provider_prepared` or `needs_attention` with a named `owned_changed` code. Disclose that the owned copy is visible in Claude Code under the marker title and that deleting it there is unrecoverable. Do not claim exclusivity the store cannot enforce.

### 7. Consent-on publish can persist the source preview instead of the remapped owned page

- **Severity:** high
- **Lane:** criteria-gaming
- **Plan location:** D7; Operation State Machine step 4; Provider Bridge "Project history from the quiescent owned fork"; DB/server tests 7 and 12; React test 5
- **Issue:** Published readable history must be re-read from the remapped owned fork and may differ from the source preview, but no proof requires `session/messages` (or equivalent) to be invoked with the owned UUID at commit, or that published IDs/order/omissions differ from the inspector preview when the fork remaps. Server tests only check ordered imported events; UI tests only check that the preview toggle fetches source text.
- **Why it matters:** Cheapest pass: inspect-with-preview pages the source, stash that array on the operation, and copy it into system/imported-message events at commit. Use one fixture for source and owned in the host fake. Consent-on tests go green while users can get source UUIDs, pre-compaction rows the fork dropped, or a chain the owned session cannot resume.
- **Amendment:** Add a public-route test whose source preview and owned-fork page are intentionally different (IDs, order, omission flags). Commit must persist the owned page only. The host fake must fail if commit pages the source UUID or reuses inspect-preview bytes. Inspector copy is not a substitute for that oracle.

### 8. Kill-point recovery can be "proven" in the same in-memory process

- **Severity:** high
- **Lane:** criteria-gaming
- **Plan location:** Surprises (ordinary create is process-local); Milestone 3 proof; DB/server test 5; Milestone 7 kill-point recovery
- **Issue:** The saga exists because ordinary create cannot survive process death, but the required Milestone 3 proof is in-memory SQLite plus a stateful host fake. File-backed kill/recreate is a second sentence with "File-backed DB or `@bb/integration-tests`". That package already has `tests/integration/fake/recovery/idle-crash-restart.test.ts` for ordinary threads, not import operations. Test 5 never names an import-specific file or `crashDaemon` / `startDaemon` hook.
- **Why it matters:** Cheapest pass: persist `preparing` in `:memory:`, resume in the same process, never kill anything. Milestone 7 ledger: "kill-point recovery owned by `@bb/integration-tests` (existing idle-crash-restart)." The "or" makes that a literal reading. A crash after `forkSession` returns and before `provider_prepared` is written stays unproven — the exact lost-response case D9 exists to handle.
- **Amendment:** Delete the "or". Require one import-specific file-backed or `@bb/integration-tests` case that kills and recreates the server after `reserved`, `preparing`, and `provider_prepared`, then GET + resume converges to one owned UUID and one thread. Name the harness (`crashDaemon` / file-backed DB). In-memory failure injection cannot stand in for that case.

### 9. History bounds are required in prose but no integer or over-limit behavior is pinned

- **Severity:** high
- **Lane:** criteria-gaming
- **Plan location:** Provider Bridge "Apply result-size bounds"; Commit "explicit message/byte limits"; No-ship "unbounded results"; Milestone 3 in-memory bounded history paging; consent-on test 7
- **Issue:** Bounds are required in prose and unbounded results are no-ship, but no max page size, max messages, or max bytes is named, and no test covers over-limit consent-on commit. Existing host-contract APIs pin numbers (`PATHS_EXIST_MAX_PATHS`, `HOST_ARTIFACT_MAX_BYTES`). Consent-on proofs use small ordered fixtures.
- **Why it matters:** Cheapest pass: `MAX_MESSAGES = Number.MAX_SAFE_INTEGER` or `while (page.length) pages.push(...)` with no cap. A limit field exists, so "unbounded results" is officially avoided. Alternatively `MAX_MESSAGES = 10` with a 2-message fixture: consent-on "exact ordered projections" still passes while most of the active chain is silently dropped and unflagged.
- **Amendment:** Pin integers (page size, max messages, max bytes) in the public contract. Over-limit consent-on commit must fail closed (`needs_attention` or a truncated projection plus a persisted omission class). Add a public-route test that exceeds the cap and asserts the chosen behavior. A limit constant alone is not enough.

### 10. Milestone 5/7 let durable recovery exist only if the original tab's URL survived

- **Severity:** high
- **Lane:** criteria-gaming
- **Plan location:** App Experience "Durable operation state is queried on mount", "Needs attention", Mapping-needed setup action; Design D09; React tests 3, 6, 7; Milestone 5 "every public behavior listed below"; Milestone 7 browser-setup stop
- **Issue:** Milestone 5 only binds the numbered React list, which is narrower than App Experience. That list lets Needs attention render at rest as an empty heading, restores an operation only when the client already has the operation ID, and never requires the Mapping-needed setup action, project-scoped list of nonterminal operations, first-send draft preservation, or iOS drawer. Milestone 7 then allows stopping at the first Chrome-setup failure and recording it in the ledger.
- **Why it matters:** Cheapest pass: implement the ten RTL tests. Resume lives in `/continue/:operationId`. Clean visit after restart or from another client shows an empty Needs attention group. Mapping needed is a badge with no setup action. A failed first send drops the draft. iOS Simulator is never opened. The durable saga is then only recoverable if the original tab's URL survived.
- **Amendment:** On surface mount without an operation ID, list project/host nonterminal operations and render Needs attention / Resume from those rows. RTL: a second mount with no operation ID still shows Resume. Mapping-needed rows must expose the existing setup action, preserve list/search/selection, and revalidate; test that path. First-send failure must preserve the composer draft. iOS Simulator drawer evidence is a Milestone 7 done-condition, not a skippable ledger note; Chrome-setup failure cannot complete acceptance 12.

## Deduped amendment list

1. Require the source-safety test in the default plugin vitest config the listed Turbo command runs; assert the spawned binary is the SDK-pinned bundled CLI; use disposable 0.3.197-readable session fixtures and hash source JSONL plus every sidecar. "Explicit no-ship" leaves Milestones 2 and 7 incomplete and is not a passing acceptance item.
2. Rewrite D10 / test 11 against the real idle-delete path (`markThreadDeleted` + synchronous `finalizeStoppedThread` hard delete). Pin claim lifetime to one DB-module write used by every `markThreadDeleted` caller; in that transaction, before `deleteThread`, CAS NULL `canonical_source_claim` and set `reclaimed` or `aborted`. Treat `thread_id` as a dangling id with no live row. Drop the thread hard-delete/sweep stage. Name archive writers as the retain-claim path. Prove abort, public DELETE, and project deletion each then allow default re-import.
3. Stop calling this the `list_models` seam. Clone `thread.unarchive` (`resolveRuntimeBridgeLaunch` + `ensureProviderMaintenanceRuntime` in the dispatch handler). Always pass explicit source cwd/dir into session APIs. If an `options.*` override is used, name the `app.ts` injection and forbid `defaultListModels` for mutating prepare/abort. The maintenance workspace is a dummy `dataDir`, not a user project.
4. Split catalog vs reconciliation lists. Reconciliation pages an unfiltered `includeProgrammatic: true` scan, matches the exact operation marker title, then `getSessionInfo(ownedId)`. Catalog keeps privacy filters and must not share that helper. A lost-response test must start from a catalog helper that would have hidden the marker and still return one fork.
5. Make abort repeat-safe: proven absence / `deleteSession`-not-found is success, release the claim, mark `aborted`. Use `needs_attention` only for contradictory presence. Add pre-publish abandon on unreachable/destroyed host that releases the claim without asserting fork deletion. Prove abort twice, abort after the fork is gone, abandon while host is offline, then default re-import succeeds.
6. Snapshot an owned revision tuple at prepare persist; re-read it immediately before history paging and immediately before the publish transaction; on change stay `provider_prepared` or `needs_attention` with `owned_changed`. Disclose that the owned copy is visible in Claude Code under the marker title and that deleting it there is unrecoverable. Do not claim store exclusivity.
7. Add a public-route test whose source preview and owned-fork page differ in IDs, order, and omission flags. Commit must persist the owned page only. The host fake must fail if commit pages the source UUID or reuses inspect-preview bytes.
8. Delete the kill-point "or". Require one import-specific file-backed or `@bb/integration-tests` case that kills and recreates the server after `reserved`, `preparing`, and `provider_prepared`, then GET + resume converges to one owned UUID and one thread. Name the harness. In-memory failure injection cannot stand in.
9. Pin page-size, max-messages, and max-bytes integers in the public contract. Over-limit consent-on commit must fail closed (`needs_attention` or a truncated projection plus a persisted omission class). Add a public-route test that exceeds the cap and asserts the chosen behavior.
10. On surface mount without an operation ID, list project/host nonterminal operations and render Needs attention / Resume from those rows; RTL a second mount with no operation ID still shows Resume. Mapping-needed rows must expose the existing setup action, preserve list/search/selection, and revalidate. First-send failure must preserve the composer draft. iOS Simulator drawer evidence is a Milestone 7 done-condition; Chrome-setup failure cannot complete acceptance 12.

## Merge notes

| Input                                                                       | Disposition                                                                                                |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| assumptions — `list_models` is not one function                             | Kept as finding 3                                                                                          |
| assumptions — public DELETE is not a durable soft-delete                    | **Merged** into finding 2                                                                                  |
| blast-radius — claim/tombstone specified against a three-stage delete model | **Merged** into finding 2 (same root cause; combined amendment keeps both caller-set and column-level CAS) |
| blast-radius — reconciliation reuses the filtered catalog                   | Kept as finding 4                                                                                          |
| blast-radius — abort/`deleteSession` is not idempotent                      | Kept as finding 5 (claim release here is abort compensation, not the delete-path writer)                   |
| blast-radius — owned fork is not a frozen private object                    | Kept as finding 6                                                                                          |
| criteria-gaming — source-safety no-ship can stay green                      | Kept as finding 1                                                                                          |
| criteria-gaming — publish can copy the source preview                       | Kept as finding 7                                                                                          |
| criteria-gaming — kill-point proof can stay in-process                      | Kept as finding 8                                                                                          |
| criteria-gaming — bounds have no integers or over-limit test                | Kept as finding 9                                                                                          |
| criteria-gaming — Milestone 5/7 narrower than App Experience                | Kept as finding 10                                                                                         |

Nothing was dropped as immaterial.

## Refuted by pre-verification

None. The pre-refuted list was empty; no counterexamples were supplied. This section is excluded from severity totals, amendments, and the verdict.

## Verdict

**not-ready** — one blocker and nine high-severity findings survive the root-cause merge. Under the requested rule, any surviving blocker or high requires `not-ready`.

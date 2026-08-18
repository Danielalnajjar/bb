# Adversary Merge Report

- Run tag: `omega-plan:20260818T050643Z-ce25039e`
- Call ID: `omega_plan__adversary-merge__ce25039e`
- Stage: `adversary`
- Plan: [`../exec-plan.md`](../exec-plan.md)
- Report: this file, copied from the canonical Omega run artifact.
- Verdict: `not-ready`

Nine material findings survived merge. They were deduplicated by root cause (not wording), retain originating lane attribution, and are ordered by severity. No two findings share a root cause. Nothing was dropped as immaterial. No pre-refuted findings were supplied.

## Severity Totals

| Severity | Count |
| -------- | ----: |
| Blocker  |     1 |
| High     |     8 |
| Medium   |     0 |
| Low      |     0 |

By lane (after merge; each finding kept its single originating lane):

| Lane              |     Material findings |
| ----------------- | --------------------: |
| `criteria-gaming` | 4 (1 blocker, 3 high) |
| `assumptions`     |          3 (all high) |
| `blast-radius`    |         2 (both high) |

## Merged Findings

### 1. Acceptance oracles prove an unused UUID, not that the owned session continues the source

- Severity: `blocker`
- Lane: `criteria-gaming`
- Plan location: Purpose; D1; Milestone 2 proof / no-ship row Source mutation; Provider/host sketch 4; DB/server sketch 10; Acceptance items 1, 5, 9
- Issue: The required oracles prove a new unused UUID, not that the owned session continues the source. Source-safety hashes source JSONL/sidecars, asserts `owned ≠ source`, and forbids mocks of `listSessions` / `forkSession` / `getSessionInfo` / `deleteSession` only. It never unmocks `getSessionMessages` or requires owned to contain remapped supported source text. Publication history is an implementer-written host fake. First-send inspects the queued `turn.submit` identity and cwd, not the owned chain. Cheapest green pass: mint an empty marker-titled session (or fork an unrelated/empty id); source hashes unchanged; abort deletes only that file; fake returns canned owned pages and one `turn.submit` with `resumeContext.providerThreadId === owned`.
- Why it matters: V1 is native continuation of useful Claude work. An empty marker session satisfies every named no-ship row while the first BB message resumes a conversation that does not contain the user's source. Implementation prose saying prepare calls `forkSession(sourceId)` is not an acceptance oracle.
- Amendment: In the default plugin real-SDK source-safety test, also forbid mocking `getSessionMessages`. After prepare, call `getSessionMessages` on source and owned with `{ dir: sourceCwd }` and assert the owned chain contains the source's supported user/assistant text (not empty) and remapped ids when the SDK remaps them. An empty marker-titled session, a fork of a different id, or skipped/mocked `getSessionMessages` fails Milestone 2 and is not acceptance evidence. Keep the host-fake publication tests, but they cannot substitute for this lineage proof.

### 2. Host-wide catalog `dir` rule contradicts the SDK and the plan's own catalog snippet

- Severity: `high`
- Lane: `assumptions`
- Plan location: Surprises (CLI 2.1.197 predates cross-directory lookup); Provider Bridge and Host Runtime (every session API call must carry explicit source cwd/dir and must never inherit `runtime.workspacePath`); Claude catalog helper `listSessions({ includeProgrammatic: false, limit, offset })`
- Issue: The plan treats omitting `dir` as inheriting the dummy maintenance workspace because CLI 2.1.197 supposedly has no cross-directory lookup. Installed `@anthropic-ai/claude-agent-sdk@0.3.197` (bundled CLI 2.1.197) does the opposite for the utilities this feature calls: `listSessions` without `dir` uses `pV` over every project under the Claude projects root; `getSessionInfo` / `getSessionMessages` / `forkSession` / `deleteSession` without `dir` search all project directories via `Pn`/`gV`. Dummy workspace is only used if something passes that path as `dir`. D8 exact-path matching is still true for first send, because BB resume builds `workspaceContext` from the live environment path.
- Why it matters: A machine-scoped catalog has no source cwd yet. Following “every call must carry `dir`” on contact, implementers will pass the maintenance workspace (empty/wrong catalog) or one environment path (drop sessions whose project key is not that path). The catalog snippet that omits `dir` is the correct SDK call; the surrounding invariant contradicts both the SDK and that snippet.
- Amendment: Split the `dir` rule. Host-wide candidate catalog: `listSessions({ includeProgrammatic: false, limit, offset })` with `dir` omitted (all projects; this does not inherit `runtime.workspacePath`). Inspect/prepare/messages/abort/delete: pass `dir: sourceCwd`. Keep exact canonical-path equality only as a first-send/resume constraint (`turn.submit` `workspaceContext` comes from the live environment path), not as a session-utility default. Never pass the maintenance workspace path as `dir`.

### 3. Milestone 3 restart proof targets APIs that are not in the tree

- Severity: `high`
- Lane: `assumptions`
- Plan location: Milestone 3 proof; Test Sketches DB/server integration row 5; Decision D17 (file-backed server restart, not `crashDaemon`)
- Issue: The plan names `initDb(tempFile)` plus `crashServer`/`restartServer`, or an equivalent real process-kill surface under `tests/qa`. `initDb(path)` exists. `crashServer` and `restartServer` do not exist anywhere in the repo. `withTestHarness`/`createTestAppHarness` always call `initDb(":memory:")`. The integration harness’s `crashDaemon`/`startDaemon`/`restartDaemon` exist but that harness is also `:memory:`. `tests/qa` only starts/stops/restarts the standalone daemon; it has no HTTP-server plus file-backed SQLite kill surface.
- Why it matters: An implementer searching for `crashServer`/`restartServer` will find nothing. Reusing `withTestHarness` or `crashDaemon` cannot prove file-backed server-process restart: both DBs are in-memory, and `crashDaemon` only kills the daemon. The “or equivalent” hedge does not name an existing owner, so Milestone 3’s no-ship restart proof is aimed at APIs that are not in the tree.
- Amendment: State that the file-backed server-saga harness is new work, not an existing API. Specify what it must close and reopen against one SQLite file (Hono/HTTP server, DB connection/owner, notification hub), that it lives in `apps/server` test helpers or a named `tests/qa` surface (not `crashDaemon`), that `withTestHarness`/`:memory:` cannot substitute, and that `crashDaemon`/`startDaemon` remain host-offline/lost-RPC only.

### 4. The bb-cli skill is hand-written, not generated

- Severity: `high`
- Lane: `assumptions`
- Plan location: Public API, SDK, and CLI (`update packages/templates/src/templates/bb-guide-threads.md`, the generated built-in bb-cli skill, and `docs/cli-guide-and-skill.md`); Milestone 4
- Issue: The bb-cli skill is not generated. `docs/cli-guide-and-skill.md` is the process doc: edit `bb-guide-*.md` then run `generate-templates.mjs` for in-CLI guide bodies, and separately hand-edit `apps/server/src/services/skills/builtin-skills/bb-cli/SKILL.md`. That `SKILL.md` is a long hand-written command catalog. `generate-templates.mjs` does not write it. `docs/cli-guide-and-skill.md` is not a user-facing command reference to fill in.
- Why it matters: Following the plan as written, implementers update the guide template (and maybe the process doc) and assume the skill is produced. Agents using bb-cli will not see `bb thread continue claude-code …`. The required agent surface is a direct, non-generated `SKILL.md` edit.
- Amendment: Name the two real discoverable surfaces: (1) `packages/templates/src/templates/bb-guide-threads.md` plus `generate-templates.mjs`; (2) hand-edit `apps/server/src/services/skills/builtin-skills/bb-cli/SKILL.md` in the same change. Do not call the skill generated. Do not treat `docs/cli-guide-and-skill.md` as a command-reference target unless the sync process itself changes.

### 5. Refused delete leaves the unique source claim locked with no online release

- Severity: `high`
- Lane: `blast-radius`
- Plan location: D10; Operation State Machine §§5–6 (abort/abandon); App Experience recovery; Provider Bridge catalog vs reconciliation; Test sketches DB/server #9
- Issue: After pass 2, abort/compensation may not call `deleteSession` when the owned marker or revision tuple changed. That path CASes to `needs_attention` and retains the unique `canonical_source_claim`. The only claim-release that does not delete is Abandon, and it is specified only for an unreachable or destroyed host. The user-facing catalog still strips BB marker sessions (by exact title and/or every stored `owned_provider_thread_id`), including rows in `needs_attention`, `abandoned`, and `aborted`.
- Why it matters: Realistic sequence: prepare writes a visible marker-titled Claude session; the user or Claude Code types in it or `/rename`s it; commit/abort correctly refuses deletion; default import of the source is then blocked forever while the host is online. Resume cannot publish (`owned_changed`). Abort loops in `needs_attention`. Abandon is hidden because the host is connected. Create another copy still works, but it creates a third Claude session and leaves the claim occupied. The mutated fork is invisible in BB and is not a published thread, so there is no Open-existing recovery. Pass 2's keep-or-explicitly-disclose-the-claim wording is not a release hatch; it is how the unique index becomes a permanent lock on the primary product action.
- Amendment: Add an online, consequence-labeled Release claim / Abandon without delete for every pre-publish state where delete is refused or the user no longer wants the operation, including `needs_attention` plus `owned_changed`/`owned_externally_written` while the host is reachable. It must NULL `canonical_source_claim`, mark `abandoned`, and not call `deleteSession`. After release, a later default import of the original source must succeed. Catalog/reconciliation filters may hide marker sessions only for live still-claimed operations; once the claim is released, that owned UUID must appear as a normal candidate or a named recoverable orphan, not stay stripped because a tombstone still holds the id/title. Prove: mutate owned after prepare, abort stays `needs_attention` and does not delete, online release, default re-import of the source succeeds, and the mutated fork remains hash-identical and listable.

### 6. Lost-response resume treats “no marker title” as “no fork” and may fork again

- Severity: `high`
- Lane: `blast-radius`
- Plan location: D9; Operation State Machine step 3; Provider Bridge prepare reconciliation (If zero results are proven after a completed failure, retry may fork); Surprises (`forkSession` has no atomicity guarantee)
- Issue: Lost-response resume is allowed to call `forkSession` again when an unfiltered marker scan returns zero `customTitle === exactOperationMarker` hits. That is not a presence check. Agent SDK 0.3.197 `forkSession` copies a new `{sessionId}.jsonl` and takes title as an option; if omitted it derives original + `" (fork)"`. `getSessionInfo`/`listSessions` can omit a file that exists but has no extractable summary. The plan already admits there is no atomicity guarantee, then still equates no marker title with no fork.
- Why it matters: The saga exists so a timeout, crash, or protocol-bump daemon restart cannot create a second Claude session. A `forkSession` that dies after creating the file and before the title is durable — or a partial JSONL that `listSessions` skips — produces zero marker hits. Resume then forks again. Abort can uniquely verify at most one of them; the marker-less orphan stays in the user's Claude project dir, is not in `owned_provider_thread_id`, and is invisible to marker reconcile. Pass 1 only stopped reusing the privacy-filtered catalog. It did not change the zero-implies-fork rule. Source-safety hashes a successful fork; it never injects a marker-less new file after a lost prepare.
- Amendment: Ban a second `forkSession` unless the provider can prove no new session file appeared in the source lookup-scope project dir for this operation window. Before the first fork, snapshot that directory's session ids/mtimes (plugin-side; still no core JSONL reads). After a lost or failed prepare, if any new non-claimed session file exists — marker or not — CAS to `needs_attention` (ambiguous fork) and do not fork. Retry may fork only when that snapshot is unchanged and the unfiltered marker scan is empty. An incomplete or timed-out `listSessions` page is contradictory, not zero. Prove with a real-SDK or fixture case: after prepare starts, inject a new marker-less `{uuid}.jsonl` in the source project dir, lose the response, resume; fork count stays 1 and public state is `needs_attention`, not a second UUID.

### 7. Inspect-with-preview can fork; written proofs never forbid it

- Severity: `high`
- Lane: `criteria-gaming`
- Plan location: D7; Inspector and consent; React DOM+events 5; DB/server 12; Provider/host 3
- Issue: D7 says history-on inspect fetches a bounded source preview, creates no fork, and stays ephemeral. Written proofs only check that preview text appears, that inspect without the preview flag returns no text, and that a stale revision is rejected before prepare. Pass 1 already blocks commit from persisting inspector-preview bytes. Nothing requires inspect-with-preview to avoid `forkSession`/`prepare`/`deleteSession` or to leave source+sidecar hashes and session count unchanged. Cheapest green pass: inspect-with-preview calls `forkSession` so the preview can show remapped ids, leaves the fork on disk, and still pages a later owned UUID at commit.
- Why it matters: History-on browsing is the high-frequency path. Forking to preview leaves catalog-hidden marker orphans for sessions the user never committed, while selected-source hashes and the publish-from-preview-bytes oracle stay green.
- Amendment: Add a public inspect-with-preview proof: zero `forkSession`, `prepare`, or `deleteSession` calls; source JSONL and every sidecar hash unchanged; session count in the disposable store unchanged; no preview bytes persisted on the operation row. Stale-revision inspect remains a preflight before prepare and is not this oracle.

### 8. `includeReadableHistory` omit path is unpinned and can default true

- Severity: `high`
- Lane: `criteria-gaming`
- Plan location: D6; Public API begin/resume history choice; CLI test 4; DB/server 6 and 12; React 5–6; no-ship hidden history indexing
- Issue: D6 says `includeReadableHistory` defaults false and the stored operation row is the sole consent authority. Every sketched HTTP/SDK/React test sends an explicit `true` or `false`. CLI only proves the flag is the CLI's true path. The contract does not pin required versus `optional().default(false)`. Cheapest green pass: `includeReadableHistory: z.boolean().optional().default(true)` or treat missing as true. App/CLI stay explicit; omit on HTTP/SDK publishes imported events and `imported_message` FTS.
- Why it matters: Hidden history indexing is a named no-ship. Resume-cannot-broaden-a-stored-false does not help if the first persist already stored true. Curl, an older SDK client, or a forgotten field would index the chain while every written consent test stays green.
- Amendment: Pin the public start/resume field as either required boolean or optional default false. Add a public-route test that omits the field: persist `include_readable_history=false`, create no imported-message events or FTS, and expose no preview/canary text. A 400 on omit is acceptable only if every shipped client sends an explicit boolean and that omit case is tested.

### 9. Mapping-needed recovery proofs never require the source to become Ready

- Severity: `high`
- Lane: `criteria-gaming`
- Plan location: D8; App Experience mapping; Pure/domain 3; React DOM+events 11; Acceptance item 3
- Issue: Pass 2 pinned Ready to exact canonical-path equality and first-send cwd. V1 recovery for Mapping needed is a contextual existing setup action plus revalidate. React test 11 only requires invoking that action, preserving list/search/selection, and that revalidate is called. Domain sketch 3 classifies a static fixture. No proof requires that after a ready environment with that exact canonical path exists, the same source becomes Ready and commit is allowed. Cheapest green pass: settings link plus a `revalidate()` spy; classifier still returns Mapping needed.
- Why it matters: D8 forbids creating a worktree inside the saga, so attaching the matching environment is the only user fix. A badge and a navigation click can satisfy every written test while the candidate can never leave Mapping needed.
- Amendment: Add a public/RTL recovery case: start with Mapping needed and no matching ready environment; after a ready environment whose canonical path equals the source lookup-scope cwd exists, the same source is Ready and commit is allowed; a sibling/relocated/symlink-only path stays Mapping needed. Invoking setup and calling revalidate is not sufficient.

## Deduped Amendment List

1. **Lineage oracle (blocker).** In the default plugin real-SDK source-safety test, also forbid mocking `getSessionMessages`. After prepare, call `getSessionMessages` on source and owned with `{ dir: sourceCwd }` and assert the owned chain contains the source's supported user/assistant text (not empty) and remapped ids when the SDK remaps them. An empty marker-titled session, a fork of a different id, or skipped/mocked `getSessionMessages` fails Milestone 2 and is not acceptance evidence. Host-fake publication tests cannot substitute.
2. **Split the session `dir` rule.** Host-wide candidate catalog: `listSessions({ includeProgrammatic: false, limit, offset })` with `dir` omitted (all projects; does not inherit `runtime.workspacePath`). Inspect/prepare/messages/abort/delete: pass `dir: sourceCwd`. Keep exact canonical-path equality only as a first-send/resume constraint. Never pass the maintenance workspace path as `dir`.
3. **File-backed server-saga harness is new work.** Specify what it must close and reopen against one SQLite file (Hono/HTTP server, DB connection/owner, notification hub), that it lives in `apps/server` test helpers or a named `tests/qa` surface (not `crashDaemon`), that `withTestHarness`/`:memory:` cannot substitute, and that `crashDaemon`/`startDaemon` remain host-offline/lost-RPC only.
4. **Name the two real CLI surfaces.** (1) `packages/templates/src/templates/bb-guide-threads.md` plus `generate-templates.mjs`; (2) hand-edit `apps/server/src/services/skills/builtin-skills/bb-cli/SKILL.md` in the same change. Do not call the skill generated. Do not treat `docs/cli-guide-and-skill.md` as a command-reference target unless the sync process itself changes.
5. **Online Release claim / Abandon without delete.** For every pre-publish state where delete is refused or the user no longer wants the operation (`needs_attention`, `owned_changed`/`owned_externally_written` while the host is reachable): NULL `canonical_source_claim`, mark `abandoned`, do not call `deleteSession`. After release, default re-import of the original source must succeed. Catalog filters may hide marker sessions only for live still-claimed operations. Prove: mutate owned after prepare → abort stays `needs_attention` and does not delete → online release → default re-import succeeds → mutated fork remains hash-identical and listable.
6. **Ban a second `forkSession` without a presence proof.** Before the first fork, snapshot the source lookup-scope project dir's session ids/mtimes (plugin-side; no core JSONL reads). After a lost or failed prepare, if any new non-claimed session file exists — marker or not — CAS to `needs_attention` (ambiguous fork) and do not fork. Retry may fork only when that snapshot is unchanged and the unfiltered marker scan is empty. An incomplete or timed-out `listSessions` page is contradictory, not zero. Prove: inject a marker-less `{uuid}.jsonl` after prepare starts, lose the response, resume; fork count stays 1 and public state is `needs_attention`.
7. **Inspect-with-preview no-mutation oracle.** Zero `forkSession`, `prepare`, or `deleteSession` calls; source JSONL and every sidecar hash unchanged; session count in the disposable store unchanged; no preview bytes persisted on the operation row. Stale-revision inspect is a different preflight and is not this oracle.
8. **Pin `includeReadableHistory` omit semantics.** Public start/resume field is either required boolean or optional default false. Add a public-route test that omits the field: persist `include_readable_history=false`, create no imported-message events or FTS, and expose no preview/canary text. A 400 on omit is acceptable only if every shipped client sends an explicit boolean and that omit case is tested.
9. **Mapping-needed recovery must become Ready.** Public/RTL case: start Mapping needed with no matching ready environment; after a ready environment whose canonical path equals the source lookup-scope cwd exists, the same source is Ready and commit is allowed; a sibling/relocated/symlink-only path stays Mapping needed. Invoking setup and calling `revalidate` is not sufficient.

## Refuted by pre-verification

No findings were supplied as pre-refuted.

## Verdict

`not-ready`: one blocker and eight high-severity findings survived the merge.

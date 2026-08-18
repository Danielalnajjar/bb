# Continue Claude Code in BB

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must remain current as implementation proceeds.

## Status

Parked, planning-only. Local repository exploration, primary-source research, Omega hardening, Omega discovery, and three complete Omega adversarial passes are preserved. All twenty-five findings from complete adversarial passes are integrated. Pass four (`wf_af9514674137`) was explicitly interrupted before refutation/merge and contributed no adopted findings. Implementation has not started; a resumed effort must run a fresh adversarial pass before source edits.

## Purpose / Big Picture

BB users should be able to take useful work already living in Claude Code and continue it in BB without writing a handoff, losing Claude's native conversational context, or risking two clients writing the same Claude session.

The feature appears in the app as **Continue Claude Code in BB** beside ordinary thread creation and in the command palette. It opens one responsive surface where the user chooses an enrolled machine, finds a session, confirms an exact BB workspace mapping, and decides whether supported historical messages may also become readable and searchable in BB. The terminal action creates a new Claude-native fork owned by BB, leaves the original unchanged, publishes one idle BB thread only after verification, and opens that thread with its composer focused. A durable operation record makes duplicate clicks, disconnects, restarts, and ambiguous provider responses understandable and retry-safe.

The same behavior is available through the public SDK and `bb` CLI. V1 is deliberately Claude-specific and single-session-first; it preserves reusable core invariants without presenting a generic migration framework.

## Worker routing

- Worker provider: **grok**.
- Grok owns direct implementation, corrections, simplification, and all Omega stages.
- Codex owns lead decisions, local explorer and librarian lanes, review synthesis, and final verification.
- Do not substitute Codex for a Grok build or Omega lane unless the user changes this routing.

## Progress

- [x] (2026-08-17) Read the live workflow-cycle, Grok CLI, discovery-first planning, Omega plan, testing, BB CLI, BB plugin authoring, and repository instructions.
- [x] (2026-08-17) Verify Grok with a real authenticated request and verify `omegacode doctor` advertises Grok.
- [x] (2026-08-17) Clone `get-bb/bb`, create `feat/claude-code-session-import`, install locked dependencies, and verify a clean tree.
- [x] (2026-08-17) Read the canonical 19-designer recommendation, prior technical synthesis, and unknowns pass.
- [x] (2026-08-17) Complete three non-overlapping Codex explorer lanes covering provider/runtime, server/persistence, and app/UX.
- [x] (2026-08-17) Freeze the external research query/skip list before librarian dispatch.
- [x] (2026-08-17) Incorporate the two librarian Context Packs and mark the plan discovery-complete.
- [x] (2026-08-17) Run Grok Omega hardening (`wf_09a494ba829d`) and integrate all 16 surviving amendments.
- [x] (2026-08-17) Run Grok Omega discovery (`wf_4550eda8d12d`) and integrate both surviving amendments.
- [x] (2026-08-17) Run Grok Omega adversarial review pass 1 (`wf_901de924b84a`) and integrate all ten surviving amendments.
- [x] (2026-08-17) Run Grok Omega adversarial review pass 2 (`wf_2b7f9420b47d`) and integrate all six surviving amendments.
- [x] (2026-08-17) Run Grok Omega adversarial review pass 3 (`wf_f4e0e62a2847`) and integrate all nine surviving amendments.
- [x] (2026-08-17) Park the cycle at the user's request; interrupt incomplete adversarial pass 4 (`wf_af9514674137`) without adopting partial output.
- [ ] On resume, run a fresh Grok Omega adversarial review against the parked plan and reach implementation-ready.
- [ ] Implement Milestones 1–7 with Grok, preserving one writer per file slice.
- [ ] Run targeted tests and create local R0.
- [ ] Run Codex lead review plus two blind Opus baseline reviews.
- [ ] Triage, research accepted uncertain fixes, and apply Grok corrections with bounded re-review.
- [ ] Run Grok Omega review, ChatGPT Pro PR review, and Grok Omega simplification.
- [ ] Run final Turbo gates, affected-flow browser QA, source-safety disposable probes, and completion audit.
- [ ] Stop branch-ready without pushing, opening a PR, merging, or deploying.

## Surprises & Discoveries

- BB already has the correct native-continuation primitive: the Claude bridge maps `thread/fork` to Agent SDK `forkSession()` and then treats the returned UUID as an ordinary restorable provider session. The missing product is orchestration around an external source, not a new conversation mechanism.
- Provider session identity is event-sourced (`events.providerThreadId`), not a column on `threads`. A valid imported idle thread therefore needs a factual identity event in its atomic publication transaction.
- Ordinary thread creation is eager and its provisioning recovery is intentionally process-local cleanup, not a resumable saga. Reusing it would expose a half-imported thread and lose idempotency.
- Agent SDK 0.3.197 exposes `listSessions`, `getSessionInfo`, `getSessionMessages`, `forkSession`, and `deleteSession`; the Claude bridge simply does not expose most of them yet.
- SDK 0.3.197 bundles Claude CLI 2.1.197. That CLI predates cross-directory session lookup, so the owned fork must later resume from the exact source cwd/project-worktree lookup scope. Current cross-directory behavior cannot be assumed.
- `getSessionMessages` rebuilds only the active parent chain, applies offset/limit after that reconstruction, omits system entries by default, and can exclude pre-compaction history. It is a bounded readable projection of resumable context, not a complete raw transcript or audit log.
- Standalone `forkSession` promises a new UUID and remapped message chain, but it does not return source lineage, an old-to-new UUID map, subagent/file-history copies, or an atomicity guarantee against an external writer. BB must persist lineage itself and probe races.
- `forkSession` can set a custom title. An operation-derived preparation title provides a provider-side reconciliation marker after a lost response; retries can search for it before any second fork is allowed.
- A source provider session and BB timeline/search are separate data products. Native context continuity works without importing any old messages into BB.
- A Claude resume acknowledgement is optimistic: a stale UUID can be accepted before asynchronous consumption later reports failure. Native fork is the required preflight because it fails synchronously when the source is unreadable.
- The stable app entry is `ProjectListActionButtons`, not the empty welcome or ordinary composer. Ordinary create also honors a user preference that can suppress navigation, which import success must bypass.
- The Claude plugin's singular `bb.host` artifact is already the provider bridge. Session operations should extend the provider bridge/runtime command seam rather than attempt a second plugin-host executable or let core read Claude files.
- Non-thread online RPC commands with `envLane: null` do not acquire an existing provider mutation lane. Import prepare/abort therefore need serialization inside dispatch/runtime or explicit new online-RPC lane keys; `resolveProviderLane` is not already providing it.
- Imported system events cross more closed graphs than the first draft named: domain type/scope/decode, provider-identifier resolution, both live-FTS switches, event projection, server timeline contracts, app/CLI rendering, search kinds, generated plugin SDK declarations, and their fixtures must move together.
- An idle thread DELETE is not a long-lived soft-delete followed by a later import-aware sweep: `markThreadDeleted` can be followed by synchronous `finalizeStoppedThread` hard deletion in the same request. Import claim release must therefore happen in the DB-owned mark-delete transaction used by every caller.
- The maintenance runtime's workspace is a dummy data directory. Every Claude session utility must receive the explicit source cwd/dir; it must never inherit that runtime workspace.
- An owned fork is visible and mutable from Claude Code. BB can ensure quiescence only by revision checks immediately before projection and publication, not by claiming exclusive ownership of the provider store.
- Host-daemon restart is not server-saga restart. Durable recovery proof must close/recreate the HTTP server and DB owner against the same file-backed SQLite; daemon crash/restart is a separate host-offline/lost-RPC case.
- Import target identifiers and provenance outlive project/environment/host rows. They must not cascade away, and nonterminal imports must participate explicitly in each owning deletion/prune graph so a unique source claim cannot become stranded.
- A host-wide Claude catalog intentionally omits `dir`; exact source `dir` is mandatory only for inspect/preview, import snapshot/prepare, messages, abort/delete, and eventual resume. The maintenance runtime workspace is never a Claude session lookup scope.
- Marker reconciliation alone cannot exclude a marker-less fork after a lost response. BB must persist a plugin-produced pre-fork directory identity/mtime snapshot before mutation, and any unexplained new session makes retry ambiguous rather than permitting another fork.

## Decision Log

### D1 — Native fork, never exact-ID adoption in v1

Create a new Claude session UUID with `forkSession`; do not resume the external source UUID. This gives the first BB message one write home while leaving the source unchanged. BB has no cross-client lease that could make adoption exclusive.

### D2 — Dedicated core import saga

Do not add `providerThreadId` to generic thread creation and do not disguise the external source as a BB `sourceThreadId`. Add a core-owned `provider_imports` domain with an explicitly Claude-specific v1 public route. This keeps ownership, privacy, idempotency, compensation, and publication invariants inseparable.

### D3 — Provider-local operations through the existing bridge process seam

Add additive provider-bridge requests for session list, inspect, message projection, import prepare/reconcile, and abort. Add matching Agent Runtime methods and host-daemon commands. Core supplies the validated bridge launch; the Claude plugin interprets Claude storage and SDK types. Host daemon transports raw typed values and does not learn Claude storage policy.

### D4 — Mandatory host protocol bump, additive bridge protocol

Increment `HOST_DAEMON_PROTOCOL_VERSION` from 130 because new server↔daemon commands are wire changes. Keep Provider Bridge Protocol v1 only if the methods are additive and older bridges remain valid; conformance must prove unsupported methods return an explicit capability/unsupported result rather than hanging.

### D5 — Publish once in a new immediate transaction

Do not call ordinary `createThread()`. A dedicated DB command creates the idle thread, a factual provider identity event, durable provenance, the bounded historical marker/messages if consented, matching FTS segments, and terminal operation state in one immediate SQLite transaction. The import boundary and imported-message events are unscoped system events whose `events.provider_thread_id` is null; source session/message IDs live only in their payloads. Only the factual identity event carries the owned provider UUID. Notifications and plugin `thread.created` fire only after commit and never carry message bodies.

### D6 — Default history exposure off

Provider-native continuity is always created. `includeReadableHistory` defaults false. Only explicit activation allows projected messages to be held in memory for publication, persisted, rendered, searched, sent to remote clients, or observed by permitted plugins. The operation row is the sole consent authority: retry/resume ignores any contradictory caller value and cannot broaden a stored false choice.

### D7 — Minimal discovery before content consent

The default candidate catalog returns source UUID, last activity, file size, branch, canonical cwd/worktree identity, version/support facts, mapping status, and import status. It does not return first prompts, generated summaries, verbatim messages, or transcript-derived intent. When the user explicitly enables readable history, the selected-session inspector may fetch a bounded read-only preview from the source under the same disclosure; this creates no fork and the preview remains ephemeral. The commit later re-reads the quiescent owned fork, so the inspector states that published readable history is the remapped owned chain and may omit or reorder records relative to the source preview.

### D8 — Existing-ready workspace in v1

A Ready candidate must map to an existing ready BB environment on the same enrolled host whose canonical path is exactly equal to the source lookup-scope canonical cwd. Sibling, relocated, symlink-only, same-worktree-but-different-path, deleted, ambiguous, or not-yet-attached rows are **Mapping needed** with a contextual setup action, then refresh. V1 does not create a worktree or relocate a Claude transcript inside the import saga.

This constraint prevents a prepared provider fork from being bound to a cwd from which ordinary BB resume cannot locate it. There is no implementation-time probe escape hatch: v1 ships exact canonical-path equality only. Any future relaxation requires a separate evidence-backed plan and compatibility matrix.

### D9 — Provider-side operation marker and no blind retry

Before provider mutation, reserve a core operation UUID and canonical source claim. Prepare calls `forkSession(sourceId, { dir: sourceCwd, title: operationMarker })`. The marker contains an unguessable operation UUID and no source content. On retry, reconcile by exact marker and metadata before forking. If zero results are proven after a completed failure, retry may fork; if one result exists, reuse it; if multiple or contradictory results exist, enter `needs_attention`. Never blindly fork from an ambiguous state.

Because the SDK does not structurally expose “fork of source,” the exact operation title is a BB reconciliation convention, not provider-native lineage. Reconciliation must verify the marker, cwd, creation/modification window, and absence from existing BB ownership claims. If that evidence is not unique, stop in `needs_attention`.

Read source metadata immediately before and after `forkSession`. If the source revision tuple changes during preparation, first re-read the owned marker/revision tuple. Delete the just-created fork only when that owned snapshot is unchanged, then verify deletion and return `source_changed`. If the owned marker/revision changed, refuse deletion and move to `needs_attention` with `owned_externally_written`; do not publish a potentially ambiguous cutoff. This detects ordinary concurrent writes but is not claimed as a provider lock.

### D10 — Default duplicate opens the existing import

The first ordinary import for `(host, provider, sourceSessionId)` owns a unique nullable `canonicalSourceClaim`. A concurrent or later ordinary request returns the existing operation/thread and the UI labels the primary action **Open existing thread**. An explicit **Create another copy** request sets no canonical claim, uses a new operation ID, and plainly states that it creates a second Claude fork.

One domain/DB module owns claim lifetime. Repeat-safe pre-publication abort and explicit offline abandon release the claim. Archive writers retain it, and **Open existing thread** includes/unarchives the live archived row while forwarding only the owned UUID. BB's real idle-delete path can mark and synchronously hard-delete the thread in one request, so every `markThreadDeleted` caller must invoke the same DB-owned CAS that clears the canonical claim and marks the import `reclaimed` before `deleteThread`; public thread DELETE and project deletion therefore permit later default re-import. Neither delete nor archive removes either Claude session under current Claude retention semantics. The import row survives as a provenance tombstone, and `thread_id` becomes a dangling logical identifier without a cascading foreign key after deletion.

### D11 — Import-specific historical events and bounded fidelity

Do not manufacture turns, live tools, pending approvals, tasks, or subagents. Add unscoped thread-system `system/thread-imported` and `system/imported-message` event types with null provider identity. Imported messages carry source message UUID when present, role, normalized text blocks, source timestamp when present, order, projection version, and fidelity flags in payload only. V1 projects supported user, assistant, and system text returned by the SDK's active-chain view. Tool use/results, raw thinking, attachments, tasks, approvals, hooks, background processes, subagent sidechains, pre-compaction entries absent from the active chain, arbitrary metadata records, and file-history/undo are named omissions. `@bb/thread-view` owns the first-class inert boundary/imported-message timeline rows used by server, app, and CLI; adapters never reinterpret them as live conversation rows. The UI calls this **readable history from the resumable conversation chain**, never a complete transcript.

### D12 — Static provenance, not sync

The published import row remains the durable provenance record: source and owned IDs, host, provider, source revision tuple and cwd, target project/environment/path, history decision, projection version, omission classes, SDK/CLI versions when detectable, timestamps, and lifecycle/tombstone state. BB never re-reads the source after successful publication and never labels it synchronized, locked, or current.

### D13 — Single-session v1

No bulk selection or bulk commit in this PR. The data model and candidate status remain compatible with a later accelerator, but bulk does not shape the initial UI or API.

### D14 — Omega hardening amendments integrated

Run `omega-plan:20260818T034247Z-f70c3eef` returned **Amend before discovery** with 2 blockers, 13 majors, and 1 minor. All 16 amendments were accepted because they were file-backed and either closed a safety hole or removed unjustified state. The plan now pins null provider identities on import events and a queued-command first-send oracle; requires real-SDK source-safety; defines archive/delete/claim retention; permits abort from every pre-publication stage; makes preview source-read-only; routes history through `@bb/thread-view`; forbids live-session creation during prepare; requires project scope; separates in-memory one-fork proof from file-backed restart proof; adds public consent negatives and protocol-pin proof; removes history staging, post-publish rename, startup mutation, and runtime read-back reclassification; and names existing harness/test-value requirements.

### D15 — Omega discovery amendments integrated

Run `omega-plan:20260818T040750Z-f15c848d` returned two plan amendments and no inconclusive findings. Both were accepted because they correct current-source assumptions and enumerate compile/runtime closed graphs. Provider session operations now explicitly use a provider maintenance runtime through `resolveRuntimeBridgeLaunch` and `ensureProviderMaintenanceRuntime`; capability or `-32601` handling occurs before `requireProviderRequestPlan`; mutating prepare/abort calls are non-retryable at the host RPC boundary and gain their own serialization rather than relying on `resolveProviderLane`. Milestones 1 and 6 now carry the complete inert-event, FTS, projection, renderer, generated-type, fixture, and first-send switch inventory. The Claude SDK prepared-fork lifecycle was confirmed without amendment.

### D16 — Adversarial pass 1 amendments integrated

Run `omega-plan:20260818T042503Z-453db13a` returned **not-ready** with one blocker, nine non-blocking survivors, and no inconclusive findings. All ten were accepted. The plan now makes the real-SDK source-safety test part of the default plugin test target; models claim release on BB's actual synchronous idle-delete path; clones the production `thread.unarchive` maintenance-runtime pattern; splits private catalog listing from unfiltered marker reconciliation; makes abort repeat-safe and adds explicit offline abandon; revision-checks the externally visible owned fork; proves publication never reuses source-preview bytes; mandates import-specific file-backed process restart; pins history limits and truncation behavior; and restores durable UI operations even when the original URL is gone. This is adversary pass 1 of at most 5; implementation remains blocked pending a ready rerun.

### D17 — Adversarial pass 2 amendments integrated

Run `omega-plan:20260818T044715Z-418101b1` returned **not-ready** with six survivors and no inconclusive findings. All six were accepted. Restart proof now stops/recreates the server and DB owner against one file-backed database rather than misusing `crashDaemon`; any owned-session deletion first revalidates the marker, prepared revision, and absence of newer conversation content; project/environment/host lifecycle transactions explicitly abandon or clean nonterminal imports without cascading provenance; readiness and first-send use one exact canonical path oracle with no probe escape hatch; explicit new-copy must create a second Claude fork; and command-palette registration/handler/RTL/acceptance are named. This is adversary pass 2 of at most 5; implementation remains blocked pending a ready rerun.

### D18 — Adversarial pass 3 amendments integrated

Run `omega-plan:20260818T050643Z-ce25039e` returned **not-ready** with nine survivors and no inconclusive findings. All nine were accepted. The default real-SDK test now proves the owned chain actually contains the source's supported text with remapped IDs; host-wide catalog omits `dir` while all session-specific utilities require source cwd; the new server restart harness has explicit owners/lifetimes; CLI docs target the real template generator and hand-authored built-in skill; online release-without-delete is available for every pre-publish state; a persisted plugin-side pre-fork directory snapshot prevents marker-less lost-response duplication; preview proves zero mutation and zero persistence; omitted history consent defaults false; and mapping recovery must demonstrate the same candidate becoming Ready after an exact-path environment appears. This is adversary pass 3 of at most 5; implementation remains blocked pending a ready rerun.

### D19 — Cycle parked before adversarial pass 4 completed

The user asked to park the work and push the planning packet to a BB fork. Run `wf_af9514674137` was interrupted during its three primary attack lanes before refutation or merge, so it has no valid verdict and none of its partial output is adopted. Completed hardening, discovery, and adversarial passes 1–3 remain authoritative. The resume point is a fresh adversarial pass against this exact plan; no implementation, local R0, push of source changes, PR, merge, or deploy occurred in the active cycle.

## Outcomes & Retrospective

Parked before implementation. The durable output is the planning packet: product design, technical research, unknowns, Plan 0, this ExecPlan, and completed Omega reports. No product code, migration, test, UI, local R0, browser QA, PR, merge, or deploy exists yet.

## Context and Orientation

The repository is a pnpm/Turbo monorepo.

- Product policy and public HTTP routes live in `apps/server`.
- Host-local commands and runtime lifecycles live in `apps/host-daemon` and `packages/agent-runtime`.
- Wire schemas live in `packages/host-daemon-contract` and `packages/provider-bridge-protocol`.
- The Claude provider plugin lives in `plugins/provider-claude-code`; its `bb.host` artifact is `src/bridge/bridge.ts`.
- Persistent core data and Drizzle migrations live in `packages/db`.
- Shared domain/event schemas live in `packages/domain`.
- Public request/response types live in `packages/server-contract`, with client methods in `packages/sdk` and commands in `apps/cli`.
- The React app lives in `apps/app`.

Existing BB-native fork flow:

    public fork request -> server resolves BB source thread/provider identity/host
      -> host daemon thread.start(fork descriptor)
      -> Agent Runtime thread/fork
      -> Claude bridge forkSession(source UUID)
      -> provider identity event -> idle BB thread

New external continuation flow:

    select project + host -> provider session list/inspect -> exact ready environment mapping
      -> reserve durable operation -> provider prepare/reconcile native fork
      -> optionally page bounded normalized history from the quiescent fork into memory
      -> atomic BB thread + identity + provenance + history commit
      -> direct navigation to idle composer

An **operation** is the durable core record for one requested continuation attempt. A **source session** is the external Claude UUID and is never written by BB. An **owned session** is the new Claude UUID returned by `forkSession` and becomes the provider identity of the published BB thread. A **projection** is the optional supported historical text BB copies into its own event/search model; it is not provider context.

## Data Model and Invariants

### `provider_imports`

Add a core table whose row survives publication and serves both operation recovery and provenance. Exact field names may follow local schema conventions, but it must contain:

- `id` — server-accepted UUID operation identity, primary key.
- `idempotency_key` — unique caller key; repeating it returns this row.
- `canonical_source_claim` — nullable unique stable hash/key for the default first import of host/provider/source; null only for explicit additional copies.
- `host_id`, `provider_id`, `source_provider_thread_id`. `host_id` is retained as a logical identifier with no delete cascade so provenance survives host removal.
- `source_revision`, `source_last_modified`, `source_file_size`, `source_cwd`, optional `source_git_branch`, and safe source display metadata. The revision tuple detects drift but is not described as a cryptographic content fingerprint.
- `prefork_session_snapshot_json` and digest, containing only plugin-observed session UUIDs/mtimes for the source lookup-scope directory plus snapshot time. It is captured by a read-only provider operation and persisted before the first fork attempt; it contains no message text.
- `target_project_id`, `target_environment_id`, and snapshotted target canonical path. Project/environment IDs are logical identifiers with no `ON DELETE CASCADE` (no FK or `SET NULL` plus retained snapshots) so the operation/provenance row survives lifecycle cleanup.
- `owned_provider_thread_id` nullable until prepared, with a unique index across `(host_id, provider_id, owned_provider_thread_id)` when non-null, plus an owned revision tuple (`owned_last_modified`, `owned_file_size`, and any stable SDK metadata available) snapshotted when prepare is persisted.
- `thread_id` nullable then unique logical identifier without a cascading foreign key, so the import/provenance tombstone survives thread hard deletion.
- `include_readable_history` with a public omitted-field default of false, `projection_version`, `omitted_record_classes_json`, exact projected message/byte counts, a lower bound on source records observed, and persisted truncation facts. Do not represent the observed lower bound as a total because the SDK exposes no total count.
- `stage` with a closed enum: `reserved`, `preparing`, `provider_prepared`, `published`, `reclaimed`, `needs_attention`, `aborting`, `aborted`, `abandoned`. `reclaimed` means the linked BB thread was deleted and the canonical source claim was released; `abandoned` means a user explicitly released a pre-publication claim while the host was unreachable or destroyed and an orphaned provider copy may remain. Both rows survive as provenance tombstones.
- expected error fields: `failure_code`, safe `failure_message`, `failed_stage`, `retryable`.
- provider operation marker and detected SDK/CLI version fields when available.
- `created_at`, `updated_at`, `published_at`, `aborted_at`, `abandoned_at`.

Constraints:

- `published` requires non-null owned provider ID and thread ID.
- `provider_prepared`, `published`, and `reclaimed` require an owned provider ID; `aborted`/`abandoned` may or may not have one depending on where cleanup stopped.
- `include_readable_history = false` forbids imported-message events and imported-message FTS segments.
- a thread linked to a published import is provider `claude-code`, has the same environment host, and its latest provider identity equals the owned UUID.
- source and owned UUIDs must differ.
- stage transitions use transactional compare-and-set; terminal transitions are repeat-safe.
- publication requires the currently observed owned revision tuple to equal the tuple persisted at prepare; missing or changed owned state cannot publish.
- any cleanup that would call `deleteSession` is authorized only when an immediate SDK metadata re-read proves the exact operation marker still exists and the owned revision tuple equals the prepared snapshot. Under the supported file-backed store, any title/content write changes `lastModified` and/or `fileSize`; BB therefore treats every tuple change conservatively as possibly newer user/assistant content and refuses deletion without reading message bodies when history consent is off. Otherwise it preserves the provider copy and claim, moving to `needs_attention` with `owned_changed` or `owned_externally_written`.
- a second `forkSession` is forbidden unless the persisted pre-fork snapshot still exactly matches a complete current plugin snapshot and the complete unfiltered marker scan returns zero. Incomplete/timed-out listing or any new unclaimed session UUID/mtime is contradictory and moves to `needs_attention` with `ambiguous_fork`.

### Event and thread contract

Extend the domain with `system/thread-imported` and `system/imported-message`, both unscoped system events. Extend `ThreadEventDataByType`, scope policy, stored-event decoding, server ingestion closed switches, and `@bb/thread-view` plus server-contract timeline rows. Timeline projection emits one inert boundary and ordered inert imported-message rows with no edit/steer/retry/tool/task/approval affordances. Add `imported_message` to `ThreadSearchSourceKind` and make the dedicated publication command the sole FTS owner for imported messages. Extend the public `Thread` response with nullable import provenance summary sufficient for list/detail/Info rendering without exposing message content. Add a full provenance endpoint if the normal thread payload would become unreasonably large.

The publication transaction creates:

1. an idle visible thread row with no `sourceThreadId` and no `originKind`;
2. a factual `thread/identity` event with the owned provider UUID;
3. one `system/thread-imported` boundary/provenance event with null `provider_thread_id`;
4. zero or more ordered `system/imported-message` events with null `provider_thread_id` only when consented;
5. matching FTS segments only for those imported text events;
6. the import row's `published` state and `thread_id`;

No user-message telemetry fires for publication. Plugin `thread.created` notification and DB notifiers fire after commit exactly once.

## Operation State Machine and Recovery

    reserved
      -> preparing
      -> provider_prepared
      -> published
      -> reclaimed (only after linked thread deletion)

    any nonterminal state -> needs_attention
    any pre-published state -> aborting -> aborted
    any pre-published state -> abandoned (explicit offline/destroyed-host escape hatch)

Transitions:

1. **Reserve.** Validate project/environment/host/provider, candidate revision, history choice (omitted means false), and duplicate policy. Insert or return the row by idempotency/canonical claim before any host mutation.
2. **Persist pre-fork snapshot.** Call the read-only `session/import/snapshot` operation with explicit source cwd. The Claude plugin enumerates session UUIDs/mtimes in that source lookup-scope project directory without reading message bodies or asking core to parse JSONL. Persist the complete bounded snapshot/digest and CAS the operation to `preparing` before any fork attempt. An incomplete or timed-out enumeration cannot authorize mutation.
3. **Prepare.** Dispatch a non-retryable host command carrying operation marker, persisted pre-fork snapshot, source identity/revision/cwd, and bridge launch. The provider first completes an unfiltered marker reconciliation. One exact live-claimed marker is reused; multiple/contradictory results fail. If the scan finds zero, recompute the complete directory snapshot: any new session file/mtime—including marker-less and unclaimed sessions—means `ambiguous_fork` and forbids a second fork; only an unchanged snapshot may call `forkSession`. The provider validates source revision, creates or returns one native fork, verifies source and owned IDs differ, and snapshots the owned marker/revision facts. It rereads the source revision to detect an external write during preparation. Before source-changed compensation deletes the just-created owned fork, it revalidates that owned marker/revision snapshot; any tuple change is conservatively treated as possible newer conversation content. If revalidation fails, it does not delete, retains the claim, and returns `needs_attention` with `owned_externally_written`/`owned_changed`.
4. **Persist prepared identity.** CAS `preparing -> provider_prepared`, storing the owned UUID and owned revision tuple together. If the server loses the response, the row remains `preparing`; `resume` repeats complete reconciliation with the same marker and persisted pre-fork snapshot, never a raw second fork.
5. **Commit.** Revalidate target environment remains ready/on the same host and its live canonical path still equals the snapshotted source/target cwd. Re-read the owned revision immediately before optional history paging and again immediately before the publication transaction; both observations must equal the prepared tuple. Missing state yields `owned_missing`; changed state yields `owned_changed`; neither publishes, and the operation remains `provider_prepared` or moves to `needs_attention` with the typed cause. When consent is true, page only the owned fork into bounded memory: request at most 100 underlying records, persist at most 2,000 complete normalized messages, at most 8,388,608 UTF-8 bytes across persisted normalized text, at most 262,144 UTF-8 bytes per message, and return at most 1,048,576 serialized bytes per host page. The provider response owns explicit `nextOffset`/`hasMore`; a response shortened for its byte cap is not mistaken for EOF. An oversized individual message advances the source offset but contributes an omission record and no body. On any aggregate bound, publish only complete chronological records below every cap and persist `history_projection_truncated_at_limit`, exact projected counts/bytes, and the observed-source lower bound; native Claude context is unaffected. One immediate transaction publishes the complete BB state and marks the operation `published`. A crash before commit simply re-pages the still-quiescent fork. The transaction is the publication authority; tests perform public read-back, while a lost HTTP response retries the operation ID and returns the already-published thread.
6. **Abort or release.** Allow cleanup abort from every pre-published stage. For `preparing`, reconcile the operation marker/snapshot first. Immediately before any `deleteSession`—abort, retry cleanup, or source-changed compensation—call `getSessionInfo(ownedId, { dir: sourceCwd })`. Delete only when the marker title is intact and the owned revision equals the prepared snapshot; under the supported file store, BB treats any metadata tuple change as possible newer user/assistant content and refuses deletion without reading bodies when consent is off. Then prove absence. Proven prior absence/SDK not-found is repeat-safe success: release the claim and mark `aborted`. A missing marker or changed tuple means BB retains the claim and CASes to `needs_attention` with `owned_changed`/`owned_externally_written` plus copy explaining that BB will not delete the modified Claude session. Contradictory post-delete presence, multiple marker hits, or owned equals source also remain needs-attention. Separately, every pre-publish state—including reachable-host `needs_attention`—offers consequence-labeled **Release claim without deleting copy** / **Abandon import**. That action never calls `deleteSession`; it NULLs the canonical claim and marks `abandoned`, disclosing the marker-titled orphan. Once released, catalog/reconciliation may hide marker sessions only for still-live claimed operations: the orphan becomes a normal candidate or a named recoverable orphan, never permanently filtered by its tombstone. After publication, abort/release reject and normal thread lifecycle applies.
7. **Archive/delete and owner lifecycle.** Archive writers (`archiveThreadWithLifecycleEffects` and environment/child cascades) retain the claim because a live archived row can be opened and unarchived without touching the source. Idle published-thread DELETE follows the actual same-request path: `markThreadDeleted` then synchronous `finalizeStoppedThread`/`deleteThread`. The `deletedAt` write and provider-import reclaim CAS are one immediate SQLite transaction invoked by every `markThreadDeleted` caller including public DELETE, `beginProjectDeletion`, and `advanceProjectDeletion`; it clears `canonical_source_claim` and marks `reclaimed` before the thread row is deleted, so no crash can expose deletedAt with the claim still unique. `thread_id` then remains a dangling logical identifier with no live row. There is no separate import hard-delete/sweep stage. Before project deletion, environment destroy/prune, or host destroy removes an owner, the same lifecycle transaction enumerates every targeting nonterminal import and either completes safe abort or CASes it to `abandoned` while clearing its canonical claim and recording possible orphan disclosure. `wouldCleanupEnvironment` treats a targeting nonterminal import as a live pin unless the destroy transaction abandons it first. Published tombstones remain addressable by operation ID after thread deletion, environment prune, project deletion, or host removal. These lifecycle paths never silently delete modified Claude sessions.

Startup/reconnect reconciliation only lists nonterminal operations and surfaces **Resume import**. The begin/resume route is the sole mutation owner; `preparing` reconciles the marker only when that route is invoked. Offline host is a durable addressed condition, not an unseen background queue. Explicit abandon is the only offline path that releases the claim, and it never claims provider cleanup.

## Public API, SDK, and CLI

Add a Claude-specific provider-import area to the server contract. Naming can be adjusted to local REST conventions, but the public behavior must include:

- list candidates by required `projectId` and explicit `hostId`, pagination cursor/offset, scoped search, and catalog mode;
- inspect one candidate under the same project/host scope with mapping/readiness/provenance facts and an optional explicitly consented preview;
- begin/resume a continuation with caller `operationId`/idempotency key, exact source revision, ready target environment, `includeReadableHistory?: boolean` whose schema default is false, and duplicate policy. Resume never broadens the already persisted choice;
- get/list durable operations, including the thread ID on publication;
- abort a pre-publication operation, and explicitly abandon one when its host is unreachable/destroyed;
- get durable provenance for a published thread.

SDK: add typed `sdk.providerImports.claudeCode.*` or the closest deep local area. Keep session UUIDs opaque. Never expose a generic method that binds an arbitrary provider ID to a BB thread.

CLI:

    bb thread continue claude-code list --project <project> --machine <host> [--all] [--query <text>] [--json]
    bb thread continue claude-code inspect <session-id> --project <project> --machine <host> [--preview-readable-history] [--json]
    bb thread continue claude-code start <session-id> --project <project> --machine <host> --environment <id> [--include-readable-history] [--new-copy] [--json]
    bb thread continue claude-code status <operation-id> [--json]
    bb thread continue claude-code resume <operation-id> [--json]
    bb thread continue claude-code abort <operation-id> [--json]
    bb thread continue claude-code abandon <operation-id> [--json]

Register `import claude-code` as a documented alias for the same subtree if the CLI framework supports a true alias without duplicated implementations or help drift. Otherwise keep `continue` canonical and include “import” in descriptions/search tokens rather than adding a shallow wrapper.

JSON output must be stable structured data; human output uses the same Ready/exception and Open existing semantics as the app.

Update the two real discoverable CLI surfaces in one change: edit `packages/templates/src/templates/bb-guide-threads.md` and run its `generate-templates.mjs` process; separately hand-edit `apps/server/src/services/skills/builtin-skills/bb-cli/SKILL.md` because it is not generated. Do not treat `docs/cli-guide-and-skill.md` as command reference unless this change intentionally alters the sync process itself.

## Provider Bridge and Host Runtime

Add strict additive provider-bridge request/response schemas and optional capabilities for:

- `session/list`
- `session/inspect`
- `session/messages`
- `session/import/snapshot`
- `session/import/prepare`
- `session/import/abort`

Names must remain provider-neutral at the wire level, but only the Claude provider declares support and only Claude appears in the v1 product. Unsupported providers/older bridge artifacts return a typed unavailable status.

Extend `AdapterCommand`, bridge-protocol adapter request planning/parsing, Agent Runtime public methods, host-daemon contract/registry, dispatch, and command handlers. Clone the production `thread.unarchive` provider-process pattern: in the dispatch handler resolve the supplied bridge artifact with `resolveRuntimeBridgeLaunch`, then obtain the process with `runtimeManager.ensureProviderMaintenanceRuntime`. Its workspace is a dummy host `dataDir`, not the user's project; every session API call must therefore carry the validated explicit source cwd/dir and must never inherit `runtime.workspacePath`. If implementation shares the `list_models` `options.*` injection shape, name and test the corresponding `app.ts` injection; `defaultListModels` or any discovery default is forbidden for prepare/abort. Handle an absent capability or JSON-RPC `-32601` as typed unsupported before calling `requireProviderRequestPlan`, so an older bridge fails promptly rather than timing out or reaching a request-only assertion. Discovery reads use `callHostRetryableOnlineRpc`; prepare and abort set `retryable: false` and use `callHostOnlineRpc` because blind transport retries can duplicate provider mutations. Commands with `envLane: null` do not already acquire a provider lane: serialize prepare/abort per `(provider, source cwd/operation)` inside dispatch/runtime or add explicit online-RPC lane keys, never claim `resolveProviderLane` already protects them. Apply the pinned page/result bounds below. Change the host-protocol assertion from 130 to 131 with an explanatory test comment; update the strict command registry, the hand-maintained `onlineRpcResponseSuccessSchemaFor` union, and `ONLINE_RPC_RESPONSE_RESULT_FIXTURES` for every new command type.

Claude bridge behavior:

- Candidate catalog and marker reconciliation are separate helpers with different privacy contracts. The host-wide user-facing catalog calls `listSessions({ includeProgrammatic: false, limit, offset })` with `dir` omitted so it enumerates all projects; omission does not mean the maintenance runtime workspace. It filters sidechains and marker sessions only for still-live claimed operations, and strips prompt/summary content. Released marker-titled sessions appear as ordinary candidates or named recoverable orphans. Reconciliation pages an unfiltered `listSessions({ dir: sourceCwd, includeProgrammatic: true, limit, offset })` scan through the terminal short page, never drops marker titles, matches only `customTitle === exactOperationMarker` (never summary/first prompt), and then calls `getSessionInfo(ownedId, { dir: sourceCwd })`. The reconciliation helper must never reuse catalog filtering; incomplete/time-out is contradictory, never zero.
- Strip prompt/summary content from default results; return only the minimal allowed metadata.
- Inspect/preview, import snapshot/prepare, messages, abort, and delete always pass `dir: sourceCwd`; catalog alone omits dir. `getSessionInfo(sourceId, { dir: sourceCwd })` returns the stable revision tuple from session ID, lastModified, fileSize, cwd, and branch. State clearly that this is drift detection, not content authentication, and never pass the maintenance `runtime.workspacePath` as dir.
- `session/import/snapshot` is read-only. It enumerates the bounded complete set of session UUIDs/mtimes in the source lookup-scope project directory without parsing message bodies, returning the snapshot/digest that core persists before mutation. Prepare compares the supplied baseline both before a first fork and after any lost response; an unexplained new marker-less file, an incomplete list page, or a timeout yields `ambiguous_fork` and no fork.
- Prepare reconciliation uses the unfiltered helper above. It calls `forkSession` at most once for a marker and then verifies `getSessionInfo(ownedId, { dir: sourceCwd })`.
- Prepare is a quiescent file/session utility only: it must not call or delegate to `thread/fork`, construct a `ThreadSession`, call `session.start`, or register a live runtime session for the owned UUID.
- Project history from the quiescent owned fork with `getSessionMessages`, not the mutable source or ephemeral inspector bytes. Use explicit `{ dir: sourceCwd }` and the public limits: request size 100, 2,000 complete persisted messages, 8,388,608 normalized UTF-8 bytes, 262,144 bytes per normalized message, and 1,048,576 serialized bytes per host page. The bridge returns explicit `nextOffset` and `hasMore`, advances past omitted oversized records, and never relies on a byte-shortened result length as EOF. Offset pagination is safe only while both owned revision checks remain equal and BB has not resumed/written the fork; no provider-store exclusivity or snapshot/cursor guarantee is claimed.
- Normalize only supported text into provider-neutral import message values and enumerate omissions.
- Abort and every prepare/retry compensation call `deleteSession(ownedId, { dir: sourceCwd })` only after an immediate `getSessionInfo` check proves the exact operation marker and prepared owned revision; never accept the source UUID as a deletion target. Any tuple change is conservatively treated as possible newer user/assistant content, yielding `owned_changed`/`owned_externally_written`, and BB refuses deletion without bypassing history consent. Proven prior absence/not-found is successful idempotent cleanup, while contradictory post-delete presence fails closed.
- Use the SDK package's pinned bundled Claude CLI for import probes and production session utilities. Do not silently route through a newer external `pathToClaudeCodeExecutable`; any future skew needs an owned compatibility matrix.

Do not read or write Claude JSONL directly in core, server, or daemon. Provider tests may use disposable fixture stores/directories.

## App Experience

### Entry and layout

Add a labeled **Continue Claude Code** action adjacent to **New thread** inside `ProjectListActionButtons`, retaining a clear route while sidebar search is active or documenting/test-driving the deliberate alternative. Add command-palette access. Do not add permanent primary navigation.

Open a dedicated route/surface, not an ordinary composer mode. Desktop presents a compact machine/session column with a contextual inspector. Compact viewports use the shared persistent responsive overlay/drawer contract with deferred realization and correct focus restore. There is one terminal commit button; no multi-page wizard, synthetic progress percentage, success screen, or celebration.

### Candidate states

- Machine picker is visible and authoritative, with connected/offline state at rest.
- Opening view shows **Ready to continue** by recent activity plus named exception groups: **Already in BB**, **Connect this machine**, **Mapping needed**, **Unsupported**, and **Needs attention**.
- The full machine-scoped catalog and search are one explicit action away. Search and grouping use stored metadata only; never inspect transcript content to infer intent.
- Rows are semantic buttons/options with selected state. Async host switches cannot let a stale response replace the newly selected host's results.
- Candidate count/scale uses pagination or virtualization; inspector state is independent of row mount lifetime.

### Inspector and consent

The inspector displays static source facts, exact target mapping, source-untouched/native-fork explanation, runtime reset, and named omission classes. It also discloses that the BB-owned fork is a normal marker-titled session visible in Claude Code until BB first resumes it; deleting or editing that copy there can make this import unrecoverable, and BB does not have an exclusive provider-store lock. History is a consequence-labeled checkbox/control, initially off:

> Also make supported messages readable and searchable in BB. They will be visible in BB timelines, search, connected clients, and permitted plugins.

Turning it on fetches a bounded read-only preview from the selected source session and updates the visible outcome; it does not prepare a fork. The copy explains that committed readable history is re-read from the remapped owned chain and may differ at unsupported/compacted boundaries. Turning it off clears the preview and guarantees the commit request excludes history. Cancel before start makes no mutation; cancel after an operation exists invokes the durable abort path.

Mapping must be a ready environment on the selected host. Exact auto-matches are preselected. Mapping-needed rows provide a contextual existing setup action, preserve list/search/selection state, then revalidate.

### Recovery and completion

Durable operation state is queried on every mount. When the URL has no operation ID, list nonterminal operations for the selected project/host and render **Resume import** or **Needs attention** directly from those rows; recovery cannot depend on the original tab or URL surviving. Labels map to real states: Reserved, Preparing copy, Copy prepared, Needs attention, Published, Removing copy, Removed, Abandoned, and Thread deleted. Offline/disconnect retains the operation and offers Resume when the host returns plus an explicit, consequence-labeled **Abandon import** escape hatch when the host is unreachable/destroyed; reconnect never mutates automatically. Duplicate default imports lead with **Open existing thread** (including an archived thread); **Create another copy** is secondary and explicit.

On publish, place the returned idle thread in caches and navigate to it regardless of normal new-thread navigation preference. Focus the composer. If the first send fails, preserve the exact composer draft and recover through ordinary thread behavior.

### Published thread

Render one bounded historical region headed with a non-color-only statement such as:

> Continued from Claude Code on {machine}. Messages above this boundary are historical; tools, tasks, approvals, and processes are not live.

The region contains only inert `@bb/thread-view` import rows. Durable provenance also makes the existing Thread Info panel non-empty and shows source machine/session, owned BB session, mapping, history choice, projection version, omissions, import time, and lifecycle/tombstone state. Keep it collapsed by default where density warrants, but reachable in reading order and on compact/remote clients.

### Accessibility and motion

- Complete keyboard, pointer, touch, and screen-reader paths; visible controls precede accelerators.
- Preserve selected-row focus through async updates; return focus to the entry on cancel; transfer focus to the composer on success.
- Use polite live announcements for phase changes without repeating stable row metadata.
- Historical/live distinction cannot rely on color or dimming.
- Honor reduced motion; add no second custom animation atop the shared overlay.
- Long machine names, paths, branches, and errors must wrap/truncate deliberately with full accessible names.
- Verify desktop, compact responsive drawer, zoom/reflow, and representative iOS Safari behavior.

## Milestones

### Milestone 1 — Domain, DB, and public contract skeleton

Add import enums/value types, event schemas/scopes, database tables/data module, generated Drizzle migration, public candidate/operation/provenance schemas, and pure state-transition guards. No route mutates a provider yet.

Move the complete closed event graph together: add both event types and payloads to `systemEventTypeValues` and `ThreadEventDataByType`; add both to `unscopedSystemEventSchema` without `providerThreadId`; give both `policy: "thread"` with rationale in the scope registry; return `undefined` for both cases in the two `event-decode.ts` switches; and map both to `{ providerThreadId: null }` in `resolveProviderIdentifiers`. In both ordinary live-event FTS switches, leave these event types on the default empty result. The publication command writes `providerThreadId: null` and is the sole caller of `upsertThreadSearchSegments` for consented imported text. Add `imported_message` to `ThreadSearchSourceKind` and regenerate the plugin SDK/template declarations with the required `PLUGIN_SDK_VERSION` bump from 0.4.8 rather than hand-editing generated output.

Proof: migration tests, schema contract tests, DB transition/uniqueness tests, import event parse/render fixture tests.

### Milestone 2 — Claude session operations end to end

Add provider-bridge session methods, Claude SDK adapter implementation, runtime methods, host wire commands/handlers, protocol bump, size limits, and conformance tests. Use fixture sessions and a temporary Claude config/project store. Do not touch the user's real sessions in automated tests.

Proof: list/inspect privacy shape; snapshot persists before mutation; prepare returns a distinct UUID without creating a live `ThreadSession`; same marker reconciles one UUID even when the catalog helper hides the marker; a marker-less new session after lost response forbids another fork; messages page stably; abort deletes only the verified prepared fork and treats proven absence as success; unsupported provider/old bridge fails clearly; host protocol pin and exhaustive result fixtures move to the new version. Source safety is a named plugin-package test included by the default plugin Vitest config and therefore by the listed Turbo test command. It uses real 0.3.197 utilities and the SDK-pinned bundled CLI—not `pathToClaudeCodeExecutable` or a stub—against disposable, 0.3.197-readable Claude session fixtures under isolated `CLAUDE_CONFIG_DIR`/project storage, with no mock of `listSessions`, `getSessionInfo`, `getSessionMessages`, `forkSession`, or `deleteSession`. After prepare, it calls real `getSessionMessages` on source and owned with `{ dir: sourceCwd }`, proves the non-empty owned active chain contains the source's supported user/assistant text, and proves source message IDs were remapped when the SDK promises remapping. It also hashes the source JSONL and every subagent/file-history sidecar before/after, proves owned ≠ source, and proves abort removes only unchanged owned. An empty marker-only session, wrong-source fork, mocked/skipped message read, or host-fake-only result fails Milestones 2 and 7. If this test cannot execute and pass, the branch is no-ship.

### Milestone 3 — Durable server saga and atomic publication

Implement reserve, explicit resume, in-memory bounded history paging, atomic commit, duplicate/open-existing, explicit new-copy, repeat-safe abort from every pre-published stage, explicit offline abandon, archive/delete claim lifecycle, and read-only restart/reconnect listing. Add a dedicated atomic DB publication command and post-commit notifications.

Proof: in-memory SQLite public-route integration with failure injection after every durable transition and a stateful host fake that returns a fresh UUID only for an actual fork, returns the same UUID for unfiltered marker reconcile, and fails on a second fork. The import-specific file-backed server-saga harness is new work, not an existing API: add it under `apps/server` test helpers or a named real-process `tests/qa` surface. It opens one `initDb(tempFile)` database, then `crashServer`/`restartServer` closes and recreates the Hono/HTTP server, DB connection/owner, and notification hub against that same SQLite file after `reserved`, `preparing`, and `provider_prepared`. Fresh-process GET must show the same pre-publication stage, zero additional provider-fork calls, and no thread; only explicit resume may reconcile or publish and must converge to one owned UUID/thread. Existing `withTestHarness`/`:memory:` cannot substitute. `crashDaemon` + `startDaemon()` may separately prove host-offline/lost-RPC behavior but never server-saga durability. Repeated operation ID returns the same operation/thread/fork; consent false creates no message events/FTS or public text exposure; consent true pages and persists the owned UUID only; archive/delete/owner removal follow the named claim/tombstone rules; abort/release claims as specified; no half-published thread is queryable.

### Milestone 4 — SDK, CLI, and documentation

Add the full typed SDK area and CLI subtree, human/JSON output, documented alias/search language, guide template plus generator output, the separately hand-authored built-in bb-cli skill, and sync receipts.

Proof: SDK transport tests, CLI snapshots/output tests, guide/skill sync checks.

### Milestone 5 — App continuation surface

Add the sidebar entry and a dedicated Continue command registered in `APP_COMMAND_IDS` and `APP_COMMAND_GROUPS`; its handler opens the exact same route/surface as the sidebar action. Add project-and-host-scoped queries, nonterminal-operation discovery without a URL operation ID, one-surface candidate/inspector/consent/recovery UI, responsive drawer, mapping setup/revalidation, direct navigation, cache ownership, and empty/error states. Use theme tokens and existing primitives.

Proof: RTL DOM+event tests for every public behavior listed below; app typecheck/build.

### Milestone 6 — Historical region and Thread Info provenance

Project import events through `@bb/thread-view` and server-contract timeline rows into an inert bounded region shared by server/app/CLI, and render durable provenance in Thread Info on all responsive clients. Extend domain scope/data closed graphs, `packages/db/src/data/events.ts`, `apps/server/src/internal/events.ts`, search-source kinds, and the single publication-time FTS owner.

Parse both import event types before the unhandled sink in `build-event-projection.ts`. Add first-class inert `EventProjectionMessage` kinds and corresponding `convertMessage` / `isEventProjectionCallMessage` handling; do not reuse user, assistant-text, or operation kinds. Add inert kinds/systemKinds to `timelineRowSchema` and exhaustively render them in `format-timeline-text.ts`, `timeline-row-title.ts`, `timeline-view.ts`, and `TimelineRowView` without edit, steer, retry, tool, task, or approval actions. Keep the new types out of `THREAD_TIMELINE_EXCLUDED_EVENT_TYPES`, `getLatestThreadOutputEventRow`, and `listStoredConversationOutlineEventRows`: they must be visible history without becoming live last-output or outline input. Extend `timeline-test-harness.ts` with factories for both events.

Proof: extend—not duplicate—the domain scope/stored/provider-event suites; DB events and thread-search suites; thread-view harness, timeline, parse, and CLI snapshot suites; server public-thread-data and timeline-delta suites; app `ThreadTimelineRows.actions.test.tsx` plus timeline fixtures; CLI thread-show fixtures/snapshots; and publication/first-send `withTestHarness` coverage. Prove inert rows have no actions, search deep-links use `searchMessageSeq`, imported FTS exists only under consent, and the first send uses the owned UUID with no `thread.start` and never the source UUID.

### Milestone 7 — Integration, safety matrix, and polish

Run fixture version/cwd/path matrices, required import-specific kill-point recovery, full targeted Turbo gates, root-owned affected-flow browser QA, accessibility review, and fit-and-finish. Representative iOS Simulator Safari drawer evidence is a done-condition. If the single permitted Chrome setup attempt fails, report that lane failure but do not mark acceptance item 12 or Milestone 7 complete. Address accepted reviews; delete superseded or temporary code.

Proof: evidence ledger in this plan and branch-ready local commits.

## Test Sketches Before Implementation

Tests use public setup/action/observable outcome. Keep setup in each test or a small `setup()` returning dependencies; avoid private-call assertions and mock-only oracles.

Before creating a harness, extend the existing `withTestHarness`, `registerHostRpcResponder`, `listQueuedThreadCommands` / `waitForQueuedCommand`, `createQueryClientTestHarness`, command-output harness, `PersistentResponsiveDrawerShell` tests, `ProjectListActionButtons` tests, `withWriteAfterFirstRead`, and integration recovery harness. New helpers must expose observables those owners cannot, not duplicate them.

### No-ship test-value rows

| Risk                      | Public surface                                                           | Why no-op/inversion/wrong identity fails                                                                  | Mock boundary                                            | Required Turbo proof                 |
| ------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------ |
| Source mutation           | Real Claude SDK utility lifecycle                                        | Source/subagent hashes change, owned equals source, or delete removes source                              | No mocks for session utilities; disposable storage only  | Claude provider plugin real-SDK test |
| Wrong first-send identity | Public thread send and queued host command                               | No `turn.submit`, any `thread.start`, or resume source/other UUID fails                                   | Stateful host responder; inspect queued command          | Server thread/public tests           |
| Duplicate fork            | Begin/lost-response/resume                                               | Stateful fake counts a second fresh fork or two owned/thread IDs                                          | Fake differentiates fork vs marker reconcile             | Server + file-backed recovery        |
| Consent leak              | Public list/inspect/start/resume/timeline/search/thread GET/plugin event | Stored false flips, preview-less content appears, or consent-off canary escapes                           | Provider supplies canaries; no UI-only oracle            | Server public + app query tests      |
| Abort/retention           | Public abort/abandon/archive/delete/project-delete/default re-import     | Source changes, repeated absence fails, offline abandon asserts deletion, or claim opens a missing thread | Real SDK for prepublish delete; server lifecycle harness | Provider + server lifecycle tests    |
| Protocol skew             | Host session open and command parsing                                    | Constant remains 130 or fixtures omit a new command                                                       | None; strict contract schema                             | Host-daemon-contract tests           |

### Pure/domain

1. Parse every operation stage and reject impossible published/reclaimed/aborted/abandoned shapes.
2. Given a current stage and requested transition, accept only the documented state graph and return an explicit conflict for stale CAS input.
3. Given minimal SDK metadata and BB environment facts, classify Ready/already-imported/offline/mapping-needed/unsupported deterministically without transcript text.
4. Normalize message fixtures into allowed user/assistant/system text and exact omission flags; tool/reasoning/attachment records cannot become live BB events.

### DB/server integration

1. Begin twice with one idempotency key; observe one operation.
2. Begin two default imports for one source concurrently; observe one canonical claim and an open-existing result.
3. Begin an explicit new copy; observe a second operation ID, a second `forkSession` call producing a distinct owned UUID, null canonical claim, and unique-index success. UI/CLI copy says it creates another Claude session. Reusing an owned UUID or skipping prepare fails.
4. Persist the pre-fork snapshot and `preparing`, simulate lost response, reconcile the operation marker, resume; observe one provider fork and one thread. In a second case inject a new marker-less `{uuid}.jsonl` in the source lookup-scope project directory after prepare begins, lose the response, and resume: fork count remains 1 and public state becomes `needs_attention/ambiguous_fork`; incomplete/timed-out listing behaves the same.
5. With the import-specific file-backed server harness (`initDb(tempFile)` and `crashServer`/`restartServer`, or a named real process-kill `tests/qa` surface), stop/recreate the server and DB owner after `reserved`, `preparing`, and `provider_prepared`; fresh-process GET exposes the identical pre-publication phase, zero new provider-fork calls, and no thread. Only explicit resume may mutate and must converge to exactly one owned UUID/thread. Separately, `crashDaemon`/`startDaemon()` proves host-offline/lost-RPC recovery only.
6. Commit with history off; observe idle thread + identity + boundary/provenance only and no imported FTS canary.
7. Commit with history on using a source preview and owned-fork page that deliberately differ in IDs, order, omission flags, and canary text; observe that only the owned page becomes ordered imported events and `imported_message` FTS, with every import event's stored provider identity null. The host fake fails if commit pages the source UUID or reuses inspector-preview bytes.
8. Fail publication transaction mid-write; observe no thread/events/search and operation remains recoverable with known fork.
9. Abort from `reserved`, `preparing`, `provider_prepared`, and `needs_attention`; `preparing` reconciles first. Abort twice and abort after the fork was independently removed; proven absence/not-found is success, source remains unchanged, claim releases, and only contradictory presence remains needs-attention. Mutate the owned fixture's title/revision or append user/assistant content after prepare, then abort: source and owned hashes stay unchanged, public state becomes `needs_attention` with `owned_changed`/`owned_externally_written`, and BB explains it refused deletion while retaining the claim. While the host is still online, invoke Release claim without deleting copy: no delete call occurs, the row becomes abandoned, default re-import of the original source succeeds, and the mutated fork remains hash-identical and listable as a normal candidate/named orphan. Repeat release from an offline pre-publish state with the same no-cleanup disclosure.
10. After a history-on publish, use `withTestHarness` and queued-command observables: one ordinary send produces exactly one `turn.submit` whose `resumeContext.providerThreadId` is owned and whose `resumeContext.workspaceContext.path` equals the snapshotted exact source/target canonical cwd, zero `thread.start`, `getLastProviderThreadId` remains owned, and source is never targeted. Commit refuses when the environment path drifted after reserve.
11. Archive through `archiveThreadWithLifecycleEffects` and environment/child cascades retains provenance and canonical claim, opens/unarchives the live archived thread, and forwards only owned UUID. Public idle-thread DELETE performs `markThreadDeleted` plus synchronous hard finalization; before `deleteThread`, its shared DB write releases the claim, marks the import reclaimed, preserves both Claude sessions, and leaves a dangling logical `thread_id`. Public DELETE and project deletion through both `beginProjectDeletion` and `advanceProjectDeletion` each permit a later default re-import. Post-publish abort/abandon reject unchanged state.
12. Resume/retry with consent true against an operation stored false leaves consent false. Omitting `includeReadableHistory` on public start persists false, creates no imported-message events/FTS, and exposes no preview/canary text. Consent-off public timeline/search/thread GET and plugin `thread.created` expose no imported text; the plugin event fires once after commit without bodies. Consent-on public GETs show ordered projection. Host A endpoints reject host B's session ID. Inspect without preview consent returns no message text.
13. Prepare stores an owned revision tuple. Mutation immediately before history paging and mutation after paging but before publication each return typed `owned_changed` without publishing; deletion returns `owned_missing`. An unchanged owned fork publishes.
14. A consent-on owned chain beyond 2,000 messages, 8,388,608 normalized UTF-8 bytes, 262,144 bytes for one message, or 1,048,576 serialized bytes for one host page never exceeds the public bounds. It persists only complete chronological messages under every cap, advances explicit pagination correctly when a page/message is omitted or byte-shortened, records `history_projection_truncated_at_limit`, exact projected counts/bytes and an observed-source lower bound, and exposes the omission in provenance/UI.
15. With a `provider_prepared` import, delete the target project/environment/host through each owning path. No FK cascade or failure removes the operation row; the same lifecycle transaction releases the claim and aborts safely or marks `abandoned` with orphan disclosure; later default import succeeds. A published tombstone remains readable by operation ID after thread delete and environment prune. Failure injection never exposes `deletedAt` with the canonical claim still set. `wouldCleanupEnvironment` reports the nonterminal import as a live pin until abandonment.

### Provider/host integration

1. Candidate list default response contains no first prompt, summary, or message text.
2. Host-wide catalog calls `listSessions` with `dir` omitted, includes safe candidates across projects, omits sidechains and only live-claimed markers, strips content, and paginates stably. Inspect/preview, snapshot/prepare, messages, abort, and delete all pass exact `dir: sourceCwd` and never the maintenance workspace. The distinct reconciliation scan uses `includeProgrammatic: true`, exhausts offsets through a short page, sees a catalog-hidden exact `customTitle` marker, and returns the one existing fork after a simulated lost response.
3. Inspect stale revision returns source-changed before mutation; a revision change during fork deletes and verifies the prepared copy before returning the error.
4. In a named default-config plugin-package test with a disposable `CLAUDE_CONFIG_DIR` and no mocked session utilities—including `getSessionMessages`—prepare creates a new UUID, real source/owned message reads show non-empty supported text continuity and remapped IDs, source/subagent hashes remain unchanged, no live bridge `ThreadSession` exists for owned, undo/file history is absent and disclosed, and real abort deletes only an unchanged owned fork. A second case mutates the owned fixture after prepare and proves abort preserves both source and owned hashes and returns public `needs_attention`.
5. Same operation marker called twice returns same UUID.
6. Marker collision/ambiguous results returns needs-attention and never calls fork again.
7. Message pagination from the explicit-dir owned fork preserves chain order, enforces the pinned page/message/byte limits, and labels omissions/truncation.
8. Abort refuses source UUID and wrong marker, then removes the verified owned fork; a repeat abort and already-missing owned fork succeed, while contradictory post-delete presence fails closed.
9. Offline host, protocol mismatch, unsupported bridge, unreadable/newer fixture, deleted cwd, symlink, and different worktree return typed states.
10. Host contract pins the incremented protocol with an import-RPC comment and strict result fixtures cover every new command; an older bridge returns typed unsupported.
11. Public inspect with preview makes zero fork/prepare/delete calls, leaves source JSONL/sidecar hashes and disposable-store session count unchanged, and persists no preview bytes on any operation row.

### SDK/CLI

1. SDK list/inspect/start/status/resume/abort/abandon requires project/host scope, serializes exact public payloads and pinned history-limit metadata, and parses typed results.
2. CLI human list resolves/requires `--project`, groups Ready and exceptions with machine identity, and emits stable JSON fields.
3. CLI default start against already imported source prints/returns existing thread; `--new-copy` creates an explicit new operation.
4. `--include-readable-history` is the only CLI route that sets consent true.

### React DOM+events

1. Entry beside New thread opens by click and keyboard; search/mobile visibility is explicit. A Continue command exists in `APP_COMMAND_IDS`/`APP_COMMAND_GROUPS`, and invoking its handler opens the same route as the sidebar action.
2. Two hosts render names/readiness inside the selected project; offline remains visible; choosing host B issues only project+host-B active results and late host-A response is ignored.
3. Ready and every named exception render at rest; full catalog/search remain reachable.
4. Candidate activation updates an accessible inspector without losing focus when rows paginate/unmount.
5. History defaults off even when the start field is omitted; no preview request/canary appears. Toggle on shows a disclosure-bound source preview and notes the committed owned-chain projection may differ; toggle off clears it. Cancel before start makes no mutation; cancel after start calls abort or consequence-labeled release when cleanup is refused.
6. Commit payload includes exact persisted consent/mapping/source revision; duplicate response shows Open existing.
7. Remount with operation ID restores phase/error; Resume reuses ID. A second mount with no operation ID lists project/host nonterminal operations and still renders Resume/Needs attention. Success navigates once to the returned idle thread despite compose preference.
8. Published provenance makes Thread Info non-empty; historical region is labeled and has no live tool/task/approval controls.
9. Compact drawer has correct label, focus containment/restore, Escape/backdrop behavior, retained realization, and no app-root inert/aria-hidden regression.
10. Reduced-motion state adds no custom transition; phase live region announces meaningful changes once.
11. Start with Mapping needed and no matching ready environment. Invoke the existing setup action while preserving list/search/selection; once a ready environment whose canonical path exactly equals the source lookup-scope cwd exists, revalidation makes that same candidate Ready and permits commit. Sibling, relocated, symlink-only, and same-worktree-different-path environments remain Mapping needed.
12. A failed first `turn.submit` leaves the exact composer draft present and editable.
13. Explicit **Create another copy** copy clearly says another Claude session will be created; the action result carries a distinct operation/owned UUID and does not replace the open-existing primary path.

### Browser QA

Use `state-based-browser-qa` after implementation. Exercise desktop and compact flows from entry through publish, offline/reconnect, duplicate/open-existing, consent off/on, history boundary, Thread Info, first message, focus transfer/return, long paths/errors, zoom/reflow, reduced motion, and representative iOS Simulator Safari drawer behavior. Root owns final verification.

## Concrete Implementation Areas

Expected touched areas; exact file splits should follow existing module boundaries rather than accumulating one coordinator:

- `packages/domain/src/provider-event.ts`, `thread-events.ts`, `thread-event-scope.ts`, `thread-search.ts`, `thread.ts`, plus new focused import domain file.
- `packages/db/src/schema.ts`, `packages/db/src/data/events.ts`, a new `packages/db/src/data/provider-imports.ts`, exports/tests, and generated `packages/db/drizzle/*` migration artifacts.
- `packages/provider-bridge-protocol/src/requests.ts`, handshake/capability/bridge-kit exports/tests.
- `plugins/provider-claude-code/src/bridge/bridge.ts` plus a focused session-import module and bridge tests.
- `packages/agent-runtime/src/provider-adapter.ts`, `bridge-protocol-adapter.ts`, `runtime.ts`, `types.ts`, focused tests.
- `packages/host-daemon-contract/src/commands.ts`, `protocol.ts`, contract tests; `apps/host-daemon` dispatch/handlers/tests.
- `packages/thread-view` for inert boundary/imported-message rows; `packages/server-contract/src/api`, timeline row contracts, and `public-api.ts`; `apps/server/src/internal/events.ts`, routes, and a focused `services/provider-imports` module with public integration tests.
- `packages/sdk/src` and `apps/cli/src/commands/thread` plus their public tests.
- `apps/app/src/components/sidebar/ProjectList.tsx`, a focused `components/provider-imports/claude-code` feature area, query/mutation/cache owners, routing, inert timeline-row rendering, and `ThreadMetadataContent.tsx`.
- guide/skill/docs files required by root repository policy.

Avoid compatibility shims, hidden generic escape hatches, direct provider file access outside the provider plugin, direct plugin writes to core DB, and duplicated state machines across UI/server/provider. Keep state policy in one domain module and expose plain typed values at boundaries.

## Validation and Acceptance

Run the smallest targeted tests during each milestone, then Turbo orchestration for all affected packages. Representative final commands (adjust filters to actual package names):

    pnpm exec turbo run typecheck --filter=@bb/domain --filter=@bb/db --filter=@bb/provider-bridge-protocol --filter=@bb/agent-runtime --filter=@bb/host-daemon-contract --filter=@bb/host-daemon --filter=@bb/thread-view --filter=@bb/server-contract --filter=@bb/server --filter=@bb/sdk --filter=@bb/cli --filter=@bb/app --filter=@bb/integration-tests --filter=bb-plugin-provider-claude-code

    pnpm exec turbo run test --filter=@bb/domain --filter=@bb/db --filter=@bb/provider-bridge-protocol --filter=@bb/agent-runtime --filter=@bb/host-daemon-contract --filter=@bb/host-daemon --filter=@bb/thread-view --filter=@bb/server-contract --filter=@bb/server --filter=@bb/sdk --filter=@bb/cli --filter=@bb/app --filter=@bb/integration-tests --filter=bb-plugin-provider-claude-code --force --output-logs=new-only

    pnpm exec turbo run build --filter=@bb/app --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/cli

Also run repository lint/format gates required by touched packages and real/disposable integration probes where credentials/runtime permit. Never point destructive tests at the user's real `~/.claude` data; copy fixtures to a temporary config/project root and record source hashes before/after.

Acceptance requires observable proof of:

1. source session JSONL and every subagent/file-history sidecar unchanged under the default real-SDK plugin test;
2. selected-project-and-host-only discovery/mutation and explicit offline behavior;
3. exact safe cwd/worktree mapping;
4. passing supported SDK/CLI fixture matrix through the default plugin Vitest/Turbo target;
5. one fork/thread per idempotent operation and canonical source claim;
6. file-backed server-process restart/kill convergence without GET-side mutation or blind duplicate fork;
7. consent-gated timeline/search/remote exposure;
8. inert history with named omissions and current runtime reset;
9. first new message resumes the owned UUID;
10. accurate repeat-safe abort, explicit offline abandon, archive, synchronous delete/project-delete, and claim-retention semantics;
11. durable provenance after reload and upgrade migration;
12. desktop/compact/mobile accessibility and focus behavior, including representative iOS Simulator Safari drawer evidence and a successful root-owned affected-flow browser lane.
13. the command-palette Continue command opens the same product route as the sidebar action;
14. exact canonical source/target cwd persists through commit and first-send workspace context;
15. explicit new-copy creates a second Claude fork and says so before mutation.

No-ship conditions: direct source adoption; hidden history indexing; fabricated live history; a generic provider ID binding endpoint; unbounded results; protocol change without version bump; a path that publishes before provider identity/history decision is committed; publication after the owned revision changes or disappears; deletion of an externally changed owned fork; a retry path that can fork twice, including marker-less lost-response ambiguity; in-memory-only or daemon-only server-restart proof; target-owner cascade loss or stranded claim; first-send path drift; fake new-copy without a second fork; missing command-palette surface; history omission that can default true; preview mutation/persistence; an empty/wrong-source owned session that passes source-safety; incomplete/default-skipped source-safety or first-send proof; missing iOS Simulator evidence; failed Chrome setup or incomplete browser acceptance.

## Idempotence and Recovery for Development

- All automated provider tests use fresh temporary fixture roots and explicit resolved paths.
- Generated Drizzle migrations are created with the repository generator; never hand-edit snapshot JSON.
- Re-running a failed implementation milestone should not require deleting user data. Test DBs and fixture roots are disposable.
- If a development import creates a prepared fixture fork, record its operation marker and use the tested abort path; never delete by a source session ID.
- Local commits are allowed by workflow-cycle. Push, PR creation, merge, and deployment are not authorized.
- If browser setup fails at the first Chrome creation/listing/window target step, stop that browser lane per repository policy, report the exact failure, and leave Milestone 7 plus acceptance item 12 incomplete.

## Artifacts and Notes

- Canonical design recommendation: [`product-design.md`](product-design.md)
- Technical synthesis: [`technical-research.md`](technical-research.md)
- Unknowns pass: [`unknowns.md`](unknowns.md)
- Plan 0 and query list: [`plan-zero.md`](plan-zero.md)
- This ExecPlan: [`exec-plan.md`](exec-plan.md)
- Claude Agent SDK primary evidence: official Agent SDK TypeScript/session/session-storage documentation plus the published 0.3.197 declarations and bundle.
- Codex comparison evidence: current `openai/codex` main at `f97e77569352a2bf5be9955e623edad0a15d9b93` and stable `rust-v0.147.0`; reuse its bounded discovery/root validation/ledger discipline, reject its lossy conversion/synthetic events/suffix synchronization.

Stage 3 adversary budget: **3/5 completed; pass 4 interrupted before verdict and does not count**.

## Plan change note

Initial draft written 2026-08-17 after local exploration. It selects a core-owned durable saga, additive provider session operations, operation-marked native forks, consent-gated projection, existing-ready exact workspace mapping, atomic publication, and a Claude-specific single-session UI. Primary research then hardened exact-cwd behavior for pinned CLI 2.1.197, bounded post-compaction history fidelity, deletion verification, pinned-runtime ownership, and before/after source revision checks. Omega hardening run `wf_09a494ba829d` integrated 16 amendments; discovery run `wf_4550eda8d12d` integrated two; adversarial pass 1 `wf_901de924b84a` integrated ten; adversarial pass 2 `wf_2b7f9420b47d` integrated six; adversarial pass 3 `wf_f4e0e62a2847` integrated nine. Pass 4 `wf_af9514674137` was interrupted before verdict and is recorded only as a parked receipt. A fresh adversarial pass is required before implementation.

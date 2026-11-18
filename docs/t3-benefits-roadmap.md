# BB improvement roadmap: capture the T3 benefits that matter to Daniel

**Assessment date: November 17, 2026, Pacific.** Recommendations based on source inspection, repository history, and recorded verification. No application source, services, settings, credentials, schedules, or deployments were changed. No new runtime benchmark or failure-injection test was run.

## Recommendation

Keep BB's central fleet, provider bridges, Crew, account policy, workflow engine, and semantic attention system. Concentrate the next work on four improvements:

1. Verify and activate the already-written large-history performance fixes when appropriate.
2. Integrate the upstream BB dispatch/reconnect/stop fixes that the maintained fork does not yet contain.
3. Give the existing composer customizations narrow native layout surfaces, then delete their equivalent DOM workarounds.
4. Let workflow producers expose their own activity facts so the sidebar stops interpreting their private databases.

These are my engineering priorities for Daniel's observed system, not a measured ranking of BB versus T3 performance. They capture much of the practical value behind a more integrated coding product: responsiveness during heavy work, trustworthy execution status, a coherent composer, and fewer components that must change together.

Turn-level file restoration is a separate optional feature. A wholesale execution-engine rewrite is not justified by the inspected evidence.

## Baseline and confidence

| Item | Inspected baseline |
| --- | --- |
| Maintained BB fork | `Danielalnajjar/bb`, `local/0.49.0-a8823008`, `5b2ed0313b0bbf2183137c6bd838f744800ae56d`; remote branch head rechecked for this assessment |
| T3 comparison | Stable v0.1.10, `7d32075e3757ded707914e2450c3e392a9665765`; latest-release endpoint rechecked |
| Skills/plugins | `Danielalnajjar/skills` at `660162f7531092825c734bb4921576973242b864` |
| Environment configuration | `bf930550e69155589617e04fc055d78aa5929786` |
| Workflow-orchestrator | `97d6f0bc4c08ee5319f4e979a397ae181ad51b92` |
| Relevant newer upstream fix | BB PR #7542, merged as `1fa400dec7866721d1e60c3f3b480df8b1c42c5f` |

The fork's default main is stale. The recommendations use the maintained branch above. Repository inclusion does not establish what binary is serving today. The records distinguish the earlier deployed build from later staged changes; the exact current payload, experiment flags, enabled plugins, and live behavior remain implementation-time checks. [B0] [P1] [P2]

### What is already present

BB already has an atomic accepted-send/queue transaction, durable queue recovery, daemon reconnect reconciliation, selective thread subscriptions, bounded server timeline views, delta/tag handling, and shared client/view code. T3's atomic command/event/projection/effect boundary is a useful design reference, but it does not prove those BB mechanisms are absent or broken. [B1] [B2] [B3] [B4] [T1]

| Desired benefit | Most direct BB action | Confidence / scope |
| --- | --- | --- |
| Keep controls responsive while opening long captains or searching history | Validate and activate fork PR #3; measure any remaining timeline hotspot | High confidence in existing patch and recorded evidence; present deployment unknown |
| Correct behavior across disconnects, queue holds, and Stop | Integrate upstream #7542 through an appropriate base update | High confidence in upstream diagnosis; assembled-fork acceptance remains |
| Composer feels integrated and survives upgrades | Native task-panel collapse and an inline status slot | Concrete missing ownership surfaces; current failure frequency not measured |
| Sidebar, Crew, and Hark share trustworthy activity facts | Producer-owned continuation query using existing RPCs | Concrete private-schema coupling; not a claim of a current status defect |
| Undo a bad coding attempt including its files | Optional isolated-worktree checkpoint restoration | Candidate feature; BB edit flow retains files, but exhaustive feature absence not established |
| Receive all future T3 improvements automatically | No local patch can supply this | Continuing upstream maintenance capacity is a separate advantage |

## 1. Put the existing performance work into service

### Why it ranks first

The performance fix with the clearest evidence is already written. Fork PR #3 moves expensive conversation-outline and exact-search work into a read-only SQLite worker, preserving the algorithms and response semantics. Its recorded experiments separate main-loop responsiveness from query completion time. [P1]

The PR reports broad-search median server event-loop gaps falling from approximately **886.7 ms to 2.7 ms** on a protected large-database copy. It also reports equivalent response bodies across the tested routes. These are the PR author's results, not a benchmark repeated in this assessment and not a BB-versus-T3 measurement. Some cold outline reads can take longer to finish while the application remains more responsive. [P1]

The November 15 backup receipt records about 37 GB of logical data, including a 33 GB BB database and 20 plugin databases. This is dated scale evidence, not a fresh measurement. Long captains, nested children, simultaneous search, and live updates matter more than an empty-database demo. [E1]

### Smallest complete action

First identify the serving build. If PR #3 is already serving, validate that baseline; do not reinstall based on stale staging documentation. If it remains staged, activate the reviewed build through the existing rollout process, preserving the known data/schema and worker packaging assumptions.

Then measure the existing selective timeline path. BB already tracks watched threads, bounded windows, cache tags, deltas, and stale-baseline refetch. The app path is gated by `config.experiments.timelinePush`; the live setting was not inspected. Compare its behavior on the clients actually used before choosing an experiment setting or changing invalidation policy. [B3] [B4]

There is one concrete follow-on candidate: timeline window cache misses still call `buildThreadTimelineWithProfile` synchronously on the server thread. If it remains a material bottleneck after the existing fix, put that bounded projection computation into the same `ThreadReader`. Keep validation, display policy, subscriptions, baseline/delta coordination, and publication on the server. Reuse the current builder. [B3] [B5]

### Existing owners

- `apps/server/src/services/threads/thread-reads.ts`
- `apps/server/src/services/threads/thread-read-worker.ts`
- `apps/server/src/services/threads/thread-timeline-windows.ts`
- `apps/server/src/routes/threads/data.ts`
- Existing timeline push/cache owners in the app

### Definition of done

A representative long captain can open or search while ordinary control requests and other active threads remain responsive. Cold completion time, control latency, event-loop delay, read-worker queue wait, and memory are measured separately. Outline/search results stay equivalent, and timeline views converge after missed deltas, reconnects, appends, and same-head rewrites.

Use the existing read/timeline tests. Add coverage only for a new failure introduced by the chosen change. An isolated database copy must not become a second live automation server.

Fork PR #4 is a separate already-written operational fix: it separates the trusted Connect cloud origin from a daemon's direct transport URL. Preserve and validate it on hosts using direct routes. Its live expose/share behavior is still a rollout check; it is not the main performance project. [P2]

**Expected scope:** primarily rollout and measurement first; additional source work only for a measured remaining cost.

## 2. Adopt the existing upstream reliability fixes

### Concrete improvement available now

BB upstream PR #7542 merged on November 17, 2026. It is absent from the maintained fork revision. Upstream reproduced and fixed these sequences with real Codex/Claude daemons and a connection-fault proxy: [P3]

| Failure | Result of the upstream correction |
| --- | --- |
| Daemon receives a command but its reply is lost on disconnect | The server treats delivery as unconfirmed and reconciles it instead of immediately declaring refusal |
| Stop is lost during disconnect | Reconnect resends the pending stop |
| A delayed stop reaches a different, later turn | Stop is aimed at the original turn/request identity, preserving unrelated later work |
| A plugin holds the first claimed queue row | Another eligible message can continue through the drain |
| One plugin's pacing suppresses another plugin's recheck | Recheck pacing accounts for both thread and plugin |

This directly serves Daniel's remote hosts and plugin-controlled queues. It is a concrete way to improve the execution consistency that made T3's orchestration attractive.

### Integration scope

Move the maintained fork onto a reviewed upstream base or release containing the full fix and its dependencies, while retaining and reassessing the useful local patches. A carefully reviewed backport is another option, but this is not an isolated one-file cherry-pick.

The maintained fork uses daemon protocol **264**. PR #7542 changes its upstream parent from **265 to 266**. The intervening changes and matching server/daemon rollout must be handled together. The PR states that the provider bridge protocol and plugin APIs are unchanged; that does not make the daemon wire change backward compatible. [B6] [P3]

Reuse its `send-queue-interleavings` suite and selected real-daemon scenarios with the assembled fork and Daniel's queue hooks. Upstream reports 14 scenarios and live fault injection; those checks were not rerun here.

### Definition of done

Delivered-but-unacknowledged work is not falsely shown as definitively refused. Work that never reached a daemon settles when reconciliation establishes that fact. Stop does not kill an unrelated later turn. No running daemon turn is presented as idle. Eligible messages progress even when another plugin holds a row.

### Borrow T3's durability discipline at specific boundaries

After the upstream integration, extend the existing failure harness at two precise boundaries:

1. **Event commit followed by lost HTTP response.** Commit a daemon event batch, suppress its acknowledgment, then let the sink retry. Inspect partial text, persisted events, final text, and completion multiplicity. Current final snapshots can correct duplicated streaming text, so permanent corruption must not be assumed. If the desired behavior fails, put stable delivery identity and transactional deduplication in the existing sink/contract/append owners. Do not deduplicate by event text; identical text can be legitimate. [D1]
2. **Child completion followed by process death before its parent notice is materialized.** Restart on the same data and require the waiting parent to receive one eligible result. Also test death after the notice queue row exists but before its wake-up; current durable queue recovery should already handle that second case. If the first case fails, persist narrowly scoped completion/notification intent under the existing owner. [D2]

These are source-supported test candidates, not reproduced defects. There is no basis here for adding an outbox everywhere or replacing BB's provider/runtime architecture. T3 itself distinguishes replay-safe effects from effects tied to a lost provider process; durable intent does not make arbitrary external actions exactly once. [T1] [T2]

**Expected scope:** meaningful upstream integration and compatibility testing, followed by two focused failure tests; further production changes are conditional.

## 3. Make the useful composer behavior native at its existing owners

### The problem to remove

The plugins provide useful behavior but sometimes have to inspect or reposition BB's DOM to obtain it:

- `composer-panels` finds the banner stack, counts visible nonempty task panels, and injects Hide/Show controls with an observer. Its README documents why the existing context-segment slot cannot preserve cross-panel collapse or protect core prompts. [S1]
- `claude-cache-ttl` locates the footer and context-window button to place its chip. A full-width context segment was tried and reverted because it was too intrusive. The useful backend and the brittle placement are separate concerns. [S2]
- The current composer contract supports actions, banners, menus, and popups, but the inspected declaration does not provide that narrow inline footer position. BB already owns the banner renderer and footer. [B7]

This is evidence of maintenance cost, not a claim that the UI is currently broken.

### Smallest complete changes

**First patch: host-owned task-panel collapse.** Extend the existing banner renderer so the host owns task-panel grouping, nonempty counts, persistence, and show/hide. Navigation and core questions, approvals, and queued messages retain their current visibility. Reuse the existing preference and preserve state inside hidden panels.

**Second patch: inline composer status contribution.** Provide a narrow host-rendered status location beside the existing footer controls. Mount the existing TTL content there. Keep transcript access, cache interpretation, host ownership, and account policy in their current plugins.

After visual and interaction parity is verified, delete the equivalent DOM observer, anchor lookup, portal placement, and CSS compensation. Leaving both paths active would preserve the maintenance burden.

BB also exposes a whole-composer replacement, but that contract leaves banners, approvals, and queued-message cards with the host. It does not solve cross-banner collapse, and replacing the entire composer merely to place the TTL chip would be disproportionate. [B9]

Sidebar minimum width and phone safe-area behavior can be separate later changes in their existing layout owners. The recorded Compact Chrome width and cross-plugin overlay fixes show the same responsibility split, but they should not expand the first composer patch. [S3]

### Existing owners and compatibility

Use `PluginComposerBanners.tsx`, `FollowUpPromptBox.tsx`, and the existing composer SDK declarations. Follow BB's current extension rules for any public experimental surface; core and plugins should use the same path. Preserve provider logic and semantic sidebar/Crew behavior as plugins.

There is already a positive precedent: skills PR #846 adopted native timestamp/action surfaces and deleted timestamp recovery/cache code and duplicate invalidation. Continue that approach where the host now supplies the right outcome. [S4]

### Definition of done

On desktop, a narrow split pane, and the actual phone layout, collapsing task panels never hides a pending question, approval, queued message, or navigation control. Empty panels are not counted; hide/show does not reset plugin work. The TTL chip retains its existing meaning and unobtrusive placement. Queue, steer, keyboard focus, overlays, and reconnect still behave correctly. The replaced workaround is removed.

**Expected scope:** two bounded UI/API patches, with real device/layout verification. No new service or persistent execution state.

## 4. Put workflow activity facts behind their producer's API

### What is already good

The semantic sidebar already supplies a shared attention projection to Crew and Hark. It distinguishes working, waiting, needs-you, stuck, uncertain, and result-ready. A new global status service would duplicate that owner. [S5]

### Remaining coupling

The sidebar's `cycle-continuations.ts` still opens the sibling workflow-orchestrator database, knows table names and the cycle-state v8 format, reconstructs private chain identity, probes its host, and rereads rows to reject a stale observation. Its native Workflows reader also opens a sibling database. [S6] [S8]

Meanwhile workflow-orchestrator already owns the chain store, chain service, state migrations, host process operations, and `readThreadRun`/`listRunProgress` RPCs. [W1]

### Smallest complete change

Extend that existing producer RPC surface with the narrow read-only continuation facts needed by the sidebar. Move version/identity validation, process observation, and observation-freshness checks into the workflow owner. The sidebar consumes the result and deletes its private SQL and state-format interpretation.

Use existing run-state events and reconnect refresh where authoritative. Retain bounded host observation where process liveness cannot be established by an event. Return unavailable/unknown explicitly; a lost host read does not mean work finished.

Keep the existing responsibility split:

| Responsibility | Owner |
| --- | --- |
| Provider request/run lifecycle | BB core |
| Chain execution and stage/receipt validity | Workflow-orchestrator |
| Card obligations and retirement | Crew |
| What Daniel should attend to | Semantic sidebar |
| Phone notification delivery/acknowledgment | Hark |

One shared fact source does not collapse these meanings into one “done” field.

This pattern has already worked in the stack. PR #1432 moved Omega activity discovery out of the sidebar's server-home scanner and into Omega's execution-host owner, removing a server-move failure and duplicate interpretation. That work is already done; apply the same principle to the remaining cycle boundary. [S7]

### Definition of done

A running cycle, completed cycle, hidden child, and unreadable host produce consistent execution facts for sidebar, Crew, and Hark. Healthy completed work clears while another host is unavailable. A workflow storage-format change no longer requires a sidebar SQL-reader change. Existing receipt and retirement gates remain authoritative.

**Expected scope:** one producer/consumer integration; native Workflows origin reads can follow as a separate bounded change. No new database, scheduler, or universal execution graph.

## Optional: checkpoint-based file restoration

T3's stable editing flow can rewind a conversation while either keeping files or restoring the pre-message workspace checkpoint. File restoration is worktree-only and refused for overlapping sessions. Its turn diff also separates the turn's own edits from changes merely brought in by pull, merge, or rebase. [T3] [T4]

BB's inspected edit-message contract explicitly keeps workspace changes while replacing conversation history. This establishes a difference in that flow; it does not prove that no BB extension offers any other restore mechanism. [B8]

If Daniel frequently wants to undo a bad coding attempt, this is the most concrete additional T3-style feature to evaluate. Inspect the existing Git/environment surfaces first. Reuse their owners for turn-scoped review and optional restore; keep the current conversation-only behavior as the normal option.

A valid design must preserve preexisting dirty/untracked state, show that file restore can undo human edits too, refuse shared or overlapping checkouts and other active writers, and coordinate provider rewind with filesystem changes. Durable external workflows must be included in the workspace-ownership check. External API calls and deployments are outside a Git checkpoint.

Prioritize the four changes above for standing captains and fleet work. Treat checkpoint restoration as its own feature with explicit user value, storage/retention decisions, and failure handling.

## Maintenance strategy and implementation order

The largest continuing T3 benefit that cannot be copied by a patch is its upstream team's ongoing work. BB changes can reduce Daniel's private maintenance burden; they cannot make future T3 integrations arrive automatically.

Keep generic performance, recovery, and UI ownership improvements close to upstream. Keep Daniel-specific Crew, routing, account, Hark, and workflow policy in plugins. During upgrades, remove an old workaround when the new native behavior has been verified to replace it. The existing native-slot adoption commits show this is practical. [S4]

Recommended delivery sequence:

1. **Establish and validate the serving baseline.** PR #3 performance and PR #4 route-origin behavior are already written; determine what is active and complete the relevant rollout.
2. **Integrate #7542 and dependencies.** Preserve useful fork deltas; coordinate server/daemon compatibility; run the selected interleaving checks.
3. **Land the two composer ownership changes separately.** Verify real layouts and delete superseded patches.
4. **Replace the cycle private-database reader with producer facts.** Keep shared attention policy where it already lives.
5. **Act on measured or reproduced gaps only.** Timeline-worker extension, event-ACK deduplication, and completion intent depend on their specific measurements/tests.
6. **Evaluate file restoration separately.** Implement only if the editing benefit warrants the storage and workspace-ownership work.

These are priorities and acceptance criteria, not calendar estimates. Scope depends on the selected upstream base, currently serving payloads, and any remaining conflicts or gaps found at the named boundaries.

## Sources

[B0]: https://github.com/Danielalnajjar/bb/tree/5b2ed0313b0bbf2183137c6bd838f744800ae56d
[P1]: https://github.com/Danielalnajjar/bb/pull/3
[P2]: https://github.com/Danielalnajjar/bb/pull/4
[P3]: https://github.com/get-bb/bb/pull/7542
[B1]: https://github.com/Danielalnajjar/bb/blob/5b2ed0313b0bbf2183137c6bd838f744800ae56d/apps/server/src/services/threads/thread-send.ts#L414-L485
[B2]: https://github.com/Danielalnajjar/bb/blob/5b2ed0313b0bbf2183137c6bd838f744800ae56d/apps/server/src/services/system/periodic-sweeps.ts#L612-L710
[B3]: https://github.com/Danielalnajjar/bb/blob/5b2ed0313b0bbf2183137c6bd838f744800ae56d/apps/server/src/services/threads/thread-timeline-windows.ts#L130-L199
[B4]: https://github.com/Danielalnajjar/bb/blob/5b2ed0313b0bbf2183137c6bd838f744800ae56d/apps/app/src/hooks/cache-owners/thread-timeline-push-owner.ts#L28-L141
[B5]: https://github.com/Danielalnajjar/bb/blob/5b2ed0313b0bbf2183137c6bd838f744800ae56d/apps/server/src/services/threads/thread-read-worker.ts
[B6]: https://github.com/Danielalnajjar/bb/blob/5b2ed0313b0bbf2183137c6bd838f744800ae56d/packages/host-daemon-contract/src/protocol.ts
[B7]: https://github.com/Danielalnajjar/bb/blob/5b2ed0313b0bbf2183137c6bd838f744800ae56d/packages/plugin-sdk/src/app-contract.ts#L4215-L4233
[B8]: https://github.com/Danielalnajjar/bb/blob/5b2ed0313b0bbf2183137c6bd838f744800ae56d/packages/templates/src/templates/bb-guide-threads.md#L172-L198
[B9]: https://github.com/Danielalnajjar/bb/blob/5b2ed0313b0bbf2183137c6bd838f744800ae56d/packages/plugin-sdk/src/app-contract.ts#L2784-L2807
[D1]: https://github.com/Danielalnajjar/bb/blob/5b2ed0313b0bbf2183137c6bd838f744800ae56d/apps/host-daemon/src/event-sink.ts#L243-L321
[D2]: https://github.com/Danielalnajjar/bb/blob/5b2ed0313b0bbf2183137c6bd838f744800ae56d/apps/server/src/internal/events.ts#L1233-L1292
[E1]: https://github.com/Danielalnajjar/environment-configuration/blob/bf930550e69155589617e04fc055d78aa5929786/docs/bb-server.md#L656-L665
[S1]: https://github.com/Danielalnajjar/skills/blob/660162f7531092825c734bb4921576973242b864/shared/plugins/composer-panels/README.md
[S2]: https://github.com/Danielalnajjar/skills/blob/660162f7531092825c734bb4921576973242b864/shared/plugins/claude-cache-ttl/README.md
[S3]: https://github.com/Danielalnajjar/skills/commit/d7babebe7f0bd14bab7dceb928f2f54dd4009c16
[S4]: https://github.com/Danielalnajjar/skills/commit/e7b254e59f210589da84dc962fdd7fd1d254ca59
[S5]: https://github.com/Danielalnajjar/skills/blob/660162f7531092825c734bb4921576973242b864/shared/plugins/t3-code-sidebar-v2/README.md#L144-L284
[S6]: https://github.com/Danielalnajjar/skills/blob/660162f7531092825c734bb4921576973242b864/shared/plugins/t3-code-sidebar-v2/src/cycle-continuations.ts#L1-L67
[S7]: https://github.com/Danielalnajjar/skills/commit/4601d22f74082ab80808641af076b3957cd31749
[S8]: https://github.com/Danielalnajjar/skills/blob/660162f7531092825c734bb4921576973242b864/shared/plugins/t3-code-sidebar-v2/src/workflow-origins.ts#L1-L97
[W1]: https://github.com/Danielalnajjar/workflow-orchestrator/blob/97d6f0bc4c08ee5319f4e979a397ae181ad51b92/integrations/bb-workflow-orchestrator/server.ts#L216-L269
[T1]: https://github.com/pingdotgg/t3code/blob/7d32075e3757ded707914e2450c3e392a9665765/apps/server/src/orchestration-v2/EventSink.ts#L763-L868
[T2]: https://github.com/pingdotgg/t3code/blob/7d32075e3757ded707914e2450c3e392a9665765/apps/server/src/orchestration-v2/EffectOutbox.ts#L142-L163
[T3]: https://github.com/pingdotgg/t3code/blob/7d32075e3757ded707914e2450c3e392a9665765/docs/user/composer.md#L171-L185
[T4]: https://github.com/pingdotgg/t3code/blob/7d32075e3757ded707914e2450c3e392a9665765/docs/user/source-control.md#L5-L16


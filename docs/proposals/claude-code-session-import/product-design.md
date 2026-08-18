# Placecard Design Room Recommendation

Run: `pcdt-20260818T012431Z-39434aa4`

## Controlling facts

- The durable v1 default creates a native Claude fork with a new BB-owned Claude session ID; the source Claude session is never mutated or relocated.
- Exact adoption of the source session ID is unsafe as a default: BB and another Claude client could both write, and no cross-client ownership lease exists.
- Native Claude continuation and BB-visible/searchable historical transcript are separate capabilities; neither measures the completeness of the other.
- Readable history in BB expands exposure through timelines, FTS, remote clients, and plugins, so it requires clear preview and explicit consent.
- Historical approvals, tasks, background processes, hooks, tools, and permissions are not live after import; the BB thread starts idle under current BB runtime policy.
- Provider discovery, inspection, and fork must run on the enrolled machine that owns the source session; users have multiple machines and disconnected hosts.
- Import is a recoverable cross-store saga; no thread may be published as successful before commit and verification, and retry must not create duplicate threads or forks.
- Source, destination, owning machine, project/worktree mapping, history scope, omissions, and provenance must remain inspectable; the first new message writes only to the BB-owned fork.
- The current public plugin API is insufficient; a first-party BB core import capability plus a Claude-aware adapter/plugin is expected.
- No BB screenshots, prototypes, runtime probes, latency data, or accessibility results were supplied, so pixel, density, placement, motion, and usability claims are unestablished.
- Unresolved on supplied evidence: late history staging after commit, complete history removal, off-host discovery caching, source divergence monitoring, authoritative reachability signals, and mobile import capability.
- Codex's importer performs a lossy conversion into a Codex thread; BB's native-continuation advantage must not be copied away.

## Recommended direction

Ship a Claude-first continuation experience, not a migration wizard. The product is an ordinary, idle BB thread that continues a Claude session through a BB-owned native fork, born honestly. Reach it from a labeled route beside new-thread creation plus command-palette access (contextual absence-triggered offers preserved as a tested alternative), on one compact surface — machine-explicit list plus contextual inspector plus a single terminal commit — never a sequential five-screen wizard. The opening frame leads with a deterministic "Ready to continue" set ranked by recency, followed by named exception groups derived only from authoritative stored state (already in BB, host unreachable, mapping needed, unsupported version), with the full machine-scoped catalog and scoped search one keystroke away as a labeled fallback; row state is visible at rest, never hidden behind a filter, and never inferred from transcript content. Every import continues natively; the only user choice is whether BB may display and search these messages, presented at the consolidated pre-commit review as a consequence-labeled control adjacent to a live preview, defaulting to no expansion of exposure and never framed as a completeness upgrade. The import is a durable, identified operation whose resume is idempotent and whose labels are bound to real saga transitions: pre-commit conditions resolve inline on the item with the correct primary action pre-selected (a duplicate resolves to "Open the existing thread", never an error); post-commit integrity problems become durable, addressed records findable after restart and from another client. On verification, open the idle thread with focus in the composer — no completion screen, no celebration, no synthetic percentage — with imported messages rendered as one bounded, unmistakably historical region whose tools, tasks, and approvals are inert records, and with always-inspectable provenance carrying source, destination, owning machine, mapping, included history, named omissions, and runtime reset. Provenance is static lineage, not live monitoring. Bulk is an accelerator over the same object model restricted to deterministically Ready items, not the v1 personality. The whole direction is explicitly conditional on the four-way first-screen prototype, the privacy ruling on pre-consent rendering, the core saga contract, and formal accessibility review.

## Decisions

### D01: Keep the candidate promise's factual boundaries but lead with the job: continue Claude Code work in BB, Claude keeps its context, the original stays untouched, and BB visibility is a separate consented choice. Use "Continue" as the in-product verb and keep "Import" as a first-class command synonym and saga name.

The v1 default moves nothing readable by default; a movement verb sets an expectation a continue-only thread cannot meet, creating pressure to make indexing mandatory to repair copy. Which emphasis to hero remains product-owner choice, so this fixes the factual clauses, not the emotional ranking.

**Contributors:** Kevin Twohy, Sara Vienna, Soren Iverson, Gavin Nelson, Mery Kaftar

**Constraints:** ISSUE-01 disposition experiment_only: emphasis is a comprehension question, not a constraint determination; Copy must not imply BB locks, syncs, or merges the original

**Confidence:** medium

### D02: Provide a canonical labeled entry beside new-thread creation plus command-palette access; no permanent primary-navigation Import item. Contextual absence-triggered entry is preserved as a prototype alternative, never as the sole route.

Import is low-frequency and high-consequence: permanent chrome taxes daily density, palette-only routes are invisible to anyone not already told, and contextual matching is unproven without current BB navigation evidence.

**Contributors:** Rauno Freiberg, Mery Kaftar, Gavin Nelson, Sara Vienna, Soren Iverson, Kevin Twohy

**Constraints:** ISSUE-02 experiment_only; current BB surfaces unknown; Accelerators may not be the only path for pointer, touch, or assistive users

**Confidence:** medium

### D03: Open on a deterministic Ready-to-continue set ranked by recency, plus named stored-state exception groups, with a labeled full machine-scoped catalog and scoped search as fallback. Row state is carried at rest. No transcript-derived intent grouping.

All five revisions converged here after challenge: an undifferentiated warehouse gives already-imported, unreachable, missing-cwd, and unreadable-version rows equal legitimacy while asserting everything is fine, and filters do not help the row the user has no reason to filter for. Intent extraction is unproven and would read transcript content for sessions the user never selects.

**Contributors:** Soren Iverson, Gavin Nelson, Kevin Twohy, Mery Kaftar, Sara Vienna

**Constraints:** ISSUE-03 experiment_only: the preferred opening hierarchy awaits the four-way prototype; TRANSCRIPT-DERIVED-INTENT-GROUPING: unsupported — cannot be an authoritative source, grouping, mapping, or fork target; If stored-state grouping cannot be classified reliably, the fallback catalog may occupy the first screen as a verification outcome

**Confidence:** medium

### D04: Make the owning machine a visible participant with its own readiness state, not a filter control. Known-but-unreachable hosts appear explicitly with a connect path; rows resolve progressively rather than behind a blocking spinner.

Provider operations are host-bound; an offline host silently omitted is indistinguishable from "BB cannot see my work," which is the fastest way to lose trust in the whole capability.

**Contributors:** Kevin Twohy, Rauno Freiberg, Gavin Nelson, Mery Kaftar, Sara Vienna, Soren Iverson

**Constraints:** ISSUE-04:MACHINE-VISIBLE allowed; Last-seen, scan-freshness, and off-host metadata caching require specialist review before display

**Confidence:** high

### D05: Treat the discovery list as its own privacy surface, designed to be fully selectable from minimally exposing metadata; verbatim prompts, previews, and any derived summary are gated on a privacy/security ruling covering local vs remote rendering and caching.

Content crosses the exposure boundary during browsing, before consent, for every session the user did not choose. The ruling is not the design room's to make; the design must survive either answer.

**Contributors:** Kevin Twohy, Rauno Freiberg, Gavin Nelson, Soren Iverson

**Constraints:** ISSUE-05 specialist_review; If titles and first prompts are forbidden pre-consent, the first screen changes shape, not merely order — carry this as a designed branch in the prototype

**Confidence:** medium

### D06: Every import continues natively. Present the history decision as a single consequence-labeled control ('also make these messages readable and searchable in BB — visible in BB timelines, search, connected clients, and permitted plugins'), not as two modes sharing a 'Continue' prefix.

Two named modes make the longer option read as the more complete one, so a privacy-boundary change gets made by default-clicking. The difference is exposure, not continuation quality.

**Contributors:** Rauno Freiberg, Mery Kaftar, Gavin Nelson, Sara Vienna, Kevin Twohy, Soren Iverson

**Constraints:** ISSUE-06:OUTCOMES-SEPARATE allowed; History must never be framed as required for continuation completeness; Whether the control defaults on or off is a data-minimization decision reserved to privacy and the product owner

**Confidence:** high

### D07: Place the history choice in the consolidated pre-commit review adjacent to a preview that visibly updates with the control, with omitted record classes in progressive disclosure. Do not offer 'add readable history later' or imply removal is complete until core and privacy verify late staging and full deletion.

Consent belongs next to the artifacts it describes, not behind an interstitial read before the evidence. A post-import add path and a reversibility claim are both attractive and both currently unverified; a dead affordance or a false reversibility promise is worse than a one-shot decision.

**Contributors:** Rauno Freiberg, Mery Kaftar, Gavin Nelson, Sara Vienna, Kevin Twohy, Soren Iverson

**Constraints:** ISSUE-07:HISTORY-AT-COMMIT allowed; HISTORY-AFTER-CONTINUE-OR-REVISABLE and REMOVE-READABLE-HISTORY-EVERYWHERE: verify before promising

**Confidence:** medium

### D08: One surface with progressive disclosure — machine scope, session list, inspector for preview/mapping/exposure — and a single terminal commit. Query, filters, selection, scroll, machine scope, mapping edits, and history choice survive inspection, failure, and retry.

Unanimous across advisors: sequential wizard pages destroy comparison context and turn recovery into backtracking, producing exactly the migration-wizard shape the packet rejects.

**Contributors:** Kevin Twohy, Rauno Freiberg, Mery Kaftar, Gavin Nelson, Sara Vienna, Soren Iverson

**Constraints:** ISSUE-08:ONE-SURFACE allowed; exact layout remains a prototype matter

**Confidence:** high

### D09: Give the import a durable, visible operation identity that survives reload, with resume as the primary action and 'start a new import instead' clearly secondary and labeled as creating a second fork. Pre-commit conditions resolve inline with the correct primary action pre-selected; post-commit integrity problems become durable addressed records. A duplicate resolves to 'Open the existing thread' and is never rendered as a failure. Prepared-but-uncommitted forks get a real surface with a remove-copy action.

Idempotency exists in the system but is unverifiable by the person it protects; after a reload a generic Retry is indistinguishable from start-over, so cautious users stall and impatient users create second forks. Orphan forks are the one state where BB left an artifact on the user's machine and had no described home.

**Contributors:** Rauno Freiberg, Kevin Twohy, Mery Kaftar, Gavin Nelson, Soren Iverson, Sara Vienna

**Constraints:** ISSUE-09:DURABLE-OPERATION allowed; State labels, cancel semantics ('cancel removes the copy'), Ready, and one-click resume must be bound to actual saga transitions and compensation rules before shipping the copy; CONTINUE-UNMAPPED: unsupported — mapping to an existing project or unmanaged workspace is required; A durable queue surviving host disconnect is unsupported on current evidence

**Confidence:** medium

### D10: Render imported messages as one continuous, clearly bounded historical region with a single boundary statement naming the source machine and stating nothing above is live. Historical tools, tasks, approvals, hooks, and processes render as inert records or are named as omissions; the thread starts idle under current BB policy, stated as what is now true rather than what was lost.

The natural design drops the user into a thread structurally identical to a BB-native one, so historical Claude tool calls read as BB events and the central claim is asserted before it is exercised. When the first turn behaves differently, trust in every provenance claim collapses at once.

**Contributors:** Rauno Freiberg, Kevin Twohy, Soren Iverson, Gavin Nelson, Mery Kaftar, Sara Vienna

**Constraints:** ISSUE-10:HISTORICAL-BOUNDARY allowed; BOUNDED-REGION-VERSUS-PER-MESSAGE: experiment_only — long-transcript and scroll comprehension unproven; Historical/live distinction must not be encoded by color or dimming alone

**Confidence:** high

### D11: Every imported thread carries always-inspectable provenance: source session and host, destination and mapped project/worktree, included history, named omission classes, runtime-policy reset, and recovery state — reachable in transcript reading order, collapsed by default, legible on remote clients, and never self-re-expanding.

The hardest concept is currently explained in a modal that disappears and is absent weeks later when a search returns nothing. Inspectability is a controlling invariant; prominence and form are not.

**Contributors:** Kevin Twohy, Mery Kaftar, Gavin Nelson, Sara Vienna, Rauno Freiberg, Soren Iverson

**Constraints:** ISSUE-11:DURABLE-PROVENANCE allowed; PROVENANCE-PROMINENCE-AND-PLACEMENT experiment_only; Requires projection version and omitted record classes to be readable at thread-render time — a core dependency, not a design decision; Must read as lineage, not as a permanent warning label

**Confidence:** medium

### D12: Persist import-time lineage as static fact. Do not re-read or monitor the source after import, and do not display divergence or staleness states, until backend and privacy owners rule on post-import source re-verification.

Static lineage avoids implying BB monitors, synchronizes, locks, or controls the original. Live divergence is a real and unaddressed confusion, but re-reading the source changes the privacy, host, battery, and authority model.

**Contributors:** Kevin Twohy, Mery Kaftar, Gavin Nelson, Sara Vienna, Soren Iverson, Rauno Freiberg

**Constraints:** ISSUE-12:STATIC-LINEAGE allowed; LIVE-DIVERGENCE specialist_review; BB cannot claim an exclusive lock on the original Claude session; no such lease exists

**Confidence:** high

### D13: End the flow by opening the verified idle thread with focus in the composer — no confirmation screen, no celebration, no percentage progress on host-bound work. Express native continuation as a property of the thread, not as a past-tense success claim, and let the first response confirm it; first-send failure recovers at the composer with the typed message preserved. Spend at most one transition, on the source-to-thread handoff, with an immediate-cut reduced-motion alternative rather than a shortened spatial move.

The riskiest moment is the first message, not the import. A celebration implies nothing changed and worsens the runtime-reset surprise; motion over unknown-duration host calls reads as theater the moment it outlasts itself. Premium here is immediacy, stability, and truthful states.

**Contributors:** Kevin Twohy, Rauno Freiberg, Sara Vienna, Mery Kaftar, Gavin Nelson, Soren Iverson

**Constraints:** ISSUE-13:DIRECT-COMPOSER allowed; ONE-HANDOFF-TRANSITION experiment_only; Motion must be interruptible and must not delay input or imply unverified completion

**Confidence:** high

### D14: Bulk is an accelerator over the same list, consent, validation, idempotency, and per-item recovery model, eligible by default only for deterministically Ready items; All is never a bulk target, and no item may be published by a batch that would not have passed individually. Visible controls precede keyboard accelerators; a persistent selected-count chip must reveal any selection scope hidden by filters.

A separate administrative bulk mode either infects the single-session default with migration chrome or becomes a second, less careful path — which is precisely where half-imports and unresolved mappings get published.

**Contributors:** Kevin Twohy, Mery Kaftar, Gavin Nelson, Soren Iverson, Sara Vienna

**Constraints:** ISSUE-14:BULK-SAME-MODEL-READY-ONLY allowed; BULK-IN-V1 experiment_only — v1 scope is the product owner's call; Bulk must not become the v1 personality before single-session trust is proven

**Confidence:** medium

### D15: Do not promise mobile commit or state-preserving desktop handoff in v1 copy or IA until BB's current mobile surfaces, host targeting, durable operation resume, and cross-device capability are verified. Both bounded mobile roles remain live options.

Both proposals correctly reject compressed desktop parity, but each depends on unverified platform capability, and stranding a user mid-operation is worse than a smaller scope.

**Contributors:** Mery Kaftar, Gavin Nelson

**Constraints:** ISSUE-15 verify on both positions; Never stack the desktop table, inspector, and bulk controls into one long mobile page

**Confidence:** low

### D16: Treat accessibility as an acceptance gate, not polish: formal specialist review of an interactive prototype covering keyboard and touch completeness, focus order/return/transfer into the composer, live saga announcements without over-announcing, dense-list and bulk semantics, non-visual historical-vs-live distinction, error recovery, target size, contrast, zoom/reflow, and reduced motion.

Unanimous across advisors and not overridable by advisor majority; no design-room lens can certify conformance.

**Contributors:** Kevin Twohy, Rauno Freiberg, Mery Kaftar, Gavin Nelson, Sara Vienna, Soren Iverson

**Constraints:** ISSUE-16 specialist_review; accessibility is controlling authority

**Confidence:** high

### D17: Keep out of v1: exact-ID adoption (including as a disabled option), Codex-style lossy conversion, automatic or watched history import, fabricated live historical events, a plugin-only or generic providerThreadId escape hatch, a provider-generic import shell with Claude as one tile, bidirectional sync or merge/diff UI, and migration completion theater.

Each is blocked by the constraint audit against established facts 2, 3, 5, 6, 7, and 10 or by the packet's Claude-first scope; reusable invariants may be preserved internally without presenting an abstract multi-provider product now.

**Contributors:** Kevin Twohy, Rauno Freiberg, Mery Kaftar, Gavin Nelson, Sara Vienna, Soren Iverson

**Constraints:** ISSUE-17 blocked dispositions across all six targets

**Confidence:** high

## Viable alternatives

### Promise emphasis: custody-first vs one-home-first

Custody-first leads with continuation plus source safety ('the original stays untouched'). One-home-first demotes source safety to a quiet invariant and heroes the fork: 'the next message has one home.' Both preserve the fork, source-safety, and first-send contracts.

**Optimizes:** Custody-first: addresses fear of destructive surprise and reads as trustworthy on first contact; One-home-first: pre-empts the two-futures confusion the fork model manufactures by design

**Sacrifices:** Custody-first: leaves the divergent-futures problem unnamed until it happens; One-home-first: may under-explain that a new Claude session ID was created, and can scare users out of importing if source-safety is not equally visible

### First screen: Ready-plus-exceptions vs machine-first catalog vs recency-first vs repository-first

Four coherent openings for the same surface, all machine-explicit and all using deterministic session identity. Ready-plus-exceptions leads with the actionable subset and named stored-state failures; the catalog leads with complete scoped inventory; recency-first with a short ranked list of recent sessions; repository-first with project grouping.

**Optimizes:** Ready-plus-exceptions: prevents a healthy-looking warehouse from hiding unsafe rows and frames the job as continuation; Catalog: deterministic recognition, density, auditability, and a reliable route for users who know the exact source; Recency-first: fastest path when the modal case is continuing last night's work; Repository-first: matches how developers describe their own work

**Sacrifices:** Ready-plus-exceptions: risks reading as 'BB thinks my work is broken'; depends on classification that may lag or over-claim; Catalog: risks archive-administration framing and industrialized bulk mistakes; Recency-first: fails if the modal case is archaeology across many machines; Repository-first: repositories and worktrees repeat across hosts, obscuring the only scope that can fork

### Provenance form: full seam vs collapsing receipt vs quiet scar

Seam: a permanent block in transcript reading order stating origin, what came, what did not, what changed, and what can still be done. Receipt: one identity-preserving object carried from inspector through recovery into the thread, then collapsed. Scar: a quiet persistent line naming source and BB-owned future, receding after first continuation.

**Optimizes:** Seam: makes omissions and later actions visible exactly where confusion arises; Receipt: keeps task meaning stable across preview, progress, repair, and destination; Scar: protects transcript density for an audience that prizes it

**Sacrifices:** Seam: vertical space on every imported thread; concentrates all disclosure risk in one wording; Receipt: needs disciplined disclosure or it dominates the thread; bulk needs a comprehensible aggregate; Scar: least capacity to explain omissions and recovery at the moment of confusion

### History consent timing: at commit vs as a separate post-import action

At commit, exposure is understood before finalization. Post-import, continuation happens first with no index, and readable history becomes a distinct later action with its own exposure preview.

**Optimizes:** At commit: one consequential moment, no dead affordance, decision made against a visible preview; Post-import: protects the direct continuation job from setup friction and gives the privacy decision its own moment

**Sacrifices:** At commit: makes the choice effectively one-shot if late staging is unsupported; Post-import: unshippable until core verifies late staging remains ordered, indexed, idempotent, recoverable, and truthful when the source is unreachable

### Mobile role: single ready-session loop vs inspect-and-handoff only

Either one complete mobile loop for a single ready session with ambiguous cases routed to desktop, or mobile limited to inspection, status, and a state-preserving desktop handoff.

**Optimizes:** Single loop: real value on the device where urgency often strikes; Inspect-and-handoff: no risk of stranding a user mid-operation on a compressed surface

**Sacrifices:** Single loop: unverified host targeting, state persistence, and cross-device recovery; Inspect-and-handoff: promises a handoff whose durability is itself unverified

## Implementation sequence

1. Obtain the controlling rulings before design hardens: privacy/security on what may be rendered or cached pre-consent (locally and on remote clients); BB core on the authoritative saga transitions, cancellation and compensation, publication gate, idempotency identity, orphan reconciliation, late history staging, and read-time availability of projection version and omission classes.
2. Design the consequential end state first: the idle imported BB thread — bounded historical region, boundary statement, inert historical records, runtime-reset statement, provenance object, composer focus. Let its required fields define what the saga must record.
3. Specify the complete interaction-state inventory for this flow (idle, preview, checking host, host unreachable, preparing, fork created, staging, committing, verifying, published, partially complete, failed, retrying, rolled back, stale/superseded, already imported) and map each to one of the three custody beats, with what is true, what the user may do, and where feedback appears.
4. Walk every named trouble state — duplicate, missing cwd, version skew, disconnected host, partial failure, orphan fork — through that model and through the inline-vs-durable-record split before any layout work.
5. Design the one surface: machine-explicit scope, Ready-plus-exceptions default with catalog fallback, recognition record fields, contextual inspector, consolidated review with the consequence-labeled history control and live preview, single terminal commit.
6. Define the copy system as one artifact: promise clauses, the two plain terms for what Claude remembers vs what BB can show and search, boundary statement, omission nouns, state labels, and one sentence per named failure cause — reviewed to the same standard as the state machine and shared with support.
7. Build the four-way first-screen prototype (machine-first catalog, recency-first, repository-first, Ready-plus-exceptions) with realistic multi-machine inventories, including a designed branch for the case where pre-consent recognition metadata is forbidden.
8. Run comprehension, task-time, and error-rate testing; then accessibility review of the interactive prototype; then resolve the reserved product-owner choices.
9. Only after those gates, define the v1 boundary for bulk and mobile and hand the accepted direction to engineering for the BB core import capability plus Claude adapter plan.

## Validation plan

- Verify the authoritative core import saga: transition names, cancellation and compensation behavior, publication gate, idempotency identity, and orphan-fork reconciliation at every kill point — before any UI label promises them.
- Verify exact cwd, linked-worktree, symlink, relocated, deleted, ambiguous, and unmanaged-workspace mapping behavior; no unmapped-continuation path is approved without it.
- Verify supported Agent SDK and resolved Claude executable version pairs across older, current, and newer sessions.
- Verify authoritative machine reachability, last-seen, scan-freshness, reconnect, latency, pagination, and cancellation behavior, ensuring an offline host is never presented as empty.
- Verify whether late history staging after commit is supported and stays ordered, indexed, idempotent, recoverable, and truthful when the source becomes unreachable.
- Verify whether imported history can be removed from all BB timelines, FTS indexes, remote-client caches, and plugin-visible surfaces before implying any reversibility.
- Verify source-safety hashes, first-send owned-fork identity, runtime-policy reset, projection fidelity, omission metadata, malformed-record handling, and upgrade survival using disposable fixtures.
- Verify whether re-reading a source fingerprint after import is permitted and reliable enough to support divergence or staleness claims.
- Verify whether off-host caching or rendering of discovered session metadata is supported and permitted.
- Run the four-way first-screen prototype with realistic multi-machine inventories; measure time to correct session, wrong-source errors, already-imported errors, fallback use, and whether users perceive continuation or archive administration. Record whether any candidate requires reading transcript content to render, so disclosure cost is compared alongside task time.
- Test comprehension — after a delay, not same-session — of native fork ownership, original-session safety, continuation without readable history, history exposure scope, omissions, and the two-futures boundary. The decisive question: does a continue-only thread read as complete or as broken?
- Prototype long imported transcripts to verify the historical-vs-live distinction remains perceivable after scrolling and with assistive technology, and that it is not conveyed by color or dimming alone.
- Test the durable operation and receipt across success, disconnected host, ambiguous cwd, duplicate, version skew, commit failure, and orphan-fork recovery, confirming that inspection and return restore machine scope, grouping, selection, scroll, mapping, and history choice.
- Verify actual demand and safe large-inventory behavior (virtualization, hidden selection scope, per-item recovery) before committing broad bulk import to v1.
- Verify current BB mobile import, host targeting, durable operation resume, and cross-device handoff before promising either mobile commit or resume-on-desktop.
- Obtain formal accessibility review of the interactive prototype and affected BB flows against the D16 checklist as a ship gate.
- Obtain privacy/security approval of the readable-history exposure matrix, consent language, indexing, plugin access, remote-client visibility, redaction, retention, and deletion; and legal/retention approval for any claim about deletion, export, retention, caches, or prepared-fork lifecycle beyond the source-unchanged invariant.

## Decisions reserved for the product owner

- Promise emphasis: custody-first ('the original stays untouched') vs one-home-first ('the next message has one home'), and whether 'Continue' or 'Import' is the in-product primary verb — to be decided on copy-comprehension evidence, not advisor popularity.
- Whether readable-history consent happens at initial import only, or additionally as a post-import action — contingent on core verifying late staging.
- Whether the readable-history control defaults on or off (a data-minimization decision shared with privacy).
- The first-screen hierarchy, after the four-way prototype reports task time, wrong-source and already-imported error rates, fallback use, and perceived job framing.
- Provenance prominence and placement: full seam, collapsing receipt, or quiet scar — and how long it stays prominent after the first successful continuation.
- v1 bulk scope: ship Ready-only bulk as an accelerator, or defer bulk entirely until single-session trust is proven.
- v1 mobile scope: single ready-session commit loop, or inspection/status plus desktop handoff only — after platform capability is verified.
- Whether a history omission ever blocks import or only permits continuation with a visible warning.
- The acceptable speed-versus-certainty threshold for the first screen (wrong-source and recovery-success thresholds the prototype must meet).
- Confirmation of the v1 boundary and the ordering of deferred follow-ons, including cross-machine session search and any later exact-ID mode should an enforceable ownership lease ever exist.

## Material contributions

- **Kevin Twohy lens:** Named the browse-is-disclosure gap (the discovery list is its own privacy surface, pre-consent, for sessions the user never chose) and later extended it to derived content, which is what disqualified transcript-derived intent grouping. Split trouble states into inline pre-commit conditions vs durable post-commit records, established that a duplicate must never render as a failure, and argued the trust burden belongs in a permanent continuity object rather than a transient modal. Amended his own bulk position to restrict eligibility to the Ready set.
- **Rauno Freiberg lens:** Supplied the three-beat user-facing state model (nothing created / a copy exists on this machine / imported and yours) mapping every engineering stage to one beat; the acknowledgement-at-the-object rule (row and machine selector own their state, never a global banner); the first-message-honesty rule (continuation is a property of the thread, not a past-tense claim before the first send); visible retry identity so idempotency is verifiable by the person it protects; and the one-transition motion budget with a non-spatial reduced-motion alternative.
- **Mery Kaftar lens:** Provided the two-outcome plain-language framing at review, authoritative named saga states instead of percentages, the counted-filter comparison-and-repair list with a persistent selected-count chip revealing hidden selection scope, the Import Ledger as one record shared across discovery, progress, repair, and destination, and the bounded-mobile-loop model. Amended the opening to Ready-plus-Needs-attention with All as explicit fallback.
- **Gavin Nelson lens:** Established machine as persistent visible scope rather than a buried filter, the compact recognition record (what metadata is required for a safe choice given repeated repo names across hosts and worktrees), master-detail context preservation through mapping edits and retries, and the continuation receipt that begins as inspector, becomes the recovery record, and resolves into thread provenance. Authored the challenge that forced deterministic session identity over inferred intent, and the Ready-only bulk restriction.
- **Sara Vienna lens:** Framed history inclusion as a change of audience rather than a fidelity or completeness setting — the reframing that keeps a continue-only import from reading as incomplete. Separated stable custody invariants from Claude-first expression, argued for prototyping the consequential end state (the idle thread with a quiet provenance scar) first and designing discovery backward from it, and rejected provider-generic v1 furniture.
- **Soren Iverson lens:** Inverted the migration-wizard assumption and the safety-hero promise, producing the job-first opening and the 'next message has one home' framing. Replaced the omissions terms-wall with a single consequence preview. Authored the challenge that exposed the healthy-looking warehouse as the dangerous default state, then withdrew the inferred-intent matcher while keeping stored-state Ready-plus-anomaly grouping — the move that produced the convergent first-screen position.

## Rejected proposals

- **Exact adoption of the source Claude session ID in v1, in any form including a disabled or advanced control** — Blocked: contradicts the established safe default and permits a dual-writer state with no enforceable ownership lease (facts 2 and 3).
- **Codex-style lossy transcript conversion as the v1 default** — Blocked: abandons native Claude identity and discards BB's established advantage (fact 10).
- **Automatic or watched history import, or background indexing of discovered sessions** — Blocked: expands exposure without the required per-session preview and explicit consent (fact 5).
- **Rendering historical tasks, approvals, tools, hooks, processes, permissions, or turns as live BB activity** — Blocked: violates the timeline-fidelity and idle-start contracts (fact 6 and safety invariants).
- **A plugin-only workflow or a generic providerThreadId spawn escape hatch** — Blocked: the current public plugin API cannot enforce the durable workflow, and the hatch bypasses ownership, provenance, idempotency, rollback, and event invariants (fact 7).
- **A provider-generic v1 import shell with Claude as one tile among providers** — Blocked: exceeds the explicit Claude-first scope and hides Claude-specific machine, cwd, fork, and fidelity consequences. Reusable invariants may be kept internally.
- **Transcript-derived intent extraction as the first-screen grouping, authoritative source, mapping, or fork target** — Unsupported: no reliable extraction mechanism or identity semantics exist, and computing labels by reading every transcript crosses the unresolved pre-consent exposure boundary. Withdrawn by its own proposer.
- **A 'possible secrets' classification group in the discovery list** — Unsupported: no detection method, false-positive contract, permission boundary, or safe pre-consent content-read policy is supplied. Cannot be an authoritative default group.
- **Continuing an import with no project/worktree mapping ('continue unmapped')** — Unsupported: the evidence requires an exact existing project or unmanaged-workspace mapping and treats missing, deleted, relocated, and ambiguous cwd as ship-gate work.
- **An import queue that survives host disconnect** — Unsupported: a useful recovery idea, but no supplied BB capability or saga contract establishes durable queueing across disconnect.
- **Describing 'Continue only' as the established v1 default for history** — Unsupported as a factual claim: the evidence establishes the native fork as the default but explicitly reserves whether v1 offers a history choice. It may be recommended, not stated as established.
- **Interface language implying imported history can be fully removed later, or that BB monitors/locks/syncs the original session** — Unsupported until deletion across FTS, remote-client caches, and plugin-visible surfaces is verified, and no exclusivity lease over the Claude client exists.
- **Migration completion theater: success/celebration screens, confetti, 'N sessions imported' banners, synthetic percentage progress over host-bound discovery, and consent interstitials shown before the preview** — Rejected as generic and dishonest for this audience: polish that conceals an incomplete or ambiguous operation, and consent read before the evidence is a formality rather than consent.
- **A sequential multi-screen migration wizard, a flat session table or file picker as the first screen, and a permanent Import item in primary navigation** — Rejected unanimously: destroys comparison context, gives unsafe rows equal legitimacy, and taxes daily density for an episodic job.
- **Bidirectional sync, merge/diff UI between a Claude session and an existing BB thread, and importing host-saga stage names into the continue moment** — Rejected as overbuilt for v1 and as exposing implementation vocabulary at a granularity the user cannot act on.

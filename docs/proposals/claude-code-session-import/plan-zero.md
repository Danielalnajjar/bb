# Plan 0 and Research Routing — Continue Claude Code in BB

## Problem statement

Build a first-party, Claude-first continuation flow that discovers Claude Code sessions on an explicitly selected enrolled host, creates a new BB-owned native Claude fork, optionally projects supported historical messages into BB after explicit consent, and publishes one ordinary idle BB thread only after durable verification. The source session remains untouched.

## Worker routing

- Worker provider: **grok**.
- Grok owns implementation, correction, simplification, and every Omega workflow stage.
- Codex owns lead decisions, local explorer lanes, librarian research, review synthesis, and final verification.
- No Codex fallback is permitted for Grok build or Omega lanes unless the user changes the routing.

## Plan 0

1. Prove the current local seams for provider discovery/fork, server policy and persistence, host-daemon transport, UI entry, CLI, and SDK.
2. Verify the pinned Claude Agent SDK's public/source-level session discovery, history, fork, cleanup, and compatibility semantics from primary evidence.
3. Write a decision-complete ExecPlan outside the Git tree with data model, state machine, protocol changes, public surfaces, test sketches, UI states, recovery, and ship gates.
4. Run Grok-backed Omega plan hardening, discovery, and adversarial review; incorporate accepted amendments.
5. Hand bounded implementation slices to Grok and assemble them under one root-owned branch.
6. Create local R0; run the required review, correction, external review, simplification, tests, and browser QA cycle.
7. Stop branch-ready. Do not push, open a PR, merge, or deploy without further authorization.

## Local Context Pack

### Product authority

- Canonical product recommendation: `claude-import-design-room/FINAL-RECOMMENDATION.md`.
- Technical synthesis: `claude-session-import-research-synthesis.md`.
- Unknowns pass: `claude-session-import-unknowns.md`.

Controlling direction: use the in-product verb **Continue**; create a new BB-owned native Claude fork; keep the source unchanged; separate provider continuity from BB-readable/searchable history; default to no exposure expansion; present machine readiness explicitly; commit from one surface; make import durable and idempotent; publish only after verification; open directly into the idle thread composer; retain inspectable static provenance and inert historical records.

### Repository facts established locally

- `plugins/provider-claude-code/src/bridge/bridge.ts` already implements `thread/fork` by calling Agent SDK `forkSession(sourceProviderThreadId, { dir, upToMessageId? })`, starts the returned session ID, and reports it as restorable.
- The existing public BB fork flow in `apps/server/src/services/threads/thread-fork.ts` requires a live BB source thread and ready source environment.
- `apps/server/src/services/threads/thread-create.ts` derives a fork descriptor only from an existing same-provider BB source thread with a stored provider session ID on the same host; a source-derived thread without that descriptor is rejected rather than silently starting fresh.
- The `threads` table stores BB provenance (`sourceThreadId`, `originKind`, `originPluginId`) but not an external-provider import claim. Provider session identity is event-sourced in `events.providerThreadId`.
- Provider execution is host-bound. A new daemon wire operation requires a `HOST_DAEMON_PROTOCOL_VERSION` bump from the current value.
- Root repository policy requires every end-user feature through UI, SDK, and `bb` CLI, with docs and public-surface tests.

### Constraints

- No exact source-ID adoption, generic provider-session escape hatch, watched sync, automatic transcript exposure, fabricated live events, or plugin-only database writes.
- No half-published thread. Retry must return the same operation/thread/fork unless the user explicitly starts a new import.
- History is optional projection, not a requirement for native continuation.
- Pre-import discovery must remain useful under a privacy ruling that forbids prompt/title content before consent.
- V1 is single-session first. Bulk is deferred.
- The source machine is explicit and provider mutation happens only there.

## Local exploration routing note

Three non-overlapping Codex explorer lanes are active:

1. Claude provider/Agent SDK runtime and host-daemon protocol seam.
2. Server import saga, database provenance/idempotency, CLI/SDK/publication seam.
3. App entry, candidate/inspector/recovery/history/provenance UI and affected tests.

Root continues only cross-cutting source reads and synthesis; it does not duplicate the explorers' bounded questions.

## External research query and skip list

The following list is frozen before librarian dispatch.

### Q1 — Claude Agent SDK session operations at the pinned/current boundary

- **Question:** In `@anthropic-ai/claude-agent-sdk` 0.3.197 and current official documentation/source, what supported APIs and storage semantics exist for listing sessions, inspecting metadata, paginating messages, native fork, identifying/deleting a prepared fork, and resuming the fork?
- **Why needed:** Determines the host adapter contract and whether the proposed saga can reconcile or compensate after a lost response.
- **Required evidence:** Official Anthropic docs plus the exact 0.3.197 declarations/source; clearly distinguish pinned behavior from newer behavior.
- **Deliverable:** Capability table with exact symbols, inputs/outputs, limitations, version notes, and implementation consequences.

### Q2 — Claude session compatibility, concurrency, and history fidelity

- **Question:** What do official/source materials establish about session file location/format stability, writer concurrency, CLI/SDK version skew, fork immutability of the source, `cwd` requirements, and the fidelity/omissions of message-history APIs?
- **Why needed:** Sets safe defaults, ship matrix, privacy disclosure, and whether an operation marker/cleanup primitive is feasible.
- **Required evidence:** Primary sources only; label absence of guarantee as an unknown rather than an inferred guarantee.
- **Deliverable:** Verified facts, explicit non-guarantees, failure modes, and required disposable probes.

### Q3 — Comparable first-party migration/import architecture

- **Question:** In current OpenAI Codex source, what session discovery, Claude JSONL parsing, provenance, idempotency, filtering, and failure-handling patterns are reusable or explicitly unsuitable for BB's native-fork design?
- **Why needed:** Gives a current first-party comparison without copying Codex's lossy product model.
- **Required evidence:** Current tagged/source implementation and tests, not third-party summaries.
- **Deliverable:** Reuse/reject table with source links and BB consequences.

### Skips

- **Broad community pulse / last-30-days search:** skipped. This is an implementation/API evidence problem, not a market, sentiment, or adoption decision.
- **BB architecture via external research:** skipped. The checked-out source, tests, and repository instructions are the authoritative and more current evidence.
- **Generic UX pattern research:** skipped. The completed 19-designer room is the product authority; implementation only needs to prove feasibility against current BB surfaces.
- **Framework/library method research for React/TanStack/Vitest:** skipped for planning. Existing repository patterns and the shared test skill are sufficient; research will be opened later only for an accepted finding whose fix depends on uncertain current behavior.

## Initial test-value table

| Surface             | Public setup/action/outcome                                                                                                                | Value | Stage                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----: | ---------------------------------- |
| Claude host adapter | Fixture session catalog; list/inspect/fork/reconcile/delete; source hashes unchanged                                                       |  High | automated + disposable integration |
| Host protocol       | Typed discovery/import commands across wire; offline/mismatch/invalid host rejected                                                        |  High | contract/integration               |
| Server saga         | Begin same idempotency key twice; kill/retry every transition; exactly one operation/thread/provider claim published                       |  High | in-memory SQLite integration       |
| History consent     | Commit with history off/on; only on indexes supported text and emits import-specific inert records                                         |  High | server integration                 |
| App flow            | Open Continue route; choose host/session/mapping/history; recover duplicate/offline/resume; verified thread opens idle with composer focus |  High | RTL DOM+events plus browser QA     |
| SDK/CLI             | List/inspect/continue/status/abort through public API; stable machine-readable output and duplicate-open result                            |  High | public-surface integration         |
| Provenance          | Reload and remote-client read preserves source/owned IDs, host, mapping, omissions, projection version, lifecycle state                    |  High | DB/API integration                 |
| Accessibility       | Keyboard/touch reachability, focus return/transfer, live status announcement, reduced motion, non-color history boundary                   |  High | RTL + browser QA                   |

## Stage ledger

- Stage 1: local exploration complete; external primary-source research in progress.
- Worker provider: grok.
- Stage 3 adversary budget: 0/5 completed.

## Local exploration conclusions

1. **Use a dedicated external-import domain.** `sourceThreadId` and `originKind: "fork"` mean a relationship to another BB thread and must not be overloaded.
2. **Add provider-session operations to the provider bridge/runtime seam.** The Agent Runtime already has a provider-process command path for host-scoped, non-thread calls such as `model/list`; session list/inspect/read/prepare/abort can follow that deep boundary while Claude-specific SDK handling stays in the Claude provider artifact.
3. **Bump daemon protocol 130 for the new server-to-host commands.** Additive provider-bridge methods may stay on bridge protocol v1, but the host wire changes unconditionally trigger the repository's version rule.
4. **Make the saga core-owned and durable.** Existing thread provisioning is eager and process-local; it cannot guarantee idempotent external mutation or publish-after-verify. Core DB state must own reservation, phase transitions, staged history, thread/provenance commit, recovery, and notifications.
5. **Do not publish through ordinary create.** The import commit needs one immediate transaction that creates the idle thread, provider identity, provenance, import-specific history events/search segments when consented, and the terminal operation state before notifying subscribers.
6. **Reconcile before retrying.** Agent SDK 0.3.197 exposes `forkSession`, `getSessionInfo`, `getSessionMessages`, `listSessions`, and `deleteSession`. A prepare call should title the new fork with an operation-derived marker; retry lists/inspects for that marker before it may fork again. Ambiguity becomes a durable `needs_attention` state, never a blind retry.
7. **Keep the UI Claude-specific.** The canonical entry is a labeled action adjacent to **New thread** in `ProjectListActionButtons`, plus command-palette access. The one-surface flow uses the existing machine picker and responsive overlay/drawer, but has its own candidate inspector before a thread exists.
8. **Navigate directly on publish.** Import success always opens the returned idle thread and focuses its composer; it does not inherit the ordinary new-thread preference that can suppress navigation.
9. **Expose provenance twice.** A bounded historical header/region appears in transcript reading order, and durable details make the existing Thread Info gate true. Neither surface claims synchronization or ownership of the source.
10. **Server-owned operation queries drive recovery.** Component-local mutation state is insufficient. Remount/reload must read a durable operation, show exact phase/error, and either resume the same operation, open the already-published thread, or remove the known prepared copy.

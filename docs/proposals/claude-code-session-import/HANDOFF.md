# `/handoff`: Claude Code Session Import

**Checkpoint:** Parked on 2026-08-17 after product design, source research, and
three complete adversarial passes. Planning only; implementation has not
started.

## Durable location

- Fork: <https://github.com/Danielalnajjar/bb>
- Branch: `feat/claude-code-session-import`
- Proposal: `docs/proposals/claude-code-session-import/`
- Planning checkpoint commit: `9cc7ae09acbd0c8f59f33b2c8047e3798571f509`
- Upstream remains `get-bb/bb`; no upstream pull request exists.

Start with the [ExecPlan](exec-plan.md). It is authoritative over the earlier
research and review reports wherever they differ.

## Product promise

Give a developer a native **Continue Claude Code in BB** action that:

1. finds a Claude Code session on an enrolled machine;
2. confirms an exact ready BB workspace mapping;
3. creates a new Claude-native fork owned by BB;
4. leaves the source Claude session untouched;
5. optionally projects bounded readable history only with explicit consent; and
6. publishes one verified, idle BB thread ready for the next message.

This is a native BB feature, not a plugin-only database workaround. The same
capability must ship through the app, public SDK, and `bb` CLI.

## What is complete

- A 19-designer product consultation was consolidated into
  [product-design.md](product-design.md).
- BB and Claude Agent SDK/runtime evidence is recorded in
  [technical-research.md](technical-research.md).
- Open questions and risks are recorded in [unknowns.md](unknowns.md).
- The research and implementation framing is preserved in
  [plan-zero.md](plan-zero.md).
- The [ExecPlan](exec-plan.md) integrates Omega hardening, discovery, and all
  findings from three complete adversarial passes.
- The fourth adversarial run, `wf_af9514674137`, was interrupted before a valid
  verdict. Its partial output was not adopted and must not be resumed or cited
  as decision evidence.
- The planning packet passed Prettier and staged-diff whitespace checks before
  its checkpoint commit.

## What does not exist

There is no product code, schema migration, provider bridge change, test,
generated SDK surface, UI implementation, browser QA, implementation commit,
upstream PR, merge, or deployment for this feature.

## Do-not-reopen boundaries

- Fork the provider session; never adopt the external Claude session ID.
- Never parse or write Claude JSONL from BB core, server, or host daemon.
- Keep the source session and the BB-owned fork as separate ownership domains.
- Default readable-history exposure to off and persist the original consent
  choice as the retry authority.
- Never blindly retry a provider fork after an ambiguous or lost response.
- Publish the BB thread, identity, provenance, consented history, search rows,
  and terminal operation state atomically.
- Never delete a source session or a BB-owned session that has changed outside
  the operation's verified revision boundary.
- Preserve a durable, idempotent import operation across disconnects and
  server/daemon restarts.
- Use exact canonical source/target path equality for v1 readiness.

## Resume sequence

1. Check out this branch and refresh it against the then-current upstream
   `main`. Resolve drift in the plan before implementation.
2. Re-read the repository instructions and the full proposal packet. Reverify
   any version-sensitive SDK, bundled Claude CLI, protocol, route, schema, and
   UI evidence against the refreshed source.
3. Run a **fresh** Grok Omega adversarial pass against `exec-plan.md` through
   the current canonical workflow entrypoint. Do not resume
   `wf_af9514674137`. Three of the planned maximum five valid adversarial passes
   are complete.
4. Adjudicate every surviving finding into the ExecPlan and continue fresh
   passes only as needed to reach an implementation-ready verdict.
5. Implement with Grok in bounded, one-writer slices. Keep Codex on lead
   decisions, explorer/librarian research, synthesis, and final verification.
6. Deliver the feature as a reviewable stack rather than one XXL pull request:
   domain/DB/timeline; provider/runtime; server plus SDK/CLI/docs; app UX plus
   browser verification.
7. Run the full ExecPlan verification matrix, affected-flow browser QA, source
   safety probes, and completion audit before claiming branch-ready.

The current estimate is approximately 70–110 files and 8k–14k net lines,
including tests and generated artifacts. Refresh that estimate after upstream
drift is reconciled.

## Completion gates

Do not call the work complete until all of these are evidenced:

- source session remains unchanged;
- exactly one owned Claude fork exists for an ordinary import;
- duplicate clicks, lost responses, server restarts, daemon restarts, and
  ambiguous provider outcomes are retry-safe;
- readable history is absent by default and bounded, inert, searchable, and
  provenance-labeled when explicitly enabled;
- app, SDK, CLI, docs, generated declarations, protocol versioning, and event
  closed graphs agree;
- deletion, archival, environment/project/host lifecycle, and orphan recovery
  preserve the stated ownership invariants;
- representative desktop and compact flows pass state-based browser QA; and
- tests use the public surfaces and include the real supported Claude SDK
  behavior where the ExecPlan requires it.

## Authority on resume

This handoff preserves context; it does not authorize an upstream push, pull
request, merge, deployment, destructive provider cleanup, or a change to the
accepted product boundaries. Obtain fresh user direction before those actions.

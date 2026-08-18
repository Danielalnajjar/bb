# Claude Code Session Import Proposal

**Status:** Parked, planning-only. No product code or migration has been implemented.

This packet preserves the product design, source research, implementation plan,
and completed adversarial reviews for a native **Continue Claude Code in BB**
flow. The intended behavior is a BB-owned Claude fork that leaves the source
session untouched, optionally projects bounded readable history into BB, and
publishes an idle BB thread only after durable verification.

## Reading order

1. [`/handoff`](HANDOFF.md) — the durable resume checkpoint, boundaries, and next actions.
2. [Product design](product-design.md) — the consolidated design-team recommendation.
3. [Technical research](technical-research.md) — BB and Claude Agent SDK findings.
4. [Unknowns](unknowns.md) — unresolved questions and risk inventory from discovery.
5. [Plan zero](plan-zero.md) — research routing and initial implementation framing.
6. [ExecPlan](exec-plan.md) — the current decision-complete implementation plan and resume checkpoint.
7. [Omega reviews](reviews/) — raw completed hardening, discovery, and adversarial reports.

## Completed review ledger

| Stage            | Run               | Result                              | Disposition                 |
| ---------------- | ----------------- | ----------------------------------- | --------------------------- |
| Omega hardening  | `wf_09a494ba829d` | Amend before discovery: 16 findings | All integrated              |
| Omega discovery  | `wf_4550eda8d12d` | 2 amendments                        | Both integrated             |
| Adversary pass 1 | `wf_901de924b84a` | Not ready: 10 findings              | All integrated              |
| Adversary pass 2 | `wf_2b7f9420b47d` | Not ready: 6 findings               | All integrated              |
| Adversary pass 3 | `wf_f4e0e62a2847` | Not ready: 9 findings               | All integrated              |
| Adversary pass 4 | `wf_af9514674137` | Interrupted before verdict          | No partial findings adopted |

The [pass-four receipt](reviews/omega-adversary-pass-4-interrupted.md) records
why that incomplete run is not decision evidence.

## Resume checkpoint

1. Treat the ExecPlan as authoritative over older reports where they differ.
2. Rebase or refresh local source evidence against current BB main.
3. Run a fresh Grok Omega adversarial pass; do not resume the interrupted pass.
4. Incorporate or reject surviving findings in the ExecPlan.
5. Begin implementation only after the plan reaches an implementation-ready verdict.

The expected full feature is an XXL cross-layer change, approximately 70–110
files and 8k–14k net lines including tests and generated artifacts. A reviewable
delivery should use a layered stack: domain/DB/timeline; provider/runtime;
server saga plus SDK/CLI/docs; then app UX and browser verification.

## Preserved boundaries

- No exact-ID adoption of an external Claude session.
- No direct Claude JSONL parsing or writes in BB core, server, or daemon.
- No readable-history persistence, search, or remote exposure without explicit consent.
- No blind retry that can create a second provider fork.
- No source or externally modified owned-session deletion.
- No plugin-only database mutation or generic provider-ID binding endpoint.
- No push to upstream, pull request, merge, or deployment was performed while producing this packet.

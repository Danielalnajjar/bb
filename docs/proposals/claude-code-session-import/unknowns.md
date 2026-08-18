# Native Claude Session Import for BB — Blind Spot Pass

## Working brief

**Goal:** Let a user discover existing Claude Code sessions and bring them into BB as genuinely usable BB threads, preserving provider-native context where possible rather than relying on a prose handoff.

**Current stage:** Pre-implementation feasibility and architecture hardening.

**Known constraints:**

- BB 0.38.0 already uses Claude Agent SDK session IDs internally as `providerThreadId` values.
- Claude Agent SDK exposes session discovery, history reads, native resume, and native fork operations.
- BB Plugin SDK 0.4.6 can spawn and manage BB threads but cannot bind an external `providerThreadId` or seed native timeline events.
- A plugin-only implementation must not mutate BB's core SQLite database or depend on private in-memory server behavior.
- The design must work with BB's enrolled-machine model rather than assuming the plugin server and Claude transcript are on the same machine.
- The original Claude process must not write concurrently to a session BB is adopting.

## Unknowns map

### Known knowns

- **Fact:** BB's Claude bridge already has a native `thread/resume` path that accepts an existing provider session ID.
- **Fact:** Claude CLI and Agent SDK sessions share the same session storage and UUID model.
- **Fact:** Codex imports Claude history by converting Claude JSONL into a new Codex-native rollout; it does not adopt Claude provider identity.
- **Fact:** A public BB core/SDK capability is missing between plugin discovery and BB's existing internal resume primitive.
- **Fact:** Native provider context and native BB timeline history are separate concerns. Resuming a Claude UUID does not automatically prove that old messages will appear in BB's event timeline.

### Assumptions to test

- **Assumption:** A supported BB import should remain valid across BB updates, so direct writes to core storage are unacceptable even though plugins are full-trust.
- **Assumption:** Imported sessions should be usable from BB's normal thread surface and search, not only from a custom plugin panel.
- **Assumption:** The first release should preserve originals until its resume and timeline results have been verified.

### Known unknowns

- Whether BB should default to **adopt** (same Claude UUID) or **fork** (new Claude UUID with copied native context).
- What “import history” must preserve: user/assistant messages only, or tools, results, reasoning, files, tasks, subagents, attachments, compaction boundaries, and system notices.
- Whether BB's bundled Claude SDK/CLI version can safely read sessions written by newer Claude Code releases already installed on the machine.
- How current BB instructions, tools, hooks, permissions, model, memory, and workflow settings behave when resuming an externally created session.
- How to detect and prevent duplicate imports, concurrent ownership, and stale/incomplete sessions.
- How to map historical session `cwd` values to current BB projects, sources, worktrees, personal workspaces, and enrolled machines.
- Whether source attachments and paths remain available after import.
- Which failures can be rolled back atomically after a BB thread row or imported timeline has been created.

### Unknown knowns

- The user may prefer exact continuity even if it means the source Claude session must become read-only elsewhere.
- The user may instead value safety and reversibility enough to prefer a native fork by default.
- “Native” may mean provider context continuity, a visually complete BB history, or both; those outcomes have materially different implementation costs.
- Imported sessions may need a visible provenance marker and source link rather than being indistinguishable from sessions created inside BB.

### Unknown unknowns

| Rank | Blind spot                                           | Why it matters                                                                                       | Cheap probe                                                                      | Consequence if missed                                         | Reversibility |
| ---: | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------- |
|    1 | Adopted session is reopened in Claude CLI            | Two writers can interleave the same JSONL and corrupt the conversational chain                       | Verify Anthropic concurrency semantics; prototype an ownership/duplicate guard   | Corrupted or ambiguous provider history                       | Low           |
|    2 | Session format/version skew                          | BB may bundle an older Claude runtime than the session writer                                        | Build a version matrix and resume read-only copies of representative sessions    | Import succeeds partially or later resume fails               | Medium        |
|    3 | Provider context and BB timeline diverge             | Claude remembers messages BB does not display or search                                              | Resume a copied session and compare SDK context with BB timeline projection      | Invisible context, confusing replies, incomplete search/audit | Medium        |
|    4 | Resume changes tool/instruction semantics            | BB injects different tools, hooks, instructions, permissions, or memory than the original client     | Compare effective session configuration before and after BB resume               | Behavior changes despite apparently continuous session        | Medium        |
|    5 | Deleted or relocated cwd/worktree                    | Claude can find a transcript whose working files no longer exist                                     | Validate `cwd`, git worktree identity, branch, and project mapping before import | Thread opens against wrong or missing code                    | High          |
|    6 | Cross-machine discovery runs on the wrong host       | Plugins execute on the BB server while transcripts may live on Air/WSL/Pro                           | Trace host-daemon and Plugin SDK boundaries; design host-explicit discovery      | Missing sessions or accidental reads from the wrong machine   | High          |
|    7 | Timeline conversion loses non-message state          | Tasks, tool results, subagents, attachments, and compaction can affect continuation and auditability | Inventory Claude JSONL record types and BB event types; define a fidelity table  | Misleading “complete import” claim                            | Medium        |
|    8 | Duplicate imports or partial retries                 | Re-running import may create multiple BB threads for one provider session                            | Define unique ownership/index and idempotency key; inject failures in each stage | Duplicate writers and orphan threads                          | High          |
|    9 | Sensitive historical content becomes newly indexed   | BB search, remote access, and plugins may expose imported content more broadly                       | Compare storage/search/access boundaries and add explicit consent                | Privacy or secrets exposure                                   | Low           |
|   10 | Active tasks cannot actually resume                  | Persisted transcript may reference background commands/subagents that no longer exist                | Import sessions with active/stale tasks and inspect resulting states             | UI suggests work is running when it is not                    | High          |
|   11 | Rollback cannot restore the pre-import state         | Identity and timeline writes may span database and host operations                                   | Specify transaction/compensation sequence and failure injection tests            | Orphaned ownership or half-imported history                   | Medium        |
|   12 | Local plugin becomes coupled to private BB internals | An app update can silently break imports                                                             | Restrict design to a versioned public core/Plugin SDK contract                   | Fragile maintenance burden                                    | High          |

## High-leverage questions

1. Should the safe default be a **native fork**, with exact-ID adoption as an explicit advanced option? This changes ownership, concurrency risk, rollback, and the meaning of “continue the same thread.”
2. Is acceptance **provider-native continuity plus readable user/assistant history**, or must the first release reconstruct BB-native tools, file changes, tasks, and subagent history too? This changes the core event-import surface and release size.

## Fast discovery plan

1. Verify Claude Agent SDK resume/fork/discovery, concurrency, version, and configuration semantics from primary sources and source code.
2. Trace BB's provider/session provisioning, event store, Plugin SDK, host-daemon, and multi-host boundaries to identify the smallest stable public contract.
3. Study Codex's current Claude importer for discovery, conversion, idempotency, provenance, limits, and rollback patterns that BB should reuse or reject.
4. Build a disposable probe using copied Claude session files: list, inspect, native-fork, resume, compare history, and deliberately fail each stage without touching originals.
5. Decide the v1 fidelity contract and only then write the implementation plan.

## Better next prompt

Research the attached native-Claude-import unknowns packet. Use primary documentation and source code. Resolve facts rather than proposing code. Return: evidence, version scope, failure modes, recommended default, exact BB contract changes, validation probes, and unresolved user decisions. Distinguish exact-ID adoption, native fork, and transcript conversion. Do not mutate sessions, BB data, or repositories.

# Native Claude Session Import for BB — Research Synthesis

## Verdict

Build this as a **BB core import capability plus a provider-aware plugin**. The v1 import mode should create a **native Claude fork** on the enrolled machine that owns the source transcript, then bind that new Claude session UUID to an idle BB thread. This preserves native Claude conversation context while leaving the source transcript unchanged.

Do not ship either of these as the v1 default:

- **Exact-ID adoption:** another Claude client can reopen the same UUID, and neither BB nor Claude Agent SDK provides a cross-client ownership lease.
- **Codex-style transcript conversion:** useful as precedent for discovery and projection, but it abandons Claude provider identity and is intentionally lossy.

A stable implementation cannot be plugin-only on installed BB 0.38.0 / Plugin SDK 0.4.6. The public SDK cannot run provider discovery on a selected remote host, bind an external provider session, create an idle imported thread, or seed native timeline/search data. Current BB main / Plugin SDK 0.4.8 has experimental host-targeted RPC, which is the right direction but must be stabilized or kept first-party.

## Resolved unknowns

| Unknown                                                   | Resolution                                                                                                                                                   | Confidence |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| Can BB continue an external Claude session natively?      | Yes. BB's Claude bridge already resumes an opaque `providerThreadId` through Claude Agent SDK.                                                               | High       |
| Adopt or fork?                                            | Native fork for v1. Exact adoption is an advanced ownership-transfer mode at most.                                                                           | High       |
| Does native context automatically populate BB history?    | No. Provider context and BB timeline/search history are separate outputs.                                                                                    | High       |
| Can `getSessionMessages()` provide a lossless timeline?   | No. It is a chain projection and omits non-message records and metadata.                                                                                     | High       |
| Can a current external plugin implement this cleanly?     | No. It lacks stable host RPC, provider-identity binding, idle import creation, and event seeding.                                                            | High       |
| Should generic `threads.spawn` accept `providerThreadId`? | No. Use a dedicated import saga so ownership, provenance, idempotency, rollback, and event invariants cannot be bypassed.                                    | High       |
| Does resume preserve original behavior?                   | It preserves provider conversation context, but BB applies current instructions, tools, hooks, settings, permissions, memory, subagent, and workflow policy. | High       |
| Is version compatibility automatic?                       | No. Record and test the Agent SDK plus resolved Claude executable pair. The transcript schema is opaque and unversioned.                                     | High       |
| Can history import silently expand access?                | Yes. BB timeline, FTS search, remote clients, and plugins create a broader visibility boundary than local Claude JSONL alone.                                | High       |
| Are old tasks/permissions still live?                     | No reliable assumption. Import them as historical/stale and require fresh BB permission decisions.                                                           | High       |

## Recommended v1 user experience

1. Open **Import Claude Code sessions**.
2. Select an enrolled machine explicitly.
3. Browse paginated Claude sessions with title, first prompt, last activity, historical `cwd`, branch, size, source version, and mapping status.
4. Select one session and choose its exact existing BB project/unmanaged workspace mapping.
5. Review a disclosure:
   - source remains unchanged;
   - BB will create a native Claude fork;
   - file-checkpoint/undo history is not copied;
   - old tasks, approvals, and background processes are historical;
   - optional imported messages become visible and searchable in BB.
6. Choose history policy:
   - **Continue only:** native provider context, provenance marker, no historical message indexing;
   - **Continue + readable history:** import the supported user/assistant/system projection and disclose omitted record classes.
7. Commit the import and open the new idle BB thread.
8. On the first message, BB resumes the newly owned Claude fork through its existing bridge.

Do not expose exact-ID adoption in v1. If added later, require an explicit ownership-transfer warning and never claim BB can enforce exclusivity outside BB.

## Core and plugin split

### Provider host capability

Run all provider-specific session operations on the selected enrolled host:

```ts
listSessions({ cursor, projectDir? })
inspectSession({ sourceSessionId, projectDir })
readMessages({ sourceSessionId, projectDir, cursor })
forkForImport({ operationId, sourceSessionId, projectDir })
deletePreparedFork({ operationId, ownedSessionId, projectDir })
```

Use Claude Agent SDK for discovery, inspection, native fork, and cleanup. Keep this outside the execution bridge; the bridge already owns ordinary `thread/resume` after import.

### Core import saga

Expose a dedicated, versioned surface rather than widening generic spawn:

```ts
threads.providerImports.begin(...)
threads.providerImports.appendMessages(...)
threads.providerImports.commit(...)
threads.providerImports.abort(...)
```

The high-level Plugin SDK may wrap those phases in `importProviderSession()`, but core owns every invariant.

### Durable identity and provenance

Add a core-owned claim/provenance table with at least:

- BB thread ID;
- host ID;
- provider ID;
- source provider session ID;
- owned provider session ID;
- mode (`fork`, future `adopt`);
- source fingerprint and detected writer/runtime versions;
- canonical historical and mapped `cwd`;
- originating plugin and import operation ID;
- projection schema/version and omitted record classes;
- lifecycle stage, timestamps, and failure/reconciliation state.

Uniqueness must cover `(host_id, provider_id, owned_provider_session_id)` plus an import idempotency key. Source and owned IDs differ for a fork.

## State machine and recovery

Treat import as a cross-store saga because Claude creates the fork in host-local storage while BB persists thread, provenance, events, and FTS data in SQLite.

```text
discovered
  -> prepared
  -> provider-forked
  -> history-staged
  -> bb-committed
  -> verified
  -> published
```

- Reserve the operation/idempotency key before provider mutation.
- Give a prepared fork an operation-derived marker so an ambiguous lost response can be reconciled by listing; never blindly call `forkSession()` twice.
- Commit the idle BB thread, provider claim, provenance marker, imported messages, and search projections in one immediate database transaction.
- If a known fork exists and BB commit fails, delete only that prepared fork or record it as a recoverable orphan.
- Never modify or delete the source session.
- Before the first BB turn, rollback can remove the unpublished BB import and prepared fork. After the first turn, rollback becomes ordinary archive/export/delete semantics for the fork.

## Timeline fidelity contract

Do not fabricate BB lifecycle events for work BB never observed. Add import-specific historical events such as:

```text
system/thread-imported
system/imported-message
```

An imported message should carry source UUID, role, normalized content, optional timestamp, projection version, and fidelity metadata. Core may index supported user/assistant text in FTS. It must not manufacture `turn/started`, live tools, active tasks, pending approvals, or subagent lifecycles.

The provenance marker must disclose omitted or downgraded data, including as applicable:

- raw thinking/reasoning;
- arbitrary top-level JSONL records;
- attachments and unavailable filesystem paths;
- compaction/replacement metadata;
- task/background-process live state;
- subagent sidechains;
- file-checkpoint/undo history;
- historical permission grants and pending interactions.

## Ship gates

Do not ship until disposable fixtures prove:

1. **Source safety:** source transcript and subagent hashes remain unchanged.
2. **Host isolation:** discovery and mutation occur only on the explicitly selected host, including offline/reconnect cases.
3. **Cwd mapping:** exact existing path, linked worktree, symlink, relocated path, deleted path, and ambiguous project cases fail or map predictably.
4. **Version matrix:** supported Agent SDK and resolved Claude CLI pairs read, fork, and resume representative older/current/newer sessions without partial commit.
5. **Idempotency:** retries return the same operation/thread/fork; an explicitly new operation is required to create another fork.
6. **Kill-point recovery:** server or daemon termination at every phase converges without duplicate threads or unknown provider forks.
7. **Timeline fidelity:** ordering and omission disclosures match fixtures containing tools, tasks, subagents, compaction, malformed lines, and attachments.
8. **Privacy/search:** canaries in each record class appear only on disclosed BB surfaces; searchable history requires explicit consent.
9. **Runtime reset:** imported tasks are historical/stale, permission grants and pending interactions are not inherited, and current BB policy is visible.
10. **First-send identity:** the new BB thread resumes the owned fork UUID through the existing bridge.
11. **Rollback/lifecycle:** archive, delete, restore, and provider-file retention behavior are explicit before and after the first BB turn.
12. **Upgrade:** an import created on BB N survives BB N+1 with provider identity, provenance, timeline, and search intact.

No-ship conditions:

- direct writes from a plugin into `bb.db`;
- private daemon calls or a generic `providerThreadId` escape hatch;
- exact-ID adoption without a clear non-exclusive ownership contract;
- automatic transcript relocation between machines;
- fabricated live task/tool/approval states;
- hidden indexing/privacy expansion;
- any failure point that can publish a half-imported thread.

## Remaining user decisions

1. Should v1 offer both **Continue only** and **Continue + readable history**, or require readable history for every import?
2. Should exact-ID adoption be excluded entirely until BB/Claude has an enforceable lease, or retained later as an advanced unsupported-by-other-clients mode?
3. Should this be developed first-party in the BB repository, or as an external plugin after the necessary core and stable host APIs land?

## Primary references

- [Anthropic Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Claude Code session management](https://code.claude.com/docs/en/sessions)
- [Agent SDK 0.3.197 declarations](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.197/sdk.d.ts)
- [BB 0.38 Claude bridge](https://github.com/get-bb/bb/blob/45145e51af36b4bd1346a9d2e73d7612d250ba4f/packages/agent-runtime/src/claude-code/bridge/bridge.ts#L1678-L1780)
- [BB current provider bridge protocol](https://github.com/get-bb/bb/blob/652eda7ee2726e178f00423b52800409405c9695/docs/provider-bridge-protocol.md#L10-L41)
- [BB 0.38 Plugin SDK host boundary](https://github.com/get-bb/bb/blob/45145e51af36b4bd1346a9d2e73d7612d250ba4f/packages/plugin-sdk/src/backend-contract.ts#L630-L647)
- [BB current host RPC contract](https://github.com/get-bb/bb/blob/652eda7ee2726e178f00423b52800409405c9695/packages/plugin-sdk/src/host-contract.ts#L19-L48)
- [Codex 0.147 Claude importer](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/src/external_agent_migration/session_importer.rs#L387-L455)
- [Codex Claude parser](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/external-agent-migration/src/sessions/records_cla.rs#L170-L217)

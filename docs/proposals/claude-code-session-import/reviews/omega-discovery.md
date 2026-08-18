# Discovery report

- run-tag: `omega-plan:20260818T040750Z-f15c848d`
- call-id: `omega_plan__discover-collate__f15c848d`
- stage: discover
- plan: [`../exec-plan.md`](../exec-plan.md)

Dispositions are **not** re-judged here. Areas are listed **amend-plan → inconclusive → plan-confirmed**. There is no inconclusive area in this pass.

## Required Coverage

| key                              | label                            | observedKey                      | status             | findings | survivors | refuted |
| -------------------------------- | -------------------------------- | -------------------------------- | ------------------ | -------- | --------- | ------- |
| claude-sdk-prepared-fork         | claude-sdk-prepared-fork         | claude-sdk-prepared-fork         | completed-refuted  | 1        | 0         | 1       |
| bb-host-provider-session-ops     | bb-host-provider-session-ops     | bb-host-provider-session-ops     | completed-survivor | 1        | 1         | 0       |
| bb-inert-history-timeline-search | bb-inert-history-timeline-search | bb-inert-history-timeline-search | completed-survivor | 1        | 1         | 0       |

---

## bb-host-provider-session-ops

### Verdict

amend-plan

### Key answer

Clone the existing non-thread provider-process seam: server requireBridgeLaunchForProviderId + callHostRetryableOnlineRpc({ type: "provider.list*models", bridgeLaunch }) → daemon onlineRpcHandlers["provider.list_models"] → resolveRuntimeBridgeLaunch → ensureProviderMaintenanceRuntime → AgentRuntime.listModels → AdapterCommand { type: "model/list" } → BRIDGE_REQUEST_METHODS.modelList → plugin bb.host experimental_providerBridge.handleLine. Add new typed hostDaemonCommandRegistry onlineRpc commands (envLane: null, required bridgeLaunch): reads via callHostRetryableOnlineRpc; prepare/abort retryable:false via callHostOnlineRpc. Bump HOST_DAEMON_PROTOCOL_VERSION 130→131. Keep Provider Bridge Protocol v1 for additive methods and optional handshake capabilities (.default(false)/.passthrough()); do not overload thread/fork. Extend AdapterCommand, BRIDGE_REQUEST_METHODS, buildCommandPlan, Claude claudeCodeCommandSchema/decodeClaudeCodeJsonRpcRequest, OnlineRpcHandlerMap, and hand-maintained session.ts success union + ONLINE_RPC_RESPONSE_RESULT_FIXTURES in lockstep. Do not use plugin.host.call, provider.usage/codex.*, environment thread.\_ runtimes, or Claude logic in core/daemon.

### Evidence

| claim                                                                                                                                                         | source                                                                                                                                                                                                                                                      | date/version                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Non-thread provider-process path is provider.list_models → resolveRuntimeBridgeLaunch → maintenance runtime → listModels → model/list                         | apps/server/src/services/system/execution-options.ts loadSystemProviderModels; apps/host-daemon/src/command-dispatch.ts onlineRpcHandlers["provider.list_models"]; apps/host-daemon/src/app.ts listModels; packages/agent-runtime/src/runtime.ts listModels | host protocol 130                    |
| Every bridge-bound command carries required bridgeLaunch; artifact is fetched/hash-verified then run as the plugin bb.host bridge                             | packages/host-daemon-contract/src/protocol.ts; commands.ts hostDaemonBridgeLaunchSchema; command-dispatch-support.ts resolveRuntimeBridgeLaunch; apps/server/src/services/system/provider-bridge-launch.ts                                                  | 130                                  |
| AdapterCommand is a closed union; generic adapter maps model/list to BRIDGE_REQUEST_METHODS.modelList; requireProviderRequestPlan throws on non-request plans | packages/agent-runtime/src/provider-adapter.ts; bridge-protocol-adapter.ts buildCommandPlan; runtime.ts requireProviderRequestPlan                                                                                                                          | current main                         |
| Bridge methods live in BRIDGE_REQUEST_METHODS; handshake capabilities default false + passthrough; unknown methods -32601; additive changes stay at PBP v1    | packages/provider-bridge-protocol/src/requests.ts; handshake.ts; version.ts; errors.ts; docs/provider-bridge-protocol.md; test/protocol.test.ts                                                                                                             | PROVIDER_BRIDGE_PROTOCOL_VERSION = 1 |
| New host commands require protocol bump; schemas are .strict(); enrolled old daemons cannot parse new types/fields                                            | AGENTS.md; packages/host-daemon-contract/src/protocol.ts (= 130); test/contract.test.ts expect(…).toBe(130)                                                                                                                                                 | 130                                  |
| Exhaustive online-RPC result fixtures must cover every command type; session.ts success union is a manual per-type list                                       | contract.test.ts ONLINE_RPC_RESPONSE_RESULT_FIXTURES vs HOST_DAEMON_ONLINE_RPC_COMMAND_TYPES; packages/host-daemon-contract/src/session.ts onlineRpcResponseSuccessSchemaFor                                                                                | 130                                  |
| Claude unknown methods are explicit -32601 via closed claudeCodeCommandSchema; plugin export is experimental_providerBridge only                              | plugins/provider-claude-code/src/bridge/commands.ts decodeClaudeCodeJsonRpcRequest; bridge.ts unknown_method + experimental_providerBridge                                                                                                                  | current main                         |
| plugin.host.call is a generic method+jsonValue envelope routed to PluginHostManager, not AgentRuntime                                                         | commands.ts pluginHostCallCommandSchema; command-router.ts executeOnlineRpcCommand; command-dispatch.ts throws if it reaches handlers                                                                                                                       | v124 envelope, still 130             |
| Online RPC with envLane: null skips environment and provider lanes; resolveProviderLane only covers settled thread/interactive cases                          | command-router.ts executeOnlineRpcCommand / resolveProviderLane; commands.ts "provider.list_models" descriptor                                                                                                                                              | current main                         |
| provider.usage and codex.inference.complete / codex.voice.transcribe are host commands that do not go through the provider-bridge process                     | command-dispatch.ts getProviderUsage / completeCodexInference; settled codex.\* descriptors                                                                                                                                                                 | current main                         |
| JSON-RPC error responses reject the pending request; silent drop becomes a 30s JSON-RPC request timed out                                                     | runtime-json-rpc.ts sendJsonRpcRequest (default 30_000); docs/provider-bridge-protocol.md #853                                                                                                                                                              | PBP v1                               |
| Plan-pinned Claude SDK/CLI versions (not architecture)                                                                                                        | claude-code-continuation-execplan.md Surprises                                                                                                                                                                                                              | Agent SDK 0.3.197, CLI 2.1.197       |

### Amendment

In “Provider Bridge and Host Runtime”: keep additive PBP methods + new onlineRpc host commands + 130→131 + fixture/union updates. Strike any implication that CommandRouter already serializes non-thread provider mutations. Specify: (1) ensureProviderMaintenanceRuntime + resolveRuntimeBridgeLaunch; (2) capability/-32601 handled before requireProviderRequestPlan; (3) prepare/abort retryable: false via callHostOnlineRpc; (4) serialize prepare/abort inside dispatch/runtime (or add new onlineRpc lane keys), not via resolveProviderLane.

### Gaps

Claude SDK 0.3.197 / CLI 2.1.197 are plan-pin only and were not re-verified against npm this pass.

### Librarian Context Pack

## Context Pack: Narrowest BB path for non-thread provider session ops

### Key Answer

- Clone the existing **non-thread provider-process** seam, not plugin-host RPC and not `thread.*`. End-to-end today is: server `requireBridgeLaunchForProviderId` + `callHostRetryableOnlineRpc({ type: "provider.list_models", bridgeLaunch, … })` → daemon `onlineRpcHandlers["provider.list_models"]` → `resolveRuntimeBridgeLaunch` → `runtimeManager.ensureProviderMaintenanceRuntime` → `AgentRuntime.listModels` → `AdapterCommand` `{ type: "model/list" }` → `BRIDGE_REQUEST_METHODS.modelList` → plugin `bb.host` `experimental_providerBridge.handleLine`. [verified]
- Add **new typed host wire commands** in `hostDaemonCommandRegistry` (`transport: "onlineRpc"`, `envLane: null`, required `bridgeLaunch`). Reads: `retryable: true` + `callHostRetryableOnlineRpc`. Prepare/abort: `retryable: false` + `callHostOnlineRpc`. That is a server↔daemon wire change: bump `HOST_DAEMON_PROTOCOL_VERSION` **130 → 131**. [verified]
- Keep **Provider Bridge Protocol v1**. Additive methods + optional handshake capabilities with `.default(false)` / `.passthrough()` do not bump `PROVIDER_BRIDGE_PROTOCOL_VERSION`. Runtime must not send capability-gated methods unless advertised; older bridges already answer unknown methods with `-32601` (`METHOD_NOT_FOUND`). Do not overload `thread/fork`. [verified]
- Extend the closed unions in lockstep: `AdapterCommand`, `BRIDGE_REQUEST_METHODS`, `bridge-protocol-adapter.buildCommandPlan`, Claude `claudeCodeCommandSchema` / `decodeClaudeCodeJsonRpcRequest`, `OnlineRpcHandlerMap`, and the **hand-maintained** `session.ts` success-union + `ONLINE_RPC_RESPONSE_RESULT_FIXTURES` (keys must equal `HOST_DAEMON_ONLINE_RPC_COMMAND_TYPES`). [verified]
- **Do not use** `plugin.host.call` (PluginHostManager worker, not AgentRuntime; Claude exports only `experimental_providerBridge`), `provider.usage` / `codex.*` (daemon-local, not the bridge), or environment `thread.*` runtimes (those require a BB thread/env). Claude session interpretation stays in `plugins/provider-claude-code`. [verified]
- **Plan amendment:** CommandRouter provider process/session lanes exist only for settled `HostDaemonCommand` cases in `resolveProviderLane`. `provider.list_models` has `envLane: null` and **no** provider-lane serialization. Prepare/abort cannot assume router lanes; serialize in the handler/runtime (or add new onlineRpc lane keys). Also: `requireProviderRequestPlan` **throws** on adapter `noop` (`${capability} not advertised`) — missing-capability must become a typed unavailable result _before_ that helper. [verified]

### Evidence

| #   | Claim                                                                                                                                                                         | Source                                                                                                                                                                                                                                                                      | Version/Date                           | Status                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------- |
| 1   | Non-thread provider-process path is `provider.list_models` → `resolveRuntimeBridgeLaunch` → maintenance runtime → `listModels` → `model/list`                                 | `apps/server/src/services/system/execution-options.ts` `loadSystemProviderModels`; `apps/host-daemon/src/command-dispatch.ts` `onlineRpcHandlers["provider.list_models"]`; `apps/host-daemon/src/app.ts` `listModels`; `packages/agent-runtime/src/runtime.ts` `listModels` | host protocol 130                      | Verified                    |
| 2   | Every bridge-bound command carries required `bridgeLaunch` (`artifact` digest or `daemon-bundled`); artifact is fetched/hash-verified then run as the plugin `bb.host` bridge | `packages/host-daemon-contract/src/protocol.ts`; `commands.ts` `hostDaemonBridgeLaunchSchema`; `command-dispatch-support.ts` `resolveRuntimeBridgeLaunch`; `apps/server/src/services/system/provider-bridge-launch.ts`                                                      | 130                                    | Verified                    |
| 3   | `AdapterCommand` is a closed union; generic adapter maps `model/list` to `BRIDGE_REQUEST_METHODS.modelList`; `requireProviderRequestPlan` throws on non-`request` plans       | `packages/agent-runtime/src/provider-adapter.ts`; `bridge-protocol-adapter.ts` `buildCommandPlan`; `runtime.ts` `requireProviderRequestPlan`                                                                                                                                | current main                           | Verified                    |
| 4   | Bridge methods live in `BRIDGE_REQUEST_METHODS`; handshake capabilities default false + passthrough; unknown methods `-32601`; additive changes stay at PBP v1                | `packages/provider-bridge-protocol/src/requests.ts`; `handshake.ts`; `version.ts`; `errors.ts`; `docs/provider-bridge-protocol.md`; `test/protocol.test.ts`                                                                                                                 | `PROVIDER_BRIDGE_PROTOCOL_VERSION = 1` | Verified                    |
| 5   | New host commands require protocol bump; schemas are `.strict()`; enrolled old daemons cannot parse new types/fields                                                          | `AGENTS.md`; `packages/host-daemon-contract/src/protocol.ts` (`= 130`); `test/contract.test.ts` version comment + `expect(…).toBe(130)`                                                                                                                                     | 130                                    | Verified                    |
| 6   | Exhaustive online-RPC result fixtures must cover every command type; `session.ts` success union is a manual per-type list                                                     | `contract.test.ts` `ONLINE_RPC_RESPONSE_RESULT_FIXTURES` vs `HOST_DAEMON_ONLINE_RPC_COMMAND_TYPES`; `packages/host-daemon-contract/src/session.ts` `onlineRpcResponseSuccessSchemaFor(...)`                                                                                 | 130                                    | Verified                    |
| 7   | Claude unknown methods are explicit `-32601` via closed `claudeCodeCommandSchema`; plugin export is `experimental_providerBridge` only                                        | `plugins/provider-claude-code/src/bridge/commands.ts` `decodeClaudeCodeJsonRpcRequest`; `bridge.ts` `unknown_method` + `experimental_providerBridge`                                                                                                                        | current main                           | Verified                    |
| 8   | `plugin.host.call` is a generic `method`+`jsonValue` envelope routed to `PluginHostManager`, not AgentRuntime                                                                 | `commands.ts` `pluginHostCallCommandSchema`; `command-router.ts` `executeOnlineRpcCommand`; `command-dispatch.ts` throws if it reaches handlers                                                                                                                             | v124 envelope, still 130               | Verified                    |
| 9   | Online RPC with `envLane: null` skips environment and provider lanes; `resolveProviderLane` only covers settled thread/interactive cases                                      | `command-router.ts` `executeOnlineRpcCommand` / `resolveProviderLane`; `commands.ts` `"provider.list_models"` descriptor                                                                                                                                                    | current main                           | Verified                    |
| 10  | `provider.usage` and `codex.inference.complete` / `codex.voice.transcribe` are host commands that do **not** go through the provider-bridge process                           | `command-dispatch.ts` `getProviderUsage` / `completeCodexInference`; settled `codex.*` descriptors                                                                                                                                                                          | current main                           | Verified                    |
| 11  | JSON-RPC error responses reject the pending request; silent drop becomes a 30s `JSON-RPC request timed out: ${method}`                                                        | `runtime-json-rpc.ts` `sendJsonRpcRequest` (default `30_000`); `docs/provider-bridge-protocol.md` #853                                                                                                                                                                      | PBP v1                                 | Verified                    |
| 12  | Plan-pinned Claude SDK/CLI versions (not architecture)                                                                                                                        | execplan Surprises                                                                                                                                                                                                                                                          | Agent SDK **0.3.197**, CLI **2.1.197** | Search-only (plan pin only) |

```2328:2355:packages/agent-runtime/src/runtime.ts
    async listModels({ providerId, acpLaunchSpec, bridgeLaunch, cwd }) {
      await runtime.ensureProvider({
        providerId,
        ...(acpLaunchSpec !== undefined ? { acpLaunchSpec } : {}),
        ...(bridgeLaunch !== undefined ? { bridgeLaunch } : {}),
      });
      const proc = requireProviderProcess({
        processKey: resolveProviderProcessKey({
          ...(acpLaunchSpec !== undefined ? { acpLaunchSpec } : {}),
          ...(bridgeLaunch !== undefined ? { bridgeLaunch } : {}),
          providerId,
        }),
        providerId,
      });
      const command = requireProviderRequestPlan({
        commandType: "model/list",
        plan: proc.adapter.buildCommandPlan({
          type: "model/list",
          ...(cwd !== undefined ? { cwd } : {}),
        }),
        providerId,
      });
      const result = await sendCommand({
        proc,
        message: command,
        resultSchema: ignoredJsonRpcResultSchema,
      });
      return proc.adapter.parseModelListResult(result);
    },
```

```661:674:apps/host-daemon/src/command-dispatch.ts
  "provider.list_models": async (command, options) => {
    const bridgeLaunch = await resolveRuntimeBridgeLaunch(
      command.bridgeLaunch,
      options,
    );
    return (options.listModels ?? defaultListModels)({
      providerId: command.providerId,
      ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
      ...(command.acpLaunchSpec !== undefined
        ? { acpLaunchSpec: command.acpLaunchSpec }
        : {}),
      bridgeLaunch,
    });
  },
```

```1:12:packages/provider-bridge-protocol/src/version.ts
/**
 * The bb Provider Bridge Protocol version.
 *
 * Negotiated in both directions during `initialize`. Bump only for changes an
 * older bridge or runtime cannot tolerate: removing a method, changing the
 * meaning of an existing field, or tightening a previously lenient parse.
 * Additive changes (new optional capability, new method a bridge may not
 * implement, new notification the runtime may not understand) do NOT bump the
 * version — unknown methods answer -32601, unknown notifications are ignored,
 * and unknown capability fields pass through.
 */
export const PROVIDER_BRIDGE_PROTOCOL_VERSION = 1 as const;
```

### Gotchas

- **`requireProviderRequestPlan` vs capabilities:** `gate("threadArchive", …)` returns `{ kind: "noop", reason: "… not advertised" }`. `listModels` always `requireProviderRequestPlan`s. Session methods must map missing capability / `-32601` to a typed unavailable result; do not let the throw become a 30s hang or a 502.
- **`OnlineRpcHandlerMap` is exhaustive on `HostDaemonOnlineRpcCommandType`.** Adding a registry entry without a handler is a typecheck failure. `session.ts` success union is **not** generated — omit a variant and wire parse fails.
- **Claude decode union is closed.** `claudeCodeCommandSchema` currently has no session methods; until those literals are added, even a new handler never runs — `decodeClaudeCodeJsonRpcRequest` returns `unknown_method`. Claude `model/list` params are `z.object({})` (drops canonical `cwd`); do not copy that for session ops.
- **Maintenance runtime is not an environment runtime.** `ensureProviderMaintenanceRuntime` uses a daemon-data workspace and **drops** thread events. Prepare must not construct a live `ThreadSession` / `thread/fork`.
- **No onlineRpc provider-lane today.** Plan text that assumes CommandRouter will serialize prepare/abort against `model/list` is wrong; list_models is unsynchronized onlineRpc.
- **Counterexamples that look tempting and are wrong for this feature:** `plugin.host.call` (generic, no new command type, but host-worker lane); `provider.usage` / `codex.*` (host commands without a bridge); piggybacking fields onto `provider.list_models` (still a 130→131 bump because schemas are strict, and it conflates catalogs). Overloading `thread/fork` would be a PBP semantic break, not an additive v1 method.

### Confidence

| Claim area                                               | Level           | Basis                                                    |
| -------------------------------------------------------- | --------------- | -------------------------------------------------------- |
| model/list as the clone path                             | High confidence | server + daemon dispatch + runtime source + app.test     |
| New typed host commands + 130→131                        | High confidence | AGENTS.md + protocol.ts + contract.test pin              |
| Keep PBP v1 for additive methods                         | High confidence | version.ts + handshake tests + docs + Claude `-32601`    |
| Do not use plugin.host.call / daemon-local provider cmds | High confidence | router vs dispatch source; Claude export is bridge-only  |
| OnlineRpc has no provider mutation lanes                 | High confidence | CommandRouter source; list_models descriptor             |
| Claude SDK 0.3.197 API surface                           | Search-only     | execplan pin only; not re-verified against npm this pass |

### Sources

- Tools used: `search_tool`, `btca__listResources`, `read_file`, `list_dir`, `grep`
- Repos searched: the current BB repository snapshot; the [ExecPlan](../exec-plan.md) was consulted only for version pins.
- URLs scraped: none
- Total tool calls: 40

### Plan amendment (exact)

In “Provider Bridge and Host Runtime”: keep additive PBP methods + new onlineRpc host commands + 130→131 + fixture/union updates. Strike any implication that CommandRouter already serializes non-thread provider mutations. Specify: (1) `ensureProviderMaintenanceRuntime` + `resolveRuntimeBridgeLaunch`; (2) capability/`-32601` handled before `requireProviderRequestPlan`; (3) prepare/abort `retryable: false` via `callHostOnlineRpc`; (4) serialize prepare/abort inside dispatch/runtime (or add new onlineRpc lane keys), not via `resolveProviderLane`.

---

## bb-inert-history-timeline-search

### Verdict

amend-plan

### Key answer

Treat system/thread-imported and system/imported-message as unscoped system events (systemEventTypeValues, ThreadEventDataByType, unscopedSystemEventSchema with no providerThreadId, threadEventScopeDefinitionByType policy:"thread"). Persist events.provider_thread_id=NULL on both; identity recovery is column-based (latest non-null). Do not convert history into client/turn/requested, item/completed agentMessage, ConversationRow, or live turns—add first-class inert EventProjectionMessage and TimelineRow kinds. FTS: add imported_message to ThreadSearchSourceKind; leave both live FTS switches default []; the atomic publication command is the sole imported FTS owner via upsertThreadSearchSegments (sourceKey event:${seq}, sourceSeq seq). Keep import types out of THREAD_TIMELINE_EXCLUDED_EVENT_TYPES, getLatestThreadOutputEventRow, and listStoredConversationOutlineEventRows. Search deep-link already works for any non-title kind with sourceSeq.

### Evidence

| claim                                                                                                                                                                                                    | source                                                                                                                                                          | date/version             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| System events are a closed list; ThreadEventDataByType is a manual map of those types                                                                                                                    | packages/domain/src/thread-events.ts; packages/domain/src/provider-event.ts unscopedSystemEventSchema                                                           | repo checkout 2026-08-17 |
| System events do not carry providerThreadId; provider events do; event-decode returns undefined for all system types                                                                                     | packages/domain/src/provider-event.ts; packages/thread-view/src/event-decode.ts                                                                                 | repo checkout 2026-08-17 |
| Scope policy is Record<ThreadEventType> and tests require exact coverage of threadEventTypeValues                                                                                                        | packages/domain/src/thread-event-scope.ts; packages/domain/test/thread-event-scope.test.ts                                                                      | repo checkout 2026-08-17 |
| Stored decode injects column providerThreadId only when != null; system extras are stripped                                                                                                              | packages/domain/src/stored-thread-event.ts parseStoredThreadEvent; thread-data.ts                                                                               | repo checkout 2026-08-17 |
| Identity recovery uses latest non-null events.provider_thread_id                                                                                                                                         | packages/db/src/data/events.ts getStoredProviderThreadIdAtOrBeforeSequence, listThreadTurnInterruptionEventStates; packages/db/test/data/events.test.ts         | repo checkout 2026-08-17 |
| Daemon ingest resolveProviderIdentifiers is exhaustive and maps all system types to { providerThreadId: null }                                                                                           | apps/server/src/internal/events.ts; packages/host-daemon-contract/src/session.ts                                                                                | protocol 130             |
| Live FTS owners are two closed switches only for client/turn/requested, item/completed agentMessage, system/manager/user_message; others default []                                                      | packages/db/src/data/events.ts listThreadSearchSegmentsForStoredEventArgs / listThreadSearchSegmentsForThreadEvent; packages/db/test/data/thread-search.test.ts | repo checkout 2026-08-17 |
| insertEvents writes the column but does not upsert FTS; appendStoredThreadEventsInTransaction / appendDaemonEventsInTransaction do                                                                       | packages/db/src/data/events.ts insertEvents vs append paths                                                                                                     | repo checkout 2026-08-17 |
| Search kinds today are title, title_fallback, user_message, assistant_message, system_message; deep-link is any non-title match with sourceSeq                                                           | packages/domain/src/thread-search.ts; server-contract threadSearchMatchSchema; SidebarThreadSearchPanel.tsx getMessageMatchSeq                                  | repo checkout 2026-08-17 |
| Unknown event types are dropped unless debug raw events; ConversationRow is the live edit/fork/plugin surface                                                                                            | packages/thread-view/src/parse-operation-message.ts; build-event-projection.ts; ThreadTimelineRows.tsx                                                          | repo checkout 2026-08-17 |
| CLI bb thread show formats HTTP timeline rows via exhaustive row.kind; last-output and conversation-outline are closed allowlists; THREAD_TIMELINE_EXCLUDED_EVENT_TYPES already excludes thread/identity | apps/cli format-timeline-text.ts; getLatestThreadOutputEventRow; listStoredConversationOutlineEventRows; timeline-noise-events.ts                               | repo checkout 2026-08-17 |

### Amendment

Add closed-switch inventory to Milestone 1/6; do not treat “extend thread-view + events.ts” as sufficient. A1 systemEventTypeValues + ThreadEventDataByType both types + payloads. A2 unscopedSystemEventSchema both types, no providerThreadId. A3 thread-event-scope policy:"thread" + rationale. A4 event-decode.ts both switches return undefined. A5 resolveProviderIdentifiers { providerThreadId: null }. A6 both FTS switches leave default []. A7 publication command providerThreadId:null + upsertThreadSearchSegments only for consented imported text (sole imported FTS owner). A8 dedicated parse before unhandled sink in build-event-projection. A9 new inert EventProjectionMessage/convertMessage/isEventProjectionCallMessage kinds—not user/assistant-text/operation. A10 timelineRowSchema new inert kinds/systemKinds. A11 format-timeline-text, timeline-row-title, timeline-view, TimelineRowView render inert with no edit/steer/retry. A12 do not add to THREAD_TIMELINE_EXCLUDED_EVENT_TYPES. A13 do not add to last-output/outline allowlists. A14 ThreadSearchSourceKind += imported_message; regenerate plugin-sdk/template dts (PLUGIN_SDK_VERSION 0.4.8). A15 timeline-test-harness factories. Extend existing harnesses only: domain scope/stored/provider-event tests; events.test.ts + thread-search.test.ts; thread-view harness/timeline/parse/CLI snapshots; public-thread-data + public-thread-timeline-delta; ThreadTimelineRows.actions.test.tsx (no edit on inert; searchMessageSeq); app timeline fixtures; CLI thread-show + fixtures; publication/first-send withTestHarness (owned UUID, never source).

### Gaps

None that block routing. Librarian evidence is high-confidence across domain, db, thread-view, server, app, and CLI. Plan method (inert unscoped system events + null identity column + sole publication FTS owner) is the correct current method; the plan still underspecifies required closed switches A4–A15.

### Librarian Context Pack

## Context Pack: BB closed graphs for system/thread-imported and system/imported-message

### Key Answer

- Treat both types as **unscoped system events**: add them to `systemEventTypeValues`, `ThreadEventDataByType`, `unscopedSystemEventSchema` (no `providerThreadId` field), and `threadEventScopeDefinitionByType` with **`policy: "thread"`** plus a rationale. The completeness test in `packages/domain/test/thread-event-scope.test.ts` will fail until those maps stay 1:1 with `threadEventTypeValues`. [verified]
- Persist **`events.provider_thread_id = NULL`** on both import events. Identity recovery is **column-based**, not payload-based: `getStoredProviderThreadIdAtOrBeforeSequence` and `listThreadTurnInterruptionEventStates` take the latest non-null column. A later imported row with a source UUID would steal resume/first-send onto the source. Only the factual `thread/identity` event may write the owned UUID. Put source session/message IDs in JSON payload only. [verified]
- Do **not** convert history into `client/turn/requested`, `item/completed` `agentMessage`, conversation rows, or live turns. Add first-class **inert** `EventProjectionMessage` kinds and matching `TimelineRow` kinds (new `kind` or a dedicated non-conversation `systemKind`). `ConversationRow` attaches edit/fork/plugin actions; `parse-operation-message` currently returns `null` and the projector **silently drops** unknown types. [verified]
- FTS: add `imported_message` to `ThreadSearchSourceKind`. **Do not** add import types to `listThreadSearchSegmentsForStoredEventArgs` / `listThreadSearchSegmentsForThreadEvent` (live owners for `user_message` / `assistant_message` / `system_message` only). The atomic publication command is the **sole** imported FTS writer via `upsertThreadSearchSegments` (`sourceKey: event:${seq}`, `sourceSeq: seq`). `insertEvents` does not index. [verified]
- Search deep-link already works for any non-title kind with `sourceSeq`: `getMessageMatchSeq` + `searchMessageSeq` + `useScrollToSearchedMessage` match `sourceSeqStart..sourceSeqEnd`. Keep import events **out of** `THREAD_TIMELINE_EXCLUDED_EVENT_TYPES`, `getLatestThreadOutputEventRow`, and `listStoredConversationOutlineEventRows`. [verified]
- Closed switches the ExecPlan still underspecifies (exact amendments): (1) `event-decode.ts` `getEventProviderThreadId` / `getEventParentToolCallId` `assertNever`; (2) `apps/server/src/internal/events.ts` `resolveProviderIdentifiers` `never`; (3) two FTS switches stay default-`[]`; (4) dedicated parse **before** the unhandled sink in `build-event-projection.ts`; (5) `convertMessage` / `EventProjectionMessage` / `isEventProjectionCallMessage`; (6) `timelineRowSchema` + `format-timeline-text` + `timeline-row-title` + app `TimelineRowView`; (7) regenerate plugin-sdk dts (`PLUGIN_SDK_VERSION` 0.4.8). [verified]

### Evidence

| #   | Claim                                                                                                                                                      | Source                                                                                                                                             | Version/Date             | Status   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------- |
| 1   | System events are a closed list; `ThreadEventDataByType` is a manual map of those types                                                                    | `packages/domain/src/thread-events.ts`; `packages/domain/src/provider-event.ts` `unscopedSystemEventSchema`                                        | repo checkout 2026-08-17 | Verified |
| 2   | System events do not carry `providerThreadId`; provider events do                                                                                          | `provider-event.ts` comments + schemas; `thread-view/src/event-decode.ts` returns `undefined` for all system types                                 | same                     | Verified |
| 3   | Scope policy is a `Record<ThreadEventType, …>` and tests require exact coverage of `threadEventTypeValues`                                                 | `thread-event-scope.ts`; `packages/domain/test/thread-event-scope.test.ts`                                                                         | same                     | Verified |
| 4   | Stored decode injects column `providerThreadId` only when `!= null`; system extras are stripped                                                            | `stored-thread-event.ts` `parseStoredThreadEvent`; `thread-data.ts` passes `row.providerThreadId`                                                  | same                     | Verified |
| 5   | Identity recovery uses latest non-null `events.provider_thread_id`                                                                                         | `events.ts` `getStoredProviderThreadIdAtOrBeforeSequence`, `listThreadTurnInterruptionEventStates`; `packages/db/test/data/events.test.ts`         | same                     | Verified |
| 6   | Daemon ingest `resolveProviderIdentifiers` is exhaustive and maps all system types → `{ providerThreadId: null }`                                          | `apps/server/src/internal/events.ts`; envelope is `threadEventSchema` in `host-daemon-contract/src/session.ts`                                     | protocol 130             | Verified |
| 7   | Live FTS owners are two closed switches; only `client/turn/requested`, `item/completed` agentMessage, `system/manager/user_message`                        | `events.ts` `listThreadSearchSegmentsForStoredEventArgs` / `listThreadSearchSegmentsForThreadEvent`; `packages/db/test/data/thread-search.test.ts` | same                     | Verified |
| 8   | Title FTS is a separate owner; message FTS uses `sourceKey event:${seq}` + `sourceSeq`                                                                     | `threads.ts` `upsertThreadTitleSearchSegments` vs `buildThreadEventSearchSegment`                                                                  | same                     | Verified |
| 9   | `insertEvents` writes the column but does **not** upsert FTS; `appendStoredThreadEventsInTransaction` / `appendDaemonEventsInTransaction` do               | `events.ts` `insertEvents` vs append paths                                                                                                         | same                     | Verified |
| 10  | Search kinds today are `title`, `title_fallback`, `user_message`, `assistant_message`, `system_message`; deep-link is any non-title match with `sourceSeq` | `thread-search.ts`; `server-contract` `threadSearchMatchSchema`; `sidebarThreadSearch.ts`; `SidebarThreadSearchPanel.tsx` `getMessageMatchSeq`     | same                     | Verified |
| 11  | Unknown event types are dropped (not rendered) unless debug raw events                                                                                     | `parse-operation-message.ts` terminal `return null`; `build-event-projection.ts` unhandled sink                                                    | same                     | Verified |
| 12  | Conversation rows are live: edit/fork/plugin actions on `ConversationRow`                                                                                  | `ThreadTimelineRows.tsx` `canEditMessage` / `onEditMessage`                                                                                        | same                     | Verified |
| 13  | CLI `bb thread show` formats HTTP timeline rows via `formatThreadTimelineText`                                                                             | `apps/cli/src/commands/thread/show.ts`; `format-timeline-text.ts` exhaustive `row.kind`                                                            | same                     | Verified |
| 14  | Last-output and conversation-outline are closed allowlists that omit unknown system types                                                                  | `getLatestThreadOutputEventRow`; `listStoredConversationOutlineEventRows`                                                                          | same                     | Verified |
| 15  | `THREAD_TIMELINE_EXCLUDED_EVENT_TYPES` already excludes `thread/identity`; adding import types there would hide history                                    | `timeline-noise-events.ts`; `apps/server/.../timeline.ts` imports it                                                                               | same                     | Verified |

```16:35:packages/domain/src/thread-events.ts
export const systemEventTypeValues = [
  "client/thread/start",
  // ...
  "system/thread-provisioning",
  "system/provider-turn-watchdog",
] as const;
```

```628:631:packages/domain/src/provider-event.ts
 * Events originating from the server/system layer (not from a provider process).
 * These do NOT carry `providerThreadId`.
```

```136:144:packages/domain/src/stored-thread-event.ts
  return threadEventSchema.parse({
    ...omitStoredScopeFields(eventData),
    ...(args.providerThreadId != null
      ? { providerThreadId: args.providerThreadId }
      : {}),
    // ...
  });
```

```3070:3078:packages/db/src/data/events.ts
        isNotNull(events.providerThreadId),
        sql`${events.sequence} = (
          SELECT MAX(latest.sequence)
          FROM events AS latest
          WHERE latest.thread_id = ${events.threadId}
            AND latest.provider_thread_id IS NOT NULL
        )`,
```

```471:532:packages/db/src/data/events.ts
  switch (args.eventArgs.type) {
    case "client/turn/requested": /* user_message */
    case "item/completed": /* assistant_message if agentMessage */
    case "system/manager/user_message": /* system_message */
    default:
      return [];
  }
```

```13:62:packages/thread-view/src/event-decode.ts
    case "system/thread-provisioning":
    case "system/provider-turn-watchdog":
      return undefined;
    default:
      return assertNever(decoded);
```

```62:69:apps/app/src/components/sidebar/SidebarThreadSearchPanel.tsx
  for (const match of matches) {
    if (!isSidebarThreadTitleMatch(match) && match.sourceSeq !== null) {
      return match.sourceSeq;
    }
  }
```

### Gotchas

- **Column vs parsed event:** Zod system schemas strip an injected `providerThreadId`. Timeline decode would still look “system,” but resume/first-send would follow the **column**. Null on `events.provider_thread_id` is the safety invariant.
- **Two FTS owners if you “just add a case”:** Extending the live switches _and_ indexing in the publication command double-writes the same `threadId:sourceKind:sourceKey`. Plan D11/M6 must say: publication only; live switches stay `default: []`.
- **Silent timeline hole:** Without a dedicated parse in `build-event-projection` (before `parseErrorMessage` / debug sink), import events persist and search-hit but **never render**.
- **Do not reuse conversation / assistant-text / user:** `ConversationRow` is the live affordance surface (edit, fork, add-to-chat, plugin actions). Inert rows must be a new kind the app/CLI format as history.
- **Do not put import types in `THREAD_TIMELINE_EXCLUDED_EVENT_TYPES`:** that list is a read-side skip for identity/usage/diff noise; including imports would drop them from HTTP timeline windows.
- **Do not reuse `item/completed` agentMessage or `system/manager/user_message`:** those auto-FTS as `assistant_message`/`system_message` and become last-output / outline conversation. That is synthetic live history.
- **Plugin SDK:** `ThreadEventType` and `ThreadSearchSourceKind` are flattened into `packages/plugin-sdk/bundled-types` and `packages/templates/src/generated/plugin-sdk-dts.generated.ts` (SDK 0.4.8). Typecheck of plugins/templates fails until regenerated.
- **`insertEvents` is not a publication path for searchable history.** Tests that only `insertEvents` will not create FTS rows.
- Host protocol is **130** today (`packages/host-daemon-contract/src/protocol.ts`); import RPCs need a bump, but these two event types are core-persisted, not daemon-emitted.

### Confidence

| Claim area                                           | Level           | Basis                                                                 |
| ---------------------------------------------------- | --------------- | --------------------------------------------------------------------- |
| Event/scope/provider unions and null identity column | High confidence | domain schemas + events SQL + identity tests                          |
| FTS live owner vs publication owner                  | High confidence | two switches + append vs insert + thread-search tests                 |
| Timeline drop / live-affordance risk                 | High confidence | parse-operation null + ConversationRow + convertMessage `assertNever` |
| Search deep-link for new `imported_message`          | High confidence | title-only exclusion + seq-range scroll; no extra decoder             |
| Outline/last-output exclusion                        | High confidence | closed SQL allowlists; product intent is not live conversation        |
| Plugin-sdk dts regen                                 | High confidence | generated unions copy domain kinds                                    |

### Sources

- Tools used: `search_tool`, `btca__listResources`, `read_file`, `list_dir`, `grep`, `run_terminal_command` (`rg -a` on `events.ts` because of embedded `\0`)
- Repos searched: the current BB repository snapshot (`packages/domain`, `packages/db`, `packages/thread-view`, `packages/server-contract`, `packages/host-daemon-contract`, `apps/server`, `apps/app`, `apps/cli`).
- URLs scraped: none (local checkout; BTCA has no BB index)
- Total tool calls: 55

### ExecPlan amendments (required closed switches still missing)

Add this inventory to Milestone 1/6. Do not treat “extend thread-view + events.ts” as sufficient.

| #   | File / function                                                                                                                                    | Required case                                                                            | If missed                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| A1  | `packages/domain/src/thread-events.ts` `systemEventTypeValues` + `ThreadEventDataByType`                                                           | both types + payload schemas                                                             | compile/runtime parse fail                             |
| A2  | `packages/domain/src/provider-event.ts` `unscopedSystemEventSchema`                                                                                | both types, **no** `providerThreadId`                                                    | not a `ThreadEvent`                                    |
| A3  | `packages/domain/src/thread-event-scope.ts`                                                                                                        | `policy: "thread"` + rationale                                                           | scope test + `threadEventSchema` refine fail           |
| A4  | `packages/thread-view/src/event-decode.ts` both switches                                                                                           | return `undefined`                                                                       | `assertNever` typecheck fail                           |
| A5  | `apps/server/src/internal/events.ts` `resolveProviderIdentifiers`                                                                                  | `{ providerThreadId: null }`                                                             | `never` exhaustiveness fail                            |
| A6  | `packages/db/src/data/events.ts` **both** FTS switches                                                                                             | **leave default `[]`**                                                                   | dual FTS owner or live-kind pollution                  |
| A7  | Publication command                                                                                                                                | `providerThreadId: null` + `upsertThreadSearchSegments` only for consented imported text | unssearchable or identity theft                        |
| A8  | `packages/thread-view/src/parse-operation-message.ts` **or** new parser called from `build-event-projection.ts` **before** the null/unhandled sink | emit inert projection messages                                                           | persisted but invisible                                |
| A9  | `event-projection-message.ts` + `isEventProjectionCallMessage` + `convertMessage`                                                                  | new kinds; not `user` / `assistant-text` / `operation` reused as live work               | live affordances or `assertNever`                      |
| A10 | `packages/server-contract/src/thread-timeline.ts` row union                                                                                        | new inert kinds/systemKinds                                                              | HTTP decode fail                                       |
| A11 | `format-timeline-text.ts`, `timeline-row-title.ts`, `timeline-view.ts`, `ThreadTimelineRows.tsx` `TimelineRowView`                                 | format/render inert; no edit/steer/retry                                                 | CLI/app exhaustiveness or live chrome                  |
| A12 | `THREAD_TIMELINE_EXCLUDED_EVENT_TYPES`                                                                                                             | **do not add**                                                                           | history omitted from windows                           |
| A13 | `getLatestThreadOutputEventRow`, `listStoredConversationOutlineEventRows`                                                                          | **do not add**                                                                           | last-output/outline treat history as live conversation |
| A14 | `packages/domain/src/thread-search.ts` + plugin-sdk/template dts regen                                                                             | `imported_message`                                                                       | search contract / plugin types stale                   |
| A15 | `packages/thread-view/test/timeline-test-harness.ts`                                                                                               | factories for both event types                                                           | cannot extend projection tests                         |

**Harnesses/tests to extend (existing, do not invent duplicates):**

- `packages/domain/test/thread-event-scope.test.ts`, `stored-thread-event.test.ts`, `provider-event.test.ts`
- `packages/db/test/data/events.test.ts` (null latest provider; append paths), `thread-search.test.ts` (live write indexing + `sourceSeq`)
- `packages/thread-view/test/timeline-test-harness.ts`, `build-thread-timeline.test.ts`, `parse-operation-message.test.ts`, `timeline-cli-rendering.snapshots.test.ts`
- `apps/server/test/public/public-thread-data.test.ts`, `public-thread-timeline-delta.test.ts`
- `apps/app/src/components/thread/timeline/ThreadTimelineRows.actions.test.tsx` (no edit on inert; `searchMessageSeq` flash/scroll)
- `apps/app/src/test/fixtures/thread-timeline-rows.ts`
- `apps/cli/src/__tests__/command-output/thread-show.test.ts` + `command-output-fixtures.ts`
- Publication/first-send: `withTestHarness` + queued-command observers as already named in the plan (owned UUID, never source)

---

## claude-sdk-prepared-fork

### Verdict

plan-confirmed

### Key answer

Prepare with standalone forkSession(sourceId, { dir: sourceCwd, title: uniqueOpMarker }). It remaps the transcript, returns { sessionId }, and does not spawn Claude or start query(); do not call query(), startup(), or options.forkSession during prepare (no public session.start in 0.3.197). Persist the fork UUID immediately. On a lost response, scan full listSessions({ dir: sourceCwd }) paging until a short page and match customTitle === uniqueOpMarker (not summary alone): 1 hit reuse, 0 after a completed failure may fork once, 2+ or contradictory metadata stop. Snapshot getSessionInfo before and after and compare lastModified+fileSize; on change deleteSession(forkId, { dir: sourceCwd }), verify absence via getSessionInfo undefined AND listSessions, abort source_changed. Later query({ prompt, options: { resume: ownedId, cwd: sourceCwd } }) must use the source project/worktree lookup scope because CLI 2.1.197 predates 2.1.223 cross-directory resume. Readable history is getSessionMessages on the reconstructed active parentUuid chain (offset/limit after rebuild; default omits system/compact-boundary and pre-compaction off-chain lines). deleteSession throws if not found. Do not adopt the source UUID or write JSONL. No safer supported alternative to the operation-title marker.

### Evidence

| claim                                                                                                                                                       | source                                                                                                               | date/version                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| SDK 0.3.197 pins claudeCodeVersion 2.1.197                                                                                                                  | npm package.json and registry metadata for @anthropic-ai/claude-agent-sdk@0.3.197                                    | 0.3.197 / 2.1.197                  |
| Standalone forkSession copies/remaps the transcript, returns only { sessionId }, and does not start a live query                                            | sdk.d.ts JSDoc; platform.claude.com cookbook session browser fork_session(); sdk.mjs write path                      | 0.3.197; cookbook 2026-08-17       |
| listSessions/getSessionInfo/getSessionMessages/deleteSession/renameSession/tagSession are public standalone APIs; omitted dir searches all projects         | https://code.claude.com/docs/en/agent-sdk/typescript ; sdk.d.ts option comments                                      | docs 2026-08-17; package 0.3.197   |
| query resume/fork live path is options.resume plus optional options.forkSession; prompt required; distinct from standalone forkSession()                    | https://code.claude.com/docs/en/agent-sdk/sessions ; sdk.d.ts Options                                                | docs 2026-08-17; 0.3.197           |
| CLI/SDK resume before v2.1.223 is scoped to the current project directory and its git worktrees; 2.1.197 still behaves this way                             | https://code.claude.com/docs/en/sessions ; https://code.claude.com/docs/en/agent-sdk/sessions                        | cutoff 2.1.223; pin 2.1.197        |
| forkSession({ title }) persists a custom title; listSessions/getSessionInfo expose customTitle and display summary                                          | ForkSessionOptions.title in sdk.d.ts; official TS SDKSessionInfo; cookbook rename/fork title -> custom_title         | 0.3.197; docs 2026-08-17           |
| Returned customTitle can be last customTitle or last aiTitle; uniqueness is not enforced                                                                    | sdk.mjs title extraction (customTitle \|\| aiTitle); official CLI sessions (SDK/-p names are not uniqueness-checked) | 0.3.197; CLI docs current          |
| getSessionMessages rebuilds parentUuid chain and paginates after filter; default excludes system/compact boundaries; post-compaction only                   | sdk.d.ts JSDoc; https://code.claude.com/docs/en/agent-sdk/session-storage ; cookbook offset is chronological         | 0.3.197; docs 2026-08-17           |
| Only revision metadata is lastModified (fs mtime ms) plus optional fileSize; no hash/revision token                                                         | official TS SDKSessionInfo; sdk.mjs stat().mtime / size                                                              | 0.3.197                            |
| Local deleteSession throws if not found; store without delete is a no-op; cookbook treats it as hard delete                                                 | sdk.d.ts + sdk.mjs wR(); official session-storage delete contract; cookbook cleanup                                  | 0.3.197; docs 2026-08-17           |
| includeWorktrees defaults true on listSessions only; get/fork/delete expand worktrees whenever dir is set                                                   | ListSessionsOptions in sdk.d.ts; sdk.mjs Pn/gV always call worktree helper                                           | 0.3.197                            |
| Live official TS page omits includeSystemMessages and documents SessionMessage.type as user\|assistant only versus sdk.d.ts 0.3.197 user\|assistant\|system | https://code.claude.com/docs/en/agent-sdk/typescript vs published sdk.d.ts 0.3.197                                   | docs 2026-08-17 vs package 0.3.197 |

### Amendment

(none)

### Gaps

Search-only: exact numeric pagination defaults for negative/zero limit (sdk.mjs fz treats limit===0 as no cap; not restated in official prose). Search-only: no documented visibility delay between a just-written fork and listSessions. dir is project-encoding plus worktree scope, not string-equal cwd; mapping a fork to a non-worktree relocated path is unsafe. getSessionInfo undefined is not sole absence proof (sidechain or no extractable summary); getSessionMessages([]) is also ambiguous. Live TS docs lag 0.3.197 (includeSystemMessages, system message type, listSessions.offset/includeProgrammatic).

### Librarian Context Pack

## Context Pack: Safest supported prepared-fork lifecycle (Agent SDK 0.3.197 / CLI 2.1.197)

### Key Answer

- Use standalone `forkSession(sourceId, { dir: sourceCwd, title: uniqueOpMarker })` as prepare. It copies/remaps the transcript, returns `{ sessionId }`, and does **not** spawn Claude, send a prompt, or create a live `query()`. Do **not** call `query()`, `startup()`, or `options.forkSession: true` during prepare. There is no public `session.start` in 0.3.197 (V2 session API was removed in 0.3.142). [verified]
- Persist the returned fork UUID immediately. If that response is lost, reconcile **before** any second fork: `listSessions({ dir: sourceCwd })` with no small `limit`, match `customTitle === uniqueOpMarker` (do not match `summary` alone). 1 unique hit → reuse; 0 after a completed failure → may fork once; 2+ or contradictory metadata → stop. Titles are **not** unique keys; the marker is a BB convention, not provider lineage. [verified]
- **No amendment** to replace the operation-title marker. `tagSession` / `renameSession` are a second write and can leave an untitled fork. Pre-assigning a UUID via `query({ options: { resume, forkSession: true, sessionId } })` is not safer: it starts a live CLI. `forkSession({ title })` is the only atomic supported custom metadata written with the fork. [verified]
- Snapshot source `getSessionInfo(sourceId, { dir: sourceCwd })` immediately before and after `forkSession`. Compare `lastModified` + `fileSize` (the only supported revision tuple). If either changes, `deleteSession(forkId, { dir: sourceCwd })`, verify absence, and abort as `source_changed`. This is a race detector, not a lock; there is no content hash/revision field. [verified]
- Later `query({ prompt, options: { resume: ownedId, cwd: sourceCwd } })` must use the **source project/worktree lookup scope**. Bundled CLI **2.1.197 predates 2.1.223** cross-directory resume: `--resume` only searches the current project directory and its git worktrees. SDK list/get/fork/delete _can_ search all projects when `dir` is omitted; `query.resume` cannot. [verified]
- Readable history: `getSessionMessages(ownedId, { dir: sourceCwd, offset, limit, includeSystemMessages })` after reconstructing the **active parentUuid chain**. Offset/limit apply after that reconstruction. Default omits system/compact-boundary entries. Pre-compaction JSONL lines not on the chain are omitted. Paginate until a short page; keep `includeSystemMessages` stable across pages. [verified]
- Local `deleteSession` removes `{id}.jsonl` + `{id}/` and **throws if not found**. Success is `Promise<void>`, not a boolean. Verify with `getSessionInfo === undefined` **and** absence from `listSessions`; `getSessionMessages === []` is only supporting (also means missing/invalid). A store without `delete` is a documented no-op. Do not adopt the source UUID. Do not write JSONL. [verified]

### Evidence

| #   | Claim                                                                                                                                                                       | Source                                                                                                                        | Version/Date                               | Status                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------- |
| 1   | SDK 0.3.197 pins `claudeCodeVersion` 2.1.197                                                                                                                                | npm `package.json`; registry metadata for `@anthropic-ai/claude-agent-sdk@0.3.197`                                            | 0.3.197 / 2.1.197                          | Verified                    |
| 2   | Standalone `forkSession` copies transcript, remaps UUIDs, returns only `{ sessionId }`, does not start a live query                                                         | `sdk.d.ts` JSDoc; official cookbook `fork_session()` (“doesn’t run the agent”); `sdk.mjs` write path                          | 0.3.197; cookbook current as of 2026-08-17 | Verified                    |
| 3   | `listSessions` / `getSessionInfo` / `getSessionMessages` / `deleteSession` / `renameSession` / `tagSession` are public standalone APIs; `dir` omitted searches all projects | Official TS reference; `sdk.d.ts` option comments                                                                             | docs 2026-08-17; package 0.3.197           | Verified                    |
| 4   | `query` resume/fork live path is `options.resume` + optional `options.forkSession`; `prompt` required; distinct from standalone `forkSession()`                             | Official sessions guide; `sdk.d.ts` `Options`                                                                                 | docs 2026-08-17; 0.3.197                   | Verified                    |
| 5   | CLI/SDK resume before v2.1.223 is scoped to current project dir + git worktrees; 2.1.197 still behaves this way                                                             | Official CLI sessions page; official Agent SDK sessions page (“SDK versions that bundle an older CLI still behave this way”)  | cutoff 2.1.223; this pin 2.1.197           | Verified                    |
| 6   | `forkSession({ title })` persists a custom title; `listSessions`/`getSessionInfo` expose `customTitle` and display `summary`                                                | `ForkSessionOptions.title` in `sdk.d.ts`; official TS `SDKSessionInfo`; cookbook rename/fork title → `custom_title`           | 0.3.197; docs 2026-08-17                   | Verified                    |
| 7   | Returned `customTitle` can be last `customTitle` **or** last `aiTitle`; uniqueness is not enforced                                                                          | `sdk.mjs` title extraction (`customTitle` \|\| `aiTitle`); official CLI sessions (SDK/`-p` names are not uniqueness-checked)  | 0.3.197; CLI docs current                  | Verified                    |
| 8   | `getSessionMessages` rebuilds parentUuid chain, paginates after filter; default excludes system/compact boundaries; post-compaction only                                    | `sdk.d.ts` JSDoc; official session-storage (“post-compaction chain”; 503 raw → 18 messages); cookbook offset is chronological | 0.3.197; docs 2026-08-17                   | Verified                    |
| 9   | Only revision metadata is `lastModified` (fs mtime ms) + optional `fileSize`; no hash/revision token                                                                        | Official TS `SDKSessionInfo`; `sdk.mjs` `stat().mtime` / `size`                                                               | 0.3.197                                    | Verified                    |
| 10  | Local `deleteSession` throws if not found; store without `delete` is no-op; cookbook treats it as hard delete                                                               | `sdk.d.ts` + `sdk.mjs` `wR()`; official session-storage `delete` contract; cookbook cleanup                                   | 0.3.197; docs 2026-08-17                   | Verified                    |
| 11  | `includeWorktrees` defaults true on `listSessions` only; get/fork/delete expand worktrees whenever `dir` is set                                                             | `ListSessionsOptions` in `sdk.d.ts`; `sdk.mjs` `Pn`/`gV` always call worktree helper                                          | 0.3.197                                    | Verified                    |
| 12  | Live official TS page omits `includeSystemMessages` and documents `SessionMessage.type` as user\|assistant only                                                             | code.claude.com TS reference vs `sdk.d.ts` 0.3.197 (`'user' \| 'assistant' \| 'system'`)                                      | docs newer/stale vs package                | Verified (docs lag package) |

```630:661:/tmp/claude-agent-sdk-0.3.197-sdk.d.ts
/**
 * Fork a session into a new branch with fresh UUIDs.
 * ...
 * Forked sessions start without undo history (file-history snapshots are not
 * copied).
 */
export declare function forkSession(...): Promise<ForkSessionResult>;
export declare type ForkSessionOptions = SessionMutationOptions & {
    upToMessageId?: string;
    title?: string;
};
export declare type ForkSessionResult = { sessionId: string };
```

```text
# code.claude.com/docs/en/agent-sdk/sessions (Resume by ID)
Before v2.1.223, the lookup was scoped to the current project directory
and its git worktrees; SDK versions that bundle an older CLI still
behave this way.

# platform.claude.com cookbook session browser
fork_session() writes the new file and returns its ID. It doesn't run
the agent, so the fork sits on disk until you resume it with query().

# code.claude.com/docs/en/agent-sdk/session-storage
getSessionMessages({ sessionStore }) returns the linked message chain
the agent would see on resume. After auto-compaction, earlier turns
are replaced by a summary.
```

### Gotchas

- **Do not treat current CLI docs as this pin.** Live docs describe post-2.1.223 global resume. 0.3.197 still needs the source project/worktree `cwd` on `query({ resume })`. Listing without `dir` can find a session that resume from the wrong cwd cannot open.
- **`dir` ≠ exact string-equal `cwd`.** It is a project-encoding + worktree scope. `includeWorktrees: false` exists only on `listSessions`. Resume on 2.1.197 still includes worktrees. Mapping a fork to a non-worktree relocated path is unsafe.
- **Title recovery is discoverable, not exclusive.** Scan the full `listSessions({ dir })` result (page `offset`/`limit` until a short page). A small `limit: 10` can miss the fork. Match `customTitle`, then confirm `cwd`/time window; `summary` can be an AI title or first prompt.
- **`getSessionInfo` can be `undefined` even if a file exists** (sidechain, or no extractable summary). A titled fork should populate `summary` from the custom title; still do not treat undefined as “definitely absent” without `listSessions` + `getSessionMessages`.
- **`getSessionMessages([])` is ambiguous** (missing, invalid UUID, empty/malformed). Never use it as the sole existence or deletion proof.
- **Live TS docs are incomplete vs 0.3.197** (`includeSystemMessages`, `system` message type, `listSessions.offset` / `includeProgrammatic`). Trust the published `sdk.d.ts` for this pin.
- **`forkSession` is not a byte-copy** and does not copy file-history/undo or return source lineage. Concurrent writers on the source are not locked; mtime/size can collide on coarse filesystems.
- **Do not use `startup()` or empty-prompt `query({ resume, maxTurns: 0 })` to “warm” prepare** — those spawn the bundled CLI. Prepare stays file-level session APIs only.

### Confidence

| Claim area                                                                      | Level           | Basis                                                                               |
| ------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------- |
| Quiescent `forkSession` prepare (no query)                                      | High confidence | `sdk.d.ts` + cookbook + `sdk.mjs`                                                   |
| Title marker is the least-bad lost-response key; no safer supported alternative | High confidence | atomic `title` on fork vs second-write tag/rename vs live `query` UUID preassign    |
| CLI 2.1.197 resume = project + worktrees, not cross-directory                   | High confidence | official sessions + CLI pages, explicit pre-2.1.223 caveat                          |
| Active-chain / compaction / offset-after-rebuild                                | High confidence | `sdk.d.ts` + session-storage + `sdk.mjs` `pR`/`fz`                                  |
| Source revision via mtime+size only                                             | High confidence | official `SDKSessionInfo` + `sdk.mjs` stat path                                     |
| Title uniqueness / `customTitle` may include `aiTitle`                          | High confidence | `sdk.mjs` extraction + CLI uniqueness exceptions                                    |
| Exact numeric pagination defaults for negative/zero `limit`                     | Search-only     | `sdk.mjs` `fz` only (`limit===0` treated as no cap); not restated in official prose |
| How quickly a just-written fork is visible to `listSessions` on local FS        | Search-only     | implied by local file write; no documented visibility delay                         |

### Sources

- Tools used: `btca__listResources`, `btca__ask` (npm `@anthropic-ai/claude-agent-sdk@0.3.197` ×2), `firecrawl__firecrawl_search` ×3, `firecrawl__firecrawl_map` ×2, `firecrawl__firecrawl_scrape` ×5, `search_tool` ×3, `read_file`, `grep`, `run_terminal_command` (npm registry + unpkg `sdk.d.ts`/`package.json`)
- Repos searched: published npm package only (not the BB plan’s proposed method)
- URLs scraped: `https://code.claude.com/docs/en/agent-sdk/sessions`, `https://code.claude.com/docs/en/agent-sdk/typescript`, `https://code.claude.com/docs/en/agent-sdk/session-storage`, `https://code.claude.com/docs/en/sessions`, `https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser`, `https://docs.claude.com/en/agent-sdk/local-session-management` (redirects to Agent SDK overview; no extra local-session page)
- Total tool calls: 33

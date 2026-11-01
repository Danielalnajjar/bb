import {
  getLastExecutionOptions,
  getLastProviderThreadId,
} from "./thread-events.js";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  events,
  getEnvironment,
  getPromptSuggestionModeOverride,
  setPromptSuggestionModeOverride,
} from "@bb/db";
import type { DbConnection } from "@bb/db";
import {
  promptSuggestionTextSchema,
  THREAD_CONTEXT_CLEAR_OPERATION,
  type PromptSuggestionConfiguration,
  type PromptSuggestionMode,
  type PromptSuggestionState,
  type Thread,
  type ThreadEvent,
} from "@bb/domain";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { ApiError } from "../../errors.js";
import { requirePublicThread } from "../lib/entity-lookup.js";
import { runLiveHostCommand } from "../hosts/live-command.js";
import { requireThreadCommandEnvironment } from "./thread-command-environment.js";
import {
  buildExecutionOptions,
  prepareTurnSubmitCommandPayload,
} from "./thread-commands.js";
import { resolveThreadPluginAgentConfiguration } from "./thread-runtime-config.js";
import { withThreadExclusiveGuard } from "./thread-context-mutation-guard.js";

export const PROMPT_SUGGESTION_PROMPT =
  'Predict the next message this user would naturally type in this conversation. Match their wording and brevity, using the latest exchange and their stated intent. Predict their message rather than recommending a new task. Return only JSON with one key, "suggestion": a short message string, or null when no clear next message is supported. This is a prediction request, not permission to carry out the message or use tools.';

export function decodePromptSuggestion(text: string | null): string | null {
  try {
    const parsed = z
      .object({ suggestion: promptSuggestionTextSchema.nullable() })
      .strict()
      .safeParse(text === null ? null : JSON.parse(text));
    if (parsed.success) return parsed.data.suggestion;
  } catch {}
  throw new ApiError(
    502,
    "prompt_suggestion_failed",
    "Prompt suggestion returned an invalid response. Try again.",
    true,
  );
}

interface Source {
  requestId: string;
  turnId: string;
}
interface TransientSuggestion {
  key: string;
  text: string | null;
  dismissed: boolean;
  requestId: string | null;
  pending: Promise<PromptSuggestionState> | null;
  generation: number;
  cancel: (() => void) | null;
}
const stateByDb = new WeakMap<DbConnection, Map<string, TransientSuggestion>>();
function states(db: DbConnection): Map<string, TransientSuggestion> {
  let value = stateByDb.get(db);
  if (!value) {
    value = new Map();
    stateByDb.set(db, value);
  }
  return value;
}

export function promptSuggestionThreadEligible(
  thread: Thread,
  pluginAllows: boolean,
): boolean {
  return (
    pluginAllows &&
    !thread.parentThreadId &&
    !thread.sourceThreadId &&
    !thread.originKind &&
    !thread.lifecycleOwnerThreadId &&
    thread.visibility === "visible" &&
    !thread.archivedAt &&
    !thread.deletedAt
  );
}
function supported(providerId: string): boolean {
  return providerId === "codex" || providerId === "claude-code";
}
export function resolvePromptSuggestionMode(
  providerId: string,
  model: string,
  override: PromptSuggestionMode | null,
): PromptSuggestionMode {
  if (!supported(providerId)) return "off";
  return (
    override ??
    (providerId === "claude-code" &&
    (model === "fable" || /^claude-fable(?:-|$)/u.test(model))
      ? "button"
      : "automatic")
  );
}
function latestSource(db: DbConnection, threadId: string): Source | null {
  const accepted = db
    .select({
      turnId: events.turnId,
      data: events.data,
      sequence: events.sequence,
    })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "turn/input/accepted"),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  if (!accepted?.turnId) return null;
  const requested = db
    .select({ data: events.data })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "client/turn/requested"),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  const parsed = z
    .object({ clientRequestId: z.string().min(1) })
    .safeParse(JSON.parse(accepted.data));
  if (!parsed.success || !requested) return null;
  const request = z
    .object({ requestId: z.string().min(1) })
    .safeParse(JSON.parse(requested.data));
  if (
    !request.success ||
    request.data.requestId !== parsed.data.clientRequestId
  )
    return null;
  const latest = db
    .select({
      type: events.type,
      data: events.data,
      sequence: events.sequence,
      turnId: events.turnId,
    })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        or(
          inArray(events.type, [
            "client/turn/requested",
            "turn/completed",
            "thread/context/cleared",
            "thread/compacted",
          ]),
          and(
            eq(events.type, "system/operation"),
            sql`json_extract(${events.data}, '$.operation') = ${THREAD_CONTEXT_CLEAR_OPERATION}`,
          ),
        ),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  if (
    !latest ||
    latest.sequence <= accepted.sequence ||
    latest.type !== "turn/completed" ||
    latest.turnId !== accepted.turnId
  )
    return null;
  const completed = z
    .object({ status: z.literal("completed") })
    .safeParse(JSON.parse(latest.data));
  if (!completed.success) return null;
  return { requestId: parsed.data.clientRequestId, turnId: accepted.turnId };
}
export function resolvePromptSuggestionConfiguration(
  deps: Pick<AppDeps, "db">,
  thread: Thread,
  model: string,
  pluginAllows: boolean,
): PromptSuggestionConfiguration {
  return {
    automatic:
      promptSuggestionThreadEligible(thread, pluginAllows) &&
      resolvePromptSuggestionMode(
        thread.providerId,
        model,
        getPromptSuggestionModeOverride(deps.db, thread.id),
      ) === "automatic",
    prompt: PROMPT_SUGGESTION_PROMPT,
    sourceRequestId: latestSource(deps.db, thread.id)?.requestId ?? null,
  };
}
function notify(deps: Pick<AppDeps, "hub">, threadId: string): void {
  deps.hub.notifyThread(threadId, ["prompt-suggestion-changed"]);
}
export function invalidatePromptSuggestion(
  deps: Pick<AppDeps, "db" | "hub">,
  threadId: string,
  dismissed = false,
): void {
  const value = states(deps.db).get(threadId);
  if (!value) {
    notify(deps, threadId);
    return;
  }
  const cancel = value.cancel;
  value.cancel = null;
  value.generation += 1;
  value.text = null;
  value.pending = null;
  value.requestId = null;
  value.dismissed = dismissed;
  if (!dismissed) value.key = "";
  notify(deps, threadId);
  cancel?.();
}
async function current(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
) {
  const thread = requirePublicThread(deps.db, threadId);
  const execution = await buildExecutionOptions(deps, {}, { threadId });
  const environment = thread.environmentId
    ? getEnvironment(deps.db, thread.environmentId)
    : null;
  const pluginAllows = environment
    ? (
        await resolveThreadPluginAgentConfiguration(deps, {
          thread,
          model: execution.model,
          environment,
        })
      ).promptSuggestions
    : true;
  const eligible =
    supported(thread.providerId) &&
    promptSuggestionThreadEligible(thread, pluginAllows);
  const modeOverride = getPromptSuggestionModeOverride(deps.db, threadId);
  const mode = resolvePromptSuggestionMode(
    thread.providerId,
    execution.model,
    modeOverride,
  );
  const source = latestSource(deps.db, threadId);
  const key = JSON.stringify([
    thread.providerId,
    execution.model,
    mode,
    eligible,
    source,
  ]);
  let value = states(deps.db).get(threadId);
  if (!value || value.key !== key) {
    if (value) invalidatePromptSuggestion(deps, threadId);
    value = {
      key,
      text: null,
      dismissed: false,
      requestId: null,
      pending: null,
      generation: 0,
      cancel: null,
    };
    states(deps.db).set(threadId, value);
  }
  const busy =
    thread.status === "active" ||
    thread.status === "starting" ||
    thread.status === "stopping";
  if (
    (!eligible || mode === "off" || busy || !source) &&
    (value.text || value.pending)
  ) {
    invalidatePromptSuggestion(deps, threadId);
  }
  const state: PromptSuggestionState = {
    mode,
    modeOverride,
    eligible,
    sourceTurnId: source?.turnId ?? null,
    text: eligible && mode !== "off" && !busy ? value.text : null,
    pending: value.pending !== null,
  };
  return { thread, execution, state, source, value, busy };
}
export async function getPromptSuggestion(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
): Promise<PromptSuggestionState> {
  return (await current(deps, threadId)).state;
}
async function preparedCommand(
  deps: LoggedPendingInteractionWorkSessionDeps,
  thread: Thread,
) {
  const environment = await requireThreadCommandEnvironment(deps, { thread });
  const execution = await buildExecutionOptions(
    deps,
    {},
    { threadId: thread.id },
  );
  const prepared = await prepareTurnSubmitCommandPayload(deps, {
    thread,
    environment,
    execution,
    input: [],
    permissionEscalation: "deny",
    target: { mode: "auto", expectedTurnId: null },
  });
  return { environment, prepared };
}
async function sendPromptSuggestionConfiguration(
  deps: LoggedPendingInteractionWorkSessionDeps,
  thread: Thread,
  configuration: PromptSuggestionConfiguration,
): Promise<void> {
  const { environment, prepared } = await preparedCommand(deps, thread);
  await runLiveHostCommand(deps, {
    hostId: environment.hostId,
    timeoutMs: 30_000,
    command: {
      type: "thread.promptSuggestion.configure",
      threadId: thread.id,
      environmentId: environment.id,
      bridgeLaunch: prepared.bridgeLaunch,
      options: { ...prepared.options, promptSuggestions: configuration },
      resumeContext: prepared.resumeContext,
      configuration,
    },
  });
}

export async function synchronizePromptSuggestionEligibility(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
): Promise<void> {
  const snapshot = await current(deps, threadId);
  if (
    snapshot.busy ||
    !supported(snapshot.thread.providerId) ||
    !getLastProviderThreadId(deps, threadId)
  )
    return;
  const modelChanged =
    getLastExecutionOptions(deps, threadId)?.model !== snapshot.execution.model;
  if (!modelChanged && snapshot.state.eligible) return;
  invalidatePromptSuggestion(deps, threadId);
  await sendPromptSuggestionConfiguration(deps, snapshot.thread, {
    automatic: false,
    prompt: PROMPT_SUGGESTION_PROMPT,
    sourceRequestId: null,
  });
}

export async function configurePromptSuggestion(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
  mode: PromptSuggestionMode | null,
): Promise<PromptSuggestionState> {
  return withThreadExclusiveGuard(threadId, async () => {
    const before = await current(deps, threadId);
    if (before.busy)
      throw new ApiError(
        409,
        "invalid_request",
        "Thread is busy; retry after the turn completes",
      );
    invalidatePromptSuggestion(deps, threadId);
    if (
      supported(before.thread.providerId) &&
      getLastProviderThreadId(deps, threadId)
    ) {
      const configuration: PromptSuggestionConfiguration = {
        automatic:
          before.state.eligible &&
          resolvePromptSuggestionMode(
            before.thread.providerId,
            before.execution.model,
            mode,
          ) === "automatic",
        prompt: PROMPT_SUGGESTION_PROMPT,
        sourceRequestId: before.source?.requestId ?? null,
      };
      await sendPromptSuggestionConfiguration(
        deps,
        before.thread,
        configuration,
      );
    }
    setPromptSuggestionModeOverride(deps.db, threadId, mode);
    states(deps.db).delete(threadId);
    notify(deps, threadId);
    return getPromptSuggestion(deps, threadId);
  });
}
export async function requestPromptSuggestion(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
): Promise<PromptSuggestionState> {
  const initial = await current(deps, threadId);
  if (
    !initial.state.eligible ||
    initial.state.mode === "off" ||
    initial.busy ||
    !initial.source
  ) {
    throw new ApiError(
      409,
      "invalid_request",
      "Prompt suggestions need an eligible idle thread with a completed source turn",
    );
  }
  if (initial.value.pending) return initial.value.pending;
  if (initial.value.text !== null) return initial.state;
  const value = initial.value;
  const requestId = randomUUID();
  value.requestId = requestId;
  value.dismissed = false;
  const generation = value.generation;
  const source = initial.source;
  const operation = async (): Promise<PromptSuggestionState> => {
    try {
      const { environment, prepared } = await preparedCommand(
        deps,
        initial.thread,
      );
      const recheck = await current(deps, threadId);
      if (
        recheck.value !== value ||
        value.generation !== generation ||
        recheck.busy
      )
        return recheck.state;
      value.cancel = () => {
        void runLiveHostCommand(deps, {
          hostId: environment.hostId,
          timeoutMs: 10_000,
          command: {
            type: "thread.promptSuggestion.cancel",
            environmentId: environment.id,
            threadId,
            requestId,
          },
        }).catch((error: unknown) =>
          deps.logger.warn(
            { error, threadId },
            "Prompt suggestion cancellation failed",
          ),
        );
      };
      const result = await runLiveHostCommand(deps, {
        hostId: environment.hostId,
        timeoutMs: 40_000,
        command: {
          type: "thread.promptSuggestion.request",
          threadId,
          environmentId: environment.id,
          bridgeLaunch: prepared.bridgeLaunch,
          options: prepared.options,
          resumeContext: prepared.resumeContext,
          requestId,
          sourceTurnId: source.turnId,
          prompt: PROMPT_SUGGESTION_PROMPT,
        },
      });
      const after = await current(deps, threadId);
      if (
        after.value === value &&
        value.generation === generation &&
        !after.busy &&
        after.state.eligible &&
        after.state.mode !== "off" &&
        result.sourceTurnId === source.turnId
      ) {
        value.text = decodePromptSuggestion(result.text);
      }
    } catch (error) {
      const after = await current(deps, threadId);
      if (after.value !== value || value.generation !== generation)
        return after.state;
      invalidatePromptSuggestion(deps, threadId);
      throw error;
    } finally {
      if (value.generation === generation) {
        value.pending = null;
        value.requestId = null;
        value.cancel = null;
      }
      notify(deps, threadId);
    }
    return getPromptSuggestion(deps, threadId);
  };
  value.pending = operation();
  notify(deps, threadId);
  return value.pending;
}
export async function dismissPromptSuggestion(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
  sourceTurnId: string,
): Promise<PromptSuggestionState> {
  const snapshot = await current(deps, threadId);
  if (snapshot.source?.turnId === sourceTurnId)
    invalidatePromptSuggestion(deps, threadId, true);
  return getPromptSuggestion(deps, threadId);
}
export async function receivePromptSuggestion(
  deps: LoggedPendingInteractionWorkSessionDeps,
  event: Extract<ThreadEvent, { type: "thread/promptSuggestion/updated" }>,
): Promise<void> {
  const snapshot = await current(deps, event.threadId);
  if (
    !snapshot.state.eligible ||
    snapshot.state.mode !== "automatic" ||
    snapshot.busy ||
    snapshot.source?.requestId !== event.sourceRequestId ||
    snapshot.execution.model !== event.model ||
    snapshot.value.dismissed
  )
    return;
  try {
    snapshot.value.text =
      snapshot.thread.providerId === "codex"
        ? decodePromptSuggestion(event.text)
        : promptSuggestionTextSchema.parse(event.text);
  } catch {
    deps.logger.warn(
      { threadId: event.threadId, providerId: snapshot.thread.providerId },
      "Automatic prompt suggestion returned an invalid response",
    );
    return;
  }
  notify(deps, event.threadId);
}

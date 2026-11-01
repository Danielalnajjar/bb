import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { DynamicTool } from "@get-bb/plugin-sdk/provider-bridge";
import {
  buildSdkPermissionOptions,
  type SdkSessionOptions,
} from "./sdk-session.js";
import { buildBridgeMcpServer } from "./tool-proxy-mcp.js";
import { BB_BRIDGE_MCP_SERVER_NAME } from "../tool-classification.js";
import { claudeModelFallbackSystemMessageSchema } from "../schemas.js";

const TOOL_DENIAL = "Prompt predictions cannot execute tools.";
const MAX_NATIVE_SUGGESTION_LENGTH = 1000;
const MAX_PREDICTION_OUTPUT_LENGTH = 8000;
const REQUEST_TIMEOUT_MS = 15_000;

export function promptSuggestionText(value: string): string | null {
  const text = value.trim();
  return text.length > 0 && text.length <= MAX_NATIVE_SUGGESTION_LENGTH
    ? text
    : null;
}

export async function requestClaudePromptSuggestion(args: {
  sessionOptions: SdkSessionOptions;
  providerSessionId: string;
  model: string;
  dynamicTools: DynamicTool[];
  prompt: string;
  signal: AbortSignal;
}): Promise<string | null> {
  if (args.signal.aborted) return null;
  const controller = new AbortController();
  const options = args.sessionOptions;
  let attemptedTool = false;
  let cancelWait = (): void => {};
  let timeoutWait = (): void => {};
  const canceled = new Promise<null>((resolve, reject) => {
    cancelWait = () => resolve(null);
    timeoutWait = () =>
      reject(new Error("Prompt suggestion request timed out"));
  });
  let session: ReturnType<typeof query> | undefined;
  const close = (): void => {
    controller.abort();
    cancelWait();
    try {
      session?.close();
    } catch {}
  };
  const denyTool = (): void => {
    attemptedTool = true;
  };
  const predictionOptions: Options = {
    abortController: controller,
    cwd: options.cwd,
    systemPrompt: options.systemPrompt,
    ...buildSdkPermissionOptions({
      allowBypassPermissions: options.allowBypassPermissions,
      permissionMode: options.permissionMode,
    }),
    disallowedTools: options.disallowedTools,
    model: args.model,
    effort: options.effort,
    thinking: options.thinking,
    env: options.env,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
    plugins: options.plugins,
    extraArgs: options.extraArgs,
    additionalDirectories: options.additionalDirectories
      ? [...options.additionalDirectories]
      : [],
    sandbox: options.sandbox,
    settingSources: ["user", "project", "local"],
    settings: {
      ...(typeof options.settings === "object" ? options.settings : {}),
      disableAllHooks: true,
    },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async () => {
              denyTool();
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: TOOL_DENIAL,
                },
              };
            },
          ],
        },
      ],
    },
    resume: args.providerSessionId,
    forkSession: true,
    persistSession: false,
    promptSuggestions: false,
    maxTurns: 1,
    includePartialMessages: true,
    canUseTool: async () => {
      denyTool();
      return { behavior: "deny", message: TOOL_DENIAL };
    },
    ...(args.dynamicTools.length > 0
      ? {
          mcpServers: {
            [BB_BRIDGE_MCP_SERVER_NAME]: buildBridgeMcpServer(
              args.dynamicTools,
              async () => {
                denyTool();
                return { content: TOOL_DENIAL, isError: true };
              },
            ),
          },
        }
      : {}),
  };
  args.signal.addEventListener("abort", close, { once: true });
  const timeout = setTimeout(() => {
    timeoutWait();
    close();
  }, REQUEST_TIMEOUT_MS);
  try {
    if (args.signal.aborted) return null;
    session = query({ prompt: args.prompt, options: predictionOptions });
    const consume = async (): Promise<string | null> => {
      if (!session) throw new Error("Prompt suggestion session unavailable");
      let outputLength = 0;
      for await (const message of session) {
        if (args.signal.aborted) return null;
        if (
          message.type === "system" &&
          claudeModelFallbackSystemMessageSchema.safeParse(message).success
        )
          throw new Error("Prompt suggestion model fallback");
        if (message.type === "stream_event") {
          const event = message.event;
          if (
            event.type === "content_block_start" &&
            event.content_block.type === "tool_use"
          )
            throw new Error("Prompt suggestion attempted a tool");
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            outputLength += event.delta.text.length;
            if (outputLength > MAX_PREDICTION_OUTPUT_LENGTH)
              throw new Error("Prompt suggestion output exceeded the limit");
          }
        }
        if (
          message.type === "assistant" &&
          message.message.content.some((block) => block.type === "tool_use")
        ) {
          denyTool();
          throw new Error("Prompt suggestion attempted a tool");
        }
        if (
          message.type === "assistant" &&
          message.message.content.reduce(
            (length, block) =>
              length + (block.type === "text" ? block.text.length : 0),
            0,
          ) > MAX_PREDICTION_OUTPUT_LENGTH
        )
          throw new Error("Prompt suggestion output exceeded the limit");
        if (message.type === "result") {
          if (attemptedTool)
            throw new Error("Prompt suggestion attempted a tool");
          if (
            message.subtype !== "success" ||
            message.is_error ||
            typeof message.result !== "string"
          )
            throw new Error("Prompt suggestion SDK result failed");
          const raw = message.result.trim();
          if (raw.length === 0 || raw.length > MAX_PREDICTION_OUTPUT_LENGTH)
            throw new Error(
              "Prompt suggestion output was empty or exceeded the limit",
            );
          return raw;
        }
      }
      throw new Error("Prompt suggestion stream ended without a result");
    };
    return await Promise.race([consume(), canceled]);
  } catch (error) {
    if (args.signal.aborted) return null;
    throw error;
  } finally {
    clearTimeout(timeout);
    args.signal.removeEventListener("abort", close);
    close();
  }
}

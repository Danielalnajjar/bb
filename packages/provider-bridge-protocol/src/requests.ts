import {
  clientTurnRequestIdSchema,
  dynamicToolSchema,
  instructionModeSchema,
  promptInputSchema,
  promptSuggestionConfigurationSchema,
  promptSuggestionPromptSchema,
  promptSuggestionRawTextSchema,
  threadProviderCommandsStateSchema,
} from "@bb/domain";
import { z } from "zod";
import { bridgeExecutionOptionsSchema } from "./execution-options.js";

export const BRIDGE_REQUEST_METHODS = {
  initialize: "initialize",
  modelList: "model/list",
  commandList: "commands/list",
  providerHealth: "provider/health",
  providerUsage: "provider/usage",
  providerInstallationStatus: "provider/installation/status",
  providerInstallationRun: "provider/installation/run",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  threadFork: "thread/fork",
  threadStop: "thread/stop",
  threadDiscard: "thread/discard",
  threadNameSet: "thread/name/set",
  threadArchive: "thread/archive",
  threadUnarchive: "thread/unarchive",
  threadGoalClear: "thread/goal/clear",
  threadPromptSuggestionRequest: "thread/prompt-suggestion/request",
  threadPromptSuggestionCancel: "thread/prompt-suggestion/cancel",
  threadPromptSuggestionConfigure: "thread/prompt-suggestion/configure",
  turnStart: "turn/start",
  turnSteer: "turn/steer",
  skillsConfigure: "skills/configure",
} as const;

const sessionConstructionFields = {
  threadId: z.string().min(1),
  cwd: z.string().min(1),
  options: bridgeExecutionOptionsSchema,
  dynamicTools: z.array(dynamicToolSchema).optional(),
  disallowedTools: z.array(z.string().min(1)).optional(),
  instructionMode: instructionModeSchema,
};

export const modelListParamsSchema = z
  .object({
    cwd: z.string().min(1).optional(),
    envVars: z.record(z.string(), z.string()).optional(),
    selectedModel: z.string().min(1).optional(),
  })
  .passthrough();

export const commandListParamsSchema = z
  .object({ cwd: z.string().min(1) })
  .passthrough();

export const commandListResultSchema = threadProviderCommandsStateSchema;
export type CommandListResult = z.infer<typeof commandListResultSchema>;

export const threadStartParamsSchema = z
  .object({
    ...sessionConstructionFields,
    input: z.array(promptInputSchema).optional(),
  })
  .passthrough();

export const threadResumeParamsSchema = z
  .object({
    ...sessionConstructionFields,
    providerThreadId: z.string().min(1),
  })
  .passthrough();

export const threadForkParamsSchema = z
  .object({
    ...sessionConstructionFields,
    sourceProviderThreadId: z.string().min(1),
    sourceProviderCheckpointId: z.string().min(1).optional(),
  })
  .passthrough();

export const threadStopParamsSchema = z
  .object({
    threadId: z.string().min(1),
    providerThreadId: z.string().min(1),
    intent: z.enum(["interrupt", "release"]),
    activeTurnId: z.string().min(1).nullable(),
  })
  .passthrough();

const threadRefParams = z
  .object({
    threadId: z.string().min(1),
    providerThreadId: z.string().min(1),
  })
  .passthrough();

export const threadDiscardParamsSchema = threadRefParams;
export const threadArchiveParamsSchema = threadRefParams;
export const threadUnarchiveParamsSchema = threadRefParams;
export const threadGoalClearParamsSchema = threadRefParams;

export const threadNameSetParamsSchema = z
  .object({
    threadId: z.string().min(1),
    providerThreadId: z.string().min(1),
    title: z.string().min(1),
  })
  .passthrough();

const turnInputFields = {
  threadId: z.string().min(1),
  providerThreadId: z.string().min(1),
  input: z.array(promptInputSchema),
  clientRequestId: clientTurnRequestIdSchema,
  options: bridgeExecutionOptionsSchema,
};

export const turnStartParamsSchema = z.object(turnInputFields).passthrough();

export const turnSteerParamsSchema = z
  .object({
    ...turnInputFields,
    expectedTurnId: z.string().min(1),
  })
  .passthrough();

export const skillsConfigureRootSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    skills: z.array(
      z
        .object({
          name: z.string().min(1),
          description: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type SkillsConfigureRoot = z.infer<typeof skillsConfigureRootSchema>;

export const skillsConfigureParamsSchema = z
  .object({
    roots: z.array(skillsConfigureRootSchema),
  })
  .passthrough();

export const threadIdentityResultSchema = z
  .object({
    providerThreadId: z.string().min(1),
    sessionRestorable: z.boolean().optional(),
  })
  .passthrough();

export const promptSuggestionCancelParamsSchema = z.object({
  threadId: z.string().min(1),
  providerThreadId: z.string().min(1),
  requestId: z.string().min(1),
});
export const promptSuggestionRequestParamsSchema =
  promptSuggestionCancelParamsSchema.extend({
    sourceTurnId: z.string().min(1),
    prompt: promptSuggestionPromptSchema,
  });
export const promptSuggestionRequestResultSchema = z.object({
  sourceTurnId: z.string().min(1),
  text: promptSuggestionRawTextSchema.nullable(),
});
export const promptSuggestionConfigureParamsSchema = z.object({
  threadId: z.string().min(1),
  providerThreadId: z.string().min(1),
  configuration: promptSuggestionConfigurationSchema,
});
export type PromptSuggestionRequestParams = z.infer<
  typeof promptSuggestionRequestParamsSchema
>;
export type PromptSuggestionRequestResult = z.infer<
  typeof promptSuggestionRequestResultSchema
>;
export type PromptSuggestionCancelParams = z.infer<
  typeof promptSuggestionCancelParamsSchema
>;
export type PromptSuggestionConfigureParams = z.infer<
  typeof promptSuggestionConfigureParamsSchema
>;

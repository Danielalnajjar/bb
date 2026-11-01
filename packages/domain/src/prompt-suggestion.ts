import { z } from "zod";

export const promptSuggestionModeSchema = z.enum([
  "automatic",
  "button",
  "off",
]);
export type PromptSuggestionMode = z.infer<typeof promptSuggestionModeSchema>;

export const promptSuggestionPromptSchema = z
  .string()
  .min(1)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 4000,
    "Prediction prompt must be at most 4000 UTF-8 bytes",
  );
export const promptSuggestionRawTextSchema = z.string().max(8000);
export const promptSuggestionTextSchema = z.string().trim().min(1).max(1000);
export const promptSuggestionConfigurationSchema = z.object({
  automatic: z.boolean(),
  prompt: promptSuggestionPromptSchema,
  sourceRequestId: z.string().min(1).nullable(),
});
export type PromptSuggestionConfiguration = z.infer<
  typeof promptSuggestionConfigurationSchema
>;

export const promptSuggestionStateSchema = z.object({
  mode: promptSuggestionModeSchema,
  modeOverride: promptSuggestionModeSchema.nullable(),
  eligible: z.boolean(),
  sourceTurnId: z.string().nullable(),
  text: promptSuggestionTextSchema.nullable(),
  pending: z.boolean(),
});
export type PromptSuggestionState = z.infer<typeof promptSuggestionStateSchema>;

import { expect, it } from "vitest";
import {
  promptSuggestionConfigurationSchema,
  promptSuggestionStateSchema,
} from "../src/prompt-suggestion.js";

it("bounds the prediction prompt in UTF-8 bytes, not UTF-16 code units", () => {
  expect(
    promptSuggestionConfigurationSchema.safeParse({
      automatic: false,
      prompt: "é".repeat(2000),
      sourceRequestId: null,
    }).success,
  ).toBe(true);
  expect(
    promptSuggestionConfigurationSchema.safeParse({
      automatic: false,
      prompt: "é".repeat(2001),
      sourceRequestId: null,
    }).success,
  ).toBe(false);
});
it("does not admit blank or overlong text into the editable draft candidate", () => {
  const state = {
    mode: "button",
    modeOverride: null,
    eligible: true,
    sourceTurnId: "turn-1",
    pending: false,
  };
  expect(
    promptSuggestionStateSchema.safeParse({ ...state, text: "  " }).success,
  ).toBe(false);
  expect(
    promptSuggestionStateSchema.safeParse({ ...state, text: "x".repeat(1001) })
      .success,
  ).toBe(false);
  expect(
    promptSuggestionStateSchema.safeParse({ ...state, text: null }).success,
  ).toBe(true);
});

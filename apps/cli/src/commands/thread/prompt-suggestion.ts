import { Command } from "commander";
import { promptSuggestionModeSchema } from "@bb/domain";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { outputJson, requireThreadIdOrSelf } from "../helpers.js";

interface Options {
  self?: boolean;
  json?: boolean;
  sourceTurn?: string;
}

export function registerPromptSuggestionCommands(
  parent: Command,
  getUrl: () => string,
): void {
  const group = parent
    .command("prompt-suggestion")
    .description("Read and control transient next-user-prompt suggestions");
  for (const operation of ["get", "request", "dismiss"] as const) {
    const command = group
      .command(`${operation} [id]`)
      .option("--self", "Use the current thread")
      .option("--json", "Print machine-readable JSON output");
    if (operation === "dismiss")
      command.requiredOption(
        "--source-turn <id>",
        "The completed BB turn whose suggestion to dismiss",
      );
    command.action(
      action(async (id: string | undefined, options: Options) => {
        const threadId = requireThreadIdOrSelf(id, options);
        const api =
          createCliBbSdk(getUrl()).threads.experimental_promptSuggestions;
        const state =
          operation === "dismiss"
            ? await api.dismiss({ threadId, sourceTurnId: options.sourceTurn! })
            : await api[operation]({ threadId });
        if (outputJson(options, state)) return;
        console.log(
          state.text ??
            `${state.mode}${state.pending ? " (pending)" : ""}${state.eligible ? "" : " (ineligible)"}`,
        );
      }),
    );
  }
  group
    .command("mode <mode> [id]")
    .description(
      "Choose automatic, button, off, or default to reset the override",
    )
    .option("--self", "Use the current thread")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (mode: string, id: string | undefined, options: Options) => {
        const state = await createCliBbSdk(
          getUrl(),
        ).threads.experimental_promptSuggestions.configure({
          threadId: requireThreadIdOrSelf(id, options),
          mode:
            mode === "default" ? null : promptSuggestionModeSchema.parse(mode),
        });
        if (outputJson(options, state)) return;
        console.log(state.mode);
      }),
    );
}

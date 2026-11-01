import { expect, it } from "vitest";
import { createMigratedConnection } from "../../src/testing.js";
import {
  createProject,
  createThread,
  getPromptSuggestionModeOverride,
  noopNotifier,
  setPromptSuggestionModeOverride,
  threadPromptSuggestionPreferences,
  upsertHost,
} from "../../src/index.js";

it("stores only explicit thread mode preferences and removes a reset instead of retaining a default snapshot", () => {
  const db = createMigratedConnection();
  try {
    const host = upsertHost(db, noopNotifier, { name: "host" });
    const { project } = createProject(db, noopNotifier, {
      name: "project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/prediction-test",
      },
    });
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    expect(getPromptSuggestionModeOverride(db, thread.id)).toBeNull();
    setPromptSuggestionModeOverride(db, thread.id, "button");
    expect(db.select().from(threadPromptSuggestionPreferences).all()).toEqual([
      { threadId: thread.id, mode: "button" },
    ]);
    setPromptSuggestionModeOverride(db, thread.id, "off");
    expect(getPromptSuggestionModeOverride(db, thread.id)).toBe("off");
    setPromptSuggestionModeOverride(db, thread.id, null);
    expect(db.select().from(threadPromptSuggestionPreferences).all()).toEqual(
      [],
    );
  } finally {
    db.$client.close();
  }
});

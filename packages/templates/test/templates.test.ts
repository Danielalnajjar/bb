import { describe, expect, it } from "vitest";
import {
  renderTemplate,
  type TemplateId,
  type TemplateVariables,
} from "../src/index.js";
import { templateDefinitions } from "../src/generated/templates.generated.js";

describe("@bb/templates", () => {
  it("keeps the restart prompt unchanged unless a receipt check is requested", () => {
    const details =
      "while you were working. Check whether your last step finished.";
    const unchanged = `[bb system]\n\nbb restarted ${details}`;
    expect(renderTemplate("systemMessageRestartResume", { details })).toBe(
      unchanged,
    );
    expect(
      renderTemplate("systemMessageRestartResume", {
        details,
        receiptBacked: "",
      }),
    ).toBe(unchanged);
    expect(
      renderTemplate("systemMessageRestartResume", {
        details,
        receiptBacked: "true",
      }),
    ).toBe(
      `${unchanged}\n\nBefore continuing, check \`git status\` and the receipt named in your existing instructions.`,
    );
  });

  it("documents project creation machine routing", () => {
    const guide = renderTemplate("bbGuideProjects", {});

    expect(guide).toContain("bb project create --name");
    expect(guide).toContain("--machine <id-or-name>");
    expect(guide).toContain("--host <id-or-name>");
    expect(guide).toContain("local CLI machine fallback");
  });

  it("documents project-aware thread references", () => {
    const guide = renderTemplate("bbGuideThreadInspection", {});

    expect(guide).toContain("@thread:thr_abc123");
    expect(guide).toContain("do not construct thread URLs manually");
  });

  it("renders agent thread messages without inline reply guidance", () => {
    const rendered = renderTemplate("agentThreadMessage", {
      senderThreadId: "thr_sender",
      messageText: "Please check the failing test.",
    });

    expect(rendered).toBe(
      [
        "[bb message from thread:thr_sender]",
        "",
        "Please check the failing test.",
      ].join("\n"),
    );
  });

  it("renders child thread needs-attention messages with blocker summaries", () => {
    const rendered = renderTemplate("systemMessageChildThreadNeedsAttention", {
      blockerSummary: [
        "Blocked on command approval:",
        "Command: git push",
      ].join("\n"),
      threadMention: "@thread:thr_child",
    });

    expect(rendered).toBe(
      [
        "[bb system]",
        "",
        "@thread:thr_child needs help.",
        "Blocked on command approval:",
        "Command: git push",
        "",
        "Review the blocker. If you can resolve it from existing context, reply to the thread with guidance. Otherwise, ask the user for the missing decision.",
      ].join("\n"),
    );
  });

  it("renders child thread ownership messages", () => {
    expect(
      renderTemplate("systemMessageThreadOwnershipAssigned", {
        threadMention: "@thread:thr_child",
      }),
    ).toBe(
      [
        "[bb system]",
        "",
        "@thread:thr_child is now a child of this thread.",
      ].join("\n"),
    );
    expect(
      renderTemplate("systemMessageThreadOwnershipRemoved", {
        threadMention: "@thread:thr_child",
      }),
    ).toBe(
      [
        "[bb system]",
        "",
        "@thread:thr_child is no longer a child of this thread.",
      ].join("\n"),
    );
  });

  it("renders all templates without error", () => {
    const templates = templateDefinitions;

    const placeholderVariables: Record<string, Record<string, string>> = {};
    for (const template of templates) {
      const vars: Record<string, string> = {};
      for (const varName of Object.keys(template.variables)) {
        vars[varName] = `__placeholder_${varName}__`;
      }
      placeholderVariables[template.id] = vars;
    }

    for (const template of templates) {
      const vars = placeholderVariables[
        template.id
      ] as TemplateVariables[TemplateId];
      expect(() =>
        renderTemplate(template.id as TemplateId, vars),
      ).not.toThrow();
    }
  });
});

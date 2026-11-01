import { describe, expect, it } from "vitest";
import {
  createDesktopAboutDialogOptions,
  createDesktopAboutPanelOptions,
  type DesktopAboutFacts,
} from "../src/desktop-about-panel.js";

describe("desktop About build provenance", () => {
  it.each(["", "prompt-suggestions"])(
    "identifies the distribution without replacing its source commit (custom: %s)",
    (customBuild) => {
      const facts: DesktopAboutFacts = {
        applicationName: "bb",
        buildDate: "2026-11-01T00:00:00.000Z",
        channel: "latest",
        commit: "f1b3a5b7c9d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8",
        customBuild,
        electronVersion: "44.9.3",
        osArch: "arm64",
        osRelease: "26.0.0",
        osType: "Darwin",
        platform: "darwin",
        pluginSdkVersion: "0.6.104",
        version: "0.48.1",
      };
      const dialog = createDesktopAboutDialogOptions(
        facts,
        Date.parse(facts.buildDate),
      );
      const panel = createDesktopAboutPanelOptions(facts);

      for (const details of [dialog.detail, panel.credits]) {
        expect(details).toContain(`Commit: ${facts.commit}`);
        if (customBuild) {
          expect(details).toContain(
            "Build Type: Custom (prompt-suggestions; latest channel)",
          );
          expect(details).toContain(
            "Updates: Maintenance-managed; official updates disabled",
          );
        } else {
          expect(details).toContain("Build Type: Stable");
          expect(details).not.toContain("Custom");
          expect(details).not.toContain("Updates:");
        }
      }
    },
  );
});

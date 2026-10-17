import { expect, it } from "vitest";
import type { TimelineToolWorkRow } from "@bb/server-contract";
import { deferSettledTimelineRow } from "./timeline-deferred-content.js";

it("keeps bounded BB directive results available to a collapsed-history client", () => {
  const row: TimelineToolWorkRow = {
    id: "graphic", threadId: "thr_main", turnId: "turn_1",
    sourceSeqStart: 1, sourceSeqEnd: 1, startedAt: 1, createdAt: 1,
    kind: "work", workKind: "tool", status: "completed",
    callId: "graphic", toolName: "bb:render_html", toolArgs: null,
    completedAt: 2, approvalStatus: null,
    output: `::graphic{value="${"x".repeat(1_100)}"}`,
  };
  expect(deferSettledTimelineRow(row)).toBe(row);
  expect(deferSettledTimelineRow({ ...row, toolName: "external:render_html" }))
    .toMatchObject({ output: "", contentDeferred: true });
  expect(deferSettledTimelineRow({ ...row, output: `Note\n${row.output}` }))
    .toMatchObject({ output: "", contentDeferred: true });
});

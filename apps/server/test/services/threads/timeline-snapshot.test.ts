import { describe, expect, it } from "vitest";
import { deleteThreadEventSuffixInTransaction } from "@bb/db";
import {
  bindTimelineCursor,
  resolveTimelineSnapshot,
} from "../../../src/services/threads/timeline-snapshot.js";
import {
  appendRows,
  withTestThread,
} from "../../helpers/timeline-cache-fixture.js";

describe("timeline snapshots", () => {
  it("rejects a pre-edit snapshot even when its older-page anchor survives", () => {
    withTestThread((testThread) => {
      const { db, thread } = testThread;
      const oldMaxSeq = appendRows(testThread, [
        { type: "turn/started", turnId: "turn-1" },
        {
          type: "turn/completed",
          turnId: "turn-1",
          data: { status: "completed" },
        },
        { type: "turn/started", turnId: "turn-2" },
      ]);
      const latestPage = { kind: "latest", segmentLimit: 20 } as const;
      const snapshot = resolveTimelineSnapshot(
        db,
        thread,
        latestPage,
        "surface",
      );
      const cursor = bindTimelineCursor(
        { anchorSeq: 1, anchorId: "timeline-window:1" },
        snapshot,
      );
      if (cursor === null) throw new Error("Expected an older-page cursor");
      const olderPage = {
        kind: "older",
        beforeCursor: cursor,
        segmentLimit: 20,
      } as const;
      expect(resolveTimelineSnapshot(db, thread, olderPage, "surface")).toEqual(
        snapshot,
      );
      db.transaction((tx) => {
        deleteThreadEventSuffixInTransaction(tx, {
          cutoffSequence: 3,
          oldMaxSequence: oldMaxSeq,
          threadId: thread.id,
        });
      });
      expect(() =>
        resolveTimelineSnapshot(db, thread, olderPage, "surface"),
      ).toThrow(
        "Timeline pagination cursor is no longer available; reload the latest page",
      );
      const refreshed = resolveTimelineSnapshot(
        db,
        thread,
        latestPage,
        "surface",
      );
      expect(refreshed.maxSeq).toBe(2);
      const refreshedCursor = bindTimelineCursor(cursor, refreshed);
      if (refreshedCursor === null)
        throw new Error("Expected a refreshed cursor");
      expect(
        resolveTimelineSnapshot(
          db,
          thread,
          {
            ...olderPage,
            beforeCursor: refreshedCursor,
          },
          "surface",
        ),
      ).toEqual(refreshed);
    });
  });
});

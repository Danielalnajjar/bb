import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection, getThread, listQueuedThreadMessages } from "@bb/db";
import { listEvents } from "@bb/db/testing";
import { turnRequestEventDataSchema } from "@bb/domain";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import {
  runPeriodicSweeps,
  runStartupRecoverySweep,
} from "../../src/services/system/periodic-sweeps.js";
import {
  listQueuedThreadCommands,
  registerTestHostRpcCapture,
} from "../helpers/commands.js";
import { createTestDb, withTestHarness } from "../helpers/test-app.js";

const cutReceipt = z.object({
  childId: z.string(),
  hostId: z.string(),
  parentId: z.string(),
  sessionId: z.string(),
  now: z.number(),
});

async function killAtNoticeBoundary(
  dataDir: string,
  cut: "before notice" | "after notice",
) {
  const child = fork(
    fileURLToPath(new URL("./fixtures/child-notice-crash.ts", import.meta.url)),
    [dataDir, cut],
    {
      execArgv: ["--conditions=source", "--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const exited = once(child, "exit");
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  };
  onTestFinished(stop);
  try {
    const receipt = await Promise.race([
      once(child, "message").then(([message]) => cutReceipt.parse(message)),
      exited.then(([code, signal]) => {
        throw new Error(
          `Crash fixture exited before reaching its boundary: ${code ?? signal}`,
        );
      }),
    ]);
    expect(child.kill("SIGKILL")).toBe(true);
    expect(await exited).toEqual([null, "SIGKILL"]);
    return receipt;
  } finally {
    await stop();
  }
}

afterEach(() => vi.useRealTimers());

for (const cut of ["before notice", "after notice"] as const) {
  const testCut = cut === "before notice" ? it.fails : it;
  testCut(
    `T3 roadmap §2 D2: delivers exactly one child result after SIGKILL ${cut}`,
    async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "bb-child-notice-crash-"));
      onTestFinished(() => rm(dataDir, { recursive: true }));
      const dbPath = join(dataDir, "bb.db");
      const template = createTestDb();
      try {
        await writeFile(dbPath, template.$client.serialize());
      } finally {
        template.$client.close();
      }
      const { childId, hostId, parentId, sessionId, now } =
        await killAtNoticeBoundary(dataDir, cut);

      const db = createConnection(dbPath);
      try {
        await withTestHarness({ storage: { dataDir, db } }, async (harness) => {
          vi.useFakeTimers({ toFake: ["Date"], now });
          const notices = () =>
            listEvents(db, { threadId: parentId })
              .filter((row) => row.type === "client/turn/requested")
              .map((row) =>
                turnRequestEventDataSchema.parse(JSON.parse(row.data)),
              )
              .filter((turn) => turn.initiator === "system");
          expect(getThread(db, childId)?.status).toBe("idle");
          expect(
            listEvents(db, { threadId: childId }).filter(
              (row) => row.type === "turn/completed",
            ),
          ).toHaveLength(1);
          expect(notices()).toEqual([]);
          const queuedAtCrash = listQueuedThreadMessages(db, parentId);
          if (cut === "after notice") {
            expect(queuedAtCrash).toMatchObject([
              { state: "scheduled", sendAt: expect.any(Number) },
            ]);
            expect(queuedAtCrash[0]?.content).toContain(
              "Recovered the requested result.",
            );
            expect(queuedAtCrash[0]?.sendAt).toBeGreaterThan(now);
          }

          await runStartupRecoverySweep(harness.deps);
          registerTestHostRpcCapture(harness.deps, { hostId, sessionId });
          vi.setSystemTime(now + 2_001);
          const sweepDeps = {
            ...harness.deps,
            pluginSchedules: harness.pluginService,
            plugins: harness.pluginService,
          };
          await runPeriodicSweeps(sweepDeps);
          await runPeriodicSweeps(sweepDeps);

          expect({
            results: notices().map((turn) => ({
              kind: turn.systemMessageKind,
              child: turn.systemMessageSubject,
              input: JSON.stringify(turn.input).includes(
                "Recovered the requested result.",
              ),
            })),
            submissions: listQueuedThreadCommands(
              harness,
              "turn.submit",
              parentId,
            ).length,
            queued: listQueuedThreadMessages(db, parentId),
          }).toMatchObject({
            results: [
              {
                kind: "child-completed",
                child: { threadId: childId },
                input: true,
              },
            ],
            submissions: 1,
            queued: [],
          });
        });
      } finally {
        db.$client.close();
      }
    },
  );
}

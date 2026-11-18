import { join } from "node:path";
import { mock } from "node:test";
import { createConnection } from "@bb/db";
import { turnScope } from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { createDeferredPromise } from "@bb/test-helpers";
import { internalAuthHeaders } from "../../helpers/commands.js";
import {
  seedThread,
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../../helpers/seed.js";
import { createTestAppHarness } from "../../helpers/test-app.js";

const [dataDir, cut] = process.argv.slice(2);
if (
  dataDir === undefined ||
  (cut !== "before notice" && cut !== "after notice") ||
  process.send === undefined
) {
  throw new Error(
    "Expected a data directory, a crash boundary and an IPC channel",
  );
}
const db = createConnection(join(dataDir, "bb.db"));
const harness = await createTestAppHarness({ storage: { dataDir, db } });
const {
  host,
  session,
  project,
  environment,
  thread: parent,
} = seedThreadFixture(harness, {
  session: { id: "parent-notice-host" },
  environment: { path: dataDir },
});
seedThreadRuntimeState(harness.deps, {
  threadId: parent.id,
  environmentId: environment.id,
  providerThreadId: "parent-provider-thread",
});
const child = seedThread(harness.deps, {
  projectId: project.id,
  environmentId: environment.id,
  parentThreadId: parent.id,
  status: "active",
  title: "Worker child",
});
const turnId = "finished-work";
const providerThreadId = "child-provider-thread";
const scope = turnScope(turnId);
seedTurnStarted(harness.deps, {
  threadId: child.id,
  environmentId: environment.id,
  providerThreadId,
  turnId,
});

const noticeWritten = createDeferredPromise<void>();
harness.hub.onChangedMessage((message) => {
  if (
    message.entity === "thread" &&
    message.id === parent.id &&
    message.changes.includes("queue-changed")
  ) {
    noticeWritten.resolve();
  }
});
mock.timers.enable({
  apis: ["Date", "setImmediate", "setTimeout"],
  now: Date.now(),
});
const response = await harness.app.request("/internal/session/events", {
  method: "POST",
  headers: internalAuthHeaders(harness, { hostId: host.id }),
  body: JSON.stringify({
    sessionId: session.id,
    eventGroups: groupHostDaemonEvents([
      {
        threadId: child.id,
        event: {
          type: "item/completed",
          threadId: child.id,
          providerThreadId,
          scope,
          item: {
            id: "result",
            type: "agentMessage",
            text: "Recovered the requested result.",
          },
        },
      },
      {
        threadId: child.id,
        event: {
          type: "turn/completed",
          threadId: child.id,
          providerThreadId,
          scope,
          status: "completed",
        },
      },
    ]),
  }),
});
if (!response.ok) throw new Error(await response.text());
if (cut === "after notice") {
  mock.timers.tick(0);
  await noticeWritten.promise;
}
process.send({
  parentId: parent.id,
  childId: child.id,
  hostId: host.id,
  sessionId: session.id,
  now: Date.now(),
});
process.on("message", () => {});

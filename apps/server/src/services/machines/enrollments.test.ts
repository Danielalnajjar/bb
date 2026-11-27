import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasEnabledAuthApiKeyForHost, hosts } from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMachineAuthService,
  DAEMON_ENROLL_CONFIG_ID,
} from "../machine-auth.js";
import {
  createMachineEnrollmentService,
  findUnusedEnrollmentCredential,
} from "./enrollments.js";
import { withHostCleanup } from "../hosts/cleanup-context.js";
import { setPluginMachineProviderBridge } from "../plugins/plugin-machine-provider-registry.js";
import { validatePluginMachineProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  setPluginMachineProviderBridge(undefined);
});

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-enrollments-test-"));
  const db = createMigratedConnection();
  cleanup.push(async () => {
    db.$client.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const machineAuth = await createMachineAuthService({
    db,
    dataDir,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const serverAccess = {
    resolve: vi.fn(
      async (_request: {
        key: string;
        hostId: string;
        signal: AbortSignal;
      }) => ({
        id: "grant",
        serverUrl: "https://server.example",
      }),
    ),
    repair: vi.fn(
      async (_request: {
        key: string;
        hostId: string;
        signal: AbortSignal;
      }) => ({
        id: "repaired-grant",
        serverUrl: "https://replacement.example",
      }),
    ),
  };
  const connected = new Set<string>();
  const deps = {
    dataDir,
    db,
    machineAuth,
    serverAccess,
    isConnected: (id: string) => connected.has(id),
  };
  const create = () => createMachineEnrollmentService(deps);
  const service = create();
  const provider = validatePluginMachineProviderDeclaration({
    id: "test-machine",
    displayName: "Test machine",
    description: "Test machine",
    icon: "Terminal",
    create: async () => ({ status: "failed", message: "unused" }),
    reconcileCleanup: async () => ({ status: "removed" }),
    remove: async () => ({ status: "removed" }),
  });
  setPluginMachineProviderBridge({
    listMachineProviders: () => [{ pluginId: "plugin-a", provider }],
    getMachineProvider: (id) =>
      id === provider.id ? { pluginId: "plugin-a", provider } : undefined,
    invokeProvider: async (_pluginId, _label, run) => ({
      ok: true,
      value: await run(),
    }),
    decisionTimeoutMs: 1_000,
  });
  const seed = (
    key: string,
    state?: Pick<typeof hosts.$inferInsert, "phase" | "lastSeenAt">,
  ) => {
    const now = Date.now();
    db.insert(hosts)
      .values({
        id: `host_${key}`,
        name: "Test machine",
        type: "persistent",
        machineProviderId: provider.id,
        launchKey: key,
        attempt: 1,
        phase: "creating",
        createdAt: now,
        updatedAt: now,
        ...state,
      })
      .onConflictDoNothing()
      .run();
  };
  return {
    ...deps,
    connected,
    create,
    service,
    api: service.forOwner("plugin-a"),
    other: service.forOwner("plugin-b"),
    seed,
  };
}

describe("machine enrollments", () => {
  it("serializes same-key prepares and reissues credentials for the same durable identity", async () => {
    const h = await harness();
    h.seed("create");
    const [first, parallel] = await Promise.all([
      h.api.prepare({ signal: new AbortController().signal, key: "create" }),
      h.api.prepare({ signal: new AbortController().signal, key: "create" }),
    ]);
    expect(parallel.hostId).toBe(first.hostId);
    expect(h.serverAccess.resolve).toHaveBeenCalledTimes(2);
    const restarted = await h
      .create()
      .forOwner("plugin-a")
      .prepare({ signal: new AbortController().signal, key: "create" });
    expect(restarted.id).toBe(first.id);
    expect(restarted.hostId).toBe(first.hostId);
    expect(first.state).toBe("pending");
    if (first.state !== "pending" || restarted.state !== "pending")
      throw new Error("Expected pending enrollment");
    expect(restarted.bootstrap.credential).not.toBe(first.bootstrap.credential);
    expect(parallel.state).toBe("pending");
    if (parallel.state !== "pending")
      throw new Error("Expected pending enrollment");
    expect(parallel.bootstrap.credential).not.toBe(first.bootstrap.credential);
    expect(JSON.stringify(h.db.select().from(hosts).all())).not.toContain(
      first.bootstrap.credential,
    );
  });

  it("rejects removed identities", async () => {
    const h = await harness();
    h.seed("removed");
    const prepared = await h.api.prepare({
      signal: new AbortController().signal,
      key: "removed",
    });
    if (prepared.state !== "pending") throw new Error("Expected enrollment");
    h.db
      .update(hosts)
      .set({ phase: "destroyed" })
      .where(eq(hosts.id, prepared.hostId))
      .run();
    await expect(
      h.api.prepare({ signal: new AbortController().signal, key: "removed" }),
    ).rejects.toThrow("cancelled");
  });

  it("recovers a lost exchange response with a fresh credential for the same identity", async () => {
    const h = await harness();
    h.seed("lost-response");
    const first = await h.api.prepare({
      signal: new AbortController().signal,
      key: "lost-response",
    });
    if (first.state !== "pending")
      throw new Error("Expected pending enrollment");
    const lostResponse = await h.machineAuth.enrollHost({
      token: first.bootstrap.credential,
      hostId: first.hostId,
    });
    expect(lostResponse).not.toBeNull();
    await h.machineAuth.issueHostEnrollKey({
      hostId: first.hostId,
      enrollSource: "public-multi-machine",
    });
    const retry = await h
      .create()
      .forOwner("plugin-a")
      .prepare({ signal: new AbortController().signal, key: "lost-response" });
    if (retry.state !== "pending")
      throw new Error("Expected recoverable pending enrollment");
    expect(retry.hostId).toBe(first.hostId);
    expect(retry.bootstrap.credential === first.bootstrap.credential).toBe(
      false,
    );
    const recovered = await h.machineAuth.enrollHost({
      token: retry.bootstrap.credential,
      hostId: retry.hostId,
    });
    if (!recovered || !lostResponse)
      throw new Error("Expected successful exchanges");
    expect(
      await h.machineAuth.verifyDaemonHostKey(recovered.hostKey),
    ).not.toBeNull();
    expect(
      await h.machineAuth.verifyDaemonHostKey(lostResponse.hostKey),
    ).toBeNull();
    const beforeStart = await h.api.prepare({
      signal: new AbortController().signal,
      key: "lost-response",
    });
    expect(beforeStart.state).toBe("pending");
    expect(
      await h.machineAuth.verifyDaemonHostKey(recovered.hostKey),
    ).not.toBeNull();
    h.db
      .update(hosts)
      .set({ lastSeenAt: Date.now() })
      .where(eq(hosts.id, first.hostId))
      .run();
    expect(
      await h.create().forOwner("plugin-a").prepare({
        signal: new AbortController().signal,
        key: "lost-response",
      }),
    ).toEqual({
      id: first.id,
      hostId: first.hostId,
      state: "enrolled",
    });
  });

  it("repairs access and replaces the daemon key of a disconnected resuming host", async () => {
    const h = await harness();
    const key = "replacement";
    const hostId = `host_${key}`;
    h.seed(key, { phase: "resuming", lastSeenAt: Date.now() });
    const oldHostKey = await h.machineAuth.issueDaemonHostKey({ hostId });
    const oldEnrollment = await h.machineAuth.issueHostEnrollKey({
      hostId,
      enrollSource: "public-multi-machine",
    });
    expect(await h.machineAuth.verifyDaemonHostKey(oldHostKey)).not.toBeNull();

    const enrollment = await h.api.prepare({
      key,
      signal: new AbortController().signal,
      reEnroll: true,
    });
    if (enrollment.state !== "pending") throw new Error("Expected enrollment");
    expect(enrollment.hostId).toBe(hostId);
    expect(enrollment.bootstrap.serverUrl).toBe("https://replacement.example");
    expect(h.serverAccess.repair).toHaveBeenCalledExactlyOnceWith({
      key: JSON.stringify(["plugin-a", key]),
      hostId,
      signal: expect.any(AbortSignal),
    });
    expect(h.serverAccess.resolve).not.toHaveBeenCalled();
    const { credential } = enrollment.bootstrap;
    expect(credential).not.toBe(oldEnrollment.key);
    expect(
      await findUnusedEnrollmentCredential(h.db, oldEnrollment.key),
    ).toBeNull();
    expect(
      await h.service.pendingBootstrapForHost({ hostId, owner: "plugin-a" }),
    ).toBeNull();
    expect(
      await h.service.pendingBootstrapForCredential(credential),
    ).toBeNull();

    const redeemed = await h.machineAuth.enrollHost({
      hostId,
      token: credential,
    });
    if (!redeemed) throw new Error("Expected successful exchange");
    expect(redeemed.hostKey).not.toBe(oldHostKey);
    expect(
      await h.machineAuth.verifyDaemonHostKey(redeemed.hostKey),
    ).not.toBeNull();
    expect(await h.machineAuth.verifyDaemonHostKey(oldHostKey)).toBeNull();
  });

  it.each([
    { phase: "resuming", reEnroll: undefined, connected: false },
    { phase: "resuming", reEnroll: true, connected: true },
    { phase: "active", reEnroll: true, connected: false },
    { phase: "suspended", reEnroll: true, connected: false },
    { phase: "creating", reEnroll: true, connected: false },
    { phase: "removing", reEnroll: true, connected: false },
  ] as const)(
    "does not mint for $phase (reEnroll: $reEnroll, connected: $connected)",
    async ({ phase, reEnroll, connected }) => {
      const h = await harness();
      const key = "not-eligible";
      const hostId = `host_${key}`;
      h.seed(key, {
        phase,
        lastSeenAt: phase === "creating" ? null : Date.now(),
      });
      if (connected) h.connected.add(hostId);
      const prepare = () =>
        h.api.prepare({
          key,
          signal: new AbortController().signal,
          ...(reEnroll === undefined ? {} : { reEnroll }),
        });
      if (phase === "removing")
        await expect(prepare()).rejects.toThrow("cancelled");
      const result = await withHostCleanup(
        h,
        phase === "removing" ? hostId : null,
        prepare,
      );
      expect(result).toEqual({ id: hostId, hostId, state: "enrolled" });
      expect(h.serverAccess.repair).not.toHaveBeenCalled();
      expect(h.serverAccess.resolve).not.toHaveBeenCalled();
      expect(
        hasEnabledAuthApiKeyForHost(h.db, {
          configId: DAEMON_ENROLL_CONFIG_ID,
          hostId,
        }),
      ).toBe(false);
    },
  );

  it("refuses explicit re-enrollment for unauthorized, cancelled, or invalid requests", async () => {
    const h = await harness();
    h.seed("resuming", { phase: "resuming", lastSeenAt: Date.now() });
    h.seed("destroyed", { phase: "destroyed", lastSeenAt: Date.now() });
    const request = { signal: new AbortController().signal, reEnroll: true };
    await expect(
      h.other.prepare({ ...request, key: "resuming" }),
    ).rejects.toThrow("different plugin");
    await expect(
      h.api.prepare({ ...request, key: "destroyed" }),
    ).rejects.toThrow("cancelled");
    await expect(h.api.prepare({ ...request, key: " " })).rejects.toThrow(
      "must not be empty",
    );
    await expect(
      h.api.prepare({
        ...request,
        key: "resuming",
        signal: AbortSignal.abort(new Error("aborted")),
      }),
    ).rejects.toThrow("aborted");
    expect(h.serverAccess.repair).not.toHaveBeenCalled();
    expect(h.serverAccess.resolve).not.toHaveBeenCalled();
  });

  it("only lets the owning plugin revoke an enrollment key", async () => {
    const h = await harness();
    h.seed("revoke", { phase: "resuming", lastSeenAt: Date.now() });
    const hostId = "host_revoke";
    const { key: token } = await h.machineAuth.issueHostEnrollKey({
      hostId,
      enrollSource: "public-multi-machine",
    });
    await h.other.revokeEnrollKeys?.("revoke");
    expect(await findUnusedEnrollmentCredential(h.db, token)).toMatchObject({
      hostId,
    });
    await h.api.revokeEnrollKeys?.("revoke");
    expect(await findUnusedEnrollmentCredential(h.db, token)).toBeNull();
  });

  it("recovers access failures with the same durable host identity", async () => {
    const h = await harness();
    h.seed("create");
    h.serverAccess.resolve.mockRejectedValueOnce(
      new Error("temporarily unavailable"),
    );
    await expect(
      h.api.prepare({ signal: new AbortController().signal, key: "create" }),
    ).rejects.toThrow("temporarily unavailable");
    const retry = await h.api.prepare({
      signal: new AbortController().signal,
      key: "create",
    });
    expect(retry.hostId).toBe("host_create");
  });
});

it("propagates cancellation to acquisition and never publishes a late enrollment command", async () => {
  const h = await harness();
  h.seed("cancel");
  const controller = new AbortController();
  let finish: () => void = () => {};
  let acquisitionSignal: AbortSignal | undefined;
  h.serverAccess.resolve.mockImplementation(async ({ signal }) => {
    acquisitionSignal = signal;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { id: "late-grant", serverUrl: "https://server.example" };
  });
  const pending = h.api.prepare({ key: "cancel", signal: controller.signal });
  await vi.waitFor(() => expect(acquisitionSignal).toBeDefined());
  controller.abort(new Error("cancelled"));
  expect(acquisitionSignal?.aborted).toBe(true);
  finish();
  await expect(pending).rejects.toThrow("cancelled");
  expect(
    await h.service.pendingBootstrapForHost({
      hostId: "host_cancel",
      owner: "plugin-a",
    }),
  ).toBeNull();
});

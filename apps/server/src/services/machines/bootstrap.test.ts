import { describe, expect, it, vi } from "vitest";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import type { MachineEnrollments, EnrollmentBootstrap } from "./enrollments.js";
import { createMachineBootstrapApi } from "./bootstrap.js";

const bootstrap: EnrollmentBootstrap = {
  hostId: "host_1",
  serverUrl: "https://server.example",
  credential: "private-credential",
  expiresAt: Date.now() + 60_000,
};
const enrolled = {
  id: "enrollment",
  hostId: "host_1",
  state: "enrolled",
} as const;
const missingInstallation = "  ✗  Machine installation was not found.";

function harness() {
  const enrollments = {
    clearPending: vi.fn(),
    prepare: vi.fn<MachineEnrollments["prepare"]>(async () => ({
      id: "enrollment",
      hostId: "host_1",
      state: "pending",
      bootstrap,
    })),
    revokeEnrollKeys: vi.fn<MachineEnrollments["revokeEnrollKeys"]>(
      async () => {},
    ),
    waitForConnection: vi.fn(async () => ({
      hostId: "host_1",
      hostName: "Host 1",
    })),
  } satisfies MachineEnrollments;
  const api = createMachineBootstrapApi(enrollments);
  const exec = vi.fn<MachineExecutor["exec"]>(async () => ({
    exitCode: 0,
  }));
  const report = { step: vi.fn(), log: vi.fn() };
  const run = (signal = new AbortController().signal) =>
    api.bootstrap({ key: "key", executor: { exec }, report, signal });
  return { api, enrollments, exec, report, run };
}

function startFailure(message: string): MachineExecutor["exec"] {
  return async (request) => {
    request.onOutput(message.slice(0, 20));
    request.onOutput(message.slice(20));
    return { exitCode: 1 };
  };
}

describe("machine bootstrap", () => {
  it("delivers credentials through stdin and forwards streamed executor output", async () => {
    const h = harness();
    h.exec.mockImplementation(async (request) => {
      request.onOutput("installing\nstart");
      request.onOutput("ed\n");
      return {
        exitCode: 0,
      };
    });
    const result = await h.api.bootstrap({
      key: "key",
      executor: { exec: h.exec },
      report: h.report,
      signal: new AbortController().signal,
    });
    const request = vi.mocked(h.exec).mock.calls[0];
    expect(JSON.stringify(request)).toContain(bootstrap.credential);
    expect(JSON.stringify(h.report.step.mock.calls)).not.toContain(
      bootstrap.credential,
    );
    expect(h.report.log.mock.calls).toEqual([["installing\n"], ["started\n"]]);
    expect(h.enrollments.waitForConnection).toHaveBeenCalledOnce();
    expect(result).toEqual({ hostId: "host_1" });
    expect(request[0].command.join(" ")).not.toContain(bootstrap.credential);
  });

  it("includes the last 20 streamed lines when the command exits non-zero", async () => {
    const h = harness();
    h.exec.mockImplementation(async (request) => {
      request.onOutput(
        Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join(
          "\n",
        ) + "\n",
      );
      return { exitCode: 9 };
    });
    const error = await h.api
      .bootstrap({
        key: "key",
        executor: { exec: h.exec },
        report: h.report,
        signal: new AbortController().signal,
      })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("line 6\nline 7");
    expect(error.message).toContain("line 25");
    expect(error.message).not.toContain("line 5\n");
  });

  it("redacts transport failures and clears pending enrollment", async () => {
    const h = harness();
    h.exec.mockRejectedValue(new Error(bootstrap.credential));
    await expect(
      h.api.bootstrap({
        key: "key",
        executor: { exec: h.exec },
        report: h.report,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/^Machine bootstrap command failed$/);
    expect(h.enrollments.waitForConnection).not.toHaveBeenCalled();
    expect(h.enrollments.clearPending).toHaveBeenCalledWith("key");
  });

  it("starts an already enrolled machine before waiting after snapshot restore", async () => {
    const h = harness();
    h.enrollments.prepare.mockResolvedValue(enrolled);
    await h.api.bootstrap({
      key: "key",
      executor: { exec: h.exec },
      report: h.report,
      signal: new AbortController().signal,
    });
    expect(h.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: ["sh", "-s", "--", "--start", "--host-id", "host_1"],
        stdin: expect.stringContaining("Usage: install.sh"),
      }),
    );
    expect(h.enrollments.prepare).toHaveBeenCalledOnce();
    expect(h.enrollments.waitForConnection).toHaveBeenCalledOnce();
  });

  it("re-enrolls a replacement when the existing installation is missing", async () => {
    const h = harness();
    const signal = new AbortController().signal;
    h.enrollments.prepare.mockResolvedValueOnce(enrolled);
    h.exec.mockImplementationOnce(startFailure(missingInstallation));

    await expect(h.run(signal)).resolves.toEqual({ hostId: "host_1" });
    expect(h.enrollments.prepare.mock.calls).toEqual([
      [{ key: "key", signal }],
      [{ key: "key", signal, reEnroll: true }],
    ]);
    expect(h.exec.mock.calls[0]?.[0].command).toEqual([
      "sh",
      "-s",
      "--",
      "--start",
      "--host-id",
      "host_1",
    ]);
    const install = h.exec.mock.calls[1]?.[0];
    expect(install?.command.at(-1)).toBe("https://server.example/install.sh");
    expect(install?.stdin && JSON.parse(install.stdin)).toEqual(bootstrap);
    expect(install?.command.join(" ")).not.toContain(bootstrap.credential);
    expect(h.report.step.mock.calls).toEqual([
      ["Preparing machine enrollment"],
      ["Starting enrolled machine"],
      ["Bootstrapping machine"],
      ["Waiting for machine connection"],
    ]);
    expect(JSON.stringify(h.report.log.mock.calls)).not.toContain(
      bootstrap.credential,
    );
    expect(h.enrollments.waitForConnection).toHaveBeenCalledExactlyOnceWith({
      enrollmentId: enrolled.id,
      timeoutMs: 120_000,
      signal,
    });
    expect(h.enrollments.revokeEnrollKeys).not.toHaveBeenCalled();
  });

  it.each([
    { message: "Machine daemon did not start within 20 seconds.", prepares: 1 },
    { message: missingInstallation, prepares: 2 },
  ])(
    "preserves the start failure without installing: $message",
    async ({ message, prepares }) => {
      const h = harness();
      h.enrollments.prepare.mockResolvedValue(enrolled);
      h.exec.mockImplementationOnce(startFailure(message));

      await expect(h.run()).rejects.toThrow(
        new Error(`Machine bootstrap command failed:\n${message}`),
      );
      expect(h.enrollments.prepare).toHaveBeenCalledTimes(prepares);
      expect(h.exec).toHaveBeenCalledOnce();
      expect(h.enrollments.waitForConnection).not.toHaveBeenCalled();
      expect(h.enrollments.revokeEnrollKeys).not.toHaveBeenCalled();
    },
  );

  it.each([
    { stage: "install", abort: false },
    { stage: "install", abort: true },
    { stage: "connection", abort: false },
    { stage: "connection", abort: true },
  ])(
    "clears and revokes re-enrollment on $stage failure (abort: $abort)",
    async ({ stage, abort }) => {
      const h = harness();
      const controller = new AbortController();
      const failure = new Error(abort ? "cancelled" : "connection failed");
      h.enrollments.prepare.mockResolvedValueOnce(enrolled);
      h.exec.mockImplementationOnce(startFailure(missingInstallation));
      if (stage === "install") {
        h.exec.mockImplementationOnce(async (request) => {
          if (abort) controller.abort(failure);
          request.signal.throwIfAborted();
          request.onOutput("Installation failed.\n");
          return { exitCode: 1 };
        });
      } else {
        h.enrollments.waitForConnection.mockImplementationOnce(async () => {
          if (abort) controller.abort(failure);
          throw failure;
        });
      }

      const pending = h.run(controller.signal);
      if (stage === "install" && !abort) {
        await expect(pending).rejects.toThrow(
          "Machine bootstrap command failed:\nInstallation failed.",
        );
      } else {
        await expect(pending).rejects.toBe(failure);
      }
      expect(h.enrollments.clearPending).toHaveBeenCalledExactlyOnceWith("key");
      expect(h.enrollments.revokeEnrollKeys).toHaveBeenCalledExactlyOnceWith(
        "key",
      );
    },
  );

  it("revokes the replacement key and preserves the failure when clearing pending throws", async () => {
    const h = harness();
    const failure = new Error("replacement connection failed");
    h.enrollments.prepare.mockResolvedValueOnce(enrolled);
    h.exec.mockImplementationOnce(startFailure(missingInstallation));
    h.enrollments.waitForConnection.mockRejectedValueOnce(failure);
    h.enrollments.clearPending.mockImplementationOnce(() => {
      throw new Error("could not clear pending enrollment");
    });

    await expect(h.run()).rejects.toBe(failure);
    expect(h.enrollments.revokeEnrollKeys).toHaveBeenCalledExactlyOnceWith(
      "key",
    );
  });

  it("does no work after abort", async () => {
    const h = harness();
    await expect(
      h.api.bootstrap({
        key: "key",
        executor: { exec: h.exec },
        report: h.report,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(h.enrollments.prepare).not.toHaveBeenCalled();
    expect(h.exec).not.toHaveBeenCalled();
  });
});

it("cancels pending preparation without executing or waiting for enrollment", async () => {
  const h = harness();
  const controller = new AbortController();
  vi.mocked(h.enrollments.prepare).mockImplementation(
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const pending = h.api.bootstrap({
    key: "pending",
    executor: { exec: h.exec },
    report: h.report,
    signal: controller.signal,
  });
  controller.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
  expect(h.exec).not.toHaveBeenCalled();
  expect(h.enrollments.waitForConnection).not.toHaveBeenCalled();
  expect(h.enrollments.clearPending).toHaveBeenCalledWith("pending");
});

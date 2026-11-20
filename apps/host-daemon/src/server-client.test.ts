import { AbortError } from "p-retry";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  threadEventSchema,
  threadScope,
  type PendingInteractionCreate,
} from "@bb/domain";
import type { HostDaemonEventEnvelope } from "@bb/host-daemon-contract";
import { HOST_ARTIFACT_MAX_BYTES } from "@bb/host-daemon-contract/protocol";
import { createEventSink } from "./event-sink.js";
import {
  createServerClient,
  ServerResponseError,
  type FetchFn,
} from "./server-client.js";

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createInteractiveRequest(): PendingInteractionCreate {
  return {
    threadId: "thr_123",
    turnId: "turn_123",
    providerId: "codex",
    providerThreadId: "provider-thread-123",
    providerRequestId: "request-123",
    payload: {
      kind: "approval",
      subject: {
        kind: "command",
        itemId: "item-123",
        command: "git push",
        cwd: "/tmp/project",
        actions: [],
        sessionGrant: null,
      },
      reason: "Needs approval",
      availableDecisions: ["allow_once", "deny"],
    },
  };
}

async function readText(source: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

describe("createServerClient", () => {
  it("narrows a protocol update retry request from error details", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      Response.json(
        {
          code: "protocol_version_mismatch",
          details: { retryUpdate: true },
          message: "protocol mismatch",
        },
        { status: 400 },
      ),
    );
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "https://bb.example.test",
    });

    const result = client.openSession({
      hostId: "host-1",
      hostName: "Host",
      dataDir: "/tmp/bb",
      instanceId: "instance-1",
      localApiPort: null,
      turnCommandThreadIds: [],
      activeThreads: [],
      openThreadWork: [],
      undeliveredEventThreadIds: [],
      loadedEnvironments: [],
    });

    await expect(result).rejects.toMatchObject({
      code: "protocol_version_mismatch",
      protocolUpdateRetryRequested: true,
    });
  });

  it.each([
    {
      name: "with headers",
      details: {
        serverUrl: "https://studio.example.test",
        toHostName: "studio",
        movedAt: 1_700_000_000_000,
        headers: { "x-bb-connect-machine": "bbcm_new" },
      },
      expected: {
        serverUrl: "https://studio.example.test",
        toHostName: "studio",
        movedAt: 1_700_000_000_000,
        headers: { "x-bb-connect-machine": "bbcm_new" },
      },
    },
    {
      name: "from the moved responder",
      details: {
        serverUrl: "http://192.168.1.20:38886",
        toHostName: "studio",
        movedAt: 1_700_000_000_000,
      },
      expected: {
        serverUrl: "http://192.168.1.20:38886",
        toHostName: "studio",
        movedAt: 1_700_000_000_000,
      },
    },
    {
      name: "without a server URL",
      details: { toHostName: "studio", movedAt: 1_700_000_000_000 },
      expected: null,
    },
  ])(
    "preserves 410 server_moved details $name",
    async ({ details, expected }) => {
      const fetchFn = vi.fn<FetchFn>(async () =>
        Response.json(
          {
            code: "server_moved",
            message: "This bb server moved to studio",
            details,
          },
          { status: 410 },
        ),
      );
      const client = createServerClient({
        fetchFn,
        getSessionId: () => "session-1",
        hostKey: "host-key",
        logger: createLogger(),
        serverUrl: "http://old-server.example.test:38886",
      });

      await expect(
        client.openSession({
          hostId: "host-1",
          hostName: "Host",
          dataDir: "/tmp/bb",
          instanceId: "instance-1",
          localApiPort: null,
          turnCommandThreadIds: [],
          activeThreads: [],
          openThreadWork: [],
          undeliveredEventThreadIds: [],
          loadedEnvironments: [],
        }),
      ).rejects.toMatchObject({
        status: 410,
        code: "server_moved",
        retryable: false,
        serverMoved: expected,
      });
    },
  );

  it.each([
    {
      serverHeaders: { "x-bb-connect-machine": "bbcm_machine" },
      hasMachineCredential: true,
    },
    { serverHeaders: undefined, hasMachineCredential: false },
  ])(
    "reports live machine-credential capability as $hasMachineCredential",
    async ({ serverHeaders, hasMachineCredential }) => {
      const fetchFn = vi.fn<FetchFn>(async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          hasMachineCredential,
          localApiPort: 38_888,
        });
        return Response.json(
          {
            sessionId: "session-1",
            machineEnvironment: { revision: 0, entries: [] },
            idleProviderSessionTimeoutMinutes: 30,
            agentCpuPriority: false,
            heartbeatIntervalMs: 5_000,
            leaseTimeoutMs: 30_000,
            reconnectGraceMs: 30_000,
            endedInteractiveRequests: [],
          },
          { status: 201 },
        );
      });
      const client = createServerClient({
        fetchFn,
        getSessionId: () => "session-1",
        hostKey: "host-key",
        logger: createLogger(),
        ...(serverHeaders !== undefined ? { serverHeaders } : {}),
        serverUrl: "https://bb.example.test",
      });

      await client.openSession({
        hostId: "host-1",
        hostName: "Host",
        dataDir: "/tmp/bb",
        instanceId: "instance-1",
        localApiPort: 38_888,
        turnCommandThreadIds: [],
        activeThreads: [],
        openThreadWork: [],
        undeliveredEventThreadIds: [],
        loadedEnvironments: [],
      });
      expect(fetchFn).toHaveBeenCalledOnce();
    },
  );

  it("refuses to fetch project attachments over insecure non-loopback HTTP", async () => {
    const fetchFn = vi.fn<FetchFn>();
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "http://bb.example.test",
    });

    await expect(
      client.fetchProjectAttachment({
        maxBytes: 25,
        projectId: "project-1",
        threadId: "thread-1",
        path: "network-tab.har",
      }),
    ).rejects.toBeInstanceOf(AbortError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses to fetch project attachments when the server URL is malformed", async () => {
    const fetchFn = vi.fn<FetchFn>();
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "not a url",
    });

    await expect(
      client.fetchProjectAttachment({
        maxBytes: 25,
        projectId: "project-1",
        threadId: "thread-1",
        path: "network-tab.har",
      }),
    ).rejects.toBeInstanceOf(AbortError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fetches project attachment bytes over HTTPS", async () => {
    const fetchFn = vi.fn<FetchFn>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/internal/session/project-attachment-content");
      expect(url.searchParams.get("sessionId")).toBe("session-1");
      expect(url.searchParams.get("threadId")).toBe("thread-1");
      expect(url.searchParams.get("projectId")).toBe("project-1");
      expect(url.searchParams.get("path")).toBe("network-tab.har");
      return new Response("attachment-body", {
        headers: {
          "content-type": "application/octet-stream",
        },
        status: 200,
      });
    });
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "https://bb.example.test",
    });

    const attachment = await client.fetchProjectAttachment({
      expectedSizeBytes: 15,
      maxBytes: 25,
      projectId: "project-1",
      threadId: "thread-1",
      path: "network-tab.har",
    });

    await expect(readText(attachment.content)).resolves.toBe("attachment-body");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("fetches a skill tree manifest and requested content over authenticated LAN HTTP", async () => {
    const treeHash = "a".repeat(64);
    const manifest = {
      treeHash,
      files: [
        { path: "SKILL.md", mode: 0o644, sizeBytes: 4, sha256: "c".repeat(64) },
      ],
    };
    const fetchFn = vi.fn<FetchFn>(async (input, init) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer host-key",
      );
      expect(new Headers(init?.headers).get("x-bb-connect-machine")).toBeNull();
      if (url.pathname === `/internal/skills/tree/${treeHash}`) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      expect(url.pathname).toBe(`/internal/skills/tree/${treeHash}/content`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ paths: ["SKILL.md"] });
      return new Response("tree", { status: 200 });
    });
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "http://192.168.1.10:3000",
    });

    await expect(client.fetchSkillTreeManifest(treeHash)).resolves.toEqual(
      manifest,
    );
    await expect(
      readText(await client.fetchSkillTreeContent(treeHash, ["SKILL.md"])),
    ).resolves.toBe("tree");
  });

  it("rejects oversized host artifacts before fetching them", async () => {
    const fetchFn = vi.fn<FetchFn>();
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "https://bb.example.test",
    });

    await expect(
      client.fetchPluginHostArtifact({
        pluginId: "fixture",
        digest: "a".repeat(64),
        expectedByteLength: HOST_ARTIFACT_MAX_BYTES + 1,
      }),
    ).rejects.toThrow(/exceeds the .* byte limit/u);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("adds the connect machine credential to internal HTTP requests", async () => {
    const treeHash = "b".repeat(64);
    const fetchFn = vi.fn<FetchFn>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer host-key");
      expect(headers.get("x-bb-connect-machine")).toBe("bbcm_machine");
      return new Response(JSON.stringify({ treeHash, files: [] }), {
        status: 200,
      });
    });
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverHeaders: { "x-bb-connect-machine": "bbcm_machine" },
      serverUrl: "https://bb.example.test",
    });

    await client.fetchSkillTreeManifest(treeHash);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects a project attachment whose declared length differs before reading it", async () => {
    const cancel = vi.fn();
    const fetchFn = vi.fn<FetchFn>(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { "content-length": "9" },
          status: 200,
        }),
    );
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "https://bb.example.test",
    });

    await expect(
      client.fetchProjectAttachment({
        expectedSizeBytes: 4,
        maxBytes: 25,
        projectId: "project-1",
        threadId: "thread-1",
        path: "network-tab.har",
      }),
    ).rejects.toThrow("Project attachment size mismatch");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("fetches project attachment bytes over loopback HTTP", async () => {
    const fetchFn = vi.fn<FetchFn>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/internal/session/project-attachment-content");
      return new Response("loopback-body", {
        status: 200,
      });
    });
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "http://127.0.0.1:3334",
    });

    const attachment = await client.fetchProjectAttachment({
      maxBytes: 25,
      projectId: "project-1",
      threadId: "thread-1",
      path: "network-tab.har",
    });

    await expect(readText(attachment.content)).resolves.toBe("loopback-body");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns accepted event mappings when posting events", async () => {
    const fetchFn = vi.fn<FetchFn>(async (input, init) => {
      expect(String(input)).toContain("/internal/session/events");
      expect(JSON.parse(String(init?.body))).toEqual({
        sessionId: "session-1",
        eventGroups: [
          {
            threadId: "thr_123",
            events: [
              {
                type: "turn/started",
                threadId: "thr_123",
                providerThreadId: "provider-thread",
                scope: { kind: "turn", turnId: "turn-1" },
              },
            ],
          },
        ],
      });
      return new Response(
        JSON.stringify({
          acceptedEvents: [
            {
              eventIndex: 0,
              sequence: 6,
              threadId: "thr_123",
            },
          ],
          rejectedEvents: [],
        }),
        {
          headers: {
            "content-type": "application/json",
          },
          status: 200,
        },
      );
    });
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "https://bb.example.test",
    });

    await expect(
      client.postEvents([
        {
          threadId: "thr_123",
          event: {
            type: "turn/started",
            threadId: "thr_123",
            providerThreadId: "provider-thread",
            scope: { kind: "turn", turnId: "turn-1" },
          },
        },
      ]),
    ).resolves.toEqual({
      acceptedEvents: [
        {
          eventIndex: 0,
          sequence: 6,
          threadId: "thr_123",
        },
      ],
      rejectedEvents: [],
    });
  });

  describe("event occurrence ids", () => {
    const legacyEventBatchRequestSchema = z
      .object({
        sessionId: z.string().min(1),
        eventGroups: z.array(
          z
            .object({
              threadId: z.string().min(1),
              events: z.array(threadEventSchema).min(1),
            })
            .strict(),
        ),
      })
      .strict();

    interface EventPostBody {
      sessionId: string;
      eventGroups: {
        threadId: string;
        events: { message?: string }[];
        eventIds?: string[];
      }[];
    }

    interface EventServerArgs {
      openHeaders: HeadersInit[];
      respondToEvents: (body: EventPostBody, index: number) => Response;
    }

    function systemError(message: string) {
      return {
        type: "system/error",
        threadId: "thr_123",
        scope: threadScope(),
        message,
      } as const;
    }

    const identifiedEvents: HostDaemonEventEnvelope[] = [
      {
        threadId: "thr_123",
        event: systemError("one"),
        eventId: "0b8e4c1f-3a2d-4f6e-9b7a-1c2d3e4f5a6b",
      },
      {
        threadId: "thr_123",
        event: systemError("two"),
        eventId: "7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a",
      },
    ];

    function acceptAll(body: EventPostBody): Response {
      return Response.json({
        acceptedEvents: body.eventGroups
          .flatMap((group) => group.events.map(() => group.threadId))
          .map((threadId, eventIndex) => ({
            eventIndex,
            sequence: eventIndex + 1,
            threadId,
          })),
        rejectedEvents: [],
      });
    }

    function rejectRequest(code: string, status: number): Response {
      return Response.json(
        { code, message: `${code} rejection`, retryable: false },
        { status },
      );
    }

    function createEventServer(args: EventServerArgs) {
      const eventBodies: EventPostBody[] = [];
      let opens = 0;
      const fetchFn = vi.fn<FetchFn>(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/internal/session/open") {
          const openHeaders = args.openHeaders[opens] ?? {};
          opens += 1;
          return Response.json(
            {
              sessionId: "session-1",
              machineEnvironment: { revision: 0, entries: [] },
              idleProviderSessionTimeoutMinutes: 30,
              agentCpuPriority: false,
              heartbeatIntervalMs: 5_000,
              leaseTimeoutMs: 30_000,
              reconnectGraceMs: 30_000,
              endedInteractiveRequests: [],
            },
            { headers: openHeaders, status: 201 },
          );
        }
        expect(url.pathname).toBe("/internal/session/events");
        const body: EventPostBody = JSON.parse(String(init?.body));
        eventBodies.push(body);
        return args.respondToEvents(body, eventBodies.length - 1);
      });
      const client = createServerClient({
        fetchFn,
        getSessionId: () => "session-1",
        hostKey: "host-key",
        logger: createLogger(),
        serverUrl: "https://bb.example.test",
      });
      return { client, eventBodies };
    }

    function openSession(client: ReturnType<typeof createServerClient>) {
      return client.openSession({
        hostId: "host-1",
        hostName: "Host",
        dataDir: "/tmp/bb",
        instanceId: "instance-1",
        localApiPort: null,
        turnCommandThreadIds: [],
        activeThreads: [],
        openThreadWork: [],
        undeliveredEventThreadIds: [],
        loadedEnvironments: [],
      });
    }

    function postedShape(body: EventPostBody | undefined) {
      return body?.eventGroups.map((group) => ({
        messages: group.events.map((event) => event.message),
        eventIds: group.eventIds,
      }));
    }

    const identifiedIds = identifiedEvents.map((envelope) => envelope.eventId);

    it("sends event ids only after a session open that advertises them", async () => {
      const { client, eventBodies } = createEventServer({
        openHeaders: [{}, { "x-bb-event-ids": "1" }, {}],
        respondToEvents: acceptAll,
      });

      for (let open = 0; open < 3; open += 1) {
        await openSession(client);
        await client.postEvents(identifiedEvents);
      }

      expect(eventBodies.map(postedShape)).toEqual([
        [{ messages: ["one", "two"], eventIds: undefined }],
        [{ messages: ["one", "two"], eventIds: identifiedIds }],
        [{ messages: ["one", "two"], eventIds: undefined }],
      ]);
      expect(eventBodies[0]?.eventGroups[0]).not.toHaveProperty("eventIds");
      expect(eventBodies[2]?.eventGroups[0]).not.toHaveProperty("eventIds");
    });

    it("resends the unsplit batch without ids when the server uses the id-less strict schema", async () => {
      const stored: string[] = [];
      const { client, eventBodies } = createEventServer({
        openHeaders: [{ "x-bb-event-ids": "1" }],
        respondToEvents: (body) => {
          const parsed = legacyEventBatchRequestSchema.safeParse(body);
          if (!parsed.success) return rejectRequest("invalid_request", 400);
          for (const group of parsed.data.eventGroups) {
            for (const event of group.events) {
              if (event.type === "system/error") stored.push(event.message);
            }
          }
          return acceptAll(body);
        },
      });
      const sink = createEventSink({
        isSessionOpen: () => true,
        logger: createLogger(),
        postEvents: client.postEvents,
      });

      try {
        await openSession(client);
        sink.emit({ threadId: "thr_123", event: systemError("one") });
        sink.emit({ threadId: "thr_123", event: systemError("two") });
        await sink.flush();

        expect(stored).toEqual(["one", "two"]);
        expect(sink.listUndeliveredThreadIds()).toEqual([]);
        expect(eventBodies.map(postedShape)).toEqual([
          [
            {
              messages: ["one", "two"],
              eventIds: [expect.any(String), expect.any(String)],
            },
          ],
          [{ messages: ["one", "two"], eventIds: undefined }],
        ]);
        expect(eventBodies[1]?.eventGroups[0]).not.toHaveProperty("eventIds");

        sink.emit({ threadId: "thr_123", event: systemError("three") });
        await sink.flush();
        expect(stored).toEqual(["one", "two", "three"]);
        expect(eventBodies).toHaveLength(3);
        expect(postedShape(eventBodies[2])).toEqual([
          { messages: ["three"], eventIds: undefined },
        ]);
      } finally {
        await sink.dispose();
      }
    });

    it("hands an inactive session on the id-less resend to session handling without splitting", async () => {
      const sessionErrors: unknown[] = [];
      const { client, eventBodies } = createEventServer({
        openHeaders: [{ "x-bb-event-ids": "1" }],
        respondToEvents: (body, index) => {
          if (index === 0) return rejectRequest("invalid_request", 400);
          if (index === 1) return rejectRequest("inactive_session", 401);
          return acceptAll(body);
        },
      });
      const sink = createEventSink({
        isSessionOpen: () => true,
        logger: createLogger(),
        postEvents: async (events) => {
          try {
            return await client.postEvents(events);
          } catch (error) {
            sessionErrors.push(error);
            throw error;
          }
        },
      });

      try {
        await openSession(client);
        sink.emit({ threadId: "thr_123", event: systemError("one") });
        sink.emit({ threadId: "thr_123", event: systemError("two") });
        await sink.flush();

        expect(sessionErrors).toHaveLength(1);
        expect(sessionErrors[0]).toBeInstanceOf(ServerResponseError);
        expect(sessionErrors[0]).toMatchObject({
          code: "inactive_session",
          status: 401,
        });
        expect(sink.listUndeliveredThreadIds()).toEqual(["thr_123"]);

        await sink.flush();

        expect(sink.listUndeliveredThreadIds()).toEqual([]);
        expect(eventBodies.map(postedShape)).toEqual([
          [
            {
              messages: ["one", "two"],
              eventIds: [expect.any(String), expect.any(String)],
            },
          ],
          [{ messages: ["one", "two"], eventIds: undefined }],
          [
            {
              messages: ["one", "two"],
              eventIds: eventBodies[0]?.eventGroups[0]?.eventIds,
            },
          ],
        ]);
      } finally {
        await sink.dispose();
      }
    });

    it("retries a committed batch with the same event ids after a 5xx response", async () => {
      const storedIds = new Set<string>();
      const { client, eventBodies } = createEventServer({
        openHeaders: [{ "x-bb-event-ids": "1" }],
        respondToEvents: (body, index) => {
          for (const group of body.eventGroups) {
            for (const eventId of group.eventIds ?? []) storedIds.add(eventId);
          }
          if (index === 0) {
            return new Response("Bad Gateway", { status: 502 });
          }
          return acceptAll(body);
        },
      });
      const sink = createEventSink({
        isSessionOpen: () => true,
        logger: createLogger(),
        postEvents: client.postEvents,
      });

      try {
        await openSession(client);
        sink.emit({ threadId: "thr_123", event: systemError("one") });
        sink.emit({ threadId: "thr_123", event: systemError("two") });
        await sink.flush();

        expect(eventBodies).toHaveLength(1);
        expect(sink.listUndeliveredThreadIds()).toEqual(["thr_123"]);

        await sink.flush();

        expect(sink.listUndeliveredThreadIds()).toEqual([]);
        const firstIds = eventBodies[0]?.eventGroups[0]?.eventIds;
        expect(firstIds).toEqual([expect.any(String), expect.any(String)]);
        expect(eventBodies.map(postedShape)).toEqual([
          [{ messages: ["one", "two"], eventIds: firstIds }],
          [{ messages: ["one", "two"], eventIds: firstIds }],
        ]);
        expect(storedIds.size).toBe(2);

        sink.emit({ threadId: "thr_123", event: systemError("three") });
        await sink.flush();

        expect(eventBodies).toHaveLength(3);
        expect(postedShape(eventBodies[2])).toEqual([
          { messages: ["three"], eventIds: [expect.any(String)] },
        ]);
      } finally {
        await sink.dispose();
      }
    });

    it("keeps event ids after a validation rejection unrelated to them", async () => {
      const { client, eventBodies } = createEventServer({
        openHeaders: [{ "x-bb-event-ids": "1" }],
        respondToEvents: (body) =>
          body.eventGroups.some((group) =>
            group.events.some((event) => event.message === "malformed"),
          )
            ? rejectRequest("invalid_request", 400)
            : acceptAll(body),
      });
      const malformed: HostDaemonEventEnvelope = {
        threadId: "thr_123",
        event: systemError("malformed"),
        eventId: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
      };

      await openSession(client);
      await expect(client.postEvents([malformed])).rejects.toMatchObject({
        code: "invalid_request",
        status: 400,
      });
      await client.postEvents(identifiedEvents);

      expect(eventBodies.map(postedShape)).toEqual([
        [{ messages: ["malformed"], eventIds: [malformed.eventId] }],
        [{ messages: ["malformed"], eventIds: undefined }],
        [{ messages: ["one", "two"], eventIds: identifiedIds }],
      ]);
    });
  });

  it("retries retryable interactive request registration responses after the attempt hook", async () => {
    let calls = 0;
    const fetchFn = vi.fn<FetchFn>(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            code: "turn_start_not_ready",
            message:
              "Turn start has not been stored yet; retry interactive request registration",
            retryable: true,
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 503,
          },
        );
      }

      return new Response(
        JSON.stringify({
          outcome: "created",
          interactionId: "pint_123",
          status: "pending",
        }),
        {
          headers: {
            "content-type": "application/json",
          },
          status: 200,
        },
      );
    });
    const beforeAttempt = vi.fn(async () => undefined);
    const logger = createLogger();
    const client = createServerClient({
      beforeInteractiveRequestRegistrationAttempt: beforeAttempt,
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger,
      serverUrl: "https://bb.example.test",
    });

    await expect(
      client.registerInteractiveRequest(createInteractiveRequest()),
    ).resolves.toEqual({
      outcome: "created",
      interactionId: "pint_123",
      status: "pending",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        retriesLeft: expect.any(Number),
      }),
      "interactive request registration failed, retrying",
    );
  });

  it("does not retry non-retryable 503 interactive request registration responses", async () => {
    const fetchFn = vi.fn<FetchFn>(
      async () =>
        new Response(
          JSON.stringify({
            code: "maintenance",
            message: "Registration is disabled for this session",
            retryable: false,
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 503,
          },
        ),
    );
    const logger = createLogger();
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger,
      serverUrl: "https://bb.example.test",
    });

    const result = client.registerInteractiveRequest(
      createInteractiveRequest(),
    );

    await expect(result).rejects.toBeInstanceOf(ServerResponseError);
    await expect(result).rejects.toMatchObject({
      code: "maintenance",
      retryable: false,
      status: 503,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("dynamic tool cancellation", () => {
  it("passes cancellation to the tool-call HTTP transport", async () => {
    const controller = new AbortController();
    let transportSignal: AbortSignal | null | undefined;
    const fetchFn = vi.fn<FetchFn>(async (_input, init) => {
      transportSignal = init?.signal;
      return Response.json({ success: true, contentItems: [] });
    });
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "key",
      logger: createLogger(),
      serverUrl: "http://localhost",
    });
    await client.callTool(
      {
        requestId: 1,
        threadId: "thread",
        providerThreadId: "provider-thread",
        turnId: "turn",
        callId: "call",
        tool: "question",
      },
      controller.signal,
    );
    controller.abort();
    expect(transportSignal?.aborted).toBe(true);
    expect(
      JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)),
    ).not.toHaveProperty("signal");
  });
});

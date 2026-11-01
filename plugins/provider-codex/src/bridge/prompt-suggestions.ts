import { randomUUID } from "node:crypto";
import type {
  ExperimentalPromptSuggestionConfiguration,
  ExperimentalPromptSuggestionRequestParams,
  ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { codexTurnSchema } from "../schemas.js";
import {
  CodexAppServerRpcError,
  type CodexAppServerConnection,
} from "./app-server-connection.js";

const sampleParamsSchema = z.object({
  threadId: z.string().min(1),
  expectedTurnId: z.string().min(1),
  prompt: z
    .string()
    .min(1)
    .refine((text) => Buffer.byteLength(text, "utf8") <= 4_000),
});
const sampleResultSchema = z.object({
  sourceTurnId: z.string().min(1),
  text: z.string().nullable(),
});
const turnsListResultSchema = z.object({ data: z.array(codexTurnSchema) });
const emptyResultSchema = z.object({});

interface PendingSample {
  requestId: string;
  nativeRequestId: string;
  connection: CodexAppServerConnection;
  revision: number;
  sourceRequestId: string;
  model: string | null;
  canceled: boolean;
  started: boolean;
  cancellation: Promise<void> | null;
}

interface SourceTurn {
  id: string;
  sourceRequestId: string | null;
  successful: boolean;
}

export class CodexPromptSuggestions {
  private configuration: ExperimentalPromptSuggestionConfiguration | undefined;
  private model: string | null;
  private revision = 0;
  private pending: PendingSample | null = null;
  private source: SourceTurn | null = null;
  private sourceKnown = false;
  private input: {
    sourceRequestId: string;
    turnId: string | null;
    automatic: boolean;
  } | null = null;
  private dispatches = 0;
  private nativeBusy = false;
  private rootTurnId: string | null = null;
  private lastAutomaticTurnId: string | null = null;
  private closed = false;

  constructor(
    private readonly session: {
      configuration: ExperimentalPromptSuggestionConfiguration | undefined;
      model: string | null;
      connection(): CodexAppServerConnection | null;
      threadId(): string | null;
      isCurrent(): boolean;
      emit(delta: ThreadDelta): void;
    },
  ) {
    this.configuration = session.configuration;
    this.model = session.model;
  }

  configure(
    configuration: ExperimentalPromptSuggestionConfiguration,
  ): Promise<void> {
    this.revision += 1;
    const cancellation = this.cancel();
    this.configuration = configuration;
    return cancellation;
  }

  setModel(model: string): void {
    if (model === this.model) return;
    this.invalidate();
    this.model = model;
  }

  beginInput(args: {
    configuration: ExperimentalPromptSuggestionConfiguration | undefined;
    model: string | undefined;
    sourceRequestId: string;
    compaction: boolean;
  }): void {
    this.invalidate();
    this.configuration = args.configuration;
    if (args.model !== undefined) this.model = args.model;
    this.input = {
      sourceRequestId: args.sourceRequestId,
      turnId: null,
      automatic: !args.compaction,
    };
    this.dispatches += 1;
  }

  finishInput(): void {
    this.dispatches -= 1;
    this.scheduleAutomatic();
  }

  acceptInput(sourceRequestId: string, nativeTurnId: string): void {
    if (this.input?.sourceRequestId === sourceRequestId) {
      this.input.turnId = nativeTurnId;
      if (!this.nativeBusy) this.rootTurnId = nativeTurnId;
      if (this.source?.id === nativeTurnId)
        this.source.sourceRequestId = sourceRequestId;
    }
  }

  rootStarted(nativeTurnId: string): void {
    this.invalidate();
    this.nativeBusy = true;
    this.rootTurnId = nativeTurnId;
    this.sourceKnown = true;
    this.source = null;
  }

  rootCompleted(nativeTurnId: string, successful: boolean): void {
    if (
      this.source?.id === nativeTurnId ||
      (this.rootTurnId !== null && this.rootTurnId !== nativeTurnId)
    )
      return;
    this.nativeBusy = false;
    this.sourceKnown = true;
    this.source = {
      id: nativeTurnId,
      successful,
      sourceRequestId:
        this.input?.turnId === nativeTurnId ? this.input.sourceRequestId : null,
    };
    this.scheduleAutomatic();
  }

  private scheduleAutomatic(): void {
    const source = this.source;
    const configuration = this.configuration;
    if (
      this.closed ||
      this.nativeBusy ||
      this.dispatches !== 0 ||
      !source?.successful ||
      !source.sourceRequestId ||
      this.input?.turnId !== source.id ||
      !this.input.automatic ||
      !configuration?.automatic ||
      configuration.sourceRequestId !== source.sourceRequestId ||
      this.model === null ||
      this.lastAutomaticTurnId === source.id
    )
      return;
    this.lastAutomaticTurnId = source.id;
    const sourceRequestId = source.sourceRequestId;
    const model = this.model;
    const revision = this.revision;
    void this.request({
      requestId: randomUUID(),
      prompt: configuration.prompt,
    }).then(
      (text) => {
        if (
          this.isCurrent(revision, sourceRequestId, model) &&
          this.configuration?.automatic
        ) {
          this.session.emit({
            kind: "prompt.suggestion",
            sourceRequestId,
            model,
            text,
          });
        }
      },
      (error: unknown) => {
        if (!this.isCurrent(revision, sourceRequestId, model)) return;
        this.session.emit({
          kind: "prompt.suggestion",
          sourceRequestId,
          model,
          text: null,
        });
        process.stderr.write(
          `Codex prompt suggestions: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    );
  }

  private isCurrent(
    revision: number,
    sourceRequestId: string,
    model: string | null,
  ): boolean {
    return (
      !this.closed &&
      this.session.isCurrent() &&
      this.revision === revision &&
      this.configuration?.sourceRequestId === sourceRequestId &&
      this.model === model &&
      !this.nativeBusy &&
      this.dispatches === 0
    );
  }

  private invalidate(): void {
    this.revision += 1;
    void this.cancel().catch((error: unknown) => {
      process.stderr.write(
        `Codex sample cancellation: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }

  async cancel(requestId?: string): Promise<void> {
    const pending = this.pending;
    if (
      !pending ||
      (requestId !== undefined && pending.requestId !== requestId)
    )
      return;
    this.revision += 1;
    this.pending = null;
    return this.cancelSample(pending);
  }

  private async cancelSample(pending: PendingSample): Promise<void> {
    pending.canceled = true;
    if (pending.cancellation !== null) return pending.cancellation;
    if (!pending.started) return;
    pending.cancellation = pending.connection
      .request({
        method: "thread/sample/cancel",
        params: { requestId: pending.nativeRequestId },
        resultSchema: emptyResultSchema,
        timeoutMs: 5_000,
      })
      .then(() => undefined);
    return pending.cancellation;
  }

  close(): void {
    this.closed = true;
    this.invalidate();
  }

  async request(
    args: Pick<
      ExperimentalPromptSuggestionRequestParams,
      "requestId" | "prompt"
    >,
  ): Promise<string | null> {
    const connection = this.session.connection();
    const threadId = this.session.threadId();
    const sourceRequestId = this.configuration?.sourceRequestId;
    if (this.closed || !this.session.isCurrent() || !connection || !threadId) {
      throw new Error(
        "Codex prompt suggestions require an existing loaded session",
      );
    }
    if (this.nativeBusy || this.dispatches !== 0) {
      throw new Error(
        "Codex prompt suggestions require an idle parent; retry after the turn",
      );
    }
    if (!sourceRequestId)
      throw new Error(
        "Codex prompt suggestions are disabled or have no completed source input",
      );
    if (this.pending !== null)
      throw new Error("A Codex prompt suggestion is already pending");
    const pending: PendingSample = {
      requestId: args.requestId,
      nativeRequestId: `bb-sample-${randomUUID()}`,
      connection,
      revision: this.revision,
      sourceRequestId,
      model: this.model,
      canceled: false,
      started: false,
      cancellation: null,
    };
    this.pending = pending;
    try {
      if (!this.sourceKnown) {
        const result = await connection.request({
          method: "thread/turns/list",
          params: {
            threadId,
            limit: 1,
            sortDirection: "desc",
            itemsView: "notLoaded",
          },
          resultSchema: turnsListResultSchema,
          timeoutMs: 5_000,
        });
        this.assertCurrent(pending);
        const latest = result.data[0];
        this.sourceKnown = true;
        this.source = latest
          ? {
              id: latest.id,
              sourceRequestId,
              successful: latest.status === "completed" && !latest.error,
            }
          : null;
      }
      const source = this.source;
      if (!source?.successful || source.sourceRequestId !== sourceRequestId) {
        throw new Error(
          "Codex prompt suggestions require the latest successful completed source input",
        );
      }
      this.assertCurrent(pending);
      const params = sampleParamsSchema.parse({
        threadId,
        expectedTurnId: source.id,
        prompt: args.prompt,
      });
      pending.started = true;
      const result = await connection.request({
        requestId: pending.nativeRequestId,
        method: "thread/sample",
        params,
        resultSchema: sampleResultSchema,
        timeoutMs: 31_000,
      });
      this.assertCurrent(pending);
      if (result.sourceTurnId !== source.id)
        throw new Error("Codex sample returned a stale source turn");
      const text = result.text?.trim() ?? null;
      return text && text.length <= 8_000 ? text : null;
    } catch (error) {
      await this.cancelSample(pending).catch(() => undefined);
      if (
        error instanceof CodexAppServerRpcError &&
        (error.code === -32601 || /experimental/i.test(error.message))
      ) {
        throw new Error(
          `Codex prompt suggestions unavailable: this Codex app-server does not support native thread/sample (${error.message})`,
        );
      }
      throw error;
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }

  private assertCurrent(pending: PendingSample): void {
    if (
      pending.canceled ||
      !this.isCurrent(pending.revision, pending.sourceRequestId, pending.model)
    ) {
      throw new Error(
        "Codex prompt suggestion canceled because its source changed",
      );
    }
  }
}

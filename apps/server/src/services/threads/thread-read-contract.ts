import type { ApiError } from "../../errors.js";
import type { ThreadSearchResults } from "@bb/db";
import type { CompletedTurnDisplay } from "@bb/domain";

export type ThreadReadTask =
  | {
      kind: "outline";
      threadId: string;
      completedTurnDisplay: CompletedTurnDisplay;
      includeClearedContextHistory: boolean;
      providerDisplayName: string | null;
      eventRewriteGeneration: number;
      serverDataVersion?: number;
      role: "user" | "assistant" | null;
    }
  | { kind: "search"; query: string; limitPerGroup: number };

export interface ThreadReadRequest {
  id: number;
  source: string | Uint8Array;
  task: ThreadReadTask;
}

export type ThreadReadResult =
  | {
      kind: "outline";
      bytes: Uint8Array<ArrayBuffer>;
      maxSeq: number;
      projectionKey: string;
    }
  | { kind: "search"; results: ThreadSearchResults };

export type ThreadReadResponse =
  | { id: number; ok: true; result: ThreadReadResult }
  | {
      id: number;
      ok: false;
      message: string;
      apiError?: { status: ApiError["status"]; body: ApiError["body"] };
    };

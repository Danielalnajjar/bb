import { ApiError } from "../../errors.js";

const inFlightByThreadId = new Map<string, number>();

export class ThreadContextMutationInProgressError extends ApiError {
  constructor() {
    super(409, "invalid_request", "Thread context is being changed");
  }
}

async function withThreadContextMutationGuard<T>(
  threadId: string,
  mode: "exclusive" | "send",
  work: () => Promise<T>,
): Promise<T> {
  const inFlight = inFlightByThreadId.get(threadId) ?? 0;
  if (inFlight !== 0 && (mode === "exclusive" || inFlight < 0)) {
    if (mode === "send") throw new ThreadContextMutationInProgressError();
    throw new ApiError(
      409,
      "invalid_request",
      "Thread is processing another request",
    );
  }
  inFlightByThreadId.set(threadId, mode === "exclusive" ? -1 : inFlight + 1);
  try {
    return await work();
  } finally {
    const remaining =
      mode === "exclusive" ? 0 : (inFlightByThreadId.get(threadId) ?? 1) - 1;
    if (remaining === 0) inFlightByThreadId.delete(threadId);
    else inFlightByThreadId.set(threadId, remaining);
  }
}

export async function withThreadSendGuard<T>(
  threadId: string,
  work: () => Promise<T>,
): Promise<T> {
  return withThreadContextMutationGuard(threadId, "send", work);
}

export async function withThreadExclusiveGuard<T>(
  threadId: string,
  work: () => Promise<T>,
): Promise<T> {
  return withThreadContextMutationGuard(threadId, "exclusive", work);
}

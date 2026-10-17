import type { EventProjectionMessage } from "./event-projection-types.js";
import { parseSentThreadMessage } from "./tool-call-parsing.js";
import { getInlineToolDirectiveCandidate } from "./inline-tool-directive.js";

export function isTimelineTerminalMessage(
  message: EventProjectionMessage,
): boolean {
  return message.kind === "assistant-text" || message.kind === "error";
}

function isTimelineSummaryGroupableSteerMessage(
  message: EventProjectionMessage,
): boolean {
  return (
    message.kind === "user" &&
    message.turnRequest.kind === "steer" &&
    (message.initiator === "agent" || message.initiator === "system")
  );
}

export function isTimelineUngroupableMessage(
  message: EventProjectionMessage,
): boolean {
  if (message.kind === "user") {
    return !isTimelineSummaryGroupableSteerMessage(message);
  }
  if (message.kind === "assistant-text") {
    return message.isLegacyUserMessage === true;
  }
  if (message.kind === "command") {
    return parseSentThreadMessage(message) !== null;
  }
  if (message.kind === "tool-call") {
    return getInlineToolDirectiveCandidate(message) !== null;
  }
  return false;
}

export function isSingletonContextManagementOperation(
  messages: readonly EventProjectionMessage[],
): boolean {
  const onlyMessage = messages.length === 1 ? messages[0] : undefined;
  return (
    onlyMessage?.kind === "operation" &&
    (onlyMessage.opType === "compaction" ||
      onlyMessage.opType === "context-clear")
  );
}

export function findLastTerminalTimelineMessage(
  messages: readonly EventProjectionMessage[],
): EventProjectionMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isTimelineTerminalMessage(message)) {
      return message;
    }
  }
  return undefined;
}

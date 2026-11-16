/**
 * Tool-call counting for one pump's `turn:summary`.
 *
 * Kept outside `RunFinalizer` (which stays in `managers/`) so the chat controller can report the
 * same delta without importing a manager module.
 */

import { isInterruptedToolOutput } from "../../runtime-types/tool-truncation.js";
import { isSettledToolCallPart, isToolCallPart } from "../stream/message-parts.js";

import type { UIMessage } from "@tanstack/ai";

/**
 * Tool calls that reached an outcome in a channel snapshot.
 *
 * A pump reports `countToolCalls(end) - countToolCalls(start)`; this has to be "settled", not
 * "created": an approval-split turn requests its tools in one pump (they stay pending) and runs
 * them in the next, and counting created parts reported `0 tools` for the pump that executed them.
 *
 * An interruption marker is settled but never ran — counting it reported `83 tools` for one
 * placeholder response whose timeline said `0 phases`, the contradiction the incident exposed.
 */
export function countToolCalls(messages: readonly UIMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!isToolCallPart(part) || !isSettledToolCallPart(part)) continue;
      if (isInterruptedToolOutput(part.output)) continue;
      count += 1;
    }
  }
  return count;
}

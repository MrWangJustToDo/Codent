import { isParkedStatus } from "../../runtime-types/agent-status.js";

import type { AgentStatus } from "../../runtime-types";

/**
 * Whether mid-run user input should be queued (steer/followUp) instead of
 * starting a fresh {@link AgentChatController} pump via {@link sendMessage}.
 *
 * Uses {@link pumpDepth} — not {@link isActiveStatus} alone — so a finished
 * pump that left status `running` (tool-phase continuation still needed) does
 * not trap follow-up messages in an undrained queue.
 */
export function shouldDeferMidRunQueue(options: { pumpDepth: number; status: AgentStatus }): boolean {
  if (options.pumpDepth > 0) return true;
  const { status } = options;
  // `isParkedStatus`, not a literal pair: a parked session owes the user an answer, and the next
  // wait kind must queue input here without a second spelling to remember.
  if (isParkedStatus(status)) return true;
  // A manual `/compact` runs with no pump, but it is still work the user's next message must not
  // race: starting a turn here appends the summary checkpoint inside a half-finished turn (the
  // next model call then projects from a prefix that was replaced mid-turn) and resets the window
  // usage the new turn is accumulating. Auto-compaction is already covered by `pumpDepth > 0`;
  // this is the idle-manual case. Stale "running/thinking/responding" stays unqueued — a finished
  // pump can leave those behind, and queueing there would trap the message forever.
  if (status === "compacting") return true;
  return false;
}

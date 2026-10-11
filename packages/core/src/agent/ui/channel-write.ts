/**
 * Single safe entry point for appending synthetic messages to a UI channel.
 *
 * Consolidates the two ad-hoc "append a message to the channel tail" code paths
 * that previously lived in `synthetic-injection.ts` and `apply-compaction-result.ts`:
 * compaction summaries and turn-context/background notifications both just need
 * "push to the end, dedupe by stable id, optionally persist". Routing them all
 * through one function keeps ordering (time order) and persist semantics uniform.
 *
 * Lives under `agent/` (not `managers/middleware/`) so compaction code in
 * `agent/compaction/` can import it without crossing the agent→managers boundary.
 */

import type { AgentUIChannel } from "./ui-channel.js";
import type { UIMessage } from "@tanstack/ai";

export interface AppendChannelMessagesOptions {
  /**
   * Stable ids to treat as already-present. Entries whose id is in this set (or
   * already on the channel) are skipped. Used by synthetic injection so re-runs
   * / restores never duplicate a stable content-hash id.
   */
  existingIds?: ReadonlySet<string>;
  /** Persist the updated UI messages (no-op for subagents without a session store). */
  persist?: (next: UIMessage[]) => void;
}

/**
 * Append UIMessages to the END of the channel (time order preserved), deduped by
 * stable id, then optionally persist. Returns the messages actually inserted.
 *
 * Always appends — never inserts into the middle — so already-streamed content
 * stays byte-identical (prompt-cache prefix stability). This is the single
 * channel-append entry used by both synthetic injection and compaction.
 */
export function appendChannelMessages(
  ui: AgentUIChannel,
  messages: UIMessage[],
  options: AppendChannelMessagesOptions = {}
): UIMessage[] {
  if (messages.length === 0) return [];

  const existing = new Set(ui.getMessages().map((message) => message.id));
  if (options.existingIds) {
    for (const id of options.existingIds) existing.add(id);
  }

  const fresh = messages.filter((message) => !existing.has(message.id));
  if (fresh.length === 0) return [];

  const next = [...ui.getMessages(), ...fresh];
  ui.setMessages(next);
  options.persist?.(next);

  return fresh;
}

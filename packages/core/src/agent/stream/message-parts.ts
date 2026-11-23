/**
 * Shared UIMessage part predicates.
 *
 * These guards were previously duplicated across the stream / approval / subagent
 * modules (4× `isToolCallPart`, 2× `partTextContent`). Keep them here so the
 * "what counts as a text/tool-call part" definition lives in one place.
 */

import type { ToolCallPart } from "@tanstack/ai";

/** Text of a `text` part; `""` for any other part type or non-string content. */
export function partTextContent(part: { type?: string; content?: unknown }): string {
  if (part.type !== "text") return "";
  return typeof part.content === "string" ? part.content : "";
}

/** Narrow a UI message part to a tool-call part. */
export function isToolCallPart(part: { type?: string }): part is ToolCallPart {
  return part.type === "tool-call";
}

/**
 * The LAST part carrying this tool-call id — the live call.
 *
 * Provider ids are request-scoped and reused (`call_0`), so the transcript routinely holds several
 * parts with the same id (one per turn). Every reader that must act on "the call now" has to resolve
 * by last occurrence: `findToolCallPart` (first match) answers about the OLDEST one, which is how a
 * second `ask_user` came to look "already answered" and a resumed approval looked already decided.
 * `agent/approval/tool-approval-table.ts` and `AgentChatController.addToolResult` both depend on this.
 */
export function findLastToolCallPart(
  messages: readonly { parts?: readonly { type?: string; id?: string }[] }[],
  toolCallId: string
): ToolCallPart | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts;
    if (!parts?.length) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (isToolCallPart(part) && part.id === toolCallId) return part;
    }
  }
  return undefined;
}

/**
 * Whether a tool call reached a terminal outcome (ran, or failed) — the one definition of
 * "this call is done", shared by the cancellation predicates and the turn summary's tool count.
 *
 * An approval that was answered but not executed yet is NOT settled: the call still has to run in
 * the resume pump, which is exactly the case a "created parts" count got wrong.
 */
export function isSettledToolCallPart(part: { type?: string; state?: string }): boolean {
  return part.state === "complete" || part.state === "error";
}

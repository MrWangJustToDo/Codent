import { isToolCallPart } from "./message-parts.js";

import type { ToolCallPart, ToolResultPart, UIMessage } from "@tanstack/ai";

export const DEFAULT_TOOL_DENIAL_MESSAGE = "User denied this tool execution. Do not assume the action was performed.";

export function buildToolDenialResultContent(reason?: string): string {
  const message = reason?.trim() || DEFAULT_TOOL_DENIAL_MESSAGE;
  return JSON.stringify({ approved: false, message });
}

/** True when two approval parts describe the same decision (status / reason / time). */
export function sameApprovalDecision(
  a: ToolCallPart["approval"] | undefined,
  next: ToolCallPart["approval"] | undefined
): boolean {
  if (a === next) return true;
  if (!a || !next) return false;
  return (
    a.id === next.id &&
    a.needsApproval === next.needsApproval &&
    a.approved === next.approved &&
    approvalStamp(a) === approvalStamp(next) &&
    approvalReason(a) === approvalReason(next)
  );
}

/** Decision timestamp carried by an approval part, if any (set by the core channel). */
export function approvalStamp(approval: ToolCallPart["approval"] | undefined): number | undefined {
  const value = (approval as { updatedAt?: unknown } | undefined)?.updatedAt;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Denial reason carried by an approval part, if any (dynamically added on deny). */
export function approvalReason(approval: ToolCallPart["approval"] | undefined): string | undefined {
  const value = (approval as { reason?: unknown } | undefined)?.reason;
  return typeof value === "string" ? value : undefined;
}

/**
 * Patch a decided approval onto its tool-call part: decision status, denial
 * reason, and the decision timestamp. Returns the same array when nothing
 * changed, so replaying a decision is a no-op.
 *
 * **First decision wins.** An approval that already carries `approved` is left
 * untouched: a second answer (a late client response, or a user deny racing an
 * auto-approval batch) must not flip a decision that has already been acted on —
 * a late `allow` after a `deny` used to reach `resumeToolState` and execute the
 * tool the user had refused.
 *
 * `decidedAt` is the single time value for the decision: the channel stamps it
 * onto the part, which both feeds the persisted log and makes the same value
 * usable by the in-memory approval table.
 */
export function applyToolApprovalDecision(
  messages: UIMessage[],
  approvalId: string,
  approved: boolean,
  options?: { reason?: string; decidedAt?: number; overwrite?: "deny" }
): UIMessage[] {
  let changed = false;

  const next = messages.map((message) => {
    if (message.role !== "assistant") return message;

    let touched = false;
    const parts = message.parts.map((part) => {
      if (!isToolCallPart(part) || part.approval?.id !== approvalId) return part;
      const approval = part.approval;
      if (approval?.approved !== undefined) {
        // The ONE exception to first-decision-wins: a command-safety denial may replace an
        // approval that raced it. `overwrite` is the literal "deny" (never a boolean), so this
        // seam cannot be used to turn a denial back into an approval, and only `approved → denied`
        // is accepted — strictly stricter than the decision it replaces.
        const forcedDeny = options?.overwrite === "deny" && approved === false && approval.approved === true;
        if (!forcedDeny) return part;
      }
      const reason = approved ? undefined : options?.reason?.trim() || DEFAULT_TOOL_DENIAL_MESSAGE;
      const current = { ...approval, approved, ...(reason ? { reason } : {}) } as ToolCallPart["approval"];
      // Keep an existing decision time: the first decision owns the timestamp.
      const decidedAt = approvalStamp(approval) ?? options?.decidedAt;
      if (decidedAt !== undefined) (current as { updatedAt?: number }).updatedAt = decidedAt;
      if (sameApprovalDecision(approval, current)) return part;
      touched = true;
      return { ...part, state: "approval-responded" as ToolCallPart["state"], approval: current };
    });

    if (!touched) return message;
    changed = true;
    return { ...message, parts };
  });

  return changed ? next : messages;
}

/**
 * Attach a user-provided denial reason to the matching tool-call part and add a
 * `tool-result` part for TanStack `uiMessageToModelMessages` conversion.
 *
 * TanStack `addToolApprovalResponse` only records approved/denied; the default
 * model-facing denial text is generic. This keeps the UI freeform flow while
 * ensuring the LLM sees the user's reason on the next tool-phase run.
 */
export function applyToolDenialReason(
  messages: UIMessage[],
  approvalId: string,
  reason?: string,
  overwrite?: "deny"
): UIMessage[] {
  const denialContent = buildToolDenialResultContent(reason);

  const withDecision = applyToolApprovalDecision(messages, approvalId, false, {
    reason,
    ...(overwrite ? { overwrite } : {}),
  });

  return withDecision.map((message) => {
    if (message.role !== "assistant") return message;

    const toolCallIndex = message.parts.findIndex(
      (part): part is ToolCallPart => part.type === "tool-call" && part.approval?.id === approvalId
    );
    if (toolCallIndex === -1) return message;

    const toolCallPart = message.parts[toolCallIndex] as ToolCallPart;
    // A decision that was already made (first-wins) may be an approval; never attach a denial
    // result to it, or the transcript would claim the opposite of what `resumeToolState` does.
    if (toolCallPart.approval?.approved !== false) return message;
    const hasDenialResult = message.parts.some(
      (part) => part.type === "tool-result" && part.toolCallId === toolCallPart.id
    );
    if (hasDenialResult) return message;

    const parts = [...message.parts];
    const denialResult: ToolResultPart = {
      type: "tool-result",
      toolCallId: toolCallPart.id,
      content: denialContent,
      state: "complete",
    };
    parts.splice(toolCallIndex + 1, 0, denialResult);

    return { ...message, parts };
  });
}

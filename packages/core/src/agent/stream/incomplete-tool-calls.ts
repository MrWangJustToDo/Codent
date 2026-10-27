/**
 * Cancel incomplete / never-executed tool calls left behind after an abort.
 *
 * Esc mid tool-arg stream often leaves `input-streaming` (or TanStack finalize
 * promotes truncated JSON to `input-complete` with no output). Those rows stay
 * "executing" in the UI and the next `chat()` retries them via
 * `executeToolCalls` → JSON.parse failure.
 *
 * Must NOT cancel:
 * - pending approval prompts (user still deciding)
 * - `approval-responded` tools (user just pressed `y`)
 * - valid `input-complete` tools waiting for a normal tool-phase pump
 */

import { BUILTIN_TOOL_NAMES } from "../tools/catalog/tool-names.js";

import { isSettledToolCallPart, isToolCallPart } from "./message-parts.js";

import type { ToolCallPart, ToolResultPart, UIMessage } from "@tanstack/ai";

export const TOOL_CANCELLED_MESSAGE = "Cancelled by user.";

function hasToolResult(message: UIMessage, toolCallId: string): boolean {
  return message.parts.some((part) => part.type === "tool-result" && part.toolCallId === toolCallId);
}

/** Whether tool arguments are non-empty, parseable JSON (safe for TanStack executeToolCalls). */
export function hasValidToolArguments(part: ToolCallPart): boolean {
  const raw = typeof part.arguments === "string" ? part.arguments.trim() : "";
  if (!raw) return false;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tool call that is stuck from an aborted stream and must not be resumed.
 * Live approval / tool-phase queues are left alone.
 */
export function isCancellableIncompleteToolCall(part: ToolCallPart): boolean {
  if (part.output !== undefined) return false;
  if (isSettledToolCallPart(part)) return false;

  // User still deciding — approval UI owns this.
  if (part.approval?.needsApproval === true && part.approval.approved === undefined) {
    return false;
  }

  // User approved (`y`) — next pump must execute, not cancel.
  if (part.state === "approval-responded") return false;

  // Truncated / never-finished arg streams.
  if (part.state === "awaiting-input" || part.state === "input-streaming") return true;

  // Finalize after abort can promote truncated args to input-complete — only cancel bad JSON.
  if (part.state === "input-complete") {
    return !hasValidToolArguments(part);
  }

  return false;
}

/** Whether any message still has a cancellable incomplete tool call. */
export function hasCancellableIncompleteToolCalls(messages: UIMessage[]): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (isToolCallPart(part) && isCancellableIncompleteToolCall(part)) return true;
    }
  }
  return false;
}

interface CancelToolCallOptions {
  /** TanStack tool-call part state written on cancel. */
  state: "error" | "complete";
  /** Whether to include `cancelled: true` in the synthetic result. */
  cancelled?: boolean;
}

const DEFAULT_CANCEL_OPTIONS: CancelToolCallOptions = { state: "error", cancelled: true };

function applyToolCallCancellation(
  messages: UIMessage[],
  isCancellable: (part: ToolCallPart) => boolean,
  reason: string,
  options: CancelToolCallOptions
): UIMessage[] {
  const message = reason.trim() || TOOL_CANCELLED_MESSAGE;
  let changed = false;

  const next = messages.map((uiMessage) => {
    if (uiMessage.role !== "assistant") return uiMessage;

    let partsChanged = false;
    const parts = [...uiMessage.parts];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!isToolCallPart(part) || !isCancellable(part)) continue;

      partsChanged = true;
      // Carry the `cancelled` marker on the PART's output too, not only on the appended
      // `tool-result`: the part output is what the UI renders (and what a host reads),
      // while the tool-result content is consumed by the model wire. Without it here, a
      // cancelled call was indistinguishable from a tool that failed mid-flight, so
      // `getInlineSummary` could not tell the user the run was cut short.
      parts[i] = {
        ...part,
        state: options.state,
        output: { success: false, error: message, cancelled: options.cancelled === true },
      };

      if (
        !hasToolResult(uiMessage, part.id) &&
        !parts.some((p) => p.type === "tool-result" && p.toolCallId === part.id)
      ) {
        const result: ToolResultPart = {
          type: "tool-result",
          toolCallId: part.id,
          content: JSON.stringify({
            success: false,
            error: message,
            cancelled: options.cancelled === true,
          }),
          state: "complete",
        };
        parts.splice(i + 1, 0, result);
        i += 1;
      }
    }

    if (!partsChanged) return uiMessage;
    changed = true;
    return { ...uiMessage, parts };
  });

  return changed ? next : messages;
}

/**
 * Mark incomplete tool calls as cancelled (`error` + synthetic tool-result) so:
 * - UI stops showing a loading spinner
 * - TanStack `checkForPendingToolCalls` will not try to execute truncated args
 */
export function cancelIncompleteToolCalls(messages: UIMessage[], reason: string = TOOL_CANCELLED_MESSAGE): UIMessage[] {
  return applyToolCallCancellation(messages, isCancellableIncompleteToolCall, reason, DEFAULT_CANCEL_OPTIONS);
}

/** Reason written for a tool call recovered after a crash/interruption. */
export const INTERRUPTED_RUN_MESSAGE = "Session restored after an interrupted run.";

/** Options for the shared lifecycle settlement path. */
export interface SettleToolCallsOptions {
  /** Result text written into the synthetic tool output. */
  reason?: string;
  /** Include valid `input-complete` / approved calls that were executing (default true). */
  includeInFlight?: boolean;
  /** Keep a fully-asked `ask_user` interaction answerable (restore only). */
  preservePendingAskUser?: boolean;
}

/**
 * Settle incomplete and (optionally) in-flight tool calls in one ordered pass.
 *
 * Shared by the abort/chat-controller path and session restore; callers differ in the reason,
 * whether in-flight calls are included, and whether a pending client question is preserved.
 */
export function settleToolCalls(messages: UIMessage[], options: SettleToolCallsOptions = {}): UIMessage[] {
  const reason = options.reason ?? TOOL_CANCELLED_MESSAGE;
  let next = cancelIncompleteToolCalls(messages, reason);
  if (options.includeInFlight !== false) {
    next = cancelInFlightToolCalls(
      next,
      reason,
      options.preservePendingAskUser
        ? (part) =>
            isInFlightToolCall(part) && !(part.name === BUILTIN_TOOL_NAMES.askUser && hasValidToolArguments(part))
        : undefined
    );
  }
  return next;
}

/**
 * Settle every tool call that cannot still be running after a session restore.
 *
 * This is deliberately not the user-cancel path: no operator pressed Esc, so the synthetic
 * result must not say "Cancelled by user". Truncated/incomplete calls and valid in-flight calls
 * are both covered; pending approvals and unfinished `ask_user` interactions are left alone
 * because they are legitimate resume states.
 */
export function settleInterruptedToolCalls(
  messages: UIMessage[],
  reason: string = INTERRUPTED_RUN_MESSAGE
): UIMessage[] {
  return settleToolCalls(messages, { reason, includeInFlight: true, preservePendingAskUser: true });
}

/**
 * Tool call that is currently executing (or queued to execute) when the run is
 * aborted — valid args, no tool-result yet, but not a live approval prompt.
 *
 * These are separate from {@link isCancellableIncompleteToolCall}: a normal
 * tool-phase pump must let valid `input-complete` tools run, so they are only
 * cancelled on the abort path via {@link cancelInFlightToolCalls}.
 */
export function isInFlightToolCall(part: ToolCallPart): boolean {
  if (part.output !== undefined) return false;
  if (isSettledToolCallPart(part)) return false;
  // User still deciding — approval UI owns this.
  if (part.approval?.needsApproval === true && part.approval.approved === undefined) return false;
  // Truncated arg streams are handled by cancelIncompleteToolCalls, not here.
  if (part.state === "awaiting-input" || part.state === "input-streaming") return false;
  // Valid args that would run in the next tool-phase (or are running now).
  if (part.state === "input-complete" && hasValidToolArguments(part)) return true;
  // Approved (`y`) and queued to execute — aborted before a result arrived.
  if (part.state === "approval-responded" && part.approval?.approved === true) return true;
  return false;
}

/** Whether any message still has an in-flight (executing) tool call. */
export function hasInFlightToolCalls(messages: UIMessage[]): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (isToolCallPart(part) && isInFlightToolCall(part)) return true;
    }
  }
  return false;
}

/**
 * Mark currently-executing (in-flight) tool calls as `complete` with a
 * user-cancel result on abort. This is the framework fallback that also covers
 * extension/MCP tools whose execute never resolved before the run was torn down.
 */
export function cancelInFlightToolCalls(
  messages: UIMessage[],
  reason: string = TOOL_CANCELLED_MESSAGE,
  shouldCancel: (part: ToolCallPart) => boolean = isInFlightToolCall
): UIMessage[] {
  return applyToolCallCancellation(messages, shouldCancel, reason, {
    state: "complete",
    cancelled: true,
  });
}

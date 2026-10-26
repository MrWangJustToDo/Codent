import { BUILTIN_TOOL_NAMES, CLIENT_TOOL_NAMES } from "../tools/catalog/tool-names.js";

import { findLastMeaningfulAssistant, isEmptyAssistantShell } from "./empty-assistant-shell.js";
// The classification lives with the name registry: the tool set and this predicate must agree on it.
import { isToolCallPart, partTextContent } from "./message-parts.js";

import type { AgentStatus } from "../../runtime-types/agent-status.js";
import type { SessionInteractionsSnapshot } from "../../runtime-types/session-payloads.js";
import type { ModelMessage, ToolCallPart, ToolResultPart, UIMessage } from "@tanstack/ai";

function lastAssistantMessage(messages: UIMessage[]): UIMessage | undefined {
  return findLastMeaningfulAssistant(messages);
}

function toolResultIdsForAssistant(assistant: UIMessage): Set<string> {
  return new Set(
    assistant.parts.filter((part): part is ToolResultPart => part.type === "tool-result").map((part) => part.toolCallId)
  );
}

function hasTextAfterTools(assistant: UIMessage): boolean {
  let seenTool = false;
  for (const part of assistant.parts) {
    if (part.type === "tool-call" || part.type === "tool-result") {
      seenTool = true;
      continue;
    }
    if (seenTool && partTextContent(part).trim().length > 0) {
      return true;
    }
  }
  return false;
}

function areAllToolCallsTerminal(assistant: UIMessage): boolean {
  const toolResultIds = toolResultIdsForAssistant(assistant);
  const toolCalls = assistant.parts.filter(isToolCallPart);
  if (toolCalls.length === 0) return false;

  return toolCalls.every((part) => {
    if (isPendingToolApprovalPart(part)) return false;
    if (part.approval?.needsApproval) {
      if (part.approval.approved === false) {
        return toolResultIds.has(part.id);
      }
      if (part.approval.approved === true) {
        return part.state === "complete" || part.output !== undefined || toolResultIds.has(part.id);
      }
      return false;
    }
    return part.state === "complete" || part.output !== undefined || toolResultIds.has(part.id);
  });
}

export function isPendingToolApprovalPart(part: ToolCallPart): boolean {
  return part.approval?.needsApproval === true && part.approval.approved === undefined;
}

/**
 * Non-approval server tools still waiting after batch gating (e.g. `tree` + `run_command`).
 */
export function hasDeferredToolExecution(messages: UIMessage[]): boolean {
  const lastAssistant = lastAssistantMessage(messages);
  if (!lastAssistant) return false;

  for (const part of lastAssistant.parts) {
    if (!isToolCallPart(part)) continue;
    if (CLIENT_TOOL_NAMES.has(part.name)) continue;
    if (part.approval?.needsApproval) continue;
    if (part.state === "complete" || part.output !== undefined) continue;
    if (part.state === "input-complete" || part.state === "input-streaming" || part.state === "awaiting-input") {
      return true;
    }
  }
  return false;
}

/** Approved server tools that still need a follow-up tool-phase run. */
export function hasApprovedToolsPendingExecution(messages: UIMessage[]): boolean {
  return hasApprovalRespondedToolsPendingExecution(messages);
}

export function needsToolPhaseContinue(messages: UIMessage[]): boolean {
  return hasDeferredToolExecution(messages) || hasApprovalRespondedToolsPendingExecution(messages);
}

/**
 * Tool results (including synthetic denial) are present but the model has not
 * produced follow-up text for this turn yet. Requires another `chat()` pump.
 */
export function needsAgentResponseAfterTools(messages: UIMessage[]): boolean {
  if (needsToolPhaseContinue(messages)) return false;
  if (hasPendingToolApprovals(messages) || hasPendingAskUser(messages)) return false;

  const toolTurnAssistant = findToolTurnAwaitingFollowUp(messages);
  if (!toolTurnAssistant) return false;

  return !hasMeaningfulFollowUpAssistantAfter(messages, toolTurnAssistant);
}

function findToolTurnAwaitingFollowUp(messages: UIMessage[]): UIMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant" || isEmptyAssistantShell(message)) continue;
    if (!message.parts.some(isToolCallPart)) continue;
    if (!areAllToolCallsTerminal(message)) continue;
    if (hasTextAfterTools(message)) continue;
    return message;
  }
  return undefined;
}

function hasMeaningfulFollowUpAssistantAfter(messages: UIMessage[], toolTurnAssistant: UIMessage): boolean {
  const toolTurnIndex = messages.indexOf(toolTurnAssistant);
  if (toolTurnIndex === -1) return false;

  for (let i = toolTurnIndex + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "assistant" || isEmptyAssistantShell(message)) continue;
    if (message.parts.some((part) => partTextContent(part).trim().length > 0)) {
      return true;
    }
  }

  return false;
}

/** Whether {@link AgentChatController} should invoke another `runAgentStream`. */
export function shouldContinueAgentPump(messages: UIMessage[]): boolean {
  return needsToolPhaseContinue(messages) || needsAgentResponseAfterTools(messages);
}

/**
 * Whether the run still has a TOOL PHASE coming — the half of "will the controller pump again?" that
 * means a `chat()` invocation ending does not end the run.
 *
 * Three shapes count, and each contributes something the others miss:
 *
 * - an approval the user has not decided (`hasPendingToolApprovals`) — skipped both by
 *   `hasDeferredToolExecution` and by `hasApprovalRespondedToolsPendingExecution`, which each ignore
 *   un-answered parts;
 * - a client tool without an answer (`hasPendingAskUser`) — excluded from `hasDeferredToolExecution`
 *   by `CLIENT_TOOL_NAMES`;
 * - a tool phase that has not executed yet: an ANSWERED approval, or a server tool still deferred by
 *   batch gating (`needsToolPhaseContinue`).
 *
 * Deliberately not `needsAgentResponseAfterTools`, which is why this is not `shouldContinueAgentPump`:
 * that term covers a turn whose tools already ran and whose only remainder is the model's reply text.
 * Nothing is left to join there, so counting it would keep runs the tool phase is already done with.
 *
 * One spelling on purpose. `AgentChatController.pumpToolPhases` breaks out on the same wait checks
 * and re-pumps after them, so a boundary that reads this cannot disagree with the pump loop about
 * whether the run is over — the disagreement is the bug this exists to prevent.
 */
export function hasPendingRunContinuation(messages: UIMessage[]): boolean {
  return hasPendingToolApprovals(messages) || hasPendingAskUser(messages) || needsToolPhaseContinue(messages);
}

export function hasPendingToolApprovals(messages: UIMessage[]): boolean {
  return countPendingToolApprovals(messages) > 0;
}

export function countPendingToolApprovals(messages: UIMessage[]): number {
  // Every assistant message, not just the newest: the retained `interaction` projection
  // (`collectPendingApprovals`) and the wire both see an unanswered part in ANY message, so a
  // last-message-only counter disagreed with them the moment one survived a turn — the UI was
  // forced into approval mode while the status said completed/idle. One scan, one answer.
  let count = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (isToolCallPart(part) && isPendingToolApprovalPart(part)) count++;
    }
  }
  return count;
}

/** Approved server tools that still need execution in a follow-up `chat()` run. */
export function hasApprovalRespondedToolsPendingExecution(messages: UIMessage[]): boolean {
  const lastAssistant = lastAssistantMessage(messages);
  if (!lastAssistant) return false;

  const toolResultIds = toolResultIdsForAssistant(lastAssistant);

  for (const part of lastAssistant.parts) {
    if (!isToolCallPart(part)) continue;
    if (!part.approval?.needsApproval || part.approval.approved !== true) continue;
    if (part.state === "complete" || part.output !== undefined) continue;
    if (toolResultIds.has(part.id)) continue;
    return true;
  }
  return false;
}

/**
 * Whether `prepareForRun` should skip expensive one-shot work (memory prefetch, `prompt:submit`).
 *
 * Uses existing agent status plus conversation shape — no separate run-phase flag:
 * - `waiting` — stream paused for tool approval
 * - last message is not `user` — tool-phase or approval continuation within the same turn
 */
export function isToolContinuationPrepare(status: AgentStatus, messages?: Array<UIMessage | ModelMessage>): boolean {
  if (status === "waiting" || status === "awaiting_user") return true;
  if (!messages?.length) return false;
  return messages[messages.length - 1].role !== "user";
}

export function hasPendingAskUser(messages: UIMessage[]): boolean {
  // Same rule as approvals: `collectPendingAskUser` (the retained projection) walks the whole
  // chain, so this predicate must too or the two disagree.
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!isToolCallPart(part)) continue;
      if (part.name !== BUILTIN_TOOL_NAMES.askUser) continue;
      if (part.state === "input-complete" && part.output === undefined) return true;
    }
  }
  return false;
}

/** Parse a tool call's JSON `arguments` string; returns the raw string on failure. */
function parseToolArguments(args: string | undefined): unknown {
  if (!args) return undefined;
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}

/**
 * Pending tool approvals, newest message first — the exact set/order the app and
 * im-bridge used to derive by scanning messages themselves. Feeds the retained
 * `interaction` channel (see {@link SessionInteractionsSnapshot}).
 */
export function collectPendingApprovals(messages: UIMessage[]): SessionInteractionsSnapshot["approvals"] {
  const out: SessionInteractionsSnapshot["approvals"] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!isToolCallPart(part)) continue;
      if (!isPendingToolApprovalPart(part)) continue;
      const approvalId = part.approval?.id;
      if (!approvalId) continue;
      out.push({ approvalId, toolName: part.name, toolCallId: part.id });
    }
  }
  return out;
}

/** Pending `ask_user` requests awaiting a client answer, newest message first. */
export function collectPendingAskUser(messages: UIMessage[]): SessionInteractionsSnapshot["askUser"] {
  const out: SessionInteractionsSnapshot["askUser"] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!isToolCallPart(part)) continue;
      if (part.name !== BUILTIN_TOOL_NAMES.askUser) continue;
      if (part.state !== "input-complete" || part.output !== undefined) continue;
      const input = parseToolArguments(part.arguments) as
        { question?: string; options?: string[]; multiSelect?: boolean } | undefined;
      out.push({
        toolCallId: part.id,
        question: input?.question ?? "",
        ...(input?.options ? { options: input.options } : {}),
        ...(input?.multiSelect !== undefined ? { multiSelect: input.multiSelect } : {}),
      });
    }
  }
  return out;
}

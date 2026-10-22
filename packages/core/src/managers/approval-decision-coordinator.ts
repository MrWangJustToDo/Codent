/**
 * Approval decisions: one write path for a user answer, an auto-mode approval, and the command
 * safety policy. The channel is the source of truth (it stamps the decision time), and the
 * in-memory approval table reuses that same timestamp so the persisted log and the live table
 * cannot diverge.
 *
 * The coordinator deliberately owns no state. It exists so the four call sites that used to repeat
 * `addToolApprovalResponse → approvals.upsert → reconcile → persist` — and the two that must join
 * ONE pump instead of scheduling one per decision — cannot drift from that sequence.
 */

import { findToolCallIdForApproval, findToolCallNameForApproval } from "../agent/approval/tool-approval-table.js";
import { collectPendingApprovals } from "../agent/stream/tool-phase-utils.js";
import { analyzeCommand, createAnalysisContext } from "../agent/tools/builtin/shell/safety/command-analyzer.js";
import {
  evaluateCommandApproval,
  type CommandApprovalDecision,
} from "../agent/tools/builtin/shell/safety/command-approval-policy.js";
import { BUILTIN_TOOL_NAMES } from "../agent/tools/catalog/tool-names.js";

import type { UpsertToolApprovalInput } from "../agent/approval/tool-approval-table.js";
import type { ResolvedCoreEnv } from "../env";
import type { ToolCallPart, UIMessage } from "@tanstack/ai";

export interface ApprovalDecisionCoordinatorDeps {
  getMessages: () => UIMessage[];
  /** `AgentUIChannel.addToolApprovalResponse` — returns the decision timestamp. */
  addToolApprovalResponse: (approvalId: string, approved: boolean, reason?: string) => number;
  upsertApproval: (input: UpsertToolApprovalInput) => void;
  shouldAutoApprove: () => boolean;
  /** Status reconcile + persistence after a batch of decisions. */
  reconcile: () => void;
  persist: () => void;
  /** Join a queued pump; exactly one call per user/auto-mode decision batch. */
  enqueueRun: () => Promise<void>;
  getCoreEnv: () => ResolvedCoreEnv;
  /** Test/alternate-host seam; defaults to the tree-sitter command policy. */
  evaluateCommandSafety?: (command: string) => Promise<CommandApprovalDecision>;
}

export class ApprovalDecisionCoordinator {
  constructor(private readonly deps: ApprovalDecisionCoordinatorDeps) {}

  /** One explicit y/n answer; settles once and joins the pump. */
  async respondToToolApproval(approvalId: string, approved: boolean, reason?: string): Promise<void> {
    const messages = this.deps.getMessages();
    const toolCallId = findToolCallIdForApproval(messages, approvalId) ?? approvalId;
    const toolName = findToolCallNameForApproval(messages, approvalId);
    this.recordDecision({ approvalId, toolCallId, toolName, approved, reason });
    this.settle();
    return this.deps.enqueueRun();
  }

  /** Answer every pending approval, then resume the pump exactly once. */
  async approvePendingApprovals(): Promise<void> {
    const pending = collectPendingApprovals(this.deps.getMessages());
    if (pending.length === 0) return;

    for (const approval of pending) {
      this.recordDecision({
        approvalId: approval.approvalId,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName,
        approved: true,
      });
    }
    this.settle();
    return this.deps.enqueueRun();
  }

  /** Auto mode / plan execution: approve everything pending, without scheduling a pump. */
  autoApprovePending(): void {
    if (!this.deps.shouldAutoApprove()) return;

    let didApprove = false;
    for (const part of this.deps.getMessages().flatMap((message) => message.parts)) {
      if (part.type !== "tool-call") continue;
      const toolCall = part as ToolCallPart;
      if (toolCall.approval?.needsApproval !== true || toolCall.approval.approved !== undefined) continue;
      const approvalId = toolCall.approval.id;
      if (!approvalId) continue;
      this.recordDecision({
        approvalId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        approved: true,
      });
      didApprove = true;
    }

    if (didApprove) this.settle();
  }

  /**
   * Command-safety policy for pending `run_command` calls. Runs after {@link autoApprovePending};
   * in auto mode / plan execution it is a no-op. `ask` stays pending for the user.
   */
  async applyCommandSafetyPolicy(): Promise<void> {
    if (this.deps.shouldAutoApprove()) return;

    let handled = false;
    for (const part of this.deps.getMessages().flatMap((message) => message.parts)) {
      if (part.type !== "tool-call") continue;
      const toolCall = part as ToolCallPart;
      if (toolCall.name !== BUILTIN_TOOL_NAMES.runCommand) continue;
      if (toolCall.approval?.needsApproval !== true || toolCall.approval.approved !== undefined) continue;
      const approvalId = toolCall.approval.id;
      const command = parseToolCallInput(toolCall)?.command;
      if (!approvalId || !command) continue;

      const decision = await this.evaluateCommand(command);
      if (decision.action === "allow") {
        this.recordDecision({
          approvalId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          approved: true,
        });
        handled = true;
      } else if (decision.action === "deny") {
        this.recordDecision({
          approvalId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          approved: false,
          reason: decision.reason,
        });
        handled = true;
      }
      // ask → keep pending so the user can approve/deny (y/n).
    }

    if (handled) this.settle();
  }

  private recordDecision(input: {
    approvalId: string;
    toolCallId: string;
    toolName?: string;
    approved: boolean;
    reason?: string;
  }): void {
    // The channel resolves the time; the table reuses it (one time value for log + memory).
    const decidedAt = this.deps.addToolApprovalResponse(input.approvalId, input.approved, input.reason);
    this.deps.upsertApproval({
      id: input.approvalId,
      toolCallId: input.toolCallId,
      status: input.approved ? "approved" : "denied",
      ...(!input.approved && input.reason ? { reason: input.reason } : {}),
      toolName: input.toolName,
      updatedAt: decidedAt,
    });
  }

  private settle(): void {
    this.deps.reconcile();
    this.deps.persist();
  }

  private async evaluateCommand(command: string): Promise<CommandApprovalDecision> {
    if (this.deps.evaluateCommandSafety) return this.deps.evaluateCommandSafety(command);
    const ctx = await createAnalysisContext(this.deps.getCoreEnv());
    const report = await analyzeCommand(command, ctx);
    return evaluateCommandApproval(report, { agentKind: "root" });
  }
}

/** Safely extract a tool-call's parsed input, falling back to the raw `arguments` JSON string. */
function parseToolCallInput(toolCall: ToolCallPart): { command?: string } | undefined {
  if (toolCall.input) {
    return toolCall.input as { command?: string };
  }
  try {
    const parsed = JSON.parse(toolCall.arguments ?? "{}") as { command?: string };
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

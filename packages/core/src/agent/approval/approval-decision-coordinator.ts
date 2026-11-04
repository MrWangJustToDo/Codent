/**
 * Approval decisions: the answer writer.
 *
 * A user y/n, an auto-mode approval and a teardown denial all take the same path —
 * `addToolApprovalResponse → approvals.upsert → reconcile → persist` — and the in-memory table
 * reuses the channel's decision timestamp so the persisted log and the live table cannot diverge.
 * The coordinator owns that sequence and the one-pump join. What a decision SHOULD be is
 * `ToolAuthorizationService` (the ordered pipeline), not this class.
 */

import { ToolAuthorizationService } from "./tool-authorization.js";
import { collectPendingApprovals } from "../stream/tool-phase-utils.js";

import type { ApprovalRequirement } from "./approval-requirement.js";
import type { UpsertToolApprovalInput } from "./tool-approval-table.js";
import type { RunCommandApprovalInput, ToolAuthorizationRecord } from "./tool-authorization.js";
import type { AgentPolicyFacts } from "../mode/policy-facts.js";
import type { ToolApprovalRecord } from "../persistence/types.js";
import type { CommandApprovalDecision } from "../tools/builtin/shell/safety/command-approval-policy.js";
import type { ResolvedCoreEnv } from "../../env";
import type { UIMessage } from "@tanstack/ai";

export type { RunCommandApprovalInput } from "./tool-authorization.js";

export interface ApprovalDecisionCoordinatorDeps {
  getMessages: () => UIMessage[];
  /**
   * `AgentUIChannel.addToolApprovalResponse` — returns the decision timestamp.
   *
   * `overwrite` is the one narrow exception to first-decision-wins (approved → denied), used by the
   * command-safety policy when it resolves after the user already answered.
   */
  addToolApprovalResponse: (approvalId: string, approved: boolean, reason?: string, overwrite?: "deny") => number;
  upsertApproval: (input: UpsertToolApprovalInput) => ToolApprovalRecord | void;
  /**
   * Project the table's record onto the transcript part.
   *
   * When present, the table is the decision store: it is written first, and this only mirrors the
   * stored verdict (a first-decision-wins refusal is not projected). Without it, the legacy
   * channel-first path below is used.
   */
  projectApproval?: (input: {
    approvalId: string;
    approved: boolean;
    reason?: string;
    decidedAt: number;
    overwrite?: "deny";
  }) => void;
  /** Policy snapshot for the one authorization pipeline (mode + profile + capabilities). */
  getPolicyFacts: () => AgentPolicyFacts;
  /** The registered tool's declarative requirement (falls back to the raw flag for old hosts). */
  getApprovalRequirement?: (toolName: string) => ApprovalRequirement | undefined;
  /** Status reconcile + persistence after a batch of decisions. */
  reconcile: () => void;
  persist: () => void;
  /** Join a queued pump; exactly one call per user/auto-mode decision batch. */
  enqueueRun: () => Promise<void>;
  /**
   * True while a session switch (unload → load) is in flight. Decisions are dropped, not written:
   * the approval table and channel they would mutate are about to be replaced.
   */
  isSessionSwitching: () => boolean;
  getCoreEnv: () => ResolvedCoreEnv;
  /**
   * Whether the live tool under this name is still the seeded built-in.
   *
   * The command-safety policy analyses a shell command and then decides the approval for the call.
   * Dispatch is by name, so an extension may legitimately register its own `run_command`; the
   * verdict then describes a shell command that is not what will execute. Defaults to a name check
   * for hosts that construct this coordinator without a registry.
   */
  isIncumbentTool?: (name: string) => boolean;
  /**
   * Test/alternate-host seam. Receives every part of the call that decides the verdict
   * (`command` / `cwd` / `env`) — not just the text, because an `env` override can execute a
   * different program than the text names. Defaults to the tree-sitter command policy.
   */
  evaluateCommandSafety?: (input: RunCommandApprovalInput) => Promise<CommandApprovalDecision>;
  /**
   * Non-fatal diagnostic sink.
   *
   * A policy denial that REPLACES a user's approval is a fact both parties need to see: the caller
   * asked for one thing and a safety rule answered another, and a silent replacement is
   * indistinguishable from the policy never having run.
   */
  reportDiagnostic?: (message: string, details?: Record<string, string>) => void;
  /** Shared `tool:before:*` ledger entry point (pipeline stage; the middleware reuses it). */
  runToolBeforeHook?: (
    toolCallId: string,
    toolName: string,
    args: unknown
  ) => Promise<{ skip: boolean; reason?: string }>;
}

export class ApprovalDecisionCoordinator {
  private readonly authorization: ToolAuthorizationService;

  constructor(private readonly deps: ApprovalDecisionCoordinatorDeps) {
    this.authorization = new ToolAuthorizationService({
      getMessages: deps.getMessages,
      getPolicyFacts: deps.getPolicyFacts,
      ...(deps.getApprovalRequirement ? { getApprovalRequirement: deps.getApprovalRequirement } : {}),
      ...(deps.isIncumbentTool ? { isIncumbentTool: deps.isIncumbentTool } : {}),
      isSessionSwitching: deps.isSessionSwitching,
      getCoreEnv: deps.getCoreEnv,
      ...(deps.evaluateCommandSafety ? { evaluateCommandSafety: deps.evaluateCommandSafety } : {}),
      ...(deps.reportDiagnostic ? { reportDiagnostic: deps.reportDiagnostic } : {}),
      ...(deps.runToolBeforeHook ? { runToolBeforeHook: deps.runToolBeforeHook } : {}),
      recordDecision: (input) => this.recordDecision(input),
      settle: () => this.settle(),
    });
  }

  /** One explicit y/n answer; settles once and joins the pump. */
  async respondToToolApproval(approvalId: string, approved: boolean, reason?: string): Promise<void> {
    // First decision wins: only a PENDING approval may be answered. A repeated or late answer
    // (remote client retry, an old dialog, a deny racing auto-mode) must be inert — otherwise it
    // rewrites the channel decision, invents a table row for an id no part carries, and runs a
    // model turn over an unchanged transcript.
    const pending = collectPendingApprovals(this.deps.getMessages()).find(
      (approval) => approval.approvalId === approvalId
    );
    if (!pending) return;

    this.recordDecision({
      approvalId,
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
      approved,
      reason,
      source: "user",
    });
    this.settle();
    return this.deps.enqueueRun();
  }

  /** Answer every pending approval, then resume the pump exactly once. */
  async approvePendingApprovals(): Promise<void> {
    const pending = collectPendingApprovals(this.deps.getMessages());
    if (pending.length === 0) return;

    this.approveAll(pending);
    this.settle();
    return this.deps.enqueueRun();
  }

  /**
   * Deny every pending approval without scheduling a pump.
   *
   * Used when a turn is torn down (Esc / force-submit / session switch): the question belonged
   * to the interrupted turn, and leaving it pending kept it in `interactions.approvals` (and in
   * the wire) after the run had ended. The caller owns reconcile + persistence because the same
   * teardown already writes the cancelled tool rows.
   */
  denyPendingApprovals(reason: string): void {
    const pending = collectPendingApprovals(this.deps.getMessages());
    if (pending.length === 0) return;
    for (const approval of pending) {
      this.recordDecision({
        approvalId: approval.approvalId,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName,
        approved: false,
        reason,
        source: "user",
      });
    }
  }

  /** The pump's decision step: one `authorizeToolCall` per unresolved gated call. */
  async authorizePendingApprovals(): Promise<void> {
    return this.authorization.authorizePendingApprovals();
  }

  /** Record approval for every pending interaction, in the order the collector returned them. */
  private approveAll(pending: ReturnType<typeof collectPendingApprovals>): void {
    for (const approval of pending) {
      this.recordDecision({
        approvalId: approval.approvalId,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName,
        approved: true,
        source: "auto",
      });
    }
  }

  private recordDecision(input: ToolAuthorizationRecord): void {
    const status = input.approved ? "approved" : "denied";
    if (this.deps.projectApproval) {
      // Table first: it is the decision store. A first-decision-wins refusal returns the existing
      // row, and the transcript must not be rewritten to contradict it.
      const record = this.deps.upsertApproval({
        id: input.approvalId,
        toolCallId: input.toolCallId,
        status,
        ...(status === "denied" && input.reason ? { reason: input.reason } : {}),
        toolName: input.toolName,
        source: input.source,
        ...(input.overwrite ? { overwrite: input.overwrite } : {}),
      });
      if (record && record.status !== status) return;
      this.deps.projectApproval({
        approvalId: input.approvalId,
        approved: record ? record.status === "approved" : input.approved,
        ...((record?.reason ?? input.reason) ? { reason: record?.reason ?? input.reason } : {}),
        decidedAt: record?.updatedAt ?? Date.now(),
        ...(input.overwrite ? { overwrite: input.overwrite } : {}),
      });
      return;
    }

    // Legacy: the channel resolves the time; the table reuses it (one time value for log + memory).
    const decidedAt = this.deps.addToolApprovalResponse(
      input.approvalId,
      input.approved,
      input.reason,
      input.overwrite
    );
    this.deps.upsertApproval({
      id: input.approvalId,
      toolCallId: input.toolCallId,
      status,
      ...(status === "denied" && input.reason ? { reason: input.reason } : {}),
      toolName: input.toolName,
      source: input.source,
      updatedAt: decidedAt,
      ...(input.overwrite ? { overwrite: input.overwrite } : {}),
    });
  }

  private settle(): void {
    this.deps.reconcile();
    this.deps.persist();
  }
}

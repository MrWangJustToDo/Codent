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

import { collectPendingApprovals } from "../agent/stream/tool-phase-utils.js";
import { analyzeCommand, createAnalysisContext } from "../agent/tools/builtin/shell/safety/command-analyzer.js";
import {
  evaluateCommandApproval,
  type CommandApprovalDecision,
} from "../agent/tools/builtin/shell/safety/command-approval-policy.js";
import { BUILTIN_TOOL_NAMES } from "../agent/tools/catalog/tool-names.js";

import type { UpsertToolApprovalInput } from "../agent/approval/tool-approval-table.js";
import type { ResolvedCoreEnv } from "../env";
import type { ToolApprovalSource } from "../runtime-types/agent-event-payloads.js";
import type { ToolCallPart, UIMessage } from "@tanstack/ai";

export interface ApprovalDecisionCoordinatorDeps {
  getMessages: () => UIMessage[];
  /**
   * `AgentUIChannel.addToolApprovalResponse` — returns the decision timestamp.
   *
   * `overwrite` is the one narrow exception to first-decision-wins (approved → denied), used by the
   * command-safety policy when it resolves after the user already answered.
   */
  addToolApprovalResponse: (approvalId: string, approved: boolean, reason?: string, overwrite?: "deny") => number;
  upsertApproval: (input: UpsertToolApprovalInput) => void;
  shouldAutoApprove: () => boolean;
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
}

/** The parts of a `run_command` call that decide its approval verdict. */
export interface RunCommandApprovalInput {
  command: string;
  /** Workspace-relative working directory, as the tool will run it. */
  cwd?: string;
  /** Model-supplied environment overrides, as the host will merge them. */
  env?: Record<string, string>;
}

export class ApprovalDecisionCoordinator {
  constructor(private readonly deps: ApprovalDecisionCoordinatorDeps) {}

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

  /** Auto mode / plan execution: approve everything pending, without scheduling a pump. */
  autoApprovePending(): void {
    if (!this.deps.shouldAutoApprove()) return;

    // Same set and same decision as `approvePendingApprovals`; only the pump differs. The old
    // hand-rolled part scan repeated `isPendingToolApprovalPart` and could drift from the
    // collection the retained interaction channel uses (it also visited non-assistant messages).
    const pending = collectPendingApprovals(this.deps.getMessages());
    if (pending.length === 0) return;

    this.approveAll(pending);
    this.settle();
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

  /**
   * Command-safety policy for `run_command` calls. Runs after {@link autoApprovePending};
   * in auto mode / plan execution it is a no-op. `ask` stays pending for the user.
   *
   * A policy verdict can arrive AFTER the user answered, because the analyzer awaits CoreEnv while
   * the request is already on screen. Execution cannot happen in that window (this runs inside the
   * pump, before the next `chat()`), so a denial still protects the call: it replaces the approval
   * (see `overwrite`) and is reported, instead of being dropped by first-decision-wins. A denial is
   * the only verdict allowed to replace an answered call — an `allow` never overturns a user's no.
   */
  async applyCommandSafetyPolicy(): Promise<void> {
    if (this.deps.shouldAutoApprove()) return;
    // Nothing read before the switch is safe to write after it.
    if (this.deps.isSessionSwitching()) return;

    let handled = false;
    for (const part of this.deps.getMessages().flatMap((message) => message.parts)) {
      if (part.type !== "tool-call") continue;
      const toolCall = part as ToolCallPart;
      // Identity, not the name: an extension may register its own `run_command`, and analysing the
      // shell text of a call that executes something else approves the wrong object.
      if (toolCall.name !== BUILTIN_TOOL_NAMES.runCommand) continue;
      if (!(this.deps.isIncumbentTool?.(toolCall.name) ?? true)) continue;
      if (toolCall.approval?.needsApproval !== true) continue;
      // A denial is terminal — the policy cannot loosen it, and there is nothing to decide.
      if (toolCall.approval.approved === false) continue;
      // Already executed: the verdict can no longer protect anything, and re-analysing it would
      // spend a CoreEnv round-trip on every later phase of the same turn.
      if (toolCall.state === "complete" || toolCall.output !== undefined) continue;
      const approvalId = toolCall.approval.id;
      const input = parseToolCallInput(toolCall);
      const command = input?.command;
      if (!approvalId || !command || !input) continue;

      const decision = await this.evaluateCommand({ ...input, command });
      // The analysis is an awaited CoreEnv call. A switch admitted while it ran replaces the
      // channel and the approval table, so this decision no longer has a row to settle.
      if (this.deps.isSessionSwitching()) return;

      // Re-read after the await: the user may have answered while the analyzer was running.
      const live = findApprovalPart(this.deps.getMessages(), approvalId);
      if (!live) continue;

      if (decision.action === "allow") {
        // Never turn an answered call into an approval: that verdict belongs to the user (or auto
        // mode), and re-asserting it here would also rewrite a denial.
        if (live.approval?.approved !== undefined) continue;
        this.recordDecision({
          approvalId,
          toolCallId: live.id,
          toolName: live.name,
          approved: true,
          source: "policy",
        });
        handled = true;
      } else if (decision.action === "deny") {
        if (live.approval?.approved === false) continue;
        const overridesUser = live.approval?.approved === true;
        this.recordDecision({
          approvalId,
          toolCallId: live.id,
          toolName: live.name,
          approved: false,
          reason: decision.reason,
          source: "policy",
          ...(overridesUser ? { overwrite: "deny" as const } : {}),
        });
        handled = true;
        if (overridesUser) {
          this.deps.reportDiagnostic?.(
            `Command safety policy denied "${live.name}" after it was approved; the approval was overridden.`,
            {
              approvalId,
              toolCallId: live.id,
              ...(decision.reason ? { reason: decision.reason } : {}),
            }
          );
        }
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
    /** Who decided — travels to the log row, never to the persisted record. */
    source: ToolApprovalSource;
    /** Approved → denied only; see {@link UpsertToolApprovalInput.overwrite}. */
    overwrite?: "deny";
  }): void {
    // The channel resolves the time; the table reuses it (one time value for log + memory).
    const decidedAt = this.deps.addToolApprovalResponse(
      input.approvalId,
      input.approved,
      input.reason,
      input.overwrite
    );
    this.deps.upsertApproval({
      id: input.approvalId,
      toolCallId: input.toolCallId,
      status: input.approved ? "approved" : "denied",
      ...(!input.approved && input.reason ? { reason: input.reason } : {}),
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

  private async evaluateCommand(input: RunCommandApprovalInput): Promise<CommandApprovalDecision> {
    if (this.deps.evaluateCommandSafety) return this.deps.evaluateCommandSafety(input);
    const env = this.deps.getCoreEnv();
    // One basis for analysis and execution. `cwd` decides whether a relative path is inside the
    // workspace, and the tool runs the command from it — analysing from `rootPath` instead made
    // `run_command({ command: "cat ../README.md", cwd: "src" })` ask as an external read even
    // though the same call was allowed on the subagent path (which already resolved it this way).
    const cwd = input.cwd ? env.path.resolve(env.rootPath, input.cwd) : undefined;
    const ctx = await createAnalysisContext(env, cwd ? { cwd } : undefined);
    const report = await analyzeCommand(input.command, ctx);
    return evaluateCommandApproval(report, { agentKind: "root", envOverrides: input.env });
  }
}

/**
 * The live tool-call part carrying `approvalId`, re-read after an awaited analysis.
 *
 * The part object captured before the await can be stale (the user's answer rewrites it), so the
 * policy re-reads the current decision instead of acting on the snapshot it started from.
 */
function findApprovalPart(messages: UIMessage[], approvalId: string): ToolCallPart | undefined {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type === "tool-call" && part.approval?.id === approvalId) return part as ToolCallPart;
    }
  }
  return undefined;
}

/** Safely extract a tool-call's parsed input, falling back to the raw `arguments` JSON string. */
function parseToolCallInput(
  toolCall: ToolCallPart
): { command?: string; cwd?: string; env?: Record<string, string> } | undefined {
  let raw: unknown = toolCall.input;
  if (!raw) {
    try {
      raw = JSON.parse(toolCall.arguments ?? "{}");
    } catch {
      return undefined;
    }
  }
  if (!raw || typeof raw !== "object") return undefined;
  const { command, cwd, env } = raw as { command?: unknown; cwd?: unknown; env?: unknown };
  return {
    ...(typeof command === "string" ? { command } : {}),
    ...(typeof cwd === "string" && cwd ? { cwd } : {}),
    // Only the KEY SET matters to the override rule, so a non-string value cannot hide a key.
    // (A malformed `env` is already rejected by `inputSchema` before approval; this is the
    // defensive read.)
    ...(env && typeof env === "object" && !Array.isArray(env) ? { env: env as Record<string, string> } : {}),
  };
}

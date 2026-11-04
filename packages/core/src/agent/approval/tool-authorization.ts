/**
 * The pump's authorization pass: one decision per pending call, produced by `authorizeToolCall`.
 *
 * This is policy, not bookkeeping. The approval coordinator owns answers (a user y/n, auto mode,
 * a teardown denial) and the table/channel writes; this service decides what those answers should
 * be. Splitting them keeps the coordinator from becoming the place where four gates meet again.
 */

import { analyzeCommand, createAnalysisContext } from "../tools/builtin/shell/safety/command-analyzer.js";
import {
  evaluateCommandApproval,
  type CommandApprovalDecision,
} from "../tools/builtin/shell/safety/command-approval-policy.js";
import { BUILTIN_TOOL_NAMES } from "../tools/catalog/tool-names.js";

import { authorizeToolCall } from "./authorize-tool-call.js";

import type { ApprovalRequirement } from "./approval-requirement.js";
import type { ResolvedCoreEnv } from "../../env";
import type { ToolApprovalSource } from "../../runtime-types/agent-event-payloads.js";
import type { AgentPolicyFacts } from "../mode/policy-facts.js";
import type { ToolCallPart, UIMessage } from "@tanstack/ai";

/** The parts of a `run_command` call that decide its approval verdict. */
export interface RunCommandApprovalInput {
  command: string;
  /** Workspace-relative working directory, as the tool will run it. */
  cwd?: string;
  /** Model-supplied environment overrides, as the host will merge them. */
  env?: Record<string, string>;
}

/** One decision this service asks the coordinator to record. */
export interface ToolAuthorizationRecord {
  approvalId: string;
  toolCallId: string;
  toolName?: string;
  approved: boolean;
  reason?: string;
  source: ToolApprovalSource;
  /** Approved → denied only; see `UpsertToolApprovalInput.overwrite`. */
  overwrite?: "deny";
}

export interface ToolAuthorizationDeps {
  getMessages: () => UIMessage[];
  /** The policy snapshot; absent only on legacy hosts that still use the two-step path. */
  getPolicyFacts?: () => AgentPolicyFacts;
  getApprovalRequirement?: (toolName: string) => ApprovalRequirement | undefined;
  /** Whether the live tool under this name is still the seeded built-in. */
  isIncumbentTool?: (name: string) => boolean;
  isSessionSwitching: () => boolean;
  getCoreEnv: () => ResolvedCoreEnv;
  /** Test/alternate-host seam; defaults to the tree-sitter command policy. */
  evaluateCommandSafety?: (input: RunCommandApprovalInput) => Promise<CommandApprovalDecision>;
  recordDecision: (input: ToolAuthorizationRecord) => void;
  settle: () => void;
  reportDiagnostic?: (message: string, details?: Record<string, string>) => void;
}

export class ToolAuthorizationService {
  constructor(private readonly deps: ToolAuthorizationDeps) {}

  /**
   * One pass over every pending approval through the authorization pipeline.
   *
   * `ask` stays pending for the user; the caller does not enqueue a pump for it.
   */
  async authorizePendingApprovals(): Promise<void> {
    // Nothing read before the switch is safe to write after it.
    if (this.deps.isSessionSwitching()) return;

    const facts = this.deps.getPolicyFacts?.();
    if (!facts) return;
    let handled = false;
    for (const part of this.deps.getMessages().flatMap((message) => message.parts)) {
      if (part.type !== "tool-call") continue;
      const toolCall = part as ToolCallPart;
      const approval = toolCall.approval;
      // Only a gated, unresolved call has a decision to make. A denied call is terminal; an
      // executed one can no longer be protected.
      if (!approval?.id || approval.needsApproval !== true) continue;
      if (approval.approved === false) continue;
      if (toolCall.state === "complete" || toolCall.output !== undefined) continue;

      const input = parseToolCallInput(toolCall);
      const isCommand =
        toolCall.name === BUILTIN_TOOL_NAMES.runCommand && (this.deps.isIncumbentTool?.(toolCall.name) ?? true);
      // An answered call is not re-decided, but a DENY may still replace it: the analyzer can
      // resolve after the user answered (it awaits CoreEnv while the request is on screen), and
      // execution cannot happen in that window.
      const persisted = approval.approved === true ? "approved" : "pending";
      const decision = await authorizeToolCall({
        toolName: toolCall.name,
        args: (input ?? {}) as Record<string, unknown>,
        facts,
        ...(this.deps.getApprovalRequirement ? { approval: this.deps.getApprovalRequirement(toolCall.name) } : {}),
        persisted,
        ...(isCommand && input?.command
          ? {
              analyzeCommand: async () => {
                const analyzed = await this.evaluateCommand({ ...input, command: input.command! });
                return {
                  action: analyzed.action,
                  source: "command-analysis" as const,
                  ...(analyzed.reason ? { reason: analyzed.reason } : {}),
                };
              },
            }
          : {}),
      });
      if (this.deps.isSessionSwitching()) return;

      // Re-read after the await: the user may have answered while the analyzer was running.
      const live = findApprovalPart(this.deps.getMessages(), approval.id);
      if (!live) continue;

      if (persisted === "approved") {
        if (decision.action !== "deny") continue;
        if (live.approval?.approved === false) continue;
        this.deps.recordDecision({
          approvalId: approval.id,
          toolCallId: live.id,
          toolName: live.name,
          approved: false,
          reason: decision.reason,
          source: "policy",
          overwrite: "deny",
        });
        this.deps.reportDiagnostic?.(
          `Command safety policy denied "${live.name}" after it was approved; the approval was overridden.`,
          {
            approvalId: approval.id,
            toolCallId: live.id,
            ...(decision.reason ? { reason: decision.reason } : {}),
          }
        );
        handled = true;
        continue;
      }

      if (decision.action === "allow") {
        // Never turn an answered call into an approval: that verdict belongs to the user.
        if (live.approval?.approved !== undefined) continue;
        this.deps.recordDecision({
          approvalId: approval.id,
          toolCallId: live.id,
          toolName: live.name,
          approved: true,
          source: decision.source === "auto" ? "auto" : "policy",
        });
        handled = true;
      } else if (decision.action === "deny") {
        this.deps.recordDecision({
          approvalId: approval.id,
          toolCallId: live.id,
          toolName: live.name,
          approved: false,
          reason: decision.reason ?? `Denied by ${decision.source}`,
          source: "policy",
        });
        handled = true;
      }
      // ask → keep pending so the user can approve/deny (y/n).
    }

    if (handled) this.deps.settle();
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
export function findApprovalPart(messages: UIMessage[], approvalId: string): ToolCallPart | undefined {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type === "tool-call" && part.approval?.id === approvalId) return part as ToolCallPart;
    }
  }
  return undefined;
}

/** Safely extract a tool-call's parsed input, falling back to the raw `arguments` JSON string. */
export function parseToolCallInput(
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
    ...(typeof cwd === "string" ? { cwd } : {}),
    ...(env && typeof env === "object" ? { env: env as Record<string, string> } : {}),
  };
}

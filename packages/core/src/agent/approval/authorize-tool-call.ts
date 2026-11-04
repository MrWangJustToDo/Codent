/**
 * The one authorization pipeline for a tool call.
 *
 * Order is fixed: availability → hard policy → auto modes → declarative requirement → command
 * analysis → extension hooks → persisted decision. Each stage sees the same `AgentPolicyFacts`
 * snapshot and returns `allow`, `ask` or `deny` with the stage that produced it, so a call cannot be
 * allowed by one gate and denied by another with no shared record.
 *
 * The stages call the existing decision functions unchanged. This module composes them; it does not
 * re-implement command safety, MCP annotation folding, or extension interception.
 */

import type { ApprovalRequirement } from "./approval-requirement.js";
import type { AgentPolicyFacts } from "../mode/policy-facts.js";

export type ToolAuthorizationAction = "allow" | "ask" | "deny";

export type ToolAuthorizationSource =
  "availability" | "policy" | "auto" | "declarative" | "command-analysis" | "extension" | "persisted";

export interface ToolAuthorizationDecision {
  readonly action: ToolAuthorizationAction;
  readonly source: ToolAuthorizationSource;
  readonly reason?: string;
}

/** A persisted answer for this call, already projected from the approval table. */
export type PersistedToolDecision = "approved" | "denied" | "pending" | undefined;

export interface AuthorizeToolCallInput {
  toolName: string;
  args: Record<string, unknown>;
  facts: AgentPolicyFacts;
  /** The registered tool's declarative requirement; omitted means free. */
  approval?: ApprovalRequirement;
  /** Existing answer from the approval table (the store, not a second decision). */
  persisted?: PersistedToolDecision;
  /**
   * Hard policy (subagent profile, env override, destructive rule). A `deny` short-circuits;
   * `allow`/`ask` are advisory and the pipeline continues.
   */
  hardPolicy?: ToolAuthorizationDecision;
  /** Command-safety analysis for `run_command` (the existing analyzer, unchanged). */
  analyzeCommand?: () => Promise<ToolAuthorizationDecision | undefined>;
  /** Extension `tool:before:*` stage; a `deny` is the `skip` verdict. */
  extensionHooks?: () => Promise<ToolAuthorizationDecision | undefined>;
}

const ALLOW_FREE: ToolAuthorizationDecision = {
  action: "allow",
  source: "declarative",
  reason: "no approval required",
};

/**
 * Run the seven stages and return the first decisive verdict.
 *
 * A persisted answer is consulted in two places deliberately: a recorded denial is terminal before
 * auto mode (a user's no is not auto-approved), while a recorded approval is returned at the end so
 * command analysis and extension hooks can still deny the call.
 */
export async function authorizeToolCall(input: AuthorizeToolCallInput): Promise<ToolAuthorizationDecision> {
  const { facts, toolName } = input;

  // 1. Availability: the tool list offered to the model and the execution gate share one policy.
  if (facts.unavailableTools.has(toolName)) {
    return { action: "deny", source: "availability", reason: `"${toolName}" is not available in this mode or profile` };
  }

  // 2. Hard policy: auto mode never bypasses it.
  if (input.hardPolicy?.action === "deny") return input.hardPolicy;

  // 3. A recorded denial is terminal: no later stage may loosen it.
  if (input.persisted === "denied") {
    return { action: "deny", source: "persisted", reason: "denied by the recorded decision" };
  }

  // 4. Auto modes (auto, or plan execution with seeded todos). This is a candidate, not a terminal
  // allow: an extension hook may still deny (auto mode does not bypass a hard/extension deny), and
  // command analysis is deliberately skipped to keep auto's "no prompts, no analyzer" behavior.
  const autoApprove = facts.auto || facts.planExecutionAutoApprove;
  let candidate: ToolAuthorizationDecision | undefined = autoApprove
    ? { action: "allow", source: "auto", reason: facts.auto ? "auto mode" : "plan execution" }
    : undefined;

  // 5. Declarative requirement: this is an `ask` candidate, not a final verdict — command analysis
  // may still allow a read-only command that the tool gates by default.
  const requiresApproval = input.approval?.requiresApproval ?? false;
  if (!autoApprove && requiresApproval) {
    candidate = { action: "ask", source: "declarative", reason: input.approval?.reason ?? "tool requires approval" };
  }

  // 6. Command analysis (existing analyzer) can allow, deny or ask. A deny is terminal; an allow
  // replaces the declarative ask and stays open to a later extension deny.
  if (!autoApprove && input.analyzeCommand) {
    const analyzed = await input.analyzeCommand();
    if (analyzed?.action === "deny") return analyzed;
    if (analyzed) candidate = analyzed;
  }

  // 7. Extension hooks: a skip is a deny (terminal), even over an earlier allow.
  if (input.extensionHooks) {
    const hooked = await input.extensionHooks();
    if (hooked?.action === "deny") return hooked;
    if (hooked?.action === "allow") candidate = hooked;
  }

  // 8. Persisted decision: an answer already recorded executes once without re-prompting. It is
  // last, so a command/extension deny above still wins; it only settles an ask candidate.
  if (input.persisted === "approved") {
    return candidate?.source === "auto"
      ? candidate
      : { action: "allow", source: "persisted", reason: "approved by the recorded decision" };
  }
  if (input.persisted === "pending" && candidate?.action !== "allow") {
    return { action: "ask", source: "persisted", reason: "approval is still pending" };
  }

  return candidate ?? ALLOW_FREE;
}

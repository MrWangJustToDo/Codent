/**
 * The declarative approval requirement of a registered tool.
 *
 * One descriptor, composed at registration from the tool's own declaration and (for MCP) the
 * server's annotations. Policy reads this descriptor; a call site must not re-read a raw
 * `needsApproval` flag, because that is how two gates end up disagreeing about the same call.
 */

export type ApprovalRequirementSource = "declared" | "mcp-annotations" | "default";

export interface ApprovalRequirement {
  /** True when the call must be answered before it can execute. */
  readonly requiresApproval: boolean;
  /** Where the requirement came from (diagnostics + the stage's decision source). */
  readonly source: ApprovalRequirementSource;
  /** Set when the tool exists but the requirement had to be assumed (fail closed). */
  readonly reason?: string;
}

/** Free to run without a prompt. */
export const FREE_APPROVAL: ApprovalRequirement = { requiresApproval: false, source: "default" };

/**
 * Compose the requirement from the tool object's declaration.
 *
 * `needsApproval === true` means the tool (or its MCP annotations, already folded in by the MCP
 * client) requires an answer. A tool that declares nothing is free: only MCP has the
 * "no annotation ⇒ require approval" rule, and that is decided before registration.
 */
export function resolveApprovalRequirement(tool: unknown): ApprovalRequirement {
  if (typeof tool !== "object" || tool === null) {
    return { requiresApproval: true, source: "default", reason: "tool object is unavailable" };
  }
  const declared = (tool as { needsApproval?: unknown }).needsApproval;
  if (declared === true) return { requiresApproval: true, source: "declared" };
  return { requiresApproval: false, source: declared === false ? "declared" : "default" };
}

import { BUILTIN_TOOL_NAMES } from "../tools/catalog/tool-names.js";
import { getBuiltinToolPresentation } from "../tools/presentation/builtin.js";

import type { PlanModeController } from "./plan-mode-controller.js";
import type { ToolsRecord } from "../tools/catalog/tool-set.js";

/**
 * Tools withheld while planning or ready that do NOT write the workspace, each with its reason.
 *
 * The workspace-mutating half is DERIVED from the tool's own declaration
 * ({@link isWorkspaceEditingTool}, i.e. `present.category === "edits"`) rather than listed here, so an
 * editing tool cannot become available in plan mode by arriving under a name nobody remembered to add:
 * `code_rewrite` was exactly that — a built-in that edits in place with `dry_run: false` and appeared
 * on no list. What remains below needs a different rule, and each entry says which:
 *
 * - `kill_command` — background-job control. It does not touch the workspace (it is a `commands`
 *   tool like `run_command`); it is withheld because an unattended background job has no UI to control
 *   it, the same reason `run_command`'s `run_in_background` is refused while planning.
 *
 * `task` stays available: subagents are already read-only (Claude/Cursor-style explore).
 */
export const PLAN_MODE_EXCLUDED_NON_EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([BUILTIN_TOOL_NAMES.killCommand]);

/**
 * Whether a tool edits the workspace, by its own declaration.
 *
 * Read from the presentation registry, which is what makes this cover every source of tools —
 * built-ins, the LSP extension's tools, and any future editing tool — without a second list.
 *
 * **An undeclared tool is treated as editing.** `present` is optional on extension tools, so a
 * third-party write tool that declares nothing used to return `false` here and run during
 * planning/ready. Plan mode is a safety boundary, so unknown effects fail closed; an extension
 * that is genuinely read-only declares its presentation (and therefore becomes visible to the UI
 * as well).
 */
export function isWorkspaceEditingTool(toolName: string, resolve = getBuiltinToolPresentation): boolean {
  const presentation = resolve(toolName);
  if (!presentation) return true;
  return presentation.category === "edits";
}

/** Plan authoring tools — only offered while planning/ready. */
export const PLAN_AUTHORING_TOOL_NAMES: ReadonlySet<string> = new Set([
  BUILTIN_TOOL_NAMES.createPlan,
  BUILTIN_TOOL_NAMES.updatePlan,
]);

/** Plan completion — only offered while in retro. */
export const PLAN_COMPLETION_TOOL_NAMES: ReadonlySet<string> = new Set([BUILTIN_TOOL_NAMES.completePlan]);

export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__");
}

/** Build exclude set for {@link resolveToolsRecord} during planning/ready. */
export function getPlanModeToolExcludeSet(tools: ToolsRecord, resolve = getBuiltinToolPresentation): Set<string> {
  const exclude = new Set(PLAN_MODE_EXCLUDED_NON_EDIT_TOOL_NAMES);
  for (const name of Object.keys(tools)) {
    if (isMcpToolName(name) || isWorkspaceEditingTool(name, resolve)) exclude.add(name);
  }
  return exclude;
}

/** Whether plan mode withholds `toolName` — every editing tool, the named exceptions, and MCP. */
export function isPlanModeForbiddenTool(toolName: string, resolve = getBuiltinToolPresentation): boolean {
  return (
    isWorkspaceEditingTool(toolName, resolve) ||
    PLAN_MODE_EXCLUDED_NON_EDIT_TOOL_NAMES.has(toolName) ||
    isMcpToolName(toolName)
  );
}

/**
 * Defense-in-depth check before tool execution while restricting tools.
 * Returns an error message when the call must be skipped, else null.
 */
export function getPlanModeToolBlockReason(
  planMode: PlanModeController | null | undefined,
  toolName: string,
  args: unknown,
  resolve = getBuiltinToolPresentation
): string | null {
  if (!planMode?.isRestrictingTools()) return null;

  if (isPlanModeForbiddenTool(toolName, resolve)) {
    return `Plan mode: "${toolName}" is blocked while planning. Use /mode execute after the plan is ready.`;
  }

  if (toolName === BUILTIN_TOOL_NAMES.runCommand) {
    // run_command itself is NOT blocked here — it goes through the unified
    // needsApproval + command-safety approval rules (read-only auto-approve,
    // write/external paths ask the user y/n). Only background jobs are still
    // blocked while planning (no UI to control an unattended background job).
    if (
      args &&
      typeof args === "object" &&
      "run_in_background" in args &&
      (args as { run_in_background?: boolean }).run_in_background === true
    ) {
      return "Plan mode: background run_command is blocked while planning.";
    }
  }

  return null;
}

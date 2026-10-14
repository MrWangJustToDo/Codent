import { createSubagentTools } from "../../subagent/subagent-tools.js";
import { createTools } from "../create-tools.js";
import { BUILTIN_TOOL_NAMES } from "../tool-names.js";

import { toolsToArray, type ToolsRecord } from "./tools-record.js";

import type { ManagedAgent, UsageTracker } from "../../../runtime-types/hosts.js";
import type { AnyClientTool, AnyServerTool } from "@tanstack/ai";

// Re-exported for the runtime barrel: the classification lives in the name registry (one home), and
// this module is where the tool set is composed from it.
export { CLIENT_TOOL_NAMES } from "../tool-names.js";

// ============================================================================
// Constants
// ============================================================================

/** Tools excluded from exploration subagents (read-only subset). */
const SUBAGENT_EXCLUDED: ReadonlyArray<string> = [
  BUILTIN_TOOL_NAMES.writeFile,
  BUILTIN_TOOL_NAMES.editFile,
  BUILTIN_TOOL_NAMES.deleteFile,
  BUILTIN_TOOL_NAMES.task,
  BUILTIN_TOOL_NAMES.todo,
  BUILTIN_TOOL_NAMES.askUser,
  BUILTIN_TOOL_NAMES.createPlan,
  BUILTIN_TOOL_NAMES.updatePlan,
  BUILTIN_TOOL_NAMES.completePlan,
  BUILTIN_TOOL_NAMES.listSkills,
  BUILTIN_TOOL_NAMES.loadSkill,
];

/** Tools excluded from exploration subagents (read-only subset). */
export const SUBAGENT_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set(SUBAGENT_EXCLUDED);

/** Default exploration subagent tools (read-only fs + web research + begin_summary). */
const SUBAGENT_TOOL_NAMES = [
  BUILTIN_TOOL_NAMES.readFile,
  BUILTIN_TOOL_NAMES.glob,
  BUILTIN_TOOL_NAMES.grep,
  BUILTIN_TOOL_NAMES.listFile,
  BUILTIN_TOOL_NAMES.tree,
  BUILTIN_TOOL_NAMES.webfetch,
  BUILTIN_TOOL_NAMES.websearch,
] as const;

// ============================================================================
// TanStack tool arrays
// ============================================================================

/**
 * Flatten a tools record to TanStack tools for {@link AgentRunner}.
 */
export function resolveToolsRecord(
  record: ToolsRecord,
  options: { exclude?: ReadonlySet<string> } = {}
): Array<AnyServerTool | AnyClientTool> {
  return toolsToArray(record, options);
}

/**
 * Read-only exploration subagent tools as {@link AnyServerTool}[].
 */
export function createTanStackSubagentTools(managed?: ManagedAgent): AnyServerTool[] {
  const toolRecord = createSubagentTools(managed);
  return toolsToArray(toolRecord, { exclude: SUBAGENT_EXCLUDED_TOOL_NAMES }) as AnyServerTool[];
}

/**
 * Default root-agent filesystem/shell tools (before task/skills/MCP extensions).
 */
export async function createTanStackTools(options: { usage?: UsageTracker } = {}): Promise<AnyServerTool[]> {
  const toolRecord = await createTools({ usage: options.usage });
  return toolsToArray(toolRecord) as AnyServerTool[];
}

/** Names of tools included in the default exploration subagent set (excluding begin_summary). */
export function getReadOnlyTanStackToolNames(): readonly string[] {
  return SUBAGENT_TOOL_NAMES;
}

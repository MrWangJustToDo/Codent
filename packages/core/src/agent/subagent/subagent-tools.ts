/**
 * Read-only tool set for exploration subagents.
 */

import { createGlobTool } from "../tools/builtin/fs/glob-tool.js";
import { createGrepTool } from "../tools/builtin/fs/grep-tool.js";
import { createListFileTool } from "../tools/builtin/fs/list-file-tool.js";
import { createReadFileTool } from "../tools/builtin/fs/read-file-tool.js";
import { createTreeTool } from "../tools/builtin/fs/tree-tool.js";
import { createRunCommandTool } from "../tools/builtin/shell/run-command-tool.js";
import { createWebfetchTool } from "../tools/builtin/web/fetch/tool.js";
import { createWebsearchTool } from "../tools/builtin/web/search/tool.js";
import { BUILTIN_TOOL_NAMES } from "../tools/catalog/tool-names.js";
import { type ToolsRecord } from "../tools/catalog/tool-set.js";
import { type AgentToolContext } from "../tools/runtime/tool-context.js";

import { BEGIN_SUMMARY_TOOL_NAME, createBeginSummaryTool } from "./begin-summary-tool.js";

import type { UsageTracker } from "../../runtime-types/hosts.js";

/**
 * Every tool in the default exploration subagent set, in definition order.
 *
 * `begin_summary` is the protocol marker that unlocks the summary phase, not a workspace-reading
 * tool. The read-only projection below removes it; both lists are shared with the runtime record
 * so a new tool cannot be added to one and forgotten in the other.
 */
export const SUBAGENT_TOOL_NAMES = [
  BUILTIN_TOOL_NAMES.readFile,
  BUILTIN_TOOL_NAMES.glob,
  BUILTIN_TOOL_NAMES.grep,
  BUILTIN_TOOL_NAMES.listFile,
  BUILTIN_TOOL_NAMES.tree,
  BUILTIN_TOOL_NAMES.webfetch,
  BUILTIN_TOOL_NAMES.websearch,
  BUILTIN_TOOL_NAMES.runCommand,
  BEGIN_SUMMARY_TOOL_NAME,
] as const;

/** The subset that only reads the workspace (excludes the `begin_summary` marker). */
export const SUBAGENT_READ_ONLY_TOOL_NAMES: readonly string[] = SUBAGENT_TOOL_NAMES.filter(
  (name) => name !== BEGIN_SUMMARY_TOOL_NAME
);

/**
 * Creates the restricted read-only tool set for exploration subagents.
 * Includes local fs exploration plus websearch/webfetch for external docs.
 */
export const createSubagentTools = (
  options: { context?: AgentToolContext; usage?: UsageTracker } = {}
): ToolsRecord => {
  const { context, usage } = options;
  return {
    [BUILTIN_TOOL_NAMES.readFile]: createReadFileTool({ usage }),
    [BUILTIN_TOOL_NAMES.glob]: createGlobTool(),
    [BUILTIN_TOOL_NAMES.grep]: createGrepTool(),
    [BUILTIN_TOOL_NAMES.listFile]: createListFileTool(),
    [BUILTIN_TOOL_NAMES.tree]: createTreeTool(),
    [BUILTIN_TOOL_NAMES.webfetch]: createWebfetchTool({ context }),
    [BUILTIN_TOOL_NAMES.websearch]: createWebsearchTool({ context }),
    [BUILTIN_TOOL_NAMES.runCommand]: createRunCommandTool({ subagentSafe: true, context }),
    [BEGIN_SUMMARY_TOOL_NAME]: createBeginSummaryTool(),
  };
};

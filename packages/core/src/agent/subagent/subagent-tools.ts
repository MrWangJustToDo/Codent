/**
 * Read-only tool set for exploration subagents.
 */

import { createGlobTool } from "../tools/glob-tool.js";
import { createGrepTool } from "../tools/grep-tool.js";
import { createListFileTool } from "../tools/list-file-tool.js";
import { createReadFileTool } from "../tools/read-file-tool.js";
import { createRunCommandTool } from "../tools/run-command-tool.js";
import { type ToolsRecord } from "../tools/runtime/tools-record.js";
import { BUILTIN_TOOL_NAMES } from "../tools/tool-names.js";
import { createTreeTool } from "../tools/tree-tool.js";
import { createWebfetchTool } from "../tools/webfetch-tool.js";
import { createWebsearchTool } from "../tools/websearch-tool.js";

import { BEGIN_SUMMARY_TOOL_NAME, createBeginSummaryTool } from "./begin-summary-tool.js";

import type { ManagedAgent } from "../../runtime-types/hosts.js";

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
export const createSubagentTools = (managed?: ManagedAgent): ToolsRecord => {
  return {
    [BUILTIN_TOOL_NAMES.readFile]: createReadFileTool({ usage: managed?.usage }),
    [BUILTIN_TOOL_NAMES.glob]: createGlobTool(),
    [BUILTIN_TOOL_NAMES.grep]: createGrepTool(),
    [BUILTIN_TOOL_NAMES.listFile]: createListFileTool(),
    [BUILTIN_TOOL_NAMES.tree]: createTreeTool(),
    [BUILTIN_TOOL_NAMES.webfetch]: createWebfetchTool({ managed }),
    [BUILTIN_TOOL_NAMES.websearch]: createWebsearchTool({ managed }),
    [BUILTIN_TOOL_NAMES.runCommand]: createRunCommandTool({ subagentSafe: true }),
    [BEGIN_SUMMARY_TOOL_NAME]: createBeginSummaryTool(),
  };
};

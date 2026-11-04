/**
 * Marker tool — signals the subagent has finished analysis and will write the final summary.
 */

import { z } from "zod";

import { BUILTIN_TOOL_NAMES } from "../tools/catalog/tool-names.js";
import { defineServerTool, isProjectedModelContent } from "../tools/runtime/define-tool.js";

/**
 * Tool name used to unlock task-tool summary streaming in the parent UI.
 *
 * Derives from the built-in registry rather than spelling the string again: the catalog is the one
 * place a built-in name is written, so a rename cannot leave this marker behind. Kept as an export
 * because the public entry and the dev harness reach the name through it.
 */
export const BEGIN_SUMMARY_TOOL_NAME = BUILTIN_TOOL_NAMES.beginSummary;

export const createBeginSummaryTool = () => {
  return defineServerTool({
    name: BEGIN_SUMMARY_TOOL_NAME,
    description: `Signal that exploration is complete and you are about to write the final summary.

Call this tool ONCE after you have gathered enough information and BEFORE writing your final summary text.
Do not call exploration tools (read_file, grep, glob, etc.) after this tool.

After calling begin_summary, write your complete answer as plain text in the same or next turn.`,

    inputSchema: z.object({}),
    outputSchema: z.object({
      ready: z.literal(true).describe("Summary phase unlocked"),
    }),

    execute: async () => ({ ready: true as const }),

    toModelOutput: ({ output }) =>
      isProjectedModelContent(output)
        ? output
        : [{ type: "text" as const, content: "Proceed with your final summary for the parent agent." }],
  });
};

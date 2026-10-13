/**
 * Marker tool — signals the subagent has finished analysis and will write the final summary.
 */

import { z } from "zod";

import { defineServerTool, isProjectedModelContent } from "../tools/runtime/define-tool.js";

/** Tool name used to unlock task-tool summary streaming in the parent UI. */
export const BEGIN_SUMMARY_TOOL_NAME = "begin_summary";

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

import { z } from "zod";

import { getEnv } from "../../env";

import { defineServerTool } from "./runtime/define-tool.js";
import { withDuration } from "./util/tool-result.js";
import { toolOutputBaseSchema } from "./util/types.js";

export const createDeleteFileTool = () => {
  return defineServerTool({
    name: "delete_file",
    present: { category: "edits" },
    description: "Deletes a file or directory. Requires user approval before execution.",
    inputSchema: z.object({
      path: z.string().describe("The path to the file or directory to delete, relative to the project directory."),
    }),
    outputSchema: z.object({
      path: z.string().describe("The path of the file or directory that was deleted."),
      durationMs: z.number().describe("Execution duration in milliseconds."),
      ...toolOutputBaseSchema.shape,
    }),
    needsApproval: true,
    execute: async ({ path }) => {
      return withDuration(async () => {
        await getEnv().fs.remove(path);
        return { path };
      });
    },
  });
};

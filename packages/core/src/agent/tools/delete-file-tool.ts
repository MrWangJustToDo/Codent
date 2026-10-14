import { z } from "zod";

import { defineServerTool } from "./runtime/define-tool.js";
import { withFileMutationQueue } from "./util/file-mutation-queue.js";
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
    execute: async ({ path }, { coreEnv }) => {
      // Through the same per-path queue as `write_file` / `edit_file`: without it a delete racing an
      // edit on the same path could remove the file the edit had just re-created (or the edit could
      // resurrect the deleted one), because the two ran concurrently.
      return withFileMutationQueue(coreEnv, path, async () =>
        withDuration(async () => {
          await coreEnv.fs.remove(path);
          return { path };
        })
      );
    },
  });
};

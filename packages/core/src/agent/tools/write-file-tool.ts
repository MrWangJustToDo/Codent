import { z } from "zod";

import { defineServerTool, isProjectedModelContent } from "./runtime/define-tool.js";
import { withFileMutationQueue } from "./util/file-mutation-queue.js";
import { withDuration } from "./util/tool-result.js";
import { writeFileOutputSchema } from "./util/types.js";

import type { WriteFileOutput } from "./util/types.js";

export const createWriteFileTool = () => {
  return defineServerTool({
    name: "write_file",
    present: { category: "edits" },
    description:
      "Writes the full content of a file. Prefer edit_file for surgical changes to existing files. " +
      "Creating a new file: omit overwrite (or set false). Overwriting an existing file: pass overwrite: true. " +
      "Parent directories are created by default. Concurrent writes to the same path are serialized.",
    inputSchema: z.object({
      path: z.string().describe("The path to the file to write, relative to the project root."),
      content: z.string().describe("The full content to write to the file."),
      overwrite: z
        .boolean()
        .optional()
        .describe(
          "Must be true when replacing an existing file. Omit or false when creating a new file. Prefer edit_file instead of overwrite when possible."
        ),
      createDirectories: z
        .boolean()
        .optional()
        .describe("If true, create parent directories if they don't exist. Defaults to true."),
    }),
    outputSchema: writeFileOutputSchema,
    needsApproval: true,
    execute: async ({ path, content, overwrite, createDirectories }, { coreEnv }) => {
      return withFileMutationQueue(coreEnv, path, async () =>
        withDuration(async () => {
          const fs = coreEnv.fs;
          const fileExisted = await fs.exists(path);

          if (fileExisted && overwrite !== true) {
            throw new Error(
              `File already exists: ${path}. Use edit_file for surgical edits, or pass overwrite: true to replace the entire file.`
            );
          }

          const lastSlashIndex = path.lastIndexOf("/");
          if (lastSlashIndex > 0 && (createDirectories ?? true)) {
            const dirPath = path.substring(0, lastSlashIndex);
            const dirExists = await fs.exists(dirPath);
            if (!dirExists) {
              await fs.mkdir(dirPath);
            }
          }

          await fs.writeFile(path, content);

          return {
            path,
            bytesWritten: content.length,
            created: !fileExisted,
          };
        })
      );
    },
    toModelOutput({ output }: { toolCallId: string; input: unknown; output: WriteFileOutput }) {
      if (isProjectedModelContent(output)) return output;
      return [
        {
          type: "text" as const,
          content: `${output.created ? "Created" : "Overwrote"} file: ${output.path} `,
        },
      ];
    },
  });
};

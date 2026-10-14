import { z } from "zod";

import { utf8ByteLength } from "../../utils/bytes.js";
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

          // `path.dirname`, not `lastIndexOf("/")`: the workspace path helper knows the host's
          // separator, so a Windows-shaped path creates its parent instead of silently skipping it.
          const dirPath = coreEnv.path.dirname(path);
          if (dirPath && dirPath !== "." && dirPath !== path && (createDirectories ?? true)) {
            const dirExists = await fs.exists(dirPath);
            if (!dirExists) {
              await fs.mkdir(dirPath);
            }
          }

          // Replace through a temp file when the host offers `rename` (its documented purpose is to
          // "write a temp file, then rename it into place"), so an interrupted write leaves the
          // previous content intact instead of a half-written file. A host without it writes directly,
          // which is what every host did before.
          if (fs.rename) {
            const tempPath = `${path}.tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
            await fs.writeFile(tempPath, content);
            try {
              await fs.rename(tempPath, path);
            } catch (error) {
              await fs.remove(tempPath).catch(() => {});
              throw error;
            }
          } else {
            await fs.writeFile(path, content);
          }

          return {
            path,
            // Bytes, not UTF-16 code units: the field says "Number of bytes written", and a CJK
            // character is three of them for one code unit.
            bytesWritten: utf8ByteLength(content),
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

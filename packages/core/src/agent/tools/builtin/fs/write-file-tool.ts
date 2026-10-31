import { z } from "zod";

import { writeFileAtomic } from "../../../../utils/atomic-write.js";
import { utf8ByteLength } from "../../../../utils/bytes.js";
import { defineServerTool, isProjectedModelContent } from "../../runtime/define-tool.js";
import { writeFileOutputSchema } from "../../shared/schemas.js";
import { withDuration } from "../../shared/tool-result.js";

import { withFileMutationQueue } from "./edit/mutation-queue.js";

import type { WriteFileOutput } from "../../shared/schemas.js";

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

          // A temp file takes its mode from the umask, so replacing an existing file must carry the
          // original bits over or an executable script silently loses `+x`.
          // `stat` is part of the interface but a minimal/embedded host may omit it; mode
          // preservation then degrades to the umask default like any other host without `chmod`.
          const existingMode = fileExisted && fs.stat ? (await fs.stat(path).catch(() => undefined))?.mode : undefined;

          // Temp file + rename when the host offers it, so an interrupted write leaves the
          // previous content intact instead of a half-written file. `onError: "throw"` keeps the
          // tool's own policy: a failed atomic write must surface, not silently degrade.
          await writeFileAtomic(coreEnv.fs, path, content, {
            onError: "throw",
            ...(existingMode !== undefined ? { mode: existingMode } : {}),
          });

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

import { z } from "zod";

import { truncateText } from "../../../../utils/text-truncation.js";
import { defineServerTool, isProjectedModelContent } from "../../runtime/define-tool.js";
import { editFileOutputSchema } from "../../shared/schemas.js";
import { getFile, withDuration } from "../../shared/tool-result.js";

import { applyResolvedEdit, isErrorResult, resolveEditMatch } from "./edit/find-edit-match.js";
import { normalizeForFuzzyMatch } from "./edit/fuzzy-match.js";
import { withFileMutationQueue } from "./edit/mutation-queue.js";

import type { EditFileOutput } from "../../shared/schemas.js";

// ============================================================================
// Helpers
// ============================================================================

function findLineNumber(content: string, index: number): number {
  if (index < 0) return -1;
  let line = 1;
  let from = 0;
  while (true) {
    const nl = content.indexOf("\n", from);
    if (nl === -1 || nl >= index) break;
    line++;
    from = nl + 1;
  }
  return line;
}

// ============================================================================
// Main Tool
// ============================================================================

/**
 * Creates an edit-file tool for replacing text in files.
 *
 * Safety without modifiedTime:
 * - Per-file mutation queue serializes concurrent edits to the same path
 * - oldString must uniquely match (unless replaceAll) — wrong/stale text fails naturally
 * - Edits apply in memory first; disk write only after all succeed (atomic)
 * - User approval is still required before execution
 */
export const createEditFileTool = () => {
  return defineServerTool({
    name: "edit_file",
    present: { category: "edits" },
    description: `Edits a file by replacing oldString with newString. Supports one or more edits via the \`edits\` array.

**Key Rules:**
- Prefer edit_file over write_file for existing files (surgical edits).
- Use real newlines in oldString/newString (not the two-character sequence \\\\n).
- newString must differ from oldString — identical strings are rejected as a no-op.
- Each oldString must appear exactly once unless replaceAll is true.
- Provide startLine (1-indexed, from read_file) when the snippet may appear more than once — it selects the nearest match within ±20 lines.
- Matching tolerates common LLM over-escapes (\\\\n, over-escaped backticks) and smart-quote Unicode differences.
- If a match fails, the error includes a nearest similar line — re-read there and widen oldString.`,
    inputSchema: z.object({
      path: z.string().describe("The path to the file to edit, relative to the project root."),
      edits: z
        .array(
          z.object({
            oldString: z.string().describe("The exact string to search for and replace."),
            newString: z.string().describe("The string to replace oldString with. Must differ from oldString."),
            replaceAll: z.boolean().optional().describe("If true, replace all occurrences of this string."),
            startLine: z
              .number()
              .int({ message: "startLine: must be an integer" })
              .min(1, { message: "startLine: must be >= 1 (1-indexed)" })
              .optional()
              .describe(
                "1-indexed line where oldString starts (from read_file). Required to disambiguate multiple matches; must be within ±20 lines of the real hit."
              ),
          })
        )
        .min(1, { message: "edits: must contain at least 1 edit operation" })
        .describe("Array of edit operations to apply sequentially. For a single edit, pass an array with one element."),
    }),
    outputSchema: editFileOutputSchema,
    needsApproval: true,
    execute: async ({ path, edits }, { coreEnv }) => {
      return withFileMutationQueue(coreEnv, path, async () =>
        withDuration(async () => {
          const originalContent = await getFile(coreEnv, path);

          let content = originalContent;
          let normalizedContent = normalizeForFuzzyMatch(content);
          let normalizedValid = true;
          const results: EditFileOutput["results"] = [];

          for (const edit of edits) {
            if (!normalizedValid) {
              normalizedContent = normalizeForFuzzyMatch(content);
              normalizedValid = true;
            }

            const match = resolveEditMatch(content, edit.oldString, edit.newString, {
              replaceAll: edit.replaceAll,
              startLine: edit.startLine,
              normalizedContent,
            });

            if (isErrorResult(match)) {
              throw new Error(
                `edit_file failed, no changes were written: "${truncateText(edit.oldString, 100)}": ${match.error}`
              );
            }

            const newContent = applyResolvedEdit(content, match, Boolean(edit.replaceAll), normalizedContent);
            const actualLine = findLineNumber(content, match.index);

            results.push({
              oldString: truncateText(edit.oldString, 50),
              newString: truncateText(edit.newString, 50),
              found: true,
              replaced: true,
              count: match.occurrences,
              startLine: edit.startLine,
              actualLine: actualLine > 0 ? actualLine : undefined,
            });

            if (newContent !== content) {
              content = newContent;
              normalizedValid = false;
            }
          }

          await coreEnv.fs.writeFile(path, content);

          const totalReplacements = results.reduce((sum, r) => sum + r.count, 0);

          return {
            path,
            replacements: totalReplacements,
            oldFile: originalContent,
            newFile: content,
            results,
          };
        })
      );
    },
    toModelOutput: ({ output }: { toolCallId: string; input: unknown; output: EditFileOutput }) => {
      if (isProjectedModelContent(output)) return output;
      return [
        {
          type: "text" as const,
          content: `Edited ${output.path} (${output.replacements} replacement${output.replacements !== 1 ? "s" : ""})`,
        },
      ];
    },
  });
};

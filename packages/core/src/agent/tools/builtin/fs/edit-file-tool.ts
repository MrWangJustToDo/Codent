import { z } from "zod";

import { defineServerTool, isProjectedModelContent } from "../../runtime/define-tool.js";
import { editFileOutputSchema } from "../../shared/schemas.js";
import { withDuration } from "../../shared/tool-result.js";

import { applyEditToFile } from "./edit/apply-edit.js";
import { normalizeEditArguments } from "./edit/arguments.js";
import { formatEditResultForModel } from "./edit/format-result.js";

import type { EditFileOutput } from "../../shared/schemas.js";

// ============================================================================
// Input schema
// ============================================================================

const editOperationSchema = z.object({
  oldString: z
    .string()
    .describe("The exact text to find. Copy it from read_file without the `N: ` line-number prefix."),
  newString: z.string().describe("The replacement text. Must differ from oldString."),
  replaceAll: z
    .boolean()
    .optional()
    .describe("Replace every occurrence. Without it, oldString must match exactly one location."),
});

const editFileInputSchema = z.object({
  path: z.string().describe("The path to the file to edit, relative to the project root."),
  edits: z
    .array(editOperationSchema)
    .min(1, { message: "edits: must contain at least 1 edit operation" })
    .describe("Array of edit operations. For a single edit, pass an array with one element."),
});

/**
 * The runtime schema is a `preprocess` (coercion) pipe, but its OUTPUT is exactly
 * {@link editFileInputSchema}. `InferSchemaType` cannot see through the pipe's `unknown` input, so
 * the cast restates the one thing the tool body needs: what it receives after parsing. Validation
 * still runs the coercion first.
 */
const editFileInputSchemaWithCoercion = z.preprocess(
  normalizeEditArguments,
  editFileInputSchema
) as unknown as typeof editFileInputSchema;

// ============================================================================
// Main Tool
// ============================================================================

/**
 * Creates an edit-file tool for replacing text in files.
 *
 * Contract (see `edit/find-edit-match.ts` for the matcher, `edit/apply-edit.ts` for the write):
 * - every edit is matched against the ORIGINAL file, never incrementally;
 * - edits must not overlap; a refusing edit means nothing is written;
 * - matching tolerates line-ending, trailing-whitespace and indentation differences;
 * - `oldString === newString` is a no-op (reported, not an error);
 * - concurrent edits to one path are serialized, and the write is refused if the file changed
 *   after it was read.
 */
export const createEditFileTool = () => {
  return defineServerTool({
    name: "edit_file",
    present: { category: "edits" },
    description: `Edits a file by replacing oldString with newString. Supports one or more edits via the \`edits\` array.

**Key Rules:**
- Prefer edit_file over write_file for existing files (surgical edits).
- oldString must match exactly one location unless replaceAll is true. Add surrounding lines to make it unique; merge edits that touch the same or nearby code into one.
- Every edit in a call is matched against the ORIGINAL file. Edits must not overlap.
- Copy oldString from read_file **without** the \`N: \` line-number prefix. Use real newlines, not the two-character sequence \\n.
- Matching tolerates CRLF/LF differences, trailing whitespace, indentation drift and typographic quotes/dashes; a line that matches with different indentation keeps the file's indentation. A mixed-ending file is normalized to its dominant ending.
- newString must differ from oldString. If they are identical the edit is skipped as a no-op; the rest of the batch still applies.
- If a match fails, the error lists the closest lines (numbered like read_file) — copy from there and retry.`,
    inputSchema: editFileInputSchemaWithCoercion,
    outputSchema: editFileOutputSchema,
    needsApproval: true,
    execute: async ({ path, edits }, { coreEnv }) => {
      return withDuration(() => applyEditToFile(coreEnv, path, edits));
    },
    toModelOutput: ({ output }: { toolCallId: string; input: unknown; output: EditFileOutput }) => {
      if (isProjectedModelContent(output)) return output;
      return [{ type: "text" as const, content: formatEditResultForModel(output) }];
    },
  });
};

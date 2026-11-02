/**
 * Edit Preview — compute the before/after file content for a set of edits.
 *
 * Used by the UI to show a full-file diff during the approval phase, before the edit_file tool's
 * `execute()` runs. It runs the SAME pipeline as the tool (`applyEditsToText`: BOM split, LF view,
 * matching ladder, non-overlap, splice, line-ending restore), so the approved diff is byte-identical
 * to what the tool writes — including the cases where the tool refuses and writes nothing.
 *
 * The earlier version re-implemented matching and drifted from the tool (escape variants,
 * `startLine`, uniqueness). Re-implementing it again would repeat that; there is exactly one
 * matcher, and both sides call it.
 */

import { getEnv, type CoreEnv } from "../../../../../env";

import { normalizeEditArguments } from "./arguments.js";
import { applyEditsToText, type EditOperation } from "./find-edit-match.js";

// ============================================================================
// Types
// ============================================================================

/** A single edit operation, matching the edit_file tool's input shape. */
export interface PreviewEditInput {
  /** File path relative to the project root. */
  path: string;
  /** Array of edit operations, all matched against the original file. */
  edits: EditOperation[];
}

/** Result of previewing an edit operation. */
export interface PreviewEditResult {
  /** The original file content before any edits. */
  oldFile: string;
  /** The full file content after all edits have been applied. */
  newFile: string;
  /**
   * Set when the tool would refuse this set, in which case it writes nothing at all and `newFile`
   * equals `oldFile`. The reason is the tool's own, so the approval UI can say why the diff is empty.
   */
  error?: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Compute the before/after file content for a set of edits without writing to disk.
 *
 * @param input - The edit operation parameters (path + edits array).
 * @returns The original and modified file content.
 *
 * @example
 * ```typescript
 * const { oldFile, newFile } = await previewEdit({
 *   path: "src/foo.ts",
 *   edits: [{ oldString: "bar", newString: "baz" }],
 * });
 * ```
 */
export async function previewEdit(input: PreviewEditInput, env?: CoreEnv): Promise<PreviewEditResult> {
  // The tool accepts JSON-string / single-object / legacy shapes; the preview must see the same
  // edits the tool will run, or it previews a different change (or none) than the one written.
  const { path, edits } = normalizeEditArguments(input) as { path: string; edits?: unknown };
  if (!Array.isArray(edits) || edits.length === 0) {
    const oldFile = await (env ?? getEnv()).fs.readFile(path);
    return { oldFile, newFile: oldFile, error: "edits: must contain at least 1 edit operation" };
  }

  const oldFile = await (env ?? getEnv()).fs.readFile(path);
  const applied = applyEditsToText(oldFile, edits as EditOperation[]);
  if (!applied.ok) {
    // The tool throws on the first unresolved edit and writes nothing at all, so the honest preview
    // of this set is the original file plus the reason. A partial application would show a diff for
    // a write that never happens.
    return { oldFile, newFile: oldFile, error: applied.message };
  }

  return { oldFile, newFile: applied.content };
}

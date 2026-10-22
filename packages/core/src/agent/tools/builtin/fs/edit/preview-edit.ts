/**
 * Edit Preview — compute the before/after file content for a set of edits.
 *
 * Used by the UI to show a full-file diff during the approval phase, before
 * the edit_file tool's `execute()` runs. It reads the file from disk (via CoreEnv) and resolves each
 * edit through the tool's own matcher ({@link resolveEditMatch} / {@link applyResolvedEdit}), so the
 * approved diff is what the tool writes.
 *
 * It used to re-implement the matching (exact `includes` → fuzzy), which drifted from the tool in
 * three ways that all pointed the same direction — a diff that is not the write: it never tried the
 * over-escape variants the tool tries (so an escaped `oldString` previewed as *no change* while the
 * tool would have written one), it ignored `startLine` (so with several matches the preview rewrote
 * the first while the tool rewrote the one near that line), and it did not enforce uniqueness (so an
 * edit the tool refuses previewed as an applied change).
 */

import { getEnv, type CoreEnv } from "../../../../../env";

import { applyResolvedEdit, isErrorResult, resolveEditMatch } from "./find-edit-match.js";
import { normalizeForFuzzyMatch } from "./fuzzy-match.js";

// ============================================================================
// Types
// ============================================================================

/** A single edit operation, matching the edit_file tool's input shape. */
export interface PreviewEditInput {
  /** File path relative to the project root. */
  path: string;
  /** Array of edit operations to apply sequentially. */
  edits: Array<{
    oldString: string;
    newString: string;
    replaceAll?: boolean;
    /** 1-indexed line the edit is expected at, as the tool receives it (disambiguates matches). */
    startLine?: number;
  }>;
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
 * Compute the before/after file content for a set of edits without writing
 * to disk.
 *
 * Mirrors the edit_file tool's matching/replacement logic (exact match first,
 * then fuzzy match fallback) so the preview matches what the tool would
 * actually produce. Reuses a single normalized-content cache across all edits
 * to avoid re-scanning the whole file on every edit.
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
  const { path, edits } = input;

  const oldFile = await (env ?? getEnv()).fs.readFile(path);

  let content = oldFile;
  // Normalize once and reuse; invalidated whenever `content` changes.
  let normalizedContent = normalizeForFuzzyMatch(content);
  let normalizedContentValid = true;

  for (const edit of edits) {
    // Ensure the normalized cache reflects the current `content`.
    if (!normalizedContentValid) {
      normalizedContent = normalizeForFuzzyMatch(content);
      normalizedContentValid = true;
    }

    const match = resolveEditMatch(content, edit.oldString, edit.newString, {
      replaceAll: edit.replaceAll,
      startLine: edit.startLine,
      normalizedContent,
    });

    if (isErrorResult(match)) {
      // The tool throws on the first unresolved edit and writes nothing at all (its
      // `fs.writeFile` sits after the loop), so the honest preview of this set is the original file,
      // plus the reason. Reporting a partial application would show a diff for a write that never
      // happens.
      return { oldFile, newFile: oldFile, error: match.error };
    }

    const next = applyResolvedEdit(content, match, Boolean(edit.replaceAll), normalizedContent);
    if (next !== content) {
      content = next;
      normalizedContentValid = false; // content changed, invalidate cache
    }
  }

  return { oldFile, newFile: content };
}

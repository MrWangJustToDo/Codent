/**
 * Edit Preview — compute the before/after file content for a set of edits.
 *
 * Used by the UI to show a full-file diff during the approval phase, before
 * the edit_file tool's `execute()` runs. The function reads the file from disk
 * (via CoreEnv) and applies the same matching/replacement logic as the tool
 * itself (exact match first, then fuzzy match fallback).
 */

import { getEnv, type CoreEnv } from "../../../env";

import { fuzzyIncludes, fuzzyReplace, fuzzyReplaceAll, normalizeForFuzzyMatch } from "./fuzzy-match.js";

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
  }>;
}

/** Result of previewing an edit operation. */
export interface PreviewEditResult {
  /** The original file content before any edits. */
  oldFile: string;
  /** The full file content after all edits have been applied. */
  newFile: string;
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
    const hasExactMatch = content.includes(edit.oldString);

    // Ensure the normalized cache reflects the current `content`.
    if (!normalizedContentValid) {
      normalizedContent = normalizeForFuzzyMatch(content);
      normalizedContentValid = true;
    }

    const hasFuzzyMatch = hasExactMatch || fuzzyIncludes(content, edit.oldString, normalizedContent);

    // If neither match is found, skip this edit (the tool would throw, but
    // for preview purposes we just leave the content unchanged so the UI can
    // still show a partial diff).
    if (!hasExactMatch && !hasFuzzyMatch) {
      continue;
    }

    let newContent: string;
    if (hasExactMatch) {
      newContent = edit.replaceAll
        ? content.replaceAll(edit.oldString, edit.newString)
        : content.replace(edit.oldString, edit.newString);
    } else {
      newContent = edit.replaceAll
        ? fuzzyReplaceAll(content, edit.oldString, edit.newString, normalizedContent)
        : fuzzyReplace(content, edit.oldString, edit.newString, normalizedContent);
    }

    if (newContent !== content) {
      content = newContent;
      normalizedContentValid = false; // content changed, invalidate cache
    }
  }

  return { oldFile, newFile: content };
}

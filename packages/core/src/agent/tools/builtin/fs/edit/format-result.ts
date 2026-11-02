/**
 * Model-facing projection for `edit_file`: a one-line verdict plus a short view of the result.
 *
 * Pure (a function of the persisted output only) — `toModelOutput` may be re-run on a restored
 * session, so it must not depend on the clock or on the file's current contents.
 */

import { splitBom } from "./find-edit-match.js";

import type { EditFileOutput } from "../../../shared/schemas.js";

/** Max combined size before the line scan is skipped (the snippet is not worth an O(n) copy). */
const SNIPPET_MAX_INPUT_CHARS = 2_000_000;
const SNIPPET_CONTEXT_LINES = 3;
const SNIPPET_MAX_LINE_CHARS = 160;

/**
 * 1-indexed line that differs between the two texts.
 *
 * The snippet points at the NEW file: a batch whose first edit inserts lines above a later edit
 * would otherwise show the later edit's original line number, i.e. a window that misses the change.
 */
export function firstDifferingLine(oldText: string, newText: string): number | undefined {
  if (oldText.length + newText.length > SNIPPET_MAX_INPUT_CHARS) return undefined;
  const before = splitBom(oldText).text.split("\n");
  const after = splitBom(newText).text.split("\n");
  const count = Math.max(before.length, after.length);
  for (let index = 0; index < count; index++) {
    if ((before[index] ?? null) !== (after[index] ?? null)) return index + 1;
  }
  return undefined;
}

/** Build the text the model sees after an edit. Tolerant of a minimal/restored output shape. */
export function formatEditResultForModel(output: EditFileOutput): string {
  const results = Array.isArray(output.results) ? output.results : [];
  const replacements = typeof output.replacements === "number" ? output.replacements : 0;
  const changedLine =
    typeof output.oldFile === "string" && typeof output.newFile === "string"
      ? firstDifferingLine(output.oldFile, output.newFile)
      : results.find((result) => result.replaced)?.actualLine;

  const plural = replacements === 1 ? "" : "s";
  const lines = [`Edited ${output.path} (${replacements} replacement${plural})`];

  if (changedLine !== undefined && typeof output.newFile === "string") {
    // A short view of the result: the model can see WHICH lines changed, so an edit that landed in
    // the wrong place is caught on the next turn instead of several turns later.
    const contentLines = splitBom(output.newFile).text.split("\n");
    const from = Math.max(0, changedLine - SNIPPET_CONTEXT_LINES);
    const to = Math.min(contentLines.length, changedLine + SNIPPET_CONTEXT_LINES);
    for (let index = from; index < to; index++) {
      // A CRLF file keeps its `\r` when split on `\n`; it is not part of the visible line.
      const line = (contentLines[index] ?? "").replace(/\r$/, "");
      lines.push(
        `${index + 1}: ${line.length > SNIPPET_MAX_LINE_CHARS ? `${line.slice(0, SNIPPET_MAX_LINE_CHARS)}…` : line}`
      );
    }
  } else if (results.some((result) => result.skipped)) {
    lines.push("No change was needed: oldString and newString were identical.");
  }

  return lines.join("\n");
}

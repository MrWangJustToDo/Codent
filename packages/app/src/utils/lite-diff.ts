/**
 * LiteDiff — cheap unified-diff pipeline for message-view previews.
 *
 * Modeled after gemini-cli's DiffRenderer: jsdiff `createPatch` (context 1)
 * runs once per content change, the patch string is parsed into rows, and
 * only changed hunks (+ minimal context) are rendered. Pure module — no React —
 * so it can be unit-tested and memoized by the component layer.
 */

import { createPatch } from "diff";

/** Lines of context kept around each hunk — lite keeps it minimal to save height. */
const CONTEXT_LINES = 1;
/** Collapse a context run into a gap marker once the line-number jump exceeds this. */
const MAX_CONTEXT_LINES_WITHOUT_GAP = 5;

/**
 * Default render-row cap for a message-view diff preview.
 *
 * This is a *preview*: the change's shape, not its contents. It used to be 40, which is more
 * rows than a typical terminal has (`rows` is often 24), so a single `edit_file` row could
 * occupy the whole viewport and push the conversation off screen. Twenty leaves room for the
 * tool row's own header, the surrounding conversation and the fold line, so the diff stays
 * identifiable while the transcript around it remains readable.
 *
 * Lives here, in the pure pipeline, because the component default and this fallback used to be
 * two separate 40s that agreed only by luck — a caller omitting `maxLines` would silently
 * re-adopt the old value the moment one of them was tuned.
 */
export const LITE_DIFF_MAX_LINES = 20;

export type LiteDiffRowType = "add" | "del" | "context" | "gap";

/**
 * Gutter mode for the row grid:
 *  - `"both"` — two line-number columns (old + new),
 *  - `"add"`  — whole-file addition (only new numbers exist),
 *  - `"del"`  — whole-file deletion (only old numbers exist).
 */
export type LiteDiffColumns = "both" | "add" | "del";

export interface LiteDiffRow {
  type: LiteDiffRowType;
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface LiteDiffResult {
  rows: LiteDiffRow[];
  additions: number;
  deletions: number;
  /** Rows hidden by the maxLines cap (0 when everything fits). */
  hidden: number;
  /** Type of the first hidden row, when any (drives the fold-line background). */
  hiddenType?: LiteDiffRowType;
  /** Gutter mode; "add"/"del" collapse the twin line-number column away. */
  columns: LiteDiffColumns;
}

export interface LiteDiffOptions {
  /** Max rendered rows before tail truncation (default {@link LITE_DIFF_MAX_LINES}). */
  maxLines?: number;
  /** Render row cap; pass Infinity to disable truncation. */
}

const HUNK_HEADER = /^@@ -(\d+),?\d* \+(\d+),?\d* @@/;

/** Parse a unified patch string into typed rows with line numbers. */
export function parsePatchRows(patch: string): LiteDiffRow[] {
  const rows: LiteDiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff ") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ "))
      continue;

    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    // Stop at the "no newline" marker tail (\ No newline at end of file).
    if (raw.startsWith("\\")) continue;

    if (oldLine === 0 && newLine === 0) continue; // prelude lines before first hunk

    if (raw.startsWith("+")) {
      rows.push({ type: "add", newLine, text: raw.slice(1) });
      newLine++;
    } else if (raw.startsWith("-")) {
      rows.push({ type: "del", oldLine, text: raw.slice(1) });
      oldLine++;
    } else {
      rows.push({ type: "context", oldLine, newLine, text: raw.startsWith(" ") ? raw.slice(1) : raw });
      oldLine++;
      newLine++;
    }
  }

  return rows;
}

/**
 * Build render rows from file contents:
 *  - hunk regions only (context 3),
 *  - context runs longer than {@link MAX_CONTEXT_LINES_WITHOUT_GAP} collapse into gap markers,
 *  - tail truncation at `maxLines` (head-first, like a code preview).
 */
export function createLiteDiff(oldFile: string, newFile: string, options: LiteDiffOptions = {}): LiteDiffResult {
  const maxLines = options.maxLines ?? LITE_DIFF_MAX_LINES;

  let additions = 0;
  let deletions = 0;
  const rows: LiteDiffRow[] = [];
  let hidden = 0;
  let hiddenType: LiteDiffRowType | undefined;

  const bothEmpty = oldFile === "" && newFile === "";
  const patch = bothEmpty ? "" : createPatch("", oldFile, newFile, "", "", { context: CONTEXT_LINES });
  const parsed = parsePatchRows(patch);

  // jsdiff appends a phantom trailing empty context line when the new content
  // ends with "\n" (with an empty old file its old-side counter starts at 0,
  // rendering as a stray "0 12"-style row). Drop it — it corresponds to the
  // final newline, not a real file line.
  while (parsed.length && parsed[parsed.length - 1].type === "context" && parsed[parsed.length - 1].text === "") {
    parsed.pop();
  }

  for (const row of parsed) {
    if (row.type === "add") additions++;
    else if (row.type === "del") deletions++;
  }

  const push = (row: LiteDiffRow) => {
    if (rows.length >= maxLines) {
      hidden++;
      if (hiddenType === undefined) hiddenType = row.type;
      return;
    }
    rows.push(row);
  };

  // Collapse long context runs: any line-number jump larger than
  // MAX_CONTEXT_LINES_WITHOUT_GAP (typically between two hunks) is hidden
  // behind a gap marker. Both the old and new tracks are tracked so del/add
  // rows inside a hunk don't false-trigger.
  let oldLast: number | undefined;
  let newLast: number | undefined;
  for (const row of parsed) {
    const track = row.type === "del" ? row.oldLine : row.newLine;
    const last = row.type === "del" ? oldLast : newLast;
    if (
      row.type !== "gap" &&
      track !== undefined &&
      last !== undefined &&
      track - last > MAX_CONTEXT_LINES_WITHOUT_GAP
    ) {
      push({ type: "gap", text: "" });
    }
    if (row.type !== "gap") {
      if (row.oldLine !== undefined) oldLast = row.oldLine;
      if (row.newLine !== undefined) newLast = row.newLine;
    }
    push(row);
  }

  // Whole-file add/delete diffs only carry one side of line numbers; the
  // renderer collapses the gutter to a single column in that case instead of
  // reserving an empty twin.
  const nonGap = rows.filter((r) => r.type !== "gap");
  const columns: LiteDiffColumns =
    nonGap.length > 0 && nonGap.every((r) => r.type === "add")
      ? "add"
      : nonGap.length > 0 && nonGap.every((r) => r.type === "del")
        ? "del"
        : "both";

  return { rows, additions, deletions, hidden, hiddenType, columns };
}

/** Cheap +/- stat for headers (no row building). */
export function getLiteDiffStats(oldFile: string, newFile: string): { additions: number; deletions: number } {
  const patch = oldFile === "" && newFile === "" ? "" : createPatch("", oldFile, newFile, "", "", { context: 0 });
  const rows = parsePatchRows(patch);
  const additions = rows.filter((r) => r.type === "add").length;
  const deletions = rows.filter((r) => r.type === "del").length;
  return { additions, deletions };
}

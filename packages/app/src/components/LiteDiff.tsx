import { Box, Text } from "ink";
import { memo, useMemo } from "react";

import { BG, COLORS } from "../theme/colors.js";
import { syntaxColorForClasses } from "../theme/syntax-colors.js";
import { highlightLines, langForPath } from "../utils/lite-diff-highlight.js";
import { createLiteDiff, LITE_DIFF_MAX_LINES, type LiteDiffRow } from "../utils/lite-diff.js";

import type { LiteDiffSegment } from "../utils/lite-diff-highlight.js";

/**
 * Cheap diff renderer for message-view previews.
 *
 * Unlike {@link FileDiffContent} (full `@git-diff-view` Split/Unified views for
 * the interactive workspace), this renders only the changed hunks of a unified
 * patch with hunk-region highlight (adjacent rows share one tokenizer pass,
 * so multi-line constructs stay colored correctly) and a FIFO segment cache —
 * O(hunk) instead of O(file), and free on re-render when content is unchanged.
 */
export type LiteDiffProps = {
  oldPath: string;
  newPath: string;
  oldFile: string;
  newFile: string;
  width: number;
  /** Max rendered rows before tail truncation (default {@link LITE_DIFF_MAX_LINES}). */
  maxLines?: number;
  /** 1-based line offset for fragment diffs (prepends virtual empty lines). */
  startLine?: number;
};

function padNum(value: number | undefined, width: number): string {
  if (value === undefined) return " ".repeat(width);
  return String(value).padStart(width, " ");
}

function rowBackground(type: LiteDiffRow["type"]): string | undefined {
  if (type === "add") return BG.diffAdded;
  if (type === "del") return BG.diffRemoved;
  if (type === "context") return BG.diffContext;
  return undefined;
}

function rowMarker(type: LiteDiffRow["type"]): string {
  if (type === "add") return "+";
  if (type === "del") return "-";
  return " ";
}

export const LiteDiff = memo(function LiteDiff({
  oldPath,
  newPath,
  oldFile,
  newFile,
  width,
  maxLines = LITE_DIFF_MAX_LINES,
  startLine,
}: LiteDiffProps) {
  const paddedOld = startLine && startLine > 1 ? "\n".repeat(startLine - 1) + oldFile : oldFile;
  const paddedNew = startLine && startLine > 1 ? "\n".repeat(startLine - 1) + newFile : newFile;

  const result = useMemo(() => createLiteDiff(paddedOld, paddedNew, { maxLines }), [paddedOld, paddedNew, maxLines]);

  const lang = useMemo(() => langForPath(newPath || oldPath), [newPath, oldPath]);

  const rows = result.rows;

  // Highlight whole hunk regions (runs of adjacent rows, split at gap markers)
  // so the tokenizer sees cross-line context, then split back to per-row
  // segments for rendering.
  const segmentsByRow = useMemo(() => {
    const perRow: Array<LiteDiffSegment[] | undefined> = new Array(rows.length).fill(undefined);
    if (!lang) return perRow;
    let start = 0;
    const flush = (endExclusive: number) => {
      const segs = highlightLines(
        rows.slice(start, endExclusive).map((r) => r.text),
        lang
      );
      for (let i = 0; i < segs.length; i++) perRow[start + i] = segs[i];
    };
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].type === "gap") {
        if (i > start) flush(i);
        start = i + 1;
      }
    }
    if (rows.length > start) flush(rows.length);
    return perRow;
  }, [rows, lang]);
  const maxOld = rows.reduce((acc, r) => Math.max(acc, r.oldLine ?? 0), 0);
  const maxNew = rows.reduce((acc, r) => Math.max(acc, r.newLine ?? 0), 0);
  const numWidth = Math.max(1, String(Math.max(maxOld, maxNew)).length);
  // Whole-file add/delete only have one line-number side — collapse the
  // gutter to a single column instead of reserving an empty twin.
  const singleColumn = result.columns !== "both";
  // The fold line (`··· N more lines`) collapses the hidden tail, so its
  // background previews the content that resumes below it (add → green,
  // del → red, context → diffContext) instead of a flat default/diffContext
  // that would sit oddly against the resumed line.
  const hiddenBg = result.hiddenType ? rowBackground(result.hiddenType) : BG.diffContext;

  if (rows.length === 0) {
    return <Text color={COLORS.muted}>{oldFile === "" && newFile === "" ? "empty file" : "no changes"}</Text>;
  }

  return (
    <Box flexDirection="column" flexShrink={0} width={width}>
      {rows.map((row, i) => {
        if (row.type === "gap") {
          // Hunk separator — keeps the leading ··· marker, drops the trailing
          // ⋯ ellipsis; the row Box carries the diff background across the
          // full width so the skipped-region break reads as a quiet gap.
          return (
            <Box key={`gap-${i}`} width={width} flexShrink={0} backgroundColor={BG.diffContext}>
              <Text color={COLORS.muted} dimColor>
                {" ···"}
              </Text>
            </Box>
          );
        }
        const bg = rowBackground(row.type);
        const marker = rowMarker(row.type);
        const rawText = row.text;
        const segments = segmentsByRow[i];
        // Rows mirror gemini-cli's DiffRenderer: a fixed gutter followed by a
        // wrapping content Text, so long lines fold onto continuation rows
        // (aligned under the content column) instead of being truncated.
        // The row Box carries the add/del background across the full rect —
        // including wrapped continuation rows and trailing empty cells — so no
        // fill padding is needed.
        return (
          <Box key={i} flexDirection="row" width={width} flexShrink={0} backgroundColor={bg}>
            <Box flexShrink={0}>
              <Text color={COLORS.muted} dimColor backgroundColor={bg}>
                {singleColumn
                  ? ` ${padNum(row.oldLine ?? row.newLine, numWidth)} ${marker} `
                  : ` ${padNum(row.oldLine, numWidth)} ${padNum(row.newLine, numWidth)} ${marker} `}
              </Text>
            </Box>
            <Text wrap="wrap" color={COLORS.text} backgroundColor={bg}>
              {segments
                ? segments.map((seg, si) =>
                    seg.text ? (
                      <Text key={si} color={syntaxColorForClasses(seg.classes)}>
                        {seg.text}
                      </Text>
                    ) : null
                  )
                : rawText}
            </Text>
          </Box>
        );
      })}
      {result.hidden > 0 && (
        <Box key="hidden" width={width} flexShrink={0} backgroundColor={hiddenBg}>
          <Text color={COLORS.muted} dimColor>
            {` ··· ${result.hidden} more line${result.hidden === 1 ? "" : "s"}`}
          </Text>
        </Box>
      )}
    </Box>
  );
});

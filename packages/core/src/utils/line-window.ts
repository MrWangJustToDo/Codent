/**
 * Line-window helpers — the one definition of "show the latest N lines, with a
 * `… N lines hidden above` indicator when more were dropped".
 *
 * The command streaming view and the task/compact summary view both render a capped
 * window of the latest lines and both spelled the same indicator and the same
 * "reserve one row for the indicator" rule. The window shape lives here so the two
 * cannot disagree on the text or the arithmetic.
 */

/** A bounded window of lines plus how many complete lines were dropped above it. */
export interface LineWindow {
  lines: string[];
  hidden: number;
}

/** Keep the latest `maxLines` lines. Short buffers are returned as-is (no padding). */
export function takeLatestLines(lines: string[], maxLines: number): string[] {
  if (maxLines <= 0) return [];
  return lines.length > maxLines ? lines.slice(-maxLines) : lines;
}

/** Keep the latest `maxLines` lines and pad on top so the array length is always `maxLines`. */
export function padLatestLines(lines: string[], maxLines: number, filler = ""): string[] {
  if (maxLines <= 0) return [];
  const tail = takeLatestLines(lines, maxLines);
  if (tail.length >= maxLines) return tail;
  return [...Array.from({ length: maxLines - tail.length }, () => filler), ...tail];
}

/** The overflow indicator line: `… N line(s) hidden above`. */
export function hiddenLinesIndicator(hidden: number): string {
  return `… ${hidden} line${hidden !== 1 ? "s" : ""} hidden above`;
}

export interface LineWindowOptions {
  /** Shown (in place of nothing) when `sourceLines` is empty. */
  emptyPlaceholder?: string;
  /** Reserve one row for the overflow indicator when lines were dropped. Default `true`. */
  markOverflow?: boolean;
  /** Pad short windows to a fixed height instead of growing. Default `false`. */
  padToMax?: boolean;
}

/**
 * Build a window of the latest `maxLines` lines.
 *
 * When more lines were dropped and `markOverflow` is set, the first visible row is the
 * indicator and the rest are the latest content lines. Empty input with no placeholder
 * yields an empty window.
 */
export function buildLineWindow(sourceLines: string[], maxLines: number, options: LineWindowOptions = {}): LineWindow {
  const { emptyPlaceholder = "", markOverflow = true, padToMax = false } = options;
  const source = sourceLines.length > 0 ? sourceLines : emptyPlaceholder ? [emptyPlaceholder] : [];
  if (source.length === 0) {
    return { lines: [], hidden: 0 };
  }

  const hidden = Math.max(0, source.length - maxLines);
  if (markOverflow && hidden > 0) {
    const contentCount = Math.max(0, maxLines - 1);
    return { lines: [hiddenLinesIndicator(hidden), ...takeLatestLines(source, contentCount)], hidden };
  }
  return { lines: padToMax ? padLatestLines(source, maxLines) : takeLatestLines(source, maxLines), hidden };
}

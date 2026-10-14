/**
 * Line-buffer helpers for summary streams (producer snapshot + app display window).
 */

import { hiddenLinesIndicator } from "../../utils/line-window.js";

export interface SummaryLineBuffer {
  lines: string[];
  pendingLine: string;
}

/** Max complete lines retained in a producer snapshot ring. */
export const SUMMARY_STREAM_SNAPSHOT_LINE_CAP = 500;

/**
 * Apply a raw chunk to a line buffer. Complete lines (ending in `\n`) move into
 * `lines`; any remainder stays in `pendingLine`. Optionally ring-caps complete lines.
 */
export function applySummaryStreamAppend(
  buffer: SummaryLineBuffer,
  chunk: string,
  options?: { maxCompleteLines?: number }
): SummaryLineBuffer {
  if (!chunk) return buffer;

  const maxCompleteLines = options?.maxCompleteLines;
  let pending = buffer.pendingLine + chunk;
  const nextLines = buffer.lines.slice();

  for (;;) {
    const nl = pending.indexOf("\n");
    if (nl < 0) break;
    nextLines.push(pending.slice(0, nl));
    pending = pending.slice(nl + 1);
  }

  if (maxCompleteLines != null && maxCompleteLines > 0 && nextLines.length > maxCompleteLines) {
    nextLines.splice(0, nextLines.length - maxCompleteLines);
  }

  return { lines: nextLines, pendingLine: pending };
}

export function emptySummaryLineBuffer(): SummaryLineBuffer {
  return { lines: [], pendingLine: "" };
}

/**
 * Display window: at most `contentSlots` complete lines + optional pending row,
 * with an independent `hidden` count of shifted complete lines.
 */
export interface SummaryDisplayWindow {
  lines: string[];
  pendingLine: string;
  hidden: number;
}

export function emptySummaryDisplayWindow(): SummaryDisplayWindow {
  return { lines: [], pendingLine: "", hidden: 0 };
}

export function applyAppendToDisplayWindow(
  window: SummaryDisplayWindow,
  chunk: string,
  contentSlots: number
): SummaryDisplayWindow {
  const slots = Math.max(1, contentSlots);
  const next = applySummaryStreamAppend({ lines: window.lines, pendingLine: window.pendingLine }, chunk);
  let hidden = window.hidden;
  const lines = next.lines.slice();
  while (lines.length > slots) {
    lines.shift();
    hidden += 1;
  }
  return { lines, pendingLine: next.pendingLine, hidden };
}

/** Rebuild a display window from a producer snapshot (remount-safe). */
export function displayWindowFromSnapshot(
  snapshot: { lines: string[]; pendingLine: string },
  contentSlots: number
): SummaryDisplayWindow {
  const slots = Math.max(1, contentSlots);
  const lines = snapshot.lines.slice();
  let hidden = 0;
  while (lines.length > slots) {
    lines.shift();
    hidden += 1;
  }
  return { lines, pendingLine: snapshot.pendingLine, hidden };
}

/** Render rows for UI: optional overflow indicator + complete lines + pending. */
export function renderSummaryDisplayRows(
  window: SummaryDisplayWindow,
  maxLines: number
): { rows: string[]; hidden: number } {
  const contentSlots = Math.max(1, maxLines - 1);
  const body: string[] = [...window.lines];
  if (window.pendingLine.length > 0) {
    body.push(window.pendingLine);
  }

  if (window.hidden <= 0) {
    return { rows: body.slice(0, maxLines), hidden: 0 };
  }

  const content = body.slice(-contentSlots);
  const indicator = hiddenLinesIndicator(window.hidden);
  return { rows: [indicator, ...content].slice(0, maxLines), hidden: window.hidden };
}

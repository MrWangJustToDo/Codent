import { keepsCompactRow as coreKeepsCompactRow } from "@codent/core";
import chalk from "chalk";

import { COLORS } from "../theme/colors.js";

import { resolveToolPresentation } from "./tool-presentation.js";
import { wrapTextToLines } from "./user-message-lines.js";

import type { UiToolState } from "./tool-part.js";

/**
 * Whether a tool renders a detailed output block in full display.
 *
 * The decision lives in core's presentation descriptor (which falls back to the static
 * built-in table), so a host process that never created the tools — a remote renderer —
 * still gets the right answer, and there is no host-side name set that can drift.
 */
export function hasDetailedOutputBlock(toolName: string): boolean {
  const present = resolveToolPresentation(toolName);
  return present?.detailed === true || present?.keepRow === true;
}

/**
 * Whether a tool owns its compact presentation.
 *
 * Core owns this rule — a descriptor that declares `keepRow` (structured result), `clientSide`
 * (the host supplies the result) or `text` (a curated line *is* the row's content) keeps its row.
 * Delegated to core so the two hosts cannot disagree about the same tool.
 */
export function keepsCompactRow(
  toolName: string,
  resolver: (name: string) => ReturnType<typeof resolveToolPresentation> = resolveToolPresentation
): boolean {
  return coreKeepsCompactRow(toolName, resolver);
}

/** Get status color for tool invocation state. */
export function getToolCallColor(state: UiToolState | string): string {
  switch (state) {
    case "input-streaming":
      return COLORS.warning;
    case "input-available":
      return COLORS.primary;
    case "output-available":
      return COLORS.success;
    case "output-error":
    case "output-denied":
      return COLORS.danger;
    case "approval-requested":
      return COLORS.warning;
    case "approval-responded":
      return COLORS.primary;
    default:
      return COLORS.muted;
  }
}

/** A `task` run's live phase, as far as the row cares: only `limit` says the step
 * budget ended it. */
export type TaskRowPhase = "running" | "summary" | "limit" | undefined;

/**
 * A step-budget cutoff, which the row must render as a warning instead of a
 * success.
 *
 * The part still settles as `output-available` (the run neither errored nor was
 * cancelled) and the subagent's own status is `completed`, so neither the tool
 * state nor the status can tell a cut-off run from a clean finish — only the live
 * `taskPhase` can. `taskPhase` is optional, so an absent value degrades to the old
 * behaviour rather than assuming a cutoff.
 */
export function isBudgetCutoffTaskPhase(phase: TaskRowPhase): boolean {
  return phase === "limit";
}

/** Status glyph for a tool row, resolving the user-cancel and budget-cutoff cases before `state`. */
export function getToolStatusGlyph(
  state: UiToolState | string,
  stoppedByLimit = false,
  stoppedByCancel = false
): string {
  // Ordered first, not last: a cut-off `task` is `output-available` and a cancelled
  // `run_command` is `output-error`, so neither reads from the state alone.
  if (stoppedByLimit) return "⚠";
  if (stoppedByCancel) return "⚠";
  switch (state) {
    case "output-available":
      return "✓";
    case "output-error":
    case "output-denied":
      return "✗";
    case "approval-requested":
      return "?";
    default:
      return "";
  }
}

// Re-exported from core so a host cannot drift from the owning process: these are the
// same thresholds and functions the core layer uses when it renders a call.
export { DURATION_THRESHOLD_MS, LIVE_DURATION_THRESHOLD_MS, getDurationMs, getInlineSummary } from "@codent/core";

export function buildToolHeader(
  toolName: string,
  displayInput: string | null,
  parenText: string,
  stateColor: string
): string {
  const chalkByColor = chalk as unknown as Record<string, typeof chalk>;
  const colorFn = chalkByColor[stateColor] ?? chalk.white;
  let header = colorFn.bold(toolName);

  if (displayInput) {
    header += " " + colorFn.dim(displayInput);
  }

  if (parenText) {
    header += chalk.hex(COLORS.muted)(parenText);
  }

  return header;
}

// ============================================================================
// Settled-row arg clamping
// ============================================================================

/** The omission marker appended when a settled row's arguments are cut. */
export const CLAMP_MARKER = "…";

/**
 * Cap a settled row's arguments so the composed header occupies at most `maxLines`
 * terminal rows.
 *
 * Why this is needed at all: the header is one `<Text wrap="wrap">` — Ink wraps it and
 * has no row budget — so a multi-line or long command grows the row to whatever height
 * the wrapping produces. The argument text is what the user must read *before* a call
 * runs (what am I approving / what is being executed), and once the row has an output it
 * is history: the result block below already carries the folded output, so the arguments
 * only need to say which command this was.
 *
 * The clamp runs on the PLAIN argument string, before colour: `buildToolHeader` composes
 * `toolName + args + paren` out of separately coloured segments, so cutting the assembled
 * (chalk-escaped) string would count escape bytes as width and could split a sequence.
 *
 * Fitting is decided by the real wrapper ({@link wrapTextToLines}, Ink's own algorithm), not
 * by a character budget: word wrapping drops the space at each break, so no arithmetic on
 * string lengths predicts the row count. A binary search over the kept prefix length is
 * cheap because that wrapper takes an early-exit row limit.
 *
 * The caller supplies `compose` because only it knows the segments around the arguments
 * (the tool name prefix and the parenthetical). Those sit on the first and last row
 * respectively, so they shrink the room available to the arguments — fitting the arguments
 * against the full width would overrun by exactly the prefix.
 *
 * @example
 * // 2 rows at 40 columns, prefix `run_command ` already accounted for by `compose`
 * clampHeaderInput("a\nb\nc", (i) => `run_command ${i}`, 40, 2) // "a\nb\n…"
 */
export function clampHeaderInput(
  displayInput: string | null,
  compose: (input: string) => string,
  width: number,
  maxLines: number
): string | null {
  if (!displayInput || maxLines < 1 || width < 1) return displayInput;

  const safeWidth = Math.max(1, width);
  // `+ 1` so the wrapper has to reveal the overflow; asking for exactly `maxLines` could
  // not distinguish "fits" from "wrapped to the limit".
  const fits = (candidate: string): boolean =>
    wrapTextToLines(compose(candidate), safeWidth, maxLines + 1).length <= maxLines;

  if (fits(displayInput)) return displayInput;
  // The fixed segments alone (tool name + parenthetical) already wrap past the budget — a
  // very narrow terminal, or a long parenthetical such as `(cancelled, 3/50 turns, …)`.
  // Nothing can be cut from the arguments to recover, and keeping any of them could only add
  // a row, so drop them entirely; the marker would be a row that says nothing.
  if (!fits("")) return "";

  // Largest kept prefix that still fits with the marker appended. The marker is inside the
  // candidate, so the result never overruns by its own width.
  let lo = 0;
  let hi = displayInput.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(displayInput.slice(0, mid) + CLAMP_MARKER)) lo = mid;
    else hi = mid - 1;
  }

  if (lo >= displayInput.length) return displayInput;
  // Drop a dangling high surrogate so the cut cannot emit a broken code point.
  const cut = /[\uD800-\uDBFF]$/.test(displayInput.slice(0, lo)) ? lo - 1 : lo;
  return displayInput.slice(0, Math.max(0, cut)) + CLAMP_MARKER;
}

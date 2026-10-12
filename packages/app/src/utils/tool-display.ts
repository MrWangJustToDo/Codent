import { getToolPresentation, keepsCompactRow as coreKeepsCompactRow } from "@codent/core";
import chalk from "chalk";

import { COLORS } from "../theme/colors.js";

import type { UiToolState } from "./tool-part.js";

/**
 * Whether a tool renders a detailed output block in full display.
 *
 * The decision lives in core's presentation descriptor (which falls back to the static
 * built-in table), so a host process that never created the tools — a remote renderer —
 * still gets the right answer, and there is no host-side name set that can drift.
 */
export function hasDetailedOutputBlock(toolName: string): boolean {
  const present = getToolPresentation(toolName);
  return present?.detailed === true || present?.keepRow === true;
}

/**
 * Whether a tool owns its compact presentation.
 *
 * Core owns this rule — a descriptor that declares `keepRow` (structured result), `clientSide`
 * (the host supplies the result) or `text` (a curated line *is* the row's content) keeps its row.
 * Delegated to core so the two hosts cannot disagree about the same tool.
 */
export const keepsCompactRow = coreKeepsCompactRow;

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
export {
  DURATION_THRESHOLD_MS,
  LIVE_DURATION_THRESHOLD_MS,
  getCompactOutput,
  getDurationMs,
  getInlineSummary,
} from "@codent/core";

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

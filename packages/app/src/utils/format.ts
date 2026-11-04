import { formatByteSize, parseDataUrl } from "@codent/core";

export { formatDuration } from "@codent/core";

/**
 * Money, with precision growing as the number shrinks (`$1.23`, `$0.500`, `$0.0042`).
 *
 * ONE definition: the footer (`LLMUsage`), `/usage`, and the exit summary each carried a copy, and
 * they had drifted — a sub-dollar amount read `$0.500` in two places and `$0.50` in the third, so
 * the same cost changed shape as you moved between screens. `<= 0` and `NaN` are `$0.00`: an
 * unstarted or free session never prints `$NaN` or `$0.0000`.
 */
export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/** Size of a base64 data URL, in the display units the host uses everywhere. */
export function formatFileSize(dataUrl: string): string {
  const parsed = parseDataUrl(dataUrl);
  // An empty payload is not "0B": the old display omitted the size entirely.
  if (!parsed?.base64) return "";
  const bytes = Math.ceil((parsed.base64.length * 3) / 4);
  return formatByteSize(bytes, { decimals: 1, showBytes: true });
}

export { formatToolInput } from "./tool-input-format.js";
export { formatToolArgs, formatToolOutput } from "./tool-output-format.js";
export {
  DURATION_THRESHOLD_MS,
  LIVE_DURATION_THRESHOLD_MS,
  buildToolHeader,
  clampHeaderInput,
  CLAMP_MARKER,
  getDurationMs,
  getInlineSummary,
  getToolCallColor,
  getToolStatusGlyph,
  isBudgetCutoffTaskPhase,
} from "./tool-display.js";

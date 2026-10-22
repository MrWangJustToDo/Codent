export { formatDuration } from "@codent/core";

export function formatFileSize(dataUrl: string): string {
  const base64Match = dataUrl.match(/;base64,(.+)/);
  if (!base64Match) return "";
  const bytes = Math.ceil((base64Match[1]!.length * 3) / 4);
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
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

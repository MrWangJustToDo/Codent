import { getCliElapsedMs } from "./cli-session-start.js";
import { formatCompactNumber } from "./format-usage.js";
import { formatCost } from "./format.js";

// Kept exported from this module (the exit summary's own test imports it here); the definition is
// `./format.ts`, shared with the footer and `/usage`.
export { formatCost };

/**
 * The exit summary, rendered as plain text: session identity, what it cost, and how to come back.
 *
 * Modelled on what Claude Code and Gemini CLI print on the way out, minus the parts this
 * codebase has no honest source for (per-model cost breakdown, tool-call success rate). Every
 * figure here already exists in the session snapshot — this is a *presentation* of
 * `snap.usage`, not new accounting, and it deliberately shares the numbers `/usage` renders so
 * the two cannot disagree.
 */

export interface ExitSummaryInput {
  name: string;
  agentId: string;
  sessionId?: string;
  model?: string;
  /** See {@link UsageChangeSnapshot}. */
  usage: {
    total: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
    billedInputTokens: number;
    cost: number;
    llmDurationMs: number;
    llmOutputTokens: number;
  };
  todos?: { status: string }[];
}

/** `1h 02m`, `3m 04s`, `12s` — two units at most, so the line stays readable. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** Cost trend for the whole run: no cost, or generation that never ran, both report `-`. */
function formatSpeed(llmDurationMs: number, llmOutputTokens: number): string | null {
  if (llmDurationMs <= 0 || llmOutputTokens <= 0) return null;
  return `${(llmOutputTokens / (llmDurationMs / 1000)).toFixed(1)} tok/s`;
}

/**
 * One screen of plain text, or `null` when there is nothing worth printing — a session that
 * never talked to a model (help, a cancelled config editor) must not get a summary of zeros.
 *
 * Lines are unindented: horizontal placement belongs to the component that frames them, so the
 * same lines can be rendered with or without the border without editing every literal here.
 */
export function buildExitSummaryLines(input: ExitSummaryInput): string[] | null {
  const { usage } = input;
  const prompt = usage.billedInputTokens;
  const output = usage.total.outputTokens;
  const cacheRead = usage.total.cacheReadTokens ?? 0;
  const cacheWrite = usage.total.cacheWriteTokens ?? 0;
  const hadModelTraffic = prompt > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0;
  if (!hadModelTraffic) return null;

  const lines: string[] = [];
  lines.push(`Session:   ${input.name}${input.sessionId ? ` (${input.sessionId})` : ""}`);
  if (input.model) lines.push(`Model:     ${input.model}`);

  lines.push("");
  lines.push(`Duration:  ${formatDuration(getCliElapsedMs())}`);
  const speed = formatSpeed(usage.llmDurationMs, usage.llmOutputTokens);
  if (speed) lines.push(`LLM time:  ${formatDuration(usage.llmDurationMs)} (${speed})`);
  lines.push(`Cost:      ${formatCost(usage.cost)}`);

  lines.push("");
  lines.push(`Tokens:    ${formatCompactNumber(prompt)} in / ${formatCompactNumber(output)} out`);
  if (cacheRead > 0 || cacheWrite > 0) {
    const parts: string[] = [];
    if (cacheRead > 0) parts.push(`${formatCompactNumber(cacheRead)} cache read`);
    if (cacheWrite > 0) parts.push(`${formatCompactNumber(cacheWrite)} cache write`);
    lines.push(`Cache:     ${parts.join(" / ")}`);
  }

  const todos = input.todos ?? [];
  if (todos.length > 0) {
    const done = todos.filter((todo) => todo.status === "completed").length;
    lines.push("");
    lines.push(`Todos:     ${done}/${todos.length} completed`);
  }

  if (input.sessionId) {
    lines.push("");
    lines.push(`To resume this session: /resume ${input.sessionId}`);
  }

  return lines;
}

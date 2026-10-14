/**
 * Compact token/usage formatting for footers and task headers.
 */

/**
 * Thousands: two decimals, `400.00k`.
 *
 * The decimals are FIXED, not trimmed, because this number is animated: `AnimateNumber` walks an
 * easing sequence to the target, so the rendered width has to be constant or the `↓` / `↑` suffixes
 * and the context segment beside it slide left and right on every 60 ms tick. A trimming formatter
 * (`400k`, then `1.5k`, then `1.55k`, then `1.6k`) is non-monotone — 1500→1600 draws 4, 5, 4 —
 * which is exactly what a tick looks like from the user's side.
 */
function thousandsLabel(value: number): string {
  return `${(Math.round((value / 1000) * 100) / 100).toFixed(2)}k`;
}

/**
 * Millions: ONE decimal, `2.7M`.
 *
 * Not the same width as {@link thousandsLabel}, deliberately: a millions figure advances in
 * 100k steps, so one decimal already moves on every step and a second one would only redraw.
 */
function millionsLabel(value: number): string {
  return `${(Math.round((value / 1_000_000) * 10) / 10).toFixed(1)}M`;
}

/**
 * Compact token/usage formatting for footers and task headers.
 *
 * Fixed decimals per unit (see the two helpers) so the label never changes width as the value
 * moves within a unit: `400.00k` → `650.00k`, or `1.0M` → `2.7M`. The width does step once at a unit
 * boundary (`999.99k` → `1.00M`), which is a single real change rather than a per-tick shimmer.
 */
export function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return thousandsLabel(n);
  return millionsLabel(n);
}

/**
 * The prompt-token reading this label must print.
 *
 * `inputTokens` alone is NOT the prompt: under an exclusive upstream
 * (Anthropic/DeepSeek native) it holds only the cache-miss part, so a fully cached
 * subagent run reads as ~0. Mirrors `promptTokensOf` in core, mirrored here rather
 * than imported because `@codent/app` must not reach into core internals and the
 * rule is two lines. Prefer an explicit `billedInputTokens` whenever the producer
 * supplied one — a subagent's own tracker already accumulated the exact sum, and
 * re-deriving it from an *aggregate* is lossy (see AGENTS.md "Context-window fill").
 */
export function resolvePromptTokens(usage: {
  inputTokens: number;
  billedInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): number {
  if (typeof usage.billedInputTokens === "number" && Number.isFinite(usage.billedInputTokens)) {
    return usage.billedInputTokens;
  }
  const cached = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
  return cached > input ? input + cached : input;
}

export function formatUsageBrief(usage: {
  inputTokens: number;
  outputTokens: number;
  billedInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): string {
  return `${formatCompactNumber(resolvePromptTokens(usage))} in / ${formatCompactNumber(usage.outputTokens)} out`;
}

/**
 * Context-window fill for the footer (Pi-style), separate from lifetime totals.
 *
 * - When limit unknown: empty string (caller hides the segment)
 * - When window usage is 0 after compact / before first response: `?/400.00k`
 * - Otherwise: `22% of 400.00k`
 *
 * The percentage is NOT clamped to 100: the limit here is the compaction BUDGET, and the trigger sits
 * at `compactAtPercent` (80 by default) of it — so a reading above 100 means the trigger did not fire,
 * which is exactly the one thing this segment can tell you. Clamping it hid that.
 *
 * ` of ` rather than `/`: the number is the budget, not the model's context window (a 1M-window model
 * shows `400.00k` here), and a slash next to the percentage reads as a fraction of the window.
 */
export function formatContextUsage(options: {
  contextFillTokens: number;
  tokenLimit: number;
  percent: number;
}): string {
  const { contextFillTokens, tokenLimit, percent } = options;
  if (!Number.isFinite(tokenLimit) || tokenLimit <= 0) return "";

  const limitLabel = formatCompactNumber(tokenLimit);
  if (!Number.isFinite(contextFillTokens) || contextFillTokens <= 0) {
    return `?/${limitLabel}`;
  }

  const pct = Math.max(0, percent);
  return `${pct.toFixed(0)}% of ${limitLabel}`;
}

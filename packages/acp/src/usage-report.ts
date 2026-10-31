/**
 * `/usage` as TEXT, for clients that have no panel to draw.
 *
 * The TUI renders the same numbers as a React tree (bars, heatmap, per-model table) fed from the
 * config store; an ACP client only ever receives text chunks, so this module is the report in a
 * client's vocabulary. It is deliberately NOT shared with the app: what `/usage [Nw]` *means* is
 * core's (`parseUsageCommand`), while how a surface draws it is the surface's — and the app's
 * version cannot be shared anyway, because it is a component reading `useConfig`.
 *
 * The two formatters are local for the same reason `formatCost`/`formatCompactNumber` are local to
 * the app: they are this surface's presentation. They differ on purpose — the app's compact number
 * keeps FIXED decimals so an animated footer never changes width, while a printed report can trim
 * (`400k`, not `400.00k`).
 */

import type { DailyUsageBucket, ModelUsageTotal, UsageChangeSnapshot } from "@codent/core";

/** Trimmed compact token count: `999`, `1.2k`, `50.6M`. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${trim(value / 1000)}k`;
  return `${trim(value / 1_000_000)}M`;
}

/** Money with precision growing as the number shrinks (`$4.37`, `$0.500`, `$0.0042`). */
export function formatMoney(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

function trim(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

/** The `usage.history` payload, as the session command returns it. */
export interface UsageHistoryPayload {
  weeks: number;
  daily: DailyUsageBucket[];
  models: ModelUsageTotal[];
}

/**
 * Build the `/usage` report.
 *
 * Session lifetime first (what the user just spent), then the global activity window the argument
 * asked for, then per-model totals only when more than one model contributed — a single-model
 * report repeating the total under "By model" is noise.
 */
export function formatUsageReport(usage: UsageChangeSnapshot, history: UsageHistoryPayload | undefined): string {
  const prompt = usage.billedInputTokens ?? 0;
  const cachedRead = usage.total.cacheReadTokens ?? 0;
  const cachedWrite = usage.total.cacheWriteTokens ?? 0;
  const uncached = usage.uncachedInputTokens ?? Math.max(0, prompt - cachedRead - cachedWrite);
  const output = usage.total.outputTokens ?? 0;
  const reasoning = usage.total.reasoningTokens ?? 0;
  const total = prompt + output;

  const lines: string[] = ["Session lifetime (cumulative)"];
  lines.push(
    `  Prompt   ${formatTokens(prompt)} billed · ${formatTokens(uncached)} uncached · ${formatTokens(cachedRead)} cache read`
  );
  lines.push(
    reasoning > 0
      ? `  Output   ${formatTokens(output)} · reasoning ${formatTokens(reasoning)}`
      : `  Output   ${formatTokens(output)}`
  );
  lines.push(`  Total    ${formatTokens(total)} tokens · ${formatMoney(usage.cost)}`);

  // The context reading is the window's real fill, not `window.inputTokens` — see
  // `UsageChangeSnapshot.contextFillTokens` for why the two differ on an exclusive-cache upstream.
  const limit = usage.tokenLimit > 0 ? usage.tokenLimit : 0;
  const percent = limit > 0 ? ` (${Math.round(usage.percent)}%)` : "";
  lines.push(
    `  Context  ${formatTokens(usage.contextFillTokens)}${limit > 0 ? ` of ${formatTokens(limit)}` : ""}${percent}`
  );

  if (history) {
    const activeDays = history.daily.filter((day) => day.totalTokens > 0).length;
    const totalTokens = history.daily.reduce((sum, day) => sum + day.totalTokens, 0);
    const totalCost = history.daily.reduce((sum, day) => sum + day.costUsd, 0);
    lines.push("");
    if (history.daily.length === 0) {
      lines.push(`Global activity (${history.weeks}w): no history yet`);
    } else {
      lines.push(
        `Global activity (${history.weeks}w): ${formatTokens(totalTokens)} tokens · ${formatMoney(totalCost)} · ` +
          `${activeDays} active days`
      );
      if (history.models.length > 1) {
        const byModel = history.models
          .slice(0, 5)
          .map((model) => `${model.model} ${formatTokens(model.totalTokens)}`)
          .join(" · ");
        lines.push(`  By model: ${byModel}`);
      }
    }
  }

  return lines.join("\n");
}

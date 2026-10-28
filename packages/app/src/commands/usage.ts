import { Box } from "ink";
import { createElement } from "react";

import { HalfLinePaddedBox } from "../components/HalfLinePaddedBox.js";
import { UsageHeatmap } from "../components/UsageHeatmap.js";
import { useConfig } from "../hooks/use-config.js";
import { useSize } from "../hooks/use-size.js";
import { BG } from "../theme/colors.js";
import { formatCompactNumber } from "../utils/format-usage.js";
import { formatCost } from "../utils/format.js";
import { usageHeatmapWindow } from "../utils/usage-heatmap.js";

import { registerBuiltinCommand } from "./utils/registry.js";

import type { CommandContext } from "./utils/types.js";
import type { DailyUsageBucket, ModelUsageTotal } from "@codent/core";
import type { ReactNode } from "react";

/** Maximum span of the global activity graph — one full year of weekly columns. */
const MAX_WEEKS = 52;

/** Terminal width assumed before the size store reports a real one. */
const FALLBACK_SCREEN_WIDTH = 80;

/**
 * Default span: whole months, as many as the terminal can show within one year.
 * The graph therefore fills the window width (instead of a fixed six-month block
 * that leaves the right half blank), starts on a month boundary so the left edge
 * never shows a slice of a month, and adapts to resizes at invocation time.
 */
function defaultWeeks(): number {
  const screenWidth = useSize.getReadonlyState().state.screenWidth || FALLBACK_SCREEN_WIDTH;
  return usageHeatmapWindow(screenWidth, MAX_WEEKS).weeks;
}

function fmt(n: number): string {
  // One compact formatter for the whole app — `format-usage.ts` owns it, and a second copy
  // here had drifted to different precision (`1.0k` where the footer printed `1.00k`), so the
  // same number read differently in the `/usage` block and the footer above it.
  return formatCompactNumber(n);
}

function pct(part: number, total: number): string {
  if (total <= 0) return "";
  return ` (${((part / total) * 100).toFixed(1)}%)`;
}

// ============================================================================
// Global activity — summary text rendered alongside the <UsageHeatmap/> node
// ============================================================================

function renderGlobalStats(daily: DailyUsageBucket[], models: ModelUsageTotal[], weeks: number): string[] {
  const lines: string[] = [];

  if (daily.length === 0) {
    lines.push("");
    lines.push(`  ── Global Activity (${weeks}w) ──`);
    lines.push("  (no usage history yet — it builds up as you use the agent)");
    return lines;
  }

  const totalTokens = daily.reduce((s, d) => s + d.totalTokens, 0);
  const totalCost = daily.reduce((s, d) => s + d.costUsd, 0);
  const activeDays = daily.filter((d) => d.totalTokens > 0).length;
  const avgPerDay = totalTokens / (weeks * 7);
  lines.push("");
  lines.push(`  ── Global Activity (${weeks}w) ──`);
  lines.push(
    `  ${fmt(totalTokens)} tokens · ${formatCost(totalCost)} · ${activeDays} active days · avg ${fmt(avgPerDay)}/day`
  );

  if (models.length > 1) {
    lines.push("");
    lines.push(`  ── By Model ──`);
    for (const m of models) {
      lines.push(`  ${m.model.padEnd(40)}${fmt(m.totalTokens).padStart(10)} tokens  ${formatCost(m.costUsd)}`);
    }
  }
  return lines;
}

async function fetchGlobalHistory(
  ctx: CommandContext,
  weeks: number
): Promise<{
  daily: DailyUsageBucket[];
  models: ModelUsageTotal[];
} | null> {
  const session = ctx.getSession();
  if (!session) return null;
  const result = await session.dispatch({ type: "usage.history", weeks });
  if (!result.ok) return null;
  const data = result.data;
  if (!data) return null;
  return { daily: data.daily, models: data.models };
}

// ============================================================================
// Command
// ============================================================================

registerBuiltinCommand("usage", {
  immediate: true,
  execute: async (args, ctx) => {
    const session = ctx.getSession();
    if (!session) {
      return { ok: false, error: "Agent not initialized" };
    }

    const weeksMatch = /^(\d+)\s*w(week)?$/i.exec(args.trim());
    const weeks = weeksMatch ? Math.min(MAX_WEEKS, Math.max(1, parseInt(weeksMatch[1], 10))) : defaultWeeks();

    const snap = session.getSnapshot();
    const usage = snap.usage;
    const totalUsage = usage.total;
    const currentUsage = usage.window;
    const cost = usage.cost;
    const tokenLimit = usage.tokenLimit;
    const { serverModel, model } = useConfig.getReadonlyState().config;
    const displayModel = serverModel || model;
    const lines: string[] = [];

    lines.push(`  Session:      ${snap.name} (${snap.agentId})`);
    if (displayModel) {
      lines.push(`  Model:        ${displayModel}`);
    }

    // Overall cache hit ratio across the session lifetime (cumulative). The denominator is
    // the *billed prompt*, not `totalUsage.inputTokens`: on an exclusive-cache upstream the
    // latter is only the cache-miss part, so the read divided by it printed 428.5%.
    const billedInput = usage.billedInputTokens;
    const cacheHitRatio = billedInput > 0 ? (totalUsage.cacheReadTokens ?? 0) / billedInput : 0;
    if (cacheHitRatio > 0) {
      lines.push("");
      lines.push(`  Cache hit:    ${(cacheHitRatio * 100).toFixed(1)}%`);
    }

    lines.push("");
    lines.push(`  ── Session Lifetime ──`);
    // The billed prompt, not `totalUsage.inputTokens`: on an exclusive-cache upstream that
    // field is only the cache-miss part, so this read printed 523.2k against a 50.63M prompt
    // — 1.0% of the real figure, under a "(cumulative)" label. `pct()` below already used
    // this same denominator, so the block was showing a share of a total it never printed.
    lines.push(`  Prompt:       ${fmt(billedInput)} tokens (cumulative, billed)`);
    const totalCacheRead = totalUsage.cacheReadTokens ?? 0;
    const totalCacheWrite = totalUsage.cacheWriteTokens ?? 0;
    // `usage.uncachedInputTokens`, not `totalUsage.inputTokens`. The latter is the upstream's own
    // convention: on an inclusive upstream (OpenAI, most gateways) it IS the whole prompt, so this
    // line printed `Input: 44.3M (uncached)` on a session whose uncached share was 0.2M — the
    // "Prompt" line above and this one rendering the same number under two labels. The tracker
    // subtracts both cache counters from the billed prompt, which is exact under either convention.
    //
    // The expression after `??` is for a server built before that field existed: an absent field
    // would reach `formatCompactNumber` as `undefined` and print a confident `0`.
    const uncachedInput = usage.uncachedInputTokens ?? Math.max(0, billedInput - totalCacheRead - totalCacheWrite);
    lines.push(`    Input:      ${fmt(uncachedInput)} (uncached)`);

    if (totalCacheRead > 0) {
      lines.push(`    Cache read:   ${fmt(totalCacheRead)}${pct(totalCacheRead, billedInput)}`);
    }
    if (totalCacheWrite > 0) {
      lines.push(`    Cache write:  ${fmt(totalCacheWrite)}${pct(totalCacheWrite, billedInput)}`);
    }

    lines.push(`  Output:       ${fmt(totalUsage.outputTokens)} tokens`);

    const totalReasoning = totalUsage.reasoningTokens ?? 0;
    if (totalReasoning > 0) {
      const text = totalUsage.outputTokens - totalReasoning;
      lines.push(`    Reasoning:    ${fmt(totalReasoning)}${pct(totalReasoning, totalUsage.outputTokens)}`);
      lines.push(`    Text:         ${fmt(text)}`);
    }

    // Prompt + output. Sourced from the same reading as `Prompt:` above rather than read off
    // `totalUsage.totalTokens`, whose per-call producers build it as `input + output` and so
    // drop every cached token (this line printed 781.1k where the real volume was 50.88M).
    // `outputTokens` is the last line of defence: if a producer ever omits it the row reads
    // `0` rather than `NaN`, which is what an unguarded sum would render here.
    const totalTokens = billedInput + (totalUsage.outputTokens ?? 0);
    lines.push(`  Total:        ${fmt(totalTokens)} tokens (prompt + output)`);

    // Average LLM generation rate across main-loop calls (cumulative output tokens /
    // cumulative model time). Side queries (titles, summaries, memory selection) are
    // intentionally excluded so this reflects the agent's own generation speed.
    if (usage.llmDurationMs > 0) {
      const rate = usage.llmOutputTokens / (usage.llmDurationMs / 1000);
      lines.push(`  Speed:        ${rate.toFixed(1)} tok/s (output)`);
    }

    // Real window fill — not `window.inputTokens`, which on an exclusive-cache
    // upstream (Anthropic/DeepSeek native) holds only the cache-miss part.
    const contextInput = usage.contextFillTokens;
    if (contextInput > 0) {
      const contextCacheRead = currentUsage.cacheReadTokens ?? 0;
      const pctText =
        tokenLimit > 0 ? ` (${((contextInput / tokenLimit) * 100).toFixed(0)}% of ${fmt(tokenLimit)})` : "";
      lines.push("");
      lines.push(`  ── Current Context ──`);
      lines.push(`  Context:      ${fmt(contextInput)} tokens${pctText}`);
      if (contextCacheRead > 0 && totalCacheRead > 0) {
        // Share of the current *billed* prompt that was cached. `contextInput` is exactly
        // that prompt (see `UsageTracker.getContextFillTokens`), so it is the "hit" reading —
        // dividing by it is what makes this a rate rather than a fraction of the window.
        lines.push(`    Cache read:   ${fmt(contextCacheRead)}${pct(contextCacheRead, contextInput)}`);
      }
    }

    lines.push(`  Session cost: ${formatCost(cost)}`);

    // Global contribution graph — best effort; a failed/dispatch-unsupported
    // session (e.g. store unavailable) just omits the section.
    let graphNode: ReactNode | undefined;
    try {
      const global = await fetchGlobalHistory(ctx, weeks);
      if (global) {
        graphNode = createElement(
          HalfLinePaddedBox,
          { backgroundColor: BG.message },
          createElement(Box, { paddingLeft: 1 }, createElement(UsageHeatmap, { daily: global.daily, weeks }))
        );
        lines.push(...renderGlobalStats(global.daily, global.models, weeks));
      }
    } catch {
      // ignore — session section is already complete
    }

    return { ok: true, message: lines.join("\n"), node: graphNode };
  },
});

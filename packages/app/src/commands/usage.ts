import { parseUsageCommand, truncateText } from "@codent/core";
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

import type { CommandContext, CommandOption } from "./utils/types.js";
import type { DailyUsageBucket, ModelUsageTotal } from "@codent/core";
import type { ReactNode } from "react";

/** Maximum span of the global activity graph — one full year of weekly columns. */
const MAX_WEEKS = 52;

/** Terminal width assumed before the size store reports a real one. */
const FALLBACK_SCREEN_WIDTH = 80;

/**
 * Value column the report's rows align to (counted from the start of the line).
 *
 * The labels used to be padded by hand (`"    Cache read:   "`), and four of them ended up two
 * columns right of their siblings — `Input` at 16, `Cache read` / `Cache write` / `Reasoning` /
 * `Text` at 18 — so one block rendered as two ragged tables. Every row now goes through
 * {@link row}, so a label can be added or lengthened without moving the numbers beside it. 18 is
 * the widest label (`    Cache write:`, 16 columns) plus two spaces.
 */
const LABEL_COLUMN = 18;

/**
 * One `label: value` row, with the value column shared by every row in the report.
 *
 * `indent` nests a row under the one above it **without** moving the value column: depth reads
 * from where the label starts, not from where the numbers start, so the whole block keeps a single
 * column the eye can follow — and a longer label never gets its own column by accident.
 */
function row(label: string, value: string, indent = 2): string {
  const prefix = " ".repeat(indent) + label + ":";
  return prefix.padEnd(LABEL_COLUMN) + value;
}

/** Widest model-name column of the `By Model` table before the name is elided. */
const MODEL_NAME_MAX = 40;

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

/**
 * `By Model` rows, with the name column measured from the data.
 *
 * `padEnd(40)` used to be hard-coded, which only aligns a table whose longest id fits inside it:
 * a model id past 40 columns (`openrouter/…` ids are) pushed its own token column right and left
 * every row behind it, so the block read as two ragged halves. The cap keeps the numbers on
 * screen — an id longer than it is elided instead of wrapping the row.
 */
function renderByModel(models: ModelUsageTotal[]): string[] {
  const nameWidth = Math.min(MODEL_NAME_MAX, Math.max(...models.map((m) => m.model.length)));
  const rows = models.map((m) => {
    // `truncateText` owns the marker budget: it returns at most `nameWidth` characters INCLUDING the
    // `…`, which is what keeps the token column where the widest name put it.
    const name = truncateText(m.model, nameWidth, { marker: "…" }).padEnd(nameWidth);
    const unpriced = m.unpricedCalls > 0 ? ` (${m.unpricedCalls} unpriced)` : "";
    return `  ${name}${fmt(m.totalTokens).padStart(10)} tokens  ${formatCost(m.costUsd)}${unpriced}`;
  });
  return ["", "  ── By Model ──", ...rows];
}

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
  const unpricedCalls = daily.reduce((s, d) => s + (d.unpricedCalls ?? 0), 0);
  const activeDays = daily.filter((d) => d.totalTokens > 0).length;
  const avgPerDay = totalTokens / (weeks * 7);
  lines.push("");
  lines.push(`  ── Global Activity (${weeks}w) ──`);
  lines.push(
    `  ${fmt(totalTokens)} tokens · ${formatCost(totalCost)}${unpricedCalls > 0 ? " + unpriced" : ""} · ${activeDays} active days · avg ${fmt(avgPerDay)}/day`
  );
  // A model with no pricing metadata used to be indistinguishable from a free one: both showed
  // `$0.0000`, and the total read as "this is what it cost". Say how many calls are unknown.
  if (unpricedCalls > 0) {
    lines.push(
      `  ${unpricedCalls} call${unpricedCalls === 1 ? "" : "s"} had no pricing metadata — their cost is not in the total`
    );
  }

  if (models.length > 1) {
    lines.push(...renderByModel(models));
  }
  return lines;
}

/**
 * The calendar block, and nothing else.
 *
 * `/usage calendar` asks for the graph on its own: no report lines beside it. It used to be appended
 * under every `/usage`, so the common question ("what did this session cost") had to scroll past a
 * year of contribution cells, and the graph itself was sandwiched between text sections.
 */
function calendarNode(daily: DailyUsageBucket[], weeks: number): ReactNode {
  return createElement(
    HalfLinePaddedBox,
    { backgroundColor: BG.message },
    createElement(Box, { paddingLeft: 1 }, createElement(UsageHeatmap, { daily, weeks }))
  );
}

/**
 * The `usage.history` payload, or `null` when this session cannot produce one.
 *
 * Best effort by design: the report is complete without the global section, and a store that is
 * unavailable (a remote session without the command, a first run) must not turn `/usage` into an
 * error. Only `calendar` mode, which has nothing else to show, reports the miss.
 */
async function fetchGlobalHistory(
  ctx: CommandContext,
  weeks: number
): Promise<{
  daily: DailyUsageBucket[];
  models: ModelUsageTotal[];
} | null> {
  const session = ctx.getSession();
  if (!session) return null;
  try {
    const result = await session.dispatch({ type: "usage.history", weeks });
    if (!result.ok) return null;
    const data = result.data;
    if (!data) return null;
    return { daily: data.daily, models: data.models };
  } catch {
    return null;
  }
}

// ============================================================================
// Command
// ============================================================================

registerBuiltinCommand("usage", {
  // NOT immediate: the two views are a MENU, the way `/settings` and `/mode` are — `/usage` opens the
  // list and the choice is the second step. The words stay legal as typed arguments (`/usage calendar
  // 26w`), for the same reason `/models 0:x high` does: the menu is a shortcut over one grammar, not a
  // second grammar beside it.
  immediate: false,
  getOptions: (): CommandOption[] => [
    {
      label: "report",
      value: "report",
      description: "Session tokens, cost, cache hit and context fill (the default)",
    },
    {
      label: "calendar",
      value: "calendar",
      description: "Draw the global activity calendar — add a span to widen it (`/usage calendar 26w`)",
    },
  ],
  execute: async (args, ctx) => {
    const session = ctx.getSession();
    if (!session) {
      return { ok: false, error: "Agent not initialized" };
    }

    // The `[calendar] [Nw]` grammar is core's (`parseUsageCommand`) — the headless host reads the
    // same argument, and a private regex here is how the two surfaces drift. No span means "whatever
    // this surface can draw", which is the terminal's width and therefore NOT core's business.
    const intent = parseUsageCommand(args);
    if (intent.kind === "invalid") {
      return { ok: false, error: `Unknown /usage argument "${intent.value}". Usage: /usage [report|calendar] [Nw]` };
    }
    const weeks = intent.weeks ?? defaultWeeks();

    // One read for both views: the report prints this payload as text, the calendar draws it.
    const history = await fetchGlobalHistory(ctx, weeks);

    // `/usage calendar` is the graph and nothing else — asking for the calendar is asking to look at
    // the year, not to re-read the session block that `/usage` already prints.
    if (intent.view === "calendar") {
      if (!history) {
        return { ok: false, error: "Usage history is unavailable for this session" };
      }
      if (history.daily.length === 0) {
        return { ok: false, error: "No usage history yet — the calendar fills in as you use the agent" };
      }
      return { ok: true, node: calendarNode(history.daily, weeks) };
    }

    const snap = session.getSnapshot();
    const usage = snap.usage;
    const totalUsage = usage.total;
    const currentUsage = usage.window;
    const cost = usage.cost;
    const tokenLimit = usage.tokenLimit;
    const { serverModel, model } = useConfig.getReadonlyState().config;
    // Session snapshot first: core adopts a resumed session's model, which may not exist in the
    // app's models.json (so the re-link never updated config). Config is the pre-init fallback.
    const displayModel = snap.model ?? serverModel ?? model;
    const lines: string[] = [];

    lines.push(row("Session", `${snap.name} (${snap.activeSessionId ?? snap.agentId})`));
    if (displayModel) {
      lines.push(row("Model", displayModel));
    }

    // Overall cache hit ratio across the session lifetime (cumulative). The denominator is
    // the *billed prompt*, not `totalUsage.inputTokens`: on an exclusive-cache upstream the
    // latter is only the cache-miss part, so the read divided by it printed 428.5%.
    const billedInput = usage.billedInputTokens;
    const cacheHitRatio = billedInput > 0 ? (totalUsage.cacheReadTokens ?? 0) / billedInput : 0;
    if (cacheHitRatio > 0) {
      lines.push("");
      lines.push(row("Cache hit", `${(cacheHitRatio * 100).toFixed(1)}%`));
    }

    lines.push("");
    lines.push(`  ── Session Lifetime ──`);
    // The billed prompt, not `totalUsage.inputTokens`: on an exclusive-cache upstream that
    // field is only the cache-miss part, so this read printed 523.2k against a 50.63M prompt
    // — 1.0% of the real figure, under a "(cumulative)" label. `pct()` below already used
    // this same denominator, so the block was showing a share of a total it never printed.
    lines.push(row("Prompt", `${fmt(billedInput)} tokens (cumulative, billed)`));
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
    lines.push(row("Input", `${fmt(uncachedInput)} (uncached)`, 4));

    if (totalCacheRead > 0) {
      lines.push(row("Cache read", `${fmt(totalCacheRead)}${pct(totalCacheRead, billedInput)}`, 4));
    }
    if (totalCacheWrite > 0) {
      lines.push(row("Cache write", `${fmt(totalCacheWrite)}${pct(totalCacheWrite, billedInput)}`, 4));
    }

    lines.push(row("Output", `${fmt(totalUsage.outputTokens)} tokens`));

    const totalReasoning = totalUsage.reasoningTokens ?? 0;
    if (totalReasoning > 0) {
      const text = totalUsage.outputTokens - totalReasoning;
      lines.push(row("Reasoning", `${fmt(totalReasoning)}${pct(totalReasoning, totalUsage.outputTokens)}`, 4));
      lines.push(row("Text", fmt(text), 4));
    }

    // Prompt + output. Sourced from the same reading as `Prompt:` above rather than read off
    // `totalUsage.totalTokens`, whose per-call producers build it as `input + output` and so
    // drop every cached token (this line printed 781.1k where the real volume was 50.88M).
    // `outputTokens` is the last line of defence: if a producer ever omits it the row reads
    // `0` rather than `NaN`, which is what an unguarded sum would render here.
    const totalTokens = billedInput + (totalUsage.outputTokens ?? 0);
    lines.push(row("Total", `${fmt(totalTokens)} tokens (prompt + output)`));

    // Average LLM generation rate across main-loop calls (cumulative output tokens /
    // cumulative model time). Side queries (titles, summaries, memory selection) are
    // intentionally excluded so this reflects the agent's own generation speed.
    if (usage.llmDurationMs > 0) {
      const rate = usage.llmOutputTokens / (usage.llmDurationMs / 1000);
      lines.push(row("Speed", `${rate.toFixed(1)} tok/s (output)`));
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
      lines.push(row("Context", `${fmt(contextInput)} tokens${pctText}`));
      if (contextCacheRead > 0 && totalCacheRead > 0) {
        // Share of the current *billed* prompt that was cached. `contextInput` is exactly
        // that prompt (see `UsageTracker.getContextFillTokens`), so it is the "hit" reading —
        // dividing by it is what makes this a rate rather than a fraction of the window.
        lines.push(row("Cache read", `${fmt(contextCacheRead)}${pct(contextCacheRead, contextInput)}`, 4));
      }
    }

    lines.push(row("Session cost", formatCost(cost)));

    // The global section is text in this view: which days were active, what they cost, and the
    // per-model split. The graph that used to sit under it is `/usage calendar`.
    if (history) {
      lines.push(...renderGlobalStats(history.daily, history.models, weeks));
    }

    return { ok: true, message: lines.join("\n") };
  },
});

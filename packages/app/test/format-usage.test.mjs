/**
 * Validates compact usage formatting for task headers / footer.
 *
 * Run: node packages/app/test/format-usage.test.mjs
 */
import assert from "node:assert/strict";

import {
  formatCompactNumber,
  formatContextUsage,
  formatUsageBrief,
  resolvePromptTokens,
} from "../dist/utils/format-usage.mjs";

assert.equal(formatCompactNumber(0), "0");
assert.equal(formatCompactNumber(342), "342");
assert.equal(formatCompactNumber(1500), "1.50k");
assert.equal(formatCompactNumber(1_200_000), "1.2M");
// Fixed decimals per unit. The footer's counter is animated (`AnimateNumber` walks an easing
// sequence at 60 ms/tick), so a width that moves with trailing zeros slides the `↓` / `↑` suffixes
// and the context segment beside it on every tick. `400k`/`1.5k`/`1.55k`/`1.6k` is the shape that
// caused it; `400.00k`/`357.21k` never changes width within its unit.
assert.equal(formatCompactNumber(400_000), "400.00k");
assert.equal(formatCompactNumber(43_150_000), "43.2M");
assert.equal(formatCompactNumber(357_210), "357.21k");
assert.equal(formatCompactNumber(1000), "1.00k");

// The regression itself, asserted as a property rather than a sample.
//
// The invariant is per-unit MONOTONICITY, not a fixed width: the digit count legitimately grows as
// the value does (`1.0M` → `50.6M`), and crossing a unit boundary legitimately gets narrower
// (`750.00k` → `1.1M`, because the unit label is shorter). What must never happen is the label
// getting narrower *inside* a unit — that is the shimmer, and it is what the trimming formatter did
// (`9.99M` … `50.6M` → `50.63M` → back to `50.6M`, 3 shrink steps in one run).
const UNIT_BOUNDARY = 1_000_000;

function widthTrace(targetTokens) {
  const trace = [];
  let current = 0;
  while (current < targetTokens) {
    const step = Math.max(1, Math.ceil((targetTokens - current) / 8));
    current = Math.min(current + step, targetTokens);
    trace.push({ tokens: current, width: formatCompactNumber(current).length });
  }
  return trace;
}

for (const target of [1_500_000, 9_000_000, 50_630_000]) {
  const trace = widthTrace(target);
  const inK = trace.filter((point) => point.tokens < UNIT_BOUNDARY);
  const inM = trace.filter((point) => point.tokens >= UNIT_BOUNDARY);

  for (const [unit, points] of [
    ["k", inK],
    ["M", inM],
  ]) {
    const shrinks = points.filter((point, i) => i > 0 && point.width < points[i - 1].width);
    assert.equal(
      shrinks.length,
      0,
      `the ${unit} label must never get narrower while the value grows (target ${target}): ` +
        `${shrinks.length} shrink step(s), e.g. at ${shrinks[0]?.tokens}`
    );
  }
}

assert.equal(formatUsageBrief({ inputTokens: 1500, outputTokens: 42 }), "1.50k in / 42 out");
assert.equal(formatUsageBrief({ inputTokens: 0, outputTokens: 0 }), "0 in / 0 out");

// Inclusive upstream (OpenAI, gateways): the cache is a subset of the prompt, so the
// prompt reading is `inputTokens` itself and the cache must NOT be added again.
assert.equal(resolvePromptTokens({ inputTokens: 1000, cacheReadTokens: 400 }), 1000);

// Exclusive upstream (Anthropic/DeepSeek native): `inputTokens` is only the cache-miss
// part, so the prompt is the sum. A fully cached subagent run made this visible once
// already — rendering `inputTokens` alone read as ~0 while 2.7M tokens were billed.
assert.equal(resolvePromptTokens({ inputTokens: 48, cacheReadTokens: 27_000 }), 27_048);
assert.equal(resolvePromptTokens({ inputTokens: 10, cacheReadTokens: 700, cacheWriteTokens: 300 }), 1010);
assert.equal(formatUsageBrief({ inputTokens: 3342, outputTokens: 44, cacheReadTokens: 2_691_831 }), "2.7M in / 44 out");
// An explicit `billedInputTokens` wins: a subagent's tracker already accumulated the exact
// per-sample sum, and re-deriving it from an aggregate is lossy (1.14% over on one run).
assert.equal(resolvePromptTokens({ inputTokens: 10, billedInputTokens: 1234, cacheReadTokens: 9999 }), 1234);
assert.equal(
  formatUsageBrief({ inputTokens: 10, billedInputTokens: 1234, outputTokens: 44, cacheReadTokens: 9999 }),
  "1.23k in / 44 out"
);

// ` of ` is the BUDGET, not the model window (a 1M-window model shows its 400k budget here).
assert.equal(formatContextUsage({ contextFillTokens: 88_000, tokenLimit: 400_000, percent: 22 }), "22% of 400.00k");
assert.equal(formatContextUsage({ contextFillTokens: 0, tokenLimit: 400_000, percent: 0 }), "?/400.00k");
assert.equal(formatContextUsage({ contextFillTokens: 100, tokenLimit: 0, percent: 0 }), "");
assert.equal(formatContextUsage({ contextFillTokens: 90_000, tokenLimit: 128_000, percent: 70.3 }), "70% of 128.00k");
// NOT clamped: above the budget is the one signal this segment carries (the trigger sits at 80%).
assert.equal(formatContextUsage({ contextFillTokens: 448_000, tokenLimit: 400_000, percent: 112 }), "112% of 400.00k");

// The budget label inside the context segment must also be width-stable while the fill moves — it is
// rebuilt on every usage snapshot, so a trembling budget would reflow the footer too. (The percentage
// itself is allowed to grow: `15%` → `100%` is real information, and it only ever gets wider.)
{
  const budgetWidths = [60_000, 120_000, 240_000, 320_000, 399_000].map(
    (fill) =>
      formatContextUsage({ contextFillTokens: fill, tokenLimit: 400_000, percent: (fill / 400_000) * 100 }).split(
        " of "
      )[1].length
  );
  assert.equal(
    new Set(budgetWidths).size,
    1,
    `the budget label must not move with the fill; got widths ${budgetWidths.join("/")}`
  );
}

console.log("format-usage validation passed");

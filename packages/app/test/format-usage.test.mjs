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
assert.equal(formatCompactNumber(1500), "1.5k");
assert.equal(formatCompactNumber(1_200_000), "1.2M");
// No trailing zeros: the footer prints a budget (`400k`) next to measured values, and `400.00k`
// spent three characters saying nothing.
assert.equal(formatCompactNumber(400_000), "400k");
assert.equal(formatCompactNumber(43_150_000), "43.15M");
assert.equal(formatCompactNumber(357_210), "357.21k");
assert.equal(formatCompactNumber(1000), "1k");

assert.equal(formatUsageBrief({ inputTokens: 1500, outputTokens: 42 }), "1.5k in / 42 out");
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
assert.equal(formatContextUsage({ contextFillTokens: 88_000, tokenLimit: 400_000, percent: 22 }), "22% of 400k");
assert.equal(formatContextUsage({ contextFillTokens: 0, tokenLimit: 400_000, percent: 0 }), "?/400k");
assert.equal(formatContextUsage({ contextFillTokens: 100, tokenLimit: 0, percent: 0 }), "");
assert.equal(formatContextUsage({ contextFillTokens: 90_000, tokenLimit: 128_000, percent: 70.3 }), "70% of 128k");
// NOT clamped: above the budget is the one signal this segment carries (the trigger sits at 80%).
assert.equal(formatContextUsage({ contextFillTokens: 448_000, tokenLimit: 400_000, percent: 112 }), "112% of 400k");

console.log("format-usage validation passed");

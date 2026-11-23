/**
 * `/usage` as text — the report a headless client receives.
 *
 * The global total is a sum of priced calls. A model with no pricing metadata contributes `0` to it,
 * which used to make "unpriced" and "free" indistinguishable: the report presented the sum as the
 * cost. The TUI gained "+ unpriced" with the same reasoning, and this pins the ACP side so the two
 * surfaces cannot disagree about what the number means.
 *
 * Run: pnpm --filter @codent/acp run validate:acp:usage
 */

import assert from "node:assert/strict";

import { formatUsageReport } from "../dist/index.mjs";

const usage = {
  billedInputTokens: 10,
  uncachedInputTokens: 10,
  total: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
  cost: 0,
  contextFillTokens: 0,
  tokenLimit: 0,
  percent: 0,
};

const day = { date: "2026-01-01", inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.5, calls: 2 };
const model = { model: "no-pricing", totalTokens: 15, outputTokens: 5, costUsd: 0.5, calls: 2 };

// One priced call and one unpriced call on the same day/model.
const mixed = formatUsageReport(usage, {
  weeks: 4,
  daily: [{ ...day, unpricedCalls: 1 }],
  models: [{ ...model, unpricedCalls: 1 }],
});
assert.match(mixed, /\$0\.500/, "the priced part is reported");
assert.match(mixed, /\+ unpriced/, "the unpriced share is named, not folded into the total");
assert.match(mixed, /1 call had no pricing metadata/, "…and a line says the cost is incomplete");

// Nothing unpriced → no hedge (a report that always hedges teaches the reader to ignore it).
const priced = formatUsageReport(usage, { weeks: 4, daily: [{ ...day, unpricedCalls: 0 }], models: [model] });
assert.doesNotMatch(priced, /unpriced/);

// Old history files have no `unpricedCalls` at all; reading must not throw or hedge.
const legacy = formatUsageReport(usage, { weeks: 4, daily: [day], models: [model] });
assert.match(legacy, /Global activity/);
assert.doesNotMatch(legacy, /unpriced/);

// No history: the session block still renders (and promises nothing about a global total).
assert.match(formatUsageReport(usage, undefined), /Session lifetime/);

console.log("acp usage report validation passed");

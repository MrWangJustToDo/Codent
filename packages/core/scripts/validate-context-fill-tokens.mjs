/**
 * Context-window fill accounting must survive BOTH upstream `input_tokens` conventions.
 *
 * The 0% footer bug: `getTokenLimitPercent()` divided `window.inputTokens` by the limit.
 * That is correct only where the upstream reports a prompt that *contains* its cache
 * counters (OpenAI, Gemini, most gateways). An **exclusive** upstream — Anthropic native,
 * DeepSeek native — reports only the cache-*miss* part there, so the cache read is
 * invisible to the formula and a fully-cached prompt renders as ~0%.
 *
 * The two conventions coexisted in this repo's own logs (same endpoint, same day):
 *
 *   10-08 17:31  in=74536   cache=74240    ← inclusive  (cache ⊆ input)
 *   10-08 18:50  in=16869   cache=29184    ← exclusive  (disjoint)
 *   10-08 19:26  in=176     cache=212992   ← exclusive, fully cached → 0.04%
 *
 * A live probe of the endpoint settles which convention produced the exclusive rows:
 * a 14.6k-token prefix, called twice, returned
 *   cold: input_tokens=14644, cache_read=0
 *   warm: input_tokens=180,   cache_read=14464
 * i.e. the true prompt is the *sum*. The cases below reuse those measured numbers.
 *
 * Run: pnpm --filter @codent/core run validate:context-fill-tokens
 */

"use strict";

import assert from "node:assert/strict";

import { UsageTracker, promptTokensOf } from "../dist/dev.mjs";

const LIMIT = 400_000;
const mk = () => {
  const usage = new UsageTracker();
  usage.setTokenLimit(LIMIT);
  return usage;
};

// ---------------------------------------------------------------------------
// 1. Exclusive upstream: the real fill is input + cache, and the % must not collapse
// ---------------------------------------------------------------------------
{
  const usage = mk();
  // Measured, 10-08 19:26 (the row that rendered as 0%).
  usage.updateWindowUsage({ inputTokens: 176, outputTokens: 100, totalTokens: 276, cacheReadTokens: 212992 });

  assert.equal(usage.getContextFillTokens(), 213168, "exclusive: fill must be input + cache_read");
  const pct = usage.getTokenLimitPercent();
  assert.ok(
    pct > 50 && pct < 54,
    `exclusive: a full 213k window must read ~53%, got ${pct.toFixed(2)}% (the bug rendered 0.04%)`
  );

  // The regression shape, asserted directly: dividing the raw field collapses.
  const naive = (176 / LIMIT) * 100;
  assert.ok(naive < 1, "control: the old formula really does render this row as ~0%");
}

// ---------------------------------------------------------------------------
// 2. Inclusive upstream: input already contains cache — must NOT double-count
// ---------------------------------------------------------------------------
{
  const usage = mk();
  // Measured, 10-08 17:31 (inclusive row — rendered correctly before the flip).
  usage.updateWindowUsage({ inputTokens: 74536, outputTokens: 10, totalTokens: 74546, cacheReadTokens: 74240 });

  assert.equal(usage.getContextFillTokens(), 74536, "inclusive: cache ⊆ input, so the fill stays input");
  const pct = usage.getTokenLimitPercent();
  assert.ok(pct > 18 && pct < 19, `inclusive: 74.5k/400k must read ~18.6%, got ${pct.toFixed(2)}%`);
}

// ---------------------------------------------------------------------------
// 3. The degradation boundary — the reading can under-count, never over-count
// ---------------------------------------------------------------------------
{
  const usage = mk();
  // Exclusive upstream, but almost nothing was cached: the fresh part outweighs the
  // cached part, so the heuristic reads it as inclusive and under-counts.
  usage.updateWindowUsage({ inputTokens: 50_000, outputTokens: 0, totalTokens: 0, cacheReadTokens: 1_000 });
  const fill = usage.getContextFillTokens();
  assert.equal(fill, 50_000, "near-cold exclusive prompt reads as inclusive (documented under-count)");

  // The invariant that keeps the failure mode safe: whatever the convention, the fill
  // is never *smaller* than the raw input. Over-counting is what would misfire compaction.
  for (const [input, cache] of [
    [0, 0],
    [100, 0],
    [0, 500],
    [1_000, 999],
    [1_000, 1_000],
    [1_000, 1_001],
    [200_000, 4_000],
  ]) {
    const u = mk();
    u.updateWindowUsage({ inputTokens: input, outputTokens: 0, totalTokens: 0, cacheReadTokens: cache });
    const got = u.getContextFillTokens();
    assert.ok(
      got >= input && got >= cache,
      `fill must dominate both fields (input=${input} cache=${cache}) — got ${got}`
    );
    assert.ok(got <= input + cache, `fill must never exceed the sum (input=${input} cache=${cache}) — got ${got}`);
  }
}

// ---------------------------------------------------------------------------
// 4. cache_write counts the same way as cache_read
// ---------------------------------------------------------------------------
{
  const usage = mk();
  usage.updateWindowUsage({ inputTokens: 10, outputTokens: 0, totalTokens: 0, cacheWriteTokens: 90_000 });
  assert.equal(usage.getContextFillTokens(), 90_010, "cache_write is part of the prompt like cache_read");
  // cache_read + cache_write are pooled, so neither alone has to exceed input.
  const both = mk();
  both.updateWindowUsage({
    inputTokens: 100,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 40_000,
    cacheWriteTokens: 40_000,
  });
  assert.equal(both.getContextFillTokens(), 80_100, "pooled cache counters decide the convention together");
}

// ---------------------------------------------------------------------------
// 5. The percentage base and the compaction trigger must share one reading
// ---------------------------------------------------------------------------
{
  const usage = mk();
  usage.updateWindowUsage({ inputTokens: 176, outputTokens: 0, totalTokens: 0, cacheReadTokens: 212_992 });

  const snap = usage.getChangeSnapshot();
  assert.equal(snap.contextFillTokens, 213_168, "the snapshot must carry the fill, not the raw input field");
  assert.equal(
    snap.percent,
    usage.getTokenLimitPercent(),
    "percent and contextFillTokens must describe the same window"
  );
  assert.ok(snap.percent > 50, `snapshot percent must not collapse on an exclusive upstream — got ${snap.percent}`);

  // The trigger used to read `window.inputTokens`; the same row drove it to ~0, so
  // compaction never fired. It must now agree with the percentage base.
  assert.equal(
    snap.contextFillTokens,
    usage.getWindowUsage().inputTokens + usage.window.cacheReadTokens,
    "trigger and percent read the same number"
  );
}

// ---------------------------------------------------------------------------
// 6. Restore must not change the reading (a resumed session keeps its fill)
// ---------------------------------------------------------------------------
{
  const live = mk();
  live.updateWindowUsage({ inputTokens: 176, outputTokens: 0, totalTokens: 0, cacheReadTokens: 212_992 });

  // `setWindowUsage` is the restore writer; it takes the same TokenUsage shape.
  const restored = mk();
  restored.setWindowUsage({
    inputTokens: 176,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 212_992,
    cacheWriteTokens: 0,
  });
  assert.equal(
    restored.getContextFillTokens(),
    live.getContextFillTokens(),
    "restore must reproduce the live fill (persisted `contextTokens` is written from it)"
  );
  assert.equal(restored.getTokenLimitPercent(), live.getTokenLimitPercent(), "and therefore the same percent");

  // --- the LIFETIME cache-hit ratio survives a resume, including across conventions ---
  //
  // `billedInputTotal` is a per-sample sum. Re-deriving it from the aggregate applies the convention
  // heuristic to totals, which only agrees while every sample used the same convention — one
  // session can hold rows from both (a gateway switched mid-run), and `resume` then reported a
  // different "/usage Cache hit" than the live run. The persisted exact count is what fixes it.
  const mixed = mk();
  // inclusive sample: cache is part of input.
  mixed.updateWindowUsage({ inputTokens: 1000, outputTokens: 10, totalTokens: 0, cacheReadTokens: 400 });
  // exclusive sample: input is the cache-miss part only.
  mixed.updateWindowUsage({ inputTokens: 100, outputTokens: 10, totalTokens: 0, cacheReadTokens: 900 });
  const liveRatio = mixed.getCacheHitRatio();
  const liveBilled = mixed.getBilledInputTokens();

  const resumed = mk();
  resumed.restoreTotals(mixed.getTotal(), liveBilled);
  assert.equal(resumed.getBilledInputTokens(), liveBilled, "the exact billed prompt is carried over");
  assert.equal(resumed.getCacheHitRatio(), liveRatio, "…so the lifetime cache hit is identical after a resume");

  // Non-vacuous: the aggregate reading really does disagree on this fixture.
  const derived = mk();
  derived.restoreTotals(mixed.getTotal());
  assert.notEqual(
    derived.getCacheHitRatio(),
    liveRatio,
    "re-deriving from the aggregate drifts (why the field exists)"
  );

  // Backward compatibility: a session persisted before the field existed still restores, using the
  // old aggregate reading instead of failing.
  const legacy = mk();
  legacy.restoreTotals(mixed.getTotal());
  assert.equal(
    legacy.getBilledInputTokens(),
    promptTokensOf(mixed.getTotal()),
    "an old session falls back to the aggregate reading"
  );
}

// ---------------------------------------------------------------------------
// 7. window.totalTokens (extension `windowTokens`) tracks the fill, not input-only
// ---------------------------------------------------------------------------
{
  const usage = mk();
  usage.updateWindowUsage({ inputTokens: 176, outputTokens: 100, totalTokens: 0, cacheReadTokens: 212_992 });
  assert.equal(
    usage.getWindowUsage().totalTokens,
    213_268,
    "window.totalTokens must include the cached prompt (it is what extensions render as the window)"
  );
}

// ---------------------------------------------------------------------------
// 8. Lifetime cache share has its own denominator (the SAME bug, totals side)
// ---------------------------------------------------------------------------
// `/usage` printed `Cache hit: 428.5%` on a real session: 125.4k cache read divided by
// 29.3k cumulative inputTokens, i.e. the cache-miss part. The billed prompt is the
// denominator, and it is the per-sample sum — `promptTokensOf` on each reading, never the
// larger of the two aggregate fields and never a sum of the aggregates (the section 5/6
// note at the top of this file says why: the convention is decided per sample).
{
  // Exclusive upstream, reproduced from the reported session.
  const exclusive = new UsageTracker();
  exclusive.addTotal({ inputTokens: 29_300, outputTokens: 1_000, totalTokens: 0, cacheReadTokens: 125_400 });
  assert.equal(
    exclusive.getBilledInputTokens(),
    154_700,
    "exclusive: the prompt accumulates per sample as input + cache, not the larger reading"
  );
  const hit = exclusive.getCacheHitRatio();
  assert.ok(hit > 0.8 && hit < 0.82, `cache hit must be ~81.0% — got ${(hit * 100).toFixed(1)}%`);
  // The regression shape, asserted directly.
  const naive = 125_400 / 29_300;
  assert.ok(naive > 4, "control: the old denominator really does print 428.5%");

  // Inclusive upstream: inputTokens already contains the cache read, so taking the max
  // is a no-op. Adding instead would inflate the denominator and deflate the ratio.
  const inclusive = new UsageTracker();
  inclusive.addTotal({ inputTokens: 125_400, outputTokens: 1_000, totalTokens: 0, cacheReadTokens: 100_000 });
  assert.equal(inclusive.getBilledInputTokens(), 125_400, "inclusive: inputTokens already is the prompt");
  const incHit = inclusive.getCacheHitRatio();
  assert.ok(
    incHit > 0.79 && incHit < 0.81,
    `inclusive: 100k/125.4k must read ~79.7%, got ${(incHit * 100).toFixed(1)}%`
  );

  // The share can never leave (0,1] under either convention.
  for (const [input, cache] of [
    [0, 0],
    [1_000, 0],
    [0, 1_000],
    [1_000, 1_000],
    [1_000, 5_000],
    [500_000, 4_000],
  ]) {
    const u = new UsageTracker();
    u.addTotal({ inputTokens: input, outputTokens: 0, totalTokens: 0, cacheReadTokens: cache });
    const r = u.getCacheHitRatio();
    assert.ok(r >= 0 && r <= 1, `cache hit must stay in [0,1] (input=${input} cache=${cache}) — got ${r}`);
    assert.ok(
      u.getBilledInputTokens() >= input && u.getBilledInputTokens() >= cache,
      `billed prompt must dominate both fields (input=${input} cache=${cache})`
    );
  }
}

// ---------------------------------------------------------------------------
// 9. Both readings reach the snapshot (the host has no other source)
// ---------------------------------------------------------------------------
{
  const usage = mk();
  usage.addTotal({ inputTokens: 29_300, outputTokens: 1_000, totalTokens: 0, cacheReadTokens: 125_400 });
  // NB: `updateWindowUsage` also folds into the lifetime totals, so the billed prompt is
  // the accumulated 29_300+150 input against the accumulated 125_400+283_648 cache read.
  usage.updateWindowUsage({ inputTokens: 150, outputTokens: 0, totalTokens: 0, cacheReadTokens: 283_648 });

  const snap = usage.getChangeSnapshot();
  // `updateWindowUsage` accumulates per sample too, so the lifetime prompt is
  // promptOf(29_300+125_400) + promptOf(150+283_648) = 154_700 + 283_798.
  assert.equal(snap.billedInputTokens, 438_498, "snapshot must carry the billed prompt for the lifetime view");
  assert.equal(snap.contextFillTokens, 283_798, "and the window fill for the context view");
  // The two are different questions on different scopes and must not collapse into one.
  assert.notEqual(
    snap.billedInputTokens,
    snap.contextFillTokens,
    "lifetime prompt and current window fill are distinct readings"
  );
}

// ---------------------------------------------------------------------------
// 10. reset() clears the lifetime prompt with everything else
// ---------------------------------------------------------------------------
{
  const usage = mk();
  usage.addTotal({ inputTokens: 29_300, outputTokens: 1_000, totalTokens: 0, cacheReadTokens: 125_400 });
  assert.ok(usage.getBilledInputTokens() > 0, "precondition: the total accumulated");
  usage.reset();
  assert.equal(usage.getBilledInputTokens(), 0, "reset must zero the lifetime prompt like `total`");
  assert.equal(usage.getCacheHitRatio(), 0, "and the ratio with it");
}

console.log("context-fill-tokens validation passed");

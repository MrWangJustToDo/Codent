/**
 * Regression gate for the exclusive/inclusive cache convention on every **display** surface.
 *
 * The convention itself was fixed for context fill (`validate:context-fill-tokens`), but the
 * lifetime views kept reading raw fields, and none of them had a guard — which is how three
 * separate surfaces drifted:
 *
 * 1. **`SessionData.totalTokens` dropped every cached token.** `accumulateTotal` built it as
 *    `input + output`, so `/usage`'s `Total:` line printed 781.1k where the real volume was
 *    50.88M (65×), and the footer/task-row inherited the same shape through per-call
 *    `totalTokens` producers.
 * 2. **The `/usage` block printed the cache-miss part as "Input (cumulative)"** — 523.2k
 *    against a 50.63M prompt — while the same block used the real prompt as the denominator
 *    of `Cache read: 50.12M (99.0%)`. It showed a share of a total it never printed.
 * 3. **The usage store trusted `usage.totalTokens` verbatim**, so `buildRecord` inherited
 *    per-call producers' `input + output`, understating the global graph by 1.4×.
 *
 * A guard is what stops this: the 99.0%/50.12M pair is self-checking, and the assertions
 * below pin that relationship rather than a formatted string.
 *
 * Run: pnpm --filter @codent/core run validate:lifetime-total-tokens
 */

import assert from "node:assert/strict";

import { UsageStore, UsageTracker, promptTokensOf, totalTokensOf, registerCoreEnv } from "../dist/dev.mjs";
import { formatToolOutput } from "../dist/index.mjs";

// A minimal env. `path` is the synchronous one CoreEnv requires (a hand-written fixture
// without it exercises a degraded code path); `exists` starts false and `readFile` returns
// whatever `appendFile` captured, so `readHistory` reads back what `append` wrote.
const files = new Map();
const usingEnv = {
  rootPath: "/mock",
  getPlatform: async () => "linux",
  getArch: async () => "arm64",
  getEnv: async () => ({}),
  homedir: async () => "/mock",
  path: {
    join: (...parts) => parts.join("/"),
    dirname: (p) => {
      const i = p.lastIndexOf("/");
      return i <= 0 ? "/" : p.slice(0, i);
    },
    basename: (p, ext) => {
      const base = p.split("/").pop() ?? p;
      return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
    },
    extname: (p) => {
      const base = p.split("/").pop() ?? p;
      const i = base.lastIndexOf(".");
      return i < 0 ? "" : base.slice(i);
    },
    resolve: (...parts) => `/${parts.join("/")}`,
    normalize: (p) => p.replace(/\/+/g, "/"),
    isAbsolute: (p) => p.startsWith("/"),
    getSep: () => "/",
  },
  fs: {
    readFile: async (p) => files.get(p) ?? "",
    writeFile: async (p, data) => void files.set(p, String(data)),
    appendFile: async () => {},
    mkdir: async () => {},
    exists: async (p) => p === ".agents/usage" || files.has(p),
    readdir: async (dir) =>
      [...files.keys()]
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => ({ name: p.slice(dir.length + 1), type: "file" })),
    remove: async () => {},
    stat: async () => ({ isDirectory: () => false, size: 0, mtimeMs: 0 }),
  },
  runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  fetch: async () => new Response("", { status: 200 }),
};
registerCoreEnv(usingEnv);

// ============================================================================
// The rule: `promptTokensOf` / `totalTokensOf`
// ============================================================================

{
  // Inclusive upstream: the cache is a subset of the prompt, so the prompt is `input`.
  const inclusive = { inputTokens: 1_000, outputTokens: 50, totalTokens: 0, cacheReadTokens: 400 };
  assert.equal(
    promptTokensOf(inclusive),
    1_000,
    "inclusive: the prompt is `inputTokens`; adding the subset double-counts"
  );
  assert.equal(totalTokensOf(inclusive), 1_050, "and the total is that prompt plus output");

  // Exclusive upstream: the cache is disjoint, so the prompt is the sum.
  const exclusive = { inputTokens: 48, outputTokens: 13, totalTokens: 0, cacheReadTokens: 27_000 };
  assert.equal(promptTokensOf(exclusive), 27_048, "exclusive: the prompt is the sum of the disjoint parts");
  assert.equal(totalTokensOf(exclusive), 27_061, "and the total includes the cached prompt");
}

// ============================================================================
// 1. The tracker's lifetime `totalTokens` includes the cached prompt
// ============================================================================

{
  const tracker = new UsageTracker();
  // One exclusive-upstream call, as the real log line reads:
  //   input=307 output=213813 cacheRead=337920
  tracker.updateWindowUsage({ inputTokens: 307, outputTokens: 213_813, totalTokens: 0, cacheReadTokens: 337_920 });
  const total = tracker.getTotal();

  assert.equal(total.inputTokens, 307, "the raw field keeps the upstream's own convention");
  assert.equal(
    total.totalTokens,
    307 + 337_920 + 213_813,
    "lifetime totalTokens must be the billed prompt + output — `input + output` omitted 337,920 cached tokens"
  );
  assert.notEqual(
    total.totalTokens,
    total.inputTokens + total.outputTokens,
    "and that omission is exactly what this guard exists to catch"
  );
}

// ============================================================================
// 2. A cache-dominated session reports its real volume
// ============================================================================

{
  // The shape of the reported session: 60 calls of ~835k cache read each, with a tiny
  // uncached remainder. 523.2k / 50.12M / 99.0% are the figures from the terminal.
  const tracker = new UsageTracker();
  tracker.setTokenLimit(400_000);
  const CACHE_READ_PER_CALL = 835_333;
  const INPUT_PER_CALL = 8_720;
  const OUTPUT_PER_CALL = 4_298;
  for (let i = 0; i < 60; i += 1) {
    tracker.updateWindowUsage({
      inputTokens: INPUT_PER_CALL,
      outputTokens: OUTPUT_PER_CALL,
      totalTokens: 0,
      cacheReadTokens: CACHE_READ_PER_CALL,
    });
  }

  const total = tracker.getTotal();
  const billed = tracker.getBilledInputTokens();

  // The `Cache read: X (Y%)` line is self-checking: Y is X over the billed prompt, so the
  // pair pins the denominator even though the old block never printed it.
  const cacheShare = total.cacheReadTokens / billed;
  assert.equal(
    Math.round(cacheShare * 1000) / 10,
    99,
    "the cache share must read 99.0% — this is the figure the block renders"
  );

  // The bug in one line: the raw field is ~1% of the prompt, and it used to be the
  // "Input (cumulative)" headline.
  assert.equal(total.inputTokens, 523_200, "raw inputTokens accumulates the cache-miss part only");
  assert.ok(
    billed > total.inputTokens * 90,
    `the billed prompt (${billed}) must dwarf the cache-miss sum (${total.inputTokens}) — printing the latter as "Input (cumulative)" is the bug`
  );

  // `Total:` — the line that printed 781.1k while the real volume was 50.88M.
  const realTotal = billed + total.outputTokens;
  assert.equal(
    total.totalTokens,
    realTotal,
    "the tracker's totalTokens must equal the reported Total, from the same reading"
  );
  assert.ok(
    total.totalTokens > (total.inputTokens + total.outputTokens) * 60,
    "and it must not be the input+output reading, which understated this session by 65x"
  );
}

// ============================================================================
// 2b. Uncached input is the cache-miss share under BOTH conventions
// ============================================================================

{
  // The reported session, in the shape the panel printed it: a 44.3M prompt of which 44.1M was
  // served from cache. `total.inputTokens` holds the WHOLE prompt here (inclusive upstream), so
  // rendering it as "Input (uncached)" showed 44.3M where 0.2M was — the same number as the
  // `Prompt:` line above, under a second label.
  const tracker = new UsageTracker();
  tracker.updateWindowUsage({
    inputTokens: 44_300_000,
    outputTokens: 118_800,
    totalTokens: 0,
    cacheReadTokens: 44_100_000,
  });

  assert.equal(tracker.getTotal().inputTokens, 44_300_000, "an inclusive upstream puts the whole prompt here");
  assert.equal(
    tracker.getUncachedInputTokens(),
    200_000,
    "the uncached share is billed prompt minus cache, not the raw field — 44.3M under an `(uncached)` label was the bug"
  );
  assert.equal(
    tracker.getChangeSnapshot().uncachedInputTokens,
    tracker.getUncachedInputTokens(),
    "the snapshot must project the tracker's own reading, so every host prints one number"
  );

  // Exclusive upstream (Anthropic/DeepSeek native): `inputTokens` is already the cache-miss part,
  // and the subtraction must still agree with it rather than double-count.
  const exclusive = new UsageTracker();
  exclusive.updateWindowUsage({
    inputTokens: 8_720,
    outputTokens: 4_298,
    totalTokens: 0,
    cacheReadTokens: 835_333,
  });
  assert.equal(
    exclusive.getUncachedInputTokens(),
    8_720,
    "under the exclusive convention the two readings coincide — the derivation must not depend on which one the upstream reports"
  );
  assert.equal(
    exclusive.getBilledInputTokens(),
    8_720 + 835_333,
    "while the billed prompt is the sum, which is why the share is computed from it"
  );

  // Cache write counts as cached too: an Anthropic-style call bills it at its own rate, but it is
  // not uncached input.
  const withWrite = new UsageTracker();
  withWrite.updateWindowUsage({ inputTokens: 1_000, outputTokens: 10, totalTokens: 0, cacheWriteTokens: 900 });
  assert.equal(withWrite.getUncachedInputTokens(), 100, "cache WRITE tokens are cached, not uncached input");
}

// ============================================================================
// 3. The usage store records the billed prompt, not the upstream's raw field
// ============================================================================
//
// `buildRecord` used to trust `usage.totalTokens` verbatim, which inherits the per-call
// producers' `input + output` shape. Measured across the whole global store: 695.4M
// recorded against 986.5M real (1.4× understated), and the heatmap/day/model totals read
// that field. Driven through a real `UsageStore` + `readHistory` so the round trip is
// covered, not just the arithmetic.

const written = [];
registerCoreEnv({
  ...usingEnv,
  fs: {
    ...usingEnv.fs,
    appendFile: async (p, data) => {
      files.set(p, (files.get(p) ?? "") + String(data));
      written.push(...String(data).split("\n").filter(Boolean));
    },
  },
});

{
  const store = new UsageStore();
  // One exclusive-upstream call: the raw input is the cache-miss part only.
  const appended = await store.append({
    agentId: "agent_test",
    model: "test-model",
    usage: { inputTokens: 307, outputTokens: 213_813, totalTokens: 307 + 213_813, cacheReadTokens: 337_920 },
    costUsd: 0,
  });

  assert.equal(appended, true, "the record must be written");
  assert.equal(written.length, 1, "exactly one line");
  const record = JSON.parse(written[0]);
  assert.equal(
    record.totalTokens,
    307 + 337_920 + 213_813,
    "the store must record the billed prompt + output — trusting the given totalTokens dropped 337,920 cached tokens"
  );
  assert.notEqual(
    record.totalTokens,
    record.inputTokens + record.outputTokens,
    "which is the shape the per-call producers hand in, so trusting them is the bug"
  );

  const history = await store.readHistory(1);
  assert.equal(history.daily.length, 1, "the day bucket must exist");
  assert.equal(
    history.daily[0].totalTokens,
    record.totalTokens,
    "and the aggregated day total must carry it through, since the heatmap reads this"
  );
}

// ============================================================================
// 4. The rule is shared, not restated per surface
// ============================================================================

{
  // `UsageTracker` delegates to `runtime-types/token-usage.js` (beside `calculateCost`) so
  // the usage store can read the same one without an `agent → managers` edge. If the store
  // restated it, a store record and a session total could disagree on the same call.
  const tracker = new UsageTracker();
  const sample = { inputTokens: 5, outputTokens: 7, totalTokens: 0, cacheReadTokens: 900 };
  tracker.updateWindowUsage({ ...sample });

  assert.equal(
    tracker.getBilledInputTokens(),
    promptTokensOf(sample),
    "the tracker must read the shared rule, not a local copy of it"
  );
  assert.equal(
    tracker.getTotal().totalTokens,
    totalTokensOf(sample),
    "and its lifetime total must come from the shared total rule"
  );
}

// ============================================================================
// 5. A task row read back from an older session still shows its prompt
// ============================================================================

{
  // `billedInputTokens` was added to the task output after the shape shipped, so 49 outputs
  // persisted in this workspace's own sessions do not carry it (nor the cache counters).
  // `formatTaskOutput` used to default it to 0 and render `[1 iteration, 300 tokens]` for a
  // 27k-token run — a plausible number, which is why it survived.
  const taskOutput = (usage) => ({
    subagentId: "subagent_test",
    summary: "done",
    truncated: false,
    iterations: 1,
    maxIterations: 50,
    reachedLimit: false,
    incomplete: false,
    aborted: false,
    usage,
  });
  const statusLine = (usage) => formatToolOutput(taskOutput(usage), "task").split("\n")[0];

  // A current result carries the tracker's own reading, and it is what the row prints.
  const current = { inputTokens: 1_200, outputTokens: 300, totalTokens: 1_500, billedInputTokens: 27_000 };
  assert.equal(
    statusLine(current),
    "[1 iteration, 27300 tokens]",
    "a current result prints its billed prompt + output"
  );

  // A pre-migration result has no `billedInputTokens`. Falling back to 0 renders the output
  // alone; the honest reading of what the row still holds is `promptTokensOf(usage)`.
  const legacy = { inputTokens: 1_200, outputTokens: 300, totalTokens: 1_500 };
  const legacyLine = statusLine(legacy);
  assert.notEqual(legacyLine, "[1 iteration, 300 tokens]", "a legacy row must not read as the output alone");
  assert.equal(
    legacyLine,
    `[1 iteration, ${promptTokensOf(legacy) + legacy.outputTokens} tokens]`,
    "it falls back to the same convention-aware sum the tracker uses"
  );
  // Which is what the host transcript already shows for the same part, so the two surfaces
  // agree on a restored session instead of contradicting each other.
  assert.equal(
    promptTokensOf(legacy) + legacy.outputTokens,
    1_500,
    "control: with no cache counters the fallback is input + output, not a fabricated prompt"
  );
}

console.log("lifetime-total-tokens validation passed");

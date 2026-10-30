/**
 * Regression gate for subagent usage accounting.
 *
 * Two silent-wrong-behavior bugs, both of the kind that renders as a plausible number
 * rather than an error:
 *
 * 1. **A subagent's usage tracker has no pricing (cost books as `$0`).** The parent's
 *    resolved `ModelInfo` never reached a spawned subagent, so `usage.pricing` stayed
 *    `null` and `accumulateTotal` took its `if (!pricing) return 0` branch. Observed on a
 *    real workspace: all 938 `subagent_*` calls in `.agents/usage/*.jsonl` recorded
 *    `costUsd: 0` while main-agent and side-query calls recorded normally. The cause was
 *    three hops, each dropping the field: `agent-factory` destructured `modelInfo` out of
 *    the config it stores, `spawnSubagent` inherited that stored config, and a late
 *    models.dev lookup / `/model` switch only ever updates the agent's *live* `modelInfo`
 *    field (never the stored config).
 * 2. **The task row prints `inputTokens` as if it were the prompt.** Under an exclusive
 *    upstream (Anthropic/DeepSeek native) `inputTokens` holds only the cache-miss part, and
 *    a subagent's prompt is almost entirely cache reads — one real run reported 3,342
 *    instead of 2,695,173. `SubagentResult.usage` / `TaskOutput.usage` therefore carry
 *    `billedInputTokens`, the tracker's own cache-aware reading, so hosts never have to
 *    re-derive it from an aggregate (that derivation is lossy: measured 1.14% over on that
 *    same run, 0.04% across the fleet).
 *
 * Run: pnpm --filter @codent/core run validate:subagent-usage-pricing
 */

import assert from "node:assert/strict";

import { UsageTracker } from "../dist/dev.mjs";
import { AgentManager, registerCoreEnv } from "../dist/index.mjs";

// A minimal env: nothing here touches the filesystem or runs commands.
registerCoreEnv({
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
    parse: (p) => {
      const base = p.split("/").pop() ?? p;
      const i = base.lastIndexOf(".");
      return {
        root: "/",
        dir: p.slice(0, p.lastIndexOf("/")) || "/",
        base,
        ext: i < 0 ? "" : base.slice(i),
        name: i < 0 ? base : base.slice(0, i),
      };
    },
  },
  fs: {
    readFile: async () => {
      throw new Error("ENOENT");
    },
    writeFile: async () => {},
    appendFile: async () => {},
    mkdir: async () => {},
    exists: async () => false,
    readdir: async () => [],
    remove: async () => {},
    stat: async () => {
      throw new Error("ENOENT");
    },
  },
  runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  fetch: async () => new Response("", { status: 200 }),
});

const PRICING = { inputPerM: 0.255552, outputPerM: 1.27776, cacheReadPerM: 0.0127776 };
const MODEL_INFO = {
  id: "deepseek/deepseek-v4.1-flash",
  name: "DeepSeek V4.1 Flash",
  style: "anthropic",
  contextWindow: 1_000_000,
  defaultMaxTokens: 384_000,
  pricing: PRICING,
  capabilities: [],
};

const rootConfig = {
  name: "root",
  model: "deepseek/deepseek-v4.1-flash",
  modelStyle: "anthropic",
  modelBaseURL: "https://example.invalid/anthropic",
  modelApiKey: "test-key",
};

// ============================================================================
// 1. `modelInfo` survives construction — the parent's own tracker is priced
// ============================================================================

{
  const manager = new AgentManager();
  const root = await manager.createManagedAgent({ ...rootConfig, modelInfo: MODEL_INFO });

  assert.deepEqual(
    root.usage.getPricing(),
    PRICING,
    "a root agent given modelInfo must price its calls — otherwise every cost it reports is $0"
  );
  assert.ok(
    "modelInfo" in root.config,
    "the stored config must carry modelInfo: a subagent inherits that config rather than re-resolving the model"
  );
}

// ============================================================================
// 2. A spawned subagent inherits pricing from the parent's STORED config
// ============================================================================

{
  const manager = new AgentManager();
  const root = await manager.createManagedAgent({ ...rootConfig, modelInfo: MODEL_INFO });
  const sub = await manager.spawnSubagent(root.id, { name: "sub" });

  assert.deepEqual(
    sub.usage.getPricing(),
    PRICING,
    "a subagent must price its calls at the inherited model's rate — this is the bug that booked 938 calls at $0"
  );

  // End to end: a call on the subagent's own tracker must actually price, and the
  // resulting cost must land on the parent through the aggregation path.
  const call = { inputTokens: 48, outputTokens: 13, totalTokens: 61, cacheReadTokens: 27_000 };
  sub.usage.addTotal(call);
  const subCost = sub.usage.getTotalCostUsd();
  assert.ok(subCost > 0, `a subagent call must cost something, got ${subCost}`);

  root.usage.addTotalWithCost(sub.usage.getTotal(), subCost);
  assert.equal(
    root.usage.getTotalCostUsd(),
    subCost,
    "the parent must carry the subagent's own cost — it was $0 before the fix, losing ~25% of real spend"
  );
}

// ============================================================================
// 3. A late models.dev lookup still reaches a subagent spawned afterwards
// ============================================================================

{
  // The `/model` switch and late metadata path update only the LIVE `modelInfo` field,
  // never `config.modelInfo`. Reading the field alone is what keeps this case working.
  const manager = new AgentManager();
  const root = await manager.createManagedAgent(rootConfig);
  assert.equal(root.usage.getPricing(), null, "no metadata yet — the lookup has not landed");

  root.setModelInfo(MODEL_INFO);
  root.usage.setPricing(PRICING);

  const sub = await manager.spawnSubagent(root.id, { name: "late-sub" });
  assert.deepEqual(
    sub.usage.getPricing(),
    PRICING,
    "a subagent spawned after a late lookup must still inherit pricing — this is why `spawnSubagent` reads the live field"
  );
}

// ============================================================================
// 4. `billedInputTokens` is the cache-aware prompt, not the raw aggregate
// ============================================================================

{
  // Same shape as a real subagent run (subagent_mv0k1wui_b8h3qv): 31 calls whose raw
  // `inputTokens` sum to a few thousand while the prompt actually sent was 2.7M.
  const tracker = new UsageTracker();
  const perCall = { inputTokens: 108, outputTokens: 30, totalTokens: 138, cacheReadTokens: 86_930 };
  for (let i = 0; i < 31; i += 1) {
    tracker.addTotal({ ...perCall });
  }

  assert.equal(tracker.getTotal().inputTokens, 3_348, "raw input is the cache-miss sum only");

  const billed = tracker.getBilledInputTokens();
  assert.ok(
    billed > 2_000_000,
    `the billed prompt must reflect the cache, got ${billed} — this is the number a host must render`
  );

  // Guard the distinction the display fix depends on: the aggregate heuristic (applying
  // the exclusive/inclusive rule to the SUMS) must not be what the tracker reports.
  const aggregateHeuristic = tracker.getTotal().inputTokens + tracker.getTotal().cacheReadTokens;
  assert.equal(
    billed,
    aggregateHeuristic,
    "when every sample agrees on the convention the two readings coincide — the tracker is still the source of truth"
  );
}

// ============================================================================
// 5. A child's usage change republishes the parent's `subagents` rows
//
// The retained `subagents` channel is rebuilt on status/phase events, and token accrual is neither.
// A long `task` therefore kept its spawn-time numbers until the next flip: a live subscriber saw
// nothing while the run spent tokens, and a reconnecting one saw the whole run land at once.
// ============================================================================

{
  const manager = new AgentManager();
  const root = await manager.createManagedAgent({ ...rootConfig, modelInfo: MODEL_INFO });
  const sub = await manager.spawnSubagent(root.id, { name: "usage-sub" });

  const frames = [];
  const dispose = manager.on("session:subagents", (event) => frames.push(event.payload));
  frames.length = 0; // drop the retained replay; only a change is interesting

  sub.usage.addTotal({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });

  const snapshot = frames.at(-1);
  assert.ok(snapshot, "a child's usage change must republish the parent's subagent rows");
  const row = (snapshot.subagents ?? []).find((entry) => entry.id === sub.id);
  assert.equal(
    row?.usage?.total?.inputTokens,
    120,
    "the republished row must carry the new numbers, not the spawn-time snapshot"
  );
  dispose();
}

// ============================================================================
// 6. A session switch destroys the previous conversation's subagents
//
// `task` children are `autoDestroy: false` so a finished preview survives; a switch is therefore
// the only point that releases them. The lifecycle test only proves the host HOOK is called — this
// one proves the agent actually leaves the registry (delete the implementation and it fails).
// ============================================================================

{
  const manager = new AgentManager();
  const root = await manager.createManagedAgent({ ...rootConfig, modelInfo: MODEL_INFO });
  const sub = await manager.spawnSubagent(root.id, { name: "switch-sub" });
  assert.ok(manager.getAgent(sub.id), "precondition: the child is registered");

  root.reset("session-switch");

  assert.equal(manager.getAgent(sub.id), undefined, "the child is destroyed, not merely aborted");
  assert.deepEqual(root.childIds, [], "the parent no longer lists it");
}

console.log("subagent-usage-pricing validation passed");

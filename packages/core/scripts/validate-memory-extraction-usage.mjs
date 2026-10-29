/**
 * Regression gate for memory extraction / consolidation accounting.
 *
 * Both queries are real LLM calls, and both were **unaccounted**: the port records every
 * side query in the global `.agents/usage/*.jsonl` store, but that store is
 * observability — it is not the owning agent's `UsageTracker`. So a `memory:extract` call
 * reached the jsonl and no session's lifetime totals, making it the one LLM call in a run
 * that no tracker ever saw (`memory-retrieval.selectWithLLM` had already taken a tracker
 * for the prefetch selection query; the extraction path had not).
 *
 * This drives the real `extractMemories` / `consolidateMemories` against a stub adapter and
 * asserts the owning tracker moves — the only shape that stays honest, since the defect was
 * an omitted argument, not a wrong calculation.
 *
 * Run: pnpm --filter @codent/core run validate:memory-extraction-usage
 */

import assert from "node:assert/strict";

import { MemoryService, UsageTracker, consolidateMemories, extractMemories, registerCoreEnv } from "../dist/dev.mjs";

// A minimal env: the extractor touches no filesystem of its own (the memory manager is a stub).
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
    stat: async () => ({ isDirectory: () => false, size: 0, mtimeMs: 0 }),
  },
  runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  fetch: async () => new Response("", { status: 200 }),
});

/** One side-query call worth of tokens, as `RUN_FINISHED` would report them. */
const CALL_USAGE = { promptTokens: 5000, completionTokens: 120, totalTokens: 5120 };
const EXPECTED_INPUT = 5000;
const EXPECTED_OUTPUT = 120;

const structuredStream = (final) =>
  (async function* () {
    yield { type: "TEXT_MESSAGE_CONTENT", delta: JSON.stringify(final) };
    yield { type: "CUSTOM", name: "structured-output.complete", value: { object: final, raw: "" } };
    yield { type: "RUN_FINISHED", usage: CALL_USAGE };
  })();

const adapter = (final, stub) => ({
  adapter: {
    kind: "text",
    name: "fake",
    model: "fake-model",
    "~types": {},
    // These callers take the structured path. The text fallback is made unusable so a
    // silent degradation to text mode fails the run instead of quietly passing.
    chatStream: () => {
      stub.textModeUsed = true;
      throw new Error("memory queries must use the structured path");
    },
    structuredOutputStream: () => {
      stub.calls += 1;
      return structuredStream(final);
    },
    async structuredOutput() {
      stub.calls += 1;
      return final;
    },
  },
  model: "fake-model",
  modelStyle: "openai",
});

const memoryManager = (count) => ({
  async listMemories() {
    return Array.from({ length: count }, (_, i) => ({
      filename: `f${i}.md`,
      name: `n${i}`,
      type: "project",
      description: `d${i}`,
      body: "b",
    }));
  },
  getConsolidateThreshold: () => 3,
  async writeMemory() {},
  async deleteMemory() {},
  async flushIndex() {},
  async getMemoryCount() {
    return count;
  },
});

const MESSAGES = [{ role: "user", content: "please remember that this project uses pnpm workspaces" }];

// ============================================================================
// 1. Extraction is accounted on the owning tracker
// ============================================================================

{
  const usage = new UsageTracker();
  const stub = { calls: 0, textModeUsed: false };

  const written = await extractMemories(
    MESSAGES,
    memoryManager(2),
    adapter({ memories: [{ name: "m1", type: "project", description: "d", body: "b" }] }, stub),
    undefined,
    undefined,
    usage
  );

  assert.equal(written, 1, "the extraction must actually run — an unexercised path proves nothing");
  assert.equal(stub.textModeUsed, false, "the run must stay on the structured path");
  assert.equal(
    usage.getTotal().inputTokens,
    EXPECTED_INPUT,
    "the extraction query's prompt tokens must reach the owning tracker — this is the omitted-argument bug"
  );
  assert.equal(usage.getTotal().outputTokens, EXPECTED_OUTPUT, "and its completion tokens");
}

// ============================================================================
// 2. Consolidation is accounted on the owning tracker
// ============================================================================

{
  const usage = new UsageTracker();
  const stub = { calls: 0, textModeUsed: false };

  const result = await consolidateMemories(
    memoryManager(5),
    adapter({ merged: [], deleted: [] }, stub),
    undefined,
    usage
  );

  assert.equal(typeof result.changed, "boolean", "consolidation must return its real result");
  assert.equal(
    usage.getTotal().inputTokens,
    EXPECTED_INPUT,
    "the consolidation query must reach the owning tracker too, not just extraction"
  );
  assert.equal(usage.getTotal().outputTokens, EXPECTED_OUTPUT, "and its completion tokens");
}

// ============================================================================
// 3. The tracker stays optional (a host without one must not crash)
// ============================================================================

{
  const stub = { calls: 0, textModeUsed: false };
  const written = await extractMemories(MESSAGES, memoryManager(2), adapter({ memories: [] }, stub));
  assert.equal(written, 0, "an empty extraction is not a failure");
  assert.equal(stub.textModeUsed, false, "and the query still ran on the structured path");
  assert.ok(stub.calls >= 1, "the call was made — only the accounting is skipped when no tracker is passed");
}

// ============================================================================
// 4. `MemoryService` forwards the tracker it is given
// ============================================================================
//
// Sections 1-2 pass the tracker straight to the extractor. The live path reaches it
// through `MemoryService.runExtraction`, and that hop is a bare destructure of an
// optional field — exactly the shape that can be silently dropped again. Driven through
// the real service so the plumbing itself is covered, not just the leaf functions.

{
  const usage = new UsageTracker();
  const stub = { calls: 0, textModeUsed: false };
  const service = new MemoryService();
  service.setManager(memoryManager(5));

  // `MIN_MESSAGES_FOR_EXTRACT` is 8, so the run must carry at least that many or the
  // service short-circuits with `skip-short` and never reaches the extractor.
  const messages = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `turn number ${i}`,
  }));

  service.runExtraction({
    getMessagesForLLM: () => messages,
    usage,
    resolveTextAdapter: async () =>
      adapter({ memories: [{ name: "m1", type: "project", description: "d", body: "b" }] }, stub),
  });

  // `runExtraction` is fire-and-forget (it must never block the turn), so wait for the
  // tracker to move rather than for a promise it does not return.
  const deadline = Date.now() + 5000;
  while (usage.getTotal().inputTokens === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }

  assert.equal(stub.calls >= 1, true, "the service must actually run the extraction query");
  assert.equal(
    usage.getTotal().inputTokens,
    EXPECTED_INPUT,
    "MemoryService must forward the tracker into extraction — a dropped field here re-breaks the whole fix"
  );
}

console.log("memory-extraction-usage validation passed");

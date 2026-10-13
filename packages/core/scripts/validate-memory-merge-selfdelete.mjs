/**
 * Regression: consolidation must never delete the entry it just wrote.
 *
 * A merge naturally named after one of its sources (`alpha-note` + `beta-note` →
 * `alpha-note`) lists that source in `replaces`. The delete step consults the
 * PRE-merge snapshot, which still contains the source — so an unguarded delete removes
 * the merged file written moments earlier, and the whole store can end up empty.
 *
 * The apply step is driven through the real `consolidateMemories`, whose deletion
 * decision now skips any filename written in the same pass. The pure decision helper
 * (`applyConsolidationDecisions`) is exercised by that path.
 *
 * Run: node scripts/validate-memory-merge-selfdelete.mjs
 * (also discovered by the `validate-*.mjs` glob in scripts/run-all-validators.mjs)
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";

import { MemoryManager, consolidateMemories, registerCoreEnv } from "../dist/dev.mjs";

const root = await mkdtemp(join(tmpdir(), "codent-memory-merge-selfdelete-"));

// Minimal CoreEnv backed by the real filesystem. `MemoryManager` takes its root from
// config, so each case can use its own subdirectory while sharing one env.
registerCoreEnv({
  rootPath: root,
  path: {
    join: (...p) => join(...p),
    dirname: (p) => dirname(p),
    basename: (p, ext) => (ext ? basename(p, ext) : basename(p)),
    extname: (p) => extname(p),
    resolve: (...p) => resolve(...p),
    normalize: (p) => normalize(p),
    isAbsolute: (p) => isAbsolute(p),
    getSep: () => sep,
    parse: (p) => parse(p),
  },
  getPlatform: async () => "test",
  getArch: async () => "test",
  getEnv: async () => ({}),
  homedir: async () => root,
  byteLength: (s) => Buffer.byteLength(s, "utf-8"),
  fs: {
    readFile: async (p) => {
      const { readFile } = await import("node:fs/promises");
      return readFile(p, "utf-8");
    },
    stat: async (p) => {
      const s = await stat(p);
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
    },
    readdir: async (p) => {
      const names = await readdir(p);
      return names.map((name) => ({ name, type: "file" }));
    },
    writeFile: async (p, content) => writeFile(p, content),
    mkdir: async (p) => {
      await mkdir(p, { recursive: true });
    },
    exists: async (p) => {
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    },
    remove: async (p) => rm(p, { recursive: true, force: true }),
    rename: async (from, to) => {
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    },
    appendFile: async (p, content) => {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(p, content);
    },
  },
});

// A fake adapter whose structured response is the given object — same shape the
// memory LLM-contract validator uses, so this file needs no network.
const usageChunk = (promptTokens, completionTokens) => ({
  type: "RUN_FINISHED",
  usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
});

const completeChunk = (object) => ({
  type: "CUSTOM",
  name: "structured-output.complete",
  value: { object, raw: JSON.stringify(object) },
});

const makeTextAdapterConfig = (object) => ({
  model: "fake-model",
  modelStyle: "openai",
  adapter: {
    kind: "text",
    name: "fake",
    model: "fake-model",
    "~types": {},
    chatStream() {
      return (async function* () {
        yield usageChunk(1, 1);
      })();
    },
    async structuredOutput() {
      throw new Error("not implemented");
    },
    structuredOutputStream() {
      return (async function* () {
        yield completeChunk(object);
        yield usageChunk(10, 5);
      })();
    },
  },
});

// ---------------------------------------------------------------------------
// 1. A merge named after one of its sources must survive its own consolidation
// ---------------------------------------------------------------------------

{
  const caseRoot = join(root, "case-self-delete");
  const manager = new MemoryManager({ rootPath: caseRoot, consolidateThreshold: 2 });
  await manager.initialize();
  await manager.writeMemory("alpha-note", "project", "Alpha", "Alpha body.");
  await manager.writeMemory("beta-note", "project", "Beta", "Beta body.");

  const adapter = makeTextAdapterConfig({
    merged: [
      {
        name: "alpha-note",
        type: "project",
        description: "Alpha and Beta merged",
        body: "Combined body.",
        replaces: ["alpha-note.md", "beta-note.md"],
      },
    ],
    deleted: [],
  });

  const result = await consolidateMemories(manager, adapter);
  assert.equal(result.changed, true, "consolidation reports a change");

  const memories = await manager.listMemories();
  assert.deepEqual(
    memories.map((m) => m.name),
    ["alpha-note"],
    "the merged entry survives even though it is named after a replaced source"
  );

  const surviving = await manager.readMemory("alpha-note.md");
  assert.ok(
    surviving.includes("Combined body."),
    "the surviving file holds the merged body — it was not re-deleted after being written"
  );

  console.log("✓ a merge named after a source survives its own consolidation");
}

// ---------------------------------------------------------------------------
// 2. An unrelated merge still replaces its sources and honors explicit deletes
// ---------------------------------------------------------------------------
//
// The self-delete guard must not disable the deletion step: a merge with a fresh name
// still removes every file it replaces, and an explicit `deleted` entry still goes.

{
  const caseRoot = join(root, "case-unrelated");
  const manager = new MemoryManager({ rootPath: caseRoot, consolidateThreshold: 2 });
  await manager.initialize();
  await manager.writeMemory("gamma-note", "project", "Gamma", "Gamma body.");
  await manager.writeMemory("delta-note", "project", "Delta", "Delta body.");
  await manager.writeMemory("stale-note", "reference", "Stale", "Stale body.");

  const adapter = makeTextAdapterConfig({
    merged: [
      {
        name: "gamma-delta-note",
        type: "project",
        description: "Gamma and Delta merged",
        body: "Combined body.",
        replaces: ["gamma-note.md", "delta-note.md"],
      },
    ],
    deleted: ["stale-note.md"],
  });

  const result = await consolidateMemories(manager, adapter);
  assert.equal(result.changed, true, "consolidation reports a change");

  assert.deepEqual(
    (await manager.listMemories()).map((m) => m.name),
    ["gamma-delta-note"],
    "sources are replaced and the explicit delete runs, while the differently-named merge survives"
  );

  console.log("✓ unrelated merges still delete what they replace");
}

// ---------------------------------------------------------------------------
// 3. A slug-collision merge (name differs from the source's display name) is safe
// ---------------------------------------------------------------------------
//
// `writeMemory` derives the filename from a slug, so the guard must compare against
// the ACTUAL filename written, not the model-supplied `name`.

{
  const caseRoot = join(root, "case-slug");
  const manager = new MemoryManager({ rootPath: caseRoot, consolidateThreshold: 2 });
  await manager.initialize();
  await manager.writeMemory("epsilon-note", "project", "Epsilon", "Epsilon body.");
  await manager.writeMemory("zeta-note", "project", "Zeta", "Zeta body.");

  const adapter = makeTextAdapterConfig({
    merged: [
      {
        // Slugifies to `epsilon-note.md`, the same file named in `replaces`.
        name: "Epsilon Note",
        type: "project",
        description: "Epsilon and Zeta merged",
        body: "Combined body.",
        replaces: ["epsilon-note.md", "zeta-note.md"],
      },
    ],
    deleted: [],
  });

  await consolidateMemories(manager, adapter);

  assert.deepEqual(
    (await manager.listMemories()).map((m) => m.name),
    ["Epsilon Note"],
    "the written slug is the filename the guard protects"
  );

  console.log("✓ a slug-colliding merge survives");
}

await rm(root, { recursive: true, force: true });

console.log("memory-merge-selfdelete validation passed");

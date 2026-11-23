/**
 * Validation for the memory lifecycle with importance + expiresAt.
 *
 * Covers:
 * - writeMemory with importance/expiresAt persists both to frontmatter
 * - listMemories parses importance/expiresAt back
 * - findRelevantMemories filters expired memories out of retrieval
 * - refreshIndex excludes expired memories from MEMORY.md
 * - writeMemory options are backward compatible (no options = plain memory)
 *
 * Run: pnpm --filter @codent/core run validate:memory-lifecycle
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";

import {
  DEFAULT_MAX_SESSION_MEMORY_BYTES,
  MemoryManager,
  MemoryService,
  findRelevantMemories,
  formatRelevantMemories,
  registerCoreEnv,
} from "../dist/dev.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const root = await mkdtemp(join(tmpdir(), "codent-memory-lifecycle-"));

// Minimal CoreEnv backed by the real filesystem, scoped to `root`.
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
    readFile: async (p) => readFile(p, "utf-8"),
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
    remove: async (p) => {
      await rm(p, TEMP_RM_OPTIONS);
    },
  },
  runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  fetch: async () => new Response("", { status: 200 }),
});

// ============================================================================
// 1. writeMemory persists importance/expiresAt to frontmatter
// ============================================================================
const manager = new MemoryManager({ rootPath: root });
await manager.initialize();

const file = await manager.writeMemory(
  "user-prefers-tabs",
  "user",
  "Prefers tabs over spaces",
  "Always use tabs for indentation.",
  { importance: 0.9, expiresAt: "2099-01-01T00:00:00.000Z" }
);
assert.ok(file.endsWith(".md"), "writeMemory returns a .md filename");

const raw = await readFile(join(root, ".agents/memory", file), "utf-8");
assert.match(raw, /importance: 0\.9/, "frontmatter contains importance");
assert.match(raw, /expiresAt: "2099-01-01/, "frontmatter contains expiresAt");

// ============================================================================
// 2. listMemories parses importance/expiresAt back
// ============================================================================
const listed = await manager.listMemories();
assert.equal(listed.length, 1, "exactly one memory after first write");
assert.equal(listed[0].importance, 0.9, "importance parsed from frontmatter");
assert.equal(listed[0].expiresAt, "2099-01-01T00:00:00.000Z", "expiresAt parsed from frontmatter");

// ============================================================================
// 3. Backward compatibility: no options → plain memory (no importance/expiresAt)
// ============================================================================
await manager.writeMemory("user-prefers-spaces", "user", "Prefers spaces", "No strong opinion.");

const compat = await manager.listMemories();
assert.equal(compat.length, 2, "two memories after second write");
const spaces = compat.find((m) => m.name === "user-prefers-spaces");
assert.equal(spaces?.importance, undefined, "no importance when not provided");
assert.equal(spaces?.expiresAt, undefined, "no expiresAt when not provided");

// ============================================================================
// 4. refreshIndex excludes expired memories from MEMORY.md
// ============================================================================
const past = "2000-01-01T00:00:00.000Z";
await manager.writeMemory("expired-note", "reference", "Old note", "Should be hidden.", {
  expiresAt: past,
});
await manager.flushIndex();

const indexContent = manager.getIndexContent();
assert.ok(!indexContent.includes("expired-note"), "expired memory excluded from MEMORY.md index");
assert.ok(indexContent.includes("user-prefers-tabs"), "live memory present in MEMORY.md index");

// ============================================================================
// 5. findRelevantMemories filters expired memories (keyword fallback path)
// ============================================================================
const relevant = await findRelevantMemories("tabs", manager, null, new Set());
const filenames = relevant.map((r) => r.filename);
assert.ok(filenames.includes("user-prefers-tabs.md"), "relevant live memory selected");
assert.ok(!filenames.includes("expired-note.md"), "expired memory never selected");

// ============================================================================
// 6. formatRelevantMemories still produces injectable text
// ============================================================================
const injected = formatRelevantMemories(relevant);
assert.ok(injected.includes("<relevant_memories>"), "injected text wraps in relevant_memories");
assert.ok(injected.includes("user-prefers-tabs"), "injected text contains memory");

// ============================================================================
// 7. The session budget ACCUMULATES (it used to restart from zero every turn)
// ============================================================================
//
// `maxSessionBytes` was passed as a per-CALL ceiling while its name promised a session cap: each turn
// could inject up to it again, and every block stayed on the wire (admitted by hash, superseded not
// replaced). 20 memories × ~4 KB therefore reached ~80 KB of `<relevant_memories>` while the code
// believed it had capped 60 KB.
{
  const body = "tabs setting detail. ".repeat(200);
  for (let i = 0; i < 20; i += 1) {
    await manager.writeMemory(`budget-note-${i}`, "reference", `tabs note ${i}`, body);
  }

  const statuses = [];
  const service = new MemoryService((type, payload) => {
    if (type === "memory:prefetch") statuses.push(payload.status);
  });
  service.setManager(manager);

  let injectedBytes = 0;
  for (let turn = 0; turn < 10; turn += 1) {
    service.clearTurnContext();
    await service.prefetchRelevantMemories({
      // `extractUserQuery` reads ModelMessage shape (`content`), not UIMessage parts.
      messages: [{ role: "user", content: "tabs" }],
      complete: null,
    });
    const content = service.getRelevantContent();
    if (!content) continue;
    injectedBytes += Buffer.byteLength(content, "utf-8");
    service.commitSurfacedMemories();
  }

  assert.ok(
    injectedBytes <= DEFAULT_MAX_SESSION_MEMORY_BYTES,
    `injected bytes stay within the session budget (got ${injectedBytes})`
  );
  // The cap is BINDING: three turns of 5 × ~4 KB fill it, and the fourth retrieves nothing. Under the
  // old per-turn reading the same fixture injected ~80 KB (every turn restarted from zero).
  assert.ok(
    injectedBytes >= DEFAULT_MAX_SESSION_MEMORY_BYTES * 0.8,
    `the budget is actually reached (got ${injectedBytes} of ${DEFAULT_MAX_SESSION_MEMORY_BYTES})`
  );
  assert.ok(
    statuses.filter((status) => status === "selected").length > 0,
    "fixture sanity: turns selected memories before the cap"
  );
  assert.ok(injectedBytes > 0, "fixture sanity: something was injected before the cap");
}

// Cleanup
await rm(root, TEMP_RM_OPTIONS);

console.log("memory-lifecycle validation passed");

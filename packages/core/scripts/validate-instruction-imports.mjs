/**
 * Validates `@` import expansion for instruction files (CLAUDE.md / AGENTS.md).
 *
 * Guards the behaviour that makes explicit composition work, and the guards that
 * keep a recursive reference from running away:
 *
 *   1. `@AGENTS.md` in CLAUDE.md is inlined (the reason this exists at all)
 *   2. references inside fenced blocks / inline code are left literal
 *   3. npm-scoped prose (`@codent/app`) is not treated as a file reference
 *   4. a cycle (a→b→a) is cut, and reported instead of silently dropped
 *   5. depth and byte budgets stop runaway expansion
 *   6. imports cannot escape the workspace root
 *   7. a missing target leaves the text as written + records a notice
 *   8. discovery is first-wins, and the turn-context digest covers imports —
 *      editing an imported file is detected as a change
 *
 * Run: pnpm --filter @codent/core run validate:instruction-imports
 */

import { defaultPath } from "@codent/core";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import {
  MAX_INSTRUCTION_IMPORT_DEPTH,
  expandInstructionImports,
  findCodeRegions,
  loadAgentDoc,
  readInstructionContextState,
  instructionStateChanged,
  loadLatestInstructionContent,
  registerCoreEnv,
} from "../dist/dev.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

// ---------------------------------------------------------------------------
// Disk-backed CoreEnv over a temp workspace
// ---------------------------------------------------------------------------

const ws = mkdtempSync(join(tmpdir(), "instr-imports-"));

/** Compare paths in one canonical form: `source` is pathe-joined (forward slashes) while
 *  native `join()` uses the platform separator, so a raw comparison is Windows-hostile. */
const normPath = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const outside = mkdtempSync(join(tmpdir(), "instr-outside-"));

const hostEnv = {
  rootPath: ws,
  // Synchronous POSIX path helpers, as `resolveCoreEnv` would supply. Passed explicitly because
  // this double is also handed to `loadAgentDoc` directly (bypassing the registry's defaults).
  path: defaultPath,
  getPlatform: async () => "test",
  getArch: async () => "arm64",
  getEnv: async () => ({}),
  homedir: async () => "/home/test",
  fs: {
    readFile: async (p) => (await import("node:fs")).readFileSync(p, "utf-8"),
    stat: async (p) => {
      const s = (await import("node:fs")).statSync(p);
      return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size, mtime: s.mtime };
    },
    readdir: async () => [],
    writeFile: async (p, c) => writeFileSync(p, String(c)),
    mkdir: async (p) => mkdirSync(p, { recursive: true }),
    exists: async (p) => (await import("node:fs")).existsSync(p),
    remove: async (p) => (await import("node:fs")).rmSync(p, TEMP_RM_OPTIONS),
  },
  byteLength: (s) => Buffer.byteLength(s, "utf-8"),
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => ({ ok: true, status: 200 }),
};

registerCoreEnv(hostEnv);

const write = (name, content) => {
  const full = join(ws, name);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
};
const expand = async (content) => expandInstructionImports(content, { baseDir: ws, rootPath: ws, maxBytes: 65536 });

// ---------------------------------------------------------------------------
// 1. The motivating case: CLAUDE.md delegates to AGENTS.md via @
// ---------------------------------------------------------------------------
await (async () => {
  write("AGENTS.md", "# AGENTS.md\n\nARCHITECTURE_MARKER\n");
  const r = await expand("# CLAUDE.md\n\nSee @AGENTS.md for details.\n");

  assert.ok(r.content.includes("ARCHITECTURE_MARKER"), "the referenced file's content is inlined");
  assert.ok(!r.content.includes("See @AGENTS.md"), "the reference itself is replaced");
  assert.ok(r.content.includes("<!-- import: AGENTS.md -->"), "the inlined region is delimited");
  assert.deepEqual(r.notices, [], "a clean import records no notices");

  console.log("✓ an @ referenced instruction file is inlined");
})();

// ---------------------------------------------------------------------------
// 2. Fenced blocks and inline code are not expanded
// ---------------------------------------------------------------------------
await (async () => {
  const r = await expand(
    ["Prose with `@AGENTS.md` inline.", "", "```md", "@AGENTS.md", "```", "", "~~~", "@AGENTS.md", "~~~", ""].join("\n")
  );

  assert.ok(!r.content.includes("ARCHITECTURE_MARKER"), "no reference inside a code region is expanded");
  assert.ok(r.content.includes("`@AGENTS.md`"), "the inline span is left as written");
  assert.equal((r.content.match(/@AGENTS\.md/g) ?? []).length, 3, "all three code-region references survive");

  // A fence must open its own line: an inline run of backticks is not a fence.
  const regions = findCodeRegions("text ```x``` more");
  assert.equal(regions.length, 1, "an inline triple-backtick run is one inline span, not a fence");

  console.log("✓ code regions are left literal");
})();

// ---------------------------------------------------------------------------
// 3. npm-scoped and extensionless tokens are not file references
// ---------------------------------------------------------------------------
await (async () => {
  const r = await expand("@codent/core and @tanstack/ai and @scope and plain @NOTICE stay put.\n");

  assert.equal(r.content, "@codent/core and @tanstack/ai and @scope and plain @NOTICE stay put.\n");
  assert.deepEqual(r.notices, [], "non-file tokens are not even reported");

  console.log("✓ scoped-package prose is not treated as an import");
})();

// ---------------------------------------------------------------------------
// 4. A cycle is cut and reported
// ---------------------------------------------------------------------------
await (async () => {
  write("cyc-a.md", "# A\n\n@cyc-b.md\n");
  write("cyc-b.md", "# B\n\n@cyc-a.md\n");

  const r = await expand("# Root\n\n@cyc-a.md\n");

  assert.ok(r.content.includes("# A"), "first hop expanded");
  assert.ok(r.content.includes("# B"), "second hop expanded");
  assert.equal((r.content.match(/# A\n/g) ?? []).length, 1, "the cycle does not re-expand A");
  assert.ok(r.content.includes("@cyc-a.md"), "the cyclic reference is left as written");
  assert.ok(
    r.notices.some((n) => /circular/i.test(n)),
    `cycle must be reported, got: ${JSON.stringify(r.notices)}`
  );

  console.log("✓ a circular reference is cut and reported");
})();

// ---------------------------------------------------------------------------
// 4b. A file that imports ITSELF is a cycle at the first hop
//
// The root file was not seeded into `visited`, so the first hop re-expanded the whole document
// into itself and only the second hop was reported.
// ---------------------------------------------------------------------------
await (async () => {
  const selfPath = join(ws, "self.md");
  const source = "# Self\n\n@self.md\n";
  write("self.md", source);

  const r = await expandInstructionImports(source, {
    baseDir: ws,
    rootPath: ws,
    sourcePath: selfPath,
    maxBytes: 65536,
  });

  assert.equal((r.content.match(/# Self/g) ?? []).length, 1, "the document is not inlined into itself");
  assert.ok(
    r.notices.some((n) => /circular/i.test(n)),
    `self-import must be reported as circular, got: ${JSON.stringify(r.notices)}`
  );

  console.log("✓ a self-import is cut at the first hop");
})();

// ---------------------------------------------------------------------------
// 5. Depth bound
// ---------------------------------------------------------------------------
await (async () => {
  const depth = MAX_INSTRUCTION_IMPORT_DEPTH + 2;
  for (let i = 0; i < depth; i++) {
    write(`deep-${i}.md`, `# depth ${i}\n\n@deep-${i + 1}.md\n`);
  }
  write(`deep-${depth}.md`, "# TOO_DEEP_MARKER\n");

  const r = await expand("# Root\n\n@deep-0.md\n");

  assert.ok(!r.content.includes("TOO_DEEP_MARKER"), "expansion stops before the depth bound");
  assert.ok(
    r.notices.some((n) => /depth/i.test(n)),
    `depth stop must be reported, got: ${JSON.stringify(r.notices)}`
  );

  console.log("✓ expansion stops at the depth bound and says so");
})();

// ---------------------------------------------------------------------------
// 6. Byte budget bound
// ---------------------------------------------------------------------------
await (async () => {
  // Distinct markers so "which one got inlined" is unambiguous. The budget is
  // checked before reading, so the first import may cross it; the point is that
  // expansion stops afterwards rather than inlining every sibling too.
  write("huge.md", "FIRST_BIG_" + "x".repeat(50_000));
  write("huge2.md", "SECOND_BIG_" + "y".repeat(50_000));
  const r = await expandInstructionImports("# Root\n\n@huge.md\n@huge2.md\n", {
    baseDir: ws,
    rootPath: ws,
    maxBytes: 1000,
  });

  assert.ok(!r.content.includes("SECOND_BIG_"), "an import past the budget is not inlined");
  assert.ok(r.content.includes("@huge2.md"), "the refused reference is left as written");
  assert.ok(
    r.notices.some((n) => /budget/i.test(n)),
    `budget stop must be reported, got: ${JSON.stringify(r.notices)}`
  );

  // At the loader boundary the result is bounded regardless.
  write("BUDGET.md", "# BUDGET.md\n\n@huge.md\n");
  rmSync(join(ws, "CLAUDE.md"), { force: true });
  rmSync(join(ws, "AGENTS.md"), { force: true });
  const bounded = await loadAgentDoc({ rootPath: ws, filenames: ["BUDGET.md"], maxBytes: 1000 });
  assert.ok(
    Buffer.byteLength(bounded.content, "utf-8") <= 1000,
    `loaded content respects the byte budget, got ${Buffer.byteLength(bounded.content, "utf-8")}`
  );

  console.log("✓ expansion stops at the byte budget and says so");
})();

// ---------------------------------------------------------------------------
// 7. Workspace containment, directories, and missing targets
// ---------------------------------------------------------------------------
await (async () => {
  // The escape vector is `../` (a leading `/` is root-relative, not absolute).
  // Point at a file that really exists outside the workspace, so "not inlineable"
  // can only come from the containment guard.
  writeFileSync(join(outside, "secret.md"), "OUTSIDE_MARKER\n");
  const escaped = await expand(`# Root\n\n@../${basename(outside)}/secret.md\n`);
  assert.ok(!escaped.content.includes("OUTSIDE_MARKER"), "an import outside the workspace is refused");
  assert.ok(
    escaped.notices.some((n) => /outside the workspace/i.test(n)),
    `escape must be reported, got: ${JSON.stringify(escaped.notices)}`
  );

  mkdirSync(join(ws, "somedir"), { recursive: true });
  const dir = await expand("# Root\n\n@somedir\n");
  assert.ok(dir.content.includes("@somedir"), "a directory reference is left as written");

  const missing = await expand("# Root\n\n@nope-does-not-exist.md\n");
  assert.ok(missing.content.includes("@nope-does-not-exist.md"), "a missing target is left as written");
  assert.ok(
    missing.notices.some((n) => /not found/i.test(n)),
    `a missing target must be reported, got: ${JSON.stringify(missing.notices)}`
  );
  console.log("✓ escapes, directories, and missing targets are refused and reported");
})();

// ---------------------------------------------------------------------------
// 7a. A leading `/` means project-root-relative (`@/path`), not filesystem-absolute
// ---------------------------------------------------------------------------
await (async () => {
  // This repo's own AGENTS.md references `@/openspec/AGENTS.md`, so the idiom has
  // to resolve rather than be rejected as "outside the workspace root".
  write("nested/ROOTREL.md", "ROOT_RELATIVE_MARKER\n");
  const fromNested = await expandInstructionImports("# Root\n\n@/nested/ROOTREL.md\n", {
    baseDir: join(ws, "nested"),
    rootPath: ws,
  });
  assert.ok(
    fromNested.content.includes("ROOT_RELATIVE_MARKER"),
    "`@/path` resolves against the workspace root, not the including file's directory"
  );
  assert.deepEqual(fromNested.notices, [], "a resolvable root-relative import records no notice");

  const missing = await expandInstructionImports("see @/nope-does-not-exist.md\n", {
    baseDir: ws,
    rootPath: ws,
  });
  assert.ok(
    missing.notices.some((n) => /not found/i.test(n)),
    `a missing root-relative target is reported, got: ${JSON.stringify(missing.notices)}`
  );
  assert.ok(!missing.notices.some((n) => /outside the workspace/i.test(n)), "`@/path` is not mistaken for an escape");

  console.log("✓ a leading `/` resolves against the workspace root");
})();

// ---------------------------------------------------------------------------
// 7b. The byte budget counts bytes, not characters
// ---------------------------------------------------------------------------
await (async () => {
  // A CJK character is 3 bytes and an emoji 4, so slicing at `maxBytes`
  // characters overshoots the budget by up to ~4x. Regression: the real
  // CLAUDE.md+AGENTS.md pair loaded 67583 bytes against a 65536 byte budget.
  const multibyte = "中".repeat(4000) + "\n" + "🚀".repeat(4000);
  write("MULTIBYTE.md", "# MULTIBYTE.md\n\n" + multibyte + "\n");

  const bounded = await loadAgentDoc({ rootPath: ws, filenames: ["MULTIBYTE.md"], maxBytes: 5000 });
  const bytes = Buffer.byteLength(bounded.content, "utf-8");
  assert.ok(bytes <= 5000, `multi-byte content must respect the byte budget, got ${bytes} bytes`);

  // Truncation is reported rather than silent.
  const full = await loadAgentDoc({ rootPath: ws, filenames: ["MULTIBYTE.md"] });
  assert.equal(full.content.length >= bounded.content.length, true, "a larger budget never yields less content");

  console.log("✓ the byte budget counts bytes, not characters");
})();

// ---------------------------------------------------------------------------
// 7b. A file that EXISTS but cannot be READ must not look like "no file"
// ---------------------------------------------------------------------------
//
// The distinction the silent `catch` used to erase. A host whose reads can be refused
// (a client-backed env, a sandbox, a broken mount) would otherwise report "no agent
// documentation file found" for a workspace that plainly has an AGENTS.md, and the
// session would run with no project instructions and nothing said about it.
await (async () => {
  const ws2 = mkdtempSync(join(tmpdir(), "instr-read-error-"));
  writeFileSync(join(ws2, "AGENTS.md"), "# rules\n");

  // Present on disk, but every read is refused — the "client declines" shape.
  const hostile = {
    ...hostEnv,
    rootPath: ws2,
    fs: {
      ...hostEnv.fs,
      exists: async () => true,
      readFile: async () => {
        throw new Error("client refused fs/read_text_file");
      },
    },
  };

  const errors = [];
  const result = await loadAgentDoc({
    rootPath: ws2,
    filenames: ["AGENTS.md"],
    env: hostile,
    onReadError: (p) => errors.push(p),
  });

  assert.equal(result.content, "", "a refused read yields no content (nothing to trust)");
  assert.equal(errors.length, 1, "the refused read is REPORTED, not swallowed");
  assert.ok(errors[0].endsWith("AGENTS.md"), "the report names the file that failed");
  assert.ok(
    Array.isArray(result.readErrors) && result.readErrors.length === 1,
    "the result carries the read failure so a caller can surface it"
  );
  // The NOTICE is what reaches the `session:doc` event and the transcript — the one line a user
  // actually reads. Claiming "no file found" here would undo the whole point of reporting the read
  // failure, because the file plainly exists.
  assert.ok(
    !/No agent documentation file found/.test(result.notice ?? ""),
    `the notice must not blame absence for a refused read, got: ${result.notice}`
  );
  assert.ok(/READ|read/i.test(result.notice ?? ""), `the notice must say the read failed, got: ${result.notice}`);
  console.log("✓ an unreadable instruction file is reported, not mistaken for absent");
})();

// ---------------------------------------------------------------------------
// 8. End-to-end: loadAgentDoc inlines; digest covers imported files
// ---------------------------------------------------------------------------
await (async () => {
  for (const f of ["CLAUDE.md", "AGENTS.md", "AGENTS.override.md"]) {
    rmSync(join(ws, f), { force: true });
  }
  write("CLAUDE.md", "# CLAUDE.md\n\n@AGENTS.md\n");
  write("AGENTS.md", "# AGENTS.md\n\nVERSION_ONE\n");

  const loaded = await loadAgentDoc({ rootPath: ws });
  assert.equal(normPath(loaded.source), normPath(join(ws, "CLAUDE.md")), "CLAUDE.md wins discovery");
  assert.ok(loaded.content.includes("VERSION_ONE"), "loadAgentDoc inlines the referenced AGENTS.md");
  assert.deepEqual(loaded.importNotices, []);

  // Editing the *imported* file must count as a change to the instruction state.
  const before = await readInstructionContextState();
  write("AGENTS.md", "# AGENTS.md\n\nVERSION_TWO\n");
  const after = await readInstructionContextState();
  assert.equal(
    instructionStateChanged(before, after),
    true,
    "editing an @-imported file is detected as an instruction change"
  );

  const latest = await loadLatestInstructionContent();
  assert.ok(latest.primary.content.includes("VERSION_TWO"), "re-injected content carries the import");
  assert.ok(!latest.primary.content.includes("VERSION_ONE"), "stale imported content is gone");

  console.log("✓ loadAgentDoc inlines imports, and the digest covers them");
})();

// ---------------------------------------------------------------------------
// 9. Discovery is first-wins (no implicit AGENTS.md fallback)
// ---------------------------------------------------------------------------
await (async () => {
  const loaded = await loadAgentDoc({ rootPath: ws });
  assert.ok(
    !loaded.content.includes("## Quick Reference") || loaded.content.includes("VERSION_TWO"),
    "only the winning file is loaded"
  );
  assert.equal(normPath(loaded.source), normPath(join(ws, "CLAUDE.md")));

  // With no CLAUDE.md, AGENTS.md is still discovered normally.
  rmSync(join(ws, "CLAUDE.md"), { force: true });
  const fallback = await loadAgentDoc({ rootPath: ws });
  assert.equal(
    normPath(fallback.source),
    normPath(join(ws, "AGENTS.md")),
    "AGENTS.md is used when CLAUDE.md is absent"
  );
  assert.ok(fallback.content.includes("VERSION_TWO"));

  console.log("✓ discovery is first-wins with no implicit fallback");
})();

rmSync(ws, TEMP_RM_OPTIONS);
rmSync(outside, TEMP_RM_OPTIONS);

console.log("instruction-imports validation passed");

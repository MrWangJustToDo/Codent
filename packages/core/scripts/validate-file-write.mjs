/**
 * Validation: `write_file` counts bytes, finds its parent by the host's rules, and replaces atomically.
 *
 * Run: pnpm --filter @codent/core run validate:file-write
 *
 * Three things the tool got wrong in ways nothing else noticed, because `write_file` is only ever
 * driven through an approval prompt and a real filesystem:
 *
 *   - `bytesWritten` was `content.length` — UTF-16 code units — while the field (and its schema) say
 *     "Number of bytes written", so a CJK file reported a third of its size;
 *   - the parent directory was found with `path.lastIndexOf("/")`, which never matches a
 *     Windows-shaped path, so the parent was silently not created there;
 *   - the content was written straight into the destination, so an interrupted write left the file
 *     truncated — `CoreEnvFs.rename` exists for exactly the temp-then-rename shape.
 */

import assert from "node:assert/strict";

import { createWriteFileTool, defaultPath } from "../dist/dev.mjs";

/** An in-memory host that records what the tool did, in order. */
function makeEnv({ path = defaultPath, withRename = true, failRename = false, mode } = {}) {
  const files = new Map();
  const ops = [];
  const fs = {
    exists: async (p) => files.has(p),
    readFile: async (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p);
    },
    writeFile: async (p, content) => {
      ops.push(`write:${p}`);
      files.set(p, content);
    },
    mkdir: async (p) => {
      ops.push(`mkdir:${p}`);
    },
    remove: async (p) => {
      ops.push(`remove:${p}`);
      files.delete(p);
    },
  };
  if (withRename) {
    fs.rename = async (from, to) => {
      ops.push(`rename:${from}->${to}`);
      if (failRename) throw new Error("rename refused");
      const content = files.get(from);
      files.delete(from);
      files.set(to, content);
    };
  }
  if (mode !== undefined) {
    // A host that reports permission bits. The tool must carry them onto the temp file BEFORE the
    // rename, or a replacement silently drops `+x`.
    fs.stat = async (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return { isDirectory: false, isFile: true, size: 0, mtime: new Date(0), mode };
    };
    fs.chmod = async (p, next) => {
      ops.push(`chmod:${p}:${next.toString(8)}`);
    };
  }
  return { env: { rootPath: "/ws", path, fs }, files, ops };
}

// The env travels as the run context: `defineServerTool`'s wrapper builds the tool's `coreEnv` from
// `ctx.context`, so passing it directly would fall back to the ambient registry.
const write = (env, args) =>
  createWriteFileTool().execute(args, { toolCallId: "call-write", context: { coreEnv: env } });

// ============================================================================
// 1. Bytes, not UTF-16 code units
// ============================================================================

{
  const { env, files } = makeEnv();
  const text = "中文"; // 2 code units, 6 UTF-8 bytes
  const result = await write(env, { path: "notes.md", content: text });

  assert.equal(result.bytesWritten, 6, `"${text}" is 6 bytes (${result.bytesWritten} reported)`);
  assert.equal(files.get("notes.md"), text, "the file holds the text itself");
  assert.equal(result.created, true, "a new file reports that it created one");

  const ascii = await write(env, { path: "a.txt", content: "hello" });
  assert.equal(ascii.bytesWritten, 5, "ASCII is unchanged (one byte per character)");
}

// ============================================================================
// 2. The parent comes from the host's path rules, not from a `/` scan
// ============================================================================

{
  // A Windows-shaped host: `dirname` splits on `\`, and the old `lastIndexOf("/")` found nothing.
  const path = { resolve: (p) => p, dirname: (p) => p.replace(/\\[^\\]*$/, "") || "." };
  const { env, ops } = makeEnv({ path });
  await write(env, { path: "src\\nested\\file.ts", content: "x" });

  assert.ok(
    ops.includes("mkdir:src\\nested"),
    `the parent directory is created for a Windows-shaped path (${JSON.stringify(ops)})`
  );
}

{
  // …and a bare filename asks for no directory at all.
  const { env, ops } = makeEnv();
  await write(env, { path: "top.txt", content: "x" });
  assert.deepEqual(
    ops.filter((op) => op.startsWith("mkdir")),
    [],
    `a top-level file creates nothing (${JSON.stringify(ops)})`
  );

  // …unless the caller says not to create directories.
  const { env: noDirs, ops: noDirOps } = makeEnv();
  await write(noDirs, { path: "deep/nested/file.txt", content: "x", createDirectories: false });
  assert.deepEqual(
    noDirOps.filter((op) => op.startsWith("mkdir")),
    [],
    "createDirectories: false is honoured"
  );
}

// ============================================================================
// 3. The destination is replaced, not truncated in place
// ============================================================================

{
  const { env, files, ops } = makeEnv();
  await write(env, { path: "a.ts", content: "first" });
  await write(env, { path: "a.ts", content: "second", overwrite: true });

  assert.equal(files.get("a.ts"), "second", "the replacement landed");
  const finalWrites = ops.filter((op) => op === "write:a.ts");
  assert.deepEqual(finalWrites, [], `the destination is never written directly (${JSON.stringify(ops)})`);
  assert.ok(
    ops.some((op) => op.startsWith("write:a.ts.tmp-") && op.includes("a.ts.tmp-")),
    "…it is written through a temp file first"
  );
  assert.ok(
    ops.some((op) => op.startsWith("rename:a.ts.tmp-") && op.endsWith("->a.ts")),
    "…then renamed into place"
  );
}

{
  // A failed rename leaves no temp file behind, and the failure is not swallowed.
  const { env, files, ops } = makeEnv({ failRename: true });
  await assert.rejects(() => write(env, { path: "a.ts", content: "x" }), /rename refused/);
  assert.ok(
    ops.some((op) => op.startsWith("remove:a.ts.tmp-")),
    `the temp file is cleaned up on failure (${JSON.stringify(ops)})`
  );
  assert.equal(files.has("a.ts"), false, "and the destination was not created by a failed write");
}

{
  // Replacing an existing file preserves its permission bits, on the TEMP file before the rename
  // (never chmod-after-replace: the destination would briefly carry the umask default).
  const { env, files, ops } = makeEnv({ mode: 0o755 });
  await write(env, { path: "a.ts", content: "first" });
  const before = ops.length;
  await write(env, { path: "a.ts", content: "second", overwrite: true });

  const replaceOps = ops.slice(before);
  assert.ok(
    replaceOps.some((op) => op.startsWith("chmod:a.ts.tmp-") && op.endsWith(":755")),
    `the temp file carries the original mode (${JSON.stringify(replaceOps)})`
  );
  const chmodAt = replaceOps.findIndex((op) => op.startsWith("chmod:"));
  const renameAt = replaceOps.findIndex((op) => op.startsWith("rename:"));
  assert.ok(chmodAt >= 0 && renameAt > chmodAt, "chmod runs before the rename");
  assert.equal(files.get("a.ts"), "second");
}

{
  // A host without `rename` writes directly — the fallback every host used before.
  const { env, files } = makeEnv({ withRename: false });
  const result = await write(env, { path: "a.ts", content: "direct" });
  assert.equal(files.get("a.ts"), "direct", "a host without rename still writes the file");
  assert.equal(result.bytesWritten, 6);
}

// ============================================================================
// 4. The overwrite guard is unchanged
// ============================================================================

{
  const { env, files } = makeEnv();
  await write(env, { path: "a.ts", content: "keep me" });
  await assert.rejects(
    () => write(env, { path: "a.ts", content: "clobber" }),
    /File already exists/,
    "an existing file is not replaced without overwrite: true"
  );
  assert.equal(files.get("a.ts"), "keep me", "…and its content is untouched");
}

console.log("file-write validation passed");

/**
 * Crash-safe whole-file write: atomic rename, symlink policy, and the failure fallback.
 *
 * The symlink rules are the load-bearing part. `rename(2)` replaces the destination DIRECTORY
 * ENTRY, so swapping a temp over a symlink destroys the link and leaves its target stale while the
 * tool reports success. The two failure paths must therefore stay distinct:
 *
 * - a lexical CONTAINMENT refusal (workspace root under a symlink) may retry the lexical spelling;
 * - an ordinary write failure (EACCES on the target directory) must NOT, because retrying lexical
 *   would rename over the link.
 *
 * Run: pnpm --filter @codent/core run validate:atomic-write
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { writeFileAtomic } from "../dist/dev.mjs";

// The lexical fallback is gated on core's own containment phrase (the only discriminator from a
// server-mapped `permission_denied`). Pin the phrase to the producer: reword `native-fs.ts` and
// this fails here instead of silently making the symlinked-root fallback dead in production.
const nativeFsSource = readFileSync(new URL("../../node/src/environment/native-fs.ts", import.meta.url), "utf8");
assert.match(
  nativeFsSource,
  /Path traversal blocked/,
  "atomic-write matches this phrase; native-fs must keep raising it"
);

/** In-memory fs with optional behaviour hooks. */
function createFs(options = {}) {
  const files = new Map();
  const calls = { writeFile: [], rename: [], remove: [], chmod: [], ops: [] };
  const fs = {
    async writeFile(path, content) {
      calls.writeFile.push(path);
      calls.ops.push({ op: "write", path });
      const failure = options.writeError?.(path);
      if (failure) throw failure;
      files.set(path, content);
    },
    async rename(from, to) {
      calls.rename.push([from, to]);
      calls.ops.push({ op: "rename", from, to });
      const failure = options.renameError?.(from, to);
      if (failure) throw failure;
      if (!files.has(from)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      const content = files.get(from);
      files.delete(from);
      files.set(to, content);
    },
    async remove(path) {
      calls.remove.push(path);
      calls.ops.push({ op: "remove", path });
      files.delete(path);
    },
    async chmod(path, mode) {
      calls.chmod.push([path, mode]);
      calls.ops.push({ op: "chmod", path, mode });
    },
  };
  if (options.realpath) fs.realpath = async (path) => options.realpath(path);
  return { fs, files, calls };
}

const eacces = () => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
const traversal = () => Object.assign(new Error("Path traversal blocked"), { code: "permission_denied" });

// ============================================================================
// 1. The atomic path swaps the temp into place and leaves no residue
// ============================================================================

{
  const { fs, files, calls } = createFs();
  // Pre-existing destination: the rename must REPLACE it, not append or keep both entries.
  files.set("notes.txt", "old");
  await writeFileAtomic(fs, "notes.txt", "hello");
  assert.equal(files.get("notes.txt"), "hello");
  assert.equal(calls.rename.length, 1);
  assert.equal(calls.rename[0][1], "notes.txt", "rename lands on the destination");
  assert.deepEqual([...files.keys()], ["notes.txt"], "the temp file is gone and no sibling remains");
}

// ============================================================================
// 2. A symlink is followed: the rename targets the real file, not the link
// ============================================================================

{
  const { fs, files, calls } = createFs({
    realpath: (path) => (path === "alias.ts" ? "/workspace/src/real.ts" : path),
  });
  await writeFileAtomic(fs, "alias.ts", "new body");
  assert.equal(files.get("/workspace/src/real.ts"), "new body");
  assert.equal(files.has("alias.ts"), false, "the link path must not receive a regular file");
  assert.equal(calls.rename[0][1], "/workspace/src/real.ts");
}

// A missing/dangling target cannot be resolved; the lexical path is the destination.
{
  const { fs, files } = createFs({
    realpath: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });
  await writeFileAtomic(fs, "new-file.ts", "body");
  assert.equal(files.get("new-file.ts"), "body");
}

// ============================================================================
// 3. Lexical containment refusal retries the lexical spelling
// ============================================================================

{
  const { fs, files, calls } = createFs({
    realpath: () => "/private/tmp/ws/file.ts",
    // The host rejects the real path lexically when the workspace root itself is a symlink.
    renameError: (_from, to) => (to === "/private/tmp/ws/file.ts" ? traversal() : undefined),
  });
  await writeFileAtomic(fs, "/tmp/ws/file.ts", "content");
  assert.equal(files.get("/tmp/ws/file.ts"), "content");
  assert.deepEqual(
    calls.rename.map(([, to]) => to),
    ["/private/tmp/ws/file.ts", "/tmp/ws/file.ts"],
    "one attempt per spelling"
  );
}

// ============================================================================
// 4. An ordinary write failure does NOT fall back to the lexical (link) path
// ============================================================================

{
  const { fs, files, calls } = createFs({
    realpath: () => "/real/target.ts",
    renameError: () => eacces(),
  });
  await assert.rejects(() => writeFileAtomic(fs, "alias.ts", "content", { onError: "throw" }), /EACCES/);
  assert.deepEqual(
    calls.rename.map(([, to]) => to),
    ["/real/target.ts"],
    "retrying the lexical path would rename the temp over the symlink"
  );
  assert.equal(files.has("alias.ts"), false);
  assert.equal(calls.remove.length, 1, "the first attempt's temp file is cleaned up exactly once");
  assert.match(calls.remove[0], /\.tmp-/, "cleanup targets the temp, not the destination or the link");
  assert.equal(
    [...files.keys()].some((key) => key.includes(".tmp-")),
    false,
    "no temp residue"
  );
}

// The server maps a genuine EACCES/EPERM to `permission_denied` too; the message is the only
// discriminator. It must NOT be treated as a containment refusal, or the link gets replaced.
{
  const { fs, files, calls } = createFs({
    realpath: () => "/real/target.ts",
    renameError: () =>
      Object.assign(new Error("EACCES: permission denied, rename '/real/target.ts.tmp-x' -> '/real/target.ts'"), {
        code: "permission_denied",
        path: "/real/target.ts.tmp-x",
      }),
  });
  await assert.rejects(() => writeFileAtomic(fs, "alias.ts", "content", { onError: "throw" }), /EACCES/);
  assert.deepEqual(
    calls.rename.map(([, to]) => to),
    ["/real/target.ts"],
    "a mapped EACCES (permission_denied code, non-containment message) must not retry the link"
  );
  assert.equal(files.has("alias.ts"), false);
}

// ============================================================================
// 5. A failed atomic path degrades to an in-place write (document saves)
// ============================================================================

{
  const { fs, files, calls } = createFs({
    writeError: (path) => (path.includes(".tmp-") ? eacces() : undefined),
  });
  await writeFileAtomic(fs, "models.json", '{"ok":true}');
  assert.equal(files.get("models.json"), '{"ok":true}');
  assert.equal(calls.rename.length, 0, "no rename after the temp write failed");
  assert.equal(
    calls.writeFile.some((path) => path.includes(".tmp-")),
    true,
    "the atomic path really was attempted (a temp write), so this exercises the fallback"
  );
}

// ============================================================================
// 6. A host without rename writes in place
// ============================================================================

{
  const { fs, files } = createFs();
  delete fs.rename;
  await writeFileAtomic(fs, "plain.txt", "x");
  assert.equal(files.get("plain.txt"), "x");
}

// ============================================================================
// 7. The temp file receives the mode BEFORE the rename
// ============================================================================

{
  const { fs, calls } = createFs();
  await writeFileAtomic(fs, "script.sh", "#!/bin/sh\n", { mode: 0o755 });
  const ops = calls.ops.map((entry) => entry.op);
  // Ordered, not just present: `rename(tmp, dst); chmod(tmp, mode)` would move an unmoded file
  // into place (the destination is briefly created with the umask) and then chmod a path that no
  // longer exists.
  assert.deepEqual(ops, ["write", "chmod", "rename"], "mode is applied to the temp BEFORE the rename");
  assert.match(calls.chmod[0][0], /\.tmp-/);
  assert.equal(calls.rename[0][0], calls.chmod[0][0], "the same temp file is renamed");
}

console.log("atomic write validation passed");

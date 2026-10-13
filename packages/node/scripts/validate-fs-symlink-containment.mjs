/**
 * Validates the symlink-containment gate in `createNativeFilesystem`.
 *
 * Why this exists: the workspace confinement was LEXICAL only — `path.resolve` is pure string
 * math, so an in-root symlink whose target lives OUTSIDE the workspace passed the check while the
 * OS followed the link at access time. That escaped confinement for BOTH reads and writes. This
 * pins the fixed contract:
 *
 *   1. a plain `..` / absolute escape is still rejected with `permission_denied`;
 *   2. an in-root symlink pointing outside the root is rejected on read AND write;
 *   3. a write target that does not exist yet is still checked (deepest existing ancestor is
 *      resolved) — including a DANGLING in-root symlink whose out-of-root target is only created by
 *      the write;
 *   4. a legitimate in-root read (real file, or a symlink pointing back inside the root) is NOT
 *      blocked.
 *
 * Also exercises the symlinked-root case implicitly: `os.tmpdir()` is a symlink on some platforms
 * (macOS `/var` -> `/private/var`), so the root itself is realpathed before comparison.
 *
 * Run: node packages/node/scripts/validate-fs-symlink-containment.mjs
 * (Needs a build first — it drives the package's `dist/index.mjs`.)
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile as readFs, rm, symlink, writeFile as writeFs } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createNativeFilesystem } from "../dist/index.mjs";

/** Reported distinctly from a pass — see the `validators-windows` CI job. */
const SKIP_MARKER = "[validator-skip]";

/** Assert an async operation is rejected by the containment gate with `permission_denied`. */
const denied = async (label, operation) => {
  await assert.rejects(operation, (err) => {
    assert.equal(err?.code, "permission_denied", `${label}: expected permission_denied, got ${err?.code}`);
    assert.equal(err?.name, "FileError", `${label}: expected FileError, got ${err?.name}`);
    return true;
  });
  console.log(`ok  ${label} blocked with permission_denied`);
};

const base = await mkdtemp(path.join(os.tmpdir(), "codent-fs-symlink-"));
const root = path.join(base, "root");
const outside = path.join(base, "outside");
console.log(`ok  temp workspace at ${base}`);

try {
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFs(path.join(root, "in-root.txt"), "in-root-content", "utf-8");
  await writeFs(path.join(outside, "secret.txt"), "outside-secret", "utf-8");

  // The lexical gate folds case on a case-insensitive host (Windows, or the default macOS APFS),
  // so a case-only difference from the root is the same place rather than an escape. Forced
  // explicitly on both sides here so the branch is exercisable on any platform.
  {
    const upperRoot = path.join(base, "ROOT", "in-root.txt");

    const { filesystem: strictFs } = createNativeFilesystem(root, { caseInsensitive: false });
    await denied("case-variant root prefix is rejected when folding is off", () => strictFs.readFile(upperRoot));

    const { filesystem: foldedFs } = createNativeFilesystem(root, { caseInsensitive: true });
    // May still fail (ENOENT on this case-sensitive host, where `ROOT/` is a different directory),
    // but it must NOT be the traversal gate rejecting it.
    let gateRejected = false;
    try {
      await foldedFs.readFile(upperRoot);
    } catch (err) {
      gateRejected = err?.code === "permission_denied";
    }
    assert.equal(
      gateRejected,
      false,
      "a case-insensitive host must not reject a case-variant root prefix as a traversal"
    );

    // ...and folding must not widen the gate for something genuinely outside the root.
    await denied("case-insensitive host still blocks a real escape", () =>
      foldedFs.readFile(path.join(base, "OUTSIDE", "secret.txt"))
    );
    console.log("ok  case fold applies only when enabled, and never widens an escape");
  }

  // In-root symlinks that point OUTSIDE the workspace: to an existing file, an existing directory,
  // and a target that does not exist yet (dangling). Creating a FILE symlink needs a privilege that
  // Windows runners may not grant; when it is unavailable the symlink half of the contract cannot
  // be exercised, so report a SKIP (the runner counts it separately) rather than a false pass.
  try {
    await symlink(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));
  } catch (err) {
    await rm(base, { recursive: true, force: true });
    console.log(`${SKIP_MARKER} symlink creation unavailable on ${process.platform} (${err?.code ?? err}) — skipped`);
    process.exit(0);
  }
  await symlink(outside, path.join(root, "escape-dir"));
  await symlink(path.join(outside, "does-not-exist.txt"), path.join(root, "dangling.txt"));

  // A legitimate in-root symlink (points back INSIDE the root) must not be blocked.
  await symlink(path.join(root, "in-root.txt"), path.join(root, "inside-link.txt"));

  const { filesystem } = createNativeFilesystem(root);

  // ---- 4. Legitimate access is unaffected (never a false positive) ----
  assert.equal(await filesystem.readFile("in-root.txt"), "in-root-content", "a plain in-root read works");
  assert.equal(await filesystem.readFile("inside-link.txt"), "in-root-content", "an in-root symlink works");
  assert.equal(
    await filesystem.readFile(path.join(root, "in-root.txt")),
    "in-root-content",
    "an absolute in-root read works"
  );
  console.log("ok  legitimate in-root reads (file + in-root symlink) are allowed");

  // ---- 1. Plain lexical escapes ----
  await denied("plain absolute escape read", () => filesystem.readFile(path.join(outside, "secret.txt")));
  await denied("plain relative `../` escape read", () => filesystem.readFile(path.join("..", "outside", "secret.txt")));

  // ---- 2. Symlink escapes: read + write, file + directory targets ----
  await denied("symlinked-file read", () => filesystem.readFile("escape.txt"));
  await denied("symlinked-file write", () => filesystem.writeFile("escape.txt", "overwritten"));
  await denied("symlinked-dir read", () => filesystem.readFile(path.join("escape-dir", "secret.txt")));
  await denied("symlinked-dir write", () => filesystem.writeFile(path.join("escape-dir", "new.txt"), "created"));

  // ---- 3. A not-yet-existing target through a dangling out-of-root symlink ----
  await denied("dangling-symlink write", () => filesystem.writeFile("dangling.txt", "created-elsewhere"));

  // A genuinely new in-root path is still writable (the deepest-existing-ancestor walk must not
  // over-reject a normal write).
  await filesystem.writeFile(path.join("nested", "fresh.txt"), "fresh-content");
  assert.equal(await readFs(path.join(root, "nested", "fresh.txt"), "utf-8"), "fresh-content");
  console.log("ok  a new in-root write target is still allowed");
} finally {
  await rm(base, { recursive: true, force: true });
}

console.log("fs symlink-containment validation passed");

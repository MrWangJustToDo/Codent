/**
 * Validates workspace-relative path conversion, including Windows roots.
 *
 * Run: node packages/app/test/workspace-path.test.mjs
 *
 * The Windows cases are the reason this exists. The conversion used to assume a
 * `/`-terminated POSIX root, so a `C:\repo` root never matched and the function silently
 * returned the absolute path — a failure that only shows up as a missing git-status entry,
 * and only on Windows.
 */
import { registerCoreEnv } from "@codent/core";
import assert from "node:assert/strict";

import { workspaceRelativePath, joinWorkspacePath } from "../dist/utils/workspace-path.mjs";

// `joinWorkspacePath` reads CoreEnv's path utils from the env it is handed. A stub is enough.
const env = {
  rootPath: "/repo",
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({}),
  homedir: async () => "/home/user",
  fs: {},
  runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => new Response(),
};
registerCoreEnv(env);

// --- Windows roots ----------------------------------------------------------
assert.equal(workspaceRelativePath("C:\\repo", "C:/repo/src/a.ts"), "src/a.ts");
assert.equal(workspaceRelativePath("C:\\repo\\", "C:\\repo\\src\\a.ts"), "src/a.ts");
assert.equal(workspaceRelativePath("C:\\repo", "C:\\repo"), ".");
assert.equal(
  workspaceRelativePath("C:\\repo", "C:\\repo\\a\\b\\c.ts"),
  "a/b/c.ts",
  "a deeper Windows path must be fully relativized"
);

// --- POSIX roots ------------------------------------------------------------
// No trailing slash: the previous implementation required one.
assert.equal(workspaceRelativePath("/repo", "/repo/src/a.ts"), "src/a.ts");
assert.equal(workspaceRelativePath("/repo/", "/repo/src/a.ts"), "src/a.ts");
assert.equal(workspaceRelativePath("/repo", "/repo"), ".");
assert.equal(workspaceRelativePath("/repo/", "/repo/"), ".");

// --- must not over-match ----------------------------------------------------
// A sibling directory sharing a name prefix is not inside the root.
assert.equal(workspaceRelativePath("/repo", "/repo-other/a.ts"), "/repo-other/a.ts");
assert.equal(workspaceRelativePath("C:\\repo", "C:\\repo-other\\a.ts"), "C:\\repo-other\\a.ts");
// A path outside the root is returned as given.
assert.equal(workspaceRelativePath("/repo", "/elsewhere/a.ts"), "/elsewhere/a.ts");

// --- joinWorkspacePath ------------------------------------------------------
// Uses CoreEnv's path utils (POSIX via pathe by default).
assert.equal(joinWorkspacePath(env, "a", "b", "c.ts"), "a/b/c.ts");
assert.equal(joinWorkspacePath(env, "/repo", "src", "a.ts"), "/repo/src/a.ts");

console.log("workspace-path: ok");

/* global process */
/**
 * Validates the WebContainer workspace path resolver.
 *
 * Imports the REAL module. The previous version of this file re-implemented
 * `resolveWorkspacePath` / `toWebContainerSpawnCwd` next to the source, so deleting the traversal
 * check from production left this validator green — it was testing its own copy.
 *
 * Run: pnpm --filter @codent/playground validate:workspace-path
 */
import assert from "node:assert/strict";

import { resolveWorkspacePath, toWebContainerSpawnCwd, toWorkdirPath } from "../src/webcontainer/workspace-path.ts";

// ----------------------------------------------------------------------------
// resolveWorkspacePath: root == "/" keeps absolute paths
// ----------------------------------------------------------------------------
assert.equal(resolveWorkspacePath("/", "src/a.ts"), "/src/a.ts");
assert.equal(resolveWorkspacePath("/", "/src/a.ts"), "/src/a.ts");
assert.equal(resolveWorkspacePath("/", "."), "/");
assert.equal(resolveWorkspacePath("/", "/"), "/");

// ----------------------------------------------------------------------------
// A non-root absolute path is workspace-relative, not filesystem-root absolute
// ----------------------------------------------------------------------------
assert.equal(resolveWorkspacePath("/home/project", "pkg/x"), "/home/project/pkg/x");
assert.equal(resolveWorkspacePath("/home/project", "/home/project/pkg/x"), "/home/project/pkg/x");
assert.equal(resolveWorkspacePath("/home/project", "/pkg/x"), "/home/project/pkg/x");
assert.equal(resolveWorkspacePath("/home/project", "/"), "/home/project");

// ----------------------------------------------------------------------------
// Traversal is blocked (the security property this module exists for)
// ----------------------------------------------------------------------------
assert.throws(() => resolveWorkspacePath("/home/project", "../escape"), /traversal/i);
assert.throws(() => resolveWorkspacePath("/home/project", "pkg/../../escape"), /traversal/i);

// An absolute path outside the root is NOT a traversal error — it is re-rooted, which is the
// documented behaviour that keeps the shell and the file tools in one namespace. (The old copy of
// this validator asserted a throw here, i.e. it tested a contract production never had.)
assert.equal(resolveWorkspacePath("/home/project", "/etc/passwd"), "/home/project/etc/passwd");
// Root is the one workspace whose containment check can never fail on an absolute path.
assert.equal(resolveWorkspacePath("/", "/etc/passwd"), "/etc/passwd");

// Normalization happens before the check, so a lexically-clean escape is still caught.
assert.equal(resolveWorkspacePath("/home/project", "pkg/../other"), "/home/project/other");

// ----------------------------------------------------------------------------
// toWebContainerSpawnCwd (the shell cwd, which must be workdir-relative)
// ----------------------------------------------------------------------------
assert.equal(toWebContainerSpawnCwd("/", undefined), ".");
assert.equal(toWebContainerSpawnCwd("/", "/"), ".");
assert.equal(toWebContainerSpawnCwd("/", "src"), "src");
assert.equal(toWebContainerSpawnCwd("/", "/src/app"), "src/app");
assert.equal(toWebContainerSpawnCwd("/home/workspace", undefined), ".");
assert.equal(toWebContainerSpawnCwd("/home/workspace", "pkg"), "pkg");
assert.equal(toWebContainerSpawnCwd("/home/workspace", "/home/workspace/pkg"), "pkg");
// An absolute path outside the root is re-rooted (same rule as `resolveWorkspacePath`), so the
// spawn cwd stays inside the workspace instead of pointing the shell at the host filesystem.
assert.equal(toWebContainerSpawnCwd("/home/workspace", "/etc"), "etc");

// ----------------------------------------------------------------------------
// toWorkdirPath (the inverse for `wc.fs`, which has no /home/workspace prefix)
// ----------------------------------------------------------------------------
assert.equal(toWorkdirPath("/", "/src/a.ts"), "/src/a.ts");
assert.equal(toWorkdirPath("/home/workspace", "/home/workspace"), "/");
assert.equal(toWorkdirPath("/home/workspace", "/home/workspace/src/a.ts"), "/src/a.ts");
// Not under the root → left as-is (already workdir-relative).
assert.equal(toWorkdirPath("/home/workspace", "/src/a.ts"), "/src/a.ts");

process.stdout.write("validate-workspace-path: ok\n");

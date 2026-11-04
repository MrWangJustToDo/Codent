/**
 * Validate Windows path conversions at the three boundaries that were POSIX-only.
 *
 * These are not Windows-only code paths guarded by an `if (win32)` — they are conversions that
 * must work for *any* input, which means the Windows cases are reachable and testable on
 * Linux. That is the point: a Windows branch nobody can exercise is a branch that rots, and
 * all three of these were written assuming `/`-separated, no-drive-letter paths.
 *
 * Covered:
 * - LSP file-URI round-trip (`agent/lsp/shared/format.ts`) — `file:///C:/x` must not become
 *   `/C:/x`, and converting back must reproduce the URI.
 * - Sandbox deny rules (`@codent/node`) — must resolve `~` rather than emit literal `~/.ssh`.
 *
 * NOT covered here: workspace-relative paths (`@codent/app`). That conversion is asserted in
 * `packages/app/test/workspace-path.test.mjs` instead, because `@codent/app` does not export
 * it from its barrel and reaching into a hashed chunk name from another package's validator
 * would break on any bundler-hash change.
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildOsSandboxConfig } from "../../node/dist/index.mjs";
import {
  clearCoreEnv,
  expandInstructionImports,
  formatAsTree,
  registerCoreEnv,
  walkTree,
  fileUriToPath,
  formatLocation,
  pathToFileUrl,
} from "../dist/dev.mjs";

let failures = 0;
function check(label, fn) {
  try {
    const result = fn();
    // Async cases return a promise; the caller `await`s it so failures settle
    // before the exit check at the bottom of the file.
    if (result instanceof Promise) {
      return result.then(
        () => console.log(`PASS  ${label}`),
        (err) => {
          failures += 1;
          console.log(`FAIL  ${label}`);
          console.log(`      ${err.message.split("\n")[0]}`);
        }
      );
    }
    console.log(`PASS  ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${label}`);
    console.log(`      ${err.message.split("\n")[0]}`);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 5.1 — LSP file URI <-> path
// ---------------------------------------------------------------------------

check("file URI: Windows drive path keeps its drive letter", () => {
  assert.equal(fileUriToPath("file:///C:/dir/file.ts", "C:\\repo"), "C:/dir/file.ts");
});

check("file URI: Windows path under the root becomes relative", () => {
  assert.equal(fileUriToPath("file:///C:/repo/src/a.ts", "C:\\repo"), "src/a.ts");
});

check("file URI: Windows path equal to the root becomes '.'", () => {
  assert.equal(fileUriToPath("file:///C:/repo", "C:\\repo"), ".");
});

check("file URI: POSIX behaviour unchanged", () => {
  assert.equal(fileUriToPath("file:///repo/src/a.ts", "/repo"), "src/a.ts");
  assert.equal(fileUriToPath("file:///repo", "/repo"), ".");
});

check("file URI: traversal outside the root stays relative-first", () => {
  // Not under the root — must not be chopped into a bogus relative path.
  assert.equal(fileUriToPath("file:///elsewhere/a.ts", "/repo"), "/elsewhere/a.ts");
});

check("file URI: round-trips a Windows drive path", () => {
  const uri = "file:///C:/dir/file.ts";
  const back = pathToFileUrl(fileUriToPath(uri, "C:\\repo"));
  assert.equal(back, uri);
});

check("file URI: characters that would change the URL are encoded", () => {
  // The extension loader and the LSP client shared the unencoded spelling: `#` became a fragment
  // and `?` a query, so the loader reported a file that exists as unloadable.
  assert.equal(pathToFileUrl("/tmp/a#b/c?.ts"), "file:///tmp/a%23b/c%3F.ts");
  assert.equal(pathToFileUrl("/tmp/with space.ts"), "file:///tmp/with%20space.ts");
});

check("file URI: round-trips a POSIX path", () => {
  // Round-tripping only holds for paths that stay absolute. A path *under* rootDir is
  // intentionally relativized (`/repo/src/a.ts` -> `src/a.ts`), and a relative path cannot
  // reproduce the original absolute URI — that is inherent to the conversion, not a defect.
  const uri = "file:///elsewhere/a.ts";
  const back = pathToFileUrl(fileUriToPath(uri, "/repo"));
  assert.equal(back, uri);
});

check("file URI: a path under the root is relativized (so it cannot round-trip)", () => {
  assert.equal(fileUriToPath("file:///repo/src/a.ts", "/repo"), "src/a.ts");
});

check("file URI: formatLocation renders a Windows location", () => {
  const out = formatLocation(
    { uri: "file:///C:/repo/src/a.ts", range: { start: { line: 9, character: 4 }, end: { line: 9, character: 6 } } },
    "C:\\repo"
  );
  assert.equal(out, "src/a.ts:10:5");
});

// ---------------------------------------------------------------------------
// 5.3 — sandbox deny rules
// ---------------------------------------------------------------------------

check("sandbox: denyRead resolves the home directory", () => {
  const config = buildOsSandboxConfig("/repo");
  const deny = config.filesystem.denyRead;
  const home = homedir();
  assert.deepEqual(
    deny,
    [".ssh", ".aws", join(".config", "gcloud"), ".gnupg"].map((s) => join(home, s))
  );
});

check("sandbox: no literal tilde survives in denyRead", () => {
  const config = buildOsSandboxConfig("/repo");
  const withTilde = config.filesystem.denyRead.filter((p) => p.includes("~"));
  assert.deepEqual(withTilde, []);
});

check("sandbox: ssh key directory is still denied", () => {
  const config = buildOsSandboxConfig("/repo");
  assert.ok(config.filesystem.denyRead.includes(join(homedir(), ".ssh")));
});

// ---------------------------------------------------------------------------
// instruction files — `@import` containment under win32 path semantics
// ---------------------------------------------------------------------------
// `isInside` used to compare with a hardcoded `/` prefix. Under `node:path` on
// win32, `resolve` returns backslash paths, so the prefix never matched and
// every `@import` was rejected as outside the workspace — silently, in both
// consumers (the doc loader and the turn-context change detector). These cases
// register a stub env whose `path` follows `node:path/win32` so the win32
// behaviour is exercisable on Linux.
//
// The async cases are awaited **sequentially**: each registers its own env and
// clears it in `finally`, so running them concurrently let one case tear down
// another's env mid-flight (and the sync exit-check below would also run
// before any of them settled).

const win32Path = await import("node:path").then((m) => m.win32);
const win32Env = {
  rootPath: "C:\\repo",
  path: {
    join: win32Path.join,
    dirname: win32Path.dirname,
    basename: win32Path.basename,
    resolve: win32Path.resolve,
    isAbsolute: win32Path.isAbsolute,
  },
  fs: {
    exists: async (p) => p === "C:\\repo\\docs\\guide.md",
    stat: async () => ({ isDirectory: false, isFile: true }),
    readFile: async () => "guide content",
  },
  byteLength: (s) => Buffer.byteLength(s, "utf-8"),
};

await check("instruction: win32 @import inside the root is expanded", async () => {
  clearCoreEnv();
  registerCoreEnv(win32Env);
  try {
    const { content, notices } = await expandInstructionImports("see @docs/guide.md here", {
      baseDir: "C:\\repo",
      rootPath: "C:\\repo",
    });
    assert.equal(content.includes("guide content"), true, JSON.stringify({ content, notices }));
    assert.deepEqual(notices, []);
  } finally {
    clearCoreEnv();
  }
});

await check("instruction: win32 @/ root-relative import is expanded", async () => {
  clearCoreEnv();
  registerCoreEnv(win32Env);
  try {
    const { content, notices } = await expandInstructionImports("see @/docs/guide.md here", {
      baseDir: "C:\\repo",
      rootPath: "C:\\repo",
    });
    assert.equal(content.includes("guide content"), true, JSON.stringify({ content, notices }));
    assert.deepEqual(notices, []);
  } finally {
    clearCoreEnv();
  }
});

await check("instruction: win32 import outside the root is still rejected", async () => {
  clearCoreEnv();
  registerCoreEnv(win32Env);
  try {
    const { content, notices } = await expandInstructionImports("see @..\\outside.md here", {
      baseDir: "C:\\repo",
      rootPath: "C:\\repo",
    });
    assert.equal(content.includes("guide content"), false);
    assert.equal(
      notices.some((n) => n.includes("outside the workspace")),
      true,
      JSON.stringify(notices)
    );
  } finally {
    clearCoreEnv();
  }
});

// ---------------------------------------------------------------------------
// tree fallback — formatAsTree with win32-shaped absolute paths
// ---------------------------------------------------------------------------
// `formatAsTree` is exported for this case. The walk is separator-agnostic by
// construction, so the function's prefix-strip cannot be reached through it with
// backslashes — the only way to pin the fix is to call the formatter directly.

await check("tree: formatAsTree strips a win32 root prefix", async () => {
  const tree = formatAsTree(["C:\\repo\\src", "C:\\repo\\src\\a.ts", "C:\\repo\\README.md"], "C:\\repo");
  // The prefix is stripped (no `C:\repo\` survives) and the bare root collapses to
  // the root label. The default formatter prints names indented, not the root name.
  assert.ok(!tree.includes("C:"), `the root prefix leaked into the tree:\n${tree}`);
  assert.equal(tree, ["README.md", "src", "  a.ts"].join("\n"), tree);
});

await check("tree: formatAsTree strips a POSIX root prefix", async () => {
  assert.equal(formatAsTree(["/repo/src", "/repo/src/a.ts"], "/repo"), ["src", "  a.ts"].join("\n"));
  assert.equal(formatAsTree(["/repo"], "/repo"), "/repo", "a bare root renders the root name");
});

// ---------------------------------------------------------------------------
// tree walk — a win32-shaped filesystem is walked correctly
// ---------------------------------------------------------------------------

await check("tree: walkTree walks a win32-shaped fs", async () => {
  clearCoreEnv();
  registerCoreEnv({
    rootPath: "C:\\repo",
    fs: {
      readdir: async (dir) =>
        dir === "C:\\repo" ? [{ name: "src", type: "directory" }] : [{ name: "a.ts", type: "file" }],
    },
  });
  try {
    // The injected join makes the FS lookups win32-shaped. `walkTree`'s return
    // value is root-relative and always "/"-joined (its `relative` build does
    // not use the injected join), so what this pins is that the walk reaches the
    // nested directory on a backslash-flavoured fs and feeds the formatter paths
    // it can render.
    const paths = await walkTree("C:\\repo", {
      maxDepth: 2,
      dirsOnly: false,
      showHidden: false,
      pattern: undefined,
      ignore: [],
      join: (parent, child) => `${parent}\\${child}`,
    });
    assert.deepEqual(paths, ["src", "src/a.ts"]);

    // End to end through the real formatter: `walkTree` hands it root-relative
    // paths, which is the production shape, and they render as a tree.
    assert.equal(formatAsTree(paths, "C:\\repo"), ["src", "  a.ts"].join("\n"));
  } finally {
    clearCoreEnv();
  }
});

if (failures > 0) {
  console.error(`\nvalidate:path-portability FAILED (${failures} case(s))`);
  process.exit(1);
}
console.log("\nvalidate-path-portability: ok");

/**
 * Validates diff-mode tree preprocessing (changed-files-only tree with
 * GitHub-PR-style single-subdirectory chain compression).
 *
 * Run: node packages/app/test/workspace-diff-tree.test.mjs
 */
import assert from "node:assert/strict";

// The tree helpers take the env explicitly; a minimal stub is enough.
const { registerCoreEnv } = await import(new URL("../../core/dist/index.mjs", import.meta.url).href);
const env = { rootPath: "/repo" };
registerCoreEnv(env);

const { buildDiffTreeItems, changedFileJumpTarget, orderedChangedFiles } =
  await import("../dist/utils/workspace-diff-tree.mjs");

const status = (entries) => new Map(entries);

const names = (items) => items.map((i) => `${i.name}${i.type === "directory" ? "/" : ""}@${i.indent}`);

// Single deep chain: first level kept, deeper single-subdir chains merged.
{
  const items = buildDiffTreeItems(env, status([["app/src/utils/generateDir.ts", "M"]]), "/repo", new Set());
  assert.deepEqual(names(items), ["app/@0", "src/utils/@1", "generateDir.ts@2"]);
}

// Several files sharing a directory: no merge, normal nesting.
{
  const items = buildDiffTreeItems(
    env,
    status([
      ["src/a.ts", "M"],
      ["src/b.ts", "??"],
    ]),
    "/repo",
    new Set()
  );
  assert.deepEqual(names(items), ["src/@0", "a.ts@1", "b.ts@1"]);
}

// Mixed: file + subdir inside the same dir prevents merging that chain.
{
  const items = buildDiffTreeItems(
    env,
    status([
      ["src/x.ts", "M"],
      ["src/lib/y.ts", "D"],
    ]),
    "/repo",
    new Set()
  );
  assert.deepEqual(names(items), ["src/@0", "lib/@1", "y.ts@2", "x.ts@1"]);
}

// Top-level files stay at indent 0 (directories sort first).
{
  const items = buildDiffTreeItems(
    env,
    status([
      ["README.md", "M"],
      ["z.md", "??"],
    ]),
    "/repo",
    new Set()
  );
  assert.deepEqual(names(items), ["README.md@0", "z.md@0"]);
}

// Empty / no-root inputs.
{
  assert.deepEqual(buildDiffTreeItems(env, new Map(), "/repo", new Set()), []);
  assert.deepEqual(buildDiffTreeItems(env, status([["a.ts", "M"]]), "", new Set()), []);
}

// Collapsed directories hide their subtree.
{
  const items = buildDiffTreeItems(
    env,
    status([
      ["a/b/c.ts", "M"],
      ["a/b/d.ts", "M"],
      ["e.ts", "M"],
    ]),
    "/repo",
    new Set(["a/b"])
  );
  assert.deepEqual(names(items), ["a/@0", "b/@1", "e.ts@0"]);
}

// Windows-style backslash keys normalize to "/".
{
  const items = buildDiffTreeItems(env, status([["src\\win.ts", "M"]]), "/repo", new Set());
  assert.deepEqual(names(items), ["src/@0", "win.ts@1"]);
}

// A directory-shaped key must not become a row. `git status` without `--untracked-files=all`
// reports an untracked directory as `dir/`; split on "/" that ends in an empty segment, which
// `isLast` classified as a FILE — so the tree rendered a nameless row pointing at the directory
// and none of the files inside it ever appeared. This is the reported symptom.
{
  const items = buildDiffTreeItems(env, status([["brand-new/", "??"]]), "/repo", new Set());
  assert.deepEqual(items, [], "an untracked directory key must produce no row at all");
}

// The same guard for a Windows-style directory key.
{
  const items = buildDiffTreeItems(env, status([["brand-new\\", "??"]]), "/repo", new Set());
  assert.deepEqual(items, []);
}

// The regression proper: with the directory expanded (as `-uall` now does), every file inside
// is its own row — previously none of them were listed.
{
  const items = buildDiffTreeItems(
    env,
    status([
      ["brand-new/sub/deep/file.ts", "??"],
      ["brand-new/top.txt", "??"],
    ]),
    "/repo",
    new Set()
  );
  // Directories sort before files, so `sub/` is emitted before `top.txt`.
  assert.deepEqual(names(items), ["brand-new/@0", "sub/deep/@1", "file.ts@2", "top.txt@1"]);
}

// No row may ever have an empty name — the invariant the reported symptom violated.
{
  const items = buildDiffTreeItems(
    env,
    status([
      ["brand-new/", "??"],
      ["has space.ts", "M"],
      ["a/b.ts", "M"],
    ]),
    "/repo",
    new Set()
  );
  assert.equal(
    items.filter((i) => i.type === "file" && i.name === "").length,
    0,
    "a file row with an empty name is the defect"
  );
}

// Renamed paths (old -> new) render both sides as rows.
{
  const items = buildDiffTreeItems(
    env,
    status([
      ["old/name.ts", "R"],
      ["new/name.ts", "R"],
    ]),
    "/repo",
    new Set()
  );
  assert.deepEqual(names(items), ["new/@0", "name.ts@1", "old/@0", "name.ts@1"]);
}

// orderedChangedFiles: `[` / `]` order must match the rendered tree
// (directories first, case-insensitive) — NOT a plain lexicographic path sort.
{
  const map = status([
    ["src/z.ts", "M"],
    ["src/components/Foo.tsx", "M"],
    ["src/components/bar.tsx", "M"],
    ["src/utils/a.ts", "M"],
    ["README.md", "M"],
  ]);
  const ordered = orderedChangedFiles(env, map, "/repo").map((p) => p.replace("/repo/", ""));
  // dirs first (components, utils), then files; case-insensitive within a dir.
  assert.deepEqual(ordered, [
    "src/components/bar.tsx",
    "src/components/Foo.tsx",
    "src/utils/a.ts",
    "src/z.ts",
    "README.md",
  ]);

  // And it must differ from the old plain-sort behaviour in exactly these cases.
  const plainSorted = [...map.keys()].map((rel) => `/repo/${rel}`).sort();
  assert.notDeepEqual(ordered, plainSorted, "tree order differs from plain path sort");
}

// Same-name file vs directory: directory subtree sorts before the sibling file.
{
  const ordered = orderedChangedFiles(
    env,
    status([
      ["src/foo.ts", "M"],
      ["src/foo/bar.ts", "M"],
      ["src/foo.tsx", "M"],
    ]),
    "/repo"
  ).map((p) => p.replace("/repo/", ""));
  assert.deepEqual(ordered, ["src/foo/bar.ts", "src/foo.ts", "src/foo.tsx"]);
}

// No root / empty map => empty order.
{
  assert.deepEqual(orderedChangedFiles(env, new Map(), "/repo"), []);
  assert.deepEqual(orderedChangedFiles(env, status([["a.ts", "M"]]), ""), []);
}

// ancestorKeys: the chain of rendered directory ROW keys above each row, so a
// consumer can tell whether a file is reachable and which keys hide it.
//
// This is what `[` / `]` uses to expand a hidden jump target, and it cannot be
// re-derived by splitting the file path: the MERGED node's key is the deepest
// real dir of the chain, so `app/src/utils` is ONE key here — `app/src` is not a
// directory row at all.
{
  const items = buildDiffTreeItems(env, status([["app/src/utils/generateDir.ts", "M"]]), "/repo", new Set());
  assert.deepEqual(
    items.map((i) => [i.path.replace("/repo/", ""), i.ancestorKeys]),
    [
      // The first tree level is never merged, so `app` is its own row.
      ["app", []],
      ["app/src/utils", ["app"]],
      // The file's chain is the rows above it — note `app/src` is absent.
      ["app/src/utils/generateDir.ts", ["app", "app/src/utils"]],
    ]
  );

  // Collapsing any key in that chain is exactly what makes the file row
  // disappear — which is why the consumer must expand it before selecting.
  for (const key of ["app", "app/src/utils"]) {
    const collapsed = buildDiffTreeItems(env, status([["app/src/utils/generateDir.ts", "M"]]), "/repo", new Set([key]));
    assert.ok(
      !collapsed.some((i) => i.type === "file"),
      `the file row is indeed hidden once its reported ancestor key "${key}" is collapsed`
    );
  }
}

// Nested: every rendered directory row below the (never-merged) first level
// contributes one key, and keys are FULL paths from the root.
{
  const items = buildDiffTreeItems(env, status([["a/b/c/d/file.ts", "M"]]), "/repo", new Set());
  const file = items.find((i) => i.type === "file");
  assert.deepEqual(
    file?.ancestorKeys,
    ["a", "a/b/c/d"],
    "one key per rendered directory row, keyed as full paths from the root"
  );
  // The point: `a/b` and `a/b/c` are not rows, so splitting the file path would
  // produce keys that hide nothing.
  assert.ok(!file?.ancestorKeys?.includes("a/b"), "the merged interior is not a row");
}

// Workspace `[` / `]` jump: the reveal chain must be reported even while the
// target is HIDDEN.
//
// A collapsed directory removes the target's own row from the tree, so it cannot
// report its own ancestors — a first fix read the chain off the rendered rows and
// was dead code for exactly this case (found nothing, revealed nothing) while
// every pure formatter test still passed. Pin the collapsed case directly.
{
  const map = status([
    ["a/b/c/d/file.ts", "M"],
    ["top.ts", "M"],
  ]);
  const target = "/repo/a/b/c/d/file.ts";
  const first = changedFileJumpTarget(env, map, "/repo", null, 1);
  assert.deepEqual(first, { target, revealKeys: ["a", "a/b/c/d"] });

  // The target row really is gone while collapsed...
  assert.ok(
    !buildDiffTreeItems(env, map, "/repo", new Set(["a"])).some((r) => r.path === target),
    "the target row is hidden while its ancestor is collapsed"
  );
  // ...so a chain read from the rendered rows would be empty (the dead-code
  // variant this exists to prevent)...
  assert.equal(
    buildDiffTreeItems(env, map, "/repo", new Set(["a"])).find((r) => r.path === target),
    undefined,
    "looking the row up in a collapsed tree finds nothing"
  );
  // ...while the real chain is still reported, and expanding it reveals the file.
  assert.deepEqual(
    changedFileJumpTarget(env, map, "/repo", null, 1)?.revealKeys,
    ["a", "a/b/c/d"],
    "the chain is reported even though the row is not in the tree"
  );
  assert.ok(
    buildDiffTreeItems(env, map, "/repo", new Set()).some((r) => r.path === target),
    "expanding every reported key reveals the file"
  );
}

// Walk order, wrap-around, and the no-op cases.
{
  const map = status([
    ["a/b/c/d/file.ts", "M"],
    ["top.ts", "M"],
  ]);
  const target = "/repo/a/b/c/d/file.ts";
  assert.deepEqual(changedFileJumpTarget(env, map, "/repo", target, 1), {
    target: "/repo/top.ts",
    revealKeys: [],
  });
  assert.deepEqual(changedFileJumpTarget(env, map, "/repo", "/repo/top.ts", 1), {
    target,
    revealKeys: ["a", "a/b/c/d"],
  });
  assert.deepEqual(changedFileJumpTarget(env, map, "/repo", target, -1), {
    target: "/repo/top.ts",
    revealKeys: [],
  });
  // Backwards from nothing selected lands on the LAST file, not the first.
  assert.deepEqual(changedFileJumpTarget(env, map, "/repo", null, -1), { target: "/repo/top.ts", revealKeys: [] });

  assert.equal(changedFileJumpTarget(env, new Map(), "/repo", null, 1), null);
  // One changed file: the walk stays put, so it is a no-op rather than a
  // self-selection (which would drop the preview pane's focus).
  const single = status([["only.ts", "M"]]);
  assert.equal(changedFileJumpTarget(env, single, "/repo", "/repo/only.ts", 1), null);
  // A stale selection (path no longer changed) restarts the walk from the top.
  assert.equal(changedFileJumpTarget(env, map, "/repo", "/repo/gone.ts", 1)?.target, target);
}

console.log("workspace-diff-tree validation passed");

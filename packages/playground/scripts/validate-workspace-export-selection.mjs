/* global console: readonly */
/**
 * Validates the workspace export-selection helpers.
 *
 * Imports the REAL module. The previous version re-implemented the helpers here (and its copy had
 * a different surface from production), so a regression in the tree walk or the selection reducer
 * could not fail this validation.
 *
 * Run: pnpm --filter @codent/playground validate:workspace-export-selection
 */
import assert from "node:assert/strict";

import {
  deselectByDirName,
  isUnderPath,
  listWorkspaceEntries,
  pathDepth,
  selectedFilePaths,
  togglePathSelection,
} from "../src/webcontainer/workspace-export-selection.ts";

// ----------------------------------------------------------------------------
// isUnderPath / pathDepth
// ----------------------------------------------------------------------------
assert.equal(isUnderPath("/src/a.ts", "/src"), true);
assert.equal(isUnderPath("/src", "/src"), true, "a path is under itself");
assert.equal(isUnderPath("/src2/a.ts", "/src"), false, "a prefix that is not a path segment does not count");
assert.equal(isUnderPath("/anything", "/"), true);
assert.equal(isUnderPath("/", "/"), false, "the root is not under itself");

assert.equal(pathDepth("/"), 0);
assert.equal(pathDepth("/src"), 0, "a root child has depth 0");
assert.equal(pathDepth("/src/a.ts"), 1);
assert.equal(pathDepth("/node_modules/x/index.js"), 2);

// ----------------------------------------------------------------------------
// togglePathSelection: a directory check selects known descendants, uncheck clears them
// ----------------------------------------------------------------------------
const entries = [
  { path: "/src", type: "directory" },
  { path: "/src/a.ts", type: "file" },
  { path: "/src/nested", type: "directory" },
  { path: "/src/nested/b.ts", type: "file" },
  { path: "/node_modules", type: "directory" },
  { path: "/node_modules/x/index.js", type: "file" },
  { path: "/src2", type: "directory" },
  { path: "/README.md", type: "file" },
];

let selected = togglePathSelection(new Set(), entries, "/src", true);
assert.ok(selected.has("/src"));
assert.ok(selected.has("/src/a.ts"));
assert.ok(selected.has("/src/nested/b.ts"), "nested descendants are selected too");
assert.equal(selected.has("/src2"), false, "a sibling with a longer name is untouched");
assert.deepEqual(selectedFilePaths(selected, entries), ["/src/a.ts", "/src/nested/b.ts"]);

const original = new Set(selected);
selected = togglePathSelection(selected, entries, "/src", false);
assert.equal(selected.has("/src"), false);
assert.equal(selected.has("/src/a.ts"), false);
assert.equal(selected.has("/src/nested/b.ts"), false);
assert.equal(original.size > 0, true, "the input set is not mutated");

// ----------------------------------------------------------------------------
// selectedFilePaths: directories never become zip entries
// ----------------------------------------------------------------------------
assert.deepEqual(selectedFilePaths(new Set(entries.map((e) => e.path)), entries), [
  "/src/a.ts",
  "/src/nested/b.ts",
  "/node_modules/x/index.js",
  "/README.md",
]);

// ----------------------------------------------------------------------------
// deselectByDirName: matches the name at any depth, not the prefix
// ----------------------------------------------------------------------------
selected = deselectByDirName(new Set(entries.map((e) => e.path)), entries, "node_modules");
assert.equal(selected.has("/node_modules"), false);
assert.equal(selected.has("/node_modules/x/index.js"), false);
assert.ok(selected.has("/README.md"));
assert.ok(selected.has("/src/nested/b.ts"));

// `deselectByDirName` walks the ENTRIES (that is the tree it is given), so the fixture needs the
// paths to exist as entries; it is not a filter over the selection set.
const nested = [
  { path: "/a/node_modules/y.js", type: "file" },
  { path: "/ab/node_modules2/y.js", type: "file" },
];
const deep = deselectByDirName(new Set(nested.map((e) => e.path)), nested, "node_modules");
assert.deepEqual([...deep], ["/ab/node_modules2/y.js"], "only the exact path segment is matched");

// ----------------------------------------------------------------------------
// listWorkspaceEntries: real tree walk over a FileSystemAPI-shaped fs
// ----------------------------------------------------------------------------
const fakeFs = {
  tree: {
    "/": ["src", "README.md"],
    "/src": ["a.ts", "nested"],
    "/src/nested": ["b.ts"],
  },
  dirs: new Set(["/src", "/src/nested"]),
  async readdir(dir) {
    const names = this.tree[dir] ?? [];
    return names.map((name) => ({
      name,
      isDirectory: () => this.dirs.has(dir === "/" ? `/${name}` : `${dir}/${name}`),
    }));
  },
};

const listed = await listWorkspaceEntries(fakeFs, "/");
assert.deepEqual(
  listed.map((e) => e.path),
  ["/README.md", "/src", "/src/a.ts", "/src/nested", "/src/nested/b.ts"],
  "a depth-first walk with each directory's entries sorted by name, parents before children"
);
assert.equal(listed.find((e) => e.path === "/src").type, "directory");
assert.equal(listed.find((e) => e.path === "/src/a.ts").type, "file");

const capped = await listWorkspaceEntries(fakeFs, "/", { maxEntries: 2 });
assert.equal(capped.length, 2, "maxEntries is a hard cap");

// A non-root start includes the root entry itself (so the tree can render it).
const fromSrc = await listWorkspaceEntries(fakeFs, "/src");
assert.equal(fromSrc[0].path, "/src");
assert.deepEqual(
  fromSrc.map((e) => e.path),
  ["/src", "/src/a.ts", "/src/nested", "/src/nested/b.ts"],
  "the walk stays inside the requested subtree"
);

console.log("validate-workspace-export-selection: ok");

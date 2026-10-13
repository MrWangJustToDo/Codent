/**
 * Validate the native directory walk used as the `tree` fallback.
 *
 * Why this exists: the argv migration replaced `find <path> -maxdepth <n>` with `walkTree()`,
 * because `-maxdepth` is a GNU extension BSD `find` rejects. That made the *fallback itself* a
 * behaviour with no coverage at all — it is not a search binary, so no shell-ism scan looks at
 * it, and nothing imported it. The previous `tree` fallback was callable only through the tool,
 * so it was only ever exercised by hand on a machine that lacked the `tree` binary.
 *
 * It is also where a subtle regression would be invisible: depth, hidden-file, ignore and
 * pattern filtering are now four conditions inside one recursive walk, and getting any of them
 * wrong yields a plausible-looking tree rather than an error.
 *
 * The walk takes its filesystem and its join function as inputs, so a fake tree can be walked
 * here on any platform — including a Windows-shaped root, which is the case the injected `join`
 * exists for.
 */

import { walkTree } from "../dist/dev.mjs";

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

/** Build a fake CoreEnvFs from a `path -> entries` map. */
function fakeFs(dirs) {
  return {
    readdir: async (dir) => {
      const entries = dirs[dir];
      if (!entries) {
        const err = new Error(`ENOENT: ${dir}`);
        throw err;
      }
      return entries;
    },
  };
}

const enc = (name, type) => ({ name, type });

// A small tree used by most cases:
//   src/            (dir)
//   src/a.ts
//   src/b.js
//   src/nested/     (dir)
//   src/nested/deep.ts
//   src/.hidden.ts
//   .git/           (dir)
//   .git/config
//   node_modules/   (dir)
//   node_modules/pkg.js
const TREE = {
  ".": [enc("src", "directory"), enc(".git", "directory"), enc("node_modules", "directory"), enc("README.md", "file")],
  "./src": [enc("nested", "directory"), enc("a.ts", "file"), enc("b.js", "file"), enc(".hidden.ts", "file")],
  "./src/nested": [enc("deep.ts", "file")],
  "./.git": [enc("config", "file")],
  "./node_modules": [enc("pkg.js", "file")],
};

const walk = (options) =>
  walkTree(".", {
    maxDepth: 10,
    dirsOnly: false,
    showHidden: false,
    pattern: undefined,
    ignore: ["node_modules", ".git"],
    fs: fakeFs(TREE),
    ...options,
  });

// ---------------------------------------------------------------------------
// basic walk + filtering
// ---------------------------------------------------------------------------

const all = await walk({});
check(
  "walks nested directories",
  JSON.stringify(all) ===
    JSON.stringify(["README.md", "src", "src/a.ts", "src/b.js", "src/nested", "src/nested/deep.ts"].sort()),
  JSON.stringify(all)
);

check("hidden entries are excluded by default", !all.some((p) => p.includes(".hidden")), JSON.stringify(all));
check("ignored entries are excluded by name", !all.some((p) => p.startsWith("node_modules")), JSON.stringify(all));
check("a hidden directory is pruned with its subtree", !all.some((p) => p.startsWith(".git")), JSON.stringify(all));

// `-I` semantics: the binary is handed `ignore.join("|")` as ONE pattern, so the walk has to read it
// the same way — a basename glob with `|` separating alternatives. It used to require an exact name,
// so a wildcard pruned nothing here while the binary pruned it: the same call produced two trees.
const globIgnore = await walk({ ignore: ["*.js"] });
check("an ignore glob prunes by basename", !globIgnore.some((p) => p.endsWith(".js")), JSON.stringify(globIgnore));
check("…and leaves everything else", globIgnore.includes("src/a.ts"), JSON.stringify(globIgnore));

const alternation = await walk({ ignore: ["node_modules|README.md"] });
check(
  "`|` separates alternatives, as `tree -I` reads it",
  !alternation.some((p) => p.startsWith("node_modules") || p === "README.md"),
  JSON.stringify(alternation)
);
check("…without over-pruning the rest", alternation.includes("src/b.js"), JSON.stringify(alternation));

const notMatching = await walk({ ignore: ["*.nope"] });
check(
  "an ignore that matches nothing keeps the tree",
  notMatching.includes("src/b.js") && notMatching.includes("README.md"),
  JSON.stringify(notMatching)
);

const hidden = await walk({ showHidden: true });
check("showHidden includes dot entries", hidden.includes("src/.hidden.ts"), JSON.stringify(hidden));
// `.git` is still in this case's `ignore` list, so it stays pruned even with showHidden — the two
// filters are independent.
check("showHidden does not defeat an explicit ignore", !hidden.includes(".git/config"), JSON.stringify(hidden));
const hiddenAll = await walk({ showHidden: true, ignore: [] });
check(
  "showHidden with no ignore list walks dot directories",
  hiddenAll.includes(".git/config"),
  JSON.stringify(hiddenAll)
);

const dirs = await walk({ dirsOnly: true });
check(
  "dirsOnly keeps only directories",
  JSON.stringify(dirs) === JSON.stringify(["src", "src/nested"].sort()),
  JSON.stringify(dirs)
);

// ---------------------------------------------------------------------------
// depth — the `-L <n>` semantic the previous `-maxdepth <n>` got wrong
// ---------------------------------------------------------------------------

const depth1 = await walk({ maxDepth: 1 });
check(
  "maxDepth 1 stops at the root's immediate children",
  JSON.stringify(depth1) === JSON.stringify(["README.md", "src"]),
  JSON.stringify(depth1)
);

const depth2 = await walk({ maxDepth: 2 });
check(
  "maxDepth 2 includes grandchildren but not deeper",
  depth2.includes("src/nested") && !depth2.includes("src/nested/deep.ts"),
  JSON.stringify(depth2)
);

// ---------------------------------------------------------------------------
// pattern — the `tree -P` / `find -name` filter
// ---------------------------------------------------------------------------

// Only entries whose *basename* matches are reported — `src` does not match `*.ts`, which is
// also how `find -name` behaves.
const ts = await walk({ pattern: "*.ts" });
check(
  "pattern '*.ts' matches by basename at every depth",
  JSON.stringify(ts) === JSON.stringify(["src/a.ts", "src/nested/deep.ts"].sort()),
  JSON.stringify(ts)
);

// The bug this file was written to catch: the pattern filter used to `continue` before the
// recursive call, so a directory whose own name did not match was never descended into and
// `*.ts` produced nothing at all. `find -name` descends unconditionally.
check(
  "a pattern that no directory matches still finds files below it",
  ts.includes("src/nested/deep.ts"),
  JSON.stringify(ts)
);

const exact = await walk({ pattern: "a.ts" });
check(
  "a wildcard-free pattern is an exact basename match",
  JSON.stringify(exact) === JSON.stringify(["src/a.ts"]),
  JSON.stringify(exact)
);

// `dirsOnly` is also a report filter, not a pruning one — a file between two directories must
// not hide the deeper directory.
const dirsDeep = await walk({ dirsOnly: true });
check(
  "dirsOnly still descends through files",
  JSON.stringify(dirsDeep) === JSON.stringify(["src", "src/nested"].sort()),
  JSON.stringify(dirsDeep)
);

// ---------------------------------------------------------------------------
// robustness + determinism
// ---------------------------------------------------------------------------

const empty = await walkTree(".", {
  maxDepth: 3,
  dirsOnly: false,
  showHidden: false,
  pattern: undefined,
  ignore: [],
  fs: fakeFs({ ".": [] }),
});
check("an empty directory yields no entries (not an error)", empty.length === 0, JSON.stringify(empty));

const unreadable = await walkTree(".", {
  maxDepth: 3,
  dirsOnly: false,
  showHidden: false,
  pattern: undefined,
  ignore: [],
  // `missing` is absent from the fs map, so readdir throws. A partial tree is more useful than
  // an exception: `find` also warned and continued.
  fs: fakeFs({ ".": [enc("missing", "directory"), enc("ok.ts", "file")] }),
});
check(
  "an unreadable subdirectory is reported but not descended into",
  JSON.stringify(unreadable) === JSON.stringify(["missing", "ok.ts"]),
  JSON.stringify(unreadable)
);

const runA = await walk({});
const runB = await walk({});
check("results are deterministic and sorted", JSON.stringify(runA) === JSON.stringify(runB), JSON.stringify(runA));

// ---------------------------------------------------------------------------
// Windows-shaped root: the emitted paths stay `/`-joined regardless of the input separator,
// because that is what `formatAsTree` splits on and what the tree UI renders.
// ---------------------------------------------------------------------------

const win = await walkTree("C:\\repo", {
  maxDepth: 3,
  dirsOnly: false,
  showHidden: false,
  pattern: undefined,
  ignore: [],
  fs: fakeFs({ "C:\\repo": [enc("src", "directory")], "C:\\repo\\src": [enc("a.ts", "file")] }),
  join: (parent, child) => `${parent.replace(/[/\\]+$/, "")}\\${child}`,
});
check(
  "Windows root walks through the injected separator",
  JSON.stringify(win) === JSON.stringify(["src", "src/a.ts"]),
  JSON.stringify(win)
);

if (failures > 0) {
  console.error(`\nvalidate:tree-walk FAILED (${failures} case(s))`);
  process.exit(1);
}
console.log("\nvalidate-tree-walk: ok");

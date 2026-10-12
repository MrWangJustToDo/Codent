/**
 * Validates quick-open fuzzy matcher scoring/ranking.
 *
 * Run: node packages/app/test/workspace-file-search.test.mjs
 */
import assert from "node:assert/strict";

const { fuzzyFilterFiles, fuzzyMatch } = await import("../dist/utils/workspace-file-search.mjs");

// Subsequence matching + case-insensitivity.
{
  assert.ok(fuzzyMatch("wdt", "src/utils/workspace-diff-tree.ts") !== null);
  assert.ok(fuzzyMatch("WDT", "src/utils/workspace-diff-tree.ts") !== null);
  assert.equal(fuzzyMatch("zzz", "src/utils/workspace-diff-tree.ts"), null);
  assert.equal(fuzzyMatch("util", "src.ts"), null); // out of order / missing
}

// Consecutive runs score higher than scattered matches.
{
  const consecutive = fuzzyMatch("ab", "ab");
  const scattered = fuzzyMatch("ab", "axb");
  assert.ok(consecutive !== null && scattered !== null && consecutive > scattered);
}

// Basename matches score higher than same-length dir-prefix matches.
{
  const dirMatch = fuzzyMatch("util", "utils/a.ts");
  const baseMatch = fuzzyMatch("util", "a/utils.ts");
  assert.ok(dirMatch !== null && baseMatch !== null && baseMatch > dirMatch);
}

// Ranking: boundary matches first, then name order for ties.
{
  const paths = ["src/other/file.ts", "README.md", "src/file-icons.ts"];
  const results = fuzzyFilterFiles("file", paths);
  assert.deepEqual(
    results.map((r) => r.path),
    ["src/file-icons.ts", "src/other/file.ts"]
  );
}

// Empty query returns the leading slice.
{
  const paths = ["a.ts", "b.ts", "c.ts"];
  assert.deepEqual(
    fuzzyFilterFiles("", paths, 2).map((r) => r.path),
    ["a.ts", "b.ts"]
  );
}

// Results expose matched indices (for match highlighting).
{
  const [hit] = fuzzyFilterFiles("wdt", ["src/utils/workspace-diff-tree.ts"]);
  assert.ok(hit !== undefined);
  assert.ok(hit.indices.length === 3);
  const chars = hit.indices.map((i) => hit.path[i]).join("");
  assert.equal(chars.toLowerCase(), "wdt");
}

// ============================================================================
// The file list: real, findable paths
//
// Fetching the list is a different concern from scoring it, and it had the defect the matcher
// tests above cannot see: the list was parsed from line-oriented `git ls-files` output, so a
// path git quotes or octal-escapes was stored as a string that is not the file's path. The
// matcher then scored a query against that string — which is why a non-ASCII file existed but
// could not be found by its own name.
//
// Run against a real throwaway repository so the expected paths are git's actual output.
// ============================================================================
{
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { registerCoreEnv, clearCoreEnv } = await import("../../core/dist/index.mjs");
  const { createNodeEnv } = await import("../../node/dist/index.mjs");
  const { fetchWorkspaceFileList, clearWorkspaceFileListCache } =
    await import("../dist/utils/workspace-file-search.mjs");

  const repo = mkdtempSync(join(tmpdir(), "file-search-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "tracked.ts"), "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  // Untracked: these come from `git ls-files --others`.
  mkdirSync(join(repo, "new dir"), { recursive: true });
  writeFileSync(join(repo, "new dir", "plain.ts"), "x\n");
  writeFileSync(join(repo, "new dir", "has space.ts"), "x\n");
  writeFileSync(join(repo, "new dir", 'quo"te.ts'), "x\n");
  writeFileSync(join(repo, "new dir", "中文.ts"), "x\n");

  // Tracked, with the same shapes, so the `ls-files` branch is covered too.
  mkdirSync(join(repo, "sub"), { recursive: true });
  writeFileSync(join(repo, "sub", "traced space.ts"), "x\n");
  writeFileSync(join(repo, "sub", "跟踪.ts"), "x\n");
  git("add", "sub");
  git("commit", "-q", "-m", "tracked specials");

  // A real CoreEnv, not a stub: this asserts on git's actual bytes, so the runner must be one
  // that really executes git. `@codent/node` is a workspace sibling, so no install is needed.
  const env = createNodeEnv({ rootPath: repo });
  registerCoreEnv(env);
  clearWorkspaceFileListCache();
  const files = await fetchWorkspaceFileList(env, repo);
  clearCoreEnv();

  for (const expected of [
    "tracked.ts",
    "new dir/plain.ts",
    "new dir/has space.ts",
    'new dir/quo"te.ts',
    "new dir/中文.ts",
    "sub/traced space.ts",
    "sub/跟踪.ts",
  ]) {
    assert.ok(files.includes(expected), `the list must contain the real path ${JSON.stringify(expected)}`);
  }

  // A leading quote is the signature of a line-oriented parse. Worse than cosmetic: it made the
  // path a different string, and the escaped interior produced a bogus directory level.
  assert.equal(files.filter((f) => f.startsWith('"') || f.endsWith('"')).length, 0, "no path may carry git's quoting");

  // `\344\270\255` is how git writes U+4E2D. Leaving those digits in the path means the file is
  // present but under a name nothing can match.
  assert.equal(files.filter((f) => /\\\d{3}/.test(f)).length, 0, "no path may carry git's octal escaping");

  // The escaped text must not invent an intermediate directory — the old parse turned
  // `"new dir/quo\"te.ts"` into `"new dir/quo/` plus `"te.ts"`.
  assert.equal(files.filter((f) => f.includes("quo/")).length, 0);

  // The user-visible assertion, and the one that names the symptom: a file must be findable by
  // its own characters. This is what failed before the fix — the file existed but no query
  // could reach it.
  for (const [query, expected] of [
    ["中文", "new dir/中文.ts"],
    ["跟踪", "sub/跟踪.ts"],
    ['quo"te', 'new dir/quo"te.ts'],
    ["has space", "new dir/has space.ts"],
    ["plain", "new dir/plain.ts"],
  ]) {
    const hits = fuzzyFilterFiles(query, files);
    assert.ok(
      hits.some((h) => h.path === expected),
      `a query of ${JSON.stringify(query)} must find ${JSON.stringify(expected)} — otherwise the file exists but cannot be opened`
    );
  }
}

console.log("workspace-file-search validation passed");

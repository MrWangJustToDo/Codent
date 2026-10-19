/**
 * Pins the git *commands* the diff view issues, not just the parsers.
 *
 * The parsers can only be as correct as the output they are handed. A parse that reads NUL
 * records is right, but if the query stops asking for `-z` the payload is line-oriented and
 * quoted, and if it stops asking for `--untracked-files=all` git reports one record for a
 * whole untracked directory — the nameless row, arriving by a route no parse test can see.
 *
 * Sabotage caught this: reverting the query flags left every parse test green, because the
 * tests fed the parser NUL input directly. These cases record the command instead.
 *
 * Run: node packages/app/test/workspace-git-commands.test.mjs
 */
import assert from "node:assert/strict";

const { registerCoreEnv } = await import(new URL("../../core/dist/index.mjs", import.meta.url).href);
const { clearGitStatusCache, fetchGitStatusSnapshot } = await import("../dist/utils/workspace-git-status.mjs");
const { clearWorkspaceDiffStatsCache, fetchWorkspaceDiffStats } =
  await import("../dist/utils/workspace-diff-stats.mjs");

const NUL = "\0";
const commands = [];

// Minimal CoreEnv: record the command, return whatever payload the case wants.
const payload = { stdout: "" };
const env = {
  rootPath: "/repo",
  runCommand: async (cmd) => {
    commands.push(cmd);
    return { stdout: payload.stdout, stderr: "", exitCode: 0 };
  },
  fs: { readFile: async () => "" },
};
registerCoreEnv(env);

// ============================================================================
// The status query
// ============================================================================

{
  commands.length = 0;
  payload.stdout = ` M src/a.ts${NUL}`;
  clearGitStatusCache();
  const { status } = await fetchGitStatusSnapshot(env, "/repo");

  const cmd = commands[0];
  assert.match(cmd, /git status/, "the status query");
  assert.match(
    cmd,
    /(^|\s)-z(\s|$)/,
    "must ask for NUL-delimited output: line-oriented output quotes and octal-escapes paths, which is exactly the defect"
  );
  assert.match(
    cmd,
    /--untracked-files=all|(^|\s)-uall(\s|$)/,
    "must expand untracked directories: without it git reports the directory itself, producing the nameless row"
  );
  assert.equal(status.get("src/a.ts"), "M", "and the NUL payload is what actually gets parsed");
}

// ============================================================================
// The numstat query
// ============================================================================

{
  commands.length = 0;
  payload.stdout = `2\t1\tsrc/a.ts${NUL}`;
  clearWorkspaceDiffStatsCache();
  const stats = await fetchWorkspaceDiffStats(env, "/repo", []);
  const cmd = commands.find((c) => c.includes("numstat") || c.includes("diff"));

  assert.ok(cmd, "a numstat query is issued");
  assert.match(
    cmd,
    /(^|\s)-z(\s|$)/,
    "numstat must be NUL-delimited too, or a quoted path yields a stat key that matches no row"
  );
  assert.deepEqual(stats.files.get("src/a.ts"), { added: 2, deleted: 1 });
}

console.log("workspace-git-commands validation passed");

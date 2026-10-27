/**
 * Search tools must ask the WORKSPACE what it excludes, not carry their own list.
 *
 * The regression this guards: `grep`/`glob` used to run their engines with `--no-ignore`, so the
 * only protection was a six-name directory list in the tool. A repo-wide search therefore walked
 * this workspace's `.agents/` directory — 524 MB of session logs — at 12.6 s for an answer
 * `git grep` produces in 57 ms, and returned session-log paths as "matches" (17% of the rows in
 * the turn that surfaced it).
 *
 * What is asserted here, against a REAL temp git repository:
 *  1. A default search honours `.gitignore` (ignored trees are not searched) and still finds
 *     untracked files, so "ignored" never means "invisible".
 *  2. The runtime data directory (`.agents/`) is excluded even with no git in sight — it is
 *     derived from `AGENT_DATA_DIR`, not from anyone's ignore file.
 *  3. An EXPLICIT target reopens a tree the rules would skip (`path: ".agents/sessions"`,
 *     `path: "generated"`), because ignoring is a default rather than a cage.
 *  4. `glob` shares the same policy, so the two tools cannot disagree about what a workspace is.
 *  5. The engine ladder stays honest: `--no-config` always, `--no-ignore` only for an explicit
 *     ignored target, and `git grep` (not `grep -r`) answers when ripgrep is absent.
 *
 * Run: pnpm --filter @codent/core run validate:search-ignore-policy
 */

import assert from "node:assert/strict";
import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { clearCoreEnv, createGlobTool, createGrepTool, registerCoreEnv } from "../dist/dev.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

// ============================================================================
// Fixture: a real git repository (the ignore rules are git's, so git must exist)
// ============================================================================

if (!nodeExecFile) {
  console.log("[validator-skip] child_process unavailable");
  process.exit(0);
}

const gitAvailable = await new Promise((resolve) => {
  nodeExecFile("git", ["--version"], (err) => resolve(!err));
});
if (!gitAvailable) {
  console.log("[validator-skip] git is not installed; the ignore policy is defined in terms of it");
  process.exit(0);
}

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "search-policy-"));
const toAbs = (p) => (path.isAbsolute(p) ? p : path.join(rootPath, p));

function write(rel, content) {
  const abs = toAbs(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function git(args) {
  return new Promise((resolve, reject) => {
    nodeExecFile("git", args, { cwd: rootPath }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args.join(" ")}: ${stderr || err.message}`)) : resolve(stdout)
    );
  });
}

write(".gitignore", ".agents/\ngenerated/\nnode_modules/\n");
write("src/app.ts", "export const a = 1; // needle\n");
write("src/untracked.ts", "export const b = 2; // needle\n");
write(".agents/sessions/s1.session.jsonl", '{"needle":"session log"}\n');
write("generated/out.ts", "export const c = 3; // needle\n");
write("node_modules/pkg/index.js", "// needle in a dependency\n");
write("dist/bundle.js", "// needle in a build output\n");

await git(["init", "-q"]);
await git(["-c", "user.email=v@example.com", "-c", "user.name=v", "add", ".gitignore", "src/app.ts"]);
await git(["-c", "user.email=v@example.com", "-c", "user.name=v", "commit", "-q", "-m", "fixture"]);

// ============================================================================
// CoreEnv: real filesystem + real argv execution, with ripgrep made ABSENT
// ============================================================================

/**
 * A machine without ripgrep, which is the case the ladder has to survive: `rg` reports ENOENT
 * (the way `node:child_process` reports it), everything else spawns for real.
 */
function makeEnv({ captureRgArgs, root = rootPath } = {}) {
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(root, p));
  return {
    rootPath: root,
    getPlatform: async () => "linux",
    getArch: async () => "x64",
    getEnv: async () => ({}),
    homedir: async () => rootPath,
    fs: {
      readFile: async (p, encoding) => fs.promises.readFile(abs(p), encoding),
      writeFile: async (p, content) => fs.promises.writeFile(abs(p), content),
      mkdir: async (p) => fs.promises.mkdir(abs(p), { recursive: true }),
      exists: async (p) =>
        fs.promises.access(abs(p)).then(
          () => true,
          () => false
        ),
      readdir: async (p) =>
        fs.promises
          .readdir(abs(p), { withFileTypes: true })
          .then((entries) =>
            entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }))
          )
          .catch(() => []),
      stat: async (p) => {
        const stat = await fs.promises.stat(abs(p));
        return { isDirectory: stat.isDirectory(), isFile: stat.isFile(), size: stat.size, mtime: stat.mtime };
      },
      realpath: async (p) => fs.promises.realpath(abs(p)),
      remove: async (p) => fs.promises.rm(abs(p), TEMP_RM_OPTIONS),
    },
    runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    fetch: async () => new Response(),
    commandExists: async (command) => command !== "rg",
    execFile: async (file, args, options) => {
      if (file === "rg") {
        if (captureRgArgs) {
          captureRgArgs(args);
          // A canned match keeps the assertion about ARGS, not about a real search.
          return { stdout: `src/app.ts\0${1}:needle\n`, stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "spawn rg ENOENT", code: null, missing: true };
      }
      return new Promise((resolve) => {
        nodeExecFile(
          file,
          args,
          { cwd: options?.cwd ?? rootPath, timeout: options?.timeout ?? 30_000, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const missing = Boolean(err && (err.code === "ENOENT" || /ENOENT/.test(err.message ?? "")));
            resolve({
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
              missing,
            });
          }
        );
      });
    },
  };
}

const grep = createGrepTool();
const glob = createGlobTool();
const runGrep = (input) => grep.execute(input, { toolCallId: "t-grep" });
const runGlob = (input) => glob.execute(input, { toolCallId: "t-glob" });

const files = (result) => [...new Set(result.matches.map((match) => match.file))].sort();

clearCoreEnv();
registerCoreEnv(makeEnv());

// ============================================================================
// 1. Default search: .gitignore decides, untracked files still count
// ============================================================================

{
  const result = await runGrep({ pattern: "needle", outputMode: "files_with_matches" });
  const found = files(result);
  assert.deepEqual(
    found,
    ["src/app.ts", "src/untracked.ts"],
    `a default search honours .gitignore and still finds untracked files (got ${JSON.stringify(found)})`
  );
  for (const skipped of [".agents/", "generated/", "node_modules/", "dist/"]) {
    assert.ok(
      !found.some((file) => file.startsWith(skipped)),
      `${skipped} must not be searched by default (got ${JSON.stringify(found)})`
    );
  }
}

// ============================================================================
// 2. The runtime data directory is excluded even without git
// ============================================================================

{
  const nonGitRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "search-policy-nogit-"));
  for (const [rel, content] of [
    [".agents/sessions/s1.session.jsonl", '{"needle":"session log"}\n'],
    ["node_modules/pkg/index.js", "// needle in a dependency\n"],
    ["generated/out.ts", "// needle\n"],
    ["src/app.ts", "// needle\n"],
  ]) {
    const abs = path.join(nonGitRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  clearCoreEnv();
  registerCoreEnv(makeEnv({ root: nonGitRoot }));
  const result = await runGrep({ pattern: "needle", outputMode: "files_with_matches" });
  const found = files(result);
  assert.ok(!found.some((file) => file.startsWith(".agents/")), "the runtime data dir is excluded without git");
  assert.ok(!found.some((file) => file.startsWith("node_modules/")), "dependency trees are excluded without git");
  assert.ok(
    found.some((file) => file === "generated/out.ts"),
    `without a repository there are no ignore rules, so a plain directory is searched (got ${JSON.stringify(found)})`
  );
  await fs.promises.rm(nonGitRoot, TEMP_RM_OPTIONS);
  clearCoreEnv();
  registerCoreEnv(makeEnv());
}

// ============================================================================
// 3. An explicit target reopens what the rules would skip
// ============================================================================

{
  const runtime = await runGrep({
    pattern: "needle",
    path: ".agents/sessions",
    outputMode: "files_with_matches",
  });
  assert.deepEqual(files(runtime), [".agents/sessions/s1.session.jsonl"], "an explicit runtime path is searched");

  const generated = await runGrep({
    pattern: "needle",
    path: "generated",
    outputMode: "files_with_matches",
  });
  assert.deepEqual(
    files(generated),
    ["generated/out.ts"],
    "a .gitignore'd directory is searched when the caller names it (git check-ignore decides)"
  );

  const narrowed = await runGrep({ pattern: "needle", path: "src", outputMode: "files_with_matches" });
  assert.deepEqual(files(narrowed), ["src/app.ts", "src/untracked.ts"], "a plain narrowed search keeps the policy");
}

// ============================================================================
// 4. glob shares the policy
// ============================================================================

{
  const result = await runGlob({ pattern: "**/*.ts" });
  assert.deepEqual(result.files.slice().sort(), ["src/app.ts", "src/untracked.ts"], "glob honours .gitignore too");
}

// ============================================================================
// 5. Engine arguments: --no-config always, --no-ignore only on request
// ============================================================================

{
  const seen = [];
  clearCoreEnv();
  registerCoreEnv(makeEnv({ captureRgArgs: (args) => seen.push(args) }));

  await runGrep({ pattern: "needle" });
  const defaultArgs = seen.at(-1);
  assert.ok(defaultArgs.includes("--no-config"), "ambient ripgrep config must not change the tool contract");
  assert.ok(!defaultArgs.includes("--no-ignore"), "a default search must respect the ignore rules");
  assert.ok(defaultArgs.includes("--hidden"), "hidden files stay visible — hidden is not ignored");
  assert.ok(
    defaultArgs.some((arg) => arg.includes(".agents")),
    "the runtime data directory is excluded by the policy"
  );

  await runGrep({ pattern: "needle", path: ".agents/sessions" });
  const explicitArgs = seen.at(-1);
  assert.ok(explicitArgs.includes("--no-ignore"), "an explicit ignored target drops the ignore rules");
  assert.ok(
    !explicitArgs.some((arg) => arg.includes("!.agents")),
    "…and the policy stops excluding the tree the caller asked for"
  );
}

// ============================================================================
// 6. The ladder reaches git grep when ripgrep is absent
// ============================================================================

{
  const seen = [];
  clearCoreEnv();
  registerCoreEnv({
    ...makeEnv(),
    execFile: async (file, args, options) => {
      if (file === "rg") return { stdout: "", stderr: "spawn rg ENOENT", code: null, missing: true };
      seen.push(file);
      return new Promise((resolve) => {
        nodeExecFile(file, args, { cwd: options?.cwd ?? rootPath, timeout: 30_000 }, (err, stdout, stderr) => {
          const missing = Boolean(err && (err.code === "ENOENT" || /ENOENT/.test(err.message ?? "")));
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
            missing,
          });
        });
      });
    },
  });

  const result = await runGrep({ pattern: "needle", outputMode: "files_with_matches" });
  assert.deepEqual(files(result), ["src/app.ts", "src/untracked.ts"], "git grep answers without ripgrep");
  assert.ok(seen.includes("git"), `the git rung ran (engines: ${JSON.stringify([...new Set(seen)])})`);
  assert.ok(
    !seen.includes("grep"),
    `grep -r must not be reached while a repository can answer (engines: ${JSON.stringify([...new Set(seen)])})`
  );
}

// ============================================================================
// Cleanup
// ============================================================================

clearCoreEnv();
await fs.promises.rm(rootPath, TEMP_RM_OPTIONS);
console.log("search ignore policy validation passed");

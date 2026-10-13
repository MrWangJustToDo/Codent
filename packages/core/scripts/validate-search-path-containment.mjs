/**
 * Validate that the search tools cannot read outside the workspace, and that their search is
 * anchored to the workspace root rather than the process cwd.
 *
 * Why this exists: `glob` / `grep` / `tree` spawn external binaries (`fd`/`find`, `rg`/`grep`,
 * `tree`) that read the filesystem directly, so they bypass `CoreEnv.fs` and its traversal
 * guard (`resolvePath` in the Node adapter). Two failures followed from that:
 *
 *   1. `grep { path: "../../.." }` or an absolute path outside the root read outside the
 *      workspace with no approval — these are auto-approved read-only tools.
 *   2. The default `path: "."` resolved against the child's cwd (the host process cwd), so on a
 *      host whose cwd differs from the workspace root (server `ROOT_PATH`, `codent acp --cwd`,
 *      a remote env) it searched the wrong tree.
 *
 * The fix has two parts, both asserted here: a shared resolver rejects escapes
 * (`resolveSearchPath`, throwing the fs layer's own `FileError` `permission_denied`), and every
 * spawn receives `cwd: coreEnv.rootPath` so the caller's relative path still resolves inside
 * the workspace.
 *
 * This runs on any machine: the tools are exercised with a stubbed CoreEnv whose `execFile`
 * records the `{ cwd }` it received and returns canned stdout — so containment and cwd wiring
 * are proven without spawning anything.
 */

import { canExecArgs, createGlobTool, createGrepTool, createTreeTool, execArgsCapture } from "../dist/dev.mjs";

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

const json = (value) => JSON.stringify(value);

/**
 * A CoreEnv whose `execFile` records the call it received and returns canned stdout for the
 * search binaries. `records` collects `{ file, args, cwd }` so a test can assert both the
 * arguments and — the point of this validator — the `cwd` the tools passed.
 */
function makeEnv(records) {
  return {
    rootPath: "/repo",
    getPlatform: async () => "linux",
    getArch: async () => "x64",
    getEnv: async () => ({}),
    homedir: async () => "/home/user",
    fs: {
      // `grep` stats the search path to decide file-vs-directory; a directory is fine.
      stat: async () => ({ isDirectory: true, isFile: false, size: 1, mtime: new Date() }),
    },
    runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    fetch: async () => new Response(),
    execFile: async (file, args, options) => {
      records.push({ file, args, cwd: options?.cwd });
      if (file === "fd" || file === "fdfind") return { stdout: "src/a.ts\n", stderr: "", code: 0 };
      if (file === "rg") return { stdout: "src/a.ts:1:const x = 1;\n", stderr: "", code: 0 };
      if (file === "tree") return { stdout: "src\n  a.ts\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
  };
}

/** A host without argument-vector execution (an old remote server) — the legacy shell path. */
function makeLegacyEnv(commands) {
  const env = makeEnv([]);
  delete env.execFile;
  env.runCommand = async (command, options) => {
    commands.push({ command, cwd: options?.cwd });
    return { stdout: "src/a.ts\n", stderr: "", exitCode: 0, durationMs: 0 };
  };
  return env;
}

/** Call a tool through the real `defineServerTool` wrapper with an explicit run env. */
function run(tool, input, env) {
  return tool.execute(input, { toolCallId: "t", context: { coreEnv: env } });
}

/** Assert a call rejects with the fs layer's traversal error and never reaches the binary. */
async function expectRejected(label, promiseFactory, records) {
  try {
    await promiseFactory();
    check(label, false, "expected a rejection, got a result");
    return;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    check(
      label,
      err?.code === "permission_denied" && /Path traversal blocked/.test(message),
      `code=${json(err?.code)} message=${json(message)}`
    );
    check(`${label} (does not spawn a binary)`, records.length === 0, `records=${json(records)}`);
  }
}

// ============================================================================
// Default search is anchored to the workspace root, not the process cwd
// ============================================================================

// A root that is deliberately not the real process cwd, so `cwd === "/repo"` cannot be
// satisfied by accident.
check("the stub root differs from process.cwd()", process.cwd() !== "/repo");

{
  const records = [];
  const env = makeEnv(records);
  await run(createGlobTool(), { pattern: "**/*.ts" }, env);
  check(
    "glob: default path spawns with cwd = workspace root",
    records.length > 0 && records.every((r) => r.cwd === "/repo"),
    `records=${json(records)}`
  );
  check(
    'glob: default path keeps the search argument as "." (root-relative output)',
    records[0]?.args?.includes("."),
    `args=${json(records[0]?.args)}`
  );
}

{
  const records = [];
  const env = makeEnv(records);
  await run(createGrepTool(), { pattern: "const x" }, env);
  check(
    "grep: default path spawns with cwd = workspace root",
    records.length > 0 && records.every((r) => r.cwd === "/repo"),
    `records=${json(records)}`
  );
  check(
    'grep: default path keeps the search argument as "."',
    records[0]?.args?.includes("."),
    `args=${json(records[0]?.args)}`
  );
}

{
  const records = [];
  const env = makeEnv(records);
  await run(createTreeTool(), {}, env);
  check(
    "tree: default path spawns with cwd = workspace root",
    records.length > 0 && records.every((r) => r.cwd === "/repo"),
    `records=${json(records)}`
  );
  check(
    'tree: default path keeps the search argument as "."',
    records[0]?.args?.[0] === ".",
    `args=${json(records[0]?.args)}`
  );
}

// ============================================================================
// An in-root path reaches the binary with cwd = workspace root, kept as given
// ============================================================================

{
  const records = [];
  const env = makeEnv(records);
  await run(createGlobTool(), { pattern: "**/*.ts", path: "src" }, env);
  check(
    "glob: in-root relative path spawns with cwd = workspace root",
    records.length > 0 && records.every((r) => r.cwd === "/repo"),
    `records=${json(records)}`
  );
  check(
    "glob: in-root relative path is passed through unchanged (relative stays relative)",
    records[0]?.args?.includes("src"),
    `args=${json(records[0]?.args)}`
  );
}

{
  const records = [];
  const env = makeEnv(records);
  await run(createGrepTool(), { pattern: "const x", path: "src" }, env);
  check(
    "grep: in-root relative path spawns with cwd = workspace root",
    records.length > 0 && records.every((r) => r.cwd === "/repo"),
    `records=${json(records)}`
  );
  check(
    "grep: in-root relative path is passed through unchanged",
    records[0]?.args?.includes("src"),
    `args=${json(records[0]?.args)}`
  );
}

{
  const records = [];
  const env = makeEnv(records);
  await run(createTreeTool(), { path: "src" }, env);
  check(
    "tree: in-root relative path spawns with cwd = workspace root",
    records.length > 0 && records.every((r) => r.cwd === "/repo"),
    `records=${json(records)}`
  );
  check(
    "tree: in-root relative path is passed through unchanged",
    records[0]?.args?.[0] === "src",
    `args=${json(records[0]?.args)}`
  );
}

// An absolute path inside the root is accepted and passed through as given.
{
  const records = [];
  const env = makeEnv(records);
  await run(createGlobTool(), { pattern: "**/*.ts", path: "/repo/src" }, env);
  check(
    "glob: absolute in-root path is accepted with cwd = workspace root",
    records.length > 0 && records.every((r) => r.cwd === "/repo") && records[0]?.args?.includes("/repo/src"),
    `records=${json(records)}`
  );
}

// ============================================================================
// Escapes are rejected, before any binary is spawned
// ============================================================================

const ESCAPES = ["../..", "../../etc", "..\\..", "/etc", "/etc/passwd", "/repo-sibling"];

for (const escape of ESCAPES) {
  {
    const records = [];
    const env = makeEnv(records);
    await expectRejected(
      `glob rejects escaping path ${json(escape)}`,
      () => run(createGlobTool(), { pattern: "**/*.ts", path: escape }, env),
      records
    );
  }
  {
    const records = [];
    const env = makeEnv(records);
    await expectRejected(
      `grep rejects escaping path ${json(escape)}`,
      () => run(createGrepTool(), { pattern: "x", path: escape }, env),
      records
    );
  }
  {
    const records = [];
    const env = makeEnv(records);
    await expectRejected(
      `tree rejects escaping path ${json(escape)}`,
      () => run(createTreeTool(), { path: escape }, env),
      records
    );
  }
}

// ============================================================================
// Legacy shell path (no execFile) still anchors cwd to the workspace root
// ============================================================================

{
  const commands = [];
  const env = makeLegacyEnv(commands);
  check("legacy env has no execFile", canExecArgs(env) === false);
  await run(createGlobTool(), { pattern: "**/*.ts" }, env);
  check(
    "glob (legacy shell path): runCommand receives cwd = workspace root",
    commands.length > 0 && commands.every((c) => c.cwd === "/repo"),
    `commands=${json(commands)}`
  );

  const escapeCommands = [];
  const escapeEnv = makeLegacyEnv(escapeCommands);
  await expectRejected(
    "glob (legacy shell path) rejects escaping path",
    () => run(createGlobTool(), { pattern: "**/*.ts", path: "../.." }, escapeEnv),
    escapeCommands
  );
}

// ============================================================================
// The shared helper threads `cwd` through to `execFile` on its own
// ============================================================================

{
  const records = [];
  const env = makeEnv(records);
  await execArgsCapture(env, "rg", ["--version"], { cwd: "/custom/root" });
  check(
    "execArgsCapture forwards options.cwd to execFile",
    records.length === 1 && records[0].cwd === "/custom/root",
    `records=${json(records)}`
  );
}

// ============================================================================
// Windows-shaped input is judged in canonical form, not by POSIX luck
//
// `CoreEnv.path` is the HOST's path implementation (node's `path` on a Node host, so a Windows
// host hands us `C:\repo` and `path.sep === "\"`). Containment therefore folds both sides to a
// forward-slash key (`toPosixPathKey`, whose own worked example is `C:\repo\` -> `C:/repo`)
// before comparing, and must not depend on the host being POSIX. Exercised with a Windows-shaped
// root through `defaultPath` (pathe folds `\`) — the same reason `posix-path.ts` keeps
// Windows-shaped regression tests that run on Linux.
// ============================================================================

const winEnv = (records) => ({
  ...makeEnv(records),
  rootPath: "C:\\repo",
  getPlatform: async () => "win32",
  homedir: async () => "C:\\Users\\dev",
});

{
  const records = [];
  await run(createGlobTool(), { pattern: "**/*.ts", path: "src" }, winEnv(records));
  check(
    "win32: an in-root relative path is accepted, cwd = the Windows root",
    records.length > 0 && records.every((r) => r.cwd === "C:\\repo"),
    `records=${json(records)}`
  );

  const absolute = [];
  await run(createGlobTool(), { pattern: "**/*.ts", path: "C:\\repo\\src" }, winEnv(absolute));
  check(
    "win32: an absolute in-root drive path is accepted",
    absolute.length > 0 && absolute.every((r) => r.cwd === "C:\\repo") && absolute[0]?.args?.includes("C:\\repo\\src"),
    `records=${json(absolute)}`
  );
}

for (const escape of ["..\\..", "C:\\other", "D:\\repo", "C:\\repo-sibling"]) {
  const records = [];
  await expectRejected(
    `win32: rejects escaping path ${json(escape)}`,
    () => run(createGlobTool(), { pattern: "**/*.ts", path: escape }, winEnv(records)),
    records
  );
}

console.log(
  failures === 0
    ? "\nvalidate-search-path-containment: ok"
    : `\nvalidate-search-path-containment FAILED (${failures} case(s))`
);
process.exit(failures === 0 ? 0 : 1);

/**
 * Validate that the search tools still return results when the preferred binary is absent.
 *
 * Why this exists: the argv migration deleted the old rule "non-zero exit + empty stdout ⇒ try
 * the next candidate" and replaced it with a `missing` flag, but the missing-detection never
 * fired — `node:child_process` reports ENOENT as `err.code === "ENOENT"` (a *string*), which the
 * adapter coerced to the number `1`, and the detector did not recognise `1` or the text
 * "ENOENT". The tools then treated a failed spawn as a successful empty search.
 *
 * The bug was invisible to a regex-based shell-ism scan: nothing was a shell-ism, and the code
 * read correctly. It only shows up as an empty result, so that is what this asserts.
 *
 * This runs on any machine: the "binary is absent" case is simulated by a CoreEnv whose
 * `execFile` fails for the preferred binaries, so it does not depend on whether `rg`/`fd` are
 * installed. It asserts the FALLBACK produces results, which is the behaviour users depend on.
 */

import { readFileSync } from "node:fs";

import {
  createGlobTool,
  createGrepTool,
  clearCoreEnv,
  execArgsCapture,
  getEnv,
  registerCoreEnv,
} from "../dist/dev.mjs";

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

/**
 * A CoreEnv whose `execFile` reports whatever failure shape a test needs.
 *
 * The original harness only ever produced `code: 0` or the ENOENT branch, which is why it could
 * not see the bug it was written to guard: "non-zero exit *with* stdout" never occurred in it.
 */
function envWithExecFile(execFile) {
  return { ...envWithoutRipgrep(), execFile };
}

/**
 * A CoreEnv that behaves like a machine without `rg`/`fd`/`fdfind`:
 * spawning one of those fails exactly the way Node reports it (ENOENT), while `find`/`grep`
 * work. Mirrors `@codent/node`'s adapter, including its `err.code` handling.
 */
function envWithoutRipgrep() {
  const EXCLUDED = new Set(["rg", "fd", "fdfind", "tree"]);
  return {
    rootPath: "/repo",
    getPlatform: async () => "linux",
    getArch: async () => "x64",
    getEnv: async () => ({}),
    homedir: async () => "/home/user",
    fs: {
      stat: async () => ({ isDirectory: false, isFile: true, size: 1, mtime: new Date() }),
    },
    runCommand: async (command) => ({
      stdout: command.startsWith("find") ? "./src/a.ts\n./src/b.ts\n" : "src/a.ts:12:const x = 1;\n",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    }),
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    fetch: async () => new Response(),
    commandExists: async (command) => !EXCLUDED.has(command),
    execFile: async (file) => {
      if (EXCLUDED.has(file)) {
        // Node's shape: a string `code`, which is what the adapter has to normalise.
        const err = new Error(`spawn ${file} ENOENT`);
        err.code = "ENOENT";
        const code = typeof err.code === "number" ? err.code : 1;
        return { stdout: "", stderr: err.message, code };
      }
      return {
        stdout: file === "find" ? "./src/a.ts\n./src/b.ts\n" : "src/a.ts:12:const x = 1;\n",
        stderr: "",
        code: 0,
      };
    },
  };
}

clearCoreEnv();
registerCoreEnv(envWithoutRipgrep());

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

const globResult = await createGlobTool().execute({ pattern: "**/*.ts", path: "." }, { toolCallId: "t-glob" });
check(
  "glob falls back to find when fd/fdfind are absent",
  globResult.files.length > 0,
  `files=${JSON.stringify(globResult.files)}`
);
check(
  "glob normalizes workspace-relative paths without ./ or an absolute root",
  globResult.files.every((file) => !file.startsWith("./") && !file.startsWith("/repo/")),
  `files=${JSON.stringify(globResult.files)}`
);

const braceGlob = await createGlobTool().execute(
  { pattern: "**/*.{ts,tsx}", path: "." },
  { toolCallId: "t-glob-brace" }
);
check("glob expands brace alternatives", braceGlob.files.length > 0, JSON.stringify(braceGlob.files));

// `find -path` treats `*` as matching `/`, so the old `**/` -> `*/` rewrite added one
// mandatory directory between every double-star segment and the target. A nested glob
// such as `**/code-mode/**/*.ts` therefore missed the actual files and returned [].
{
  let findArgs;
  clearCoreEnv();
  registerCoreEnv({
    ...envWithoutRipgrep(),
    execFile: async (file, args) => {
      if (file === "fd" || file === "fdfind") return { stdout: "", stderr: "spawn ENOENT", code: 127 };
      findArgs = args;
      const pathArg = args[args.indexOf("-path") + 1] ?? "";
      return {
        stdout: pathArg.includes(".agents")
          ? "./.agents/sessions/test.jsonl\n"
          : pathArg.includes("index.ts")
            ? "./packages/core/src/index.ts\n"
            : "./packages/core/src/agent/code-mode/extension.ts\n",
        stderr: "",
        code: 0,
      };
    },
  });
  const nested = await createGlobTool().execute(
    { pattern: "**/code-mode/**/*.ts", path: "." },
    { toolCallId: "t-glob-nested" }
  );
  const pathIdx = findArgs?.indexOf("-path") ?? -1;
  check(
    "nested double-star glob uses a gap-tolerant find predicate with the cwd prefix",
    pathIdx >= 0 && findArgs[pathIdx + 1] === "./*code-mode/*.ts",
    `find args=${JSON.stringify(findArgs)}`
  );
  check("nested double-star glob returns the matching file", nested.files.length === 1, JSON.stringify(nested.files));

  // Literal path prefixes and hidden directories must not depend on the fallback's
  // `find .` output shape. These were the false-empty cases reported by the session.
  for (const [pattern, expected] of [
    [".agents/**/*.jsonl", "./.agents/*.jsonl"],
    ["packages/core/src/index.ts", "./packages/core/src/index.ts"],
  ]) {
    const out = await createGlobTool().execute({ pattern, path: "." }, { toolCallId: `t-${expected}` });
    const idx = findArgs?.indexOf("-path") ?? -1;
    check(
      `literal/glob path predicate includes cwd prefix for ${pattern}`,
      idx >= 0 && findArgs[idx + 1] === expected,
      `find args=${JSON.stringify(findArgs)}`
    );
    check(`literal/glob path returns a result for ${pattern}`, out.files.length === 1, JSON.stringify(out.files));
  }
}

clearCoreEnv();
registerCoreEnv(envWithoutRipgrep());

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

const grepResult = await createGrepTool().execute({ pattern: "const x", path: "src" }, { toolCallId: "t-grep" });
check(
  "grep falls back to grep when rg is absent",
  grepResult.matches.length > 0,
  `matches=${JSON.stringify(grepResult.matches)}`
);

// ---------------------------------------------------------------------------
// count mode: `path:count` for a directory, a BARE count for a single file
// ---------------------------------------------------------------------------
//
// grep omits the path when the search is a single file, exactly as it does for content lines (which
// pass the searched path down as `defaultFile` for the same reason). Parsing only `path:count` read
// the bare number as a FILE named "5" reporting zero matches — `grep -c` saying 5 came back as 0.

// The description has to name the schema's key. It said `output_mode`, which the input schema does
// not declare — unknown keys are stripped by the validator, so a model asking for counts silently
// got a content search. (That mismatch is what surfaced the bare-number case below: the first probe
// of `output_mode` never reached `parseCountLine` at all.)
{
  const grepSource = readFileSync(new URL("../src/agent/tools/builtin/fs/grep-tool.ts", import.meta.url), "utf8");
  check(
    "the grep description names the schema key `outputMode`, not `output_mode`",
    !/output_mode/.test(grepSource),
    "an unknown input key is stripped, so the described mode is not the mode that runs"
  );
  check("…and the schema still declares `outputMode`", /outputMode: z/.test(grepSource));
}

/** An env whose `grep` returns `stdout` verbatim; every other binary keeps its stub behaviour (so
 *  `rg` still reports ENOENT rather than a successful empty search, which would suppress the
 *  fallback this file exists to exercise). */
const envWithGrepStdout = (stdout) => {
  const base = envWithoutRipgrep();
  return {
    ...base,
    execFile: async (file, args) => (file === "grep" ? { stdout, stderr: "", code: 0 } : base.execFile(file, args)),
  };
};

clearCoreEnv();
registerCoreEnv(envWithGrepStdout("5\n"));
const singleFileCount = await createGrepTool().execute(
  { pattern: "const x", path: "src/a.ts", outputMode: "count" },
  { toolCallId: "t-count-one" }
);
check(
  "count mode reads grep's bare number for a single file",
  singleFileCount.matches[0]?.content === "Count: 5",
  JSON.stringify(singleFileCount.matches)
);
check(
  "…and attributes it to the file that was searched",
  singleFileCount.matches[0]?.file === "src/a.ts",
  JSON.stringify(singleFileCount.matches)
);

clearCoreEnv();
registerCoreEnv(envWithGrepStdout("src/a.ts:3\nsrc/b.ts:2\n"));
const perFileCount = await createGrepTool().execute(
  { pattern: "const x", path: "src", outputMode: "count" },
  { toolCallId: "t-count-many" }
);
check(
  "count mode still reads one `path:count` line per file",
  JSON.stringify(perFileCount.matches.map((m) => [m.file, m.content])) ===
    JSON.stringify([
      ["src/a.ts", "Count: 3"],
      ["src/b.ts", "Count: 2"],
    ]),
  JSON.stringify(perFileCount.matches)
);

// ---------------------------------------------------------------------------
// grep argv / parsing regressions found by the real-filesystem audit
// ---------------------------------------------------------------------------

{
  let countArgs;
  clearCoreEnv();
  registerCoreEnv({
    ...envWithoutRipgrep(),
    execFile: async (file, args) => {
      if (file === "rg") return { stdout: "", stderr: "spawn ENOENT", code: 127 };
      if (file === "grep") {
        countArgs = args;
        return { stdout: "src/a.ts:1997\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  const count = await createGrepTool().execute(
    { pattern: "state", path: "src", outputMode: "count", limit: 5 },
    { toolCallId: "t-count-limit" }
  );
  check("count mode does not pass -m (GNU grep caps the count with it)", !countArgs?.includes("-m"));
  check(
    "count mode keeps the full per-file count",
    count.matches[0]?.content === "Count: 1997",
    JSON.stringify(count.matches)
  );
}

{
  let contentArgs;
  clearCoreEnv();
  registerCoreEnv({
    ...envWithoutRipgrep(),
    execFile: async (file, args) => {
      if (file === "rg") return { stdout: "", stderr: "spawn ENOENT", code: 127 };
      contentArgs = args;
      // NUL after the path is what `grep -Z` / `rg --null` emit.
      return { stdout: "src/a.ts\u00001:-beta flag\n", stderr: "", code: 0 };
    },
  });
  const dash = await createGrepTool().execute({ pattern: "-beta", path: "src" }, { toolCallId: "t-dash" });
  check(
    "a pattern beginning with - is passed through -e",
    contentArgs?.includes("-e") && contentArgs?.includes("-beta")
  );
  check("grep requests unambiguous NUL file boundaries", contentArgs?.includes("-Z"));
  check(
    "a leading-dash pattern still matches",
    dash.matches[0]?.content === "-beta flag",
    JSON.stringify(dash.matches)
  );
}

{
  let includeArgs;
  clearCoreEnv();
  const includeBase = envWithoutRipgrep();
  registerCoreEnv({
    ...includeBase,
    fs: {
      ...includeBase.fs,
      stat: async () => ({ isDirectory: true, isFile: false, size: 1, mtime: new Date() }),
    },
    execFile: async (file, args) => {
      if (file === "rg") return { stdout: "", stderr: "spawn ENOENT", code: 127 };
      includeArgs = args;
      return {
        stdout: "src/root.ts\u00001:export root\nsrc/nested/a.ts\u00001:export nested\n",
        stderr: "",
        code: 0,
      };
    },
  });
  const nested = await createGrepTool().execute(
    { pattern: "export", path: "src", include: "nested/*.ts", limit: 5 },
    { toolCallId: "t-include-path" }
  );
  check("path include uses a basename pre-filter for grep", includeArgs?.includes("*.ts"));
  check(
    "path include is applied in JS before pagination",
    nested.matches.length === 1 && nested.matches[0]?.file === "src/nested/a.ts",
    JSON.stringify(nested.matches)
  );
}

{
  let rgArgs;
  clearCoreEnv();
  const rgBase = envWithoutRipgrep();
  registerCoreEnv({
    ...rgBase,
    fs: {
      ...rgBase.fs,
      stat: async () => ({ isDirectory: true, isFile: false, size: 1, mtime: new Date() }),
    },
    execFile: async (file, args) => {
      if (file === "rg") {
        rgArgs = args;
        return { stdout: "src/nested/a.ts\u00001:export nested\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  const nested = await createGrepTool().execute(
    { pattern: "export", path: "src", include: "nested/*.ts", limit: 5 },
    { toolCallId: "t-rg-include-path" }
  );
  check("rg path include is made depth-tolerant", rgArgs?.includes("**/nested/*.ts"));
  check(
    "rg path include keeps the exact relative match",
    nested.matches.length === 1 && nested.matches[0]?.file === "src/nested/a.ts",
    JSON.stringify(nested.matches)
  );
}

{
  clearCoreEnv();
  registerCoreEnv({
    ...envWithoutRipgrep(),
    execFile: async (file) => {
      if (file === "rg") return { stdout: "", stderr: "spawn ENOENT", code: 127 };
      return {
        // A real match whose text starts with the context marker, followed by its context.
        stdout: "src/a.ts\u00001:[context] needle here\nsrc/a.ts\u00002-other\n",
        stderr: "",
        code: 0,
      };
    },
  });
  const sentinel = await createGrepTool().execute(
    { pattern: "needle", path: "src", context: 1 },
    { toolCallId: "t-context-sentinel" }
  );
  check(
    "a real match beginning with [context] is not dropped",
    sentinel.matches.some(
      (match) => match.lineNumber === 1 && match.content === "[context] needle here" && match.kind === "match"
    ),
    JSON.stringify(sentinel.matches)
  );

  const one = await createGrepTool().execute(
    { pattern: "needle", path: "src", context: 1 },
    { toolCallId: "t-context-one" }
  );
  check("one-match context keeps the surrounding rows", one.matches.length === 2, JSON.stringify(one.matches));
}

// A buffer-ceiling kill carries partial output; a timeout/abort does not.
{
  clearCoreEnv();
  registerCoreEnv({
    ...envWithoutRipgrep(),
    execFile: async () => ({
      stdout: "partial",
      stderr: "maxBuffer exceeded",
      code: null,
      killed: true,
      truncated: true,
    }),
  });
  const partial = await execArgsCapture(getEnv(), "grep", ["x"]);
  check("truncated capture keeps usable partial output", partial === "partial", JSON.stringify(partial));
}

// ---------------------------------------------------------------------------
// fd parse errors, exclude filtering, and grep failures
// ---------------------------------------------------------------------------

{
  clearCoreEnv();
  registerCoreEnv({
    ...envWithoutRipgrep(),
    execFile: async (file) => {
      if (file === "fd" || file === "fdfind") {
        return { stdout: "", stderr: "error parsing glob: unclosed character class", code: 1 };
      }
      if (file === "find") return { stdout: "./a[b.txt\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  const escapedFallback = await createGlobTool().execute(
    { pattern: "a[b*", path: "." },
    { toolCallId: "t-fd-parse-fallback" }
  );
  check(
    "a malformed fd glob falls back to find instead of returning empty",
    escapedFallback.files.length === 1 && escapedFallback.files[0] === "a[b.txt",
    JSON.stringify(escapedFallback.files)
  );
}

{
  clearCoreEnv();
  registerCoreEnv({
    ...envWithoutRipgrep(),
    execFile: async (file) => {
      if (file === "rg") return { stdout: "", stderr: "spawn ENOENT", code: 127 };
      if (file === "grep") return { stdout: "", stderr: "grep: Invalid regular expression", code: 2 };
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  let failed = false;
  try {
    await createGrepTool().execute({ pattern: "foo[", path: "src" }, { toolCallId: "t-grep-error" });
  } catch (err) {
    failed = err instanceof Error && /Invalid regular expression/.test(err.message);
  }
  check("grep surfaces a command failure instead of reporting zero matches", failed);
}

{
  clearCoreEnv();
  registerCoreEnv({
    ...envWithoutRipgrep(),
    execFile: async (file) => {
      if (file === "fd" || file === "fdfind") return { stdout: "", stderr: "spawn ENOENT", code: 127 };
      if (file === "find") return { stdout: "./src/a.ts\n./nested/b.ts\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  const excluded = await createGlobTool().execute(
    { pattern: "**/*.ts", path: ".", exclude: "src" },
    { toolCallId: "t-glob-exclude" }
  );
  check(
    "exclude is applied consistently in JS",
    excluded.files.length === 1 && excluded.files[0] === "nested/b.ts",
    JSON.stringify(excluded.files)
  );
}

{
  const base = envWithoutRipgrep();
  clearCoreEnv();
  registerCoreEnv({
    ...base,
    fs: {
      ...base.fs,
      realpath: async (path) => (path === "escape" || path.endsWith("/escape") ? "/outside/escape" : "/repo"),
    },
    execFile: async () => ({ stdout: "", stderr: "", code: 0 }),
  });
  let blocked = false;
  try {
    await createGlobTool().execute({ pattern: "**/*.ts", path: "escape" }, { toolCallId: "t-realpath" });
  } catch (err) {
    blocked = err instanceof Error && /resolves outside workspace root/.test(err.message);
  }
  check("an in-root symlink resolved outside the workspace is rejected", blocked);
}

{
  clearCoreEnv();
  registerCoreEnv({
    ...envWithoutRipgrep(),
    execFile: async (file) => {
      if (file === "fd" || file === "fdfind") return { stdout: "", stderr: "spawn ENOENT", code: 127 };
      if (file === "find") {
        return { stdout: "", stderr: "find: './missing': No such file or directory", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  let failed = false;
  try {
    await createGlobTool().execute({ pattern: "**/*.ts", path: "missing" }, { toolCallId: "t-find-error" });
  } catch (err) {
    failed = err instanceof Error && /find failed with exit code 1/.test(err.message);
  }
  check("find surfaces a command failure instead of reporting no files", failed);
}

// ---------------------------------------------------------------------------
// the invariant: a genuinely empty search must still read as empty, not as a failure
// ---------------------------------------------------------------------------

clearCoreEnv();
registerCoreEnv({
  ...envWithoutRipgrep(),
  // Every binary runs cleanly and legitimately finds nothing. Exit codes carry the real
  // semantics here: fd/ripgrep use 1 for "no matches", and 1 must NOT be read as a failure.
  execFile: async (file) => {
    if (file === "rg" || file === "grep") return { stdout: "", stderr: "", code: 1 };
    return { stdout: "", stderr: "", code: 0 };
  },
});

const emptyGlob = await createGlobTool().execute({ pattern: "**/*.nope", path: "." }, { toolCallId: "t-empty" });
check(
  "glob with no matches returns an empty list (not an error)",
  emptyGlob.files.length === 0,
  JSON.stringify(emptyGlob.files)
);

const emptyGrep = await createGrepTool().execute(
  { pattern: "zzz_no_such_symbol", path: "src" },
  { toolCallId: "t-empty-g" }
);
check(
  "grep with no matches returns an empty list (not an error)",
  emptyGrep.matches.length === 0,
  JSON.stringify(emptyGrep.matches)
);

// ---------------------------------------------------------------------------
// a non-zero exit with stdout must NOT discard the output
//
// This is the shape the original harness could not produce, and the one that regressed hardest.
// `find` printing hits and then exiting 1 (an unreadable subdirectory is enough) is normal, and
// ripgrep exits 1 for "no matches". Discarding stdout on any non-zero code means a FATAL search
// reports "0 results", which the model cannot distinguish from a correct empty answer.
// The previous implementation returned stdout for these codes.
// ---------------------------------------------------------------------------

const hitsWithExit = (code, stdout) =>
  envWithExecFile(async (file) => {
    if (file === "rg" || file === "fd" || file === "fdfind") return { stdout: "", stderr: "spawn ENOENT", code: 127 };
    return { stdout, stderr: "permission denied somewhere", code };
  });

for (const code of [1, 2]) {
  clearCoreEnv();
  registerCoreEnv(hitsWithExit(code, "/repo/src/a.ts\n/repo/src/b.ts\n"));
  const out = await createGlobTool().execute({ pattern: "**/*.ts", path: "." }, { toolCallId: `t-x${code}` });
  check(
    `glob keeps stdout when the fallback exits ${code} after printing hits`,
    out.files.length === 2,
    `files=${JSON.stringify(out.files)}`
  );
}

clearCoreEnv();
registerCoreEnv(hitsWithExit(2, "src/a.ts:1:hit\nsrc/b.ts:2:hit\n"));
const grepNonZero = await createGrepTool().execute({ pattern: "hit", path: "src" }, { toolCallId: "t-g2" });
check(
  "grep keeps stdout when the fallback exits 2 after printing hits",
  grepNonZero.matches.length === 2,
  `matches=${JSON.stringify(grepNonZero.matches)}`
);

// ---------------------------------------------------------------------------
// a killed search is not "no matches"
// ---------------------------------------------------------------------------

clearCoreEnv();
registerCoreEnv(
  envWithExecFile(async (file) =>
    file === "rg" || file === "fd" || file === "fdfind"
      ? { stdout: "", stderr: "spawn ENOENT", code: 127 }
      : // What Node reports when the timeout kills the child: no exit status at all.
        { stdout: "", stderr: "", code: null, killed: true }
  )
);
const killed = await execArgsCapture(getEnv(), "find", [".", "-name", "x"]);
check(
  "a killed search is signalled as unavailable, not as an empty result",
  killed === undefined,
  `execArgsCapture -> ${JSON.stringify(killed)}`
);

// ---------------------------------------------------------------------------
// a host whose execFile returns null (old remote server) must not crash
// ---------------------------------------------------------------------------

clearCoreEnv();
registerCoreEnv({ ...envWithoutRipgrep(), execFile: async () => null });

let crashed = false;
try {
  await createGlobTool().execute({ pattern: "**/*.ts", path: "." }, { toolCallId: "t-null" });
} catch (err) {
  crashed = true;
  console.log(`      (threw: ${err.message})`);
}
check("a null execFile result does not crash the tool", !crashed);

console.log(
  failures === 0 ? "\nvalidate-search-fallback: ok" : `\nvalidate-search-fallback FAILED (${failures} case(s))`
);
process.exit(failures === 0 ? 0 : 1);

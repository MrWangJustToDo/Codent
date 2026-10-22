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

import { createGlobTool, createGrepTool, clearCoreEnv, execArgsCapture, registerCoreEnv } from "../dist/dev.mjs";

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
      stdout: command.startsWith("find") ? "/repo/src/a.ts\n/repo/src/b.ts\n" : "src/a.ts:12:const x = 1;\n",
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
        stdout: file === "find" ? "/repo/src/a.ts\n/repo/src/b.ts\n" : "src/a.ts:12:const x = 1;\n",
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
const killed = await execArgsCapture("find", [".", "-name", "x"]);
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

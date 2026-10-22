/**
 * Validate that a search stops WITH the run, and reports the stop as a cancel.
 *
 * Why this exists: the search tools took the run's `abortSignal` but never passed it to the
 * spawn — `ExecArgsOptions` had no `signal` field at all, so pressing Esc ended the run while
 * `rg`/`fd`/`tree` kept scanning the workspace until their own deadline (30-60s), and the killed
 * child's empty stdout was then reported to the model as "no matches". Both halves are wrong in
 * the same way: the tool answers a question it was stopped from answering. `list_file` is not
 * covered — it makes one `readdir` call, so there is no long-running step to stop.
 *
 * The stub `execFile` here only settles when the signal aborts, which makes the test
 * self-proving: if the signal does not reach the host, the tool never settles and the whole
 * validator times out instead of passing.
 */

import assert from "node:assert/strict";

import {
  clearCoreEnv,
  createGlobTool,
  createGrepTool,
  createTreeTool,
  formatToolOutput,
  registerCoreEnv,
  TOOL_CANCELLED_MESSAGE,
  getToolMetadata,
  walkTree,
  isAbortError,
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
 * A CoreEnv whose `execFile` reports whatever a test needs, and records every call.
 *
 * `hang` makes the spawn a search that would run until its deadline: the promise settles ONLY when
 * the run's signal aborts, so a tool that does not forward the signal cannot finish.
 */
function envWithExecFile(execFile) {
  return {
    rootPath: "/repo",
    getPlatform: async () => "linux",
    getArch: async () => "x64",
    getEnv: async () => ({}),
    homedir: async () => "/home/user",
    fs: {
      stat: async () => ({ isDirectory: true, isFile: false, size: 0, mtime: new Date() }),
      readdir: async () => [],
    },
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    fetch: async () => new Response(),
    commandExists: async () => true,
    runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
    execFile,
  };
}

function hangingEnv() {
  const calls = [];
  const env = envWithExecFile((file, args, options) => {
    calls.push({ file, args, signal: options?.signal });
    return new Promise((resolve) => {
      const settle = () => resolve({ stdout: "", stderr: "", code: null, killed: true });
      if (options?.signal?.aborted) {
        settle();
        return;
      }
      options?.signal?.addEventListener("abort", settle, { once: true });
    });
  });
  return { env, calls };
}

/** Call a tool the way the engine does: with the run's signal in the execute options. */
async function runTool(makeTool, input, controller) {
  const started = Date.now();
  const output = await makeTool().execute(input, {
    toolCallId: "t-1",
    abortSignal: controller.signal,
  });
  return { output, elapsed: Date.now() - started };
}

// ---------------------------------------------------------------------------
// 1. Every search tool forwards the run's signal to the spawn, and settles as a cancel
// ---------------------------------------------------------------------------

for (const [name, make, input] of [
  ["grep", createGrepTool, { pattern: "x", path: "src" }],
  ["glob", createGlobTool, { pattern: "**/*.ts", path: "." }],
  ["tree", createTreeTool, { path: "." }],
]) {
  const { env, calls } = hangingEnv();
  clearCoreEnv();
  registerCoreEnv(env);

  const controller = new AbortController();
  const running = runTool(make, input, controller);
  // Let the tool reach the spawn before aborting, so this exercises the abort of a RUNNING search
  // rather than the "already over, do not spawn" path.
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  const { output, elapsed } = await running;

  check(
    `${name}: the run's signal reaches the host`,
    calls.length > 0 && calls.every((call) => call.signal === controller.signal),
    `calls=${calls.length}`
  );
  check(`${name}: settles as a cancel`, output.cancelled === true, JSON.stringify(output));
  check(`${name}: settles as soon as the run is over, not at a deadline`, elapsed < 2000, `${elapsed}ms`);
}

// ---------------------------------------------------------------------------
// 2. A cancel is not an empty result — for the formatter or for the model
// ---------------------------------------------------------------------------

const cancelledGrep = { matches: [], content: "", offset: 0, limit: 500, cancelled: true, durationMs: 1 };
const cancelledGlob = { files: [], content: "", offset: 0, limit: 500, cancelled: true, durationMs: 1 };

check(
  "a stopped grep renders as cancelled, not as 'No matches found'",
  formatToolOutput(cancelledGrep, "grep") === TOOL_CANCELLED_MESSAGE,
  formatToolOutput(cancelledGrep, "grep")
);
check(
  "a stopped glob renders as cancelled, not as 'No files found'",
  formatToolOutput(cancelledGlob, "glob") === TOOL_CANCELLED_MESSAGE,
  formatToolOutput(cancelledGlob, "glob")
);

// The other half of that rule: output that EXISTS is still shown. Hiding it would repeat the bug
// `isSyntheticCancelOutput` was split out to fix — "carries a cancel marker" is not "has nothing
// to show".
const resumedGrep = {
  matches: [{ file: "src/a.ts", lineNumber: 3, content: "x" }],
  content: "",
  offset: 0,
  limit: 500,
  cancelled: true,
  durationMs: 1,
};
check(
  "a cancelled grep that did match keeps showing its matches",
  formatToolOutput(resumedGrep, "grep").includes("src/a.ts") &&
    formatToolOutput(resumedGrep, "grep") !== TOOL_CANCELLED_MESSAGE,
  formatToolOutput(resumedGrep, "grep")
);

for (const [name, make, output, expectedEmpty] of [
  [
    "grep",
    createGrepTool,
    { matches: [], content: "", offset: 0, limit: 5, cancelled: true, durationMs: 1 },
    "[Search cancelled by user.]",
  ],
  [
    "glob",
    createGlobTool,
    { files: [], content: "", offset: 0, limit: 5, cancelled: true, durationMs: 1 },
    "[Search cancelled by user.]",
  ],
  [
    "tree",
    createTreeTool,
    { path: ".", maxDepth: 3, tree: "", totalEntries: 0, truncated: false, cancelled: true, durationMs: 1 },
    "[Search cancelled by user.]",
  ],
]) {
  const tool = make({});
  const projection = getToolMetadata(tool)?.toModelOutput;
  assert.equal(typeof projection, "function", `${name}: registered a model-facing projection`);
  const out = await projection({ toolCallId: "t", input: {}, output });
  const body = (Array.isArray(out) ? out : [out]).map((part) => part?.content ?? "").join("\n");
  check(`${name}: the model is told the search was cancelled`, body.includes(expectedEmpty), body);
  check(`${name}: the model is not told "no matches"`, !/No (matches|files) found/.test(body), body);
}

// A stopped search that DID print matches says both things: it stopped, and what it had.
{
  const projection = getToolMetadata(createGrepTool({}))?.toModelOutput;
  const out = await projection({
    toolCallId: "t",
    input: {},
    output: {
      matches: [{ file: "src/a.ts", lineNumber: 3, content: "x" }],
      content: "",
      offset: 0,
      limit: 5,
      cancelled: true,
      durationMs: 1,
    },
  });
  const body = (Array.isArray(out) ? out : [out]).map((part) => part?.content ?? "").join("\n");
  check("a cancelled grep with matches tells the model the result is incomplete", /incomplete/.test(body), body);
  check("…and carries the matches it had", body.includes("src/a.ts:3"), body);
}

// ---------------------------------------------------------------------------
// 3. The distinction the code turns on: an abort is not a timeout, and not an empty search
// ---------------------------------------------------------------------------

{
  // A kill with NO abort is the tool's own deadline. It must not be reported as a cancel — the
  // marker means "the user stopped this", and a timeout must not borrow it.
  clearCoreEnv();
  registerCoreEnv(envWithExecFile(async () => ({ stdout: "src/a.ts:1:x\n", stderr: "", code: null, killed: true })));
  const output = await createGrepTool().execute({ pattern: "x", path: "src" }, { toolCallId: "t-timeout" });
  check("a killed child that was NOT aborted is not a cancel", output.cancelled !== true, JSON.stringify(output));
}

{
  // `walkTree` is the fallback's own long loop: it must stop with the run too, in the same shape as
  // the spawn path (`isAbortError` recognizes it, so the tool's catch does not need a second rule).
  const controller = new AbortController();
  const dirs = { "/repo": [{ name: "a", type: "directory" }], "/repo/a": [{ name: "b.ts", type: "file" }] };
  const fs = {
    readdir: async (dir) => {
      if (dir === "/repo") controller.abort();
      return dirs[dir] ?? [];
    },
  };
  let thrown;
  try {
    await walkTree("/repo", {
      fs,
      maxDepth: 5,
      dirsOnly: false,
      showHidden: true,
      pattern: undefined,
      ignore: [],
      signal: controller.signal,
    });
  } catch (err) {
    thrown = err;
  }
  check("walkTree stops when the run is aborted", thrown !== undefined, "the walk ran to completion");
  check("…and its error is the run's abort", isAbortError(thrown, controller.signal), String(thrown));
}

console.log(
  failures === 0
    ? "\nvalidate-search-abort: ok — the run's signal reaches every search spawn and every walk"
    : `\nvalidate-search-abort: ${failures} failure(s)`
);
process.exit(failures === 0 ? 0 : 1);

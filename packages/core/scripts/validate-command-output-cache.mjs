/**
 * Validation: the spilled command output is the FULL output.
 *
 * Run: pnpm --filter @codent/core run validate:command-output-cache
 *
 * When a command's output is large, `run_command` writes it to
 * `.agents/cache/tool-output/<id>-stdout.txt` and the model is handed a preview that says
 * "Full output saved to: <path> … use read_file". The file used to be written from the tool's
 * accumulator, which keeps only a bounded TAIL (50KB / 2000 lines) to cap the agent's memory — so the
 * "full" file stopped exactly where the displayed preview did, and the head of a long output was
 * unrecoverable through the one route the model was told to use.
 *
 * The assertion is on the bytes: the head marker of an output larger than that cap must be in the
 * file. A file written from the accumulator cannot contain it.
 */

import assert from "node:assert/strict";

import { clearCoreEnv, createRunCommandTool, registerCoreEnv } from "../dist/dev.mjs";

/** The accumulator's in-memory bound — the output below is deliberately larger. */
const ACCUMULATOR_CAP = 50 * 1024;

const HEAD_MARKER = "HEAD-OF-THE-OUTPUT";
const TAIL_MARKER = "TAIL-OF-THE-OUTPUT";
// Three long lines: the head marker sits in the first few bytes, so a tail-only window drops it, and
// the few-lines shape also exercises the char-based head/tail preview rather than the line-based one.
const full = `${HEAD_MARKER}\n${"h".repeat(40 * 1024)}\n${"m".repeat(40 * 1024)}\n${TAIL_MARKER}\n`;
assert.ok(full.length > ACCUMULATOR_CAP * 1.5, `the fixture must exceed the accumulator cap (${full.length})`);

/** A CoreEnv that streams in pieces and returns its own full buffers, like the real hosts do. */
function makeEnv() {
  const files = new Map();
  return {
    files,
    env: {
      rootPath: "/repo",
      getPlatform: async () => "linux",
      getArch: async () => "x64",
      homedir: async () => "/home/user",
      getEnv: async () => ({}),
      path: { resolve: (p) => p, join: (...p) => p.join("/") },
      fs: {
        readFile: async (p) => files.get(p) ?? "",
        writeFile: async (p, c) => {
          files.set(p, c);
        },
        readdir: async () => [],
        exists: async (p) => files.has(p),
        remove: async (p) => {
          files.delete(p);
        },
        stat: async () => ({ isDirectory: true, isFile: false, size: 0, mtime: new Date() }),
      },
      runCommand: async (_cmd, opts) => {
        const CHUNK = 8 * 1024;
        for (let i = 0; i < full.length; i += CHUNK) {
          opts?.onStdout?.(full.slice(i, i + CHUNK));
        }
        return { stdout: full, stderr: "", exitCode: 0 };
      },
      commandExists: async () => true,
    },
  };
}

{
  const { env, files } = makeEnv();
  clearCoreEnv();
  registerCoreEnv(env);

  const result = await createRunCommandTool().execute(
    { command: "produce-a-lot" },
    { toolCallId: "call-big", coreEnv: env }
  );

  assert.equal(result.success, true, "the command succeeded");
  assert.equal(typeof result.cachedOutputPath, "string", "a large output is spilled to disk");
  assert.match(result.stdout, /Full output saved to:/, "…and the model is told to read the file for the rest");

  const spilled = files.get(result.cachedOutputPath);
  assert.equal(typeof spilled, "string", `the cache path names a file that was written (${result.cachedOutputPath})`);
  assert.equal(spilled, full, "the file holds the FULL output, not the display tail");
  assert.ok(spilled.includes(HEAD_MARKER), "the head survived — the part a tail-only window drops");
  assert.ok(spilled.includes(TAIL_MARKER), "and so did the tail");

  // The displayed text stays bounded: the point of spilling is that the model's copy is a preview.
  assert.ok(result.stdout.length < full.length, "the model's copy is the preview, not the whole output");
}

// A small output must not grow a file on disk at all.
{
  const { env, files } = makeEnv();
  env.runCommand = async () => ({ stdout: "ok\n", stderr: "", exitCode: 0 });
  clearCoreEnv();
  registerCoreEnv(env);

  const result = await createRunCommandTool().execute(
    { command: "echo ok" },
    { toolCallId: "call-small", coreEnv: env }
  );
  assert.equal(result.cachedOutputPath, null, "a small output is not spilled");
  assert.equal(result.stdout, "ok\n", "…and is returned verbatim");
  assert.equal(files.size, 0, "…and nothing is written to the cache directory");
}

console.log("command-output-cache validation passed");

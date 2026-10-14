/**
 * Validates the tool-output cache's age-based stale sweep:
 * `sweepStaleToolOutput` removes only `.txt` entries past the threshold, runs at
 * most once per process, and degrades silently when CoreEnv is unavailable —
 * plus the wiring that makes `cacheToolOutput` trigger it on first write, and
 * the unchanged `maybeCacheOutput` threshold contract.
 *
 * Run: pnpm --filter @codent/core run validate:tool-output-cache
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CACHE_THRESHOLD,
  TOOL_OUTPUT_CACHE_DIR,
  TOOL_OUTPUT_MAX_AGE_MS,
  cacheToolOutput,
  clearCoreEnv,
  maybeCacheOutput,
  getEnv,
  registerCoreEnv,
  resetToolOutputSweepForTesting,
  sweepStaleToolOutput,
} from "../dist/dev.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

// ---------------------------------------------------------------------------
// Mock CoreEnv backed by the real filesystem (relative paths resolve against
// rootPath, like the Node adapter).
// ---------------------------------------------------------------------------
function createEnv(rootPath) {
  const resolve = (p) => (path.isAbsolute(p) ? p : path.join(rootPath, p));
  return {
    rootPath,
    getPlatform: async () => "linux",
    getArch: async () => "x64",
    getEnv: async () => ({}),
    homedir: async () => rootPath,
    fs: {
      readFile: async (p, encoding) => fs.promises.readFile(resolve(p), encoding ?? "utf-8"),
      writeFile: async (p, content) => fs.promises.writeFile(resolve(p), content),
      mkdir: async (p) => fs.promises.mkdir(resolve(p), { recursive: true }),
      exists: async (p) =>
        fs.promises.access(resolve(p)).then(
          () => true,
          () => false
        ),
      readdir: async (p) => {
        try {
          const entries = await fs.promises.readdir(resolve(p), { withFileTypes: true });
          return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
        } catch {
          return [];
        }
      },
      stat: async (p) => {
        const st = await fs.promises.stat(resolve(p));
        return { isDirectory: st.isDirectory(), isFile: st.isFile(), size: st.size, mtime: st.mtime };
      },
      remove: async (p) => fs.promises.rm(resolve(p), TEMP_RM_OPTIONS),
    },
    runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    fetch: async () => new Response(),
  };
}

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tool-output-cache-"));
registerCoreEnv(createEnv(rootPath));

const abs = (relPath) => path.join(rootPath, relPath);
const exists = (relPath) =>
  fs.promises.access(abs(relPath)).then(
    () => true,
    () => false
  );
const writeEntry = async (name, { ageMs = 0, content = "x\n" } = {}) => {
  const rel = `${TOOL_OUTPUT_CACHE_DIR}/${name}`;
  await fs.promises.mkdir(abs(TOOL_OUTPUT_CACHE_DIR), { recursive: true });
  await fs.promises.writeFile(abs(rel), content);
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await fs.promises.utimes(abs(rel), when, when);
  }
  return rel;
};
const STALE_AGE = TOOL_OUTPUT_MAX_AGE_MS + 60_000;

// ---------------------------------------------------------------------------
// 1. Age + suffix: only stale `.txt` entries are removed
// ---------------------------------------------------------------------------
{
  const stale = await writeEntry("call_stale-stdout.txt", { ageMs: STALE_AGE });
  const fresh = await writeEntry("call_fresh-stdout.txt");
  // A background job log may one day share this directory — `.log` is not ours.
  const staleLog = await writeEntry("job_whatever.log", { ageMs: STALE_AGE });

  resetToolOutputSweepForTesting();
  const removed = await sweepStaleToolOutput(getEnv(), { force: true });
  assert.equal(removed, 1, `expected exactly the stale .txt to be swept, got ${removed}`);
  assert.equal(await exists(stale), false, "stale .txt removed");
  assert.equal(await exists(fresh), true, "fresh .txt kept");
  assert.equal(await exists(staleLog), true, "non-.txt entry is never swept");
  console.log("age + suffix OK (stale .txt swept, fresh kept, .log untouched)");
}

// ---------------------------------------------------------------------------
// 2. Once per process unless forced
// ---------------------------------------------------------------------------
{
  const stale = await writeEntry("call_stale2-stdout.txt", { ageMs: STALE_AGE });

  resetToolOutputSweepForTesting();
  assert.equal(await sweepStaleToolOutput(getEnv()), 1, "first unforced sweep removes");
  const laterStale = await writeEntry("call_stale3-stdout.txt", { ageMs: STALE_AGE });
  assert.equal(await sweepStaleToolOutput(getEnv()), 0, "second unforced sweep is a no-op");
  assert.equal(await exists(laterStale), true, "later stale file survives the guarded call");

  resetToolOutputSweepForTesting();
  assert.equal(await sweepStaleToolOutput(getEnv()), 1, "force re-arms the guard and picks up the later file");
  assert.equal(await exists(stale), false, "first stale file stays removed");
  assert.equal(await exists(laterStale), false, "later stale file removed once the guard is re-armed");
  console.log("once-per-process guard OK");
}

// ---------------------------------------------------------------------------
// 3. Wiring: the first cache write of a process triggers the sweep
// ---------------------------------------------------------------------------
{
  const stale = await writeEntry("call_wiring-stdout.txt", { ageMs: STALE_AGE });

  resetToolOutputSweepForTesting();
  const written = await cacheToolOutput(getEnv(), "hello\n", "call_wiring-grep");
  assert.equal(written, `${TOOL_OUTPUT_CACHE_DIR}/call_wiring-grep.txt`, "path shape unchanged");
  assert.equal(await exists(written), true, "cache write landed");
  assert.equal(
    await exists(stale),
    false,
    "cacheToolOutput must trigger the stale sweep (mutation: dropping the await leaves this file behind)"
  );
  console.log("cacheToolOutput wiring OK");
}

// ---------------------------------------------------------------------------
// 4. maybeCacheOutput contract: threshold decides whether anything is written
// ---------------------------------------------------------------------------
{
  const small = await maybeCacheOutput(getEnv(), "small\n", "call_small-grep");
  assert.deepEqual(small, { content: "small\n", cachedOutputPath: null }, "below threshold → no cache, no path");
  assert.equal(await exists(`${TOOL_OUTPUT_CACHE_DIR}/call_small-grep.txt`), false, "nothing written below threshold");

  const body = "y".repeat(CACHE_THRESHOLD + 10);
  const big = await maybeCacheOutput(getEnv(), body, "call_big-grep");
  assert.equal(big.cachedOutputPath, `${TOOL_OUTPUT_CACHE_DIR}/call_big-grep.txt`, "above threshold → path returned");
  assert.equal(big.content.includes("Full output saved to:"), true, "preview references the cache path");
  assert.equal(await exists(big.cachedOutputPath), true, "a returned path always exists on disk");
  console.log("maybeCacheOutput threshold contract OK");
}

// ---------------------------------------------------------------------------
// 5. Degraded host: no CoreEnv → no throw, nothing removed
// ---------------------------------------------------------------------------
{
  const stale = await writeEntry("call_degraded-stdout.txt", { ageMs: STALE_AGE });

  clearCoreEnv();
  resetToolOutputSweepForTesting();
  assert.equal(await sweepStaleToolOutput(undefined, { force: true }), 0, "missing env → 0 removed, no throw");
  assert.doesNotThrow(() => sweepStaleToolOutput(undefined, { force: true }));
  assert.equal(await exists(stale), true, "nothing removed without an env");

  registerCoreEnv(createEnv(rootPath));
  console.log("degraded host OK (no throw, no removal)");
}

await fs.promises.rm(rootPath, TEMP_RM_OPTIONS);

console.log("tool-output-cache validation passed");

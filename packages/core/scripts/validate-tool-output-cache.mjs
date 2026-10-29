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
  cleanupOrphanedToolCache,
  clearCoreEnv,
  findOrphanedToolCut,
  maybeCacheOutput,
  getEnv,
  registerCoreEnv,
  resetToolOutputSweepForTesting,
  sweepStaleToolOutput,
} from "../dist/dev.mjs";

import { createMockEnv } from "./helpers/mock-env.mjs";
import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tool-output-cache-"));
registerCoreEnv(createMockEnv(rootPath));

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
// 2b. The guard is per workspace root, not per process
// ---------------------------------------------------------------------------
{
  const root2 = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codent-tool-cache2-"));
  const env2 = createMockEnv(root2);
  const rel2 = `${TOOL_OUTPUT_CACHE_DIR}/call_root2-stdout.txt`;
  const abs2 = path.join(root2, rel2);
  await fs.promises.mkdir(path.join(root2, TOOL_OUTPUT_CACHE_DIR), { recursive: true });
  await fs.promises.writeFile(abs2, "x\n");
  const when = new Date(Date.now() - STALE_AGE);
  await fs.promises.utimes(abs2, when, when);

  resetToolOutputSweepForTesting();
  await writeEntry("call_root1-guard.txt", { ageMs: STALE_AGE });
  await sweepStaleToolOutput(getEnv()); // marks root1
  assert.equal(
    await sweepStaleToolOutput(env2),
    1,
    "a second workspace must still be swept after the first one's guard was armed"
  );
  assert.equal(
    await fs.promises
      .access(abs2)
      .then(() => true)
      .catch(() => false),
    false,
    "the second workspace's stale entry is removed"
  );

  await fs.promises.rm(root2, TEMP_RM_OPTIONS);
  console.log("per-workspace sweep guard OK");
}

// ---------------------------------------------------------------------------
// 2c. A failed pass must not arm the once-per-process guard
//
// The guard used to be set BEFORE the I/O, so one transient `exists`/`readdir` failure (a remote
// env hiccup) disabled the sweep for this workspace until the process restarted.
// ---------------------------------------------------------------------------
{
  resetToolOutputSweepForTesting();
  const env = createMockEnv(rootPath);
  const originalExists = env.fs.exists;
  let failures = 1;
  env.fs = {
    ...env.fs,
    exists: async (path) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("transient getEnv failure");
      }
      return originalExists(path);
    },
  };

  const stale = await writeEntry("call_transient-stdout.txt", { ageMs: STALE_AGE });
  assert.equal(await sweepStaleToolOutput(env), 0, "a failing pass removes nothing and does not throw");
  assert.equal(
    await sweepStaleToolOutput(env),
    1,
    "the next unforced pass retries instead of treating the failure as 'already swept'"
  );
  assert.equal(await exists(stale), false, "and it removes the stale entry");
  console.log("failed pass does not arm the sweep guard OK");
}

// ---------------------------------------------------------------------------
// 3. Wiring: the first cache write of a process triggers the sweep
// ---------------------------------------------------------------------------
{
  const stale = await writeEntry("call_wiring-stdout.txt", { ageMs: STALE_AGE });

  resetToolOutputSweepForTesting();
  const written = await cacheToolOutput(getEnv(), "hello\n", "call_wiring-grep");
  assert.ok(
    written.startsWith(`${TOOL_OUTPUT_CACHE_DIR}/call_wiring-grep-`) && written.endsWith(".txt"),
    `the id stays in the name and the write is unique-suffixed (got ${written})`
  );
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
  {
    const entries = await getEnv().fs.readdir(TOOL_OUTPUT_CACHE_DIR);
    assert.equal(
      entries.some((entry) => entry.name.startsWith("call_small-grep-")),
      false,
      "nothing written below threshold"
    );
  }

  const body = "y".repeat(CACHE_THRESHOLD + 10);
  const big = await maybeCacheOutput(getEnv(), body, "call_big-grep");
  assert.ok(
    big.cachedOutputPath.startsWith(`${TOOL_OUTPUT_CACHE_DIR}/call_big-grep-`),
    "above threshold → path returned"
  );
  assert.equal(big.content.includes("Full output saved to:"), true, "preview references the cache path");
  assert.equal(await exists(big.cachedOutputPath), true, "a returned path always exists on disk");

  // The same tool-call id from another session (a provider's `call_0` is request-scoped) must not
  // overwrite the first spill — the file name has to be unique, not just id-derived.
  const body2 = "z".repeat(CACHE_THRESHOLD + 10);
  const second = await maybeCacheOutput(getEnv(), body2, "call_big-grep");
  assert.notEqual(second.cachedOutputPath, big.cachedOutputPath, "a re-used id gets its own file");
  assert.equal(await exists(big.cachedOutputPath), true, "the earlier spill still exists");
  assert.equal(await fs.promises.readFile(path.join(getEnv().rootPath, second.cachedOutputPath), "utf8"), body2);
  console.log("maybeCacheOutput threshold contract OK");
}

// ---------------------------------------------------------------------------
// 4b. Compaction GC reads the real tool-message `content`
//
// `convertMessagesToModelMessages` emits a tool message as `{ role: "tool", content }` where
// `content` is either the JSON string or an array of text parts — never a UI `tool-result` part.
// The collector used to look for `part.type === "tool-result"` and skip strings, so it deleted
// nothing in production. Cover both real shapes.
// ---------------------------------------------------------------------------
{
  const keptString = await writeEntry("call_kept_string-stdout.txt");
  const orphanString = await writeEntry("call_orphan_string-stdout.txt");
  const keptParts = await writeEntry("call_kept_parts-stdout.txt");
  const orphanParts = await writeEntry("call_orphan_parts-stdout.txt");

  const stringMessage = (toolCallId, cachedOutputPath) => ({
    role: "tool",
    toolCallId,
    content: JSON.stringify({ success: true, cachedOutputPath }),
  });
  const partsMessage = (toolCallId, cachedOutputPath) => ({
    role: "tool",
    toolCallId,
    content: [{ type: "text", content: JSON.stringify({ success: true, cachedOutputPath }) }],
  });

  const messages = [
    stringMessage("call_orphan_string", orphanString),
    partsMessage("call_orphan_parts", orphanParts),
    stringMessage("call_kept_string", keptString),
    partsMessage("call_kept_parts", keptParts),
  ];
  // `minAgeMs: 0` pins the REFERENCE walk; the default grace is covered by §4e.
  await cleanupOrphanedToolCache(getEnv(), messages, 2, { minAgeMs: 0 });

  assert.equal(await exists(orphanString), false, "a spilled file behind the cut (string content) is deleted");
  assert.equal(await exists(orphanParts), false, "a spilled file behind the cut (text-part content) is deleted");
  assert.equal(await exists(keptString), true, "a still-visible string-content spill file is kept");
  assert.equal(await exists(keptParts), true, "a still-visible text-part spill file is kept");
  console.log("compaction reference GC OK (string + content-part tool messages)");
}

// ---------------------------------------------------------------------------
// 4c. A `cachedOutputPath` outside the cache dir is not collectable
//
// Background command results use the SAME field for their durable job log
// (`.agents/cache/command-jobs/<id>.log`). Matching the field name alone deleted a finished
// job's log on the next compaction; its later appends then recreated a headerless file with no
// history, while persisted messages still pointed at it.
// ---------------------------------------------------------------------------
{
  const jobRel = ".agents/cache/command-jobs/job-1.log";
  await fs.promises.mkdir(abs(path.dirname(jobRel)), { recursive: true });
  await fs.promises.writeFile(abs(jobRel), "# sleep 1\noutput\n");
  const inCache = await writeEntry("call_in_cache-stdout.txt");

  const messages = [
    { role: "tool", toolCallId: "call_job", content: JSON.stringify({ success: true, cachedOutputPath: jobRel }) },
    { role: "tool", toolCallId: "call_cache", content: JSON.stringify({ success: true, cachedOutputPath: inCache }) },
  ];
  await cleanupOrphanedToolCache(getEnv(), messages, 2, { minAgeMs: 0 });

  assert.equal(await exists(jobRel), true, "a background job log is not a cache entry and survives the GC");
  assert.equal(await exists(inCache), false, "a real cache entry behind the cut is still collected");
  console.log("compaction reference GC OK (job logs outside the cache are never deleted)");
}

// ---------------------------------------------------------------------------
// 4d. The compaction cut spans the WHOLE orphan prefix, not just its first entry
//
// The kept window is the tail, so orphans form the head prefix. Returning the first orphan (+1)
// left every later prefix result "visible": a 20-result compaction collected exactly one spill
// file and the other 19 waited for the age sweep.
// ---------------------------------------------------------------------------
{
  const visible = new Set(["kept"]);
  const messages = [
    ...Array.from({ length: 5 }, (_, i) => ({ role: "tool", toolCallId: `orphan-${i}`, content: "{}" })),
    { role: "user", content: "kept turn" },
    { role: "tool", toolCallId: "kept", content: "{}" },
  ];
  assert.equal(findOrphanedToolCut(messages, visible), 5, "the cut includes every orphaned prefix result");
  assert.equal(findOrphanedToolCut([], visible), 0, "an empty wire has no cut");
  assert.equal(
    findOrphanedToolCut([{ role: "tool", toolCallId: "kept", content: "{}" }], visible),
    0,
    "a fully visible wire has no cut"
  );
  console.log("compaction cut spans the orphan prefix OK");
}

// ---------------------------------------------------------------------------
// 4e. Shadowed is not expired: the default grace keeps a fresh candidate
//
// Compaction appends a summary; it never removes the transcript. A message therefore keeps naming
// its `cachedOutputPath` after it leaves the wire, and a live turn can still read it. One session
// lost a subagent report this way (auto-compact at 17:48, `No such file` at 17:49). The reference
// pass must only collect files old enough that no live reader can still hold the path; the 7-day
// age sweep stays the real reclamation path.
// ---------------------------------------------------------------------------
{
  const fresh = await writeEntry("call_grace_fresh-stdout.txt");
  const stale = await writeEntry("call_grace_stale-stdout.txt");
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await fs.promises.utimes(abs(stale), twoDaysAgo, twoDaysAgo);

  const messages = [
    { role: "tool", toolCallId: "call_grace_fresh", content: JSON.stringify({ cachedOutputPath: fresh }) },
    { role: "tool", toolCallId: "call_grace_stale", content: JSON.stringify({ cachedOutputPath: stale }) },
  ];
  await cleanupOrphanedToolCache(getEnv(), messages, 2);

  assert.equal(await exists(fresh), true, "a candidate younger than the grace period survives the compaction pass");
  assert.equal(await exists(stale), false, "an old candidate is still collected (the pass is not dead code)");
  console.log("compaction reference GC OK (grace period keeps fresh evidence)");
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

  registerCoreEnv(createMockEnv(rootPath));
  console.log("degraded host OK (no throw, no removal)");
}

await fs.promises.rm(rootPath, TEMP_RM_OPTIONS);

console.log("tool-output-cache validation passed");

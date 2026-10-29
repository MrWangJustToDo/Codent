/**
 * Validates the shared workspace-cache retention table.
 *
 * The spills (`.agents/cache/tool-output/*.txt`), background job logs (`command-jobs/*.log`) and job
 * records (`command-jobs/*.json`) used to carry three separate sweepers and three call sites that
 * each had to remember which one applied. They now share one table
 * (`tools/shared/cache/workspace-cache.ts`): directory + suffix + age, one walker, one
 * once-per-root guard, one trigger (`sweepWorkspaceCaches`).
 *
 * This pins the properties that make "shared" real rather than cosmetic:
 *
 *   1. the table IS the source (module constants and table cells cannot diverge);
 *   2. the retention relationships are the documented ones (a record outlives its log; the
 *      compaction reference pass can never outlive the age sweep);
 *   3. one call expires all three kinds, and the targeted functions share that call's guard — two
 *      guards would mean two policies that only happen to agree;
 *   4. the suffix is the isolation guard: merging directories can never make one sweep delete
 *      another artifact.
 *
 * Run: pnpm --filter @codent/core run validate:workspace-cache-retention
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  COMMAND_JOB_CACHE_DIR,
  MAX_JOB_LOG_AGE_MS,
  MAX_JOB_RECORD_AGE_MS,
  TOOL_OUTPUT_CACHE_DIR,
  TOOL_OUTPUT_MAX_AGE_MS,
  TOOL_OUTPUT_ORPHAN_GRACE_MS,
  WORKSPACE_CACHE_RETENTION,
  resetWorkspaceCacheSweeps,
  sweepStaleJobLogs,
  sweepStaleJobRecords,
  sweepStaleToolOutput,
  sweepWorkspaceCaches,
} from "../dist/dev.mjs";

import { createMockEnv } from "./helpers/mock-env.mjs";
import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "workspace-cache-retention-"));
const env = createMockEnv(rootPath);
const abs = (rel) => path.join(rootPath, rel);

/** Write `dir/name` with an mtime `ageMs` in the past. */
async function writeAged(rel, ageMs) {
  await fs.promises.mkdir(path.dirname(abs(rel)), { recursive: true });
  await fs.promises.writeFile(abs(rel), "x\n");
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await fs.promises.utimes(abs(rel), when, when);
  }
  return rel;
}

const staleAge = (maxAgeMs) => maxAgeMs + 60_000;

// ---------------------------------------------------------------------------
// 1. One table, no second copy of a directory or an age
// ---------------------------------------------------------------------------
{
  assert.equal(WORKSPACE_CACHE_RETENTION.toolOutput.dir, TOOL_OUTPUT_CACHE_DIR, "spill dir comes from the table");
  assert.equal(WORKSPACE_CACHE_RETENTION.toolOutput.maxAgeMs, TOOL_OUTPUT_MAX_AGE_MS, "spill age comes from the table");
  assert.equal(WORKSPACE_CACHE_RETENTION.jobLog.dir, COMMAND_JOB_CACHE_DIR, "job log dir comes from the table");
  assert.equal(WORKSPACE_CACHE_RETENTION.jobLog.maxAgeMs, MAX_JOB_LOG_AGE_MS, "job log age comes from the table");
  assert.equal(WORKSPACE_CACHE_RETENTION.jobRecord.dir, COMMAND_JOB_CACHE_DIR, "job record dir comes from the table");
  assert.equal(
    WORKSPACE_CACHE_RETENTION.jobRecord.maxAgeMs,
    MAX_JOB_RECORD_AGE_MS,
    "job record age comes from the table"
  );

  const suffixes = Object.values(WORKSPACE_CACHE_RETENTION).map((spec) => spec.suffix);
  assert.equal(new Set(suffixes).size, suffixes.length, "each artifact owns a distinct suffix (the isolation guard)");
  assert.deepEqual([...suffixes].sort(), [".json", ".log", ".txt"], "the expected artifact kinds");

  // A record must outlive its log: the log is the bulky artifact, the record is what still answers
  // "what happened" after the log is gone.
  assert.ok(MAX_JOB_LOG_AGE_MS < MAX_JOB_RECORD_AGE_MS, "a job record outlives its log");
  // The compaction reference pass may only collect what the age sweep would eventually collect; a
  // grace longer than the max age would make the pass dead code and the doc a lie.
  assert.ok(
    TOOL_OUTPUT_ORPHAN_GRACE_MS <= TOOL_OUTPUT_MAX_AGE_MS,
    "the reference-pass grace cannot outlive the age sweep"
  );
  console.log("retention table is the single source, relationships hold — ok");
}

// ---------------------------------------------------------------------------
// 2. One call expires every kind (fresh entries survive)
// ---------------------------------------------------------------------------
{
  resetWorkspaceCacheSweeps();
  const fixtures = [
    await writeAged(`${TOOL_OUTPUT_CACHE_DIR}/stale.txt`, staleAge(TOOL_OUTPUT_MAX_AGE_MS)),
    await writeAged(`${TOOL_OUTPUT_CACHE_DIR}/fresh.txt`, 0),
    await writeAged(`${COMMAND_JOB_CACHE_DIR}/job_stale.log`, staleAge(MAX_JOB_LOG_AGE_MS)),
    await writeAged(`${COMMAND_JOB_CACHE_DIR}/job_fresh.log`, 0),
    await writeAged(`${COMMAND_JOB_CACHE_DIR}/job_stale.json`, staleAge(MAX_JOB_RECORD_AGE_MS)),
    await writeAged(`${COMMAND_JOB_CACHE_DIR}/job_fresh.json`, 0),
  ];

  const result = await sweepWorkspaceCaches(env, { force: true });
  assert.equal(result.removed, 3, `one call removes one stale file per kind, got ${JSON.stringify(result.byKind)}`);
  assert.deepEqual(result.byKind, { toolOutput: 1, jobLog: 1, jobRecord: 1 }, "each kind was swept");

  const present = async (rel) =>
    fs.promises
      .access(abs(rel))
      .then(() => true)
      .catch(() => false);
  assert.equal(await present(fixtures[0]), false, "stale spill removed");
  assert.equal(await present(fixtures[1]), true, "fresh spill kept");
  assert.equal(await present(fixtures[2]), false, "stale job log removed");
  assert.equal(await present(fixtures[3]), true, "fresh job log kept");
  assert.equal(await present(fixtures[4]), false, "stale job record removed");
  assert.equal(await present(fixtures[5]), true, "fresh job record kept");
  console.log("one sweep expires all three kinds — ok");
}

// ---------------------------------------------------------------------------
// 3. The targeted functions share the shared sweep's guard
//
// If `sweepStaleToolOutput` kept its own "already swept" flag, it would be a second policy that
// only happens to agree today. After the unified pass, the targeted entry points must be no-ops.
// ---------------------------------------------------------------------------
{
  resetWorkspaceCacheSweeps();
  await writeAged(`${TOOL_OUTPUT_CACHE_DIR}/guard.txt`, staleAge(TOOL_OUTPUT_MAX_AGE_MS));
  await sweepWorkspaceCaches(env); // removes guard.txt and arms all three

  assert.equal(await sweepStaleToolOutput(env), 0, "the spill entry point shares the unified guard");
  assert.equal(await sweepStaleJobLogs(undefined, env), 0, "the job-log entry point shares the same guard");
  assert.equal(await sweepStaleJobRecords(env), 0, "the job-record entry point shares the same guard");

  // A file that appears after the pass is exactly what `force` exists for.
  await writeAged(`${TOOL_OUTPUT_CACHE_DIR}/guard-later.txt`, staleAge(TOOL_OUTPUT_MAX_AGE_MS));
  const removed = await sweepWorkspaceCaches(env, { force: true });
  assert.equal(removed.byKind.toolOutput, 1, "force re-arms and collects the file written after the pass");
  console.log("targeted entry points share the unified guard — ok");
}

// ---------------------------------------------------------------------------
// 4. Suffix isolation still holds when the directories are the same
//
// Logs and records already share `command-jobs/`; the spill sweep is the one that must never treat
// a neighbouring artifact as its own. A future merge of `tool-output/` into that directory must not
// turn a `.txt` sweep into a job-log deleter (or the reverse).
// ---------------------------------------------------------------------------
{
  resetWorkspaceCacheSweeps();
  const strayLog = await writeAged(`${TOOL_OUTPUT_CACHE_DIR}/not-a-spill.log`, staleAge(TOOL_OUTPUT_MAX_AGE_MS));
  const strayTxt = await writeAged(`${COMMAND_JOB_CACHE_DIR}/not-a-job.txt`, staleAge(MAX_JOB_LOG_AGE_MS));

  await sweepWorkspaceCaches(env, { force: true });
  const present = async (rel) =>
    fs.promises
      .access(abs(rel))
      .then(() => true)
      .catch(() => false);
  assert.equal(await present(strayLog), true, "a .log inside the spill directory is not a spill");
  assert.equal(await present(strayTxt), true, "a .txt inside the job directory is not a job artifact");
  console.log("suffix isolation holds across shared directories — ok");
}

await fs.promises.rm(rootPath, TEMP_RM_OPTIONS);
console.log("workspace-cache-retention validation passed");

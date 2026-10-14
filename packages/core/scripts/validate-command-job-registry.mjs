/**
 * Validates CommandJobRegistry poll/kill/destroyAll semantics plus the durable
 * per-job log: creation, arrival order, stderr marking, terminal footer,
 * unbounded size, eviction/teardown deletion, stale sweep and degraded hosts.
 *
 * Run: pnpm --filter @codent/core run validate:command-job-registry
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  COMMAND_JOB_LOG_DIR,
  MAX_JOB_LOG_AGE_MS,
  clearCoreEnv,
  commandJobRegistry,
  createKillCommandTool,
  registerCoreEnv,
  sweepStaleJobLogs,
} from "../dist/dev.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const registry = commandJobRegistry;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MIB = 1024 * 1024;
/** The size cap this feature deliberately does NOT have any more (regression guard). */
const REMOVED_JOB_LOG_CAP_BYTES = 16 * MIB;

// ---------------------------------------------------------------------------
// Mock CoreEnv backed by the real filesystem (relative paths resolve against
// rootPath, like the Node adapter).
// ---------------------------------------------------------------------------
function createEnv(rootPath, { withAppendFile = true } = {}) {
  const resolve = (p) => (path.isAbsolute(p) ? p : path.join(rootPath, p));
  const fsImpl = {
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
  };
  if (withAppendFile === "throwing") {
    fsImpl.appendFile = async () => {
      throw new Error("appendFile failed");
    };
  } else if (withAppendFile) {
    fsImpl.appendFile = async (p, content) => fs.promises.appendFile(resolve(p), content, "utf8");
  }
  return {
    rootPath,
    getPlatform: async () => "linux",
    getArch: async () => "x64",
    getEnv: async () => ({}),
    homedir: async () => rootPath,
    fs: fsImpl,
    runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    fetch: async () => new Response(),
  };
}

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "command-job-registry-"));
registerCoreEnv(createEnv(rootPath));

const abs = (relPath) => path.join(rootPath, relPath);
const logExists = async (relPath) =>
  fs.promises.access(abs(relPath)).then(
    () => true,
    () => false
  );
/** Wait until the log contains `needle` (writer flushes on a timer). */
async function waitForLog(relPath, needle, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = await fs.promises.readFile(abs(relPath), "utf-8").catch(() => "");
    if (content.includes(needle) || Date.now() > deadline) return content;
    await sleep(25);
  }
}

/**
 * Wait until a log no longer exists. Deletions are asynchronous — the registry's log
 * `remove()` awaits an in-flight flush before unlinking — so a fixed settle sleep is a
 * flake under load (too short) or dead time when idle. Polling is neither.
 */
async function waitForLogGone(relPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while ((await logExists(relPath)) && Date.now() < deadline) {
    await sleep(25);
  }
}

// ---------------------------------------------------------------------------
// 1. Create a job
// ---------------------------------------------------------------------------
const job = registry.create("echo hello");
assert.equal(job.status, "running");
assert.ok(job.id.startsWith("job_"));
assert.equal(job.stdout, "");
assert.equal(job.stderr, "");
assert.equal(job.exitCode, null);
assert.ok(job.startedAt > 0);
assert.equal(job.endedAt, null);
assert.equal(job.logPath, `${COMMAND_JOB_LOG_DIR}/${job.id}.log`);

// ---------------------------------------------------------------------------
// 2. Append output and poll incrementally
// ---------------------------------------------------------------------------
registry.appendStdout(job.id, "hello\n");
registry.appendStderr(job.id, "warn: test\n");

let result = registry.poll(job.id);
assert.equal(result.jobId, job.id);
assert.equal(result.status, "running");
assert.equal(result.stdout, "hello\n");
assert.equal(result.stderr, "warn: test\n");
assert.equal(result.exitCode, null);
assert.equal(result.running, true);
assert.equal(result.logPath, job.logPath);

// Second poll returns empty (cursor advanced)
result = registry.poll(job.id);
assert.equal(result.stdout, "");
assert.equal(result.stderr, "");

// ---------------------------------------------------------------------------
// 3. Append after poll — only new data returned
// ---------------------------------------------------------------------------
registry.appendStdout(job.id, "world\n");
result = registry.poll(job.id);
assert.equal(result.stdout, "world\n");
assert.equal(result.stderr, "");

// ---------------------------------------------------------------------------
// 4. markExited transitions status
// ---------------------------------------------------------------------------
registry.markExited(job.id, 0);
assert.equal(job.status, "exited");
assert.equal(job.exitCode, 0);
assert.ok(job.endedAt !== null);

result = registry.poll(job.id);
assert.equal(result.status, "exited");
assert.equal(result.running, false);

// ---------------------------------------------------------------------------
// 5. Log content: header, arrival order, stderr marking, terminal footer
// ---------------------------------------------------------------------------
{
  const content = await waitForLog(job.logPath, "[exit 0");
  assert.ok(
    content.startsWith("# echo hello\n"),
    `header starts the log, got: ${JSON.stringify(content.slice(0, 40))}`
  );
  assert.ok(/^# started \d{4}-/m.test(content), "header records the start time");

  const stdoutAt = content.indexOf("hello\n");
  const stderrAt = content.indexOf("[stderr] warn: test\n");
  const secondAt = content.indexOf("world\n");
  const footerAt = content.indexOf("[exit 0 · exited · finished ");
  assert.ok(stdoutAt > 0, "stdout written");
  assert.ok(stderrAt > stdoutAt, "stderr marked and ordered after the preceding stdout chunk");
  assert.ok(secondAt > stderrAt, "later stdout follows in arrival order");
  assert.ok(footerAt > secondAt, "terminal footer closes the log");
  console.log("job log content OK");
}

// ---------------------------------------------------------------------------
// 6. Running jobs can be killed (and the log records the terminal status)
// ---------------------------------------------------------------------------
let killCalled = false;
const killable = registry.create("sleep 10");
registry.appendStdout(killable.id, "listening on :5173\n");
registry.setKill(killable.id, async () => {
  killCalled = true;
});
const killed = await registry.kill(killable.id);
assert.equal(killed, true);
assert.equal(killCalled, true);
assert.equal(killable.status, "killed");

{
  const content = await waitForLog(killable.logPath, "· killed ·");
  assert.ok(content.includes("[exit n/a · killed · finished "), "killed job log carries a footer");
  assert.ok(content.includes("listening on :5173"), "killed job log keeps its output");
  console.log("kill footer OK");
}

// ---------------------------------------------------------------------------
// 7. Unknown job returns null from get/poll
// ---------------------------------------------------------------------------
assert.equal(registry.get("nonexistent"), undefined);
assert.equal(registry.poll("nonexistent"), null);

// ---------------------------------------------------------------------------
// 8. Append after non-running is no-op (memory and log)
// ---------------------------------------------------------------------------
registry.appendStdout(job.id, "after exit\n");
result = registry.poll(job.id);
assert.equal(result.stdout, ""); // no data — we stopped appending when exited
assert.equal((await waitForLog(job.logPath, "[exit 0")).includes("after exit"), false);

// ---------------------------------------------------------------------------
// 9. destroyAll kills all, clears, and deletes the logs
// ---------------------------------------------------------------------------
const jobA = registry.create("echo a");
const jobB = registry.create("echo b");
registry.appendStdout(jobA.id, "a\n");
registry.appendStdout(jobB.id, "b\n");
assert.ok(registry.get(jobA.id) !== undefined);
assert.ok(registry.get(jobB.id) !== undefined);
// Let both writers create their files before teardown.
await waitForLog(jobA.logPath, "# echo a");
await waitForLog(jobB.logPath, "# echo b");
await registry.destroyAll();
assert.equal(registry.get(jobA.id), undefined);
assert.equal(registry.get(jobB.id), undefined);
assert.equal(await logExists(jobA.logPath), false, "teardown deletes the job log");
assert.equal(await logExists(jobB.logPath), false, "teardown deletes the job log");
console.log("teardown log deletion OK");

// ---------------------------------------------------------------------------
// 10. No size cap: background output is always written, nothing is truncated
// ---------------------------------------------------------------------------
{
  const bigJob = registry.create("echo big");
  const chunkFor = (i) => `${String(i).padStart(2, "0")}-` + "x".repeat(MIB - 4) + "\n";
  const CHUNKS = 17;
  for (let i = 0; i < CHUNKS; i++) registry.appendStdout(bigJob.id, chunkFor(i));
  registry.markExited(bigJob.id, 0);

  const content = await waitForLog(bigJob.logPath, "[exit 0");
  const stat = await fs.promises.stat(abs(bigJob.logPath));
  assert.equal(content.includes("log truncated"), false, "no truncation marker is ever written");
  assert.ok(content.startsWith("# echo big\n"), "header intact");
  assert.ok(content.includes("00-"), "first chunk retained");
  assert.ok(content.includes(`${String(CHUNKS - 1).padStart(2, "0")}-`), "LAST chunk retained too (past 16 MiB)");
  assert.ok(stat.size > REMOVED_JOB_LOG_CAP_BYTES, `log exceeds the removed 16 MiB cap, got ${stat.size} bytes`);
  assert.ok(content.includes("[exit 0 · exited · finished "), "footer written after an over-cap log");
  console.log("no size cap OK:", stat.size, "bytes (over the removed", REMOVED_JOB_LOG_CAP_BYTES, "cap)");
}

// ---------------------------------------------------------------------------
// 11. Registry eviction deletes the evicted job's log
// ---------------------------------------------------------------------------
{
  const created = [];
  for (let i = 0; i < 51; i++) {
    const j = registry.create(`evict-${i}`);
    registry.appendStdout(j.id, `out-${i}\n`);
    if (i === 0) {
      // The file must exist before eviction, or the deletion assertion below passes
      // vacuously ("deleted" is indistinguishable from "never created").
      const seeded = await waitForLog(j.logPath, "out-0");
      assert.ok(seeded.includes("out-0"), "eviction candidate log exists before eviction");
    }
    registry.markExited(j.id, 0);
    registry.collectCompleted(); // notified finished jobs are the evictable ones
    created.push(j);
  }
  await waitForLogGone(created[0].logPath);
  assert.equal(await logExists(created[0].logPath), false, "evicted job log deleted");
  // Poll for the retained log's content too: asserting merely that the path exists could
  // race the writer's flush on a slow runner.
  const kept = await waitForLog(created[50].logPath, "out-50");
  assert.ok(kept.includes("out-50"), "retained job log kept");
  console.log("eviction log deletion OK");
}

// ---------------------------------------------------------------------------
// 12. Degraded host: fs without appendFile → null path, no writes, no throw
// ---------------------------------------------------------------------------
{
  const noAppendRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "command-job-no-append-"));
  clearCoreEnv();
  registerCoreEnv(createEnv(noAppendRoot, { withAppendFile: false }));

  const quiet = registry.create("echo quiet");
  assert.equal(quiet.logPath, null, "no log path without appendFile");
  registry.appendStdout(quiet.id, "ignored\n");
  registry.appendStderr(quiet.id, "ignored\n");
  registry.markExited(quiet.id, 0);
  const quietPoll = registry.poll(quiet.id);
  assert.equal(quietPoll.logPath, null);
  assert.equal(quietPoll.status, "exited");
  assert.deepEqual(await fs.promises.readdir(noAppendRoot), [], "nothing written without appendFile");
  console.log("degraded host OK (no appendFile → null path, no write, no throw)");

  clearCoreEnv();
  registerCoreEnv(createEnv(rootPath));
}

// ---------------------------------------------------------------------------
// 13. Runtime write failure: logging degrades and the path stops being advertised
// ---------------------------------------------------------------------------
{
  const throwRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "command-job-throwing-"));
  clearCoreEnv();
  registerCoreEnv(createEnv(throwRoot, { withAppendFile: "throwing" }));

  const failing = registry.create("echo failing");
  assert.equal(failing.logPath, `${COMMAND_JOB_LOG_DIR}/${failing.id}.log`, "path advertised while healthy");
  registry.appendStdout(failing.id, "boom\n");
  await sleep(400); // let the failing flush settle
  assert.equal(registry.get(failing.id)?.logPath, null, "path cleared after a write failure");
  assert.equal(registry.poll(failing.id).logPath, null, "poll stops advertising the path");
  assert.doesNotThrow(() => registry.appendStderr(failing.id, "more\n"));
  assert.doesNotThrow(() => registry.markExited(failing.id, 1));
  // A non-zero exit is `failed` now (this call exits 1). The assertion's point is the query, which must
  // keep working when logging degraded — the status is the honest one for the exit it was given.
  assert.equal(registry.poll(failing.id).status, "failed", "job stays queryable after a logging failure");
  console.log("runtime log failure OK (path cleared, command unaffected)");

  clearCoreEnv();
  registerCoreEnv(createEnv(rootPath));
}

// ---------------------------------------------------------------------------
// 14. Stale sweep: only logs past the age threshold are removed
// ---------------------------------------------------------------------------
{
  const staleRel = `${COMMAND_JOB_LOG_DIR}/job_stale.log`;
  const freshRel = `${COMMAND_JOB_LOG_DIR}/job_fresh.log`;
  await fs.promises.mkdir(abs(COMMAND_JOB_LOG_DIR), { recursive: true });
  await fs.promises.writeFile(abs(staleRel), "# stale\n");
  await fs.promises.writeFile(abs(freshRel), "# fresh\n");
  const old = new Date(Date.now() - MAX_JOB_LOG_AGE_MS - 60_000);
  await fs.promises.utimes(abs(staleRel), old, old);

  const swept = await sweepStaleJobLogs({ force: true });
  assert.equal(swept, 1, `expected exactly the stale log to be swept, got ${swept}`);
  assert.equal(await logExists(staleRel), false, "stale log removed");
  assert.equal(await logExists(freshRel), true, "fresh log kept");
  console.log("stale sweep OK");
}

// ---------------------------------------------------------------------------
// 9. A failed exit is `failed`, and a kill of a finished job says so
// ---------------------------------------------------------------------------
//
// `markExited`'s ternary read `… ? "exited" : "exited"`, so EVERY job that ended was recorded as a
// clean finish — and the completion notification maps `exited` to "completed", so a background command
// that failed was announced to the model as completed. `kill` returned `true` for a job that had
// already finished, so `kill_command` claimed to have killed it and its "was not running" branch was
// unreachable.

{
  const ok = registry.create("echo ok");
  registry.markExited(ok.id, 0);
  assert.equal(ok.status, "exited", "a zero exit is a clean finish");

  const failed = registry.create("exit 7");
  registry.markExited(failed.id, 7);
  assert.equal(failed.status, "failed", "a non-zero exit is a failure, not a finish");
  assert.equal(failed.exitCode, 7, "…and the real code is kept");

  const signalled = registry.create("sleep 1");
  registry.markExited(signalled.id, null);
  assert.equal(signalled.status, "failed", "no exit status (the child was signalled) is not a success");
  assert.equal(signalled.exitCode, 1, "…and it is reported with a non-zero code");

  assert.equal(await registry.kill(ok.id), false, "killing a finished job reports that nothing was killed");
  assert.equal(await registry.kill("nonexistent"), false, "…as does an unknown job");
  const running = registry.create("sleep 30");
  registry.setKill(running.id, async () => {});
  assert.equal(await registry.kill(running.id), true, "killing a running job reports that it killed it");

  // `kill_command` hands back the job's durable log: killing stops the stream, it does not erase what
  // the job produced, and that file is the one the background `run_command` advertises.
  const tool = createKillCommandTool();
  const logged = registry.create("echo logged");
  registry.appendStdout(logged.id, "some output\n");
  registry.markExited(logged.id, 0); // finished: killing it stops nothing
  const result = await tool.execute({ jobId: logged.id }, {});
  assert.equal(result.killed, false, "a finished job is reported as not running");
  assert.equal(result.cachedOutputPath, logged.logPath, "…and its log path is returned, not null");
}

await registry.destroyAll();

console.log("command-job-registry validation passed");

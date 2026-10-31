/* eslint-disable max-lines -- the command-job suite keeps record/log/teardown/lifecycle cases together; splitting them would duplicate the filesystem env and temp fixture setup. */
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
  COMMAND_JOB_CACHE_DIR,
  MAX_JOB_LOG_AGE_MS,
  AgentCommandService,
  CommandJobRegistry,
  TURN_CONTEXT_KINDS,
  clearCoreEnv,
  collectRunCommandToolCallIds,
  contextAttributesFromText,
  createBackgroundMiddleware,
  formatContextSectionUserContent,
  formatSectionTag,
  createGetCommandOutputTool,
  createKillCommandTool,
  formatBackgroundJobsSection,
  registerCoreEnv,
  sweepStaleJobLogs,
} from "../dist/dev.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const registry = new CommandJobRegistry();
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
const env = createEnv(rootPath);
registerCoreEnv(env);

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
/** Wait until a file contains `needle` (record writes are serialized/fire-and-forget). */
async function waitForFileContent(relPath, needle, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = await fs.promises.readFile(abs(relPath), "utf-8").catch(() => "");
    if (content.includes(needle) || Date.now() > deadline) return content;
    await sleep(25);
  }
}

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
assert.equal(job.logPath, `${COMMAND_JOB_CACHE_DIR}/${job.id}.log`);

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
    await registry.collectCompleted(); // notified finished jobs are the evictable ones
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
  /** Poll until the registry stops advertising a job's log path (the flush is debounced + async). */
  const waitForLogPathCleared = async (id, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (registry.get(id)?.logPath === null) return;
      await sleep(25);
    }
  };

  const throwRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "command-job-throwing-"));
  clearCoreEnv();
  registerCoreEnv(createEnv(throwRoot, { withAppendFile: "throwing" }));

  const failing = registry.create("echo failing");
  assert.equal(failing.logPath, `${COMMAND_JOB_CACHE_DIR}/${failing.id}.log`, "path advertised while healthy");
  registry.appendStdout(failing.id, "boom\n");
  // The flush is DEBOUNCED (`JOB_LOG_FLUSH_INTERVAL_MS`) and then awaits real I/O, so the failure is
  // observed on a timer rather than synchronously. A fixed 400 ms wait therefore raced a loaded CI
  // runner (Windows) and read the path as still advertised, while the same code passed locally. Wait
  // for the CONDITION: the assertion is unchanged, it just stops depending on how fast a machine gets
  // through a 250 ms timer plus a write.
  await waitForLogPathCleared(failing.id, 5_000);
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
  const staleRel = `${COMMAND_JOB_CACHE_DIR}/job_stale.log`;
  const freshRel = `${COMMAND_JOB_CACHE_DIR}/job_fresh.log`;
  await fs.promises.mkdir(abs(COMMAND_JOB_CACHE_DIR), { recursive: true });
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
  const commandService = {
    kill: async (jobId) => {
      await registry.ready();
      const existing = registry.get(jobId);
      if (!existing) throw new Error(`Unknown background jobId: ${jobId}`);
      const killed = await registry.kill(jobId);
      const after = registry.get(jobId);
      return { killed, status: after?.status ?? "killed", logPath: after?.logPath };
    },
  };
  const tool = createKillCommandTool({ context: { getCommandService: () => commandService } });
  const logged = registry.create("echo logged");
  registry.appendStdout(logged.id, "some output\n");
  registry.markExited(logged.id, 0); // finished: killing it stops nothing
  const result = await tool.execute({ jobId: logged.id }, {});
  assert.equal(result.killed, false, "a finished job is reported as not running");
  assert.equal(result.cachedOutputPath, logged.logPath, "…and its log path is returned, not null");
}

// ---------------------------------------------------------------------------
// 13. Durable records: a restart restores status/output and delivers once
// ---------------------------------------------------------------------------
{
  const owner = "ses_durable";
  // A getter is the production shape: the registry is built before `ensureSessionData()` exists.
  const first = new CommandJobRegistry(env, { ownerSessionId: () => owner });
  await first.ready();
  const finished = first.create("echo durable", "call_durable");
  first.appendStdout(finished.id, "durable output\n");
  first.markExited(finished.id, 0);
  const recordPath = `${COMMAND_JOB_CACHE_DIR}/${finished.id}.json`;
  const record = await waitForFileContent(recordPath, '"status":"exited"');
  assert.ok(record.includes('"status":"exited"'), "terminal record persisted");

  const resumed = new CommandJobRegistry(env, { ownerSessionId: owner });
  await resumed.ready();
  assert.equal(resumed.get(finished.id)?.status, "exited", "resume restores the terminal status");
  assert.equal(
    resumed.get(finished.id)?.toolCallId,
    "call_durable",
    "…and the tool-call id used by the section filter"
  );
  const polled = resumed.poll(finished.id);
  assert.equal(polled?.stdout, "durable output\n", "first poll after resume returns the persisted tail");
  // The middleware's two-phase contract: peek (no mark) → persist the notification → mark.
  const peeked = await resumed.collectCompleted({ markNotified: false });
  assert.equal(peeked.filter((j) => j.id === finished.id).length, 1, "…and queues the completion");
  assert.ok(peeked.find((j) => j.id === finished.id)?.logPath, "…with the full log path");
  assert.equal(
    (await resumed.collectCompleted({ markNotified: false })).filter((j) => j.id === finished.id).length,
    1,
    "…and a crash before the notification re-delivers instead of dropping it"
  );
  await resumed.markNotified([finished.id]);
  assert.deepEqual(await resumed.collectCompleted(), [], "marking makes the completion exactly-once");

  const afterNotify = new CommandJobRegistry(env, { ownerSessionId: owner });
  await afterNotify.ready();
  assert.deepEqual(await afterNotify.collectCompleted(), [], "the notified flag survives a restart");
  assert.equal(afterNotify.get(finished.id)?.status, "exited");

  // The kill tool works on a restored job too (no "unknown jobId" after resume).
  const getTool = createGetCommandOutputTool({
    context: {
      getCommandService: () => ({
        poll: async (jobId) => {
          await afterNotify.ready();
          const result = afterNotify.poll(jobId);
          if (!result) throw new Error(`Unknown background jobId: ${jobId}`);
          return result;
        },
      }),
    },
  });
  const out = await getTool.execute({ jobId: finished.id }, {});
  assert.equal(out.status, "exited");
  assert.equal(out.cachedOutputPath, finished.logPath);

  await first.clear();
  await resumed.clear();
  await afterNotify.clear();
}

{
  // A `running` record from a dead process is not "still running": mark it interrupted, close the
  // log, and notify with the log path so the model can read whatever was produced.
  const owner = "ses_interrupted";
  const first = new CommandJobRegistry(env, { ownerSessionId: owner });
  await first.ready();
  const running = first.create("sleep 60", "call_running");
  first.appendStdout(running.id, "partial\n");
  await waitForLog(running.logPath, "partial");
  await waitForFileContent(`${COMMAND_JOB_CACHE_DIR}/${running.id}.json`, '"status":"running"');

  const resumed = new CommandJobRegistry(env, { ownerSessionId: owner });
  await resumed.ready();
  const restored = resumed.get(running.id);
  assert.equal(restored?.status, "failed", "a running record from a dead process is interrupted");
  assert.equal(restored?.toolCallId, "call_running", "…and keeps its tool-call id");
  assert.match(restored?.stderr ?? "", /Interrupted by a process restart/);
  const completed = await resumed.collectCompleted();
  assert.equal(completed.filter((j) => j.id === running.id).length, 1, "the interruption is notified");
  const logAfter = await waitForLog(running.logPath, "· interrupted ·");
  assert.ok(logAfter.includes("· interrupted ·"), "the log gets an interrupted footer");

  const getTool = createGetCommandOutputTool({
    context: {
      getCommandService: () => ({
        poll: async (jobId) => {
          await resumed.ready();
          const result = resumed.poll(jobId);
          if (!result) throw new Error(`Unknown background jobId: ${jobId}`);
          return result;
        },
      }),
    },
  });
  const out = await getTool.execute({ jobId: running.id }, {});
  assert.equal(out.status, "failed");
  assert.equal(out.cachedOutputPath, running.logPath, "the log path survives the restart");

  await first.clear();
  await resumed.clear();
}

{
  // Records are scoped to the disk session: a fork/`/new` must not inherit another conversation's
  // background jobs.
  const ownerA = new CommandJobRegistry(env, { ownerSessionId: "ses_scope_a" });
  await ownerA.ready();
  const job = ownerA.create("echo scoped");
  ownerA.markExited(job.id, 0);
  await waitForFileContent(`${COMMAND_JOB_CACHE_DIR}/${job.id}.json`, '"status":"exited"');

  const ownerB = new CommandJobRegistry(env, { ownerSessionId: "ses_scope_b" });
  await ownerB.ready();
  assert.equal(ownerB.get(job.id), undefined, "another session does not restore the record");
  await ownerA.clear();
  await ownerB.clear();
}

// ---------------------------------------------------------------------------
// 14. Background-jobs turn-context section: durable pointer after compaction
// ---------------------------------------------------------------------------
{
  const rows = [
    {
      jobId: "job_running",
      command: "npm run dev",
      status: "running",
      exitCode: null,
      logPath: `.agents/cache/command-jobs/job_running.log`,
      startedAt: 2,
    },
    {
      jobId: "job_done",
      command: "npm test",
      status: "exited",
      exitCode: 0,
      logPath: `.agents/cache/command-jobs/job_done.log`,
      startedAt: 1,
    },
  ];
  const section = formatBackgroundJobsSection(rows);
  assert.ok(section.includes("<background_jobs>"), "section has its tag");
  assert.ok(section.indexOf("job_running") < section.indexOf("job_done"), "running jobs come first");
  assert.ok(section.includes("running") && section.includes("exited (exit 0)"));
  assert.ok(section.includes("job_done.log"), "the durable log pointer is included");
  assert.ok(!section.includes("npm test output"), "output is not duplicated in the pointer");

  assert.equal(formatBackgroundJobsSection([]), undefined, "no jobs → no section");

  // Only `run_command` calls still in the wire count; other tools do not.
  const inContext = collectRunCommandToolCallIds([
    { role: "assistant", toolCalls: [{ id: "call_visible", function: { name: "run_command", arguments: "{}" } }] },
    { role: "assistant", toolCalls: [{ id: "call_read", function: { name: "read_file", arguments: "{}" } }] },
  ]);
  assert.deepEqual([...inContext], ["call_visible"], "only run_command tool calls are pointers");

  const many = Array.from({ length: 8 }, (_, i) => ({
    ...rows[1],
    jobId: `job_${i}`,
    startedAt: i,
  }));
  const capped = formatBackgroundJobsSection(many);
  assert.ok(capped.includes("more job(s)"), "the list is capped with a pointer to the rest");

  // The real middleware: admission is content-only and read back from the wire it is handed, so a
  // section that survives a compaction keeps suppressing itself and a section the cut dropped is
  // re-admitted — with no generation counter and no remembered hash table. Only jobs whose tool
  // call is still in the wire are listed.
  {
    const ctxRows = [
      { ...rows[1], jobId: "job_ctx", toolCallId: "call_ctx", command: "npm test", status: "exited", exitCode: 0 },
      { ...rows[1], jobId: "job_hidden", toolCallId: "call_hidden", command: "npm run dev", status: "running" },
    ];
    let messages = [{ id: "u1", role: "user", parts: [{ type: "text", content: "hi" }] }];
    const ui = {
      getMessages: () => messages,
      setMessages: (next) => (messages = next),
      // The staleness guard samples the session generation (a switch invalidates the injection).
      getSessionGeneration: () => 0,
    };
    const toolCallMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_ctx", function: { name: "run_command", arguments: "{}" } }],
    };
    // The pipeline re-projects the wire from the channel on every model call.
    const projectWire = (summary = false) => [
      ...(summary ? [{ role: "user", content: "<CONVERSATION SUMMARY>…</CONVERSATION SUMMARY>" }] : []),
      toolCallMessage,
    ];
    const commandService = {
      sectionFor: async (wireMessages, options = {}) => {
        const ids = collectRunCommandToolCallIds(wireMessages);
        const visible = ctxRows.filter(
          (row) => (!row.toolCallId || ids.has(row.toolCallId)) && !options.excludeJobIds?.has(row.jobId)
        );
        const content = formatBackgroundJobsSection(visible);
        return content ? { key: TURN_CONTEXT_KINDS.backgroundJobs, content } : undefined;
      },
      collectCompleted: async () => [],
      markNotified: async () => {},
    };
    // The pointer belongs to the background middleware now — turn-context is hash-admitted
    // sections only.
    const middleware = createBackgroundMiddleware({
      getUIChannel: () => ui,
      persistMessages: () => {},
      getCommandService: () => commandService,
      getParentId: () => undefined,
    });

    const first = await middleware.onConfig({}, { messages: projectWire() });
    const ctxCount = () => messages.filter((message) => message.id.startsWith("ctx-background_jobs-")).length;
    assert.equal(ctxCount(), 1, "the section is admitted once");
    const firstText = (first.messages ?? []).map((message) => String(message.content)).join("\n");
    assert.ok(firstText.includes("job_ctx"), "the in-context job is listed");
    assert.ok(!firstText.includes("job_hidden"), "a job whose tool call left the wire is not listed");

    // Same window (the injected row is projected back): no re-admission.
    await middleware.onConfig({}, { messages: messages.map((m) => ({ role: m.role, content: m.parts[0].content })) });
    assert.equal(ctxCount(), 1, "an unchanged, still-visible section is not re-injected");

    // A job the wire already announces (its completion notification is visible) is NOT listed:
    // the pointer is the safety net for an announcement a cut removed, not a second copy.
    const notification = formatContextSectionUserContent({
      key: TURN_CONTEXT_KINDS.backgroundNotification,
      content: formatSectionTag(
        TURN_CONTEXT_KINDS.backgroundNotification,
        "Job job_ctx finished with status completed."
      ),
      attrs: { jobs: "job_ctx" },
    });
    const announcedWire = [...projectWire(), { role: "user", content: notification }];
    const announced = await middleware.onConfig({}, { messages: announcedWire });
    assert.equal(announced.messages, undefined, "an announced job needs no pointer");

    // A compaction that dropped both the notification and the section re-admits the pointer:
    // that is the repair path.
    const second = await middleware.onConfig({}, { messages: projectWire(true) });
    assert.equal(ctxCount(), 2, "a cut that dropped the section re-admits it");
    assert.ok(
      (second.messages ?? []).some(
        (message) => String(message.content).includes("job_ctx") && !String(message.content).includes("job_hidden")
      ),
      "…with the current job list"
    );
  }

  // One pass, real completion: the notification is the core delivery and lands first; the pointer
  // then omits the job it just announced (no duplicate result in the same prompt).
  {
    let channelRows = [{ id: "u1", role: "user", parts: [{ type: "text", content: "hi" }] }];
    const ui = {
      getMessages: () => channelRows,
      setMessages: (next) => (channelRows = next),
      getSessionGeneration: () => 0,
    };
    const notified = [];
    const completedJob = {
      id: "job_done",
      command: "npm test",
      status: "exited",
      exitCode: 0,
      stdout: "all good\n",
      stderr: "",
      logPath: ".agents/cache/command-jobs/job_done.log",
      toolCallId: "call_ctx",
    };
    const service = {
      sectionFor: async (wireMessages, options = {}) => {
        const ids = collectRunCommandToolCallIds(wireMessages);
        const rows = [completedJob].filter((row) => ids.has(row.toolCallId) && !options.excludeJobIds?.has(row.id));
        const content = formatBackgroundJobsSection(rows);
        return content ? { key: TURN_CONTEXT_KINDS.backgroundJobs, content } : undefined;
      },
      collectCompleted: async () => [completedJob],
      markNotified: async (ids) => notified.push(...ids),
    };
    const middleware = createBackgroundMiddleware({
      getUIChannel: () => ui,
      persistMessages: () => {},
      getCommandService: () => service,
      getParentId: () => undefined,
    });
    const wire = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_ctx", function: { name: "run_command", arguments: "{}" } }],
      },
    ];
    const out = await middleware.onConfig({}, { messages: wire });
    const injectedRows = (out.messages ?? wire).slice(wire.length).map((message) => String(message.content));
    assert.equal(injectedRows.length, 1, "only the notification is injected");
    assert.ok(injectedRows[0].includes("Job job_done finished"), "the notification comes first");
    assert.ok(!injectedRows[0].includes("<background_jobs>"), "the pointer is not duplicated in the same pass");
    assert.equal(
      contextAttributesFromText(injectedRows[0]).jobs,
      "job_done",
      "the notification carries the machine-readable job ids the pointer uses to skip it"
    );
    assert.deepEqual(notified, ["job_done"], "the completion is marked delivered");

    // Next pass (notification still in the window): still no pointer — the result is visible.
    const nextWire = [...wire, { role: "user", content: injectedRows[0] }];
    const next = await middleware.onConfig({}, { messages: nextWire });
    assert.equal(next.messages, undefined, "an announced job stays out of the pointer");

    // The cut removed the notification: the pointer reappears as the safety net.
    const cutWire = [...wire];
    const repaired = await middleware.onConfig({}, { messages: cutWire });
    const repairedRows = (repaired.messages ?? cutWire).slice(cutWire.length).map((m) => String(m.content));
    assert.equal(repairedRows.length, 1, "the pointer is re-admitted after the announcement was cut");
    assert.ok(repairedRows[0].includes("<background_jobs>") && repairedRows[0].includes("job_done"));
  }

  // Multiple background completions batch into ONE notification; the persisted text is what session
  // search indexes. (The notification is intentionally NOT filtered by the wire: it is the durable
  // result, while the section above is only a pointer for in-context jobs.)
  {
    const owner = "ses_notify_batch";
    const batch = new CommandJobRegistry(env, { ownerSessionId: owner });
    await batch.ready();
    const firstJob = batch.create("npm test", "call_a");
    batch.appendStdout(firstJob.id, "first output\n");
    batch.markExited(firstJob.id, 0);
    const secondJob = batch.create("npm run build", "call_b");
    batch.appendStdout(secondJob.id, "second output\n");
    batch.markExited(secondJob.id, 0);
    await waitForFileContent(`${COMMAND_JOB_CACHE_DIR}/${firstJob.id}.json`, '"status":"exited"');
    await waitForFileContent(`${COMMAND_JOB_CACHE_DIR}/${secondJob.id}.json`, '"status":"exited"');

    let notificationMessages = [];
    const ui = {
      getMessages: () => notificationMessages,
      setMessages: (next) => (notificationMessages = next),
      getSessionGeneration: () => 0,
    };
    const commandService = {
      collectCompleted: () => batch.collectCompleted(),
      markNotified: (ids) => batch.markNotified(ids),
    };
    const middleware = createBackgroundMiddleware({
      getUIChannel: () => ui,
      persistMessages: (next) => (notificationMessages = next),
      getCommandService: () => ({ ...commandService, sectionFor: async () => undefined }),
      getParentId: () => undefined,
    });
    await middleware.onConfig({}, { messages: [], systemPrompts: [] });
    const notificationRows = notificationMessages.filter((message) =>
      message.id.startsWith("ctx-background_notification-")
    );
    assert.equal(notificationRows.length, 1, "two completions produce ONE notification row");
    const text = notificationRows[0]?.parts?.map((part) => part.content).join("\n") ?? "";
    assert.ok(text.includes(firstJob.id) && text.includes(secondJob.id), "both job ids are in the batch");
    assert.ok(text.includes("first output") && text.includes("second output"), "both results are persisted/searchable");

    const after = new CommandJobRegistry(env, { ownerSessionId: owner });
    await after.ready();
    assert.deepEqual(await after.collectCompleted(), [], "both completions were marked delivered");
    await batch.clear();
    await after.clear();
  }
}

// ---------------------------------------------------------------------------
// 15. Graceful teardown keeps un-notified terminal records (idle completion)
// ---------------------------------------------------------------------------
{
  const owner = "ses_graceful";
  const first = new CommandJobRegistry(env, { ownerSessionId: owner });
  await first.ready();
  const unNotified = first.create("echo pending");
  first.appendStdout(unNotified.id, "pending output\n");
  first.markExited(unNotified.id, 0);
  await waitForFileContent(`${COMMAND_JOB_CACHE_DIR}/${unNotified.id}.json`, '"status":"exited"');

  const notified = first.create("echo seen");
  first.markExited(notified.id, 0);
  await first.collectCompleted(); // default marks everything un-notified, including `unNotified`
  // Recreate an un-notified terminal job after the drain: it represents a completion that arrived
  // while the session was idle and the process then quit before the next LLM call.
  const idle = first.create("echo idle");
  first.markExited(idle.id, 0);
  await waitForFileContent(`${COMMAND_JOB_CACHE_DIR}/${idle.id}.json`, '"status":"exited"');

  await first.destroyAll();
  assert.equal(
    await fs.promises.access(abs(`${COMMAND_JOB_CACHE_DIR}/${idle.id}.json`)).then(
      () => true,
      () => false
    ),
    true,
    "a graceful quit keeps an un-notified terminal record"
  );
  assert.equal(
    await fs.promises.access(abs(`${COMMAND_JOB_CACHE_DIR}/${notified.id}.json`)).then(
      () => true,
      () => false
    ),
    false,
    "an already-notified terminal record is removed"
  );

  const resumed = new CommandJobRegistry(env, { ownerSessionId: owner });
  await resumed.ready();
  assert.equal(resumed.get(idle.id)?.status, "exited", "the kept record restores");
  const completed = await resumed.collectCompleted();
  assert.equal(completed.filter((j) => j.id === idle.id).length, 1, "…and delivers its completion");
  await resumed.clear();
}

// ---------------------------------------------------------------------------
// 16. Per-job owner snapshot: a session-id switch does not re-file a running job
// ---------------------------------------------------------------------------
{
  let owner = "ses_before_switch";
  const registryA = new CommandJobRegistry(env, { ownerSessionId: () => owner });
  await registryA.ready();
  const job = registryA.create("echo survives-clear");
  await waitForFileContent(`${COMMAND_JOB_CACHE_DIR}/${job.id}.json`, '"status":"running"');
  owner = "ses_after_switch";
  registryA.markExited(job.id, 0);
  await waitForFileContent(`${COMMAND_JOB_CACHE_DIR}/${job.id}.json`, '"status":"exited"');

  const record = JSON.parse(await fs.promises.readFile(abs(`${COMMAND_JOB_CACHE_DIR}/${job.id}.json`), "utf-8"));
  assert.equal(record.ownerSessionId, "ses_before_switch", "the record stays filed to the starting session");
  assert.deepEqual(
    await registryA.collectCompleted(),
    [],
    "the switched conversation does not receive the old job's completion"
  );
  assert.deepEqual(registryA.listForTurnContext(), [], "…and the old job is not in its model-facing pointer");

  const after = new CommandJobRegistry(env, { ownerSessionId: "ses_after_switch" });
  await after.ready();
  assert.equal(after.get(job.id), undefined, "the new session does not inherit the old job");
  const before = new CommandJobRegistry(env, { ownerSessionId: "ses_before_switch" });
  await before.ready();
  assert.equal(before.get(job.id)?.status, "exited", "the starting session owns the record");
  await registryA.clear();
  await before.clear();
  await after.clear();
}

// ---------------------------------------------------------------------------
// 17. AgentCommandService: the agent-facing owner (registry + section)
// ---------------------------------------------------------------------------
{
  const owner = "ses_background_service";
  const events = [];
  const service = new AgentCommandService({
    env: () => env,
    ownerSessionId: () => owner,
    onJobsChange: ({ jobs }) => events.push(jobs.map((job) => job.jobId)),
  });
  const startEnv = {
    ...env,
    startCommand: async (_command, options) => {
      options.onStdout?.("service output\n");
      options.onExit?.(0);
      return { kill: async () => true, pid: 4343 };
    },
  };
  const started = await service.startBackground({
    command: "echo service",
    toolCallId: "call_service",
    coreEnv: startEnv,
  });
  const job = { id: started.jobId };
  await waitForFileContent(`${COMMAND_JOB_CACHE_DIR}/${job.id}.json`, '"status":"exited"');
  await service.ready();

  const section = await service.sectionFor(
    [
      {
        role: "assistant",
        toolCalls: [{ id: "call_service", function: { name: "run_command", arguments: "{}" } }],
      },
    ],
    0
  );
  assert.ok(section?.content.includes(job.id), "the service builds the in-context section");
  assert.ok(events.length > 0, "the registry's change listener is wired by the service");
  assert.equal(service.list().length, 1, "the non-creating list sees the job");
  assert.equal(await service.sectionFor([], 0), undefined, "an empty wire has no pointer");

  const completed = await service.collectCompleted();
  assert.ok(
    completed.some((entry) => entry.id === job.id),
    "the service exposes the completion queue"
  );
  await service.markNotified([job.id]);
  assert.deepEqual(await service.collectCompleted(), [], "marking is exactly-once");
  await service.reset("session-switch");
  assert.deepEqual(service.list(), [], "reset tears the session registry down");
}

// ---------------------------------------------------------------------------
// 18. AgentCommandService: start / poll / kill through the real service
// ---------------------------------------------------------------------------
{
  const owner = "ses_command_service_lifecycle";
  const service = new AgentCommandService({
    env: () => env,
    ownerSessionId: () => owner,
    onJobsChange: () => {},
  });
  const startEnv = {
    ...env,
    startCommand: async (_command, options) => {
      options.onStdout?.("background output\n");
      options.onStderr?.("background error\n");
      options.onExit?.(0);
      return { kill: async () => true, pid: 4242 };
    },
  };

  const started = await service.startBackground({
    command: "echo background",
    toolCallId: "call_background",
    coreEnv: startEnv,
  });
  assert.equal(typeof started.jobId, "string", "startBackground returns the job id");
  assert.equal(typeof started.cachedOutputPath, "string", "startBackground returns the durable log path");
  await waitForFileContent(`${COMMAND_JOB_CACHE_DIR}/${started.jobId}.json`, '"status":"exited"');

  const polled = await service.poll(started.jobId);
  assert.equal(polled.status, "exited");
  assert.match(polled.stdout, /background output/);
  assert.match(polled.stderr, /background error/);

  const killed = await service.kill(started.jobId);
  assert.equal(killed.killed, false, "an exited job is not killed again");
  assert.equal(killed.status, "exited");
  assert.equal(typeof killed.logPath, "string", "kill returns the durable log path");

  await service.destroy();
  assert.deepEqual(service.list(), [], "destroy tears the command service registry down");
}

// ---------------------------------------------------------------------------
// 19. A reset during startCommand kills the just-started process
// ---------------------------------------------------------------------------
{
  const owner = "ses_command_service_start_race";
  const service = new AgentCommandService({
    env: () => env,
    ownerSessionId: () => owner,
    onJobsChange: () => {},
  });
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  let markStartEntered;
  const startEntered = new Promise((resolve) => {
    markStartEntered = resolve;
  });
  let killCalls = 0;
  const startEnv = {
    ...env,
    startCommand: async () => {
      markStartEntered();
      await startGate;
      return {
        pid: 4242,
        kill: async () => {
          killCalls += 1;
        },
      };
    },
  };

  const starting = service.startBackground({
    command: "long-lived",
    toolCallId: "call_start_race",
    coreEnv: startEnv,
  });
  await startEntered;
  await service.reset("session-switch");
  releaseStart();
  await assert.rejects(starting, /cancelled because its session closed/);
  assert.equal(killCalls, 1, "reset kills a process that returned after the registry was destroyed");
}

await registry.destroyAll();

console.log("command-job-registry validation passed");

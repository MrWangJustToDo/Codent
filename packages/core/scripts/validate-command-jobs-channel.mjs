/**
 * Validates the retained `jobs` channel end to end: a background `run_command` job's lifecycle
 * reaches extensions as a snapshot, and the built-in Jobs extension turns that into exactly one
 * footer line.
 *
 * Four layers, each of which can stop working on its own while the others stay green:
 *  1. `CommandJobRegistry` → change callback: membership + lifecycle changes notify, output
 *     appends do not (they are far too frequent to broadcast and carry nothing to display), and
 *     only the terminal transition reports `finished` ids (create/restore/clear are bookkeeping,
 *     and the idle wake in `ManagedAgent` must not treat a restored record as news).
 *  2. Event → channel wiring: `session:jobs` maps to the retained `jobs` channel, the channel is
 *     in the default set (an opt-in channel is one no remote client ever receives), it is
 *     classified observable for extensions, and it deliberately carries NO event→log rule.
 *  3. `createJobsExtension` → footer slot: one line, the 1s tick only while a job runs, the slot
 *     removed once nothing runs, and the timer cleared on deactivate (the leak this feature's
 *     risk list calls out: a surviving interval in the long-lived server process).
 *  4. `summarizeJobs` → the text itself: which statuses count, which elapsed time is shown, and
 *     the empty / finished-only / no-running cases that must render nothing at all.
 *
 * Run: pnpm --filter @codent/core run validate:command-jobs-channel
 */

import assert from "node:assert/strict";

import {
  AGENT_EVENT_META,
  AGENT_SESSION_CHANNELS,
  CommandJobRegistry,
  DEFAULT_AGENT_SESSION_CHANNELS,
  DEFAULT_EVENT_LOG_RULES,
  EXTENSION_EVENT_VISIBILITY,
  createJobsExtension,
  registerCoreEnv,
  summarizeJobs,
} from "../dist/dev.mjs";

// The registry resolves CoreEnv lazily (for the durable job log + stale sweep). This stub has no
// `fs.appendFile`, so logging degrades to `null` and nothing touches disk.
registerCoreEnv({
  rootPath: "/workspace",
  getPlatform: async () => "test",
  getArch: async () => "arm64",
  getEnv: async () => ({}),
  homedir: async () => "/home/test",
  fs: {
    readFile: async () => "",
    stat: async () => ({ isDirectory: false, isFile: false, size: 0, mtime: new Date() }),
    readdir: async () => [],
    writeFile: async () => {},
    mkdir: async () => {},
    exists: async () => false,
  },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ESC = "\u001b";
const STYLE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Strip ANSI styling — assertions read the visible text while the style is asserted separately. */
function plain(line) {
  return line === null ? null : line.replace(STYLE, "");
}

/** A registry job summary, shaped exactly as the channel payload carries it. */
function summary({
  jobId,
  command = "sleep 30",
  status,
  exitCode = null,
  startedAt,
  endedAt = null,
  pendingPickup = status !== "running",
}) {
  return { jobId, command, status, exitCode, startedAt, endedAt, pendingPickup };
}

// ============================================================================
// 1. Registry change notification
// ============================================================================

{
  const registry = new CommandJobRegistry();
  /** Every change payload, in order. */
  const notified = [];
  /** Just the `finished` id batches — the list a consumer uses to tell news from bookkeeping. */
  const finishedBatches = [];
  registry.setChangeListener((change) => {
    notified.push(change);
    finishedBatches.push(change.finished);
  });
  const jobsOf = (change) => change.jobs;

  // (a) Every membership / lifecycle change notifies.
  const job = registry.create("sleep 30");
  assert.equal(notified.length, 1, "(a) create notifies");
  assert.deepEqual(
    jobsOf(notified[0]).map((j) => j.jobId),
    [job.id],
    "(a) the notification carries the job"
  );
  // …but creating a job is not a completion: the idle-wake consumer must not start a turn for it.
  assert.deepEqual(finishedBatches[0], [], "(a) create reports no finished job");

  // Output appends are the hot path and must not notify.
  registry.appendStdout(job.id, "partial output\n");
  registry.appendStderr(job.id, "warning\n");
  assert.equal(notified.length, 1, "(a) output appends do not notify");

  // `kill` handles and raw output must not cross the boundary: the payload is replayed to remote
  // clients and persisted nowhere, so it stays JSON-serializable and summary-only.
  assert.deepEqual(Object.keys(jobsOf(notified[0])[0]).sort(), [
    "command",
    "endedAt",
    "exitCode",
    "jobId",
    "pendingPickup",
    "startedAt",
    "status",
  ]);

  registry.markExited(job.id, 0);
  assert.equal(notified.length, 2, "(a) markExited notifies");
  assert.equal(jobsOf(notified[1])[0].status, "exited", "(a) markExited reports the real status");
  assert.deepEqual(finishedBatches[1], [job.id], "(a) markExited is the transition that reports a finished job");

  // A second terminal transition on a finished job is a no-op (and so is its notification).
  registry.markExited(job.id, 0);
  assert.equal(notified.length, 2, "(a) a repeat terminal transition does not re-notify");

  // (c) Ownership: a finished job this session can never be handed is not owed here. The line would
  // otherwise count a completion that `collectCompleted` filters out (another session's job), i.e. a
  // pending badge that can never clear.
  {
    let owner = "ses-a";
    const scoped = new CommandJobRegistry(undefined, { ownerSessionId: () => owner });
    const job = scoped.create("sleep 5");
    scoped.markExited(job.id, 0);
    assert.equal(scoped.list()[0].pendingPickup, true, "(c) this session's finished job is pending");
    owner = "ses-b";
    assert.equal(
      scoped.list()[0].pendingPickup,
      false,
      "(c) …but one owned by another session is not, since it can never be delivered here"
    );
  }

  // (b) A finished job stays `pendingPickup` until its completion is handed to the message window,
  // and the delivery re-notifies: the retained snapshot is what the footer renders, so without this
  // event the line would keep counting a job the model already received.
  assert.equal(jobsOf(notified[0])[0].pendingPickup, false, "(b) a running job is never pending");
  assert.equal(jobsOf(notified[1])[0].pendingPickup, true, "(b) a finished job is pending pickup");
  await registry.markNotified([job.id]);
  assert.equal(notified.length, 3, "(b) marking the delivery re-notifies — the visible state changed");
  assert.equal(jobsOf(notified[2])[0].pendingPickup, false, "(b) …and the pending flag clears");
  assert.deepEqual(finishedBatches[2], [], "(b) a delivery is not a completion: no finished ids, no wake");

  const failing = registry.create("exit 1");
  registry.markFailed(failing.id, "boom");
  assert.equal(jobsOf(notified.at(-1)).find((j) => j.jobId === failing.id).status, "failed");
  assert.deepEqual(notified.at(-1).finished, [failing.id], "(a) markFailed reports the finished job");

  const killed = registry.create("sleep 300");
  registry.markKilled(killed.id);
  assert.equal(jobsOf(notified.at(-1)).find((j) => j.jobId === killed.id).status, "killed");
  assert.deepEqual(notified.at(-1).finished, [killed.id], "(a) markKilled reports the finished job");

  // Eviction / clear are bookkeeping: terminal rows leave the list, but nothing just finished.
  registry.clear();
  assert.deepEqual(notified.at(-1).jobs, [], "(a) clear drops the list");
  assert.deepEqual(notified.at(-1).finished, [], "(a) clear reports no finished job");

  // No listener → no crash (the registry is also constructed standalone/ambient).
  const bare = new CommandJobRegistry();
  const bareJob = bare.create("echo hi");
  bare.markExited(bareJob.id, 0);
  bare.clear();
}

// ============================================================================
// 2. Event → channel wiring
// ============================================================================

{
  // (b) The retained projection.
  assert.equal(AGENT_EVENT_META["session:jobs"]?.channel, "jobs", "(b) session:jobs maps to the jobs channel");
  assert.equal(AGENT_EVENT_META["session:jobs"]?.retained, true, "(b) the jobs channel is retained");
  assert.equal(AGENT_EVENT_META["session:jobs"]?.mode, "emit", "(b) it is an observer event");

  assert.ok(AGENT_SESSION_CHANNELS.includes("jobs"), "jobs is a declared session channel");
  assert.equal(
    DEFAULT_AGENT_SESSION_CHANNELS.includes("jobs"),
    true,
    "jobs is a default channel — a remote client that had to opt in would never receive it"
  );

  // Exhaustiveness is compile-checked; this pins the classification the extension surface reads.
  assert.equal(EXTENSION_EVENT_VISIBILITY["session:jobs"], "observable", "extensions may observe it");

  // Deliberate absence: job start/stop must not write a log line per event. The suppression is
  // EXPLICIT (`false`), not an omission — the table's other half is exhaustive, so a projection
  // event that nobody classified would be indistinguishable from one deliberately left silent.
  assert.equal(DEFAULT_EVENT_LOG_RULES["session:jobs"], false, "session:jobs is an explicit suppression");
}

// ============================================================================
// 3. The built-in extension
// ============================================================================

/** Minimal ExtensionContext: the extension touches only `ui.render` and `events.observe`. */
function createHarness() {
  const renders = [];
  const subscriptions = [];
  const ctx = {
    id: "codent-jobs",
    ui: { render: (surface, key, payload) => renders.push({ surface, key, payload }) },
    events: {
      observe: (type, handler) => {
        subscriptions.push({ type, handler });
        return () => {};
      },
    },
  };
  const emit = (jobs) => {
    for (const { type, handler } of subscriptions) {
      if (type === "session:jobs") handler({ type: "session:jobs", payload: { jobs } });
    }
  };
  return { ctx, renders, subscriptions, emit };
}

{
  const h = createHarness();
  createJobsExtension().activate(h.ctx);

  assert.equal(h.subscriptions.length, 1, "the extension subscribes once");
  assert.equal(h.subscriptions[0].type, "session:jobs", "and to the jobs event");

  // An empty first snapshot must cost nothing: the slot was never set, so there is nothing to clear.
  h.emit([]);
  assert.equal(h.renders.length, 0, "an empty snapshot renders nothing at all");

  // One running job → exactly one footer line.
  const startedAt = Date.now() - 2000;
  h.emit([summary({ jobId: "job-1", status: "running", startedAt })]);
  assert.equal(h.renders.length, 1, "a running job renders one line");
  assert.equal(h.renders[0].surface, "footer");
  assert.equal(h.renders[0].key, "jobs", "into its own slot, so it cannot overwrite another extension's");
  assert.equal(typeof h.renders[0].payload, "string", "the payload is raw text (JSON-safe across a process boundary)");
  assert.ok(
    h.renders[0].payload.startsWith(`${ESC}[33m⏳${ESC}[0m ${ESC}[90m1 running · `),
    "the line opens with an amber glyph and gray counts"
  );
  // Styling is ANSI (core cannot reach the host theme), a trailing reset is mandatory so the
  // color does not bleed into the surrounding footer, and no other escape may ride along.
  assert.match(h.renders[0].payload, new RegExp(`${ESC}\\[0m$`), "the line resets its styling");
  assert.equal(
    h.renders[0].payload.match(STYLE).join("|"),
    "\u001b[33m|\u001b[0m|\u001b[90m|\u001b[0m",
    "only the intended SGR codes are emitted, and the line ends reset"
  );

  // Nothing running any more and nothing owed → the slot is revoked (the one-line shape has no
  // item to dim).
  h.emit([]);
  assert.equal(h.renders.at(-1).payload, null, "no jobs at all removes the slot");

  // …and a repeat revoke does not re-notify.
  const afterRevoke = h.renders.length;
  h.emit([]);
  assert.equal(h.renders.length, afterRevoke, "a repeat empty snapshot is deduped");

  // A finished-only list whose results were all picked up also renders nothing (it is not an error
  // state: the outcomes live in the transcript).
  const done = createHarness();
  createJobsExtension().activate(done.ctx);
  done.emit([
    summary({
      jobId: "job-done",
      status: "exited",
      exitCode: 0,
      startedAt: Date.now() - 5000,
      endedAt: Date.now(),
      pendingPickup: false,
    }),
  ]);
  assert.equal(done.renders.length, 0, "a finished, picked-up job renders nothing");

  // …but a finished job whose result is still owed KEEPS the slot. This is the whole point of the
  // state: the process is gone, so nothing else on screen says the run produced something.
  const owed = createHarness();
  createJobsExtension().activate(owed.ctx);
  owed.emit([
    summary({
      jobId: "job-owed",
      status: "exited",
      exitCode: 0,
      startedAt: Date.now() - 5000,
      endedAt: Date.now(),
      pendingPickup: true,
    }),
  ]);
  assert.equal(owed.renders.length, 1, "a finished job awaiting pickup renders a line");
  assert.equal(plain(owed.renders[0].payload), "✓ 1 pending", "and says so instead of showing an elapsed time");
  assert.ok(owed.renders[0].payload.startsWith(`${ESC}[33m✓${ESC}[0m`), "the glyph is a tick: no wait is in progress");

  // Delivery clears it — the same snapshot with the flag flipped revokes the slot. No tick is
  // needed to notice: the registry re-notifies when it marks the delivery.
  owed.emit([
    summary({
      jobId: "job-owed",
      status: "exited",
      exitCode: 0,
      startedAt: Date.now() - 5000,
      endedAt: Date.now(),
      pendingPickup: false,
    }),
  ]);
  assert.equal(owed.renders.at(-1).payload, null, "picking the result up removes the slot");
}

// --- the elapsed-time tick (1s, only while something runs) -------------------

{
  const h = createHarness();
  const ext = createJobsExtension();
  ext.activate(h.ctx);

  h.emit([summary({ jobId: "job-1", status: "running", startedAt: Date.now() - 3000 })]);
  const afterFirstPaint = h.renders.length;

  await sleep(1150);
  assert.ok(h.renders.length > afterFirstPaint, "the tick repaints while a job is running");
  // The payload must actually differ: the render slot dedupes an identical payload, so a tick that
  // recomputed the same string would be invisible to the host. Compare the plain text — the styling
  // is constant across ticks, so a styled comparison would pass even if the clock never advanced.
  assert.notEqual(plain(h.renders.at(-1).payload), plain(h.renders[0].payload), "the tick emits a changed line");

  // Job finishes → the tick stops (this is the "no running job, no timer" half).
  h.emit([]);
  const afterStop = h.renders.length;
  await sleep(1200);
  assert.equal(h.renders.length, afterStop, "the tick stops once nothing is running");

  // Deactivate is the other half: a session that is torn down while a job still runs must not
  // leave the interval behind in a long-lived host process.
  const live = createHarness();
  const liveExt = createJobsExtension();
  liveExt.activate(live.ctx);
  live.emit([summary({ jobId: "job-2", status: "running", startedAt: Date.now() - 1000 })]);
  await sleep(1100);
  assert.ok(live.renders.length > 1, "the tick is running before deactivate");
  await liveExt.deactivate();
  const afterDeactivate = live.renders.length;
  await sleep(1200);
  assert.equal(live.renders.length, afterDeactivate, "deactivate clears the timer");

  await ext.deactivate();
}

// ============================================================================
// 4. The summary text
// ============================================================================

{
  const now = 10_000_000;
  const running = (ms) => summary({ jobId: `j-${ms}`, status: "running", startedAt: now - ms });
  const finished = (status, exitCode = 0) =>
    summary({ jobId: `j-${status}`, status, exitCode, startedAt: now - 60_000, endedAt: now - 59_000 });
  /** The same outcome after the completion reached the message window. */
  const pickedUp = (status, exitCode = 0) => ({ ...finished(status, exitCode), pendingPickup: false });

  assert.equal(summarizeJobs([], now), null, "no jobs → no line");
  assert.equal(
    summarizeJobs([pickedUp("exited"), pickedUp("failed", 1)], now),
    null,
    "finished AND picked up → no line"
  );

  // A finished job that has not been picked up KEEPS the line — that is the state this surface
  // exists for. No duration: nothing is being waited on, and the tick glyph says so.
  assert.equal(plain(summarizeJobs([finished("exited")], now)), "✓ 1 pending", "an owed success keeps the line");
  assert.equal(
    plain(summarizeJobs([finished("exited"), finished("killed", null)], now)),
    "✓ 1 killed · 2 pending",
    "owed outcomes are counted, and every owed job is counted as pending"
  );

  // The shipped line is ANSI-styled; the assertions read its plain text so the style is not
  // repeated in every expected string. The style itself is asserted above.
  assert.equal(plain(summarizeJobs([running(2000)], now)), "⏳ 1 running · 2.0s");
  assert.equal(plain(summarizeJobs([running(90_000)], now)), "⏳ 1 running · 1m 30s");

  // Counts lead with what the user is waiting on, and `exited` is never counted — a success is the
  // uninteresting outcome, so a mixed line must not bury the failure behind it. The pending count
  // trails both, because it applies to jobs of any status.
  const mixed = plain(summarizeJobs([running(5000), running(1000), finished("failed", 1)], now));
  assert.equal(mixed, "⏳ 2 running · 1 failed · 1 pending · 5.0s");
  assert.doesNotMatch(mixed, /exited/, "successful jobs are not listed");

  assert.equal(
    plain(summarizeJobs([running(1000), finished("killed", null)], now)),
    "⏳ 1 running · 1 killed · 1 pending · 1.0s"
  );

  // A picked-up success contributes nothing but does not hide the running job beside it.
  assert.equal(plain(summarizeJobs([running(1000), pickedUp("exited")], now)), "⏳ 1 running · 1.0s");

  // Elapsed time is the OLDEST running job's age (what the user is still waiting on), not the newest.
  assert.match(
    plain(summarizeJobs([running(1000), running(30_000)], now)),
    /· 30\.0s$/,
    "elapsed follows the oldest running job"
  );

  // A finished job's own age never enters the line, however long ago it finished.
  const stale = finished("failed", 1);
  assert.equal(plain(summarizeJobs([running(1000), stale], now)), "⏳ 1 running · 1 failed · 1 pending · 1.0s");

  // Sub-second elapsed still formats (formatDuration's ms branch).
  assert.equal(plain(summarizeJobs([running(250)], now)), "⏳ 1 running · 250ms");
}

console.log("command-jobs-channel validation passed");

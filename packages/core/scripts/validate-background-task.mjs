/* eslint-disable max-lines -- one end-to-end scenario per layer of the background-work trunk (facade, ledger, detached seat, wake, footer, running handle). They share the same temp workspace, a real ManagedAgent and the same fake CoreEnv; splitting them across files would duplicate that fixture setup and make the scenarios order-dependent. */
/**
 * `task` (subagent) can run in the background — and it does so on the SAME trunk as a background
 * command, not beside it.
 *
 * What this validator locks down, layer by layer:
 *
 *  1. **The facade** (`BackgroundWorkService`) merges two sources: one row list, one undelivered
 *     queue, per-kind delivery marking, and a session-switch `reset` that publishes the empty list
 *     FIRST so a source settling during the transaction cannot repopulate the channel being left.
 *  2. **The task ledger** (`SubagentRuns` as a source): owner-session scoping, epoch invalidation
 *     (the `closing` equivalent the command service gets for free by being thrown away), idempotent
 *     settling, and the delivered flag that clears the footer's `pending`.
 *  3. **The detached seat**: the run lifecycle (`abortAll`) must not end a background task — only the
 *     session switch (`reset` → `abortDetached`) may. Asserted on a real `ManagedAgent`, so `Esc`
 *     (`managed.abort()`) is the actual call under test.
 *  4. **The wake decision**: a finished background *task* wakes an idle session exactly once, does not
 *     consume the completion, and never fires for a live pump or a subagent.
 *  5. **One line for both kinds** in the footer, with the single-kind line byte-identical to the
 *     command-only version it replaced.
 *  6. **The running handle** is not a result: a host rendering it must not read "empty summary" as a
 *     finished task.
 *  7. **Structure**: one facade construction, two sources — the shape the whole change exists for.
 *
 * Run: pnpm --filter @codent/core run validate:background-task
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BackgroundWorkService,
  SESSION_END_CANCELLED_MESSAGE,
  SubagentRuns,
  cancelInterruptedBackgroundCommands,
  cancelInterruptedBackgroundTasks,
  clearCoreEnv,
  createJobsExtension,
  createRunCommandTool,
  failedTaskOutput,
  formatCommandBody,
  formatNotifications,
  formatTaskModelText,
  getToolMetadata,
  isRunningTaskOutput,
  reconcileSettledTaskParts,
  registerCoreEnv,
  runningTaskOutput,
  startBackgroundTask,
  subagentRuns,
  summarizeJobs,
} from "../dist/dev.mjs";
import { AgentManager, formatToolOutput, getInlineSummary } from "../dist/index.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// ============================================================================
// Fixture
// ============================================================================

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "background-task-"));

registerCoreEnv({
  rootPath,
  getPlatform: async () => "linux",
  getArch: async () => "arm64",
  getEnv: async () => ({}),
  homedir: async () => rootPath,
  fs: {
    readFile: async () => "",
    writeFile: async () => {},
    appendFile: async () => {},
    mkdir: async () => {},
    exists: async () => false,
    readdir: async () => [],
    stat: async () => ({ isDirectory: false, isFile: false, size: 0, mtime: new Date() }),
  },
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => new Response(),
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => sleep(0);
/** Let a chain of awaited steps (cache sweep → cache write → channel write) finish. */
const drain = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await sleep(5);
};

const ESC = "\u001b";
const STYLE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
/** Strip ANSI styling — the line's visible text is what these assertions are about. */
const plain = (line) => (line === null ? null : line.replace(STYLE, ""));

const manager = new AgentManager();

/**
 * A source stub that behaves like the port: rows, unread completions, and a settable sink.
 *
 * Deliberately NOT a copy of either real source — the two real ones are covered below through their
 * own classes. What this one proves is the FACADE's half: merging, per-kind routing, and the ordering
 * of the reset publication.
 */
function fakeSource(kind) {
  const state = { rows: [], completions: [], delivered: new Set(), resets: [], destroys: 0, sink: null };
  return {
    state,
    source: {
      kind,
      list: () => state.rows,
      pending: async () => state.completions.filter((completion) => !state.delivered.has(completion.id)),
      markDelivered: (completions) => {
        for (const completion of completions) state.delivered.add(completion.id);
      },
      reset: (reason) => {
        state.resets.push(reason);
        state.rows = [];
        state.completions = [];
      },
      destroy: () => {
        state.destroys += 1;
      },
      setChangeSink: (sink) => {
        state.sink = sink;
      },
    },
  };
}

const row = (overrides) => ({
  jobId: "x",
  kind: "task",
  label: "explore",
  status: "running",
  exitCode: null,
  startedAt: 0,
  endedAt: null,
  pendingPickup: false,
  ...overrides,
});

const completion = (overrides) => ({
  id: "x",
  kind: "task",
  label: "explore",
  status: "exited",
  exitCode: null,
  body: "BODY",
  ...overrides,
});

// ============================================================================
// 1. The facade: one list, one queue, per-kind delivery
// ============================================================================

{
  const changes = [];
  const work = new BackgroundWorkService({ onChange: (change) => changes.push(change) });
  const commands = fakeSource("command");
  const tasks = fakeSource("task");
  work.register(commands.source);
  work.register(tasks.source);

  assert.equal(typeof commands.state.sink, "function", "registering a source wires its change sink");
  assert.equal(typeof tasks.state.sink, "function", "…for every source, not just the first");

  commands.state.rows = [row({ jobId: "job-1", kind: "command", label: "npm run build" })];
  tasks.state.rows = [row({ jobId: "tc-1", label: "explore the parser" })];
  assert.deepEqual(
    work.list().map((entry) => `${entry.kind}:${entry.jobId}`),
    ["command:job-1", "task:tc-1"],
    "the snapshot is the merge of both sources"
  );

  commands.state.completions = [completion({ id: "job-1", kind: "command" })];
  tasks.state.completions = [completion({ id: "tc-1" })];
  assert.deepEqual(
    (await work.pending()).map((entry) => entry.id),
    ["job-1", "tc-1"],
    "the undelivered queue is merged too — one notification block, not two"
  );

  // Delivery is routed by kind: a completion must reach the source that produced it, and only that
  // one. A single shared "mark everything" would clear another source's queue.
  await work.markDelivered([tasks.state.completions[0]]);
  assert.deepEqual([...tasks.state.delivered], ["tc-1"], "the task completion reached the task source");
  assert.deepEqual([...commands.state.delivered], [], "…and not the command source");
  assert.deepEqual(
    (await work.pending()).map((entry) => entry.id),
    ["job-1"],
    "the other kind's completion is still owed"
  );

  // A source reports a change; the facade owns what it means.
  tasks.state.rows = [row({ jobId: "tc-1", status: "exited", endedAt: 5, pendingPickup: true })];
  changes.length = 0;
  tasks.state.sink(["tc-1"]);
  assert.equal(changes.length, 1, "a source change is published once");
  assert.deepEqual(changes[0].finished, ["tc-1"], "with the finished ids the source reported");
  assert.equal(changes[0].jobs.length, 2, "and the merged list, both kinds");

  // Session switch: the empty publication comes FIRST, so nothing a source settles mid-transaction
  // can land in the channel of the session being left.
  changes.length = 0;
  await work.reset("session-switch");
  assert.deepEqual(
    changes.map((change) => change.jobs.length),
    [0],
    "the reset publishes exactly one snapshot, and it is empty"
  );
  assert.deepEqual(changes[0].finished, [], "a switch is not a completion — nothing is woken for it");
  assert.deepEqual(commands.state.resets, ["session-switch"], "every source is reset");
  assert.deepEqual(tasks.state.resets, ["session-switch"]);
  assert.deepEqual(work.list(), [], "a closed facade reports nothing");
  assert.deepEqual(await work.pending(), [], "and owes nothing");
  // A late settle after the switch must not repopulate the closed facade.
  tasks.state.rows = [row({ jobId: "tc-late", status: "exited" })];
  tasks.state.sink(["tc-late"]);
  assert.equal(changes.length, 1, "a settle after the switch publishes nothing at all");
  assert.deepEqual(await work.pending(), [], "and the closed facade still owes nothing");

  await work.destroy();
  assert.equal(commands.state.destroys, 1, "destroy reaches every source");
  assert.equal(tasks.state.destroys, 1);
}

// ============================================================================
// 2. The task ledger: ownership, epoch, idempotent settle, delivered flag
// ============================================================================

{
  let owner = "ses-a";
  const runs = new SubagentRuns(
    () => 2,
    () => owner
  );
  const changes = [];
  runs.setChangeSink((finished) => changes.push(finished));

  const opened = runs.beginBackground({ toolCallId: "tc-1", label: "explore" });
  assert.equal(opened.status, "running", "a new row is running");
  assert.equal(opened.ownerSessionId, "ses-a", "the owner session is snapshotted at open time");
  assert.deepEqual(changes, [[]], "opening a row publishes a membership change, not a completion");
  assert.deepEqual(runs.pendingBackground(), [], "a running row is never pending");

  // A settle is a one-shot transition: the second must not re-fire `finished` (that is what would
  // wake an idle agent for a result it already received).
  assert.equal(runs.settleBackground("tc-1", { status: "exited", body: "BODY" }), true);
  assert.deepEqual(changes.at(-1), ["tc-1"], "the terminal transition reports the finished id");
  const changeCount = changes.length;
  assert.equal(runs.settleBackground("tc-1", { status: "exited", body: "BODY" }), false);
  assert.equal(changes.length, changeCount, "a repeated settle neither records nor publishes");

  assert.deepEqual(
    runs.pendingBackground().map((run) => run.toolCallId),
    ["tc-1"],
    "a settled, undelivered row is pending"
  );
  runs.markBackgroundDelivered(["tc-1"]);
  assert.deepEqual(changes.at(-1), [], "delivery is membership-only: no finished ids, no wake");
  assert.deepEqual(runs.pendingBackground(), [], "the delivered flag clears the queue");
  assert.equal(runs.backgroundRows()[0].delivered, true, "and the flag is on the row the footer reads");

  // Session attribution (1/3): a row owned by another session is invisible AND undeliverable here.
  // Showing it would be a `pending` badge this session's model can never clear.
  owner = "ses-b";
  assert.deepEqual(runs.backgroundRows(), [], "another session's rows are not listed");
  assert.deepEqual(runs.pendingBackground(), [], "and never owed here");
  owner = "ses-a";
  assert.equal(runs.backgroundRows().length, 1, "switching back sees them again — the filter is a view");

  // Session attribution (2/3): a settle that lands AFTER the switch must be dropped whole. `reset`
  // bumps the epoch because this registry is cached per agent (`WeakMap`), so unlike the command
  // service it survives the switch and could otherwise record into the new conversation.
  const lateEpoch = runs.currentEpoch;
  runs.reset();
  assert.equal(runs.currentEpoch, lateEpoch + 1, "reset bumps the epoch");
  assert.deepEqual(changes.at(-1), [], "and publishes the empty list itself");
  assert.deepEqual(runs.backgroundRows(), [], "the rows of the left session are gone");
  const afterReset = changes.length;
  assert.equal(runs.settleBackground("tc-1", { status: "exited", body: "LATE" }), false);
  assert.equal(changes.length, afterReset, "a late settle publishes nothing");
  assert.deepEqual(runs.backgroundRows(), [], "…and cannot resurrect the row into the new session");

  // Session attribution (3/3): the pre-switch completion is not owed after the switch either — the
  // queue is cleared, not filtered, because a switch means the conversation is over.
  assert.deepEqual(runs.pendingBackground(), [], "nothing is owed into the new session");
}

// ============================================================================
// 3. The detached seat: survives the run lifecycle, ends with the session
// ============================================================================

{
  const runs = new SubagentRuns(
    () => 4,
    () => "ses-a"
  );
  const aborted = [];
  runs.prefork.start(
    "tc-bg",
    () => aborted.push("tc-bg"),
    () => new Promise(() => {})
  );
  assert.ok(runs.prefork.detach("tc-bg"), "the seat is detached (not joined by a blocking call)");
  runs.prefork.abortAll("run-finish");
  assert.deepEqual(aborted, [], "a run-lifecycle discard must NOT stop a background task");
  assert.equal(runs.prefork.isDetached("tc-bg"), true, "the seat is still there");
  runs.prefork.abortAll("run-abort");
  assert.deepEqual(aborted, [], "…and neither does an abort of the run that started it");
  runs.reset();
  assert.deepEqual(aborted, ["tc-bg"], "only the session switch ends it");
  assert.equal(runs.prefork.isDetached("tc-bg"), false, "and it is forgotten");
}

// ============================================================================
// 4. Esc does not kill it — on a real agent, through the real abort path
// ============================================================================

const managed = await manager.createManagedAgent({ name: "background-task", model: "test-model" });
const chat = managed.initChat(manager);
/** Turn starts requested by the wake path — the pump itself is never run here. */
let wakes = 0;
chat.enqueueRunOnce = async () => {
  wakes += 1;
};

const runs = subagentRuns(managed);

{
  const killed = [];
  runs.prefork.start(
    "tc-live",
    () => killed.push("tc-live"),
    () => new Promise(() => {})
  );
  runs.prefork.detach("tc-live");
  managed.abort("user");
  assert.deepEqual(killed, [], "Esc does not kill a background task");
  assert.equal(runs.prefork.isDetached("tc-live"), true, "it keeps streaming");
  managed.reset();
  assert.deepEqual(killed, ["tc-live"], "the session switch does kill it");
}

// ============================================================================
// 5. A finished background task wakes an idle session — exactly once
// ============================================================================

{
  const work = managed.getBackgroundWork();
  runs.beginBackground({ toolCallId: "tc-wake", label: "explore" });
  await flush();
  assert.equal(wakes, 0, "starting a background task is not a completion");

  assert.equal(
    work.list().filter((entry) => entry.kind === "task").length >= 1,
    true,
    "the running task is on the shared snapshot while it runs"
  );
  const taskRow = () => work.list().find((entry) => entry.jobId === "tc-wake");
  assert.equal(taskRow().kind, "task", "the row declares its kind");
  assert.equal(taskRow().label, "explore", "and its label");
  assert.equal(taskRow().exitCode, null, "a task has no exit code (explicit null, not omitted)");
  assert.equal(taskRow().pendingPickup, false, "a running task is not pending");

  runs.settleBackground("tc-wake", { status: "exited", body: "Task summary" });
  await flush();
  assert.equal(wakes, 1, "an idle session is woken by a finished background task");
  assert.equal(taskRow().pendingPickup, true, "and reads as pending until it is delivered");
  assert.deepEqual(
    (await work.pending()).map((entry) => entry.id),
    ["tc-wake"],
    "the wake PEEKS: delivery (and the delivered flag) still belong to the middleware"
  );

  // Delivery is not a completion: no second turn.
  await work.markDelivered(await work.pending());
  await flush();
  assert.equal(wakes, 1, "delivering the notification does not start another turn");
  assert.equal(taskRow().pendingPickup, false, "and the pending flag clears");

  // A live pump already carries the notification to its next model call.
  chat.pumpDepth = 1;
  runs.beginBackground({ toolCallId: "tc-during-run", label: "second" });
  runs.settleBackground("tc-during-run", { status: "exited", body: "Second" });
  await flush();
  assert.equal(wakes, 1, "a completion during a live run starts no second turn");
  await work.markDelivered(await work.pending());
  chat.pumpDepth = 0;

  // A subagent has no user to notify.
  managed.parentId = "parent-agent";
  runs.beginBackground({ toolCallId: "tc-worker", label: "worker" });
  runs.settleBackground("tc-worker", { status: "exited", body: "Worker" });
  await flush();
  assert.equal(wakes, 1, "a subagent's completion never starts a turn");
  await work.markDelivered(await work.pending());
  delete managed.parentId;
}

// ============================================================================
// 6. One footer line for both kinds
// ============================================================================

{
  const now = 10_000_000;
  const changes = [];
  const work = new BackgroundWorkService({ onChange: (change) => changes.push(change) });
  const commands = fakeSource("command");
  const tasks = fakeSource("task");
  work.register(commands.source);
  work.register(tasks.source);

  commands.state.rows = [row({ jobId: "job-1", kind: "command", label: "npm run build", startedAt: now - 12_000 })];
  tasks.state.rows = [row({ jobId: "tc-1", label: "explore the parser", startedAt: now - 5_000 })];
  assert.equal(
    plain(summarizeJobs(work.list(), now)),
    "⏳ 1 command · 1 task · 12s",
    "both kinds share the line, split per kind, with the oldest wait's age"
  );

  // With one kind in the list the line falls back to the command-only wording byte for byte — that
  // equality is the regression baseline the task support was added behind.
  tasks.state.rows = [];
  assert.equal(plain(summarizeJobs(work.list(), now)), "⏳ 1 running · 12s", "a single kind keeps the old wording");

  // The owed-result state, driven by the ledger's delivered flag through the facade. The finished
  // task is TERMINAL, so it must not enter the per-kind split: only running rows decide that word,
  // which is what keeps a single-kind session on the byte-identical baseline after any task ends.
  tasks.state.rows = [row({ jobId: "tc-1", status: "exited", endedAt: now, pendingPickup: true })];
  tasks.state.completions = [completion({ id: "tc-1" })];
  assert.equal(
    plain(summarizeJobs(work.list(), now)),
    "⏳ 1 running · 1 pending · 12s",
    "an owed task keeps the line alive without changing the running wording"
  );
  changes.length = 0;
  await work.markDelivered(await work.pending());
  assert.deepEqual([...tasks.state.delivered], ["tc-1"], "delivery marks the row through the source");
  // The source is a stub here, so flip the flag it would have flipped and re-render: the facade simply
  // reports what the source says.
  tasks.state.rows = [row({ jobId: "tc-1", status: "exited", endedAt: now, pendingPickup: false })];
  assert.equal(
    plain(summarizeJobs(work.list(), now)),
    "⏳ 1 running · 12s",
    "a delivered result stops being counted as pending"
  );
  await work.destroy();
}

// The extension renders that line into its own footer slot, and it renders nothing when the only
// task was delivered — the same two rules the command-only version had.
{
  const renders = [];
  const subscriptions = [];
  createJobsExtension().activate({
    id: "codent-jobs",
    ui: { render: (surface, key, payload) => renders.push({ surface, key, payload }) },
    events: { observe: (type, handler) => subscriptions.push({ type, handler }) },
  });
  const emit = (jobs) => {
    for (const { type, handler } of subscriptions) if (type === "session:jobs") handler({ payload: { jobs } });
  };
  const now = Date.now();
  emit([
    row({ jobId: "job-1", kind: "command", label: "npm run build", startedAt: now - 4000 }),
    row({ jobId: "tc-1", label: "explore", startedAt: now - 2000 }),
  ]);
  assert.equal(plain(renders.at(-1).payload), "⏳ 1 command · 1 task · 4s", "the footer shows both kinds in one row");
  assert.equal(renders.at(-1).surface, "footer", "on the footer surface");
  assert.equal(renders.at(-1).key, "jobs", "in the jobs slot");

  emit([row({ jobId: "tc-1", status: "exited", endedAt: now, pendingPickup: false })]);
  assert.equal(renders.at(-1).payload, null, "a delivered task leaves nothing owed and removes the slot");
}

// ============================================================================
// 7. The running handle is not a result
// ============================================================================

{
  const handle = runningTaskOutput();
  assert.equal(handle.status, "running", "the handle says it is not the result");
  assert.equal(handle.runInBackground, true, "and which phase it came from");
  assert.equal(handle.summary, "", "with no summary yet");
  assert.equal(isRunningTaskOutput(handle), true);
  assert.equal(isRunningTaskOutput({ status: "completed", summary: "x" }), false);
  assert.equal(
    formatToolOutput(handle, "task"),
    "[queued in background]",
    "a queued handle does not render as an empty, finished task"
  );
  assert.equal(
    formatToolOutput({ ...handle, subagentId: "sub_9" }, "task"),
    "[running in background: sub_9]",
    "and names the child once it exists"
  );
  const part = { type: "tool-call", id: "call-1", name: "task", state: "complete", arguments: "{}", output: handle };
  assert.equal(getInlineSummary(part, "task"), "running", "the row reads as running, not as a clean finish");

  // The failure path's shape: a settled output, so the row stops looking live.
  const failure = failedTaskOutput("The background task failed before producing a summary: boom");
  assert.equal(isRunningTaskOutput(failure), false, "a failed background task settles the part");
  assert.equal(failure.status, "completed");
  assert.equal(failure.incomplete, true, "flagged as force-stopped, which is what it is");
  assert.match(formatTaskModelText(failure), /boom/, "and the message survives into the model text");
}

// ============================================================================
// 8. The settle ALWAYS ends the row — every failure mode, one guard
// ============================================================================

/**
 * A background task's row, footer and notification are all derived from ONE settle, so a settle that
 * throws (or a stale check that drops it) is a screen that lies forever: a `running` row, a spinning
 * footer, an empty queue and — worse — an unobserved promise rejection that can kill the host process.
 * `buildTaskOutput` really can throw: its disk-cache write goes through CoreEnv.
 *
 * These calls run against a channel with no tool-CALL part for the ids (nothing issued the call here), so
 * the stream processor logs "Could not find message with tool call …" — that noise is expected in this
 * harness only; in a real run the part exists, because `task` returned the handle that opened it.
 */
{
  const victim = await manager.createManagedAgent({ name: "background-task-settle", model: "test-model" });
  const victimChat = victim.initChat(manager);
  victimChat.enqueueRunOnce = async () => {};
  const victimRuns = subagentRuns(victim);
  const victimWork = victim.getBackgroundWork();
  const rowOf = (toolCallId) => victimWork.list().find((entry) => entry.jobId === toolCallId);
  /** A settled subagent result with a summary long enough to hit the disk cache. */
  const settled = (output) => ({
    subagentId: "sub_bg",
    output,
    truncated: false,
    iterations: 2,
    maxIterations: 20,
    durationMs: 42,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, billedInputTokens: 10 },
    reachedLimit: false,
    incomplete: false,
    aborted: false,
  });
  const longOutput = "line of the report\n".repeat(900);

  // (a) the run itself rejects: the row must end as `failed`, and its completion must be owed.
  startBackgroundTask({
    managed: victim,
    coreEnv: victim.getCoreEnv(),
    toolCallId: "tc-reject",
    label: "explode",
    input: { prompt: "explode" },
    spawn: async () => {
      throw new Error("spawn exploded");
    },
  });
  await drain();
  assert.equal(rowOf("tc-reject")?.status, "failed", "a rejected run ends the row instead of leaving it running");
  assert.match(
    (await victimWork.pending()).find((entry) => entry.id === "tc-reject")?.body ?? "",
    /spawn exploded/,
    "and the failure is what the notification will carry"
  );
  assert.equal(victimRuns.prefork.isDetached("tc-reject"), false, "the seat is released");
  await victimWork.markDelivered(await victimWork.pending());

  // (b) the result arrives but cannot be RECORDED (the disk cache write throws). The row must still
  // end, so the footer clears and the model is told what happened rather than being told to wait for a
  // notification that no ledger row will ever produce.
  const throwingEnv = {
    ...victim.getCoreEnv(),
    fs: {
      ...victim.getCoreEnv().fs,
      writeFile: async () => {
        throw new Error("disk full");
      },
    },
  };
  startBackgroundTask({
    managed: victim,
    coreEnv: throwingEnv,
    toolCallId: "tc-cache-throw",
    label: "big result",
    input: { prompt: "big" },
    spawn: async () => settled(longOutput),
  });
  await drain();
  assert.equal(
    rowOf("tc-cache-throw")?.status,
    "failed",
    "a result that cannot be recorded still ends the row (no unhandled rejection, no stuck footer)"
  );
  assert.match(
    (await victimWork.pending()).find((entry) => entry.id === "tc-cache-throw")?.body ?? "",
    /could not be recorded/,
    "and says why, instead of claiming a summary is on its way"
  );
  assert.equal(victimRuns.prefork.isDetached("tc-cache-throw"), false, "the seat is released on the error path too");
  await victimWork.markDelivered(await victimWork.pending());

  // (c) the same session's transcript is re-hydrated (a restore, including the FAILED `/resume` that
  // deliberately keeps background work alive): the generation moves, ownership does not. The
  // completion must still be recorded — judging "should this result exist?" by the transcript identity
  // stranded the row as `running` forever.
  const epochBefore = victimRuns.currentEpoch;
  victim.getUI().clearMessages();
  startBackgroundTask({
    managed: victim,
    coreEnv: victim.getCoreEnv(),
    toolCallId: "tc-after-restore",
    label: "survives a restore",
    input: { prompt: "survives a restore" },
    spawn: async () => settled("short summary"),
  });
  await drain();
  assert.equal(victimRuns.currentEpoch, epochBefore, "fixture: the session itself did not change");
  assert.equal(
    rowOf("tc-after-restore")?.status,
    "exited",
    "a transcript re-hydration is not a session change: the completion is recorded"
  );
  assert.equal(rowOf("tc-after-restore")?.pendingPickup, true, "and is owed to the model as usual");
  await victimWork.markDelivered(await victimWork.pending());

  // (d) the switch itself (epoch bump) still drops everything: the row is gone, the seat is gone and
  // nothing is owed into the new conversation. Asserted on the REAL sources (`SubagentRuns` +
  // `AgentCommandService`), not on the fake ones: a source that publishes on its own would emit a frame
  // while the facade is still open — the leaving session's rows, resurrected mid-switch — and a second
  // empty frame right after. The fake sources in section 1 cannot see that.
  startBackgroundTask({
    managed: victim,
    coreEnv: victim.getCoreEnv(),
    toolCallId: "tc-switched-away",
    label: "left behind",
    input: { prompt: "left behind" },
    spawn: () => new Promise(() => {}),
  });
  /** Every `session:jobs` frame from here on; the first is the retained replay of the current value. */
  const frames = [];
  manager.of(victim.id).on("session:jobs", (event) => frames.push(event.payload.jobs.map((entry) => entry.jobId)));
  assert.ok(frames[0].includes("tc-switched-away"), "fixture: the retained snapshot replays the live row");
  victim.reset();
  await drain();
  assert.deepEqual(
    frames.slice(1),
    [[]],
    "a switch publishes exactly one, empty snapshot — no resurrection of the leaving session's rows, no duplicate clear"
  );
  assert.equal(victimWork.list().length, 0, "a session switch reports no rows");
  assert.deepEqual(await victimWork.pending(), [], "and owes nothing — the conversation is over");
  assert.equal(victimRuns.prefork.isDetached("tc-switched-away"), false, "the detached seat was ended");
  manager.destroyAgent(victim.id);
}

// ============================================================================
// 9. Delivery is per source: one kind failing must not strand the other
// ============================================================================

{
  const errors = [];
  const work = new BackgroundWorkService({
    onChange: () => {},
    onError: (message, error) => errors.push(`${message}: ${error.message}`),
  });
  const commands = fakeSource("command");
  const tasks = fakeSource("task");
  commands.source.markDelivered = () => {
    throw new Error("ledger write failed");
  };
  work.register(commands.source);
  work.register(tasks.source);

  await work.markDelivered([completion({ id: "job-1", kind: "command" }), completion({ id: "tc-1" })]);
  assert.deepEqual(
    [...tasks.state.delivered],
    ["tc-1"],
    "the other source's completion is still marked — the notification was already injected"
  );
  assert.equal(errors.length, 1, "and the failure is reported once, not swallowed");
  assert.match(errors[0], /command delivery not recorded/);
}

// A completion's KIND decides the wake cause, not the caller: the pump's exit path has no change
// publication to learn it from, and it used to label every task `job`.
{
  const before = wakes;
  runs.beginBackground({ toolCallId: "tc-cause", label: "cause" });
  runs.settleBackground("tc-cause", { status: "exited", body: "done" });
  await flush();
  assert.equal(wakes, before + 1, "the task completion woke the session");
  assert.equal(managed.takePendingWakeCause(), "task", "and the wake says which kind pulled it back");
  await managed.getBackgroundWork().markDelivered(await managed.getBackgroundWork().pending());

  // The same question through the pump's exit, with no change publication involved.
  const beforePump = wakes;
  chat.pumpDepth = 1;
  runs.beginBackground({ toolCallId: "tc-cause-pump", label: "cause pump" });
  runs.settleBackground("tc-cause-pump", { status: "exited", body: "done" });
  await flush();
  assert.equal(wakes, beforePump, "a live pump is not woken — its next model call delivers");
  chat.pumpDepth = 0;
  // The pump's exit re-checks: nothing had re-read the queue since that settle.
  await managed.wakeForBackgroundWork();
  assert.equal(wakes, beforePump + 1, "the pump's exit wakes for the still-owed completion");
  assert.equal(
    managed.takePendingWakeCause(),
    "task",
    "the pump's peek derives `task` from the pending completion, not from its call site"
  );
  await managed.getBackgroundWork().markDelivered(await managed.getBackgroundWork().pending());
}

// ============================================================================
// 10. Structure: one facade, two sources
// ============================================================================

{
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        // The expectations below are POSIX; `path.relative` uses `\` on Windows.
        const relative = path.relative(SRC, full).split(path.sep).join("/");
        files.push({ path: relative, text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(SRC);
  const withPattern = (pattern) => files.filter((file) => pattern.test(file.text)).map((file) => file.path);

  assert.deepEqual(
    withPattern(/new BackgroundWorkService\(/),
    ["managers/managed-agent.ts"],
    "one facade per agent, built in one place"
  );
  assert.deepEqual(
    withPattern(/async pending\(\): Promise<BackgroundWorkCompletion\[\]> \{/).sort(),
    [
      "agent/subagent/task-work-source.ts",
      "managers/services/agent-command-service.ts",
      "managers/services/background-work-service.ts",
    ],
    "two sources and one facade implement the undelivered queue — never a third ledger"
  );
  assert.deepEqual(
    withPattern(/export function summarizeJobs\(/),
    ["agent/jobs/extension.ts"],
    "the footer line has one definition, shared by both kinds"
  );
  assert.deepEqual(
    withPattern(/async wakeForBackgroundWork\(/),
    ["managers/managed-agent.ts"],
    "one wake path, whatever kind finished"
  );
  assert.deepEqual(
    withPattern(/wakeForBackgroundCompletion\(/).sort(),
    ["agent/run/chat-controller.ts", "managers/managed-agent.ts"],
    "the decision lives in the controller; its one caller is the publication/peek path"
  );
}

// The middleware consumes the facade, not a source: the pointer needs the command source, but the
// completion queue must come from the trunk (otherwise a task completion has no delivery path).
{
  const source = fs.readFileSync(path.join(SRC, "managers/middleware/background-middleware.ts"), "utf8");
  assert.match(source, /getBackgroundWork: \(\) => BackgroundWorkService/, "the middleware takes the facade");
  assert.match(source, /work\.pending\(\)/, "and reads the merged queue");
  assert.match(source, /work\.markDelivered\(/, "and marks through the same object");
  assert.doesNotMatch(
    source,
    /getCommandService\(\)\.collectCompleted|collectCompleted\(\)/,
    "never the command queue directly"
  );
}

// ============================================================================
// 11. The completion notification is the model's only view of a finished task
// ============================================================================

/**
 * A task's result reaches the model through TWO surfaces: the tool part (written back at settle) and
 * the completion notification (the copy that survives a compaction that dropped the call). The
 * notification was previously asserted only in its command shape, so a task could have been labelled
 * `Job`, mapped `aborted → exited`, or lost its summary without a single check going red.
 */
{
  const taskOnly = formatNotifications([completion({ id: "tc-9", status: "exited", body: "found it" })]);
  assert.match(
    taskOnly,
    /Task tc-9 finished with status completed\./,
    "a task is a Task, and `exited` reads as completed"
  );
  assert.doesNotMatch(taskOnly, /exit code/, "a task has no exit code to print");
  assert.match(taskOnly, /Task: explore/, "the label line uses the task prefix");
  assert.match(taskOnly, /found it/, "the source-rendered body (the summary) is carried");
  assert.match(taskOnly, /jobs="tc-9"/, "the id rides in the machine-readable attribute the pointer reads");
  assert.doesNotMatch(taskOnly, /tasks=/, "there is no second, unread attribute for the same fact");

  const commandOnly = formatNotifications([
    completion({
      id: "job_1",
      kind: "command",
      label: "npm run build",
      status: "exited",
      exitCode: 0,
      toolCallId: "tc_build",
      body: "ok",
    }),
  ]);
  assert.match(
    commandOnly,
    /Job job_1 finished with status completed \(exit code 0\)\./,
    "the command wording is unchanged"
  );
  assert.match(commandOnly, /Command: npm run build/);
  assert.match(
    commandOnly,
    /Tool call: tc_build/,
    "a command's id is its jobId, so the tool call is named too — that is the model's way back to the result"
  );

  const mixed = formatNotifications([
    completion({
      id: "job_1",
      kind: "command",
      label: "npm test",
      exitCode: 1,
      status: "failed",
      toolCallId: "tc_test",
      body: "boom",
    }),
    completion({ id: "tc-2", toolCallId: "tc-2", label: "explore", status: "killed", body: "stopped" }),
  ]);
  assert.match(mixed, /Job job_1 finished with status failed \(exit code 1\)\./);
  assert.match(mixed, /Task tc-2 finished with status killed\./, "a cancel reads as killed, not as a clean finish");
  assert.match(mixed, /jobs="job_1,tc-2"/, "one announced-id list covers both kinds");
  assert.equal(
    mixed.match(/Tool call:/g)?.length,
    1,
    "only the command needs the extra line — a task's id IS its call id"
  );

  // The renderer never cuts a body. 6000 chars is BELOW the tool-cache threshold, so the body has no
  // spill path — a 2k inline cap here dropped it with nothing to read it back from, while the tool
  // result of the same call carried it whole.
  {
    const longSummary = "x".repeat(6000);
    const notif = formatNotifications([completion({ id: "tc-long", toolCallId: "tc-long", body: longSummary })]);
    assert.ok(notif.includes(longSummary), "a body under the cache threshold reaches the model whole");
  }

  // A command body IS bounded — by its SOURCE, which appends the durable pointer after the cut.
  {
    const body = formatCommandBody({
      stdout: "o".repeat(9000),
      stderr: "boom",
      logPath: ".agents/cache/command-jobs/job_9.log",
    });
    assert.match(body, /\[\.\.\.truncated \d+ chars from start\.\.\.\]/, "the inline copy says what it dropped");
    assert.match(
      body,
      /log: \.agents\/cache\/command-jobs\/job_9\.log \(full output\)/,
      "and always names the file that still has everything"
    );
    assert.ok(body.length < 9000, "the inline copy is bounded");
    assert.match(body, /stderr:\nboom/, "the reason (written to stderr) survives the tail cut");
  }
}

// ============================================================================
// 12. The settle writes the part, and the repair pass survives the batched overwrite
// ============================================================================

/**
 * TanStack writes a whole tool phase's `TOOL_CALL_RESULT` chunks only when EVERY tool of the batch has
 * finished. A background `task` returns its `running` handle inside that phase, so a subagent that
 * settles while a sibling tool still runs is overwritten by the handle it just replaced — the row goes
 * back to `running`, forever, and the wire starts telling the model to wait for a completion that was
 * already delivered.
 *
 * Two assertions here, because they cover different moments: the settle writes the part at all, and
 * `reconcileSettledTaskParts` (called at every model-call boundary) replays it from the ledger after
 * the framework has clobbered it.
 */
{
  const owner = await manager.createManagedAgent({ name: "background-task-parts", model: "test-model" });
  const ownerChat = owner.initChat(manager);
  ownerChat.enqueueRunOnce = async () => {};
  const channel = owner.getUI();
  const toolCallId = "tc-parts";
  const runningHandle = runningTaskOutput();
  ownerChat.setMessages([
    { id: "u1", role: "user", parts: [{ type: "text", content: "explore in the background" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: toolCallId,
          name: "task",
          state: "complete",
          arguments: JSON.stringify({ prompt: "explore", run_in_background: true }),
          output: runningHandle,
        },
      ],
    },
  ]);

  const result = (output) => ({
    subagentId: "sub_parts",
    output,
    truncated: false,
    iterations: 3,
    maxIterations: 20,
    durationMs: 10,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, billedInputTokens: 1 },
    reachedLimit: false,
    incomplete: false,
    aborted: false,
  });
  const partOf = () =>
    channel
      .getMessages()
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool-call" && part.id === toolCallId);

  startBackgroundTask({
    managed: owner,
    coreEnv: owner.getCoreEnv(),
    toolCallId,
    label: "explore",
    input: { prompt: "explore" },
    spawn: async () => result("the parser lives in src/agent"),
  });
  await drain();

  assert.equal(partOf()?.output?.status, "completed", "the settle writes the result into the part");
  assert.equal(partOf()?.output?.summary, "the parser lives in src/agent", "with the summary, not the handle");
  assert.equal(partOf()?.output?.runInBackground, true, "and the phase it came from");
  assert.equal(
    partOf()?.display?.summary,
    undefined,
    "the handle's `running` display is cleared, so the row cannot keep reading as in-progress"
  );

  // The framework's batched write, arriving after the settle — the middleware re-renders the handle
  // just as it did when the call first returned (output AND display).
  channel.addToolResult(toolCallId, runningHandle);
  channel.attachToolDisplay(toolCallId, { summary: "running" });
  assert.equal(partOf()?.output?.status, "running", "fixture: the batched write rolled the part back");
  assert.equal(partOf()?.display?.summary, "running", "…including the display that goes with it");

  reconcileSettledTaskParts(owner);
  assert.equal(partOf()?.output?.status, "completed", "the repair pass replays the settled payload");
  assert.equal(partOf()?.output?.summary, "the parser lives in src/agent");
  assert.equal(partOf()?.display?.summary, undefined, "and clears the display again");

  // A row that is still running is NOT touched: the handle is the truth until the run ends.
  const liveId = "tc-still-running";
  ownerChat.setMessages([
    ...ownerChat.getMessages(),
    {
      id: "a2",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: liveId,
          name: "task",
          state: "complete",
          arguments: JSON.stringify({ prompt: "still going", run_in_background: true }),
          output: runningTaskOutput(),
        },
      ],
    },
  ]);
  startBackgroundTask({
    managed: owner,
    coreEnv: owner.getCoreEnv(),
    toolCallId: liveId,
    label: "still going",
    input: { prompt: "still going" },
    spawn: () => new Promise(() => {}),
  });
  await drain();
  reconcileSettledTaskParts(owner);
  const livePart = channel
    .getMessages()
    .flatMap((message) => message.parts)
    .find((part) => part.type === "tool-call" && part.id === liveId);
  assert.equal(livePart?.output?.status, "running", "a live run keeps its handle");

  manager.destroyAgent(owner.id);
}

// ============================================================================
// 13. A session end settles the handles it left behind
// ============================================================================

/**
 * `run_in_background` writes `status: "running"` into the part immediately, and the settle write is
 * dropped (by design) when a switch is in flight. The part is then persisted as running while the
 * ledger that would repair it is gone — the restored transcript shows a spinner that never ends and
 * tells the model to wait for a completion that can never arrive.
 *
 * The generic restore pass skips any part that already carries an output, so this is its own pass. It
 * writes a TASK-SHAPED result rather than the framework's shared cancel marker: the task's own
 * `toModelOutput` reads `summary` / `status` / the flags, so the marker would put `undefined` on the
 * wire — and the reason has to be "the session ended", never "Cancelled by user.".
 */
{
  const messages = [
    { id: "u1", role: "user", parts: [{ type: "text", content: "go" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "tc-lost",
          name: "task",
          state: "complete",
          arguments: "{}",
          output: runningTaskOutput(),
          display: { summary: "running" },
        },
        {
          type: "tool-call",
          id: "tc-done",
          name: "task",
          state: "complete",
          arguments: "{}",
          output: { ...runningTaskOutput(), status: "completed", summary: "done already" },
        },
      ],
    },
  ];
  const settled = cancelInterruptedBackgroundTasks(messages);
  const lost = settled.flatMap((message) => message.parts).find((part) => part.id === "tc-lost");
  const done = settled.flatMap((message) => message.parts).find((part) => part.id === "tc-done");
  assert.equal(lost?.state, "complete", "the row stops loading");
  assert.equal(lost?.output?.status, "completed", "the handle is replaced by a settled result");
  assert.equal(lost?.output?.aborted, true, "settled as a cancel…");
  assert.equal(lost?.output?.incomplete, true, "…that produced no report of its own");
  assert.equal(lost?.output?.summary, SESSION_END_CANCELLED_MESSAGE, "with the session-end reason, not a user cancel");
  assert.equal(lost?.display, undefined, "and the `running` display is dropped with the output it described");
  assert.ok(
    settled.some((message) =>
      message.parts.some((part) => part.type === "tool-result" && part.toolCallId === "tc-lost")
    ),
    "the wire gets a paired result, so the model is not left with an unanswered call"
  );
  // The model reads this part through the tool's own `toModelOutput` — which is exactly why the shape
  // (not the shared marker) matters.
  assert.match(formatTaskModelText(lost.output), /session ended/, "the model text carries the reason");
  assert.match(formatTaskModelText(lost.output), /aborted=true/);
  assert.equal(done?.output?.summary, "done already", "an already-settled task is left exactly as it was");
  assert.equal(cancelInterruptedBackgroundTasks(settled), settled, "a second pass is a no-op");
}

// ============================================================================
// 13b. The settle rewrites the PAIRED tool-result, not just the call part
// ============================================================================
//
// `addToolResult` writes both the call's `output` and a `tool-result` part, and the model wire is
// built from the RESULT's content (TanStack copies it into the `role: "tool"` message verbatim).
// Rewriting only the call part left the UI saying "cancelled" while the resumed model still read
// the `running` handle — and was told not to poll for a completion that would never arrive.
{
  const handle = runningTaskOutput();
  const messages = [
    { id: "u1", role: "user", parts: [{ type: "text", content: "go" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "tc-paired",
          name: "task",
          state: "complete",
          arguments: "{}",
          output: handle,
        },
        {
          type: "tool-result",
          toolCallId: "tc-paired",
          content: JSON.stringify(handle),
          state: "complete",
        },
      ],
    },
  ];
  const settled = cancelInterruptedBackgroundTasks(messages);
  const result = settled
    .flatMap((message) => message.parts)
    .find((part) => part.type === "tool-result" && part.toolCallId === "tc-paired");
  assert.ok(result, "the paired result is still there");
  const content = String(result.content);
  assert.equal(content.includes('"status":"running"'), false, "the wire no longer carries a running handle");
  assert.match(content, /session ended/, "it carries the session-end reason instead");
  assert.equal(result.state, "complete", "and stays a settled result");
  assert.equal(
    settled.flatMap((message) => message.parts).filter((part) => part.type === "tool-result").length,
    1,
    "no duplicate result is appended"
  );
}

/**
 * The command half of the same hand-off.
 *
 * A `running` job record is restored and marked killed, but a GRACEFUL teardown deletes the record
 * outright (the job is killed with the session), so after `/resume` there is no record and no
 * notification — while the `run_command` part still says `running` and its `toModelOutput` still tells
 * the model to wait for a push that can never come. The part is settled here, with the same reason as
 * the task side, and keeps the job id + log path so the partial output stays reachable.
 */
{
  const messages = [
    { id: "u1", role: "user", parts: [{ type: "text", content: "start the server" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "tc-cmd",
          name: "run_command",
          state: "complete",
          arguments: "{}",
          output: {
            command: "npm run dev",
            stdout: "",
            stderr: "",
            exitCode: -1,
            durationMs: 0,
            success: true,
            jobId: "job_1",
            status: "running",
            runInBackground: true,
            cachedOutputPath: ".agents/cache/command-jobs/job_1.log",
          },
        },
      ],
    },
  ];
  const settled = cancelInterruptedBackgroundCommands(messages);
  const part = settled.flatMap((message) => message.parts).find((entry) => entry.id === "tc-cmd");
  assert.equal(part?.output?.status, "killed", "the job ended when the session did");
  assert.equal(part?.output?.stderr, SESSION_END_CANCELLED_MESSAGE, "with the shared session-end reason");
  assert.equal(part?.output?.jobId, "job_1", "the job id is kept, so the log is still addressable");
  assert.equal(part?.output?.cachedOutputPath, ".agents/cache/command-jobs/job_1.log");
  assert.equal(part?.output?.cancelled, undefined, "not a user cancel — that marker renders 'Cancelled by user.'");

  const modelText = getToolMetadata(createRunCommandTool())?.toModelOutput({
    toolCallId: "tc-cmd",
    input: {},
    output: part.output,
  });
  const text = (Array.isArray(modelText) ? modelText : [modelText]).map((entry) => entry?.content ?? "").join("\n");
  assert.match(text, /Status: killed/, "the model is told what happened");
  assert.match(text, /session ended/, "and why");
  assert.doesNotMatch(text, /You do not need to poll/, "a dead job must not be advertised as pollable");
  assert.match(
    formatToolOutput(part.output, "run_command"),
    /Background job job_1 \(killed\): npm run dev — Cancelled because the session ended\./,
    "the row's block names the verdict and the reason"
  );

  // A foreground result has no `status` and must never be rewritten by this pass.
  const foreground = [
    {
      id: "a2",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "tc-fg",
          name: "run_command",
          state: "complete",
          arguments: "{}",
          output: { command: "ls", stdout: "", stderr: "", exitCode: 0, durationMs: 1, success: true },
        },
      ],
    },
  ];
  assert.equal(cancelInterruptedBackgroundCommands(foreground), foreground, "a finished command is untouched");
}

// ============================================================================
// 14. The cascade guard protects a REAL child, not just a seat
// ============================================================================

/**
 * `SubagentRuns.reset()` / the seat assertions above prove the SEAT survives Esc. What the seat
 * protects is the child agent, and that is a different loop: `cascadeAbortToChildren` walks
 * `childIds` and must skip a child whose `task` call is detached. Without a real child the guard
 * could be deleted and every other assertion here would still pass.
 */
{
  const parent = await manager.createManagedAgent({ name: "bg-cascade-parent", model: "test-model" });
  const child = await manager.createManagedAgent(
    { name: "bg-cascade-child", model: "test-model" },
    parent.id,
    "sub-cascade"
  );
  child.parentTaskId = "tc-cascade";
  child.setStatus("running");
  const parentRuns = subagentRuns(parent);
  parentRuns.prefork.start(
    "tc-cascade",
    () => {},
    () => new Promise(() => {})
  );
  parentRuns.prefork.detach("tc-cascade");

  parent.abort("user");
  assert.equal(child.getStatus(), "running", "Esc does not abort a background child agent");

  // Same child, same call, no longer detached: the cascade must reach it.
  parentRuns.prefork.forgetDetached("tc-cascade");
  parent.abort("user");
  assert.equal(child.getStatus(), "aborted", "a foreground child is still stopped by the same call");

  manager.destroyAgent(parent.id);
}

// ============================================================================
// 15. A background task shares the foreground concurrency window
// ============================================================================

/**
 * `maxConcurrentTasks` caps TASK RUNS, not blocking calls: a detached (background) seat keeps its
 * slot while it runs, and a foreground `task` queued behind it starts the moment that slot frees. Two
 * independent windows would let one session open twice the provider streams it configured — and the
 * background kind is the easier one to forget, because its call already returned.
 */
{
  const runs = new SubagentRuns(
    () => 1,
    () => "ses-concurrency"
  );
  const started = [];
  const ok = (subagentId) => ({
    subagentId,
    output: "done",
    truncated: false,
    iterations: 1,
    maxIterations: 1,
    durationMs: 1,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, billedInputTokens: 1 },
    reachedLimit: false,
    incomplete: false,
    aborted: false,
  });

  let releaseBackground;
  const backgroundDone = new Promise((resolve) => {
    releaseBackground = () => resolve(ok("sub_bg"));
  });
  runs.prefork.start(
    "tc-bg-slot",
    () => {},
    async () => {
      started.push("tc-bg-slot");
      return backgroundDone;
    }
  );
  runs.prefork.detach("tc-bg-slot");

  runs.prefork.start(
    "tc-fg-slot",
    () => {},
    async () => {
      started.push("tc-fg-slot");
      return ok("sub_fg");
    }
  );
  await flush();
  assert.deepEqual(started, ["tc-bg-slot"], "the foreground task queues behind the running background seat");
  assert.deepEqual(runs.prefork.queuedToolCallIds(), ["tc-fg-slot"], "and is advertised as queued");
  assert.equal(runs.prefork.activeCount, 1, "one slot is occupied — by the background run");

  releaseBackground();
  await drain();
  assert.deepEqual(started, ["tc-bg-slot", "tc-fg-slot"], "the freed slot admits the foreground task");
  assert.deepEqual(runs.prefork.queuedToolCallIds(), [], "nothing is left waiting");
  assert.equal(runs.prefork.activeCount, 0, "both runs released their slot");
}

// ============================================================================
// Cleanup
// ============================================================================

clearCoreEnv();
manager.destroyAgent(managed.id);
await fs.promises.rm(rootPath, TEMP_RM_OPTIONS);

console.log("background-task validation passed");

/**
 * Validates the task pre-fork coordinator (rolling-window parallel spawning).
 *
 * Run: pnpm --filter @codent/core run validate:task-prefork
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createExtensionsMiddleware,
  getTaskPreforkCoordinator,
  MAX_ACTIVE_TASK_PREFORKS,
  peekTaskPreforkCoordinator,
  resolveMaxConcurrentTasks,
  TaskPreforkCoordinator,
} from "../dist/dev.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- start / join semantics ---

{
  const coordinator = new TaskPreforkCoordinator();
  let started = 0;
  const ok = coordinator.start(
    "call-1",
    () => {},
    async () => {
      started += 1;
      await sleep(20);
      return { subagentId: "sub-1", output: "done" };
    }
  );
  assert.equal(ok, true);
  assert.equal(coordinator.has("call-1"), true);

  // Double-start for same id is idempotent.
  assert.equal(
    coordinator.start(
      "call-1",
      () => {},
      async () => ({})
    ),
    true
  );
  assert.equal(coordinator.size, 1);

  const result = await coordinator.join("call-1");
  assert.equal(result.output, "done");
  assert.equal(started, 1);
  assert.equal(coordinator.has("call-1"), false, "join releases the slot");
}

// --- join unknown id returns null ---

{
  const coordinator = new TaskPreforkCoordinator();
  assert.equal(await coordinator.join("missing"), null);
}

// --- rolling window: over-cap runs queue and start as slots free ---

{
  const coordinator = new TaskPreforkCoordinator();
  const TOTAL = MAX_ACTIVE_TASK_PREFORKS + 3;
  const startedOrder = [];
  const finished = [];
  for (let i = 0; i < TOTAL; i++) {
    coordinator.start(
      `call-${i}`,
      () => {},
      async () => {
        startedOrder.push(i);
        await sleep(15);
        finished.push(i);
        return { subagentId: `s${i}` };
      }
    );
  }
  assert.equal(coordinator.size, TOTAL, "all runs are registered");
  assert.ok(
    coordinator.activeCount <= MAX_ACTIVE_TASK_PREFORKS,
    `concurrency must be capped (${coordinator.activeCount})`
  );

  // Let the first wave finish; queued runs must roll forward automatically.
  const results = await Promise.all(Array.from({ length: TOTAL }, (_, i) => coordinator.join(`call-${i}`)));
  assert.equal(finished.length, TOTAL, "every run completed");
  assert.deepEqual(startedOrder, [...Array(TOTAL).keys()], "runs start in FIFO order as slots free");
  assert.ok(results.every((r) => r && r.subagentId));
}

// --- onRunStart fires on slot acquisition, not registration ---

{
  const coordinator = new TaskPreforkCoordinator();
  const starts = [];
  for (let i = 0; i < MAX_ACTIVE_TASK_PREFORKS + 2; i++) {
    coordinator.start(
      `q-${i}`,
      () => {},
      async () => {
        await sleep(20);
        return {};
      },
      () => starts.push(i)
    );
  }
  await sleep(5);
  assert.equal(starts.length, MAX_ACTIVE_TASK_PREFORKS, "only admitted runs fire onRunStart");
  await Promise.all(Array.from({ length: MAX_ACTIVE_TASK_PREFORKS + 2 }, (_, i) => coordinator.join(`q-${i}`)));
  assert.equal(starts.length, MAX_ACTIVE_TASK_PREFORKS + 2, "queued runs fire onRunStart once admitted");
}

// --- abortAll cancels running runs and drops bookkeeping ---

{
  const coordinator = new TaskPreforkCoordinator();
  const aborts = [];
  coordinator.start(
    "a",
    () => aborts.push("a"),
    () => new Promise(() => {})
  );
  coordinator.start(
    "b",
    () => aborts.push("b"),
    () => new Promise(() => {})
  );
  for (let i = 0; i < MAX_ACTIVE_TASK_PREFORKS; i++) {
    coordinator.start(
      `q${i}`,
      () => aborts.push(`q${i}`),
      () => new Promise(() => {})
    );
  }

  coordinator.abortAll();
  assert.equal(coordinator.size, 0, "entries are dropped after abortAll");
  assert.equal(aborts.length, MAX_ACTIVE_TASK_PREFORKS + 2, "every run's cancel handle fired");
}

// --- the discard points are the run boundaries + the restart path, NOT RUN_STARTED ---
//
// The regression this pins: `RUN_STARTED` fires once per model ITERATION, so discarding its
// registered pre-forks there aborted a healthy eager run that the NEXT iteration's tool phase
// was about to join. The orphan it left (aborted, never joined, second subagent spawned for
// the same call id) is the one the discard record was built to explain — the reporting was
// right and the trigger was wrong. So: two halves.
{
  // (a) An eager run survives an iteration boundary and is joined by the tool phase on the
  // next one. This is the read-after-boundary contract, and it is the exact shape that used
  // to be aborted.
  const coordinator = new TaskPreforkCoordinator();
  let started = 0;
  coordinator.start(
    "iter-2-call",
    () => {},
    async () => {
      started += 1;
      await sleep(10);
      return { subagentId: "sub-eager", output: "findings" };
    }
  );
  coordinator.recordSpawn("iter-2-call", "sub-eager");
  await sleep(2); // the eager run is now in flight, one iteration boundary later
  const joined = await coordinator.join("iter-2-call");
  assert.ok(joined, "the tool phase still joins the run started on an earlier iteration");
  assert.equal(joined.output, "findings", "the joined run's own output survives, not a cancel stub");
  assert.equal(started, 1, "the run executed exactly once");
  assert.equal(coordinator.size, 0, "join released it");
}
{
  // (b) An interrupted attempt leaves a registered run, and the RESTART discards it — with
  // the cause naming the fresh stream, and the orphan still named.
  const coordinator = new TaskPreforkCoordinator();
  const aborted = [];
  coordinator.start(
    "dead-attempt-call",
    () => aborted.push("dead-attempt-call"),
    () => new Promise(() => {})
  );
  coordinator.recordSpawn("dead-attempt-call", "sub-orphan");
  const discarded = coordinator.abortAll("run-start");
  assert.equal(discarded.length, 1, "the restart reports what it discarded");
  assert.equal(discarded[0].cause, "run-start", "named as the restarted stream, not a run end");
  assert.deepEqual(discarded[0].subagentIds, ["sub-orphan"], "the orphan is named");
  assert.deepEqual(aborted, ["dead-attempt-call"], "and the run was actually cancelled");
}

// --- the discarded stub is honest about WHY it stopped ---
//
// It used to say `[Task cancelled.]` with no reason, which reads as an operator cancel — the
// same misattribution the notice taxonomy exists to fix, one layer down. A discard is the run
// lifecycle moving on.
//
// Asserted from the source, not by awaiting it: `abortAll` clears the entry, so the promise
// that settles to this stub has no joiner (the awaiting tool phase gets `null` and spawns a
// fresh subagent instead). The shape still has to be right — it is the coordinator's declared
// result for a discarded run — but there is no caller left to observe it.
{
  const src = readFileSync(join(SRC, "agent/subagent/task-prefork.ts"), "utf8");
  const stub = /function cancelledStubResult\(\): SubagentResult \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(stub, "the discarded-run stub is present");
  assert.ok(
    !/output:\s*"\[Task cancelled\.\]"/.test(stub[0]),
    "the stub's output is not the bare operator-cancel literal"
  );
  assert.ok(/output: SUBAGENT_PARENT_RUN_NOTICE/.test(stub[0]), "…it names the parent run instead");
  assert.ok(/stopReason: "parent-run"/.test(stub[0]), "…and carries the machine-readable reason");
}

// --- discardRegisteredPrefork is the single discard point the middleware + recovery share ---
//
// Asserted as source because the bug was a CALL SITE (a middleware hook discarding at an
// event that does not mean what it was assumed to mean), and no value assertion can see one.
{
  const src = readFileSync(join(SRC, "managers/middleware/task-prefork-middleware.ts"), "utf8");
  // The per-iteration boundary must NOT discard registered runs.
  const runStarted = /if \(chunk\.type === "RUN_STARTED"\) \{([\s\S]*?)\n\s{8}\}/.exec(src);
  assert.ok(runStarted, "the RUN_STARTED branch is present");
  assert.ok(
    !/discardRegistered\(|\.abortAll\(/.test(runStarted[1]),
    "RUN_STARTED drops iteration bookkeeping only — it must not discard registered pre-forks " +
      "(it fires once per iteration, so that aborted runs the next tool phase was about to join)"
  );
  // Every per-run terminal boundary DOES discard.
  for (const hook of ["onFinish", "onAbort", "onError"]) {
    const body = new RegExp(`${hook}: async \\(\\) => \\{([\\s\\S]*?)\\n\\s{4}\\}`).exec(src);
    assert.ok(body, `${hook} is declared`);
    assert.ok(/discardRegistered\(managed, "run-/.test(body[1]), `${hook} discards the attempt's pre-forks`);
  }
  // …and the restart path discards too — the place a restart is actually known.
  const recovery = readFileSync(join(SRC, "managers/run-stream-recovery.ts"), "utf8");
  assert.ok(
    /discardRegisteredPrefork\(options\.managed, "run-start"/.test(recovery),
    "a restart-style retry discards the dead attempt's pre-forks"
  );
}

// --- abortAll(cause) reports what it discarded, with the spawned subagents ---
//
// This is the record the middleware turns into `subagent:prefork-discarded`, and the only
// thing that names an orphan: a pre-fork thrown away AFTER it spawned its subagent leaves
// that subagent aborted-with-no-join, while the tool phase spawns a second one for the same
// call id. Without the record the two are indistinguishable in the log.

{
  const coordinator = new TaskPreforkCoordinator();
  coordinator.start(
    "discarded",
    () => {},
    () => new Promise(() => {})
  );
  coordinator.recordSpawn("discarded", "subagent-orphan");
  coordinator.start(
    "finished",
    () => {},
    async () => ({ subagentId: "subagent-real", output: "done" })
  );
  coordinator.recordSpawn("finished", "subagent-real");

  // A call that completed normally is joined away — it must never be reported.
  const joined = await coordinator.join("finished");
  assert.ok(joined, "the joined call returns its result");

  const discarded = coordinator.abortAll("run-finish");
  assert.equal(discarded.length, 1, "only the still-registered call is reported");
  assert.equal(discarded[0].toolCallId, "discarded");
  assert.equal(discarded[0].cause, "run-finish", "the cause is carried through");
  assert.deepEqual(
    discarded[0].subagentIds,
    ["subagent-orphan"],
    "the record names the subagent that was already spawned — the orphan"
  );

  // Without a cause the coordinator stays silent: the plain reset (no reporting path)
  // must not manufacture records for callers that do not consume them.
  const coordinator2 = new TaskPreforkCoordinator();
  coordinator2.start(
    "quiet",
    () => {},
    () => new Promise(() => {})
  );
  assert.deepEqual(coordinator2.abortAll(), [], "a causeless abortAll reports nothing");

  // An entry already aborted is not reported twice (idempotence of a double reset).
  const again = coordinator.abortAll("run-abort");
  assert.deepEqual(again, [], "a reset after a reset discards nothing");
}

// --- recordSpawn is a no-op for an unregistered call ---

{
  const coordinator = new TaskPreforkCoordinator();
  // The serial fallback path runs the subagent without registering a pre-fork; recording
  // must not create an entry (the tool call would then be reported as discarded on the
  // next reset even though nothing was ever thrown away).
  coordinator.recordSpawn("never-registered", "subagent-x");
  assert.equal(coordinator.has("never-registered"), false, "recordSpawn does not register an entry");
  assert.deepEqual(coordinator.abortAll("new-attempt"), [], "and nothing is reported for it");
}

// --- queued run aborted before admission never runs ---

{
  const coordinator = new TaskPreforkCoordinator();
  // Fill all slots with never-resolving runs.
  for (let i = 0; i < MAX_ACTIVE_TASK_PREFORKS; i++) {
    coordinator.start(
      `blocker-${i}`,
      () => {},
      () => new Promise(() => {})
    );
  }
  let factoryRan = false;
  let runStarted = false;
  coordinator.start(
    "queued",
    () => {},
    async () => {
      factoryRan = true;
      return {};
    },
    () => {
      runStarted = true;
    }
  );
  assert.equal(runStarted, false, "queued run has not acquired a slot");

  coordinator.abortAll();
  await sleep(10);
  assert.equal(factoryRan, false, "cancelled-while-queued run must never execute");
  assert.equal(runStarted, false, "cancelled-while-queued run must never fire onRunStart");
}

// --- parallel timing: two runs overlap ---

{
  const coordinator = new TaskPreforkCoordinator();
  const marks = [];
  coordinator.start(
    "p1",
    () => {},
    async () => {
      marks.push(["p1", Date.now()]);
      await sleep(60);
      return {};
    }
  );
  await sleep(5);
  coordinator.start(
    "p2",
    () => {},
    async () => {
      marks.push(["p2", Date.now()]);
      await sleep(60);
      return {};
    }
  );

  const [r1, r2] = await Promise.all([coordinator.join("p1"), coordinator.join("p2")]);
  assert.ok(r1 && r2);
  const gap = Math.abs(marks[1][1] - marks[0][1]);
  assert.ok(gap < 50, `runs must overlap (gap=${gap}ms)`);
}

// --- middleware module is loadable and named ---

{
  const { createTaskPreforkMiddleware } = await import("../dist/dev.mjs");
  const middleware = createTaskPreforkMiddleware({
    getManagedAgent: () => undefined,
    manager: {},
  });
  assert.equal(middleware.name, "task-prefork");
  // Chunks pass through untouched when no agent is bound.
  const chunk = { type: "TOOL_CALL_END", toolCallId: "t1" };
  assert.deepEqual(await middleware.onChunk({}, chunk), chunk);
}

// --- peek is non-creating; get lazily creates ---

{
  const parent = {};
  assert.equal(peekTaskPreforkCoordinator(parent), undefined, "peek returns undefined before any coordinator exists");
  const created = getTaskPreforkCoordinator(parent);
  assert.equal(peekTaskPreforkCoordinator(parent), created, "peek returns the created coordinator");
}

// --- a pre-forked task does not get the eager (tool-phase) start ---
//
// TanStack runs tools in parallel, so `onBeforeToolCall` fires for every task at the
// top of the tool phase; the pre-fork emits the real start on admission. If the eager
// one is not deferred, a queued run's row times while it merely waits for a slot.

{
  const emitted = [];
  const middleware = createExtensionsMiddleware({
    getExtensionRunner: () => null,
    getSessionId: () => "s",
    emitEvent: (type, payload) => emitted.push({ type, payload }),
    isTaskToolStartDeferred: (id) => id === "call-queued",
  });
  const hook = middleware.onBeforeToolCall;
  assert.equal(typeof hook, "function", "extensions middleware exposes onBeforeToolCall");

  await hook({}, { toolName: "task", toolCallId: "call-queued", args: { prompt: "x" } });
  assert.equal(emitted.length, 0, "a pre-forked task emits no eager tool-start (the pre-fork owns it)");

  await hook({}, { toolName: "task", toolCallId: "call-serial", args: { prompt: "y" } });
  assert.equal(emitted.length, 1, "a task the pre-fork does not own still emits its start");
  assert.equal(emitted[0].type, "agent:tool-start");

  await hook({}, { toolName: "grep", toolCallId: "call-grep", args: {} });
  assert.equal(emitted.length, 2, "non-task tools are unaffected by the deferral");
}

// --- a configured cap is honored (default stays the constant) ---

{
  const coordinator = new TaskPreforkCoordinator(() => 2);
  let running = 0;
  let maxRunning = 0;
  for (const id of ["a", "b", "c", "d"]) {
    coordinator.start(
      id,
      () => {},
      async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await sleep(30);
        running -= 1;
        return { subagentId: id, output: id };
      }
    );
  }
  await Promise.all(["a", "b", "c", "d"].map((id) => coordinator.join(id)));
  assert.equal(maxRunning, 2, "a cap of 2 admits exactly 2 and queues the rest");
}

// --- resolveMaxConcurrentTasks: default / custom / clamp ---

{
  const managed = (maxConcurrentTasks) => ({ config: { maxConcurrentTasks } });
  assert.equal(resolveMaxConcurrentTasks(managed(undefined)), MAX_ACTIVE_TASK_PREFORKS, "missing cap → default");
  assert.equal(resolveMaxConcurrentTasks({ config: {} }), MAX_ACTIVE_TASK_PREFORKS, "no config field → default");
  assert.equal(resolveMaxConcurrentTasks(managed(8)), 8, "custom cap honored");
  assert.equal(resolveMaxConcurrentTasks(managed(0)), 1, "0 clamps to 1");
  assert.equal(resolveMaxConcurrentTasks(managed(-3)), 1, "negative clamps to 1");
  assert.equal(resolveMaxConcurrentTasks(managed(2.9)), 2, "fractional floors");
  assert.equal(resolveMaxConcurrentTasks(managed(Number.NaN)), MAX_ACTIVE_TASK_PREFORKS, "NaN → default");
}

console.log("task-prefork validation passed");

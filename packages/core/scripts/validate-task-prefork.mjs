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
  AgentConfigSchema,
  createExtensionsMiddleware,
  createTaskPreforkMiddleware,
  getTaskPreforkCoordinator,
  hasPendingRunContinuation,
  MAX_ACTIVE_TASK_PREFORKS,
  peekTaskPreforkCoordinator,
  resolveMaxConcurrentTasks,
  RunCoordinator,
  shouldContinueAgentPump,
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

  // Double-start for same id registers nothing, and says so: the `false` is the caller's only signal
  // that the run it thinks it started is not the one that will be joined (the middleware uses it to
  // disarm the parent-abort listener it attached for a spawn that never happened).
  assert.equal(
    coordinator.start(
      "call-1",
      () => {},
      async () => ({})
    ),
    false
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
// The call site's BEHAVIOUR is driven for real further down; these assertions exist so that a
// refactor cannot drop the call, or drop the guard around it, without failing here first.
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

  // `onFinish` ends an INVOCATION, which a wait also ends — so it discards, but only once the run is
  // really over. Both halves are load-bearing: dropping the call leaks a stranded run, dropping the
  // guard orphans a healthy one (the tool phase then spawns a second subagent for the same call id).
  const finish = /onFinish: async \(\) => \{([\s\S]*?)\n\s{4}\}/.exec(src);
  assert.ok(finish, "onFinish is declared");
  const guard = /if \(!messages \|\| hasPendingRunContinuation\(messages\)\) return;/.exec(finish[1]);
  assert.ok(
    guard,
    "onFinish asks hasPendingRunContinuation before discarding — an approval / client-tool wait ends " +
      "the invocation while the run continues, so the joining tool phase is still coming"
  );
  const finishDiscard = /discardRegistered\(managed, "run-finish"\)/.exec(finish[1]);
  assert.ok(finishDiscard, 'onFinish still discards a run that really ended ("run-finish")');
  assert.ok(guard.index < finishDiscard.index, "the guard returns BEFORE the discard, not after it");

  // An abandonment boundary needs no guard: there is no later pump to join the registered runs.
  for (const [hook, cause] of [
    ["onAbort", "run-abort"],
    ["onError", "run-error"],
  ]) {
    const body = new RegExp(`${hook}: async \\(\\) => \\{([\\s\\S]*?)\\n\\s{4}\\}`).exec(src);
    assert.ok(body, `${hook} is declared`);
    assert.ok(
      new RegExp(`discardRegistered\\(managed, "${cause}"\\)`).test(body[1]),
      `${hook} discards the attempt's pre-forks`
    );
    assert.ok(
      !/hasPendingRunContinuation/.test(body[1]),
      `${hook} discards unconditionally — an abort/error means nothing is coming to join. (A run ` +
        "abandoned while PAUSED reaches neither hook: a session switch / `/clear` there is covered " +
        "by `ManagedAgent`'s abandonment seats — see validate:run-abort-ownership.)"
    );
  }

  // …and the restart path discards too — the place a restart is actually known.
  const recovery = readFileSync(join(SRC, "managers/run-stream-recovery.ts"), "utf8");
  assert.ok(
    /discardRegisteredPrefork\(options\.managed, "run-start"/.test(recovery),
    "a restart-style retry discards the dead attempt's pre-forks"
  );
}

// --- the pause predicate: "a tool phase is still coming" ≠ "the run is over" ---
//
// This is the rule the middleware must not hand-roll a second version of. `AgentChatController`
// breaks out of its pump on the same waits and re-pumps after them, so the predicate is literally
// "will a later pump run the tool phase that joins my registered runs".
{
  const toolCall = (over = {}) => ({
    type: "tool-call",
    id: "call-1",
    name: "run_command",
    arguments: "{}",
    ...over,
  });
  const conversation = (parts) => [
    { id: "u1", role: "user", parts: [{ type: "text", content: "go" }] },
    { id: "a1", role: "assistant", parts },
  ];

  const cases = [
    [
      "an approval the user has not decided",
      toolCall({ state: "input-complete", approval: { id: "ap1", needsApproval: true } }),
      true,
    ],
    ["a client tool awaiting an answer", toolCall({ name: "ask_user", state: "input-complete" }), true],
    [
      "an ANSWERED approval whose tool has not executed yet",
      toolCall({ state: "input-complete", approval: { id: "ap1", needsApproval: true, approved: true } }),
      true,
    ],
    ["a server tool deferred by batch gating", toolCall({ state: "input-complete" }), true],
    ["only completed tools", toolCall({ state: "complete", output: { ok: true } }), false],
  ];
  for (const [label, part, expected] of cases) {
    assert.equal(
      hasPendingRunContinuation(conversation([part])),
      expected,
      `hasPendingRunContinuation must treat ${label} as ${expected ? "'still coming'" : "'over'"}`
    );
  }

  // The distinction that makes this NOT `shouldContinueAgentPump`: a turn whose tools already ran and
  // whose only remainder is the model's reply has nothing left to join, so it must not hold a run.
  const terminal = toolCall({ state: "complete", output: { ok: true } });
  assert.equal(shouldContinueAgentPump(conversation([terminal])), true, "the controller pumps for the reply text");
  assert.equal(hasPendingRunContinuation(conversation([terminal])), false, "…but no tool phase is pending");
  console.log("ok  the pause predicate separates 'waiting for input' from 'run is over'");
}

// --- the discard call site, driven: a pausing invocation keeps its pre-forks ---
//
// Value-level, through the middleware the pipeline actually runs. `getChunk`/`trySpawn` are not
// involved: a registered pre-fork is seeded directly, which is the state `onFinish` finds.
{
  const toolCall = (over = {}) => ({
    type: "tool-call",
    id: "call-1",
    name: "run_command",
    arguments: "{}",
    ...over,
  });
  const conversation = (parts) => [
    { id: "u1", role: "user", parts: [{ type: "text", content: "go" }] },
    { id: "a1", role: "assistant", parts },
  ];
  const APPROVAL_PENDING = toolCall({ state: "input-complete", approval: { id: "ap1", needsApproval: true } });
  const ALL_DONE = toolCall({ state: "complete", output: { ok: true } });

  /** A fake parent: the middleware reads the message chain and the abort surface, nothing else. */
  const fakeParent = (messages, { noChannel = false } = {}) => ({
    id: "parent-1",
    config: {},
    getChatController: noChannel ? () => undefined : () => ({ getMessages: () => messages }),
    getUI: noChannel ? () => undefined : () => ({ getMessages: () => messages }),
    addPendingAbortController: () => {},
    removePendingAbortController: () => {},
  });

  const middlewareFor = (managed, reported = []) =>
    createTaskPreforkMiddleware({
      getManagedAgent: () => managed,
      manager: { getAgent: () => undefined },
      emitEvent: (type, payload) => {
        if (type === "subagent:prefork-discarded") reported.push(payload);
      },
    });

  /** Seed a registered pre-fork for `managed`, as the eager start would have left it. */
  const seed = (managed, toolCallId) => {
    let cancelled = 0;
    const coordinator = getTaskPreforkCoordinator(managed);
    coordinator.start(
      toolCallId,
      () => {
        cancelled += 1;
      },
      () => new Promise(() => {})
    );
    coordinator.recordSpawn(toolCallId, "sub-unjoined");
    return { coordinator, cancelled: () => cancelled };
  };

  // (a) An approval wait: the next pump's tool phase joins the run, so nothing may be discarded.
  {
    const managed = fakeParent(conversation([APPROVAL_PENDING]));
    const { coordinator, cancelled } = seed(managed, "call-waiting");
    await middlewareFor(managed).onFinish();
    assert.equal(coordinator.size, 1, "a pausing invocation keeps the registered pre-fork");
    assert.equal(cancelled(), 0, "…and does not abort it — the joining tool phase is still coming");
  }

  // (b) A run that really ended: discard, and report what was orphaned.
  {
    const managed = fakeParent(conversation([ALL_DONE]));
    const reported = [];
    const { coordinator, cancelled } = seed(managed, "call-finished");
    await middlewareFor(managed, reported).onFinish();
    assert.equal(coordinator.size, 0, "an invocation with nothing pending discards");
    assert.equal(cancelled(), 1, "…and cancels the run");
    assert.deepEqual(
      reported,
      [{ toolCallId: "call-finished", cause: "run-finish", subagentIds: ["sub-unjoined"] }],
      "the discard is reported with cause + the orphan it names"
    );
  }

  // (c) No channel to read: an unknown state must not be read as "the run is over" — a stranded run
  // can still be reached by an abort, a discarded one cannot be recovered.
  {
    const managed = fakeParent([], { noChannel: true });
    const { coordinator, cancelled } = seed(managed, "call-unknown");
    await middlewareFor(managed).onFinish();
    assert.equal(coordinator.size, 1, "an unreadable channel keeps the run");
    assert.equal(cancelled(), 0);
  }

  // (d) Abandonment is unconditional: a wait being pending changes nothing there.
  for (const hook of ["onAbort", "onError"]) {
    const managed = fakeParent(conversation([APPROVAL_PENDING]));
    const { coordinator, cancelled } = seed(managed, `call-${hook}`);
    await middlewareFor(managed)[hook]();
    assert.equal(coordinator.size, 0, `${hook} discards even with a wait pending`);
    assert.equal(cancelled(), 1, `${hook} cancels the run`);
  }

  // (e) The pause must not disturb the cap/queue contract: a queued run still rolls forward when a
  // slot frees, and the cap still holds across the kept pause.
  {
    const managed = fakeParent(conversation([APPROVAL_PENDING]));
    managed.config = { maxConcurrentTasks: 1 };
    const middleware = middlewareFor(managed);
    const coordinator = getTaskPreforkCoordinator(managed);
    const starts = [];
    let releaseFirst;
    coordinator.start(
      "call-a",
      () => {},
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
      () => starts.push("a")
    );
    coordinator.start(
      "call-b",
      () => {},
      () => Promise.resolve({ subagentId: "sub-b", output: "done" }),
      () => starts.push("b")
    );
    await sleep(5);
    assert.deepEqual(starts, ["a"], "cap 1 admits the first run and queues the second");

    await middleware.onFinish();
    assert.equal(coordinator.size, 2, "the pause keeps the admitted run and the queued one");

    releaseFirst({ subagentId: "sub-a", output: "done" });
    await coordinator.join("call-a");
    await sleep(5);
    assert.deepEqual(starts, ["a", "b"], "the queued run still starts when the slot frees");
    assert.equal(coordinator.activeCount, 0, "no slot stays held once the runs are done");
    assert.equal(coordinator.size, 1, "…and the rolled-forward run is left for the tool phase to join");
  }

  console.log("ok  the discard call site keeps a pausing invocation's pre-forks");
}

// --- the middleware reads the chain the wait was detected on ---
//
// The value cases above pass fixtures in, so on their own they would also pass with a middleware that
// reads a channel nothing ever writes approval state to. The identity is the point: the status
// controller flips to `waiting` from `this.channel.getMessages()`, and `AgentChatController` wires
// that very channel onto the agent — which is the chain `onFinish` asks.
{
  const controller = readFileSync(join(SRC, "managers/controllers/agent-chat-controller.ts"), "utf8");
  assert.ok(
    /setUIChannel\(this\.channel\)/.test(controller),
    "the agent's UI channel IS the chat controller's chain, so `managed.getChatController().getMessages()` " +
      "is the same array the approval wait was detected in"
  );
  const src = readFileSync(join(SRC, "managers/middleware/task-prefork-middleware.ts"), "utf8");
  assert.ok(/managed\.getChatController\(\)\?\.getMessages\(\)/.test(src), "…and onFinish reads exactly that");
  console.log("ok  the pause test reads the chain the wait was detected on");
}

// --- a pre-fork that outlives its invocation stays reachable by a run-level abort ---
//
// Keeping the run across a pause is only safe if the run can still stop it. The `parentSignal` a
// pre-fork captures at spawn is replaced at the next pump (`setupAbortController` installs a fresh
// `currentAbortController` and merely DETACHES the old listeners), so the run's pending-abort list
// is what has to cover it. Source half first: the registration exists, and is removed when the run
// finishes so it cannot accumulate.
{
  const src = readFileSync(join(SRC, "managers/middleware/task-prefork-middleware.ts"), "utf8");
  const fn = /async function runPreForked\(([\s\S]*?)\n\}/.exec(src);
  assert.ok(fn, "runPreForked is present");
  assert.ok(
    /managed\?\.addPendingAbortController\(controller\)/.test(fn[1]),
    "the pre-fork registers its controller on the RUN's abort surface (a pump boundary replaces the " +
      "signal it captured at spawn)"
  );
  assert.ok(
    /managed\?\.removePendingAbortController\(controller\)/.test(fn[1]),
    "…and deregisters it when the run finishes, so a settled controller cannot accumulate"
  );
}
{
  // …and the surface itself drains what it holds, on both abort paths.
  const run = new RunCoordinator();
  const preFork = new AbortController();
  run.addPendingAbortController(preFork);
  run.abort("user-cancelled");
  assert.equal(preFork.signal.aborted, true, "RunCoordinator.abort() drains the pending list");
  assert.equal(preFork.signal.reason, "user-cancelled", "…carrying the run's reason (the stop taxonomy reads it)");

  const hosted = new RunCoordinator();
  const hostAbort = new AbortController();
  hosted.setupAbortController(hostAbort.signal, { onAborted: () => {} });
  const preFork2 = new AbortController();
  hosted.addPendingAbortController(preFork2);
  hostAbort.abort("host-abort");
  assert.equal(
    preFork2.signal.aborted,
    true,
    "a host-supplied abortSignal drains it too — the run-level abort that does NOT cascade to children"
  );
  console.log("ok  a surviving pre-fork stays reachable by a run-level abort");
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

// --- a cap lowered mid-run must not be overshot by promotion ---
//
// `promote()` is an admission, so it must re-read the cap provider; otherwise a lowered cap
// is silently ignored and queued runs refill the old window.

{
  let cap = 4;
  const coordinator = new TaskPreforkCoordinator(() => cap);
  const resolvers = {};
  for (const id of ["e0", "e1", "e2", "e3", "e4", "e5"]) {
    coordinator.start(
      id,
      () => {},
      () => new Promise((resolve) => (resolvers[id] = resolve))
    );
  }
  await sleep(0);
  assert.equal(coordinator.activeCount, 4, "4 admitted at cap 4; the rest queue");

  cap = 2;
  resolvers["e0"]({ subagentId: "e0", output: "e0" });
  await sleep(0);
  assert.equal(coordinator.activeCount, 3, "promotion must not refill a slot past the lowered cap");
}

// --- a throwing onRunStart must release its slot (no permanent stall) ---

{
  const coordinator = new TaskPreforkCoordinator(() => 1);
  coordinator.start(
    "x",
    () => {},
    async () => ({ subagentId: "x", output: "x" }),
    () => {
      throw new Error("telemetry boom");
    }
  );
  await sleep(0);
  assert.equal(coordinator.activeCount, 0, "the slot is released even when onRunStart throws");

  let ran = false;
  coordinator.start(
    "y",
    () => {},
    async () => {
      ran = true;
      return { subagentId: "y", output: "y" };
    }
  );
  await sleep(0);
  assert.equal(ran, true, "the next run is admitted after the fault");
}

// --- the cap is an AgentConfig field, so it survives updateConfig's schema round-trip ---

{
  const parsed = AgentConfigSchema.parse({ model: "m", maxConcurrentTasks: 6 });
  assert.equal(
    parsed.maxConcurrentTasks,
    6,
    "AgentConfigSchema keeps maxConcurrentTasks — updateConfig (AgentConfigSchema.parse) would otherwise strip it"
  );
  const stripped = AgentConfigSchema.parse({ model: "m", someUnknownExtra: 1 });
  assert.equal("someUnknownExtra" in stripped, false, "unknown agent extras are still stripped");
}

// --- a duplicate TOOL_CALL_END for a registered pre-fork disarms its own spawn ---
//
// `start` returns false when a run for that call id is already registered — the spawn it was called
// for registered nothing. The middleware reads that as "my parent-signal listener has no run to
// stop" and removes it. While `start` always returned true, that branch was dead code and every
// duplicated `TOOL_CALL_END` left a listener (and an AbortController) attached to the parent signal.

{
  const parentController = new AbortController();
  const parentSignal = parentController.signal;
  let removals = 0;
  const realRemove = parentSignal.removeEventListener.bind(parentSignal);
  parentSignal.removeEventListener = (...args) => {
    removals += 1;
    return realRemove(...args);
  };

  const managed = {
    id: "parent-dup",
    addPendingAbortController: () => {},
    removePendingAbortController: () => {},
  };
  const middleware = createTaskPreforkMiddleware({
    getManagedAgent: () => managed,
    // The middleware ties the pre-fork to the parent's current run through this lookup.
    manager: { getAgent: () => ({ run: { currentAbortController: parentController } }) },
  });

  // A run is already registered for this call id — the state a first `TOOL_CALL_END` leaves behind.
  let factoryRuns = 0;
  const coordinator = getTaskPreforkCoordinator(managed);
  const firstStarted = coordinator.start(
    "call-dup",
    () => {},
    async () => {
      factoryRuns += 1;
      return { aborted: false, summary: "…", reachedLimit: false, incomplete: false, truncated: false };
    }
  );
  assert.equal(firstStarted, true, "the first registration for a call id reports that it registered");
  assert.equal(
    coordinator.start(
      "call-dup",
      () => {},
      async () => ({})
    ),
    false,
    "a duplicate reports that it did not"
  );

  // Now the duplicate arrives the way the engine produces one: start chunk → end chunk.
  await middleware.onChunk({}, { type: "TOOL_CALL_START", toolCallId: "call-dup", toolName: "task" });
  await middleware.onChunk({}, { type: "TOOL_CALL_END", toolCallId: "call-dup", input: { prompt: "again" } });

  assert.equal(removals, 1, "the duplicate spawn removes the parent-abort listener it attached");
  assert.equal(coordinator.size, 1, "…and registers nothing: the first run is still the one to be joined");
  await sleep(5);
  assert.equal(factoryRuns, 1, "the duplicate did not run a second subagent");
}

console.log("task-prefork validation passed");

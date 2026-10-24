/**
 * Validates that a `task` call rejected at the tool phase discards its pre-fork immediately.
 *
 * The pre-fork starts at `TOOL_CALL_END`, before the tool phase — which is where a call can still be
 * refused (an extension's `tool:before:…` interceptor setting `event.skip`, a mode policy, a tool
 * cache). Those settle the call WITHOUT running `execute`, so nothing joins the eager run, and the
 * run-boundary discards in `validate-task-prefork.mjs` would only collect it once the whole attempt
 * ended. Two things are checked here: the per-call primitive's queue contract, and the tool-phase
 * hook that fires it.
 *
 * Kept beside (not inside) `validate-task-prefork.mjs`, which is at the file-length ceiling.
 *
 * Run: pnpm --filter @codent/core run validate:task-prefork-rejected-call
 */

import assert from "node:assert/strict";

import { createTaskPreforkMiddleware, getTaskPreforkCoordinator, TaskPreforkCoordinator } from "../dist/dev.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- a refused call discards its pre-fork at the tool phase ---
//
// The pre-fork starts at `TOOL_CALL_END`, before the tool phase — which is where a call can still be
// refused (an extension's `tool:before:…` interceptor setting `event.skip`, a mode policy, a tool
// cache). Those settle the call WITHOUT running `execute`, so nothing joins the eager run and the
// run-boundary discards would only collect it once the whole attempt ended.
{
  // Unit first: the per-call primitive must keep the queue contract `abortAll` established.
  {
    const coordinator = new TaskPreforkCoordinator(() => 1);
    const started = [];
    let cancelled = 0;
    coordinator.start(
      "call-running",
      () => {
        cancelled += 1;
      },
      () => new Promise(() => {}),
      () => started.push("running")
    );
    coordinator.start(
      "call-queued",
      () => {
        cancelled += 1;
      },
      () => Promise.resolve({ subagentId: "sub-q", output: "queued" }),
      () => started.push("queued")
    );
    await sleep(5);
    assert.deepEqual(started, ["running"], "cap 1 admits one run and queues the other");

    const discarded = coordinator.discard("call-queued", "tool-rejected");
    assert.equal(discarded?.toolCallId, "call-queued", "the refused call is reported");
    assert.equal(discarded.cause, "tool-rejected", "with its own cause, not a run boundary");
    assert.deepEqual(discarded.subagentIds, [], "a run that never started orphaned nothing");
    assert.equal(coordinator.has("call-queued"), false, "the entry is dropped");
    assert.equal(cancelled, 1, "its cancel handle fired");
    assert.equal(coordinator.has("call-running"), true, "the healthy sibling of the same turn is untouched");
    assert.equal(coordinator.activeCount, 1, "…and still holds its slot");
    await sleep(5);
    assert.deepEqual(started, ["running"], "the discarded queued run never starts");

    assert.equal(
      coordinator.discard("call-absent", "tool-rejected"),
      null,
      "nothing registered means nothing to report"
    );
    console.log("ok  coordinator.discard drops one run and leaves its siblings alone");
  }

  // …then the middleware, driven through the hook the tool phase actually calls.
  const middlewareFor = (managed, reported = []) =>
    createTaskPreforkMiddleware({
      getManagedAgent: () => managed,
      manager: { getAgent: () => undefined },
      emitEvent: (type, payload) => {
        if (type === "subagent:prefork-discarded") reported.push(payload);
      },
    });
  const fakeParent = () => ({ id: "parent-refused", config: {}, addPendingAbortController: () => {} });
  const settle = (middleware, toolName, toolCallId) =>
    middleware.onAfterToolCall({}, { toolName, toolCallId, ok: true, duration: 0, result: {} });

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

  // (a) A refused `task` call: the eager run stops as the call settles, not at the next boundary.
  {
    const managed = fakeParent();
    const reported = [];
    const { coordinator, cancelled } = seed(managed, "call-refused");
    await settle(middlewareFor(managed, reported), "task", "call-refused");
    assert.equal(coordinator.size, 0, "the refused call's run is dropped at the tool phase");
    assert.equal(cancelled(), 1, "…and cancelled, so it stops paying for a call nobody will join");
    assert.deepEqual(
      reported,
      [{ toolCallId: "call-refused", cause: "tool-rejected", subagentIds: ["sub-unjoined"] }],
      "the discard is reported with the cause + the orphan it names"
    );
  }

  // (b) Any other tool settling is not this hook's business.
  {
    const managed = fakeParent();
    const reported = [];
    const { coordinator, cancelled } = seed(managed, "call-other");
    await settle(middlewareFor(managed, reported), "read_file", "call-other");
    assert.equal(coordinator.size, 1, "a non-task tool leaves the run registered");
    assert.equal(cancelled(), 0);
    assert.deepEqual(reported, []);
  }

  // (c) The healthy path: `execute` joins the run, which removes the entry BEFORE awaiting it — so
  // the same hook must find nothing and report nothing.
  {
    const managed = fakeParent();
    const reported = [];
    let release;
    const coordinator = getTaskPreforkCoordinator(managed);
    coordinator.start(
      "call-joined",
      () => {},
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const joining = coordinator.join("call-joined");
    assert.equal(coordinator.has("call-joined"), false, "join releases the entry synchronously");
    await settle(middlewareFor(managed, reported), "task", "call-joined");
    assert.deepEqual(reported, [], "a joined call is never reported as discarded");
    release({ subagentId: "sub-joined", output: "findings" });
    assert.equal((await joining)?.output, "findings", "…and its own result survives");
  }

  console.log("ok  a refused task call discards its pre-fork at the tool phase");
}

console.log("task-prefork rejected-call validation passed");

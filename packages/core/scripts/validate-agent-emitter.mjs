/**
 * Validates typed Emitter + domain migrations (todos / usage / log).
 *
 * Run: pnpm --filter @codent/core run validate:agent-emitter
 */
import assert from "node:assert/strict";

import { createAgentEventBus, Emitter, TodoManager, UsageTracker } from "../dist/dev.mjs";

// --- AgentLog (persistence-only: no in-memory emitter, entries go to the sink) ---
import { createLogCapture, waitFor } from "./helpers/log-capture.mjs";

// --- primitive ---
const emitter = new Emitter();
const seen = [];
const unsub = emitter.on("ping", (payload) => {
  seen.push(payload);
});
emitter.emit("ping", { n: 1 });
emitter.emit("ping", { n: 2 });
unsub();
emitter.emit("ping", { n: 3 });
assert.deepEqual(seen, [{ n: 1 }, { n: 2 }]);
assert.equal(emitter.listenerCount("ping"), 0);

// A stale disposer must not delete a listener set created by a LATER subscription.
{
  const reap = new Emitter();
  const stale = reap.on("tick", () => {});
  stale();
  let calls = 0;
  reap.on("tick", () => {
    calls += 1;
  });
  stale(); // second call, now that a new Set owns the entry
  reap.emit("tick", null);
  assert.equal(calls, 1, "a stale disposer leaves a re-created listener set alone");
}

// An async listener's rejection goes to `onListenerError` (a `void`-typed subscriber may still be
// async), and a reporter that throws cannot break the remaining listeners or escape the catch.
{
  const asyncBus = new Emitter();
  const errors = [];
  let second = 0;
  asyncBus.on("async", async () => {
    throw new Error("boom");
  });
  asyncBus.on("async", () => {
    second += 1;
  });
  asyncBus.emit("async", null, (error) => {
    errors.push(String(error));
    throw new Error("reporter broke");
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(second, 1, "the sync listener still receives the frame");
  assert.equal(errors.length, 1, "the async rejection reaches the reporter");
  assert.match(errors[0], /boom/);
}

// --- TodoManager (session `todos` projection on the unified bus) ---
const todosBus = createAgentEventBus();
const todos = new TodoManager();
todos.setEventBus(todosBus);
/** @type {unknown[]} */
const todoPayloads = [];
const unsubTodos = todosBus.on(
  "session:todos",
  (event) => {
    todoPayloads.push(event.payload);
  },
  { replay: false }
);
todos.update([{ content: "a", status: "pending", priority: "medium" }], "t1");
assert.equal(todoPayloads.length, 1);
assert.equal(todoPayloads[0].items[0].content, "a");
unsubTodos();
todos.update([{ content: "b", status: "pending", priority: "medium" }], "t2");
assert.equal(todoPayloads.length, 1);

// --- UsageTracker (session `usage` projection on the unified bus) ---
const usageBus = createAgentEventBus();
const usage = new UsageTracker();
usage.setEventBus(usageBus);
/** @type {unknown[]} */
const usagePayloads = [];
const unsubUsage = usageBus.on(
  "session:usage",
  (event) => {
    usagePayloads.push(event.payload);
  },
  { replay: false }
);
usage.updateWindowUsage({
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
});
assert.equal(usagePayloads.length, 1);
assert.equal(usagePayloads[0].total.inputTokens, 10);
assert.equal(usagePayloads[0].total.outputTokens, 5);
assert.equal(usagePayloads[0].window.inputTokens, 10);
unsubUsage();
usage.addTotal({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
assert.equal(usagePayloads.length, 1);

const capture = await createLogCapture("agent-emitter");
assert.equal(typeof capture.log.on, "undefined", "AgentLog has no event emitter (persistence-only)");
capture.log.info("system", "hello emitter");
// Poll instead of sleeping: `flush()` clears its buffer synchronously and only then does
// the async fs work, so a fixed sleep can read the file inside that window and see 0
// entries on a loaded runner (the sink flushes on an interval, not on write).
const logEntries = await waitFor(capture.readEntries, (entries) => entries.length >= 1);
assert.equal(logEntries.length, 1);
assert.equal(logEntries[0].message, "hello emitter");
capture.log.info("system", "after check");
assert.equal((await waitFor(capture.readEntries, (entries) => entries.length >= 2)).length, 2);

console.log("agent-emitter validation passed");

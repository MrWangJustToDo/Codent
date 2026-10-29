/**
 * Validates the middleware echo under the timeline contract: hook-call echoes are OFF by
 * default (the log policy gates them on `MY_AGENT_LOG_HOOKS`), return values (sync +
 * async/promise) pass through untouched in both modes, and high-frequency onChunk and
 * nested sandbox hooks are never wrapped.
 *
 * The wrapper emits `hooks:echo` and the policy decides whether it becomes a row, so this
 * harness wires the real bridge instead of handing the wrapper a log handle — asserting the
 * wrapper alone would prove nothing about what reaches the file.
 *
 * Run: pnpm --filter @codent/core run validate:middleware-log
 */

import assert from "node:assert/strict";

import { bridgeTelemetryToAgentLog, createAgentEventBus, instrumentMiddlewareLog } from "../dist/dev.mjs";

import { createLogCapture, waitFor } from "./helpers/log-capture.mjs";

// A realistic ChatMiddleware-shaped object (plain object, like the create*
// factories return).
const calls = [];
const middleware = [
  {
    name: "test-middleware",
    onConfig: (ctx, config) => {
      calls.push({ hook: "onConfig", phase: ctx.phase, iteration: ctx.iteration });
      return { messages: [...config.messages, "transformed"] };
    },
    onStart: (ctx) => {
      calls.push({ hook: "onStart", phase: ctx.phase, iteration: ctx.iteration });
    },
    // High-frequency hooks that must NOT be logged or wrapped.
    onChunk: () => {
      calls.push({ hook: "onChunk" });
      return "chunk";
    },
    sandbox: {
      onFile: () => {},
    },
  },
  {
    // No name → anonymous fallback.
    onIteration: async (ctx) => {
      calls.push({ hook: "onIteration", phase: ctx.phase, iteration: ctx.iteration });
      return "iter";
    },
  },
];

const ctx = {
  phase: "beforeModel",
  iteration: 2,
};

const capture = await createLogCapture("middleware-log");
const { log, readEntries } = capture;
const bus = createAgentEventBus();
bridgeTelemetryToAgentLog(bus, () => log);
const emitEvent = (type, payload) => bus.emit(type, payload, { agentId: "agent-1" });
/** Every echo that reached the BUS — the emitter-level assertion the sink read cannot make. */
const echoes = [];
bus.on("*", (event) => {
  if (event.type === "hooks:echo") echoes.push(event);
});

const wrapped = instrumentMiddlewareLog(middleware, emitEvent);

// ----------------------------------------------------------------------------
// 1. Default (MY_AGENT_LOG_HOOKS unset): no hook echoes, returns still pass.
// ----------------------------------------------------------------------------
delete process.env.MY_AGENT_LOG_HOOKS;

const configOut = wrapped[0].onConfig(ctx, { messages: ["a"] });
assert.deepEqual(configOut, { messages: ["a", "transformed"] }, "onConfig return passes through");
assert.deepEqual(calls[0], { hook: "onConfig", phase: "beforeModel", iteration: 2 });

const startOut = wrapped[0].onStart(ctx);
assert.equal(startOut, undefined, "onStart void return passes through");

const iterOut = await wrapped[1].onIteration(ctx);
assert.equal(iterOut, "iter", "async hook return passes through");

assert.equal(wrapped[0].onChunk(ctx), "chunk", "onChunk untouched");
assert.equal(typeof wrapped[0].sandbox.onFile, "function", "sandbox untouched");
assert.equal(wrapped[0].onChunk === middleware[0].onChunk, true, "onChunk identity preserved (not wrapped)");

// Negative assertion: the emitter must not even EMIT the echo. Reading the file alone was a race
// (the sink's flush timer had not run, so a stray write still read as 0); the bus count is immediate
// and the flush makes the file check real.
await log.flush();
assert.equal(echoes.length, 0, `no hook echo is emitted with the flag off, got ${echoes.length}`);
const defaultEntries = await readEntries();
assert.equal(defaultEntries.length, 0, `no hook echoes by default, got ${JSON.stringify(defaultEntries)}`);
console.log("hook echoes off by default, passthrough intact: OK");

// ----------------------------------------------------------------------------
// 2. Opt-in (MY_AGENT_LOG_HOOKS=1): the policy records category/level/phase/iteration.
// ----------------------------------------------------------------------------
process.env.MY_AGENT_LOG_HOOKS = "1";

wrapped[0].onConfig(ctx, { messages: ["a"] });
await wrapped[1].onIteration(ctx);

const entries = await waitFor(readEntries, (list) => list.length >= 2);
assert.ok(entries.length >= 2, `expected >=2 hook entries, got ${entries.length}`);
for (const entry of entries) {
  assert.equal(entry.category, "hooks", `category hooks, got ${entry.category}`);
  assert.equal(entry.level, "debug", `level debug, got ${entry.level}`);
  assert.equal(entry.event, "hooks:echo", `stamped with the originating event, got ${entry.event}`);
}

assert.ok(
  entries.some((e) => e.message === "middleware:test-middleware:onConfig"),
  `has test-middleware:onConfig entry, got ${entries.map((e) => e.message).join(", ")}`
);
assert.ok(
  entries.some((e) => e.message === "middleware:anonymous:onIteration"),
  `has anonymous:onIteration entry, got ${entries.map((e) => e.message).join(", ")}`
);

const onConfigEntry = entries.find((e) => e.message === "middleware:test-middleware:onConfig");
assert.deepEqual(onConfigEntry.data, { phase: "beforeModel", iteration: 2 }, "phase+iteration in data");

console.log("opt-in hooks logged with phase+iteration: OK");
console.log("middleware-log validation passed");

/**
 * Validates the extension registration lease: a disabled extension cannot register anything.
 *
 * The context handed to `activate` IS the lease. Exactly one context per instance incarnation is
 * registered on the runner; disabling/destroying deletes it, and re-enabling hands the extension a
 * NEW context. Three reported defects came from not having that identity:
 *
 *   1. **Revival after disable.** A callback the extension retained (a timer, a promise
 *      continuation) could call `ctx.registerTool` / `registerCommand` / `registerMessageTransformer`
 *      after the panel said "disabled": the tool reappeared in the live catalog and the
 *      registrations list had already been cleared, so a later disable could not even find it.
 *   2. **A false toggle result.** `setEnabled(false)` during `activate()` read the state an
 *      activation STARTS from (`inactive`) and answered "already disabled" — then the activation
 *      finished and the extension was active. The caller was told something untrue.
 *   3. **Destroy during activation.** `destroyAll()` emptied the instance table while an in-flight
 *      `activate()` kept registering into that empty table.
 *
 * What this pins:
 *   1. After a disable, late tool registrations are refused (and the refusal is logged once, not
 *      once per tick).
 *   2. A toggle during activation fails honestly instead of lying; the activation then completes.
 *   3. `destroyAll()` during activation leaves no artifacts and no instance.
 *   4. Re-enabling hands out a fresh context — a stale `ctx` from the previous incarnation is dead,
 *      which is what closes the "leaked timer fires after re-enable" variant.
 *
 * Run: pnpm --filter @codent/core run validate:extension-lifecycle-lease
 */

import assert from "node:assert/strict";

import { ExtensionRunner } from "../dist/dev.mjs";

// ============================================================================
// Harness
// ============================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A runner whose host side keeps a simple name → owner map, plus an optional log sink. */
function makeRunner() {
  const tools = new Map();
  const commands = new Map();
  const logEntries = [];
  const runner = new ExtensionRunner({
    onRegisterTool: (def, ownerId) => tools.set(def.name, { ownerId, def }),
    onUnregisterTool: (name, ownerId) => {
      if (tools.get(name)?.ownerId === ownerId) tools.delete(name);
    },
    onRegisterCommand: (cmd) => commands.set(cmd.name, cmd),
    onUnregisterCommand: (name) => commands.delete(name),
    log: {
      debug: () => {},
      info: () => {},
      warn: (category, message) => logEntries.push({ level: "warn", category, message }),
      error: (category, message) => logEntries.push({ level: "error", category, message }),
    },
  });
  return { runner, tools, commands, logEntries };
}

const toolDef = (name) => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  execute: async () => ({}),
});

// ============================================================================
// 1. A late registration after disable is refused (and logged once)
// ============================================================================
{
  const { runner, tools, logEntries } = makeRunner();
  let captured;
  await runner.loadExtension({
    id: "late",
    name: "late",
    activate(ctx) {
      captured = ctx;
    },
  });
  assert.deepEqual(runner.getTools(), [], "activate registered nothing");

  await runner.setEnabled("late", false);
  assert.equal(runner.getExtensionInfos()[0].state, "inactive");

  // A retained callback fires after the disable — twice, to prove the warning is per revoke.
  captured.registerTool(toolDef("late-tool"));
  captured.registerTool(toolDef("late-tool-2"));
  await sleep(20);

  assert.deepEqual(runner.getTools(), [], "a post-disable registration must not revive a tool");
  assert.equal(tools.size, 0, "and must not reach the host registry either");
  assert.deepEqual(runner.getExtensionInfos()[0].tools, [], "nor the instance's registrations");

  const refusals = logEntries.filter((entry) => entry.message.includes("registerTool()"));
  assert.equal(refusals.length, 1, "one warning per revoke, not one per leaked callback");
  assert.equal(refusals[0].level, "warn");

  // A second disable still reports the plain answer: there is nothing to clean up.
  assert.deepEqual(await runner.setEnabled("late", false), {
    ok: true,
    message: 'Extension "late" already disabled',
  });
}

// ============================================================================
// 2. Toggling during activation fails honestly, then the activation completes
// ============================================================================
{
  const { runner } = makeRunner();
  let finishActivate;
  const activationGate = new Promise((resolve) => {
    finishActivate = resolve;
  });
  const loading = runner.loadExtension({
    id: "slow",
    name: "slow",
    async activate(ctx) {
      await activationGate;
      ctx.registerTool(toolDef("slow-tool"));
    },
  });
  await tick();

  const during = await runner.setEnabled("slow", false);
  assert.equal(during.ok, false, "a toggle during activation must not claim success");
  assert.match(during.message, /activating/i, "and must say why");

  finishActivate();
  await loading;
  assert.equal(runner.getExtensionInfos()[0].state, "active", "the activation itself still completes");
  assert.deepEqual(
    runner.getTools().map((def) => def.name),
    ["slow-tool"],
    "and its registration lands"
  );
}

// ============================================================================
// 3. destroyAll() during activation leaves nothing behind
// ============================================================================
{
  const { runner, tools } = makeRunner();
  let finishActivate;
  const activationGate = new Promise((resolve) => {
    finishActivate = resolve;
  });
  const loading = runner.loadExtension({
    id: "doomed",
    name: "doomed",
    async activate(ctx) {
      await activationGate;
      ctx.registerTool(toolDef("doomed-tool"));
    },
  });
  await tick();

  await runner.destroyAll();
  finishActivate();
  await loading;

  assert.deepEqual(runner.getTools(), [], "a destroyed runner must not gain a tool afterwards");
  assert.equal(tools.size, 0, "the host registry stays empty");
  assert.deepEqual(runner.getExtensionInfos(), [], "and no instance is resurrected");
}

// ============================================================================
// 4. Re-enable hands out a fresh context; a stale one is dead
// ============================================================================
{
  const { runner, tools } = makeRunner();
  const contexts = [];
  await runner.loadExtension({
    id: "cycle",
    name: "cycle",
    activate(ctx) {
      contexts.push(ctx);
      ctx.registerTool(toolDef(`cycle-tool-${contexts.length}`));
    },
  });
  assert.equal(contexts.length, 1);

  await runner.setEnabled("cycle", false);
  await runner.setEnabled("cycle", true);
  assert.equal(contexts.length, 2, "re-enable calls activate with a context");
  assert.notEqual(contexts[1], contexts[0], "…a NEW one: the context is the lease");

  // The stale context cannot register into the new incarnation.
  contexts[0].registerTool(toolDef("ghost-tool"));
  assert.equal(tools.has("ghost-tool"), false, "a stale context is dead after re-enable");
  assert.equal(tools.has("cycle-tool-2"), true, "the live context's registration stands");

  // And the live one still can (the lease was re-issued, not locked shut).
  contexts[1].registerTool(toolDef("second-tool"));
  assert.equal(tools.has("second-tool"), true);
}

// ============================================================================
// 5. The lease covers the two side-effecting surfaces: ctx.llm and ctx.events.emit
// ============================================================================
//
// Both were outside it. `ctx.llm.complete` had no `isLive` check at all, so an extension that kept a
// timer (the documented pattern) could spend the user's tokens and the session's budget after the
// panel said "disabled". `ctx.events.emit` could still drive OTHER extensions' interceptors. Neither
// reaches the host's own state (`emit` goes to interception only, never to observers/retained), so
// the fix is a refusal, not a rollback.
{
  const tools = new Map();
  const runner = new ExtensionRunner({
    onRegisterTool: (def, ownerId) => tools.set(def.name, { ownerId, def }),
    onUnregisterTool: (name, ownerId) => {
      if (tools.get(name)?.ownerId === ownerId) tools.delete(name);
    },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    // A runtime is required for the live path to succeed; without it the assertion below would pass
    // for the wrong reason (the "no-adapter" rejection).
    getRuntime: () => ({ complete: async () => ({ text: "ok" }) }),
  });

  let fired = 0;
  let live;
  let revoked;
  await runner.loadExtension({
    id: "interceptor",
    name: "interceptor",
    activate(ctx) {
      live = ctx;
      ctx.registerInterceptor("test:lease-probe", () => {
        fired += 1;
        return false;
      });
    },
  });
  await runner.loadExtension({
    id: "caller",
    name: "caller",
    activate(ctx) {
      revoked = ctx;
    },
  });

  assert.deepEqual(await revoked.llm.complete({ prompt: "hi" }), { text: "ok" }, "a live extension may call the model");
  await revoked.events.emit({ type: "test:lease-probe", payload: {} });
  assert.equal(fired, 1, "a live extension's emit reaches another extension's interceptor");
  assert.equal(revoked.events.hasInterceptors("test:lease-probe"), true);

  await runner.setEnabled("caller", false);

  await assert.rejects(
    () => revoked.llm.complete({ prompt: "hi" }),
    (error) => error?.code === "revoked",
    "a revoked extension's completion is refused (it must not spend tokens)"
  );
  await revoked.events.emit({ type: "test:lease-probe", payload: {} });
  assert.equal(fired, 1, "and its emit no longer reaches anyone");
  assert.equal(revoked.events.hasInterceptors("test:lease-probe"), false, "nor does it advertise interceptors");

  // The live extension is unaffected — this is a lease, not a global switch.
  assert.equal(live.events.hasInterceptors("test:lease-probe"), true);
  await live.events.emit({ type: "test:lease-probe", payload: {} });
  assert.equal(fired, 2);

  await runner.destroyAll();
}

console.log("\nvalidate-extension-lifecycle-lease: all assertions passed");

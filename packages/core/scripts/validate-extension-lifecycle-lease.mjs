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
 *   2. Disabling during activation is honored: the lease is revoked, nothing lands, and the
 *      activation ends inactive. (A hung activation must not make the extension impossible to
 *      turn off — that is the one remedy a broken extension needs.)
 *   3. `destroyAll()` during activation leaves no artifacts, no instance, and releases resources
 *      the rest of `activate` acquired after the teardown's `deactivate` ran.
 *   4. Re-enabling hands out a fresh context — a stale `ctx` from the previous incarnation is dead,
 *      which is what closes the "leaked timer fires after re-enable" variant.
 *
 * Run: pnpm --filter @codent/core run validate:extension-lifecycle-lease
 */

import assert from "node:assert/strict";

import { bridgeTelemetryToAgentLog, createAgentEventBus, ExtensionRunner } from "../dist/dev.mjs";

// ============================================================================
// Harness
// ============================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A runner whose host side keeps a simple name → owner map, plus the rows its log received. */
function makeRunner(overrides = {}) {
  const tools = new Map();
  const commands = new Map();
  const logEntries = [];
  // `ctx.logger` publishes `extension:log` on the bus; the bridge turns that into one log row. The
  // stub records the bridge's write instead of a file, which is what the assertions below need —
  // "the refusal was recorded once" — without waiting for a flush interval.
  const bus = createAgentEventBus();
  bridgeTelemetryToAgentLog(bus, () => ({
    eventEntry: (level, category, _eventType, message) => {
      logEntries.push({ level, category, message });
      return null;
    },
  }));
  const disabledCalls = [];
  const runner = new ExtensionRunner({
    eventBus: bus,
    onRegisterTool: (def, ownerId) => tools.set(def.name, { ownerId, def }),
    onUnregisterTool: (name, ownerId) => {
      if (tools.get(name)?.ownerId === ownerId) tools.delete(name);
    },
    onRegisterCommand: (cmd) => commands.set(cmd.name, cmd),
    onUnregisterCommand: (name) => commands.delete(name),
    onExtensionDisabled: (extensionId, notice) => disabledCalls.push({ extensionId, notice }),
    ...overrides,
  });
  return { runner, tools, commands, logEntries, bus, disabledCalls };
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
  const { runner, tools, logEntries, disabledCalls } = makeRunner();
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
  assert.equal(disabledCalls.length, 1, "the host is told once about the disable");
  assert.match(disabledCalls[0].notice, /disabled/, "…with the notice the turn snapshot should carry");

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
// 1b. The lease is revoked BEFORE the (slow) deactivate runs
//
// `deactivate()` can await real work (the LSP extension shuts every server down). Removing tools
// and interceptors only after it returned meant a disabled extension kept running tools and
// rewriting the wire for the whole teardown; a message transformer has no per-call lease check of
// its own, so this ordering is the only thing that stops it.
// ============================================================================
{
  const { runner, tools } = makeRunner();
  let captured;
  let releaseDeactivate;
  const deactivateGate = new Promise((resolve) => {
    releaseDeactivate = resolve;
  });
  await runner.loadExtension({
    id: "slow-off",
    name: "slow-off",
    activate(ctx) {
      captured = ctx;
      ctx.registerTool(toolDef("slow-off-tool"));
    },
    async deactivate() {
      await deactivateGate;
    },
  });
  assert.notEqual(runner.contextFor("slow-off"), undefined, "the active extension has a live lease");

  const disabling = runner.setEnabled("slow-off", false);
  await tick();
  assert.equal(runner.contextFor("slow-off"), undefined, "the lease is gone while deactivate is still awaiting");

  // A retained callback firing in that window must be refused, not land a tool on a disabled ext.
  captured.registerTool(toolDef("slow-off-late"));
  assert.equal(tools.has("slow-off-late"), false, "a release-time registration is refused");

  releaseDeactivate();
  assert.equal((await disabling).ok, true, "the disable completes");
  assert.equal(runner.contextFor("slow-off"), undefined, "and the lease stays revoked");
}

// ============================================================================
// 2. Disabling during activation revokes it, then the activation lands inactive
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
  assert.equal(during.ok, true, "disabling during activation is honored, not refused");
  assert.match(during.message, /revoked/i, "and says the activation was revoked");

  finishActivate();
  await loading;
  assert.equal(runner.getExtensionInfos()[0].state, "inactive", "a revoked activation must not become active");
  assert.deepEqual(runner.getTools(), [], "and its registration is refused");
}

// ============================================================================
// 2b. The same during a RUNTIME enable (the pending-toggle guard must not win)
// ============================================================================
//
// A runtime enable holds BOTH `pendingToggles` (the non-reentrancy guard around `applyEnabled`) and
// `activating` (set inside it). Checking the toggle guard first answered "already being toggled" and
// made a hung `activate()` impossible to turn off — the one remedy the revoke branch exists for.
{
  const { runner, tools } = makeRunner();
  let finishActivate;
  let activations = 0;
  const activationGate = new Promise((resolve) => {
    finishActivate = resolve;
  });
  await runner.loadExtension({
    id: "slow-enable",
    name: "slow-enable",
    async activate(ctx) {
      activations += 1;
      // The initial load and the post-revoke re-enable return immediately; only the second call
      // (the runtime enable being revoked) hangs.
      if (activations !== 2) return;
      await activationGate;
      ctx.registerTool(toolDef("slow-enable-tool"));
    },
  });
  await runner.setEnabled("slow-enable", false);

  const enabling = runner.setEnabled("slow-enable", true);
  await tick();
  const disabling = await runner.setEnabled("slow-enable", false);
  assert.equal(disabling.ok, true, "a hung RUNTIME activation can still be disabled");
  assert.match(disabling.message, /revoked/i, "and reports the activation as revoked");

  // The revoke must release the toggle guard immediately: the hung enable's `finally` has not run
  // yet, and waiting for an activation that may never settle made the extension unusable.
  const reenabled = await runner.setEnabled("slow-enable", true);
  assert.equal(reenabled.ok, true, "a revoked activation does not block an immediate re-enable");
  assert.equal(runner.getExtensionInfos()[0].state, "active");

  finishActivate();
  await enabling;
  assert.equal(
    runner.getExtensionInfos()[0].state,
    "active",
    "the superseded activation stands down instead of disabling the new incarnation"
  );
  assert.equal(tools.has("slow-enable-tool"), false, "its late registration is refused");
}

// ============================================================================
// 3. destroyAll() during activation leaves nothing behind
// ============================================================================
{
  const { runner, tools } = makeRunner();
  let finishActivate;
  let deactivations = 0;
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
    async deactivate() {
      deactivations += 1;
    },
  });
  await tick();

  await runner.destroyAll();
  finishActivate();
  await loading;

  assert.deepEqual(runner.getTools(), [], "a destroyed runner must not gain a tool afterwards");
  assert.equal(tools.size, 0, "the host registry stays empty");
  assert.deepEqual(runner.getExtensionInfos(), [], "and no instance is resurrected");
  assert.equal(
    deactivations,
    2,
    "the revoke branch releases again — the teardown's deactivate ran before activate returned, " +
      "so resources acquired afterwards had no other owner"
  );
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
  await revoked.events.intercept({ type: "test:lease-probe", payload: {} });
  assert.equal(fired, 1, "a live extension's emit reaches another extension's interceptor");
  assert.equal(revoked.events.hasInterceptors("test:lease-probe"), true);

  await runner.setEnabled("caller", false);

  await assert.rejects(
    () => revoked.llm.complete({ prompt: "hi" }),
    (error) => error?.code === "revoked",
    "a revoked extension's completion is refused (it must not spend tokens)"
  );
  await revoked.events.intercept({ type: "test:lease-probe", payload: {} });
  assert.equal(fired, 1, "and its emit no longer reaches anyone");
  assert.equal(revoked.events.hasInterceptors("test:lease-probe"), false, "nor does it advertise interceptors");

  // The live extension is unaffected — this is a lease, not a global switch.
  assert.equal(live.events.hasInterceptors("test:lease-probe"), true);
  await live.events.intercept({ type: "test:lease-probe", payload: {} });
  assert.equal(fired, 2);

  await runner.destroyAll();
}

// ----------------------------------------------------------------------------
// `observe` is restricted to the declared observable set at RUNTIME too
//
// The types say `ObservableExtensionEvent`, but an extension is plain JS at runtime:
// `observe("*")` would become a second wildcard consumer (core's Event→Log bridge must stay the
// only one), and an internal event name would deliver exactly what `observeAny` withholds.
// ----------------------------------------------------------------------------
{
  const { runner, logEntries, bus } = makeRunner();
  let observed = 0;
  await runner.loadExtension({
    id: "observe-scope",
    name: "observe-scope",
    activate(ctx) {
      ctx.events.observe("*", () => {
        observed += 1;
      });
      ctx.events.observe("tool:chunk", () => {
        observed += 1;
      });
      ctx.events.observe("session:start", () => {
        observed += 1;
      });
    },
  });

  await bus.emit("session:start", {}, { agentId: "observe-scope" });
  await bus.emit("tool:chunk", {}, { agentId: "observe-scope" });
  assert.equal(observed, 1, "only the valid observable subscription fires");
  assert.equal(
    logEntries.filter((entry) => /not an observable extension event/.test(entry.message)).length,
    2,
    "one warning per refused type"
  );
  await runner.destroyAll();
}

// ----------------------------------------------------------------------------
// `ctx.logger` is an event, and an observer that logs must not recurse.
//
// `extension:log` is observable (it has to be: the wildcard log consumer is what records it), so an
// extension logging from its own observer is one frame away from an infinite loop. The emitter drops
// a nested log while one is dispatching; this is the only test of that guard.
// ----------------------------------------------------------------------------
{
  const { runner, logEntries } = makeRunner();
  let observed = 0;
  const api = {
    id: "logger-loop",
    name: "logger-loop",
    async activate(ctx) {
      // `observeAny`, not `observe("*")`: the wildcard is refused at runtime now (the Event→Log
      // bridge must stay core's only wildcard consumer). This test is about logger recursion.
      ctx.events.observeAny(() => {
        observed += 1;
        ctx.logger.warn("nested from observer");
      });
      ctx.logger.info("first");
    },
  };
  await runner.loadExtension(api);
  const extensionRows = () => logEntries.filter((entry) => entry.message.includes("[extension:logger-loop]"));
  assert.equal(extensionRows().length, 1, "the first log is recorded");
  assert.equal(observed, 1, "the observer saw that one event");

  const ctx = runner.contextFor("logger-loop");
  assert.ok(ctx, "live context");
  ctx.logger.info("second");
  assert.equal(
    extensionRows().length,
    2,
    `a nested log is dropped, so each outer log is one row (got ${extensionRows().length})`
  );
  assert.ok(observed >= 2, "the observer still runs for the outer frame");
  await runner.destroyAll();
}

// ----------------------------------------------------------------------------
// A load config can declare the extension disabled
//
// `ExtensionConfig.enabled` was part of the public type and read nowhere, so a host passing
// `{ id, enabled: false }` activated the extension anyway — and `ctx.env` (the other half of the
// same config object) had no source. The instance must exist for the management panel and for a
// later `setEnabled(id, true)`, but register nothing and own no live context.
// ----------------------------------------------------------------------------
{
  const { runner, tools } = makeRunner();
  let activated = 0;
  const api = {
    id: "pre-disabled",
    name: "Pre-disabled",
    version: "1.0.0",
    description: "",
    async activate(ctx) {
      activated += 1;
      ctx.registerTool({ ...toolDef("pre-disabled-tool") });
    },
  };
  const instance = await runner.loadExtension(api, { id: "pre-disabled", enabled: false });
  assert.equal(instance.state, "inactive", "a disabled load is registered but not activated");
  assert.equal(activated, 0, "activate() is never called");
  assert.deepEqual(runner.getTools(), [], "no tool is registered");
  assert.equal(tools.size, 0, "and nothing reaches the host registry");
  const info = runner.getExtensionInfos().find((entry) => entry.id === "pre-disabled");
  assert.ok(info, "the management panel still sees the instance");
  assert.equal(info.enabled, false);
  assert.equal(runner.contextFor("pre-disabled"), undefined, "a disabled load owns no live context");

  const enabled = await runner.setEnabled("pre-disabled", true);
  assert.equal(enabled.ok, true, "the instance can be enabled later");
  assert.equal(activated, 1);
  assert.ok(tools.has("pre-disabled-tool"), "enabling activates it for real");
  await runner.destroyAll();
}

// ----------------------------------------------------------------------------
// A failed activation is one outcome regardless of the door
//
// `loadExtension` emitted `agent:extension-error` on a throw; a runtime re-enable did not (only
// `deactivate`/`flush` failures emitted). The two activation paths now share one transaction, so a
// failed retry is recorded like a failed initial load.
// ----------------------------------------------------------------------------
{
  const { runner, logEntries } = makeRunner();
  let attempts = 0;
  const instance = await runner.loadExtension({
    id: "fails-on-retry",
    name: "fails-on-retry",
    async activate() {
      attempts += 1;
      if (attempts > 1) throw new Error("retry exploded");
    },
  });
  assert.equal(instance.state, "active", "the first activation succeeds");

  await runner.setEnabled("fails-on-retry", false);
  const retry = await runner.setEnabled("fails-on-retry", true);
  assert.equal(retry.ok, false, "the failed re-enable reports failure");
  assert.match(retry.message, /retry exploded/);
  assert.equal(runner.getExtensionInfos()[0].state, "error", "and the instance is errored");
  assert.ok(
    logEntries.some((entry) => entry.level === "error" && /retry exploded/.test(entry.message)),
    "a failed re-enable emits agent:extension-error, like an initial load failure"
  );
  await runner.destroyAll();
}

// ----------------------------------------------------------------------------
// A lifecycle callback that never settles is bounded
// ----------------------------------------------------------------------------
// Extensions are third-party code and none of these callbacks has a bounded-work contract, while
// bootstrap awaits `activate` serially: one promise that never settles kept the agent — and every
// later extension — from ever existing. A hung `deactivate` was worse: `pendingToggles` kept its
// token forever, so the extension could never be toggled again.
{
  const { runner } = makeRunner({ callbackTimeoutMs: 20 });
  const instance = await runner.loadExtension({
    id: "hung-activate",
    name: "hung-activate",
    activate: () => new Promise(() => {}),
  });
  assert.equal(instance.state, "error", "a hung activate is a failed activation, not an unbounded wait");
  assert.match(String(instance.error?.message), /did not settle/, "and says it timed out");
  assert.equal(runner.getExtensionInfos()[0].enabled, false, "the panel reflects the failure");
  await runner.destroyAll();
}
{
  const { runner } = makeRunner({ callbackTimeoutMs: 20 });
  await runner.loadExtension({
    id: "hung-deactivate",
    name: "hung-deactivate",
    activate() {},
    deactivate: () => new Promise(() => {}),
  });

  const off = await runner.setEnabled("hung-deactivate", false);
  assert.equal(off.ok, true, "a hung deactivate does not fail the disable");
  assert.equal(runner.getExtensionInfos()[0].enabled, false, "and the extension is disabled");

  const on = await runner.setEnabled("hung-deactivate", true);
  assert.equal(on.ok, true, "a hung deactivate must not lock the toggle token forever");
  await runner.destroyAll();
}

console.log("\nvalidate-extension-lifecycle-lease: all assertions passed");

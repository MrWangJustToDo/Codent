/**
 * Regression gate for two `ManagedAgent` state bugs found in the core review.
 *
 * Both are silent-wrong-behavior bugs (no crash, no error) — the kind only a direct
 * assertion catches:
 *
 * 1. **Switching to a model with no metadata resets the capability gate (P0-5).**
 *    `setModel` only called `usage.setCapabilities` inside `if (next.modelInfo)`. With
 *    no metadata (unknown id / offline) the previous model's gate survived, so a
 *    stale `[]` stripped images the new vision model accepts and a stale
 *    `[vision]` sent images to an endpoint that rejects them. `undefined` means
 *    "unknown" (permissive), which is the correct reset.
 * 2. **Switching sessions stops the in-flight run (P0-3).** `restoreSession` replaced
 *    the channel without aborting a live pump, so the pump kept writing chunks into
 *    the freshly restored transcript and persisted the mixture.
 *
 * Run: pnpm --filter @codent/core run validate-managed-agent-state
 */

import assert from "node:assert/strict";

import { AgentLog, ManagedAgent } from "../dist/dev.mjs";
import { AgentManager, registerCoreEnv } from "../dist/index.mjs";

// A minimal env: nothing here touches the filesystem or runs commands.
registerCoreEnv({
  rootPath: "/mock",
  getPlatform: async () => "linux",
  getArch: async () => "arm64",
  getEnv: async () => ({}),
  homedir: async () => "/mock",
  path: {
    join: (...parts) => parts.join("/"),
    dirname: (p) => {
      const i = p.lastIndexOf("/");
      return i <= 0 ? "/" : p.slice(0, i);
    },
    basename: (p, ext) => {
      const base = p.split("/").pop() ?? p;
      return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
    },
    extname: (p) => {
      const base = p.split("/").pop() ?? p;
      const i = base.lastIndexOf(".");
      return i < 0 ? "" : base.slice(i);
    },
    resolve: (...parts) => `/${parts.join("/")}`,
    normalize: (p) => p.replace(/\/+/g, "/"),
    isAbsolute: (p) => p.startsWith("/"),
    getSep: () => "/",
    parse: (p) => {
      const base = p.split("/").pop() ?? p;
      const i = base.lastIndexOf(".");
      return {
        root: "/",
        dir: p.slice(0, p.lastIndexOf("/")) || "/",
        base,
        ext: i < 0 ? "" : base.slice(i),
        name: i < 0 ? base : base.slice(0, i),
      };
    },
  },
  fs: {
    readFile: async () => {
      throw new Error("ENOENT");
    },
    writeFile: async () => {},
    appendFile: async () => {},
    mkdir: async () => {},
    exists: async () => false,
    readdir: async () => [],
    remove: async () => {},
    stat: async () => {
      throw new Error("ENOENT");
    },
  },
  runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  fetch: async () => new Response("", { status: 200 }),
});

// ---------------------------------------------------------------------------
// 1. Capability gate resets when the new model has no metadata (P0-5)
// ---------------------------------------------------------------------------
// Must go through `setModel` — that is where the bug was (the reset lived inside
// `if (next.modelInfo)`, so an unknown model inherited the previous gate). Testing
// `usage.setCapabilities` directly would pass on the broken code.
{
  const manager = new AgentManager();
  const agent = await manager.createManagedAgent({ name: "capability-gate", model: "test-model-a" });

  // Model A: metadata says text-only (declared-none ⇒ strict).
  agent.setModel({ model: "model-a", modelInfo: { id: "model-a", capabilities: [] } });
  assert.equal(agent.usage.hasCapability("vision"), false, "declared-none is strict: the gate must strip image parts");

  // Switch to a model we have no metadata for. It must become permissive again —
  // keeping A's `[]` would strip images from a model that may accept them.
  agent.setModel({ model: "model-b" });
  assert.equal(
    agent.usage.hasCapability("vision"),
    true,
    "switching to an unknown model resets the gate to permissive (stale [] must not survive)"
  );
  assert.equal(agent.usage.getCapabilities(), null, "unknown is null, distinguishable from declared-none");

  // The reverse direction: a stale vision grant must not leak onto an unknown model.
  agent.setModel({ model: "model-c", modelInfo: { id: "model-c", capabilities: ["vision"] } });
  assert.equal(agent.usage.hasCapability("vision"), true);
  agent.setModel({ model: "model-d" });
  assert.equal(agent.usage.getCapabilities(), null, "a stale vision grant does not survive an unknown switch");
}

// ---------------------------------------------------------------------------
// 1b. A reasoning level does not survive a switch to a model without it
// ---------------------------------------------------------------------------
// Same shape as the capability bug above, one field over: an explicit `high` was forwarded to the
// adapter (`run-agent` passes `config.reasoningEffort ?? defaultEffort`) no matter which model it had
// been chosen for, so switching to a model that advertises no levels carried a level that model does
// not accept — exactly the "stale level survives a model switch" defect that merging `/models` with
// the depth menu exists to close. The reset must happen in `setModel` (the one place both hosts
// switch through); asserting it here is what keeps a host from having to remember.
{
  const manager = new AgentManager();
  const levelAgent = await manager.createManagedAgent({ name: "effort-reset", model: "deep-model" });

  const reasoning = {
    id: "deep-model",
    capabilities: ["reasoning"],
    reasoningConfig: { effortValues: ["low", "high"] },
  };
  levelAgent.setModel({ model: "deep-model", modelInfo: reasoning });
  levelAgent.setReasoningEffort("high");
  assert.equal(levelAgent.getReasoningEffort(), "high", "an explicit level is recorded");

  // A model that does NOT advertise levels: the explicit level must be dropped.
  levelAgent.setModel({
    model: "plain-model",
    modelInfo: { id: "plain-model", capabilities: ["tool_calling"], reasoningConfig: {} },
  });
  assert.equal(
    levelAgent.getReasoningEffort(),
    undefined,
    "an explicit level does not survive a switch to a model without thinking depth"
  );

  // A level the new model DOES advertise is kept — the reset is not a blanket clear.
  levelAgent.setModel({ model: "deep-model", modelInfo: reasoning });
  levelAgent.setReasoningEffort("low");
  levelAgent.setModel({
    model: "other-reasoning",
    modelInfo: {
      id: "other-reasoning",
      capabilities: ["reasoning"],
      reasoningConfig: { effortValues: ["low", "max"] },
    },
  });
  assert.equal(levelAgent.getReasoningEffort(), "low", "a level the new model advertises is preserved");
}

// ---------------------------------------------------------------------------
// 2. restoreSession stops an in-flight run (P0-3)
// ---------------------------------------------------------------------------
{
  const manager = new AgentManager();
  const agent = await manager.createManagedAgent({ name: "restore-gate", model: "test-model" });

  // The agent is idle, so a restore must NOT fire the abort/finalize path.
  let stopActiveRunCalls = 0;
  const originalStop = agent.stopActiveRun.bind(agent);
  agent.stopActiveRun = (reason) => {
    stopActiveRunCalls += 1;
    originalStop(reason);
  };

  // Restoring a session that does not exist rejects, but only *after* the
  // stop-if-active guard ran — that ordering is what the fix guarantees.
  await agent.restoreSession("ses_does_not_exist").catch(() => undefined);
  assert.equal(stopActiveRunCalls, 1, "restoreSession consults stopActiveRun before swapping the transcript");

  // Idle ⇒ the call is the no-op guard, not a real interrupt.
  assert.equal(agent.getStatus(), "idle", "an idle restore does not move the agent into aborted");
}

// ---------------------------------------------------------------------------
// 3. Session switch stops child producers before the stream hub is cleared
// ---------------------------------------------------------------------------
{
  const makePair = () => {
    const parent = new ManagedAgent(
      { name: "switch-parent", model: "test-model" },
      { log: new AgentLog(), tools: {}, todoManager: null }
    );
    const child = new ManagedAgent(
      { name: "switch-child", model: "test-model" },
      { log: new AgentLog(), tools: {}, todoManager: null, parentId: parent.id }
    );
    const manager = {
      getAgent: (id) => (id === parent.id ? parent : id === child.id ? child : undefined),
    };
    parent.manager = manager;
    child.manager = manager;
    parent.childIds.push(child.id);
    return { parent, child };
  };

  const switched = makePair();
  switched.child.setStatus("running");
  switched.parent.stopForSessionSwitch("session-switch");
  assert.equal(
    switched.child.getStatus(),
    "aborted",
    "stopForSessionSwitch reaches a child not tied to the root controller"
  );

  // `reset()` is also a session-switch seat (`/clear` calls it directly in other paths).
  const reset = makePair();
  reset.child.setStatus("running");
  reset.parent.reset();
  assert.equal(reset.child.getStatus(), "aborted", "reset cascades to a running child before clearAll()");

  // A manual compaction's controller is aborted by abort(), but retained until compact()'s own
  // finally releases it so a second compact cannot overlap the aborted run's teardown.
  const compacting = new ManagedAgent(
    { name: "switch-compact", model: "test-model" },
    { log: new AgentLog(), tools: {}, todoManager: null }
  );
  const compactController = new AbortController();
  compacting.compactAbortController = compactController;
  compacting.abort("session-switch");
  assert.equal(compactController.signal.aborted, true, "abort() cancels a manual compaction");
  assert.equal(
    compacting.compactAbortController,
    compactController,
    "the controller stays owned until compact()'s finally releases it"
  );
  compacting.compactAbortController = undefined;
}

console.log("managed-agent-state validation passed");

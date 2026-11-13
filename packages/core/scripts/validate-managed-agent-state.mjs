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
 * 2. **A failed restore is a no-op (P0-3, revised).** The target is READ before
 *    `unloadCurrent`, so an unknown id never stops the run that is still on screen.
 *    (The stop → swap order for a real restore lives in `validate-session-switch-safety`.)
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
// 2. A failed restore is a no-op (the target is read before the live run is stopped)
// ---------------------------------------------------------------------------
{
  const manager = new AgentManager();
  const agent = await manager.createManagedAgent({ name: "restore-gate", model: "test-model" });
  const liveSessionId = agent.getSessionData()?.id;

  // The agent is idle, so a restore must NOT fire the abort/finalize path.
  let stopActiveRunCalls = 0;
  const originalStop = agent.stopActiveRun.bind(agent);
  agent.stopActiveRun = (reason) => {
    stopActiveRunCalls += 1;
    originalStop(reason);
  };

  // A failed `/resume` must be a no-op: the target is READ before `unloadCurrent`, so an unknown
  // id never stops the run that is still on screen (the old order aborted the visible turn and
  // then reported "not found"). The stop → swap order for a REAL restore is covered by
  // `validate-session-switch-safety`.
  const error = await agent.restoreSession("ses_does_not_exist").catch((e) => e);
  assert.ok(error instanceof Error, "an unknown session id rejects");
  assert.match(error.message, /not found/i, "and says the session does not exist");
  assert.equal(stopActiveRunCalls, 0, "an unknown session id must not stop the live run");

  // Idle ⇒ nothing moved, and the live session was not replaced.
  assert.equal(agent.getStatus(), "idle", "an idle restore does not move the agent into aborted");
  assert.equal(agent.getSessionData()?.id, liveSessionId, "the live session is unchanged");
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
      // `refreshSubagents` (child state change) projects the parent's task rows, which reads the
      // catalog. A stub without it failed as soon as a child's status changed.
      getSubagents: () => [],
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

  // `reset()` is also a session-switch seat (`/new` calls it directly in other paths).
  const reset = makePair();
  reset.child.setStatus("running");
  reset.parent.reset();
  assert.equal(reset.child.getStatus(), "aborted", "reset cascades to a running child before clearAll()");

  // A manual compaction is cancelled by abort() and its LEASE is invalidated immediately: the
  // unwinding producer is no longer current, so it cannot apply a checkpoint or restore a status.
  // (The old shape kept the controller until `compact()`'s finally, which is why a second
  // `/compact` could not overlap the teardown — leases make that unnecessary: a new claim simply
  // supersedes the old identity.)
  const compacting = new ManagedAgent(
    { name: "switch-compact", model: "test-model" },
    { log: new AgentLog(), tools: {}, todoManager: null }
  );
  const lease = compacting.compactions.begin("manual");
  assert.ok(lease?.signal, "a manual lease carries its own abort signal (it has no run to ride)");
  compacting.abort("session-switch");
  assert.equal(lease.signal.aborted, true, "abort() cancels a manual compaction");
  assert.equal(compacting.compactions.isCurrent(lease), false, "the aborted lease can no longer apply");
  assert.equal(compacting.compactions.isRunning(), false, "the teardown releases ownership");
}

// ---------------------------------------------------------------------------
// 4. `setStatus` refuses the two lossy rebuilds (compaction lease, pending wait)
// ---------------------------------------------------------------------------
// The legacy writer rebuilds every axis from a projection, and the projection cannot express a
// compaction lease's restore fields or a wait that has no status of its own. Both losses are silent:
// the agent kept a plausible-looking status while the lease was stranded / the prompt was dropped.
{
  const manager = new AgentManager();
  const agent = await manager.createManagedAgent({ name: "legacy-set-status", model: "test-model" });

  // A lease in flight: the run phase, its outcome and the three `resume*` fields belong to it.
  agent.setStatus("running");
  agent.transitionStatus({ type: "compaction-start" });
  assert.equal(agent.getStatus(), "compacting");
  assert.equal(agent.getAgentState().resumeRun, "streaming", "the lease records the phase to restore");

  agent.setStatus("running");
  assert.equal(agent.getAgentState().run, "compacting", "a status write cannot steal the lease's run phase");
  assert.equal(agent.getAgentState().resumeRun, "streaming", "the restore fields survive the ignored write");
  assert.equal(agent.getStatus(), "compacting");

  // The lease still finishes: this is what the old code broke (its `compaction-end` became illegal).
  agent.transitionStatus({ type: "compaction-end" });
  assert.equal(agent.getStatus(), "running", "the lease restores the phase it interrupted");

  // A pending approval belongs to the run that asked for it. Only a verdict ends it.
  agent.transitionStatus({ type: "pause", wait: "approval" });
  assert.equal(agent.getStatus(), "waiting");
  agent.setStatus("running");
  assert.equal(agent.getStatus(), "waiting", "a status write cannot drop a pending approval");
  assert.equal(agent.getAgentState().wait, "approval");

  // A verdict DOES end the gate — that is the `interrupt`/`fail` rule, not a loss.
  agent.setStatus("aborted");
  assert.equal(agent.getStatus(), "aborted");
  assert.equal(agent.getAgentState().wait, "none", "an abort ends the approval wait it gated");

  // A QUESTION outlives a verdict: the prompt is still owed, but the failure must not be lost.
  // The old guard refused the whole write, so a legacy host's error/abort simply vanished and the
  // session resumed as if nothing had failed once the question was answered.
  agent.transitionStatus({ type: "prepare" });
  agent.transitionStatus({ type: "pause", wait: "question" });
  assert.equal(agent.getStatus(), "awaiting_user");

  agent.setStatus("aborted");
  assert.equal(agent.getStatus(), "awaiting_user", "the question still owns the projection");
  assert.equal(agent.getAgentState().outcome, "aborted", "but the abort is recorded on the axes");
  agent.transitionStatus({ type: "resume" });
  assert.equal(agent.getStatus(), "aborted", "clearing the wait reveals the verdict");

  agent.transitionStatus({ type: "prepare" });
  agent.transitionStatus({ type: "pause", wait: "question" });
  agent.setError("provider down");
  agent.setStatus("error");
  assert.equal(agent.getStatus(), "awaiting_user", "an error leaves the question answerable");
  assert.equal(agent.getAgentState().outcome, "error", "and is recorded");
  assert.equal(agent.getAgentState().errorMessage, "provider down", "with its message");
  agent.transitionStatus({ type: "resume" });
  assert.equal(agent.getStatus(), "error");

  // `completed` behaves the same: the turn settled, the prompt is still the session's.
  agent.transitionStatus({ type: "prepare" });
  agent.transitionStatus({ type: "pause", wait: "question" });
  agent.setStatus("completed");
  assert.equal(agent.getStatus(), "awaiting_user");
  assert.equal(agent.getAgentState().outcome, "completed", "a late settle keeps the question");
  agent.transitionStatus({ type: "resume" });
  assert.equal(agent.getStatus(), "completed");

  // A plain running/idle write still cannot erase the prompt.
  agent.transitionStatus({ type: "prepare" });
  agent.transitionStatus({ type: "pause", wait: "question" });
  agent.setStatus("idle");
  assert.equal(agent.getStatus(), "awaiting_user", "an outcome-free write is refused");
}

// ---------------------------------------------------------------------------
// 5. The L1 frame has ONE authority for the error message
// ---------------------------------------------------------------------------
// `fail` writes the axes, while a CLEARING `setError("")` (retry, compaction repair) wrote only the
// run field — so the frame carried `error: ""` beside `state.errorMessage: "old fault"`, and an
// axes-reading host (ACP, the remote reducer) rendered a failure that no longer existed.
{
  const manager = new AgentManager();
  const agent = await manager.createManagedAgent({ name: "l1-error-single-source", model: "test-model" });

  // Production order: `setError` first (no verdict on the axes yet, so it is not mirrored), then the
  // status writer records the failure on the axes.
  agent.setError("provider down");
  agent.transitionStatus({ type: "fail", error: "provider down" });
  assert.equal(agent.getStatus(), "error");
  let l1 = agent.getL1State();
  assert.equal(l1.error, "provider down");
  assert.equal(l1.state.errorMessage, "provider down");

  agent.setError("");
  l1 = agent.getL1State();
  assert.equal(l1.error, "");
  assert.equal(l1.state.errorMessage, undefined, "a cleared error is not still reported by the axes");

  agent.setError("later fault");
  l1 = agent.getL1State();
  assert.equal(l1.state.errorMessage, "later fault", "and a new one reaches the axes the same way");

  // A healthy/completed state never gains a message from a stray `setError`.
  const healthy = await manager.createManagedAgent({ name: "l1-error-healthy", model: "test-model" });
  healthy.setError("not a verdict");
  assert.equal(healthy.getL1State().state.errorMessage, undefined, "no failure is invented on a live state");
}

// ---------------------------------------------------------------------------
// 6. Teardown denies pending approvals instead of persisting them as `pending`
// ---------------------------------------------------------------------------
// Nothing can answer an interaction after teardown. A `pending` row written by `session.close()`
// made a resumed session park on a question nobody asked, with no pump owning the deny.
{
  const manager = new AgentManager();
  const agent = await manager.createManagedAgent({ name: "destroy-pending-approval", model: "test-model" });
  const chat = agent.initChat(manager);
  chat.setMessages([
    { id: "u1", role: "user", parts: [{ type: "text", content: "remove the temp dir" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "call_rm",
          name: "run_command",
          state: "input-complete",
          input: { command: "rm -rf build" },
          approval: { id: "ap-1", needsApproval: true },
        },
      ],
    },
  ]);
  assert.equal(agent.readInteractions().approvals.length, 1, "the fixture is parked on an approval");

  agent.markDestroyed();
  assert.equal(
    agent.readInteractions().approvals.length,
    0,
    "teardown denies the gate instead of leaving a question nothing can answer"
  );
  // The deny itself, not the count zeroing: `markDestroyed` also zeros the derived count outright,
  // so a count assertion alone would pass even if nothing was written to the transcript.
  const part = chat.getMessages().find((message) => message.id === "a1")?.parts[0];
  assert.equal(part?.approval?.approved, false, "the gate carries a recorded decision (policy: denied)");
  assert.equal(agent.getL1State().pendingApprovalCount, 0);
}

console.log("managed-agent-state validation passed");

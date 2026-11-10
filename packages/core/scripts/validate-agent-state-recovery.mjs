/**
 * Behavioral gate for the state-flow fixes from the core review.
 *
 * Every case here was a SILENT wrong answer (no crash, no log line), so a source-shape assertion is
 * not enough — each one drives the real controller/state machine and asserts the resulting axes.
 *
 * 1. A user cancel reads the AXIS (`outcome`), not the projection. `wait=question` outranks
 *    `outcome=error`, so `getStatus()` reported `awaiting_user` and a failed run was finalized as
 *    `aborted` — one run with two conclusions (`agent:stop{aborted}` beside `agent:stream-error`).
 * 2. A DETACHED worker's abort outranks a captured fault (matching `runSubagent`, which clears
 *    `failed` on abort); a CHAT turn keeps the failure (a cancel must not relabel an error).
 * 3. `applyRunOutcome({kind:"waiting"})` must SETTLE when no interaction backs the wait. It used
 *    `whenClear: "running"`, restoring `running` with no pump behind it: UI spinning, `Esc` inert,
 *    and the session out of the background-wake allowlist.
 * 4. A trailing stream chunk after `error` must not rewrite the axes (`run: streaming`,
 *    `lifecycle: busy`); projection order only protects the LABEL.
 * 5. `markDestroyed` publishes through the single writer, zeroes the interaction counters, and
 *    refuses the legacy `setStatus` (a destroyed agent must not become "idle and writable").
 * 6. `CompactionController.cancel()` restores the run phase. Dropping the lease without
 *    `restoreStatusFor` left `run: compacting` forever, which rejects every later `prepare`.
 * 7. `interrupt` clears `resumeStream` with the other two lease-phase fields.
 * 8. A reset inside an unsettled session switch is refused.
 * 9. A USER stop of a compaction emits ONE net status move (no restored phase in between).
 * 10. A user stop while `run: compacting, outcome: error` restores the phase (no wedge).
 * 11. A manual compaction's user cancel does not fabricate a run abort.
 * 12. A state batch emits ONE merged `agent:status` (and nested/empty batches emit none).
 *
 * Run: pnpm --filter @codent/core run validate:agent-state-recovery
 */

import assert from "node:assert/strict";

import { deriveCancelVerdict } from "../dist/dev.mjs";
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

const managers = [];
async function makeAgent(name) {
  const manager = new AgentManager();
  managers.push(manager);
  return manager.createManagedAgent({ name, model: "test-model" });
}

// REASONING is the chunk type that actually dispatches a `stream-chunk` transition from a busy
// run — `TEXT_MESSAGE_CONTENT` only fires when the status is already running/thinking, so using it
// made the assertion pass even on the unfixed code.
const CHUNK = { type: "REASONING_MESSAGE_CONTENT", delta: "hmm" };

// ---------------------------------------------------------------------------
// 1. A failed run parked on a question is still `error`, not `awaiting_user`
// ---------------------------------------------------------------------------
{
  const agent = await makeAgent("cancel-reads-axis");
  agent.statusController.onRunError("provider exploded");
  agent.transitionStatus({ type: "pause", wait: "question" });

  // The projection hides the verdict behind the question — this is exactly why reading the status
  // string was wrong.
  assert.equal(agent.getStatus(), "awaiting_user");
  assert.equal(agent.getAgentState().outcome, "error", "the axis still records the failure");

  // The ACTUAL rule `interruptCurrentRun` uses (one definition, shared with the controller).
  assert.equal(
    deriveCancelVerdict(agent.getAgentState()),
    "error",
    "Esc on a failed-but-parked run must finalize as `error`"
  );
}

// ---------------------------------------------------------------------------
// 1b. BEHAVIORAL: pressing Esc on a failed-but-parked turn finalizes as `error`
// ---------------------------------------------------------------------------
// Section 1 asserts the rule; this drives the real `AgentChatController.stop()` →
// `interruptCurrentRun` → finalize path, so reverting the consumer (not just the helper) fails.
{
  const manager = new AgentManager();
  managers.push(manager);
  const agent = await manager.createManagedAgent({ name: "cancel-behavioral", model: "test-model" });
  // `createManagedAgent` may already own a controller in some paths; re-initialising would rebind the
  // UI channel (and its retained `session:messages` provider) for no reason.
  const chat = agent.getChatController() ?? agent.initChat(manager);
  agent.getUI().setMessages([
    {
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "call-ask",
          name: "ask_user",
          arguments: '{"question":"pick one"}',
          state: "input-complete",
        },
      ],
    },
  ]);
  agent.statusController.onRunError("provider exploded");
  agent.transitionStatus({ type: "pause", wait: "question" });

  const stops = [];
  agent.getEventBus().on("agent:stop", (event) => stops.push(event.payload), { replay: false });
  chat.stop();

  assert.equal(
    stops.at(-1)?.reason,
    "error",
    "the real Esc path finalizes a failed-but-parked run as `error`, not `aborted`"
  );
}

// ---------------------------------------------------------------------------
// 2. Detached abort outranks a captured fault; a chat turn keeps the fault
// ---------------------------------------------------------------------------
{
  const worker = await makeAgent("worker-abort-wins");
  worker.statusController.onRunError("stream died");
  assert.equal(worker.getAgentState().outcome, "error");

  // The verdict change is BATCHED: clearing the error text + resetting the axes + aborting must
  // publish one frame, or the parent's subagent projection flickers through idle.
  const stateFrames = [];
  worker.getEventBus().on("agent:state", (event) => stateFrames.push(event.payload.status), { replay: false });

  worker.statusController.applyRunOutcome({ kind: "aborted", messages: [], path: "detached" });
  assert.deepEqual(stateFrames, ["aborted"], "one state frame for the whole detached-abort verdict");
  assert.equal(
    worker.getAgentState().outcome,
    "aborted",
    "a detached worker's abort outranks the earlier stream error (runSubagent cleared `failed`)"
  );
  assert.equal(worker.getStatus(), "aborted", "so the parent/ACP projection cannot show a failure");
  assert.equal(worker.getL1State().error, "", "the L1 fault text goes with the verdict it described");

  const chat = await makeAgent("chat-abort-keeps-error");
  chat.statusController.onRunError("stream died");
  chat.statusController.applyRunOutcome({ kind: "aborted", messages: [], path: "chat" });
  assert.equal(
    chat.getAgentState().outcome,
    "error",
    "a CHAT turn keeps its failure; a user Esc must not relabel it as cancelled"
  );
}

// ---------------------------------------------------------------------------
// 3. A `waiting` outcome with no backing interaction settles instead of resuming
// ---------------------------------------------------------------------------
{
  const agent = await makeAgent("unbacked-wait");
  agent.transitionStatus({ type: "prepare" });
  agent.transitionStatus({ type: "pause", wait: "approval" });
  assert.equal(agent.getStatus(), "waiting");

  // No message requires the wait any more (the answer landed between the snapshot and the finalize).
  agent.statusController.applyRunOutcome({ kind: "waiting", messages: [], path: "chat" });

  assert.notEqual(agent.getStatus(), "running", "no zombie `running` without a pump behind it");
  assert.notEqual(agent.getStatus(), "waiting", "the dead wait is cleared");
  assert.equal(agent.getStatus(), "completed", "a finished turn settles as completed");
  assert.equal(agent.getAgentState().wait, "none", "the wait axis is empty too");
}

// ---------------------------------------------------------------------------
// 4. A trailing chunk after `error` must not rewrite the axes
// ---------------------------------------------------------------------------
{
  const agent = await makeAgent("error-is-sticky");
  agent.statusController.onRunError("boom");
  const before = agent.getAgentState();
  assert.equal(before.outcome, "error");
  // Snapshot primitives: `getAgentState()` returns the LIVE object, so reading `before.run` after
  // the chunk would read the mutated object and prove nothing. A stable reference only helps if we
  // copy the values out first (a replaced object would actually be a safe snapshot).
  const runBefore = before.run;
  const lifecycleBefore = before.lifecycle;
  const streamBefore = before.stream;

  agent.statusController.onStreamChunk(CHUNK);
  const after = agent.getAgentState();
  assert.equal(after.run, runBefore, "a late reasoning chunk does not promote `run` to streaming");
  assert.equal(after.lifecycle, lifecycleBefore, "…nor the lifecycle to busy");
  assert.equal(after.stream, streamBefore, "…nor the stream phase");
  assert.equal(agent.getStatus(), "error", "the label is unchanged as well");
}

// ---------------------------------------------------------------------------
// 5. markDestroyed: single writer + no interaction state + setStatus refuses
// ---------------------------------------------------------------------------
{
  const agent = await makeAgent("destroyed-state");
  agent.setPendingApprovalCount(2);
  agent.setError("last failure");
  agent.markDestroyed();

  assert.equal(agent.isDestroyed(), true);
  const state = agent.getL1State();
  assert.equal(state.pendingApprovalCount, 0, "a destroyed agent has no answerable approvals");
  assert.equal(state.error, "", "the stale fault does not survive teardown");
  assert.equal(state.status, "idle");

  agent.setStatus("running");
  assert.equal(agent.getStatus(), "idle", "the legacy writer cannot resurrect a destroyed agent");
}

// ---------------------------------------------------------------------------
// 6. Compaction cancel restores the phase it owned
// ---------------------------------------------------------------------------
{
  const agent = await makeAgent("compact-cancel-phase");
  const lease = agent.compactions.begin("manual");
  assert.ok(lease, "a manual lease is granted from idle");

  // The failure lands during the lease: the projection becomes `error` while `run` stays
  // `compacting` (the lease still owns it). This is the state `cancel()` has to recover from.
  agent.transitionStatus({ type: "fail", error: "summarizer failed" });
  assert.equal(agent.getAgentState().run, "compacting", "the lease keeps the run phase");

  assert.equal(agent.compactions.cancel(), true, "cancel claims a manual lease");
  assert.equal(agent.getAgentState().run, "finalizing", "the phase is restored (end-of-run), not abandoned");
  assert.equal(agent.getAgentState().outcome, "error", "cancel does not 'repair' the failed verdict");

  const prepared = agent.transitionStatus({ type: "prepare" });
  assert.equal(prepared, "running", "a new turn is accepted again (the old bug rejected it forever)");
}

// ---------------------------------------------------------------------------
// 7. interrupt clears every lease-phase field, not just two of three
// ---------------------------------------------------------------------------
{
  const agent = await makeAgent("interrupt-clears-resume");
  agent.transitionStatus({ type: "prepare" });
  agent.transitionStatus({ type: "stream-chunk", stream: "thinking" });

  const lease = agent.compactions.begin("manual");
  assert.ok(lease);
  assert.equal(agent.getAgentState().resumeStream, "thinking", "compaction-start saved the phase");

  agent.transitionStatus({ type: "interrupt" });
  assert.equal(agent.getAgentState().resumeRun, undefined);
  assert.equal(agent.getAgentState().resumeOutcome, undefined);
  assert.equal(agent.getAgentState().resumeStream, undefined, "the third field clears with the others");
}

// ---------------------------------------------------------------------------
// 8. `reset()` refuses to interleave with a session switch
// ---------------------------------------------------------------------------
{
  const agent = await makeAgent("reset-during-switch");
  const lifecycle = agent.sessionLifecycle;
  // Simulate an admitted-but-unsettled switch: the guard is `pendingSwitches > 0`.
  const original = lifecycle.isTransitioning.bind(lifecycle);
  lifecycle.isTransitioning = () => true;
  try {
    assert.equal(agent.reset(), false, "a reset inside a switch is refused");
  } finally {
    lifecycle.isTransitioning = original;
  }
  assert.equal(agent.reset(), true, "outside a switch the reset runs");
}

// ---------------------------------------------------------------------------
// 9. A USER stop of a compaction publishes ONE net status move
// ---------------------------------------------------------------------------
//
// `abort()` used to call `abortForTeardown` for every caller, which restores the pre-compaction
// phase before `interrupt` writes `aborted`. That produced `compacting → running → aborted`; a
// consumer that treats "left compacting" as the compaction's outcome read the cancel as a
// completion. The user path now drops the lease without restoring, so `interrupt` is the one frame.
{
  const agent = await makeAgent("compact-user-cancel");
  const statuses = [];
  agent
    .getEventBus()
    .on("agent:status", (event) => statuses.push([event.payload.from, event.payload.to]), { replay: false });

  const lease = agent.compactions.begin("auto");
  assert.ok(lease, "an auto lease is granted from idle");
  statuses.length = 0;

  agent.abort("user-cancelled", { userCancel: true });
  assert.equal(agent.getStatus(), "aborted", "the user stop settles the turn as aborted");
  assert.equal(agent.getAgentState().run, "finalizing", "the compaction phase is gone");
  assert.deepEqual(statuses, [["compacting", "aborted"]], "exactly one net move — no restored phase in between");

  // The producer's finally is what releases the lease in production.
  agent.compactions.release(lease);
  assert.equal(agent.compactions.isRunning(), false, "a cancelled lease no longer owns the agent");
  assert.equal(agent.transitionStatus({ type: "prepare" }), "running", "the next turn is accepted");
}

// ---------------------------------------------------------------------------
// 10. The terminal-outcome wedge: a user stop while `run: compacting, outcome: error`
// ---------------------------------------------------------------------------
//
// `interrupt` deliberately keeps an existing `error`/`aborted` verdict and therefore never moves
// `run` out of `compacting`. A user cancel that trusts `interrupt` to publish the verdict would
// leave the lease gone and the phase stuck — every later `prepare`/`compaction-start` is rejected.
// The cancel must restore the phase in exactly that case.
{
  const agent = await makeAgent("compact-user-cancel-wedge");
  const lease = agent.compactions.begin("reactive");
  assert.ok(lease);
  agent.transitionStatus({ type: "fail", error: "summarizer failed" });
  assert.equal(agent.getAgentState().run, "compacting", "the lease keeps the run phase");
  assert.equal(agent.getAgentState().outcome, "error", "the failure is recorded behind the lease");

  agent.abort("user-cancelled", { userCancel: true });
  assert.notEqual(agent.getAgentState().run, "compacting", "the phase is restored, not abandoned");
  assert.equal(agent.getStatus(), "error", "the existing verdict is not rewritten to aborted");
  assert.equal(agent.transitionStatus({ type: "prepare" }), "running", "the session is usable again");
}

// ---------------------------------------------------------------------------
// 11. A manual compaction's user cancel does not fabricate a run abort
// ---------------------------------------------------------------------------
{
  const agent = await makeAgent("compact-manual-user-cancel");
  let aborts = 0;
  agent.getEventBus().on("agent:abort", () => (aborts += 1), { replay: false });
  const lease = agent.compactions.begin("manual");
  assert.ok(lease);

  agent.abort("user-cancelled", { userCancel: true });
  assert.equal(agent.getStatus(), "aborted", "a manual cancel owns the verdict itself");
  assert.equal(agent.getAgentState().run, "finalizing");
  assert.equal(aborts, 0, "no run existed, so no `agent:abort`");
  agent.compactions.release(lease);
}

// ---------------------------------------------------------------------------
// 12. A state batch emits ONE merged `agent:status`, not the intermediate moves
// ---------------------------------------------------------------------------
//
// The switch suppresses per-step status frames so push consumers never observe a status the
// committed snapshot does not contain. The NET move is still a timeline fact (`error`/`aborted`
// are notable), so it is synthesized once at the batch boundary.
{
  const agent = await makeAgent("state-batch-status");
  agent.transitionStatus({ type: "prepare" });
  agent.transitionStatus({ type: "stream-chunk", stream: "thinking" });

  const statuses = [];
  const states = [];
  agent
    .getEventBus()
    .on("agent:status", (event) => statuses.push([event.payload.from, event.payload.to]), { replay: false });
  agent.getEventBus().on("agent:state", (event) => states.push(event.payload.status), { replay: false });

  agent.beginStateBatch();
  agent.transitionStatus({ type: "interrupt" }); // thinking → finalizing/aborted
  agent.transitionStatus({ type: "reset" }); //     → idle
  agent.endStateBatch();

  assert.deepEqual(statuses, [["thinking", "idle"]], "one net status row");
  assert.equal(states.at(-1), "idle", "one final L1 frame");
  assert.equal(agent.getStatus(), "idle");

  // Nested batches hold the row until the OUTER end, and a batch with no net move emits nothing.
  statuses.length = 0;
  agent.beginStateBatch();
  agent.beginStateBatch();
  agent.transitionStatus({ type: "prepare" });
  agent.transitionStatus({ type: "reset" });
  agent.endStateBatch();
  assert.deepEqual(statuses, [], "an inner end does not publish");
  agent.endStateBatch();
  assert.deepEqual(statuses, [], "idle → idle has no net move");

  const before = statuses.length;
  agent.beginStateBatch();
  agent.endStateBatch();
  assert.equal(statuses.length, before, "an empty batch emits nothing");
}

// The merged row is attributed to the transition that produced it — and a later move with NO
// event must not inherit an older one.
{
  const agent = await makeAgent("state-batch-attribution");
  const rows = [];
  agent
    .getEventBus()
    .on(
      "agent:status",
      (event) => rows.push({ from: event.payload.from, to: event.payload.to, event: event.payload.event }),
      {
        replay: false,
      }
    );

  agent.beginStateBatch();
  agent.transitionStatus({ type: "prepare" }); // names `prepare`
  agent.setStatus("completed"); //               legacy writer: moves the status with NO event
  agent.endStateBatch();

  assert.equal(rows.length, 1, "one net row");
  assert.deepEqual(rows[0], { from: "idle", to: "completed", event: undefined }, "no stale event attribution");

  // The positive half: a batch whose last move names an event still reports it.
  rows.length = 0;
  agent.setStatus("running");
  rows.length = 0; // the direct set is its own transition, not part of the batch under test
  agent.beginStateBatch();
  agent.transitionStatus({ type: "interrupt" }); // running → aborted, names `interrupt`
  agent.endStateBatch();
  assert.deepEqual(rows[0], { from: "running", to: "aborted", event: "interrupt" }, "the last event is preserved");
}

for (const manager of managers) {
  await manager.dispose().catch(() => {});
}

console.log("agent-state-recovery validation passed");

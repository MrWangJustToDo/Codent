/**
 * A manual `/compact` is the user's Esc target, and it holds the agent while it runs.
 *
 * Two defects, one root cause — the compaction is a real summarizer call that runs with **no
 * pump** (`pumpDepth === 0`), so every "is work in flight?" check that keyed on the pump missed it:
 *
 *   1. **Esc did nothing.** `AgentChatController.stop()` returned early (no pump, no pre-fork, no
 *      pending interaction), so `abortManualCompaction` was only ever reached by a session switch
 *      or agent destroy. The summarizer could not be cancelled at all.
 *   2. **The user's next message started a second turn.** `shouldDeferMidRunQueue` did not know
 *      `compacting`, so `followUp` → `sendMessage` opened a turn while the checkpoint was still
 *      being written: the summary landed inside the new turn (the next model call projects from a
 *      prefix that was replaced mid-turn) and `applyCompactionResult` reset the window usage the
 *      new turn was accumulating. `forceSubmit` (Option/Ctrl+Enter) reached the same defect through
 *      a different door: its "is a run active?" test was pump-based, so it started a turn BESIDE
 *      the summarizer. It now degrades to a queued follow-up while a compaction owns the agent.
 *
 * What this locks down:
 *   1. The routing decision (`shouldDeferMidRunQueue` also pinned in `validate-pump-continuation`).
 *   2. Esc → `aborted` (the auto path's verdict), the summarizer's controller is aborted, and the
 *      unwinding compaction does not restore its old status.
 *   3. No run existed, so Esc fabricates none: no `agent:abort`, no `agent:stop`.
 *   4. Input typed during the compaction is released when it ends — and starts the turn it was
 *      always meant to start. (Before: it started that turn immediately.)
 *   5. Esc drops that queued input, exactly as it does for a run.
 *   6. `forceSubmit` during a compaction queues, never opens a second turn.
 *
 * Run: pnpm --filter @codent/core run validate:manual-compact-interlock
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { clearCoreEnv, registerCoreEnv } from "../dist/dev.mjs";
import { AgentManager } from "../dist/index.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

// ============================================================================
// Fixture
// ============================================================================

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "manual-compact-interlock-"));
const toAbs = (p) => (path.isAbsolute(p) ? p : path.join(rootPath, p));

registerCoreEnv({
  rootPath,
  getPlatform: async () => "linux",
  getArch: async () => "arm64",
  getEnv: async () => ({}),
  homedir: async () => rootPath,
  fs: {
    readFile: async (p, encoding) => fs.promises.readFile(toAbs(p), encoding),
    writeFile: async (p, content) => fs.promises.writeFile(toAbs(p), content),
    appendFile: async (p, content) => fs.promises.appendFile(toAbs(p), content, "utf8"),
    rename: async (from, to) => fs.promises.rename(toAbs(from), toAbs(to)),
    mkdir: async (p) => fs.promises.mkdir(toAbs(p), { recursive: true }),
    exists: async (p) =>
      fs.promises.access(toAbs(p)).then(
        () => true,
        () => false
      ),
    readdir: async (p) => {
      try {
        const entries = await fs.promises.readdir(toAbs(p), { withFileTypes: true });
        return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
      } catch {
        return [];
      }
    },
    stat: async (p) => {
      const stat = await fs.promises.stat(toAbs(p));
      return { isDirectory: stat.isDirectory(), isFile: stat.isFile(), size: stat.size, mtime: stat.mtime };
    },
    remove: async (p) => fs.promises.rm(toAbs(p), TEMP_RM_OPTIONS),
  },
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => new Response(),
});

const manager = new AgentManager();

/** One plain answer per model call, recorded so a released turn is observable. */
function makeCapturingAdapter() {
  const calls = [];
  return {
    calls,
    config: {
      adapter: {
        kind: "text",
        name: "capturing",
        model: "capturing-model",
        "~types": {},
        chatStream(options) {
          calls.push(options.messages);
          return (async function* () {
            yield { type: "TEXT_MESSAGE_CONTENT", delta: "Acknowledged." };
            yield { type: "RUN_FINISHED", finishReason: "stop" };
          })();
        },
        async structuredOutput() {
          throw new Error("not implemented");
        },
      },
      model: "capturing-model",
      modelStyle: "openai",
    },
  };
}

/**
 * An agent whose transcript is too short to cut, so `autoCompact` bails out before any summarizer
 * call. That is deliberate: the interlock is about the COMPACTION LIFECYCLE (status, ownership,
 * abort), and a real summarizer would only make the assertions slower and less deterministic.
 * The compaction still publishes `compacting`, holds the controller across a microtask, and runs
 * the same start/stop/restore code.
 */
async function makeAgent(name) {
  const managed = await manager.createManagedAgent({ name, model: "capturing-model" });
  const chat = managed.initChat(manager);
  chat.getUIChannel().addUserMessage("seed");
  return { managed, chat };
}

const messageText = (message) =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => String(part.content ?? ""))
    .join("");

const hasUserText = (chat, text) =>
  chat
    .getUIChannel()
    .getMessages()
    .some((message) => message.role === "user" && messageText(message).includes(text));

function observeRunEvents(events) {
  const bus = manager.of(events.agentId);
  // `on` returns the unsubscribe; the bus has no `off` (see AgentEventBus).
  const offAbort = bus.on("agent:abort", () => {
    events.aborts += 1;
  });
  const offStop = bus.on("agent:stop", () => {
    events.stops += 1;
  });
  const offManualStart = bus.on("compaction:manual-start", () => {
    events.manualStarts += 1;
  });
  const offAutoStart = bus.on("compaction:auto-start", () => {
    events.autoStarts += 1;
  });
  const offReactiveStart = bus.on("compaction:reactive-start", () => {
    events.reactiveStarts += 1;
  });
  return () => {
    offAbort();
    offStop();
    offManualStart();
    offAutoStart();
    offReactiveStart();
  };
}

// ============================================================================
// 1. Esc during a manual compaction aborts it — and never invents a run
// ============================================================================
{
  const { managed, chat } = await makeAgent("manual-compact-cancel");
  const events = { agentId: managed.id, aborts: 0, stops: 0, manualStarts: 0, autoStarts: 0, reactiveStarts: 0 };
  const dispose = observeRunEvents(events);

  const compacting = managed.compact();
  // `compact()` publishes the status and takes the controller synchronously, before its first await.
  assert.equal(managed.getStatus(), "compacting", "a manual compaction reports `compacting` immediately");
  assert.equal(managed.compactions.ownsManual(), true, "and owns the agent while it runs");
  assert.equal(managed.compactions.runningKind(), "manual", "the lease records the kind (that is what Esc keys on)");

  chat.stop();
  assert.equal(
    managed.getStatus(),
    "aborted",
    "Esc is an abort on the auto path, so it is one here too (not a return to the previous status)"
  );
  // The cancel releases ownership immediately (the verdict is `aborted`, not "still working"), and
  // the unwinding producer can no longer apply or restore anything: `isCurrent(lease)` is false and
  // a fresh `/compact` gets a brand-new lease instead of racing the old one.
  assert.equal(managed.compactions.ownsManual(), false, "cancel releases the lease right away");
  assert.equal(managed.compactions.isRunning(), false, "no compaction owns the agent after a cancel");

  const result = await compacting;
  assert.equal(result.ok, false, "a cancelled compaction does not report success");
  assert.match(String(result.error), /aborted/i, "and says it was aborted");
  assert.equal(
    managed.getStatus(),
    "aborted",
    "the unwinding compaction must not restore the status the aborted generation lost"
  );
  assert.equal(managed.compactions.ownsManual(), false, "the lease is released when it unwinds");
  assert.equal(managed.compactions.isRunning(), false, "and no compaction owns the agent any more");

  // A compaction is not a run: there is no turn to abort or finalize.
  assert.equal(events.aborts, 0, "no run existed, so Esc must not emit `agent:abort`");
  assert.equal(events.stops, 0, "no run existed, so Esc must not emit `agent:stop`");

  // …and it announces itself as MANUAL: the timeline must be able to tell the user's `/compact`
  // from the loop compacting itself.
  assert.equal(events.manualStarts, 1, "a manual /compact emits `compaction:manual-start`");
  assert.equal(events.autoStarts, 0, "and never `compaction:auto-start`");
  assert.equal(events.reactiveStarts, 0, "nor the reactive name");

  dispose();
  manager.destroyAgent(managed.id);
}

// ============================================================================
// 2. Input typed during the compaction is queued, then released when it ends
// ============================================================================
{
  const { managed, chat } = await makeAgent("manual-compact-queue");
  const { calls, config } = makeCapturingAdapter();
  managed.setTextAdapter(config);

  const compacting = managed.compact();
  chat.followUp("typed during compaction");

  assert.equal(
    hasUserText(chat, "typed during compaction"),
    false,
    "the message must not enter the transcript while the checkpoint is still being written"
  );
  assert.deepEqual(
    chat.getQueuedMessages().followUp.map((content) => (typeof content === "string" ? content : "")),
    ["typed during compaction"],
    "it sits in the follow-up queue instead"
  );

  const result = await compacting;
  assert.equal(result.ok, true, "the short transcript is a no-op compaction, not a failure");

  // The release happens in `compact()`'s `finally`, so the message is in the transcript by now.
  assert.equal(hasUserText(chat, "typed during compaction"), true, "the queued message is released");
  assert.equal(chat.getQueuedMessages().followUp.length, 0, "and the queue is empty");

  // …and it starts the turn it was always meant to start, rather than waiting for another keystroke.
  await chat.runChain;
  assert.ok(calls.length >= 1, "the released message started a real turn");
  assert.equal(managed.getStatus(), "completed", "which settles like any other turn");

  manager.destroyAgent(managed.id);
}

// ============================================================================
// 3. Esc drops the queued input, exactly as it does for a run
// ============================================================================
{
  const { managed, chat } = await makeAgent("manual-compact-esc-queue");
  const compacting = managed.compact();
  chat.followUp("dropped by Esc");
  assert.equal(chat.getQueuedMessages().followUp.length, 1, "the message queued first");

  chat.stop();
  assert.equal(chat.getQueuedMessages().followUp.length, 0, "Esc aborts AND drops pending input");
  assert.equal(hasUserText(chat, "dropped by Esc"), false, "the dropped message never reaches the transcript");

  await compacting;
  manager.destroyAgent(managed.id);
}

// ============================================================================
// 4. The cancel path is inert without a compaction (no fabricated status change)
// ============================================================================
{
  const { managed, chat } = await makeAgent("manual-compact-noop");
  const before = managed.getStatus();
  managed.compactions.cancel("user-cancelled");
  assert.equal(managed.getStatus(), before, "no compaction means nothing to cancel");

  // An idle Esc still must not fabricate a run.
  const events = { agentId: managed.id, aborts: 0, stops: 0, manualStarts: 0, autoStarts: 0, reactiveStarts: 0 };
  const dispose = observeRunEvents(events);
  chat.stop();
  assert.equal(events.aborts, 0);
  assert.equal(events.stops, 0);
  assert.equal(managed.getStatus(), before, "and must not change the status");
  dispose();
  manager.destroyAgent(managed.id);
}

// ============================================================================
// 5. Option/Ctrl+Enter during the compaction queues instead of opening a second turn
// ============================================================================
//
// `forceSubmit` interrupted "only when a run is active" — and a manual compaction has no pump, so
// that test said no and the message started a pump BESIDE the summarizer: the checkpoint landed in
// a half-finished turn and the window usage the new turn was accumulating was reset underneath it.
{
  const { managed, chat } = await makeAgent("manual-compact-force-submit");
  const { calls, config } = makeCapturingAdapter();
  managed.setTextAdapter(config);
  const events = { agentId: managed.id, aborts: 0, stops: 0, manualStarts: 0, autoStarts: 0, reactiveStarts: 0 };
  const dispose = observeRunEvents(events);

  const compacting = managed.compact();
  assert.equal(
    chat.isRunActive(),
    true,
    "a manual compaction is active work — it has no pump, which is exactly why the old test missed it"
  );

  chat.forceSubmit("forced during compaction");

  assert.equal(
    hasUserText(chat, "forced during compaction"),
    false,
    "force-submit must not open a turn while the checkpoint is still being written"
  );
  assert.deepEqual(
    chat.getQueuedMessages().followUp.map((content) => (typeof content === "string" ? content : "")),
    ["forced during compaction"],
    "it degrades to a queued follow-up instead"
  );
  assert.equal(events.aborts, 0, "and aborts nothing: there was no run to interrupt");

  const result = await compacting;
  assert.equal(result.ok, true, "the short transcript is a no-op compaction, not a failure");
  assert.equal(hasUserText(chat, "forced during compaction"), true, "the queued message is released");
  assert.equal(chat.getQueuedMessages().followUp.length, 0, "and the queue is empty");

  await chat.runChain;
  assert.ok(calls.length >= 1, "it starts the turn it was always meant to start");
  assert.equal(managed.getStatus(), "completed", "which settles like any other turn");

  dispose();
  manager.destroyAgent(managed.id);
}

// ============================================================================
// 6. The interlock still holds AFTER a completed turn
// ============================================================================
//
// `shouldDeferQueue` short-circuits while a stale (superseded) pump is unwinding, so new input is
// not swallowed by a run that is already gone. That token used to survive the pump's exit: after
// the first completed turn the field stayed non-current forever, the shortcut fired before the
// `compacting` check, and the next `/compact` was raced by a real turn — the exact defect cases 2
// and 5 fix, reintroduced one turn later. The fixture never ran a turn, which is why it passed.
{
  const { managed, chat } = await makeAgent("manual-compact-after-turn");
  const { calls, config } = makeCapturingAdapter();
  managed.setTextAdapter(config);

  await chat.sendMessage("first turn");
  await chat.runChain;
  assert.equal(managed.getStatus(), "completed", "the first turn settles normally");
  const callsAfterFirstTurn = calls.length;
  assert.ok(callsAfterFirstTurn >= 1, "the first turn reached the model");

  const compacting = managed.compact();
  chat.followUp("typed after a completed turn");

  assert.equal(
    hasUserText(chat, "typed after a completed turn"),
    false,
    "a completed turn must not disable the compaction interlock for the rest of the session"
  );
  assert.deepEqual(
    chat.getQueuedMessages().followUp.map((content) => (typeof content === "string" ? content : "")),
    ["typed after a completed turn"],
    "the message queues until the compaction ends"
  );

  const result = await compacting;
  assert.equal(result.ok, true, "the short transcript is a no-op compaction, not a failure");
  assert.equal(hasUserText(chat, "typed after a completed turn"), true, "the queued message is released");

  await chat.runChain;
  assert.ok(calls.length > callsAfterFirstTurn, "and starts a turn of its own");
  assert.equal(managed.getStatus(), "completed", "which settles like any other turn");

  manager.destroyAgent(managed.id);
}

// ============================================================================
// 7. Stopping producers (session switch) must not leave `compacting` behind
// ============================================================================
//
// `stopForSessionSwitch` is a public entry that only stops producers, unlike `reset()`. Dropping
// the compaction lease was enough for the producer to become a no-op, but nothing restored the
// status: `isRunActive()` stayed true, so `/compact` and `/clone` were refused and input queued
// with no drainer.
{
  const { managed, chat } = await makeAgent("manual-compact-stop-for-switch");
  const compacting = managed.compact();
  assert.equal(managed.getStatus(), "compacting", "fixture: the compaction owns the status");

  managed.stopForSessionSwitch("session-switch");
  assert.notEqual(managed.getStatus(), "compacting", "stopping producers must restore the status it replaced");
  assert.equal(managed.compactions.isRunning(), false, "and release the lease");
  assert.equal(chat.isRunActive(), false, "so the agent no longer reports active work");

  const result = await compacting;
  assert.equal(result.ok, false, "the aborted compaction reports failure");
  assert.notEqual(managed.getStatus(), "compacting", "and its late teardown must not put it back");

  manager.destroyAgent(managed.id);
}

clearCoreEnv();
fs.rmSync(rootPath, TEMP_RM_OPTIONS);
console.log("\nvalidate-manual-compact-interlock: all assertions passed");

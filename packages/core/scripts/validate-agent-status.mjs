/**
 * Validates agent status helpers and ManagedAgent lifecycle ownership.
 *
 * Run: pnpm --filter @codent/core run validate:agent-status
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  abortManagedAgentRun,
  ACTIVE_STATUSES,
  createAgentStatusController,
  isActiveStatus,
  isTerminalStatus,
  ManagedAgent,
  resolveFinishStatus,
} from "../dist/dev.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

assert.equal(isTerminalStatus("aborted"), true);
assert.equal(isTerminalStatus("waiting"), true);
assert.equal(isTerminalStatus("running"), false);

assert.equal(isActiveStatus("thinking"), true);
assert.equal(isActiveStatus("completed"), false);
assert.equal(ACTIVE_STATUSES.has("compacting"), true);

assert.equal(resolveFinishStatus("aborted", ""), "aborted");
assert.equal(resolveFinishStatus("waiting", "oops"), "waiting");
assert.equal(resolveFinishStatus("awaiting_user", ""), "awaiting_user");
assert.equal(resolveFinishStatus("running", "failed"), "error");
assert.equal(resolveFinishStatus("responding", ""), "completed");

// The two tables answer DIFFERENT questions, and the abort guard needs the second one.
//
// `TERMINAL_STATUSES` means "must not be overwritten when a stream finishes NORMALLY" — so it
// excludes `completed` (that is the value such a finish writes) and includes `waiting` /
// `awaiting_user` (paused runs, which can still be aborted). Asking it "has this run ended"
// returns `false` for `completed`, which is how a guard written against it left the bug it was
// meant to fix fully intact.
assert.equal(isTerminalStatus("completed"), false, "`completed` is deliberately NOT terminal");
assert.equal(isActiveStatus("completed"), false, "…but it is not active either — abort changes nothing");
assert.equal(isActiveStatus("waiting"), true, "a paused run is still abortable");
assert.equal(isActiveStatus("awaiting_user"), true);
assert.equal(isActiveStatus("error"), false);
assert.equal(isActiveStatus("idle"), false);

const managed = new ManagedAgent(
  { name: "test", model: "gpt-4" },
  {
    context: {
      getMessages: () => [],
      getUIMessages: () => [],
      reset: () => {},
      setMessages: () => {},
      setUIMessages: () => {},
      getMessagesForLLM: () => [],
    },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, agent: () => {}, clear: () => {} },
    tools: {},
    todoManager: null,
  }
);

assert.equal(managed.getStatus(), "idle");
managed.setStatus("running");
assert.equal(managed.getStatus(), "running");

managed.setClientToolWaiting(true);
assert.equal(managed.getStatus(), "awaiting_user");
managed.setClientToolWaiting(false);
assert.equal(managed.getStatus(), "completed");

// Regression: while already awaiting_user, a repeated setClientToolWaiting(true)
// must be a no-op (no setStatus → no re-emit). The app re-dispatches whenever a
// fresh interaction snapshot changes the pending ask_user object reference; an
// unguarded re-emit here fed an infinite app↔core loop.
{
  let setStatusCalls = 0;
  const controller = createAgentStatusController({
    getStatus: () => "awaiting_user",
    setStatus: () => {
      setStatusCalls++;
    },
    getError: () => "",
    setError: () => {},
    setPendingApprovalCount: () => {},
    emitEvent: () => {},
  });
  controller.setClientToolWaiting(true);
  assert.equal(setStatusCalls, 0);
  controller.setClientToolWaiting(false);
  assert.equal(setStatusCalls, 1); // false path still transitions awaiting_user → completed
}

// An answered client tool ends the `awaiting_user` wait, so the resume pump can start.
//
// `prepareRunPhase` used to return for `awaiting_user` unconditionally. The terminal gate
// (`countPendingToolApprovals`) only counts approvals, so a session resumed after answering
// `ask_user` came back as `awaiting_user` — `applyChunkStatus` ignored every status beat and new
// input was queued as if the question were still open.
{
  let status = "awaiting_user";
  const transitions = [];
  const controller = createAgentStatusController({
    getStatus: () => status,
    setStatus: (next, trigger) => {
      transitions.push([next, trigger]);
      status = next;
    },
    getError: () => "",
    setError: () => {},
    setPendingApprovalCount: () => {},
    emitEvent: () => {},
  });
  const askUserMessage = (output) => ({
    id: "a1",
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id: "call_ask",
        name: "ask_user",
        arguments: '{"questions":[]}',
        state: output === undefined ? "input-complete" : "complete",
        ...(output === undefined ? {} : { output }),
      },
    ],
  });

  controller.prepareRunPhase([askUserMessage(undefined)]);
  assert.equal(status, "awaiting_user", "an unanswered client tool keeps the wait");

  controller.prepareRunPhase([askUserMessage({ answers: [{ id: "q1", value: "yes" }] })]);
  assert.deepEqual(transitions.at(-1), ["running", "run-prepare"], "an answered client tool starts the run");
}

// The run's finish reason rides the state payload; the ACP host maps `length` → max_tokens from it.
{
  let reason;
  const controller = createAgentStatusController({
    getStatus: () => "running",
    setStatus: () => {},
    getError: () => "",
    setError: () => {},
    setPendingApprovalCount: () => {},
    setFinishReason: (value) => {
      reason = value;
    },
    emitEvent: () => {},
  });
  controller.onRunFinish("length");
  assert.equal(reason, "length");
  controller.onRunStart();
  assert.equal(reason, null);
}
assert.equal(managed.getL1State().lastFinishReason, null);

managed.setStatus("running");
managed.runFinalizer.finalizeSnapshot([
  {
    id: "u1",
    role: "user",
    parts: [{ type: "text", content: "hi" }],
  },
  {
    id: "a1",
    role: "assistant",
    parts: [{ type: "text", content: "hello" }],
  },
]);
assert.equal(managed.getStatus(), "completed");

managed.setStatus("running");
managed.runFinalizer.finalizeSnapshot([
  {
    id: "u1",
    role: "user",
    parts: [{ type: "text", content: "run" }],
  },
  {
    id: "a1",
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id: "call_cmd",
        name: "run_command",
        arguments: '{"command":"echo hi"}',
        state: "input-complete",
        approval: { needsApproval: true, approved: undefined },
      },
    ],
  },
]);
assert.equal(managed.getStatus(), "waiting");

{
  let current = "aborted";
  const status = createAgentStatusController({
    getStatus: () => current,
    setStatus: (next) => {
      current = next;
    },
    getError: () => "",
    setError: () => {},
    setPendingApprovalCount: () => {},
  });
  status.onRunStart();
  assert.equal(current, "aborted");
  status.onStreamChunk({ type: "TOOL_CALL_START", toolCallId: "t1", toolName: "read_file" });
  assert.equal(current, "aborted");
  status.onStreamChunk({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", content: "x", delta: "x" });
  assert.equal(current, "aborted");
}

{
  // Chunk-driven transitions must only fire on a real change. A run streams
  // hundreds of reasoning/text chunks in a row; re-setting the status they
  // already imply is not a transition (`setStatus` logs only real transitions but
  // re-emits the state/mode/interaction projections on every call).
  let current = "running";
  const setCalls = [];
  const status = createAgentStatusController({
    getStatus: () => current,
    setStatus: (next) => {
      current = next;
      setCalls.push(next);
    },
    getError: () => "",
    setError: () => {},
    setPendingApprovalCount: () => {},
  });

  const reasoning = (i) => ({ type: "REASONING_MESSAGE_CONTENT", messageId: "m1", content: `t${i}`, delta: `t${i}` });

  // First reasoning chunk: running → thinking (a real transition).
  status.onStreamChunk(reasoning(0));
  assert.equal(current, "thinking");
  assert.deepEqual(setCalls, ["thinking"]);

  // The rest of the reasoning stream is the same status — no setStatus at all.
  for (let i = 1; i < 200; i++) status.onStreamChunk(reasoning(i));
  assert.deepEqual(setCalls, ["thinking"], "repeated reasoning chunks must not re-set status");

  // Text after reasoning: thinking → responding (a real transition), then silent.
  const text = (i) => ({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", content: `x${i}`, delta: `x${i}` });
  status.onStreamChunk(text(0));
  assert.equal(current, "responding");
  for (let i = 1; i < 200; i++) status.onStreamChunk(text(i));
  assert.deepEqual(setCalls, ["thinking", "responding"], "repeated text chunks must not re-set status");

  // A tool call still moves responding → running, then stays put on repeats.
  const tool = () => ({ type: "TOOL_CALL_START", toolCallId: "t1", toolName: "read_file" });
  status.onStreamChunk(tool());
  assert.equal(current, "running");
  for (let i = 0; i < 50; i++) status.onStreamChunk(tool());
  assert.deepEqual(setCalls, ["thinking", "responding", "running"], "repeated tool chunks must not re-set status");
}

{
  let current = "running";
  const status = createAgentStatusController({
    getStatus: () => current,
    setStatus: (next) => {
      current = next;
    },
    getError: () => "",
    setError: () => {},
    setPendingApprovalCount: () => {},
  });
  const doneMessages = [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", content: "explore" }],
    },
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", content: "done" }],
    },
  ];
  status.applyRunOutcome({ kind: "finished", messages: doneMessages, path: "detached" });
  assert.equal(current, "completed", "detached subagent run must leave completed, not running");

  current = "running";
  status.applyRunOutcome({ kind: "aborted", messages: doneMessages, path: "detached" });
  assert.equal(current, "aborted");
}

// --- the abort guard: only an in-flight run is turned into an abort ---
//
// Regression, in two layers.
//
// 1. `onAborted` set `aborted` unconditionally and fires SYNCHRONOUSLY inside
//    `RunCoordinator.abort()`, so the `status !== "completed"` check after that call in
//    `abortManagedAgentRun` always saw an already-rewritten status and was dead code. Every
//    destroy of a finished agent logged `completed → aborted`, and the task panel rendered
//    completed delegations as cancelled.
// 2. The first fix used `isTerminalStatus` — which EXCLUDES `completed`, because that table
//    answers "must not be overwritten when a stream finishes normally". So the guard was
//    false for exactly the status it needed to protect, and the bug survived a green build.
//    The predicate must be `isActiveStatus` ("currently doing work" — aborting has something
//    to change).
//
// Asserted at the source because both defects are about placement and predicate choice, which
// no value assertion of the pure helper can see.
{
  const src = readFileSync(join(SRC, "managers/managed-agent-run-lifecycle.ts"), "utf8");
  const listener = /onAborted: \(\) => \{([\s\S]*?)\n {6}\}/.exec(src);
  assert.ok(listener, "the abort listener is present");
  const body = listener[1];
  assert.ok(
    /if \(isActiveStatus\(host\.getStatus\(\)\)\)/.test(body),
    "the listener flips the status only for an ACTIVE run"
  );
  assert.ok(
    body.indexOf("isActiveStatus") < body.indexOf('setStatus("aborted")'),
    "the guard must be read BEFORE the status is written (the write is unconditional otherwise)"
  );
  // Both abort paths use the SAME predicate; if one lags, it silently undoes the other (the
  // post-check relabelled `error` agents as `aborted` once the listener stopped pre-empting
  // it).
  const guards = [...src.matchAll(/if \((isActiveStatus|isTerminalStatus)\(host\.getStatus\(\)\)\)/g)];
  assert.equal(guards.length, 2, "both abort paths are guarded");
  for (const g of guards) {
    assert.equal(g[1], "isActiveStatus", "…and with the same predicate");
  }
  // No unguarded `setStatus("aborted")` may survive in this module.
  for (const match of src.matchAll(/setStatus\("aborted"\)/g)) {
    const before = src.slice(Math.max(0, match.index - 500), match.index);
    assert.ok(
      /isActiveStatus/.test(before),
      'every `setStatus("aborted")` in the run-lifecycle module is behind the active-status guard'
    );
  }
}

// --- BEHAVIOURAL: the REAL abort path, driven with a real controller ---
//
// The source assertions above pin the predicate; this one proves it actually protects the
// status, through the same functions the runtime calls. It exists because the first fix passed
// every source assertion and still shipped the bug (the assertion pinned the wrong predicate),
// and because a reader of the source cannot see that `run.abort()` notifies synchronously.
{
  const makeHost = (initialStatus) => {
    let current = initialStatus;
    const controller = new AbortController();
    const host = {
      id: "behavioural-test",
      getStatus: () => current,
      setStatus: (next) => {
        current = next;
      },
      getError: () => "",
      setError: () => {},
      emitEvent: () => {},
      getUI: () => undefined,
      run: {
        setupAbortController: (_signal, setup) => {
          controller.signal.addEventListener("abort", () => setup.onAborted(), { once: true });
        },
        abort: (reason) => controller.abort(reason),
        currentAbortController: controller,
      },
    };
    return { host, controller, status: () => current };
  };

  // A run that already finished keeps `completed` — the reported defect, reproduced here.
  {
    const { host, controller, status } = makeHost("completed");
    abortManagedAgentRun(host, "Agent destroyed");
    assert.equal(status(), "completed", "destroying a finished agent must not rewrite its status");
    assert.equal(controller.signal.aborted, true, "…but the controller IS aborted (late listeners read it)");
    assert.equal(controller.signal.reason, "Agent destroyed", "…carrying the reason");
  }

  // An in-flight run becomes aborted.
  for (const active of ["running", "thinking", "responding", "waiting", "awaiting_user", "compacting"]) {
    const { host, status } = makeHost(active);
    abortManagedAgentRun(host, "user-cancelled");
    assert.equal(status(), "aborted", `an in-flight ${active} run is aborted`);
  }

  // Terminal / never-started statuses are not relabelled.
  for (const settled of ["completed", "aborted", "error", "idle"]) {
    const { host, status } = makeHost(settled);
    abortManagedAgentRun(host, "Agent destroyed");
    assert.equal(status(), settled, `abort must not rewrite a ${settled} agent`);
  }
}

// The compaction controller calls `onUserCancel` for Esc on a manual `/compact`. Its predicate
// was a hand-written subset (running/thinking/responding/compacting) that omitted the active
// WAITS, while the other abort writer (`abortManagedAgentRun`) did mark them — one cancel, two
// verdicts depending on which entry reached it.
{
  const makeController = (initial) => {
    let current = initial;
    const controller = createAgentStatusController({
      getStatus: () => current,
      setStatus: (status) => {
        current = status;
      },
      setError: () => {},
      setPendingApprovalCount: () => {},
      setClientToolWaiting: () => {},
      emitState: () => {},
      emitEvent: () => {},
      emitError: () => {},
      log: () => undefined,
    });
    return { controller, status: () => current };
  };

  for (const active of ["running", "thinking", "responding", "waiting", "awaiting_user", "compacting"]) {
    const { controller, status } = makeController(active);
    controller.onUserCancel();
    assert.equal(status(), "aborted", `Esc during ${active} is an abort`);
  }
  for (const settled of ["completed", "aborted", "error", "idle"]) {
    const { controller, status } = makeController(settled);
    controller.onUserCancel();
    assert.equal(status(), settled, `Esc must not rewrite a ${settled} agent`);
  }
}

console.log("agent-status validation passed");

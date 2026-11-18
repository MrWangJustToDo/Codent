/**
 * Run scope: one `runId` per turn, and the run-scoped budgets that hang off it.
 *
 * Two rules that only fail silently in production:
 *
 * 1. A tool continuation normally REUSES the turn's run id, but after a `/resume` the switch cleared
 *    it — so a resumed tail (an answered approval, a half-run tool phase) minted none at all. Every
 *    `llm:*` row, the persisted `runId`, the `turn:summary` and any task spawned in that phase then
 *    carried NO run: the log could not slice the turn it belonged to, and cost attribution had
 *    nothing to attribute to.
 * 2. The reactive-compaction retry budget is RUN-scoped. It is reset at the run boundary, so a
 *    continuation that reuses its run must NOT reset it (that made "max 1 per run" mean "max 1 per
 *    phase", i.e. one paid summarization per approval segment).
 *
 * Both live in `prepareManagedAgentForRun`, which is pure against the host port — so this drives the
 * real function with a fake host instead of a whole agent.
 *
 * Run: pnpm --filter @codent/core run validate:run-scope
 */

import assert from "node:assert/strict";

import { prepareManagedAgentForRun } from "../dist/dev.mjs";

function fakeHost({ continuation, currentRunId }) {
  const events = [];
  const state = { currentRunId, retryResets: 0, streamStartedAt: 1_000 };
  const host = {
    id: "agent-run-scope",
    // A child host keeps the prompt-row branch out of this test (it is a different concern).
    parentId: "parent-1",
    run: {
      setupAbortController: () => () => {},
      resetMaxOutputTokensOverride: () => {},
      setPromptlessTurn: () => {},
      consumePromptlessTurn: () => false,
      getCurrentRunId: () => state.currentRunId,
    },
    getStatus: () => "running",
    setStatus: () => {},
    consumePrepareAsNewTurn: () => false,
    consumePrepareAsContinuation: () => continuation,
    consumePreparePromptRowsEmitted: () => false,
    getStreamStartedAt: () => state.streamStartedAt,
    setStreamStartedAt: (value) => {
      state.streamStartedAt = value;
    },
    setCurrentRunId: (runId) => {
      state.currentRunId = runId;
    },
    takePendingWakeCause: () => undefined,
    getCompaction: () => ({
      resetReactiveCompactRetries: () => {
        state.retryResets += 1;
      },
    }),
    getUI: () => ({ getMessages: () => [] }),
    collectExtensionPromptHooks: async () => {},
    emitEvent: (type, payload) => events.push({ type, payload }),
  };
  return { host, state, events };
}

const emptyMessages = [];

// ---------------------------------------------------------------------------
// 1. A NEW turn mints a run id and resets the run-scoped retry budget
// ---------------------------------------------------------------------------
{
  const { host, state } = fakeHost({ continuation: false, currentRunId: "previous-run" });
  await prepareManagedAgentForRun(host, { messages: emptyMessages });

  assert.equal(typeof state.currentRunId, "string", "a new turn mints a run id");
  assert.notEqual(state.currentRunId, "previous-run", "and it is a new id, not the previous turn's");
  assert.equal(state.retryResets, 1, "the run-scoped compaction budget resets at the run boundary");
}

// ---------------------------------------------------------------------------
// 2. A continuation WITH a live run keeps it, and keeps the budget
// ---------------------------------------------------------------------------
{
  const { host, state } = fakeHost({ continuation: true, currentRunId: "live-run" });
  await prepareManagedAgentForRun(host, { messages: emptyMessages });

  assert.equal(state.currentRunId, "live-run", "a tool continuation continues the same run");
  assert.equal(state.retryResets, 0, "and must not reset the per-run compaction budget");
}

// ---------------------------------------------------------------------------
// 3. A continuation with NO run (the post-`/resume` shape) mints one
// ---------------------------------------------------------------------------
//
// This is the regression: `!isToolContinuation` alone left the resumed tail with no run at all.
{
  const { host, state } = fakeHost({ continuation: true, currentRunId: null });
  await prepareManagedAgentForRun(host, { messages: emptyMessages });

  assert.equal(typeof state.currentRunId, "string", "a resumed continuation mints the run it continues");
  assert.ok(state.currentRunId.length > 0, "and the id is usable as a log/cost slice key");
  assert.equal(state.retryResets, 1, "a run that did not exist before starts a fresh budget");
}

// ---------------------------------------------------------------------------
// 4. The stream clock: a continuation with a live clock keeps it
// ---------------------------------------------------------------------------
//
// `setStreamStartedAt` is what the footer's duration is measured from. Restarting it on every phase
// would report only the last phase of a long turn.
{
  const { host, state } = fakeHost({ continuation: true, currentRunId: "live-run" });
  state.streamStartedAt = 42;
  await prepareManagedAgentForRun(host, { messages: emptyMessages });
  assert.equal(state.streamStartedAt, 42, "a continuation keeps the turn's stream clock");

  const fresh = fakeHost({ continuation: false, currentRunId: null });
  fresh.state.streamStartedAt = 42;
  await prepareManagedAgentForRun(fresh.host, { messages: emptyMessages });
  assert.notEqual(fresh.state.streamStartedAt, 42, "a new turn starts its own clock");
}

console.log("run-scope validation passed");

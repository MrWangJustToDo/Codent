/**
 * Validates that a session switch cannot retarget an already-queued persist, and that starting a
 * new session drains the old one without blanking it.
 *
 * Run: pnpm --filter @codent/core run validate:session-switch-safety
 */

import assert from "node:assert/strict";

import {
  SessionLease,
  SessionLifecycleService,
  SessionPersistence,
  SessionService,
  dispatchLocalAgentSessionCommand,
} from "../dist/dev.mjs";

import { fakeModeState } from "./helpers/mode-state.mjs";

/** A lease already active on `id`, like a live agent's before a switch. */
function activeLease(id, onRelease = () => {}) {
  const lease = new SessionLease("agent", { acquire: () => true, release: onRelease });
  lease.claim(id);
  lease.commit();
  return lease;
}

/**
 * Build the four session ports from a flat fake host.
 *
 * The service now takes `SessionRuntime`; the fakes below still describe the individual callbacks,
 * and this adapter keeps those tests readable without re-declaring the whole port shape.
 */
function runtime(host) {
  return {
    lease:
      host.lease ??
      new SessionLease("agent", {
        acquire: host.acquireSessionOwnership ?? (() => true),
        release: host.releaseSessionOwnership ?? (() => {}),
      }),
    run: {
      run: host.run ?? { resetRunState: () => {}, resetTurnLifecycle: () => {} },
      statusController: host.statusController ?? { resetToIdle: () => {} },
      stopActiveRun: host.stopActiveRun ?? (() => {}),
      clearQueuedInput: host.clearQueuedInput ?? (() => {}),
      abortManualCompaction: host.abortManualCompaction ?? (() => {}),
      cascadeAbortToChildren: host.cascadeAbortToChildren ?? (() => {}),
      discardPreforkRuns: host.discardPreforkRuns ?? (() => {}),
      resetRunOutcome: host.resetRunOutcome,
      clearErrorAndRetry: host.clearErrorAndRetry ?? (() => {}),
      clearPendingApprovals: host.clearPendingApprovals ?? (() => {}),
      syncInteractionStateFromUIMessages: host.syncInteractionStateFromUIMessages,
    },
    transcript: {
      sessionPersistence: host.sessionPersistence,
      getSessionData: host.getSessionData,
      setSessionData: host.setSessionData ?? (() => {}),
      getSessionStore: host.getSessionStore ?? (() => null),
      awaitPersistIdle: host.awaitSessionPersistIdle ?? (async () => {}),
      getChatController: host.getChatController ?? (() => undefined),
      emitSessionNew: host.emitSessionNew ?? (() => {}),
      emitSessionSwitch: host.emitSessionSwitch ?? (() => {}),
      refreshState: host.refreshState ?? (() => {}),
      refreshSubagents: host.refreshSubagents,
      beginStateBatch: host.beginStateBatch,
      endStateBatch: host.endStateBatch,
      beginSessionRestore: host.beginSessionRestore,
      endSessionRestore: host.endSessionRestore,
      resetSessionSyncTracker: host.resetSessionSyncTracker ?? (() => {}),
      resetIterationProgress: host.resetIterationProgress ?? (() => {}),
    },
    mode: {
      mode: host.mode ?? { reset: () => {} },
      approvals: host.approvals ?? { clear: () => {} },
      resetTurnContext: host.resetTurnContext ?? (() => {}),
      resetMediaHydrationMisses: host.resetMediaHydrationMisses ?? (() => {}),
    },
    sidecars: {
      getCompaction: host.getCompaction ?? (() => ({ resetReactiveCompactRetries: () => {} })),
      memory: host.memory ?? { resetState: () => {} },
      usage: host.usage ?? { reset: () => {} },
      streamHub: host.streamHub ?? { endAllCommands: () => {}, clearAll: () => {} },
      getTodoManager: host.getTodoManager ?? (() => ({ reset: () => {} })),
      getToolCompactCache: host.getToolCompactCache,
      clearExtensionUi: host.clearExtensionUi,
      clearExtensionSessionNotices: host.clearExtensionSessionNotices,
      destroyChildAgents: host.destroyChildAgents ?? (() => {}),
      clearTaskRuns: host.clearTaskRuns ?? (() => {}),
      resetBackgroundWork: host.resetBackgroundWork ?? (() => {}),
      resumeBackgroundWork: host.resumeBackgroundWork,
      warn: host.warn,
    },
  };
}

const saves = [];
const existing = new Set();
let releaseMediaWrite;
const mediaWriteGate = new Promise((resolve) => {
  releaseMediaWrite = resolve;
});
let markMediaWriteStarted;
const mediaWriteStarted = new Promise((resolve) => {
  markMediaWriteStarted = resolve;
});
let mediaWriteCount = 0;
const store = {
  create: () => ({
    id: `ses_${existing.size + 1}`,
    name: "New Session",
    uiMessages: [],
    model: "m",
    modelStyle: "openai",
  }),
  save: async (data) => {
    saves.push({ id: data.id, messages: (data.uiMessages ?? []).map((message) => message.id) });
    existing.add(data.id);
    return true;
  },
  exists: async (id) => existing.has(id),
  getEnv: () => ({
    rootPath: "/tmp/opencode/switch-safety",
    path: { join: (...parts) => parts.join("/") },
    base64Decode: (value) => Buffer.from(value, "base64"),
    fs: {
      exists: async () => false,
      mkdir: async () => {},
      writeFile: async () => {
        mediaWriteCount += 1;
        if (mediaWriteCount === 1) {
          markMediaWriteStarted();
          await mediaWriteGate;
        }
      },
    },
  }),
};

const service = new SessionService();
service.setStore(store, { modelStyle: "openai", model: "m" });
const first = service.ensureSessionData();
first.name = "first";
first.uiMessages = [{ id: "a1", role: "user", parts: [] }];
existing.add(first.id);

const usage = {
  getTotal: () => ({}),
  getTotalCostUsd: () => 0,
  getContextFillTokens: () => 0,
  // `persistSession` records the exact billed prompt; `adoptRestoredSession` resets and restores it.
  getBilledInputTokens: () => 0,
  restoreTotals: () => {},
  reset: () => {},
};
const host = {
  session: service,
  usage,
  getTodoManager: () => null,
  planMode: { getPhase: () => "off", getState: () => null },
  getModeState: () => fakeModeState(),
  mode: { getPersistedAutoMode: () => false },
  isAutoModeEnabled: () => false,
  setAutoModeEnabled: () => {},
  getReasoningEffort: () => undefined,
  emitEvent: () => {},
  clearQueuedMessages: () => {},
  syncInteractionStateFromUIMessages: () => {},
};
const persistence = new SessionPersistence(host);

// Queue a persist for A, then adopt B before the queue runs.
persistence.maybeSave([{ id: "a1", role: "user", parts: [] }], "pump-complete");
const second = {
  id: "ses_B",
  name: "B",
  uiMessages: [{ id: "b1", role: "user", parts: [] }],
  model: "m",
  modelStyle: "openai",
};
service.setSessionData(second);
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(
  saves.some((entry) => entry.id === "ses_B" && entry.messages.includes("a1")),
  false,
  "a queued A write must not be retargeted onto B"
);

// Gate the media write so the switch lands *inside* dehydrate, not before it starts.
// This is the regression that a short sleep cannot reliably catch.
service.setSessionData(first);
const mediaMessage = {
  id: "a-media",
  role: "user",
  parts: [{ type: "image", source: { type: "data", value: "data:image/png;base64,aGVsbG8=" } }],
};
persistence.maybeSave([mediaMessage], "pump-complete");
await mediaWriteStarted;
service.setSessionData(second);
releaseMediaWrite();
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(
  second.uiMessages.some((message) => message.id === "a-media"),
  false,
  "a dehydrate that finishes after the switch must not mutate B"
);
assert.equal(
  saves.some((entry) => entry.id === "ses_B" && entry.messages.includes("a-media")),
  false,
  "a dehydrate that finishes after the switch must not save A's media into B"
);

// `resume()` must drain the persist that `stop()` itself queues. `stopActiveRun` deliberately
// queues a slow write during resume; restore must not begin until that write settles.
{
  const leaving = {
    id: "ses_resume_leave",
    uiMessages: [{ id: "leave-message", role: "user", parts: [] }],
  };
  const target = { id: "ses_resume_target", uiMessages: [], model: "m", modelStyle: "openai" };
  const pendingPersists = [];
  let saveSettled = false;
  let restoreEntered = false;
  let persistDrainCalls = 0;
  const resetCalls = [];
  const sessionSwitches = [];
  const markReset = (name) => () => resetCalls.push(name);

  const lifecycleHost = {
    getSessionData: () => leaving,
    lease: activeLease("ses_resume_leave"),
    awaitSessionPersistIdle: async () => {
      persistDrainCalls += 1;
      await Promise.all(pendingPersists);
    },
    stopActiveRun: () => {
      pendingPersists.push(
        new Promise((resolve) => {
          setTimeout(() => {
            saveSettled = true;
            resolve();
          }, 5);
        })
      );
    },
    abortManualCompaction: () => {},
    clearQueuedInput: () => {},
    cascadeAbortToChildren: () => {},
    discardPreforkRuns: () => {},
    streamHub: { endAllCommands: () => {}, clearAll: markReset("streamHub") },
    mode: { reset: markReset("mode") },
    approvals: { clear: markReset("approvals") },
    run: {
      resetRunState: markReset("runState"),
      resetTurnLifecycle: markReset("turnLifecycle"),
    },
    getCompaction: () => ({ resetReactiveCompactRetries: markReset("reactiveCompact") }),
    statusController: { resetToIdle: markReset("status") },
    clearErrorAndRetry: markReset("errorRetry"),
    clearPendingApprovals: markReset("pendingApprovals"),
    memory: { resetState: markReset("memory") },
    usage: { reset: markReset("usage") },
    resetMediaHydrationMisses: markReset("mediaMisses"),
    getTodoManager: () => ({ reset: markReset("todos") }),
    resetTurnContext: markReset("turnContext"),
    resetSessionSyncTracker: markReset("syncTracker"),
    resetIterationProgress: markReset("iteration"),
    destroyChildAgents: markReset("childAgents"),
    clearTaskRuns: markReset("taskRuns"),
    resetBackgroundWork: markReset("backgroundWork"),
    emitSessionSwitch: (from, to, messageCount, reason) => sessionSwitches.push({ from, to, messageCount, reason }),
    refreshState: () => {},
    sessionPersistence: {
      restore: async (sessionId) => {
        restoreEntered = true;
        assert.equal(saveSettled, true, "restore must wait for the persist queued by stop()");
        return { ...target, id: sessionId };
      },
      resetTracker: () => {},
      // A failed load must drop the bootstrap stand-in that refuses writes; the double has none.
      clearRestorePlaceholder: () => {},
    },
  };
  const lifecycle = new SessionLifecycleService(runtime(lifecycleHost));

  const restored = await lifecycle.resume(target.id);
  assert.equal(restored.id, target.id);
  assert.equal(restoreEntered, true);
  assert.equal(persistDrainCalls, 2, "resume drains before and after stop()");
  assert.ok(
    sessionSwitches.some((entry) => entry.from === leaving.id && entry.to === target.id),
    "the switch is recorded as one event between the two session ids"
  );
  // Restore owns mode/approvals/usage/todos/media misses/tracker; resume only
  // clears the volatile state that the on-disk session cannot rehydrate.
  for (const name of [
    "runState",
    "turnLifecycle",
    "reactiveCompact",
    "status",
    "errorRetry",
    "memory",
    "streamHub",
    "turnContext",
    "iteration",
    "childAgents",
    "taskRuns",
    "backgroundWork",
  ]) {
    assert.equal(resetCalls.includes(name), true, `resume must clear volatile state: ${name}`);
  }

  // A failed restore must not clear the current session's transient state.
  resetCalls.length = 0;
  lifecycleHost.sessionPersistence.restore = async () => {
    throw new Error("target session unreadable");
  };
  await assert.rejects(() => lifecycle.resume("ses_missing_target"), /target session unreadable/);
  assert.deepEqual(resetCalls, [], "a failed restore leaves the current transient state untouched");
}

// `newSession` drains the old session and adopts the new id without clearing the old one.
{
  let released;
  let adopted;
  let transcriptCleared = false;
  let taskRunsCleared = false;
  let childAgentsDestroyed = false;
  let persistDrains = 0;
  const newTarget = { id: "ses_new", name: "New Session", uiMessages: [], model: "m", modelStyle: "openai" };
  const newSessionLifecycle = new SessionLifecycleService(
    runtime({
      getSessionStore: () => ({
        create: () => newTarget,
      }),
      getSessionData: () => ({
        id: "ses_old",
        uiMessages: [{ id: "old", role: "user", parts: [] }],
        model: "m",
        modelStyle: "openai",
      }),
      lease: activeLease("ses_old", (id) => {
        released = id;
      }),
      // No clearPersistedSession in this host: newSession must not look for one.
      awaitSessionPersistIdle: async () => {
        persistDrains += 1;
      },
      stopActiveRun: () => {},
      abortManualCompaction: () => {},
      clearQueuedInput: () => {},
      cascadeAbortToChildren: () => {},
      discardPreforkRuns: () => {},
      streamHub: { endAllCommands: () => {}, clearAll: () => {} },
      mode: { reset: () => {} },
      approvals: { clear: () => {} },
      run: { resetRunState: () => {}, resetTurnLifecycle: () => {} },
      getCompaction: () => ({ resetReactiveCompactRetries: () => {} }),
      statusController: { resetToIdle: () => {} },
      clearErrorAndRetry: () => {},
      clearPendingApprovals: () => {},
      memory: { resetState: () => {} },
      usage: { reset: () => {} },
      resetMediaHydrationMisses: () => {},
      getTodoManager: () => ({ reset: () => {} }),
      resetTurnContext: () => {},
      resetSessionSyncTracker: () => {},
      resetIterationProgress: () => {},
      destroyChildAgents: () => {
        childAgentsDestroyed = true;
      },
      clearTaskRuns: () => {
        taskRunsCleared = true;
      },
      resetBackgroundWork: () => {},
      emitSessionNew: () => {},
      refreshState: () => {},
      refreshSubagents: () => {},
      getChatController: () => ({
        clearTranscript: () => {
          transcriptCleared = true;
        },
      }),
      setSessionData: (data) => {
        adopted = data;
      },
    })
  );
  const started = await newSessionLifecycle.newSession("session-new");
  assert.equal(started.id, "ses_new");
  assert.equal(adopted, newTarget, "the new session is adopted");
  assert.equal(persistDrains, 1, "newSession drains queued persists before rotating");
  assert.equal(transcriptCleared, true, "the live transcript is reset for the new session");
  assert.equal(
    childAgentsDestroyed,
    true,
    "a new session destroys the previous conversation's subagents (not just aborts them)"
  );
  assert.equal(taskRunsCleared, true, "the previous conversation's task records are dropped");
  assert.equal(released, "ses_old", "the previous session's ownership is released after adoption");
}

// A transition is "admitted" synchronously (before `runTransition` starts on a microtask), and the
// window must stay open until EVERY admitted switch settles — a second switch queued behind the
// first is still part of the same unload → load window. Before this, `isTransitioning` flipped only
// when the operation began, so an interaction in that gap saw "not switching" and was applied to
// the session being left.
{
  const gates = [];
  const drainGates = [0, 1].map(
    () =>
      new Promise((resolve) => {
        gates.push(resolve);
      })
  );
  let drains = 0;
  let adopted = null;
  let transcriptCleared = false;
  const lifecycle = new SessionLifecycleService(
    runtime({
      getSessionData: () => ({ id: "ses_flag_old", uiMessages: [] }),
      setSessionData: (data) => {
        adopted = data;
      },
      getSessionStore: () => ({
        create: () => ({ id: `ses_flag_new_${drains}`, uiMessages: [], model: "m", modelStyle: "openai" }),
      }),
      lease: activeLease("ses_flag_old"),
      awaitSessionPersistIdle: () => drainGates[Math.min(drains++, drainGates.length - 1)],
      stopActiveRun: () => {},
      abortManualCompaction: () => {},
      clearQueuedInput: () => {},
      cascadeAbortToChildren: () => {},
      discardPreforkRuns: () => {},
      streamHub: { endAllCommands: () => {}, clearAll: () => {} },
      mode: { reset: () => {} },
      approvals: { clear: () => {} },
      run: { resetRunState: () => {}, resetTurnLifecycle: () => {} },
      getCompaction: () => ({ resetReactiveCompactRetries: () => {} }),
      statusController: { resetToIdle: () => {} },
      clearErrorAndRetry: () => {},
      clearPendingApprovals: () => {},
      memory: { resetState: () => {} },
      usage: { reset: () => {} },
      resetMediaHydrationMisses: () => {},
      getTodoManager: () => ({ reset: () => {} }),
      resetTurnContext: () => {},
      resetSessionSyncTracker: () => {},
      resetIterationProgress: () => {},
      destroyChildAgents: () => {},
      clearTaskRuns: () => {},
      resetBackgroundWork: () => {},
      emitSessionNew: () => {},
      refreshState: () => {},
      refreshSubagents: () => {},
      getChatController: () => ({
        clearTranscript: () => {
          transcriptCleared = true;
        },
      }),
    })
  );

  const first = lifecycle.newSession("session-new");
  assert.equal(lifecycle.isTransitioning(), true, "a switch is visible synchronously, before its microtask runs");

  // A SECOND switch admitted while the first is still running keeps the window open too.
  const second = lifecycle.newSession("session-new");
  await Promise.resolve();
  assert.equal(lifecycle.isTransitioning(), true, "a queued second switch keeps the window open");

  gates[0]();
  await first;
  assert.equal(lifecycle.isTransitioning(), true, "still switching while the second is queued");

  gates[1]();
  await second;
  assert.equal(adopted?.id, "ses_flag_new_1", "both transitions committed");
  assert.equal(transcriptCleared, true);
  assert.equal(lifecycle.isTransitioning(), false, "the flag clears once every admitted transition settles");
}

// An interaction offered inside the switch window is REFUSED, not silently accepted: the chat
// controller drops it (the text belongs to neither transcript), and a host that only receives
// `{ok:true}` clears the user's input on a message nothing accepted. Every entry point must say so.
{
  const refused = {
    sendMessage: async () => "dropped",
    steer: () => false,
    followUp: () => false,
    forceSubmit: () => false,
    respondToToolApproval: async () => "switching",
    addToolResult: async () => "switching",
  };
  const managed = {
    parentId: undefined,
    getChatController: () => refused,
    setClientToolWaiting: () => "switching",
  };
  const cases = [
    { type: "send", content: "hello" },
    { type: "steer", content: "hello" },
    { type: "followUp", content: "hello" },
    { type: "forceSubmit", content: "hello" },
    { type: "respondApproval", approvalId: "a1", approved: true },
    { type: "addToolResult", toolCallId: "t1", output: {} },
  ];
  for (const command of cases) {
    const result = await dispatchLocalAgentSessionCommand(managed, {}, command);
    assert.equal(result.ok, false, `"${command.type}" must refuse while switching`);
    assert.match(String(result.error), /switching/i, `"${command.type}" must explain the refusal`);
  }

  // A queued send is still a success: it was accepted, just not delivered yet.
  const queued = { ...managed, getChatController: () => ({ ...refused, sendMessage: async () => "queued" }) };
  const queuedResult = await dispatchLocalAgentSessionCommand(queued, {}, { type: "send", content: "hello" });
  assert.deepEqual(queuedResult, { ok: true }, "a queued message is accepted");
}

// Protocol outcomes beyond "switching": an already-answered approval and a rejected client-tool
// result must not be reported as a switch (the host would tell the user to retry forever), and a
// wait asserted during compaction must say so.
{
  const chat = {
    respondToToolApproval: async () => "not-pending",
    addToolResult: async () => "rejected",
  };
  const managed = {
    parentId: undefined,
    getChatController: () => chat,
    setClientToolWaiting: () => "compacting",
  };
  const approval = await dispatchLocalAgentSessionCommand(
    managed,
    {},
    {
      type: "respondApproval",
      approvalId: "a1",
      approved: true,
    }
  );
  assert.equal(approval.ok, false);
  assert.match(String(approval.error), /no longer pending/i);

  const result = await dispatchLocalAgentSessionCommand(
    managed,
    {},
    {
      type: "addToolResult",
      toolCallId: "t1",
      output: {},
    }
  );
  assert.equal(result.ok, false);
  assert.match(String(result.error), /rejected/i);

  const waiting = await dispatchLocalAgentSessionCommand(
    managed,
    {},
    {
      type: "setClientToolWaiting",
      active: true,
    }
  );
  assert.equal(waiting.ok, false);
  assert.match(String(waiting.error), /compaction/i);
}

// ---------------------------------------------------------------------------
// A bootstrap restore loads the SAME session the agent already holds
// (`createManagedAgent` activates extensions, then `restoreSession(initialSessionId)`).
// The resume reset must NOT clear extension UI slots there — the Session subscriber that could
// replay them does not exist yet, so "restart lost my extension panel" was the result.
// ---------------------------------------------------------------------------
{
  const session = { id: "ses_same", uiMessages: [], model: "m", modelStyle: "openai" };
  let clearedUi = 0;
  let clearedNotices = 0;
  const host = {
    getSessionData: () => session,
    lease: activeLease(session.id),
    sessionPersistence: {
      restore: async (sessionId) => ({ ...session, id: sessionId }),
      resetTracker: () => {},
      clearRestorePlaceholder: () => {},
    },
    clearExtensionUi: () => {
      clearedUi += 1;
    },
    clearExtensionSessionNotices: () => {
      clearedNotices += 1;
    },
  };
  const lifecycle = new SessionLifecycleService(runtime(host));
  const restored = await lifecycle.resume(session.id);
  assert.equal(restored.id, session.id);
  assert.equal(clearedUi, 0, "a same-session restore keeps the slots activate() just published");
  assert.equal(clearedNotices, 0, "…and its notices");

  // A real switch still clears them.
  const target = { id: "ses_other", uiMessages: [], model: "m", modelStyle: "openai" };
  const switchingHost = {
    ...host,
    getSessionData: () => ({ ...session }),
    lease: activeLease(session.id),
    sessionPersistence: {
      restore: async (sessionId) => ({ ...target, id: sessionId }),
      resetTracker: () => {},
      clearRestorePlaceholder: () => {},
    },
  };
  const switching = new SessionLifecycleService(runtime(switchingHost));
  await switching.resume(target.id);
  assert.equal(clearedUi, 1, "a switch to a different session clears the old conversation's slots");
  assert.equal(clearedNotices, 1, "…and its notices");
}

console.log("session-switch-safety validation passed");

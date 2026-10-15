/**
 * Validates the P1 Session-channel gaps fixed together:
 * 1. `agent:extension-error` routes to the `lifecycle` channel (was channel-less).
 * 2. `AgentL1State` carries model / modelInfo / reasoningEffort so a remote client's
 *    cached snapshot can refresh on a live model / effort switch.
 * 3. Every display-name write path broadcasts: LLM auto-title (`onTitleResolved`),
 *    `getSessionPersistInput` wiring, and resume (`restoreManagedSession`).
 *
 * Run: pnpm --filter @codent/core run validate:l1-state-display-name
 */

import assert from "node:assert/strict";

import {
  AGENT_EVENT_META,
  ManagedAgent,
  SessionService,
  getSessionPersistInput,
  restoreManagedSession,
} from "../dist/dev.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeUsage() {
  return {
    getTotal: () => ({ inputTokens: 0, outputTokens: 0 }),
    getTotalCostUsd: () => 0,
    getWindowUsage: () => ({ inputTokens: 0 }),
    getContextFillTokens: () => 0,
    addTotal: () => {},
  };
}

// --- 1. agent:extension-error → lifecycle -----------------------------------

assert.equal(AGENT_EVENT_META["agent:extension-error"]?.channel, "lifecycle");
// Same-class errors keep the same routing.
assert.equal(AGENT_EVENT_META["agent:stream-error"]?.channel, "lifecycle");
assert.equal(AGENT_EVENT_META["subagent:error"]?.channel, "lifecycle");

// --- 2. AgentL1State carries model / modelInfo / reasoningEffort ------------

{
  const managed = new ManagedAgent(
    { name: "l1-test", model: "gpt-4" },
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
      getTodoManager: () => null,
    }
  );

  const l1 = managed.getL1State();
  assert.equal(l1.model, "gpt-4");
  assert.equal(l1.modelInfo, null);
  assert.equal(l1.reasoningEffort, null);

  managed.setReasoningEffort("high");
  assert.equal(managed.getL1State().reasoningEffort, "high");

  const info = { id: "m", name: "M", style: "openai", apiModel: "m", capabilities: [] };
  managed.setModelInfo(info);
  assert.deepEqual(managed.getL1State().modelInfo, info);
  assert.equal(managed.getL1State().model, "gpt-4");
}

// --- 3a. LLM auto-title broadcasts via onTitleResolved ----------------------

{
  const service = new SessionService();
  const saved = [];
  service.setStore(
    {
      create: () => ({ id: "ses_test", name: "New Session", usage: {}, cost: 0, contextTokens: 0, uiMessages: [] }),
      // No file is ever written by this fake, so the session is "not on disk" — the
      // persist guard treats a content-less session with no file as nothing to write.
      exists: async () => false,
      save: async (data) => {
        saved.push(data);
      },
    },
    { modelStyle: "openai", model: "m" }
  );
  service.setSessionData({ id: "ses_test", name: "New Session", uiMessages: [] });

  const titles = [];
  await service.persistSession({
    usage: fakeUsage(),
    getTodoManager: () => null,
    // No adapter → title falls back to the first user text.
    resolveTextAdapter: async () => null,
    onTitleResolved: (name) => titles.push(name),
    uiMessages: [{ id: "u1", role: "user", parts: [{ type: "text", content: "Hello world" }] }],
  });
  await tick();

  assert.deepEqual(titles, ["Hello world"], "auto-title must broadcast the new name");
  assert.equal(service.getSessionData().name, "Hello world");
  assert.ok(saved.length >= 1, "title must still be persisted");
}

// --- 3b. getSessionPersistInput wires onTitleResolved → setDisplayName ------

{
  const seen = [];
  const input = getSessionPersistInput({
    usage: fakeUsage(),
    getTodoManager: () => null,
    planMode: { getPhase: () => "off", getState: () => null },
    isAutoModeEnabled: () => false,
    getReasoningEffort: () => undefined,
    approvals: { toArray: () => [] },
    resolveTextAdapter: async () => null,
    emitEvent: () => {},
    setDisplayName: (name) => seen.push(name),
  });

  assert.equal(typeof input.onTitleResolved, "function");
  assert.deepEqual(input.onTitleResolved && (input.onTitleResolved("Title From Model"), seen), ["Title From Model"]);
}

// --- 3c. Resume broadcasts the restored session name -----------------------

{
  const names = [];
  const restored = { id: "ses_r", name: "Restored Session", uiMessages: [], approvals: [] };
  await restoreManagedSession(
    {
      toolCompactCache: { clear: () => {} },
      session: { restoreFromStore: async () => restored },
      usage: fakeUsage(),
      getTodoManager: () => null,
      planMode: { restoreState: () => {}, getPhase: () => "off", getState: () => null },
      setAutoModeEnabled: () => {},
      isAutoModeEnabled: () => false,
      approvals: { restore: () => {} },
      sessionSyncTracker: { reset: () => {} },
      getUI: () => ({ setMessages: () => {} }),
      clearQueuedMessages: () => {},
      syncInteractionStateFromUIMessages: () => {},
      emitEvent: () => {},
      setDisplayName: (name) => names.push(name),
    },
    "ses_r"
  );

  assert.deepEqual(names, ["Restored Session"], "resume must mirror the restored display name");
}

console.log("l1-state-display-name validation passed");

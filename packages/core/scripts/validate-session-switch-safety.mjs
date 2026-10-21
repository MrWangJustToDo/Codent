/**
 * Validates that a session switch cannot retarget an already-queued persist, and that /clear
 * blanks the old session before rotating.
 *
 * Run: pnpm --filter @codent/core run validate:session-switch-safety
 */

import assert from "node:assert/strict";

import { SessionPersistence, SessionService } from "../dist/dev.mjs";

const saves = [];
const existing = new Set();
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
  getEnv: () => ({ rootPath: "/tmp/opencode/switch-safety", path: { join: (...parts) => parts.join("/") } }),
};

const service = new SessionService();
service.setStore(store, { modelStyle: "openai", model: "m" });
const first = service.ensureSessionData();
first.name = "first";
first.uiMessages = [{ id: "a1", role: "user", parts: [] }];
existing.add(first.id);

const usage = { getTotal: () => ({}), getTotalCostUsd: () => 0, getContextFillTokens: () => 0 };
const host = {
  session: service,
  usage,
  getTodoManager: () => null,
  planMode: { getPhase: () => "off", getState: () => null },
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

// The /clear path awaits the empty write before rotating.
service.setSessionData(first);
await persistence.clearNow();
assert.equal(saves.at(-1).id, first.id);
assert.deepEqual(saves.at(-1).messages, [], "the old session is blanked before rotation");

console.log("session-switch-safety validation passed");

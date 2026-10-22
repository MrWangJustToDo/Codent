/**
 * Validates the agent-side session persistence transaction:
 * - the owned tracker dedupes repeated saves and only advances on a landed write;
 * - there is no in-place clear escape hatch (a new conversation is a new session);
 * - persistState() writes state without a message snapshot;
 * - resetTracker() re-enables a save of identical content.
 *
 * Run: pnpm --filter @codent/core run validate:session-persistence
 */

import assert from "node:assert/strict";

import { SessionPersistence } from "../dist/dev.mjs";

const messages = [{ id: "u1", role: "user", parts: [{ type: "text", content: "hello" }] }];
const calls = [];
let landed = true;
const host = {
  usage: {},
  getTodoManager: () => null,
  planMode: { getPhase: () => "off", getState: () => null },
  isAutoModeEnabled: () => false,
  setAutoModeEnabled: () => {},
  getReasoningEffort: () => undefined,
  session: {
    getSessionData: () => ({ id: "ses_current" }),
    persistSession: async (input) => {
      calls.push(typeof input === "function" ? input() : input);
      return landed;
    },
  },
  approvals: { restore: () => {} },
  toolCompactCache: { clear: () => {} },
  emitEvent: () => {},
  clearQueuedMessages: () => {},
  syncInteractionStateFromUIMessages: () => {},
};

const persistence = new SessionPersistence(host);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// First save lands and advances the tracker.
persistence.maybeSave(messages, "pump-complete");
await tick();
assert.equal(calls.length, 1);
assert.ok(calls[0].uiMessages);

// Identical content is deduped by the owned tracker.
persistence.maybeSave(messages, "pump-complete");
await tick();
assert.equal(calls.length, 1, "identical content is a no-op");

// A reset re-enables the same content.
persistence.resetTracker();
persistence.maybeSave(messages, "pump-complete");
await tick();
assert.equal(calls.length, 2, "resetTracker re-enables an identical save");

// A failed write must not advance the tracker.
landed = false;
persistence.save([{ id: "u2", role: "user", parts: [{ type: "text", content: "new" }] }]);
await tick();
assert.equal(calls.length, 3);
landed = true;
persistence.maybeSave([{ id: "u2", role: "user", parts: [{ type: "text", content: "new" }] }], "pump-complete");
await tick();
assert.equal(calls.length, 4, "a failed write leaves the content retryable");

// State-only persist has no uiMessages snapshot.
persistence.persistState();
await tick();
assert.equal(calls.at(-1).uiMessages, undefined);

// SessionPersistence has no clear operation: a conversation is never blanked in place.
assert.equal(persistence.clear, undefined, "SessionPersistence.clear must not exist");
assert.equal(persistence.clearNow, undefined, "SessionPersistence.clearNow must not exist");

console.log("session-persistence validation passed");

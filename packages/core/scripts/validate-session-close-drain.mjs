/**
 * Validates that `SessionService.close()` drains writes admitted before the close.
 *
 * Regression: close() used to set `closed` before awaiting the queue, and the queued inner
 * persist checked `closed` at execution time. A final pump-complete save could therefore be
 * admitted and then silently rejected during teardown.
 *
 * Run: pnpm --filter @codent/core run validate:session-close-drain
 */

import assert from "node:assert/strict";

import { SessionService } from "../dist/dev.mjs";

let releaseSave;
const saveGate = new Promise((resolve) => {
  releaseSave = resolve;
});
let saveStarted;
const started = new Promise((resolve) => {
  saveStarted = resolve;
});
const saved = [];

const store = {
  create: () => ({ id: "ses_close", name: "test", uiMessages: [], model: "m", modelStyle: "openai" }),
  exists: async () => true,
  save: async (data) => {
    saveStarted();
    await saveGate;
    saved.push(data.id);
    return true;
  },
  isDeleted: () => false,
  getEnv: () => ({ rootPath: "/tmp/opencode/session-close", path: { join: (...parts) => parts.join("/") } }),
};

const usage = {
  getTotal: () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
  getTotalCostUsd: () => 0,
  getContextFillTokens: () => 2,
  // The persist path also records the exact per-sample billed prompt (`SessionData.billedInputTokens`).
  getBilledInputTokens: () => 0,
  restoreTotals: () => {},
  reset: () => {},
};

const service = new SessionService();
service.setStore(store, { modelStyle: "openai", model: "m" });
const data = service.ensureSessionData();
data.name = "test";

const input = {
  usage,
  todoManager: null,
  planMode: null,
  autoMode: false,
  uiMessages: [{ id: "u1", role: "user", parts: [{ type: "text", content: "hello" }] }],
  sessionId: data.id,
};

const admitted = service.persistSession(input);
const closing = service.close();
await started;
releaseSave();
assert.equal(await admitted, true, "a write admitted before close() still lands");
await closing;
assert.deepEqual(saved, [data.id], "the admitted write reached the store");
assert.equal(await service.persistSession(input), false, "new writes are refused after close()");

console.log("session-close-drain validation passed");

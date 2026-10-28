/**
 * Validation: deleting a session cannot be undone by a queued or in-flight persist.
 *
 * Run: pnpm --filter @codent/core run validate:session-delete-race
 *
 * The deletion path destroys the live agent, and the abort path can queue a final
 * `pump-complete` persist. `deleteSession` used to remove the file after teardown without
 * draining that write, so a deleted conversation came back carrying the cancelled turn.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionService, SessionStore, createLocalAgentSessionHost, registerCoreEnv } from "../dist/dev.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const nodePkg = await import("@codent/node");
const ws = mkdtempSync(join(tmpdir(), "session-delete-race-"));
const env = nodePkg.createNodeEnv({ rootPath: ws });
registerCoreEnv(env);

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function usage() {
  return {
    getTotal: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    getTotalCostUsd: () => 0,
    getContextFillTokens: () => 0,
    // Persist records the exact per-sample billed prompt; restore takes it back.
    getBilledInputTokens: () => 0,
    restoreTotals: () => {},
    reset: () => {},
  };
}

const store = new SessionStore(env);
const service = new SessionService();
service.setStore(store, { modelStyle: "openai", model: "test-model" });
const data = service.ensureSessionData();
assert.ok(data, "session data allocated");
data.name = "victim";
data.uiMessages = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }];
await store.save(data);

const gate = deferred();
const started = deferred();
const slowStore = {
  save: async (session) => {
    started.resolve();
    await gate.promise;
    return store.save(session);
  },
  exists: (id) => store.exists(id),
  isDeleted: (id) => store.isDeleted(id),
  getEnv: () => store.getEnv(),
};

service.setStore(slowStore, { modelStyle: "openai", model: "test-model" });

const managed = {
  id: "agent_1",
  parentId: undefined,
  name: "victim",
  session: service,
  getSessionStore: () => store,
  getSessionData: () => service.getSessionData(),
};

const manager = {
  runtime: { env },
  createManagedAgent: async () => managed,
  getAgents: () => [managed],
  getAgent: () => undefined,
  destroyAgent: () => {},
  settleTeardowns: async () => {},
  releaseSessionOwnership: () => {},
};

const host = createLocalAgentSessionHost({ manager });

// A write that has already entered the store and is blocked on IO, exactly the window in
// which `deleteSession` used to remove the file underneath it.
const write = service.persistSession({
  usage: usage(),
  todoManager: null,
  planMode: null,
  autoMode: false,
  uiMessages: [
    { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "cancelled row" }] },
  ],
  sessionId: data.id,
});
await started.promise;

const deletePromise = host.deleteSession(data.id);
let deleted = false;
void deletePromise.then(() => {
  deleted = true;
});
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(deleted, false, "delete waits for the in-flight write instead of racing it");

gate.resolve();
await write;
assert.equal(await deletePromise, true, "delete succeeds after the write settles");

const logPath = join(ws, ".agents/sessions", `${data.id}.session.jsonl`);
assert.equal(await env.fs.exists(logPath), false, "the session file stays deleted");
assert.equal(await store.isDeleted(data.id), true, "the deletion tombstone is recorded");

// A later save (the async title path, a stale pump) is refused rather than recreating the file.
const late = await service.persistSession({
  usage: usage(),
  todoManager: null,
  planMode: null,
  autoMode: false,
  uiMessages: [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "late" }] }],
  sessionId: data.id,
});
assert.equal(late, false, "a closed session refuses later writes");
assert.equal(await env.fs.exists(logPath), false, "a late write does not resurrect the session");

rmSync(ws, TEMP_RM_OPTIONS);
console.log("session delete race validation passed");

/**
 * Validates that a restore whose post-load rewrite fails leaves the old session active. If
 * SessionData had already been adopted, ownership, log and tracker would describe a switch that
 * never completed.
 *
 * Run: pnpm --filter @codent/core run validate:session-restore-rollback
 */

import assert from "node:assert/strict";

import { AgentLog, clearCoreEnv, ManagedAgent, registerCoreEnv, SessionService } from "../dist/dev.mjs";

registerCoreEnv({
  rootPath: "/tmp/opencode/restore-rollback",
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({}),
  homedir: async () => "/tmp",
  fs: {
    readFile: async () => "",
    writeFile: async () => {},
    appendFile: async () => {},
    mkdir: async () => {},
    exists: async () => false,
    readdir: async () => [],
    stat: async () => ({ isDirectory: false, isFile: true, size: 0, mtime: new Date() }),
    remove: async () => {},
  },
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => new Response(),
});

const target = {
  id: "ses_B",
  name: "B",
  version: 7,
  modelStyle: "openai",
  model: "m",
  createdAt: 1,
  updatedAt: 1,
  uiMessages: [],
  planMode: null,
  autoMode: false,
};
const store = {
  load: async (id) => (id === "ses_B" ? { ...target, uiMessages: [] } : null),
  // The post-swap save fails: data has already become B when this throws.
  save: async () => {
    throw new Error("disk full");
  },
  exists: async () => true,
  getEnv: () => ({ rootPath: "/tmp/opencode/restore-rollback", path: { join: (...parts) => parts.join("/") } }),
};

const session = new SessionService();
session.setStore(store, { modelStyle: "openai", model: "m" });
session.setSessionData({ ...target, id: "ses_A", name: "A" });

const managed = new ManagedAgent(
  { name: "restore-rollback", model: "m" },
  { log: new AgentLog(), tools: {}, todoManager: null, session }
);
const claims = new Map([["ses_A", managed.id]]);
const released = [];
managed.manager = {
  acquireSessionOwnership: (id, agentId) => {
    const owner = claims.get(id);
    if (owner && owner !== agentId) return false;
    claims.set(id, agentId);
    return true;
  },
  releaseSessionOwnership: (id, agentId) => {
    if (claims.get(id) === agentId) {
      claims.delete(id);
      released.push(id);
    }
  },
  getLogExtension: () => ({ attachSink: () => () => {} }),
};

try {
  await managed.restoreSession("ses_B");
  assert.fail("the restore must reject when the post-swap save fails");
} catch (error) {
  assert.match(error.message, /disk full/);
}

assert.equal(managed.getSessionData()?.id, "ses_A", "the old session remains active after a failed save");
assert.equal(claims.get("ses_A"), managed.id, "the old claim is kept");
assert.equal(claims.has("ses_B"), false, "the attempted target claim is rolled back");
assert.deepEqual(released, ["ses_B"]);

clearCoreEnv();
console.log("session-restore-rollback validation passed");

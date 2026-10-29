/**
 * Validates that a session's model follows `/models` switches on disk and is
 * re-applied when the session is resumed:
 * - `model.set` persists `model` / `modelStyle` into the session record
 *   (previously only `store.create` wrote it → resume always fell back to the
 *   creation-time default model). On a session already on disk: a session with no
 *   content is never written, so the block saves one first.
 * - `session.resume` adopts the persisted model (except under remote-provider,
 *   where the provider server owns the model).
 *
 * Run: pnpm --filter @codent/core run validate:session-model-persistence
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentManager, CodentAgent, createLocalAgentSessionHost, registerCoreEnv } from "../dist/index.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// Mock CoreEnv (real fs under a temp root)
// ============================================================================

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "session-model-"));
const toAbs = (p) => (path.isAbsolute(p) ? p : path.join(rootPath, p));

/** The mock workspace env — kept in a variable because the remote-provider case builds a runtime from it. */
const mockEnv = {
  rootPath,
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({}),
  homedir: async () => rootPath,
  fs: {
    readFile: async (p, encoding) => fs.promises.readFile(toAbs(p), encoding ?? "utf-8"),
    writeFile: async (p, content) => fs.promises.writeFile(toAbs(p), content),
    appendFile: async (p, content) => fs.promises.appendFile(toAbs(p), content, "utf8"),
    // `SessionStore.writeLog` writes a temp file and renames it onto the log, so a concurrent
    // reader observes either the old file or the new one — never a truncated one. Omitting
    // `rename` silently degrades the store to `writeFile`-in-place (`session-journal.ts`),
    // which truncates to zero bytes before writing: a `load()` landing in that window read an
    // empty file, and an empty log folds to no state, so it returned `null` *while the log was
    // on disk and correct* — the intermittent `Cannot read properties of null` on Windows CI.
    // Mirrors `createNodeEnv` (packages/node `native-fs.ts`), which every real host provides.
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
        return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
      } catch {
        return [];
      }
    },
    stat: async (p) => {
      const st = await fs.promises.stat(toAbs(p));
      return { isDirectory: st.isDirectory(), isFile: st.isFile(), size: st.size, mtime: st.mtime };
    },
    remove: async (p) => fs.promises.rm(toAbs(p), TEMP_RM_OPTIONS),
  },
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => new Response(),
};

registerCoreEnv(mockEnv);

const waitFor = async (check, label) => {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
};

// ============================================================================
// 1. `model.set` reaches disk
// ============================================================================

const manager = new AgentManager();
const host = createLocalAgentSessionHost({ manager });
const created = await host.create({ name: "model-persist", model: "default-model", modelStyle: "openai" });
const session = created.session;
const agentId = session.getSnapshot().agentId;
const managed = manager.getAgent(agentId);
const store = managed.getSessionStore();
const sessionId = managed.getSessionData().id;

// A session reaches disk only on its first *content* save (`SessionService.persistSessionInner`),
// so a state-only `persistSession()` on a fresh session is a no-op. Save the session directly to
// stand in for the transcript a real session would carry; `model.set` must then persist on its own.
await store.save(managed.getSessionData());
await waitFor(async () => (await store.load(sessionId)) !== null, "initial session on disk");
assert.equal((await store.load(sessionId)).model, "default-model");

// A switch is a timeline fact: `/models` used to be silent (the only trace was the next
// `llm:request`), so "why did the answers change" had no answer.
const modelEvents = [];
manager.of(agentId).on("model:change", (event) => modelEvents.push(event.payload));

const switched = await session.dispatch({ type: "model.set", model: "switched-model", modelStyle: "anthropic" });
assert.equal(switched.ok, true);
assert.deepEqual(
  modelEvents,
  [{ from: "default-model", to: "switched-model", style: "anthropic" }],
  `one model:change per switch, got ${JSON.stringify(modelEvents)}`
);

await waitFor(async () => (await store.load(sessionId)).model === "switched-model", "model persisted to disk");
const onDisk = await store.load(sessionId);
assert.equal(onDisk.model, "switched-model", "model switch must be persisted");
assert.equal(onDisk.modelStyle, "anthropic", "model style must be persisted");
assert.equal(managed.getL1State().model, "switched-model", "live L1 state reflects the switch");

// ============================================================================
// 2. Resume adopts the persisted model
// ============================================================================

// Another live agent owns the session; release it so the second agent may resume.
manager.releaseSessionOwnership(sessionId, agentId);

const manager2 = new AgentManager();
const host2 = createLocalAgentSessionHost({ manager: manager2 });
const created2 = await host2.create({
  name: "model-restore",
  model: "default-model",
  modelStyle: "openai",
  resumeSessionId: sessionId,
});
const managed2 = manager2.getAgent(created2.session.getSnapshot().agentId);
assert.equal(managed2.config.model, "switched-model", "resume must adopt the persisted model");
assert.equal(managed2.config.modelStyle, "anthropic", "resume must adopt the persisted style");
assert.equal(managed2.getL1State().model, "switched-model");
assert.equal(created2.session.getSnapshot().model, "switched-model");

// ============================================================================
// 3. remote-provider: the persisted model is adopted when the catalog offers it
// ============================================================================
//
// The client owns the model under remote-provider too (the provider supplies the CATALOG and
// the proxy), so a resumed session must come back on the model it was switched to — and fall
// back to the model the session already runs when the catalog no longer offers it, because that
// id would be refused on the first request.

manager2.releaseSessionOwnership(sessionId, managed2.id);

const REMOTE_CATALOG = ["provider-model", "switched-model"];
const remoteProvider = {
  getConnection: async () => ({
    mode: "remote",
    style: "openai",
    model: "provider-model",
    baseURL: "http://remote/api/provider/openai/v1",
    apiKey: "remote-provider",
    models: REMOTE_CATALOG,
  }),
};

// (a) The catalog still offers the persisted model → the resume comes back on it. The STYLE is
// deliberately not adopted under remote-provider (the proxy owns it; a persisted `anthropic`
// style against an OpenAI-style proxy is a hard `style_mismatch`), which
// `validate:resolve-from-provider` pins on the connection side.
const offering = await CodentAgent.create({
  env: mockEnv,
  provider: remoteProvider,
  models: { entries: [{ type: "remote", style: "openai", baseURL: "", models: REMOTE_CATALOG }] },
});
const offeringCreated = await offering.host.create({
  name: "model-remote-offered",
  model: "provider-model",
  modelStyle: "openai",
  providerMode: "remote",
  resumeSessionId: sessionId,
});
const offeringAgent = offering.host.connect(offeringCreated.session.id);
assert.equal(
  offeringAgent?.getSnapshot().model,
  "switched-model",
  "remote-provider adopts a persisted model the catalog still offers"
);
await offering.dispose();

// (b) The catalog no longer offers it → the session keeps the model it was created with.
const retired = await CodentAgent.create({
  env: mockEnv,
  provider: {
    getConnection: async () => ({
      mode: "remote",
      style: "openai",
      model: "provider-model",
      baseURL: "http://remote/api/provider/openai/v1",
      apiKey: "remote-provider",
      models: ["provider-model"],
    }),
  },
  models: { entries: [{ type: "remote", style: "openai", baseURL: "", models: ["provider-model"] }] },
});
const retiredCreated = await retired.host.create({
  name: "model-remote-retired",
  model: "provider-model",
  modelStyle: "openai",
  providerMode: "remote",
  resumeSessionId: sessionId,
});
const retiredAgent = retired.host.connect(retiredCreated.session.id);
assert.equal(
  retiredAgent?.getSnapshot().model,
  "provider-model",
  "a persisted model the catalog dropped must not be revived"
);
await retired.dispose();

await fs.promises.rm(rootPath, TEMP_RM_OPTIONS);
console.log("session-model-persistence validation passed");

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
  for (let i = 0; i < 100; i++) {
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
// …and the FALLBACK converges on disk. Adopting the restored record after the fallback put the
// retired id back into `SessionData.model`, so every later resume repeated the same fallback and
// the session list kept naming a model the catalog no longer offers.
await waitFor(
  async () => (await store.load(sessionId)).model === "provider-model",
  "the fallback model persisted to the session record"
);
await retired.dispose();

// ============================================================================
// 4. A persisted model from ANOTHER models.json entry brings its own connection
// ============================================================================
//
// `selectableModelIds` is the union across entries, so the persisted model can belong to entry B
// while bootstrap registered entry A. The model was "offered", so it was adopted — and the request
// then went to A's baseURL with a model A never advertised (404, or served by a gateway under A's
// pricing). The TUI relinks the session model after a `/models` pick; ACP had no equivalent, so the
// connection has to follow the model in core.
{
  const sourceManager = new AgentManager();
  const sourceHost = createLocalAgentSessionHost({ manager: sourceManager });
  const source = await sourceHost.create({ name: "entry-source", model: "model-a", modelStyle: "openai" });
  const sourceAgent = sourceManager.getAgent(source.session.getSnapshot().agentId);
  const sourceStore = sourceAgent.getSessionStore();
  const sourceId = sourceAgent.getSessionData().id;
  const record = sourceAgent.getSessionData();
  record.model = "model-b";
  await sourceStore.save(record);
  sourceManager.releaseSessionOwnership(sourceId, sourceAgent.id);

  const entries = {
    entries: [
      { type: "direct", style: "openai", baseURL: "http://entry-a/v1", apiKey: "key-a", models: ["model-a"] },
      // A DIFFERENT style on purpose: the connection that serves the advertised model owns it, and the
      // persisted style belongs to the entry the record was written with. Returning the requested style
      // made the restore path write it back, so the record and the live config disagreed on every resume.
      { type: "direct", style: "anthropic", baseURL: "http://entry-b/v1", apiKey: "key-b", models: ["model-b"] },
    ],
  };
  const directProvider = { getConnection: async () => ({ mode: "direct", style: "openai", baseURL: "", apiKey: "" }) };

  const crossManager = new AgentManager();
  const crossEntry = await CodentAgent.create({
    env: mockEnv,
    provider: directProvider,
    models: entries,
    manager: crossManager,
  });
  const diagnostics = [];
  // The manager's ROOT bus, subscribed before the resume: the adoption happens while the agent is
  // being built, so a per-agent subscription would be too late.
  crossManager.on("session:diagnostic", (event) => diagnostics.push(event.payload));
  const resumed = await crossEntry.host.create({
    name: "entry-resume",
    model: "model-a",
    modelStyle: "openai",
    modelBaseURL: "http://entry-a/v1",
    modelApiKey: "key-a",
    resumeSessionId: sourceId,
  });
  const resumedAgent = crossManager.getAgent(resumed.session.getSnapshot().agentId);
  assert.equal(resumed.session.getSnapshot().model, "model-b", "the persisted model is adopted");
  assert.equal(
    resumedAgent.config.modelBaseURL,
    "http://entry-b/v1",
    "…and the connection follows the entry that advertises it, not the bootstrap one"
  );
  assert.equal(resumedAgent.config.modelApiKey, "key-b", "including its key");
  assert.equal(
    resumedAgent.config.modelStyle,
    "anthropic",
    "…and its style, which overrides the style the record was saved with"
  );
  assert.equal(
    resumedAgent.getSessionData().modelStyle,
    "anthropic",
    "the session record follows the adopted connection, so the next resume agrees instead of re-correcting"
  );
  assert.equal(
    diagnostics.some((entry) => entry.details?.baseURL === "http://entry-b/v1"),
    true,
    "the adopted connection is reported, so a cross-entry resume is explainable"
  );
  await crossEntry.dispose();
}

// ============================================================================
// 4b. Two advertisers, and a key that belongs to a host
// ============================================================================
//
// `models.json` can list the same id under two entries (two gateways, or two styles). File order is
// not a decision: the persisted style is the per-session fact that tells them apart, and ignoring it
// silently switched a session to a gateway the user did not choose. The key case is worse — an entry
// with no key adopted only the baseURL, so the PREVIOUS host's secret was sent to the new one.
{
  const entries = {
    entries: [
      { type: "direct", style: "openai", baseURL: "http://boot/v1", apiKey: "key-boot", models: ["model-a"] },
      { type: "direct", style: "anthropic", baseURL: "http://a/v1", apiKey: "key-a", models: ["model-x"] },
      { type: "direct", style: "openai", baseURL: "http://b/v1", apiKey: "key-b", models: ["model-x"] },
      { type: "direct", style: "openai", baseURL: "http://c/v1", models: ["model-y"] },
    ],
  };
  const manager = new AgentManager();
  const runtime = await CodentAgent.create({
    env: mockEnv,
    provider: { getConnection: async () => ({ mode: "direct", style: "openai", baseURL: "", apiKey: "" }) },
    models: entries,
    manager,
  });
  const created = await runtime.host.create({
    name: "advertisers",
    model: "model-a",
    modelStyle: "openai",
    modelBaseURL: "http://boot/v1",
    modelApiKey: "key-boot",
  });
  const agent = manager.getAgent(created.session.getSnapshot().agentId);

  // (a) anthropic entry comes FIRST, so `advertisers[0]` would take it; the persisted style is openai.
  const applied = agent.applyPersistedModel({ model: "model-x", modelStyle: "openai" });
  assert.equal(applied.changed, true);
  assert.equal(
    agent.config.modelBaseURL,
    "http://b/v1",
    "the advertiser matching the persisted modelStyle wins over file order"
  );
  assert.equal(agent.config.modelApiKey, "key-b");
  assert.equal(applied.modelStyle, "openai", "and the reported style is the one actually written");

  // (b) an entry with NO key on a different host: the previous host's key must not travel with it.
  agent.applyPersistedModel({ model: "model-y", modelStyle: "openai" });
  assert.equal(agent.config.modelBaseURL, "http://c/v1", "the keyless entry is still adopted");
  assert.equal(
    agent.config.modelApiKey,
    "",
    "a key belongs to the host it authenticates — another host's secret is cleared, not sent"
  );
  await runtime.dispose();
}

// Let the last runtime's log sink drain before the workspace disappears (a retry against a removed
// directory is a noisy ENOENT at exit, not a failure).
await sleep(50);
await fs.promises.rm(rootPath, TEMP_RM_OPTIONS);
console.log("session-model-persistence validation passed");

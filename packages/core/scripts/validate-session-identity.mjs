/**
 * Validates that the *active on-disk session* is observable through the session
 * protocol (audit gap #1):
 * - `AgentL1State.sessionId` / `AgentSessionSnapshot.activeSessionId` reflect the live
 *   disk session while the agent id stays stable.
 * - `session.resume` and `session.new` re-emit the retained `state` channel, so a
 *   live subscriber sees the switch (not just the command caller).
 *
 * Run: pnpm --filter @codent/core run validate:session-identity
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionStore } from "../dist/dev.mjs";
import { AgentManager, createLocalAgentSessionHost, registerCoreEnv } from "../dist/index.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

// ============================================================================
// Mock CoreEnv (real fs under a temp root, mirroring native-fs path handling)
// ============================================================================

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "session-identity-"));
const toAbs = (p) => (path.isAbsolute(p) ? p : path.join(rootPath, p));

registerCoreEnv({
  rootPath,
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({}),
  homedir: async () => rootPath,
  fs: {
    readFile: async (p, encoding) => fs.promises.readFile(toAbs(p), encoding ?? "utf-8"),
    writeFile: async (p, content) => fs.promises.writeFile(toAbs(p), content),
    appendFile: async (p, content) => fs.promises.appendFile(toAbs(p), content, "utf8"),
    // Atomic log replace (`SessionStore.writeLog` writes a temp file and renames it). Without
    // `rename` the store falls back to an in-place `writeFile`, which truncates the log first —
    // a concurrent `load()` can then read an empty file and return `null`.
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
});

// ============================================================================
// Harness
// ============================================================================

const manager = new AgentManager();
const host = createLocalAgentSessionHost({ manager });
const created = await host.create({ name: "identity-test", model: "test-model" });
const session = created.session;
const agentId = session.getSnapshot().agentId;
const managed = manager.getAgent(agentId);
assert.ok(managed, "managed agent must exist");

// Live subscriber on the retained state channel.
const seenSessionIds = [];
session.subscribe(
  (event) => {
    if (event.channel === "state") seenSessionIds.push(event.payload.sessionId);
  },
  { channels: ["state"] }
);

// A late subscriber's retained replay is delivered to that subscriber only. The
// old path used the shared multicast emitter, so every existing subscriber got
// an extra full state/messages/extension-ui frame when a new component mounted.
{
  const initialEvents = [];
  const unsubInitial = session.subscribe((event) => initialEvents.push(event), { channels: ["state"] });
  const beforeLateSubscribe = initialEvents.length;
  const unsubLate = session.subscribe(() => {}, { channels: ["state"] });
  assert.equal(
    initialEvents.length,
    beforeLateSubscribe,
    "a late subscriber's retained state replay must not reach existing subscribers"
  );
  unsubLate();
  unsubInitial();
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Session-scoped log routing. The sink is bound per session id, and both a resume and `/new`
// change that id mid-process — so these helpers are how the validator holds the binding to the
// session it claims to be logging.
const logsRoot = path.join(rootPath, ".agents/logs");
const readLog = async (id) => {
  try {
    return await fs.promises.readFile(path.join(logsRoot, id, "agent.log"), "utf-8");
  } catch {
    return "";
  }
};
const assertIdentity = (expected, label) => {
  assert.equal(session.getSnapshot().activeSessionId, expected, `${label}: snapshot.activeSessionId`);
  assert.equal(managed.getL1State().sessionId, expected, `${label}: L1 sessionId`);
  assert.equal(seenSessionIds.at(-1), expected, `${label}: live state broadcast`);
  assert.equal(session.getSnapshot().agentId, agentId, `${label}: agent identity unchanged`);
};

// ----------------------------------------------------------------------------
// 1. Fresh session is observable from the start
// ----------------------------------------------------------------------------

const first = session.getSnapshot().activeSessionId;
assert.ok(first?.startsWith("ses_"), "fresh session exposes its disk session id");
assertIdentity(first, "fresh");

// ----------------------------------------------------------------------------
// 2. `session.resume` swaps the disk session and broadcasts it
// ----------------------------------------------------------------------------

const store = managed.getSessionStore();
assert.ok(store, "session store available");
// The live agent must actually hold the session it is running, or the release assertion below
// would be vacuous (a never-claimed id is trivially claimable). `createManagedAgent` claims the
// active disk session at bootstrap; this is the other half of the A→B transaction.
{
  const owner = managed.manager;
  assert.ok(owner, "the agent exposes the manager that holds the ownership table");
  assert.equal(
    owner.acquireSessionOwnership(first, "probe-agent"),
    false,
    "a fresh live session is claimed by the agent running it"
  );
}
const target = store.create({ modelStyle: "openai", model: "test-model" });
target.name = "Resumed Target";
target.uiMessages = [{ id: "target-message", role: "user", parts: [{ type: "text", content: "keep me" }] }];
await store.save(target);

const resume = await session.dispatch({ type: "session.resume", sessionId: target.id });
assert.equal(resume.ok, true, "session.resume succeeds");
assert.notEqual(target.id, first, "resume targets a different disk session");
assertIdentity(target.id, "resume");
assert.equal(managed.name, "Resumed Target", "resume mirrors the restored display name");

// Ownership: /resume re-binds THIS agent, and the session it left is released. The claim table is
// per-`AgentManager`, so a leaked claim would block that session for every other live agent in the
// process — and it is `sessionId → agentId` shaped, i.e. several sessions per agent is representable;
// what keeps it one-to-one today is exactly this release (see ARCHITECTURE.md §1.7).
{
  const owner = managed.manager;
  assert.ok(owner, "the agent exposes the manager that holds the ownership table");
  const probe = "probe-agent";

  assert.equal(owner.acquireSessionOwnership(target.id, probe), false, "the resumed session stays claimed");
  assert.equal(owner.acquireSessionOwnership(first, probe), true, "the session left behind was released");
  owner.releaseSessionOwnership(first, probe);
}

// Provenance of the AGENT id, the other half of this subject: core assigns it. A spawned subagent gets
// exactly the id core handed over (its `spawnSubagent` argument), never a minted one — that internal
// channel exists because `ManagedAgentConfig` deliberately has no `id` for a host to set
// (`core-minted agent ids`). Dropping the forward would mint an id over the spawned one, silently.
{
  const spawnedId = "subagent_probe_identity";
  const spawned = await managed.manager.spawnSubagent(managed.id, { name: "id-provenance" }, spawnedId);
  assert.equal(spawned.id, spawnedId, "a spawned subagent keeps the id core assigned");
  assert.equal(managed.manager.getAgent(spawnedId), spawned, "…and is registered under it, so nothing minted over it");
  await managed.manager.destroyAgent(spawnedId);
}

// The resume must also ROUTE the log, not just the state: `session:restore` is the entry that says
// which session was adopted, so it belongs in the restored session's own file. Regression — it was
// emitted inside `restoreManagedSession`, which ran BEFORE `bindSessionLogSink` re-pointed the sink;
// the entry therefore landed in the transient bootstrap id's directory and the resumed session's
// file received only what came later (in the reported case, a single exit line).
await wait(450); // default log flush interval is 250ms
assert.ok(
  (await readLog(target.id)).includes("Session restored"),
  "resume routes `session:restore` into the restored session's log"
);
assert.ok(
  !(await readLog(first)).includes("Session restored"),
  "the transient bootstrap session's log does not receive the resume entry"
);

// …and the DEPARTURE, which the arrival alone cannot express. A session that is resumed FROM is
// left behind by a process that is still running, so its log otherwise just stops: the reported
// case was a log ending at `Agent aborted`, with nothing saying another session had been adopted.
// Confirmed against the artifact by disabling the emit — the assertion below fails, and no other
// one does.
assert.ok((await readLog(first)).includes("Session switched: leaving"), "the session being left records the switch");
assert.ok(
  !(await readLog(target.id)).includes("Session switched: leaving"),
  "the adopted session does not receive the departure entry (that would invert the pair)"
);

// ----------------------------------------------------------------------------
// 3. `session.new` swaps it again and broadcasts
// ----------------------------------------------------------------------------

const newSessionReasons = [];
const unsubscribeNew = managed
  .getEventBus()
  ?.on("session:new", (event) => newSessionReasons.push(event.payload.reason), { replay: false });
const newSession = await session.dispatch({ type: "session.new" });
unsubscribeNew?.();
assert.equal(newSession.ok, true, "session.new succeeds");
assert.equal(newSessionReasons.at(-1), "session-new", "session:new carries the real producer reason");
const nextId = newSession.data.sessionId;
assert.notEqual(nextId, target.id, "session.new allocates a new disk session");
assertIdentity(nextId, "session.new");

// A new conversation is a new session: the session it replaces stays intact and resumable.
const leftBehind = await store.load(target.id);
assert.ok((leftBehind?.uiMessages.length ?? 0) > 0, "session.new leaves the session it replaced intact on disk");

// `/new` changes the id the same way a resume does, so the sink must follow here too — a fixed
// `session:restore` alone would have left this path writing into the session it replaced. The
// announcement is the new log's only header: the session is written to disk on first save.
await wait(450);
assert.ok(
  (await readLog(nextId)).includes("Session started (new)"),
  "session.new announces itself in the new session's log"
);
assert.ok(
  (await readLog(nextId)).includes('"reason":"session-new"'),
  "the session:new log entry carries the producer reason"
);
assert.ok(!(await readLog(target.id)).includes("Session started (new)"), "…and not in the session it replaced");

// ----------------------------------------------------------------------------
// 4. A failed restore rolls back the attempted claim and keeps the current one
// ----------------------------------------------------------------------------
// Distinct from a refused claim (another agent owns the target, which fails before any state
// changes): this reaches `restoreSession`'s catch after the new id was acquired, so it is the path
// that used to leave a stale claim behind. The current id is claimed by `startNewDiskSession`.
{
  const owner = managed.manager;
  assert.ok(owner, "the agent exposes the manager that holds the ownership table");
  const current = session.getSnapshot().activeSessionId;
  assert.equal(current, nextId, "the failed restore starts from the current session");

  const missing = "ses_missing_restore_target";
  await assert.rejects(() => managed.restoreSession(missing), "restoring a missing session fails");
  assert.equal(
    owner.acquireSessionOwnership(current, "probe-agent"),
    false,
    "a failed restore keeps the current session claimed"
  );
  assert.equal(
    owner.acquireSessionOwnership(missing, "probe-agent"),
    true,
    "a failed restore releases the attempted claim"
  );
  owner.releaseSessionOwnership(missing, "probe-agent");
}

// ----------------------------------------------------------------------------
// 5. A refused ownership claim aborts `session.new` before it changes state
// ----------------------------------------------------------------------------
{
  const owner = managed.manager;
  const store = managed.getSessionStore();
  assert.ok(owner && store, "session.new ownership probe has a manager + store");
  const before = session.getSnapshot().activeSessionId;
  const collisionId = "ses_new_ownership_collision";
  const originalCreate = store.create.bind(store);
  const template = originalCreate({ modelStyle: "openai", model: "test-model" });
  store.create = () => ({ ...template, id: collisionId });
  assert.equal(owner.acquireSessionOwnership(collisionId, "probe-agent"), true, "the target is claimed elsewhere");

  try {
    const result = await session.dispatch({ type: "session.new" });
    assert.equal(result.ok, false, "session.new refuses an already-claimed target");
    assert.match(result.error, /already active in another live session/);
    assert.equal(session.getSnapshot().activeSessionId, before, "a refused new session leaves the active id unchanged");
    assert.equal(
      owner.acquireSessionOwnership(before, "probe-agent"),
      false,
      "the current session remains claimed by this agent"
    );
  } finally {
    store.create = originalCreate;
    owner.releaseSessionOwnership(collisionId, "probe-agent");
  }
}

// ----------------------------------------------------------------------------
// 5b. The retired in-place clear command is rejected; new conversations use session.new
// ----------------------------------------------------------------------------
{
  const beforeId = session.getSnapshot().activeSessionId;
  const beforeMessages = session.getSnapshot().messages.length;
  const result = await session.dispatch({ type: "clear" });
  assert.equal(result.ok, false, "the removed clear command is not accepted");
  assert.equal(result.code, "invalid", "the dispatcher rejects the unknown command");
  assert.equal(session.getSnapshot().activeSessionId, beforeId, "the removed clear leaves the active id");
  assert.equal(session.getSnapshot().messages.length, beforeMessages, "the removed clear leaves the transcript");
}

// ----------------------------------------------------------------------------
// 6. Concurrent resumes are serialized by the lifecycle service
// ----------------------------------------------------------------------------
{
  const owner = managed.manager;
  const store = managed.getSessionStore();
  assert.ok(owner && store, "concurrent resume probe has a manager + store");
  const makeTarget = async (name) => {
    const target = store.create({ modelStyle: "openai", model: "test-model" });
    target.name = name;
    target.uiMessages = [{ id: `${name}-message`, role: "user", parts: [{ type: "text", content: name }] }];
    await store.save(target);
    return target;
  };
  const firstTarget = await makeTarget("concurrent-a");
  const secondTarget = await makeTarget("concurrent-b");

  const originalRestore = managed.sessionPersistence.restore.bind(managed.sessionPersistence);
  let releaseRestore;
  const restoreGate = new Promise((resolve) => {
    releaseRestore = resolve;
  });
  let markRestoreStarted;
  const restoreStarted = new Promise((resolve) => {
    markRestoreStarted = resolve;
  });
  let restoreCalls = 0;
  managed.sessionPersistence.restore = async (sessionId) => {
    restoreCalls += 1;
    if (restoreCalls === 1) {
      markRestoreStarted();
      await restoreGate;
    }
    return originalRestore(sessionId);
  };

  try {
    const firstResume = managed.restoreSession(firstTarget.id);
    await restoreStarted;
    const secondResume = managed.restoreSession(secondTarget.id);
    await Promise.resolve();
    assert.equal(restoreCalls, 1, "the second resume waits for the first switch to finish");
    releaseRestore();
    await Promise.all([firstResume, secondResume]);
    assert.equal(restoreCalls, 2, "the queued resume runs after the first completes");
    assert.equal(session.getSnapshot().activeSessionId, secondTarget.id, "the last serialized resume wins");
  } finally {
    managed.sessionPersistence.restore = originalRestore;
  }
}

// ----------------------------------------------------------------------------
// 7. Bootstrap restore has one store load, and session:start follows restore
// ----------------------------------------------------------------------------
{
  const store = managed.getSessionStore();
  assert.ok(store, "restore ordering probe has a store");
  const resumeTarget = store.create({ modelStyle: "openai", model: "test-model" });
  resumeTarget.name = "restore-order";
  resumeTarget.uiMessages = [
    { id: "restore-order-message", role: "user", parts: [{ type: "text", content: "restored context" }] },
  ];
  await store.save(resumeTarget);

  const order = [];
  const extensionFactory = {
    create: () => ({
      id: "restore-order-extension",
      name: "Restore order extension",
      version: "1.0.0",
      description: "records restore/start ordering",
      activate(ctx) {
        ctx.registerInterceptor("session:start", () => {
          order.push("start");
        });
        ctx.events.observe("session:restore", () => {
          order.push("restore");
        });
      },
    }),
  };

  const originalLoad = SessionStore.prototype.load;
  let loadCalls = 0;
  SessionStore.prototype.load = async function (sessionId) {
    loadCalls += 1;
    return originalLoad.call(this, sessionId);
  };
  try {
    const created = await host.create({
      name: "restore-order",
      model: "test-model",
      resumeSessionId: resumeTarget.id,
      extensions: [extensionFactory],
      builtins: { lsp: false, skills: false, memory: false, mcp: false, codeMode: false },
    });
    assert.equal(loadCalls, 1, "a resumed host create loads the session exactly once");
    assert.deepEqual(order, ["restore", "start"], "session:start runs after the restore");
    await host.destroy(created.session.id);
  } finally {
    SessionStore.prototype.load = originalLoad;
  }
}

// ============================================================================
// Teardown
// ============================================================================
// The session/agent persistence (SessionStore journal, AgentLog JSONL sink) writes
// `.agents/**` files as fire-and-forget async operations. Those writes can still be
// landing when we delete the temp root, which makes `rm` throw ENOTEMPTY on a busy
// directory. This is a teardown race, not a validation failure, so wait a beat for
// the in-flight writes to drain and retry the removal before giving up.

async function removeRoot(root, attempts = 10) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await fs.promises.rm(root, TEMP_RM_OPTIONS);
      return;
    } catch (error) {
      // ENOTEMPTY means the directory is still being written to; retry after a
      // short drain window so in-flight async persistence can finish. Any other
      // error is unexpected and should surface.
      if (error?.code !== "ENOTEMPTY" || attempt === attempts) throw error;
      await wait(50 * attempt);
    }
  }
}

await removeRoot(rootPath);
console.log("session-identity validation passed");

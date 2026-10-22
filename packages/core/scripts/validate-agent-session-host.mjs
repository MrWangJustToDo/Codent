/**
 * Smoke-test Local AgentSessionHost: create → list → connect child → destroy.
 *
 * Run: pnpm --filter @codent/core run validate:agent-session-host
 */
import assert from "node:assert/strict";

import {
  AgentManager,
  AgentStreamHub,
  TodoManager,
  UsageTracker,
  createLocalAgentSessionHost,
  registerCoreEnv,
} from "../dist/dev.mjs";

registerCoreEnv({
  rootPath: "/tmp",
  fs: { exists: async () => false },
  path: {
    join: (...parts) => parts.join("/"),
    resolve: (...parts) => parts.join("/"),
    dirname: (p) => p.slice(0, p.lastIndexOf("/")) || "/",
    basename: (p, ext) => {
      const base = p.split("/").pop() ?? p;
      return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
    },
    extname: (p) => p.slice(p.lastIndexOf(".")),
    isAbsolute: (p) => p.startsWith("/"),
    normalize: (p) => p,
  },
  runCommand: async () => ({}),
  exec: async () => ({}),
  fetch: async () => new Response(""),
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({}),
  homedir: async () => "/tmp",
});

function createFake(id, parentId) {
  const usage = new UsageTracker();
  const todoManager = new TodoManager();
  /** @type {any} */
  let sessionData = null;
  /** @type {any} */
  const managed = {
    id,
    name: id,
    parentId,
    status: "idle",
    getStatus: () => managed.status,
    error: "",
    pendingApprovalCount: 0,
    lastStreamDurationMs: 0,
    getRetry: () => null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    childIds: [],
    usage,
    log: null,
    getTodoManager: () => todoManager,
    streamHub: new AgentStreamHub(),
    getExtensionRunner: () => null,
    readInteractions: () => ({ approvals: [], askUser: [] }),
    readIteration: () => ({ current: 0, max: 0 }),
    readJobs: () => ({ jobs: [] }),
    planMode: {
      on: () => () => {},
      getState: () => ({
        phase: "off",
        planMarkdown: null,
        steps: [],
        enabledAt: null,
        todosSeeded: false,
        preservedExistingTodos: false,
        planFilePath: null,
      }),
    },
    autoModeEnabled: false,
    manager: null,
    getUI: () => undefined,
    chatController: {
      getMessages: () => [],
      getQueuedMessages: () => ({ steer: [], followUp: [] }),
      stop: () => {
        managed.status = "aborted";
      },
      clearMessages: () => {},
      on: () => () => {},
    },
    getError() {
      return managed.error;
    },
    getPendingApprovalCount() {
      return managed.pendingApprovalCount;
    },
    getLastStreamDurationMs() {
      return managed.lastStreamDurationMs;
    },
    getAgentMode() {
      return "normal";
    },
    getMcpManager() {
      return null;
    },
    getExtensionCommands() {
      return [];
    },
    on() {
      return () => {};
    },
    getChatController() {
      return managed.chatController;
    },
    initChat() {
      return managed.chatController;
    },
    // The real `ensureSessionData()` mints the agent's disk session id (and is always called by
    // `host.create`), so the double must too — otherwise `activeSessionId` would be absent from
    // every snapshot/list entry, which is a state production never actually reaches.
    ensureSessionData() {
      if (!sessionData) sessionData = { id: `ses_${id}`, messages: [] };
      return sessionData;
    },
    getSessionData() {
      return sessionData;
    },
    getLog() {
      return null;
    },
    syncInteractionStateFromUIMessages() {},
    resetSessionSyncTracker() {},
    getPlanModeState() {
      return managed.planMode.getState();
    },
    isAutoModeEnabled() {
      return false;
    },
    abort() {
      managed.status = "aborted";
    },
  };
  return managed;
}

/** @type {Map<string, any>} */
const agents = new Map();
let seq = 0;
/** @type {any} */
let lastCreateConfig;

const manager = {
  async createManagedAgent(config) {
    lastCreateConfig = config;
    seq += 1;
    const id = `agent_${seq}`;
    const managed = createFake(id);
    managed.name = config.name;
    agents.set(id, managed);
    return managed;
  },
  getAgent(id) {
    return agents.get(id);
  },
  getAgents() {
    return [...agents.values()];
  },
  getSubagents(parentId) {
    return [...agents.values()].filter((a) => a.parentId === parentId);
  },
  destroyAgent(id) {
    const managed = agents.get(id);
    if (!managed) return;
    for (const child of [...agents.values()].filter((a) => a.parentId === id)) {
      agents.delete(child.id);
    }
    agents.delete(id);
  },
};

const host = createLocalAgentSessionHost({ manager });

// --- in-memory session store -------------------------------------------------
//
// `SessionStore` addresses every log by a fixed RELATIVE path (`.agents/sessions/<id>.session.jsonl`)
// and uses only `exists` / `mkdir` / `readdir` / `remove` / `readFile` / `stat` / `delete` (the last
// through the `fs` object it was handed). Its reads go through `readLastState`, which prefers the
// `readFileRange` tail window and falls back to a whole-file read — so the fake must serve both,
// not just `readFile`.
const SESSION_DIR = ".agents/sessions";
const SESSION_LOG_SUFFIX = ".session.jsonl";
const SESSION_VERSION = 7;
const SESSION_LOG_MESSAGE = "message";

const sessionFiles = new Map();
const sessionDirs = new Set();

function bytes(text) {
  // `Buffer` rather than `TextEncoder`: the latter is not in this repo's validate-script globals.
  return Buffer.from(text, "utf8");
}

/** Write a session log whose single line carries the state `list()` reads back. */
function writeSessionFile(id, { name, updatedAt } = {}) {
  sessionDirs.add(SESSION_DIR);
  sessionFiles.set(
    `${SESSION_DIR}/${id}${SESSION_LOG_SUFFIX}`,
    JSON.stringify({
      t: SESSION_LOG_MESSAGE,
      message: null,
      state: { id, name, version: SESSION_VERSION, modelStyle: "openai", model: "m", createdAt: 1, updatedAt },
    }) + "\n"
  );
}

registerCoreEnv({
  rootPath: "/tmp",
  path: {
    join: (...parts) => parts.join("/"),
    resolve: (...parts) => parts.join("/"),
    dirname: (p) => p.slice(0, p.lastIndexOf("/")) || "/",
    basename: (p, ext) => {
      const base = p.split("/").pop() ?? p;
      return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
    },
    extname: (p) => p.slice(p.lastIndexOf(".")),
    isAbsolute: (p) => p.startsWith("/"),
    normalize: (p) => p,
  },
  runCommand: async () => ({}),
  exec: async () => ({}),
  fetch: async () => new Response(""),
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({}),
  homedir: async () => "/tmp",
  fs: {
    exists: async (p) => sessionFiles.has(p) || sessionDirs.has(p),
    mkdir: async (p) => {
      sessionDirs.add(p);
    },
    readdir: async (p) =>
      [...sessionFiles.keys()]
        .filter((file) => file.startsWith(`${p}/`))
        .map((file) => ({ name: file.slice(p.length + 1), type: "file" })),
    writeFile: async (p, content) => {
      sessionFiles.set(p, content);
    },
    appendFile: async (p, content) => {
      sessionFiles.set(p, (sessionFiles.get(p) ?? "") + content);
    },
    appendFileSync: (p, content) => {
      sessionFiles.set(p, (sessionFiles.get(p) ?? "") + content);
    },
    rename: async (from, to) => {
      const content = sessionFiles.get(from);
      if (content === undefined) throw new Error(`ENOENT: ${from}`);
      sessionFiles.delete(from);
      sessionFiles.set(to, content);
    },
    remove: async (p) => {
      sessionFiles.delete(p);
    },
    stat: async (p) => {
      const content = sessionFiles.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return { size: bytes(content).length, isDirectory: () => false };
    },
    readFile: async (p, encoding) => {
      const content = sessionFiles.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return encoding === "buffer" ? bytes(content) : content;
    },
    readFileRange: async (p, start, end) => {
      const content = sessionFiles.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return bytes(content).subarray(start, end);
    },
  },
});

const { session } = await host.create({ name: "root", model: "test-model" });
assert.equal(session.getSnapshot().name, "root");
assert.equal((await host.list()).length, 1);
assert.equal((await host.list())[0].agentId, session.id);

// --- create options reach ManagedAgentConfig --------------------------------
//
// In-process extension factories and built-in toggles are part of the Host create
// contract (not only the deprecated ManagedAgent path). The local host must forward
// both without requiring the deprecated manager API.
const extensionFactory = {
  create: () => ({
    id: "create-options-extension",
    name: "Create options extension",
    version: "1.0.0",
    description: "registered through AgentSessionCreateOptions.extensions",
    activate() {},
  }),
};
const builtins = { lsp: false, skills: false, memory: false, mcp: false, codeMode: false };
const withOptions = await host.create({
  name: "with-options",
  model: "test-model",
  extensions: [extensionFactory],
  builtins,
});
assert.equal(lastCreateConfig.extensions?.[0], extensionFactory, "extension factories reach ManagedAgentConfig");
assert.deepEqual(lastCreateConfig.lsp, builtins.lsp, "lsp toggle reaches ManagedAgentConfig");
assert.deepEqual(lastCreateConfig.skills, builtins.skills, "skills toggle reaches ManagedAgentConfig");
assert.deepEqual(lastCreateConfig.memory, builtins.memory, "memory toggle reaches ManagedAgentConfig");
assert.deepEqual(lastCreateConfig.mcp, builtins.mcp, "mcp toggle reaches ManagedAgentConfig");
assert.deepEqual(lastCreateConfig.codeMode, builtins.codeMode, "codeMode toggle reaches ManagedAgentConfig");
await host.destroy(withOptions.session.id);

const child = createFake("agent_child", session.id);
agents.set(child.id, child);
const childSession = host.connect(child.id);
assert.ok(childSession);
assert.equal(childSession.id, "agent_child");
assert.equal((await host.list()).length, 2);

const listed = await host.list();
assert.ok(listed.some((e) => e.agentId === session.id && !e.parentId));
assert.ok(listed.some((e) => e.agentId === child.id && e.parentId === session.id));

await host.destroy(session.id);
assert.equal((await host.list()).length, 0);
assert.equal(host.connect(session.id), null);
assert.equal(host.connect(child.id), null);

// --- persisted-session catalog (optional members) ---------------------------
//
// `listPersistedSessions` / `deleteSession` are optional on the host interface (a host bound to a plane
// with no local store cannot serve them). When present they must answer about the DISK catalog,
// which `list()` deliberately does not: a session from an earlier process has no live agent and
// is still resumable.
assert.equal(typeof host.listPersistedSessions, "function");
assert.equal(typeof host.deleteSession, "function");

// A session that exists only as a file is listed...
writeSessionFile("ses_ondisk", { name: "On disk", updatedAt: 500 });
const persisted = await host.listPersistedSessions();
assert.ok(
  persisted.some((meta) => meta.id === "ses_ondisk"),
  "listPersistedSessions must include a session that has no live agent"
);
assert.equal((await host.list()).length, 0, "list() still reports only live agents");

// ...and deleting it does not require opening it.
assert.equal(await host.deleteSession("ses_ondisk"), true);
assert.ok(!(await host.listPersistedSessions()).some((meta) => meta.id === "ses_ondisk"));
assert.equal(await host.deleteSession("ses_ondisk"), false, "a second delete reports absence");

// The case a naive store-delegation gets wrong: a session that is LIVE but has no file yet
// (created, never persisted). Deleting it must succeed — the caller is holding it right now.
const fresh = await host.create({ name: "fresh", model: "test-model" });
const freshId = fresh.session.getSnapshot().activeSessionId;
assert.ok(freshId, "a root session always has a disk session id");
assert.equal(await host.deleteSession(freshId), true, "deleteSession succeeds for a live, file-less session");
assert.equal(await host.deleteSession(freshId), false, "and reports absence the second time");

// The case a `destroy()`-only implementation gets wrong: LIVE *and already persisted*. `destroy()`
// settles the log flush, but it only releases a still-empty session's startup reservation — it
// does not remove the log. Without an explicit store delete on this branch, the session would
// survive `deleteSession` and keep appearing in `listPersistedSessions`.
const persistedLive = await host.create({ name: "persisted", model: "test-model" });
const persistedId = persistedLive.session.getSnapshot().activeSessionId;
writeSessionFile(persistedId, { name: "persisted", updatedAt: 900 });
assert.ok(
  (await host.listPersistedSessions()).some((meta) => meta.id === persistedId),
  "the live session's own log is in the disk catalog"
);
assert.equal(await host.deleteSession(persistedId), true, "deleteSession succeeds for a live, persisted session");
assert.ok(
  !(await host.listPersistedSessions()).some((meta) => meta.id === persistedId),
  "deleting a live session removes its log rather than only releasing the live agent"
);

// ----------------------------------------------------------------------------
// Real binding: run the same create/list/connect/destroy through an AgentManager
// and the real LocalHost, not the structural fake above.
// ----------------------------------------------------------------------------
{
  const realManager = new AgentManager();
  const realHost = createLocalAgentSessionHost({ manager: realManager });
  const created = await realHost.create({
    name: "real-host",
    model: "test-model",
    builtins: { lsp: false, skills: false, memory: false, mcp: false, codeMode: false },
  });
  const realId = created.session.getSnapshot().agentId;
  assert.ok(realManager.getAgent(realId), "real host create registers a real ManagedAgent");
  assert.equal((await realHost.list()).length, 1, "real host lists the live agent");
  assert.equal(realHost.connect(realId)?.id, realId, "real host connects the live session");
  await realHost.destroy(realId);
  assert.equal((await realHost.list()).length, 0, "real host destroy removes the agent");

  // A failure after createManagedAgent (invalid resume target) must roll back the
  // registered agent, its ownership claim and its log sink.
  await assert.rejects(
    () =>
      realHost.create({
        name: "real-host-invalid-resume",
        model: "test-model",
        resumeSessionId: "ses_missing_resume_target",
        builtins: { lsp: false, skills: false, memory: false, mcp: false, codeMode: false },
      }),
    /Session not found/,
    "an invalid resume target rejects host.create"
  );
  assert.equal((await realHost.list()).length, 0, "a failed host.create leaves no live agent");
  assert.equal(realManager.getAgents().length, 0, "a failed host.create leaves no registered agent");
  assert.equal(
    realManager.acquireSessionOwnership("ses_missing_resume_target", "probe-agent"),
    true,
    "a failed host.create releases the target claim"
  );
  realManager.releaseSessionOwnership("ses_missing_resume_target", "probe-agent");

  await realManager.dispose();
}

console.log("agent-session-host validation passed");

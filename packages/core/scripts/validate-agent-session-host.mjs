/**
 * Smoke-test Local AgentSessionHost: create → list → connect child → destroy.
 *
 * Run: pnpm --filter @codent/core run validate:agent-session-host
 */
import assert from "node:assert/strict";

import {
  SummaryStreamHub,
  TodoManager,
  UsageTracker,
  createLocalAgentSessionHost,
  registerCoreEnv,
} from "../dist/dev.mjs";

registerCoreEnv({
  rootPath: "/tmp",
  fs: { exists: async () => false },
  path: {},
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
    summaryStreams: new SummaryStreamHub(),
    getExtensionRunner: () => null,
    readInteractions: () => ({ approvals: [], askUser: [] }),
    readIteration: () => ({ current: 0, max: 0 }),
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
    ensureSessionData() {},
    getSessionData() {
      return null;
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

const manager = {
  async createManagedAgent(config) {
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

const { session } = await host.create({ name: "root", model: "test-model" });
assert.equal(session.getSnapshot().name, "root");
assert.equal(host.list().length, 1);
assert.equal(host.list()[0].agentId, session.id);

const child = createFake("agent_child", session.id);
agents.set(child.id, child);
const childSession = host.connect(child.id);
assert.ok(childSession);
assert.equal(childSession.id, "agent_child");
assert.equal(host.list().length, 2);

const listed = host.list();
assert.ok(listed.some((e) => e.agentId === session.id && !e.parentId));
assert.ok(listed.some((e) => e.agentId === child.id && e.parentId === session.id));

await host.destroy(session.id);
assert.equal(host.list().length, 0);
assert.equal(host.connect(session.id), null);
assert.equal(host.connect(child.id), null);

console.log("agent-session-host validation passed");

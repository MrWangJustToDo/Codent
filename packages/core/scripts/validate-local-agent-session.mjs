/**
 * Smoke-test LocalAgentSession snapshot / dispatch / subscribe / child session.
 *
 * Run: pnpm --filter @codent/core run validate:local-agent-session
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AgentUIChannel,
  BUILTIN_SKILLS,
  SummaryStreamHub,
  TodoManager,
  UsageTracker,
  createAgentEventBus,
  createLocalAgentSession,
  registerCoreEnv,
  sessionForSubagent,
} from "../dist/dev.mjs";
import { AgentManager } from "../dist/index.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

function createFake(id, parentId) {
  const usage = new UsageTracker();
  const todoManager = new TodoManager();
  const bus = createAgentEventBus(id);
  usage.setEventBus(bus);
  todoManager.setEventBus(bus);
  /** @type {any} */
  const managed = {
    id,
    name: id,
    parentId,
    getEventBus: () => bus,
    // ManagedAgent reads are method-form (see validate-accessor-convention.mjs); the
    // fake keeps plain fields and exposes them through the same accessors.
    status: "idle",
    getStatus: () => managed.status,
    error: "",
    pendingApprovalCount: 0,
    lastStreamDurationMs: 0,
    getRetry: () => null,
    childIds: [],
    usage,
    log: null,
    getTodoManager: () => todoManager,
    summaryStreams: new SummaryStreamHub(),
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
      sendMessage: async () => {},
      steer: () => {},
      followUp: () => {},
      stop: () => {
        managed.status = "aborted";
      },
      clearMessages: () => {
        managed.cleared = true;
      },
      respondToToolApproval: async () => {},
      addToolResult: async () => {},
      on: (_type, listener) => {
        listener({ steer: [], followUp: [] });
        return () => {};
      },
    },
    setDisplayName(name) {
      managed.name = name;
    },
    getL1State() {
      return {
        status: managed.status,
        name: managed.name,
        error: managed.error,
        pendingApprovalCount: managed.pendingApprovalCount,
      };
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
      return managed.autoModeEnabled ? "auto" : "normal";
    },
    getMcpManager() {
      return null;
    },
    getExtensionCommands() {
      return [];
    },
    on(type, listener) {
      if (type === "change") {
        listener(managed.getL1State());
      }
      return () => {};
    },
    getChatController() {
      return managed.chatController;
    },
    getPlanModeState() {
      return managed.planMode.getState();
    },
    isAutoModeEnabled() {
      return managed.autoModeEnabled;
    },
    setAutoModeEnabled(enabled) {
      managed.autoModeEnabled = enabled;
    },
    setClientToolWaiting() {},
    enablePlanMode() {},
    disablePlanMode() {},
    togglePlanMode() {
      return "planning";
    },
    beginPlanExecution() {
      return { ok: true };
    },
    cancelPlanExecution() {
      return true;
    },
    completePlan() {
      return { ok: true };
    },
    async savePlanToWorkspace(nameHint) {
      return { ok: true, path: `.agents/plans/${nameHint || "plan"}.md` };
    },
    async loadPlanFromWorkspace(name) {
      return { ok: true, path: `.agents/plans/${name}.md`, stepCount: 2 };
    },
    async listWorkspacePlans() {
      return ["alpha.md", "beta.md"];
    },
    async compact(opts) {
      managed.compactFocus = opts?.focus;
      return { ok: true, message: "Compacted: 10 → 5 tokens (50% reduction)", tokensBefore: 10, tokensAfter: 5 };
    },
    getSessionData() {
      return null;
    },
    getSessionStore() {
      return null;
    },
    toggleAutoMode() {
      managed.autoModeEnabled = !managed.autoModeEnabled;
      return managed.autoModeEnabled;
    },
    abort() {
      managed.status = "aborted";
    },
    async restoreSession() {
      return { id: "s1" };
    },
  };
  return managed;
}

const managed = createFake("agent_root");
const session = createLocalAgentSession({ managed, manager: null });
assert.equal(session.id, "agent_root");

const snap = session.getSnapshot();
assert.equal(snap.agentId, "agent_root");
assert.equal(snap.name, "agent_root");
assert.equal(snap.status, "idle");
assert.equal(snap.mode, "normal");
assert.equal(snap.lastStreamDurationMs, 0);
assert.deepEqual(snap.messages, []);
assert.ok(Array.isArray(snap.todos));
assert.equal(snap.plan.phase, "off");
assert.deepEqual(snap.mcp, { servers: [] });
assert.deepEqual(snap.extensions, { extensions: [] });
assert.deepEqual(snap.subagents, []);

const stopResult = await session.dispatch({ type: "stop" });
assert.equal(stopResult.ok, true);
assert.equal(managed.status, "aborted");
managed.status = "idle";

const rename = await session.dispatch({ type: "rename", name: "renamed" });
assert.equal(rename.ok, true);
assert.equal(managed.name, "renamed");
assert.equal(session.getSnapshot().name, "renamed");

const compact = await session.dispatch({ type: "compact", focus: "errors" });
assert.equal(compact.ok, true);
assert.equal(managed.compactFocus, "errors");
assert.match(String(compact.data?.message ?? ""), /Compacted/);

const planList = await session.dispatch({ type: "plan.list" });
assert.equal(planList.ok, true);
assert.deepEqual(planList.data?.files, ["alpha.md", "beta.md"]);

const planSave = await session.dispatch({ type: "plan.save", nameHint: "demo" });
assert.equal(planSave.ok, true);
assert.equal(planSave.data?.path, ".agents/plans/demo.md");

const planComplete = await session.dispatch({ type: "plan.complete" });
assert.equal(planComplete.ok, true);

const mcpRefresh = await session.dispatch({ type: "mcp.refresh" });
assert.equal(mcpRefresh.ok, true);
assert.deepEqual(mcpRefresh.data?.servers, []);

/** @type {string[]} */
const channels = [];
const unsub = session.subscribe((event) => {
  channels.push(event.channel);
});
managed.usage.updateWindowUsage({ inputTokens: 3, outputTokens: 1, totalTokens: 4 });
managed.getTodoManager().update([{ content: "x", status: "pending", priority: "medium" }], "work");
assert.ok(channels.includes("usage"));
assert.ok(channels.includes("todos"));
unsub();

const child = createFake("agent_child", "agent_root");
const childSession = createLocalAgentSession({ managed: child, manager: null });
const sendDenied = await childSession.dispatch({ type: "send", content: "nope" });
assert.equal(sendDenied.ok, false);
assert.equal(sendDenied.code, "unsupported");
const childStop = await childSession.dispatch({ type: "stop" });
assert.equal(childStop.ok, true);
const childClear = await childSession.dispatch({ type: "clear" });
assert.equal(childClear.ok, true);
assert.equal(child.cleared, true);
const childCompactDenied = await childSession.dispatch({ type: "compact" });
assert.equal(childCompactDenied.ok, false);
assert.equal(childCompactDenied.code, "unsupported");

const manager = {
  getAgent: (id) => (id === child.id ? child : undefined),
  getSubagents: () => [child],
  on: () => () => {},
};
const opened = sessionForSubagent(manager, child.id);
assert.ok(opened);
assert.equal(opened.id, child.id);

const rootWithChildren = createLocalAgentSession({ managed, manager });
const withSubs = rootWithChildren.getSnapshot();
assert.equal(withSubs.subagents.length, 1);
assert.equal(withSubs.subagents[0].id, "agent_child");
assert.ok(withSubs.subagents[0].usage);

// ----------------------------------------------------------------------------
// Subagent preview channel → child session `messages` projection (regression).
// `ManagedAgent.setUIChannel` must wire the channel's scoped bus. Without it a
// subagent preview channel (created via `ensureUIChannel`, NOT through the chat
// controller) never emits `session:messages`, so the child session's `messages`
// channel stays frozen while the main session updates fine.
// ----------------------------------------------------------------------------
{
  const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "local-session-messages-"));
  const toAbs = (p) => (path.isAbsolute(p) ? p : path.join(rootPath, p));
  registerCoreEnv({
    rootPath,
    getPlatform: async () => "linux",
    getArch: async () => "arm64",
    getEnv: async () => ({}),
    homedir: async () => rootPath,
    fs: {
      readFile: async (p, encoding) => fs.promises.readFile(toAbs(p), encoding),
      writeFile: async (p, content) => fs.promises.writeFile(toAbs(p), content),
      appendFile: async (p, content) => fs.promises.appendFile(toAbs(p), content, "utf8"),
      // Atomic log replace (`SessionStore.writeLog` writes a temp file and renames it).
      // Without `rename` the store falls back to an in-place `writeFile`, which truncates
      // the log first — a concurrent `load()` can then read an empty file and return `null`.
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

  const e2eManager = new AgentManager();
  const parent = await e2eManager.createManagedAgent({ name: "root-messages", model: "test-model" });
  const sub = await e2eManager.spawnSubagent(parent.id, { name: "sub-messages" });
  const subManaged = e2eManager.getAgent(sub.id);
  assert.ok(subManaged, "subagent managed agent exists");

  const userMsg = {
    id: "m_user",
    role: "user",
    parts: [{ type: "text", content: "explore" }],
    createdAt: new Date(),
  };
  const channel = new AgentUIChannel({ initialMessages: [userMsg] });
  subManaged.setUIChannel(channel); // ← the fix under test (ensureUIChannel path)

  const childSession = createLocalAgentSession({ managed: subManaged, manager: e2eManager });
  /** @type {unknown[]} */
  const messageEvents = [];
  const unsubMessages = childSession.subscribe(
    (event) => {
      if (event.channel === "messages") messageEvents.push(event.payload);
    },
    { channels: ["messages"] }
  );

  // `setUIChannel` wired the bus → the retained `session:messages` replay
  // delivers the initial snapshot to a late subscriber (panel open case).
  assert.ok(messageEvents.length >= 1, "initial messages snapshot replayed on subscribe");

  const assistantMsg = {
    id: "m_asst",
    role: "assistant",
    parts: [{ type: "text", content: "found it" }],
    createdAt: new Date(),
  };
  channel.setMessages([userMsg, assistantMsg]); // StreamProcessor onMessagesChange → session:messages
  assert.ok(
    messageEvents.some((payload) => JSON.stringify(payload).includes("found it")),
    "subagent channel messages reach the child session messages channel"
  );
  unsubMessages();

  e2eManager.destroyAgent(sub.id);
  e2eManager.destroyAgent(parent.id);
  await fs.promises.rm(rootPath, TEMP_RM_OPTIONS);
}

// ----------------------------------------------------------------------------
// End-to-end: a real AgentManager bootstrap registers the built-in skills.
//
// The builtin-skills validator covers the registry and the extension in isolation;
// this is the seam it cannot reach — whether `buildManagedAgent` actually calls
// `registerAll(BUILTIN_SKILLS)`, and whether a same-named workspace skill still
// wins over it. A build that ships the content but never wires it would pass every
// other check and be useless to a user.
// ----------------------------------------------------------------------------
{
  const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "builtin-skills-bootstrap-"));
  const toAbs = (p) => (path.isAbsolute(p) ? p : path.join(rootPath, p));

  const shadowName = BUILTIN_SKILLS[0].name;
  const workspaceSkillDir = path.join(rootPath, ".agents", "skills", shadowName);

  registerCoreEnv({
    rootPath,
    getPlatform: async () => "linux",
    getArch: async () => "arm64",
    getEnv: async () => ({}),
    // Deliberately NOT rootPath: `getDefaultSkillDirs()` also loads
    // `~/.agents/skills`, so pointing home at the workspace would make the
    // `user` and `project` directories the same path and mask which one won.
    homedir: async () => path.join(rootPath, "home"),
    fs: {
      // Default the encoding: skill loading reads SKILL.md as text, and a Buffer
      // return would make frontmatter parsing throw (and be swallowed to "no skills").
      readFile: async (p, encoding) => fs.promises.readFile(toAbs(p), encoding ?? "utf8"),
      writeFile: async (p, content) => fs.promises.writeFile(toAbs(p), content),
      appendFile: async (p, content) => fs.promises.appendFile(toAbs(p), content, "utf8"),
      // Atomic log replace (`SessionStore.writeLog` writes a temp file and renames it).
      // Without `rename` the store falls back to an in-place `writeFile`, which truncates
      // the log first — a concurrent `load()` can then read an empty file and return `null`.
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

  const expectedNames = BUILTIN_SKILLS.map((s) => s.name).sort();

  // --- 1. Clean workspace: built-ins must be registered by the bootstrap ---
  const builtinManager = new AgentManager();
  const withBuiltins = await builtinManager.createManagedAgent({ name: "builtin-on", model: "test-model" });
  const registry = withBuiltins.getSkillRegistry();
  assert.ok(registry, "root agent has a skill registry");

  assert.deepEqual(registry.builtinNames().sort(), expectedNames, "bootstrap registers every built-in skill");
  for (const builtin of BUILTIN_SKILLS) {
    assert.equal(registry.get(builtin.name)?.source, "builtin", `"${builtin.name}" is builtin-sourced`);
    assert.ok(registry.get(builtin.name).body.length > 0, `"${builtin.name}" body survived registration`);
  }

  // --- 2. A workspace skill of the same name must shadow the built-in ---
  await fs.promises.mkdir(workspaceSkillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(workspaceSkillDir, "SKILL.md"),
    `---\nname: ${shadowName}\ndescription: workspace override\n---\n\nWORKSPACE BODY WINS\n`
  );

  const shadowManager = new AgentManager();
  const withShadow = await shadowManager.createManagedAgent({ name: "builtin-shadowed", model: "test-model" });
  const shadowRegistry = withShadow.getSkillRegistry();
  const shadowed = shadowRegistry.get(shadowName);

  assert.ok(shadowed, `"${shadowName}" resolves`);
  assert.equal(shadowed.source, "project", "the workspace skill is the one that survived");
  assert.ok(shadowed.body.includes("WORKSPACE BODY WINS"), "workspace body wins over the built-in body");
  assert.ok(!shadowed.body.includes("Writing a codent extension"), "built-in body must not leak through");
  assert.ok(!shadowRegistry.builtinNames().includes(shadowName), "shadowed built-in is gone from builtinNames()");

  // --- 3. The switch drops built-ins without breaking the agent ---
  const offManager = new AgentManager();
  const withoutBuiltins = await offManager.createManagedAgent({
    name: "builtin-off",
    model: "test-model",
    skills: { builtinsDisabled: true },
  });
  const offRegistry = withoutBuiltins.getSkillRegistry();
  assert.ok(offRegistry, "skill registry exists with built-ins disabled");
  assert.equal(offRegistry.builtinNames().length, 0, "no builtin-sourced skills when disabled");
  for (const builtin of BUILTIN_SKILLS) {
    assert.notEqual(offRegistry.get(builtin.name)?.source, "builtin", `"${builtin.name}" is not builtin-sourced`);
  }
  assert.ok(offRegistry.has(shadowName), "workspace skills survive the switch");

  builtinManager.destroyAgent(withBuiltins.id);
  shadowManager.destroyAgent(withShadow.id);
  offManager.destroyAgent(withoutBuiltins.id);
  await fs.promises.rm(rootPath, TEMP_RM_OPTIONS);
}

console.log("local-agent-session validation passed");

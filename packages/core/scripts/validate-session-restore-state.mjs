/**
 * Validates that resuming a session from its `.session.jsonl` log restores the
 * full session state — not just the model:
 *
 * - model / modelStyle / reasoningEffort / autoMode / planMode / todos (+ title,
 *   plan bound) / name / version all come back;
 * - the usage tracker is rewired from the persisted cumulative snapshot: the
 *   window fill and cost are restored EXACTLY and the restored `contextTokens`
 *   is not re-accumulated into the lifetime total (it is already included in the
 *   persisted total, so `updateWindowUsage` used to count it twice);
 * - a state-only save (no new message) re-emits the last message line, and the
 *   new state survives a later resume;
 * - a mode switch persists on its own (no turn needed) once the session is on disk:
 *   `mode.set auto` and `mode.set plan` reach disk and come back on resume. A session
 *   with no content is never written, so this block saves one first;
 * - approvals are derived from the folded messages, keeping the recorded
 *   decision time (`approvalAt`).
 *
 * Run: pnpm --filter @codent/core run validate:session-restore-state
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionService, SessionStore, TodoManager, UsageTracker } from "../dist/dev.mjs";
import { AgentManager, createLocalAgentSessionHost, registerCoreEnv } from "../dist/index.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

// ============================================================================
// Mock CoreEnv (real fs under a temp root)
// ============================================================================

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "session-restore-state-"));
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

const SESSIONS = ".agents/sessions";
const logPath = (id) => `${SESSIONS}/${id}.session.jsonl`;
const readLines = async (id) =>
  (await fs.promises.readFile(toAbs(logPath(id)), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const lastState = async (id) => (await readLines(id)).at(-1).state;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the log's newest state satisfies `check` (persists are fire-and-forget). */
const waitForState = async (id, check, label) => {
  for (let i = 0; i < 50; i++) {
    // Read + parse defensively: the log is appended in the background, so a poll can
    // observe a partially flushed line (or none yet) and must simply retry.
    const state = await fs.promises
      .readFile(toAbs(logPath(id)), "utf8")
      .then((raw) => {
        const tail = raw.trim().split("\n").at(-1);
        return tail ? JSON.parse(tail).state : null;
      })
      .catch(() => null);
    if (state && check(state)) return state;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const userMessage = (id, text) => ({ id, role: "user", parts: [{ type: "text", content: text }], createdAt: 1 });
const assistantAskUser = (id) => ({
  id,
  role: "assistant",
  parts: [
    { type: "text", content: "need input" },
    {
      type: "tool-call",
      id: "call_ask",
      name: "ask_user",
      arguments: '{"question":"which?","options":["a","b"]}',
      state: "input-complete",
    },
  ],
  createdAt: 2,
});
const assistantWithApproval = (id) => ({
  id,
  role: "assistant",
  parts: [
    { type: "text", content: "running" },
    {
      type: "tool-call",
      id: "call_1",
      name: "run_command",
      arguments: '{"command":"ls"}',
      state: "approval-responded",
      approval: { id: "approval_call_1", needsApproval: true, approved: false, reason: "nope" },
    },
  ],
  createdAt: 2,
});

// ============================================================================
// 1. Persist a rich session, then restore it from a cache-cold service
// ============================================================================

const planSnapshot = {
  phase: "executing",
  planMarkdown: "## Plan\n1. step",
  steps: [{ text: "step", status: "pending" }],
  planFilePath: null,
  seeded: false,
};

let sessionId;
{
  const store = new SessionStore();
  const service = new SessionService();
  service.setStore(store, { modelStyle: "openai", model: "default-model" });
  const session = store.create({ modelStyle: "openai", model: "default-model", name: "resume-state" });
  sessionId = session.id;
  service.setSessionData(session);

  // A `/models` switch must reach disk (setModelConfig mirrors onto the record).
  service.setModelConfig("anthropic", "switched-model");

  const usage = new UsageTracker();
  usage.addTotal({ inputTokens: 1000, outputTokens: 200, totalTokens: 1200 });
  usage.setTotalCostUsd(0.42);
  usage.updateWindowUsage({ inputTokens: 7777, outputTokens: 0, totalTokens: 7777 });

  const todos = new TodoManager();
  todos.restoreTodos([{ content: "one", status: "in_progress", priority: "high" }], {
    title: "My plan todos",
    planBound: true,
  });

  await service.persistSession({
    usage,
    todoManager: todos,
    planMode: planSnapshot,
    autoMode: true,
    reasoningEffort: "high",
    uiMessages: [userMessage("u1", "hello"), assistantWithApproval("a1")],
  });
}

{
  const entries = await fs.promises.readdir(toAbs(SESSIONS));
  assert.deepEqual(entries, [`${sessionId}.session.jsonl`], "exactly one log file per session");
  const lines = await readLines(sessionId);
  assert.equal(lines.length, 2, "one line per message");
  assert.ok(
    !(await fs.promises.readFile(toAbs(logPath(sessionId)), "utf8")).includes('"approvals"'),
    "no standalone approvals table on disk"
  );
}

{
  const store = new SessionStore();
  const service = new SessionService();
  // Ambient config deliberately unrelated: the restored record must win.
  service.setStore(store, { modelStyle: "openai", model: "unrelated-model" });

  const usage = new UsageTracker();
  const todos = new TodoManager();
  // Read, then commit: the restored counters/todos and `SessionData` are adopted by the second
  // step, after everything that can fail.
  const restored = await service.readSessionForRestore(sessionId);
  service.adoptRestoredSession(restored, { usage, todoManager: todos });
  const session = { ...restored.session, uiMessages: restored.uiMessages };
  const disk = await lastState(sessionId);

  assert.equal(session.model, "switched-model", "model restored");
  assert.equal(session.modelStyle, "anthropic", "modelStyle restored");
  assert.equal(session.reasoningEffort, "high", "reasoningEffort restored");
  assert.equal(session.autoMode, true, "autoMode restored");
  assert.deepEqual(session.planMode, planSnapshot, "planMode restored");
  assert.equal(session.todoTitle, "My plan todos", "todoTitle restored");
  assert.equal(session.todoPlanBound, true, "todoPlanBound restored");
  assert.equal(session.name, "resume-state", "name restored");
  assert.equal(session.version, 7, "version 7");
  assert.deepEqual(
    session.todos.map((t) => ({ content: t.content, status: t.status, priority: t.priority })),
    [{ content: "one", status: "in_progress", priority: "high" }],
    "todos restored"
  );
  assert.deepEqual(
    session.uiMessages.map((m) => m.id),
    ["u1", "a1"],
    "messages restored in order"
  );
  assert.ok(session.approvalTimes?.["approval_call_1"] > 0, "approval decision time derived from the log");
  assert.equal(
    session.uiMessages[1].parts.find((p) => p.type === "tool-call").approval.updatedAt,
    session.approvalTimes["approval_call_1"],
    "decision time carried on the tool-call part"
  );
  assert.ok(session.uiMessages[1].updatedAt > 0, "restored messages carry their write time");

  // Todos are pushed into the live manager as well.
  assert.equal(todos.getItems().length, 1, "todos pushed into TodoManager");
  assert.equal(todos.getTitle(), "My plan todos", "todo title pushed into TodoManager");
  assert.equal(todos.isPlanBound(), true, "plan-bound pushed into TodoManager");

  // Usage tracker: window + cost exactly, lifetime total NOT inflated by the
  // restored context fill (it is already part of the persisted total).
  assert.equal(usage.getWindowUsage().inputTokens, disk.contextTokens, "context fill restored exactly");
  assert.equal(usage.getTotalCostUsd(), disk.cost, "cost restored exactly");
  assert.equal(usage.getTotal().totalTokens, disk.usage.totalTokens, "lifetime total restored, not re-accumulated");
}

// ============================================================================
// 2. State-only save re-emits the last line; the new state survives a resume
// ============================================================================

{
  const store = new SessionStore();
  const service = new SessionService();
  service.setStore(store, { modelStyle: "openai", model: "default-model" });
  const session = store.create({ modelStyle: "openai", model: "default-model", name: "state-only" });
  service.setSessionData(session);

  const usage = new UsageTracker();
  const todos = new TodoManager();
  await service.persistSession({ usage, todoManager: todos, uiMessages: [userMessage("u1", "hi")] });
  const before = (await readLines(session.id)).length;

  // Only state changes (autoMode + todos + usage), no new messages.
  todos.restoreTodos([{ content: "later", status: "pending", priority: "low" }], { title: "T2", planBound: false });
  usage.addTotal({ inputTokens: 5, outputTokens: 5, totalTokens: 10 });
  await service.persistSession({ usage, todoManager: todos, autoMode: true });

  const lines = await readLines(session.id);
  assert.equal(lines.length, before + 1, "a state-only change appends exactly one re-emit line");

  const store2 = new SessionStore();
  const service2 = new SessionService();
  service2.setStore(store2, { modelStyle: "openai", model: "default-model" });
  const restRead = await service2.readSessionForRestore(session.id);
  service2.adoptRestoredSession(restRead, { usage: new UsageTracker(), todoManager: null });
  const restored = { ...restRead.session, uiMessages: restRead.uiMessages };
  assert.equal(restored.autoMode, true, "autoMode from a state-only re-emit survives resume");
  assert.equal(restored.todos[0].content, "later", "todos from a state-only re-emit survive resume");
  assert.equal(restored.uiMessages.length, 1, "the re-emit does not duplicate the message");
}

// ============================================================================
// 3. Mode switches persist on their own and come back on resume
// ============================================================================

{
  const manager = new AgentManager();
  const host = createLocalAgentSessionHost({ manager });
  const created = await host.create({ name: "mode-persist", model: "default-model", modelStyle: "openai" });
  const session = created.session;
  const managed = manager.getAgent(session.getSnapshot().agentId);
  const id = managed.getSessionData().id;

  // A session reaches disk only on its first *content* save, so establish one: the file
  // stands in for the transcript a real session would already carry. With the session on
  // disk, the effort/mode switch below must still persist on its own, with no turn.
  const store = managed.getSessionStore();
  await store.save(managed.getSessionData());

  const effort = await session.dispatch({ type: "effort.set", effort: "xhigh" });
  assert.equal(effort.ok, true, "effort.set succeeds");
  const mode = await session.dispatch({ type: "mode.set", mode: "auto" });
  assert.equal(mode.ok, true, "mode.set auto succeeds");

  // No turn runs here: the mode switch itself must have been persisted.
  const autoState = await waitForState(id, (state) => state.autoMode === true, "auto mode on disk");
  assert.equal(autoState.reasoningEffort, "xhigh", "reasoning effort reached disk");

  manager.releaseSessionOwnership(id, managed.id);

  const manager2 = new AgentManager();
  const host2 = createLocalAgentSessionHost({ manager: manager2 });
  const created2 = await host2.create({
    name: "mode-resume",
    model: "default-model",
    modelStyle: "openai",
    resumeSessionId: id,
  });
  const managed2 = manager2.getAgent(created2.session.getSnapshot().agentId);
  assert.equal(managed2.isAutoModeEnabled(), true, "resumed agent adopts auto mode");
  assert.equal(managed2.getReasoningEffort(), "xhigh", "resumed agent adopts reasoning effort");

  // Plan mode is session state too: switching to plan persists, and the resumed
  // agent comes back in plan mode (never auto — they are mutually exclusive).
  const plan = await session.dispatch({ type: "mode.set", mode: "plan" });
  assert.equal(plan.ok, true, "mode.set plan succeeds");
  const planState = await waitForState(
    id,
    (state) => state.planMode && state.planMode.phase !== "off",
    "plan phase on disk"
  );
  assert.equal(planState.autoMode, false, "auto mode is not persisted while plan is active");

  manager.releaseSessionOwnership(id, managed.id);
  const manager3 = new AgentManager();
  const host3 = createLocalAgentSessionHost({ manager: manager3 });
  const created3 = await host3.create({
    name: "plan-resume",
    model: "default-model",
    modelStyle: "openai",
    resumeSessionId: id,
  });
  const managed3 = manager3.getAgent(created3.session.getSnapshot().agentId);
  assert.notEqual(managed3.getPlanModeState().phase, "off", "resumed agent comes back in plan mode");
  assert.equal(managed3.isAutoModeEnabled(), false, "resumed agent is not in auto mode (mutually exclusive)");
}

// ============================================================================
// 3.5 Unloading a PARKED session is not a cancellation, and restore adopts state silently
//
// The switch's `resetTransientState` aborts the previous run. With the status still
// `awaiting_user`, that abort listener rewrote it to `aborted` — a cancellation the user never
// performed, logged against the target. The model/effort adoption has the mirror problem: its
// `model:change` / `mode:change` rows are emitted while the sink already points at the target but
// the envelope still names the departure. `session:restore` is the record for both.
// ============================================================================
{
  const manager = new AgentManager();
  const host = createLocalAgentSessionHost({ manager });
  const created = await host.create({ name: "parked-source", model: "default-model", modelStyle: "openai" });
  const managed = manager.getAgent(created.session.getSnapshot().agentId);
  const id = managed.getSessionData().id;
  const store = managed.getSessionStore();

  const data = managed.getSessionData();
  data.uiMessages = [userMessage("p-u1", "go"), assistantAskUser("p-a1")];
  data.reasoningEffort = "high";
  // A model the catalog does not offer: `applyPersistedModel` falls back to the creation model and
  // emits `model:change{fallback:true}`. With the same model as the runtime this branch never runs,
  // so the "no model:change during restore" assertion used to be vacuously true.
  data.model = "retired-model";
  await store.save(data);
  manager.releaseSessionOwnership(id, managed.id);

  const manager2 = new AgentManager();
  const seen = [];
  manager2.on("agent:status", (event) => seen.push({ kind: "status", ...event.payload }));
  manager2.on("mode:change", (event) => seen.push({ kind: "mode:change", ...event.payload }));
  manager2.on("model:change", (event) => seen.push({ kind: "model:change", ...event.payload }));
  manager2.on("session:restore", (event) => seen.push({ kind: "restore", ...event.payload }));

  const host2 = createLocalAgentSessionHost({ manager: manager2 });
  const created2 = await host2.create({
    name: "parked-resume",
    model: "default-model",
    modelStyle: "openai",
    resumeSessionId: id,
  });
  const managed2 = manager2.getAgent(created2.session.getSnapshot().agentId);

  assert.equal(managed2.getStatus(), "awaiting_user", "a restored question keeps the session parked");
  assert.ok(
    !seen.some((event) => event.kind === "status" && event.to === "aborted"),
    "unloading a parked session must not log a cancellation (status stayed awaiting_user)"
  );
  assert.ok(
    !seen.some((event) => event.kind === "mode:change"),
    "restore adopts effort silently; session:restore is the record"
  );
  assert.ok(
    !seen.some((event) => event.kind === "model:change"),
    "restore adopts the model silently (the target never made that change)"
  );
  // …but the adopted identity is not lost: it rides the restore record instead of a misattributed
  // row. (This host carries no catalog, so `selectModel` trusts the persisted id and there is no
  // fallback to report — the adoption change itself is what the suppression above hides.)
  const restored = seen.find((event) => event.kind === "restore");
  assert.equal(restored?.model, "retired-model", "session:restore carries the adopted model");
  assert.equal(restored?.modelFallback, undefined, "no catalog ⇒ no forced fallback");

  // The behavioural assertion above cannot construct a live run on a fresh manager (so the abort
  // listener has nothing to write); lock the ordering that makes it true.
  const lifecycleSrc = await fs.promises.readFile(
    new URL("../src/agent/session/session-lifecycle-service.ts", import.meta.url),
    "utf8"
  );
  const idleAt = lifecycleSrc.indexOf("statusController.resetToIdle()");
  const runResetAt = lifecycleSrc.indexOf("run.resetRunState()");
  assert.notEqual(idleAt, -1, "resetTransientState resets the status");
  assert.ok(
    idleAt < runResetAt,
    "resetToIdle must run BEFORE resetRunState — the abort listener rewrites active statuses to aborted"
  );
}

// ============================================================================
// 4. Read-side repairs are WRITTEN back
//
// A session killed while a background job ran persists a `running` handle. Restore settles it in
// memory, and `tracker.reset(repaired)` then treats that array as already persisted — so without a
// second write the file keeps the handle, and `session_read` / another process reports a job that
// cannot exist. The repaired transcript must reach disk even with no new message.
// ============================================================================
{
  const manager = new AgentManager();
  const host = createLocalAgentSessionHost({ manager });
  const created = await host.create({ name: "repair-persist", model: "default-model", modelStyle: "openai" });
  const managed = manager.getAgent(created.session.getSnapshot().agentId);
  const id = managed.getSessionData().id;
  const store = managed.getSessionStore();

  const interruptedJobPart = {
    type: "tool-call",
    id: "call_bg",
    name: "run_command",
    arguments: '{"command":"sleep 100","run_in_background":true}',
    state: "input-complete",
    output: {
      command: "sleep 100",
      stdout: "",
      stderr: "",
      exitCode: null,
      durationMs: 0,
      success: false,
      status: "running",
      runInBackground: true,
      jobId: "job_interrupted",
      cachedOutputPath: null,
    },
  };
  const data = managed.getSessionData();
  data.uiMessages = [
    userMessage("bg-u1", "start it"),
    { id: "bg-a1", role: "assistant", parts: [interruptedJobPart], createdAt: 2 },
  ];
  await store.save(data);
  manager.releaseSessionOwnership(id, managed.id);

  const manager2 = new AgentManager();
  const host2 = createLocalAgentSessionHost({ manager: manager2 });
  await host2.create({ name: "repair-resume", model: "default-model", modelStyle: "openai", resumeSessionId: id });

  const persisted = await new SessionStore().load(id);
  const persistedPart = persisted.uiMessages
    .flatMap((message) => message.parts)
    .find((part) => part.type === "tool-call" && part.id === "call_bg");
  assert.notEqual(persistedPart?.output?.status, "running", "the repaired background handle is on disk");
  assert.equal(persistedPart?.output?.status, "killed", "…settled as killed, the same status the job record uses");
}

await fs.promises.rm(rootPath, TEMP_RM_OPTIONS);
console.log("session-restore-state validation passed");

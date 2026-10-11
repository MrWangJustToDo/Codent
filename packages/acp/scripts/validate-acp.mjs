/**
 * ACP host validation.
 *
 * Part A — pure mapping units (content / tools / permissions / commands).
 * Part B — an **in-process conformance run**: the official ACP SDK `client()`
 *          connects directly to our `agent()` app (no transport) and drives
 *          initialize → session/new → session/prompt → cancel, asserting the
 *          wire shapes match the standard protocol.
 *
 * Run: pnpm --filter @codent/acp run validate:acp
 */

import { client as createClient, methods } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildElicitationRequest,
  commandsFromSnapshot,
  createAcpAgent,
  mapElicitationResponse,
  mapPermissionOutcome,
  parseSlashCommand,
  permissionOptions,
  promptBlocksToContent,
  toolDiffFor,
  toolKindFor,
  toolLocationsFor,
  toolStatusFor,
  toolTitleFor,
} from "../dist/index.mjs";

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}`);
  }
}

// ===========================================================================
// A. Pure mapping units
// ===========================================================================

// --- content ---------------------------------------------------------------
check(
  "text prompt maps to a string",
  JSON.stringify(
    promptBlocksToContent([{ type: "text", text: "hi" }], { image: true, audio: true, embeddedContext: true }).content
  ) === JSON.stringify("hi")
);
{
  const m = promptBlocksToContent(
    [
      { type: "text", text: "look" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
    ],
    { image: true, audio: true, embeddedContext: true }
  );
  check(
    "text+image maps to ContentPart[] with an image data source",
    Array.isArray(m.content) && m.content.some((p) => p.type === "image" && p.source.type === "data")
  );
}
check(
  "undeclared image is a hard error, not a silent drop",
  Boolean(
    promptBlocksToContent([{ type: "image", mimeType: "image/png", data: "AAAA" }], {
      image: false,
      audio: false,
      embeddedContext: false,
    }).error
  )
);
{
  const rl = promptBlocksToContent([{ type: "resource_link", uri: "file:///a.ts", name: "a.ts" }], {
    image: true,
    audio: true,
    embeddedContext: true,
  });
  check("resource_link becomes text context", typeof rl.content === "string" && rl.content.includes("a.ts"));
}

// --- tools -----------------------------------------------------------------
check("kind: read_file → read", toolKindFor("read_file") === "read");
check("kind: edit_file → edit", toolKindFor("edit_file") === "edit");
check("kind: delete_file → delete", toolKindFor("delete_file") === "delete");
check("kind: run_command → execute", toolKindFor("run_command") === "execute");
check("kind: webfetch → fetch", toolKindFor("webfetch") === "fetch");
check("kind: unknown tool → other", toolKindFor("mystery") === "other");

check(
  "locations resolve relative path against root",
  JSON.stringify(toolLocationsFor({ path: "src/a.ts" }, "/ws")) === JSON.stringify([{ path: "/ws/src/a.ts" }])
);
check("title includes the path", toolTitleFor("read_file", { path: "src/a.ts" }).includes("src/a.ts"));

{
  const d = toolDiffFor("write_file", { path: "a.ts", content: "hello" }, "/ws");
  check(
    "write_file produces a diff with oldText null",
    d?.type === "diff" && d.oldText === null && d.newText === "hello"
  );
}
{
  const d = toolDiffFor("edit_file", { path: "a.ts", oldString: "x", newString: "y" }, "/ws");
  check(
    "edit_file produces a diff from replacement spans",
    d?.type === "diff" && d.oldText === "x" && d.newText === "y"
  );
}
check("unknown tool yields no diff (no fabrication)", toolDiffFor("read_file", { path: "a.ts" }, "/ws") === undefined);
check("tool status: complete → completed", toolStatusFor("complete", false) === "completed");
check("tool status: error → failed", toolStatusFor("error", true) === "failed");

// --- permissions / elicitation --------------------------------------------
{
  const opts = permissionOptions();
  check("permission options cover all four kinds", opts.length === 4 && new Set(opts.map((o) => o.kind)).size === 4);
  check(
    "allow-once outcome approves",
    mapPermissionOutcome({ outcome: { outcome: "selected", optionId: "allow-once" } })?.approved === true
  );
  check(
    "reject-once outcome rejects",
    mapPermissionOutcome({ outcome: { outcome: "selected", optionId: "reject-once" } })?.approved === false
  );
  check("cancelled outcome → null", mapPermissionOutcome({ outcome: { outcome: "cancelled" } }) === null);
  const req = buildElicitationRequest("s1", { toolCallId: "c1", question: "Pick", options: ["a", "b"] });
  check("elicit form has a schema enum", req.mode === "form" && JSON.stringify(req.requestedSchema).includes("enum"));
  check(
    "elicit accept maps to an answer",
    mapElicitationResponse({ action: "accept", content: { answer: "a" } })?.answer === "a"
  );
  check("elicit decline → null", mapElicitationResponse({ action: "decline" }) === null);
}

// --- commands --------------------------------------------------------------
check(
  "parse `/mode plan`",
  JSON.stringify(parseSlashCommand("/mode plan")) === JSON.stringify({ name: "mode", args: ["plan"], raw: "plan" })
);
check("plain text is not a command", parseSlashCommand("hello") === null);
{
  const cmds = commandsFromSnapshot({
    extensions: { extensions: [{ commands: [{ name: "memory", description: "mem", hasOptions: false }] }] },
  });
  check(
    "commands include builtin + extension",
    cmds.builtin.some((c) => c.name === "mode") && cmds.extension.some((c) => c.name === "memory")
  );
  check("UI-only commands are not advertised", !cmds.builtin.some((c) => c.name === "quit"));
}

// ===========================================================================
// B. In-process ACP conformance (SDK client ↔ our agent)
// ===========================================================================

function baseSnapshot(id, overrides = {}) {
  return {
    agentId: id,
    name: id,
    status: "idle",
    error: "",
    pendingApprovalCount: 0,
    mode: "normal",
    lastStreamDurationMs: 0,
    messages: [],
    queues: { steer: [], followUp: [] },
    usage: {
      contextFillTokens: 0,
      tokenLimit: 200000,
      percent: 0,
      cost: 0,
      llmDurationMs: 0,
      llmOutputTokens: 0,
      total: {},
      window: {},
      billedInputTokens: 0,
    },
    todos: [],
    todosTitle: null,
    plan: {},
    autoMode: false,
    mcp: { servers: [] },
    extensions: { extensions: [] },
    toolDescriptors: [],
    interactions: { approvals: [], askUser: [] },
    iteration: { current: 1, max: 100 },
    subagents: [],
    ...overrides,
  };
}

function makeFakeSession(id) {
  const listeners = new Set();
  let snap = baseSnapshot(id);
  return {
    id,
    getSnapshot: () => snap,
    getSummaryStreamSnapshot: () => null,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispatch: async (command) => {
      if (command.type === "send") {
        const message = { id: "m1", role: "assistant", parts: [{ type: "text", content: "Hello from ACP." }] };
        snap = baseSnapshot(id, { status: "running", messages: [message] });
        for (const l of listeners) l({ channel: "messages", payload: [message], ts: Date.now() });
        snap = baseSnapshot(id, { status: "completed", messages: [message] });
        for (const l of listeners) l({ channel: "state", payload: snap, ts: Date.now() });
        return { ok: true };
      }
      if (command.type === "stop") return { ok: true };
      return { ok: true };
    },
  };
}

const updates = [];
const clientApp = createClient({ name: "test-client" }).onNotification(methods.client.session.update, (ctx) => {
  updates.push(ctx.params.update);
});

const host = {
  async create() {
    return { session: makeFakeSession("s1") };
  },
  connect: () => null,
  list: () => [],
  async destroy() {},
};

const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/workspace" });

await clientApp.connectWith(app, async (cx) => {
  const init = await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
  check("initialize negotiates protocolVersion 1", init.protocolVersion === 1);
  check("initialize advertises loadSession", init.agentCapabilities?.loadSession === true);
  check("initialize advertises agentInfo.name", init.agentInfo?.name === "codent");

  const news = await cx.request(methods.agent.session.new, { cwd: "/workspace", mcpServers: [] });
  check("session/new returns a sessionId", typeof news.sessionId === "string" && news.sessionId.length > 0);
  check(
    "session/new returns modes with normal active",
    news.modes?.currentModeId === "normal" && news.modes.availableModes.length === 3
  );

  const prompt = await cx.request(methods.agent.session.prompt, {
    sessionId: news.sessionId,
    prompt: [{ type: "text", text: "hi" }],
  });
  check(
    "prompt resolves with a valid stopReason",
    ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"].includes(prompt.stopReason)
  );

  // Allow queued notifications to flush.
  await new Promise((r) => setTimeout(r, 20));
  const messageChunks = updates.filter((u) => u.sessionUpdate === "agent_message_chunk");
  check(
    "agent text streams as agent_message_chunk",
    messageChunks.length > 0 && messageChunks.some((u) => u.content?.text === "Hello from ACP.")
  );
  check(
    "update carries a stable messageId",
    messageChunks.every((u) => u.messageId === "m1")
  );
});

// ===========================================================================
// C. Tool calls, plan, and session isolation
// ===========================================================================

function makeRichSession(id) {
  const listeners = new Set();
  let snap = baseSnapshot(id);
  const emit = (event) => {
    for (const l of listeners) l({ ...event, ts: Date.now() });
  };
  return {
    id,
    getSnapshot: () => snap,
    getSummaryStreamSnapshot: () => null,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispatch: async (command) => {
      if (command.type !== "send") return { ok: true };
      const call = {
        type: "tool-call",
        id: "t1",
        name: "read_file",
        input: { path: "src/a.ts" },
        state: "input-complete",
      };
      snap = baseSnapshot(id, { status: "running", messages: [{ id: "mA", role: "assistant", parts: [call] }] });
      emit({ channel: "messages", payload: snap.messages });
      const done = { ...call, state: "complete", output: { success: true } };
      const result = { type: "tool-result", toolCallId: "t1", content: "file contents", state: "complete" };
      snap = baseSnapshot(id, {
        status: "completed",
        messages: [{ id: "mA", role: "assistant", parts: [done, result] }],
        todos: [{ id: "1", content: "Do X", priority: "high", status: "pending", createdAt: 0, updatedAt: 0 }],
      });
      emit({ channel: "messages", payload: snap.messages });
      emit({ channel: "todos", payload: { items: snap.todos, title: null } });
      return { ok: true };
    },
  };
}

const richUpdates = [];
const richClient = createClient({ name: "rich-client" }).onNotification(methods.client.session.update, (ctx) =>
  richUpdates.push(ctx.params)
);
const richHost = {
  async create() {
    return { session: makeRichSession(`s-${Math.random().toString(36).slice(2, 6)}`) };
  },
  connect: () => null,
  list: () => [],
  async destroy() {},
};
const richApp = createAcpAgent({ host: richHost, defaults: { model: "fake-model" }, rootPath: "/ws" });

await richClient.connectWith(richApp, async (cx) => {
  const a = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
  const b = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
  await cx.request(methods.agent.session.prompt, {
    sessionId: a.sessionId,
    prompt: [{ type: "text", text: "read it" }],
  });
  await new Promise((r) => setTimeout(r, 20));

  const aUpdates = richUpdates.filter((u) => u.sessionId === a.sessionId).map((u) => u.update);
  const bUpdates = richUpdates.filter((u) => u.sessionId === b.sessionId).map((u) => u.update);

  const toolCall = aUpdates.find((u) => u.sessionUpdate === "tool_call");
  check(
    "tool_call emitted with kind + absolute location",
    toolCall?.kind === "read" && toolCall?.locations?.[0]?.path === "/ws/src/a.ts"
  );
  check(
    "tool_call_update completes the tool",
    aUpdates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed")
  );
  const plan = aUpdates.find((u) => u.sessionUpdate === "plan" && u.entries?.[0]?.content === "Do X");
  check("todos map to a plan update", plan?.entries?.[0]?.priority === "high");
  check(
    "session A's tool call and plan never leak to session B",
    !bUpdates.some((u) => u.sessionUpdate === "tool_call") &&
      !bUpdates.some((u) => u.sessionUpdate === "plan" && u.entries?.[0]?.content === "Do X")
  );
  check("session A really streamed its own updates", aUpdates.length > 0);
});

// ===========================================================================
// D. Cancellation
// ===========================================================================

function makeCancelSession(id) {
  const listeners = new Set();
  let snap = baseSnapshot(id, { status: "idle" });
  let release;
  return {
    id,
    getSnapshot: () => snap,
    getSummaryStreamSnapshot: () => null,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispatch: async (command) => {
      if (command.type === "send") {
        snap = baseSnapshot(id, { status: "running" });
        await new Promise((r) => {
          release = r;
        });
        snap = baseSnapshot(id, { status: "aborted" });
        return { ok: true };
      }
      if (command.type === "stop") {
        release?.();
        return { ok: true };
      }
      return { ok: true };
    },
  };
}

const cancelClient = createClient({ name: "cancel-client" });
const cancelHost = {
  async create() {
    return { session: makeCancelSession("s-cancel") };
  },
  connect: () => null,
  list: () => [],
  async destroy() {},
};
const cancelApp = createAcpAgent({ host: cancelHost, defaults: { model: "fake-model" }, rootPath: "/ws" });

await cancelClient.connectWith(cancelApp, async (cx) => {
  const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
  const promptPromise = cx.request(methods.agent.session.prompt, {
    sessionId: s.sessionId,
    prompt: [{ type: "text", text: "long" }],
  });
  await new Promise((r) => setTimeout(r, 10));
  await cx.notify(methods.agent.session.cancel, { sessionId: s.sessionId });
  const result = await promptPromise;
  check("session/cancel resolves as stopReason cancelled (not an error)", result.stopReason === "cancelled");
});

// ===========================================================================
// E. stdio smoke — spawn the standalone bin and complete `initialize`
// ===========================================================================

{
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.mjs");
  const child = spawn(process.execPath, [bin], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MODEL: "dummy", BASE_URL: "http://127.0.0.1:1", API_KEY: "x" },
  });
  try {
    const response = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("timeout waiting for initialize response")), 15000);
      child.stdout.on("data", (d) => {
        buf += d.toString();
        const line = buf.split("\n").find((l) => l.trim());
        if (line) {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(line));
          } catch (err) {
            reject(err);
          }
        }
      });
      child.on("error", reject);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })}\n`
      );
    });
    check("spawned codent-acp answers initialize over stdio", response.result?.protocolVersion === 1);
  } finally {
    child.kill();
  }
}

// ===========================================================================
// F. Incremental text + thought projection
// ===========================================================================

function makeStreamSession(id) {
  const listeners = new Set();
  let snap = baseSnapshot(id);
  const emit = (event) => {
    for (const l of listeners) l({ ...event, ts: Date.now() });
  };
  return {
    id,
    getSnapshot: () => snap,
    getSummaryStreamSnapshot: () => null,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispatch: async (command) => {
      if (command.type !== "send") return { ok: true };
      const m1 = {
        id: "mS",
        role: "assistant",
        parts: [
          { type: "thinking", content: "think" },
          { type: "text", content: "Hello" },
        ],
      };
      snap = baseSnapshot(id, { status: "running", messages: [m1] });
      emit({ channel: "messages", payload: [m1] });
      const m2 = {
        id: "mS",
        role: "assistant",
        parts: [
          { type: "thinking", content: "think" },
          { type: "text", content: "Hello world" },
        ],
      };
      snap = baseSnapshot(id, { status: "completed", messages: [m2] });
      emit({ channel: "messages", payload: [m2] });
      return { ok: true };
    },
  };
}

const streamUpdates = [];
const streamClient = createClient({ name: "stream-client" }).onNotification(methods.client.session.update, (ctx) =>
  streamUpdates.push(ctx.params.update)
);
const streamApp = createAcpAgent({
  host: {
    async create() {
      return { session: makeStreamSession("s-stream") };
    },
    connect: () => null,
    list: () => [],
    async destroy() {},
  },
  defaults: { model: "fake-model" },
  rootPath: "/ws",
});

await streamClient.connectWith(streamApp, async (cx) => {
  const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
  await cx.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "hi" }] });
  await new Promise((r) => setTimeout(r, 20));
  const textChunks = streamUpdates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text);
  check(
    "incremental text sends only the appended substring",
    JSON.stringify(textChunks) === JSON.stringify(["Hello", " world"])
  );
  const thought = streamUpdates.filter((u) => u.sessionUpdate === "agent_thought_chunk").map((u) => u.content.text);
  check("thought chunks are emitted once, not duplicated", thought.length === 1 && thought[0] === "think");
});

// ===========================================================================
// G. session/load replays once; session/resume never replays
// ===========================================================================

function makeRestoredSession(id) {
  const listeners = new Set();
  const messages = [
    { id: "u1", role: "user", parts: [{ type: "text", content: "prior question" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", content: "prior answer" }] },
  ];
  const snap = baseSnapshot(id, { messages });
  return {
    id,
    getSnapshot: () => snap,
    getSummaryStreamSnapshot: () => null,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispatch: async () => ({ ok: true }),
  };
}

const loadUpdates = [];
const loadClient = createClient({ name: "load-client" }).onNotification(methods.client.session.update, (ctx) =>
  loadUpdates.push(ctx.params.update)
);
const loadApp = createAcpAgent({
  host: {
    async create() {
      return { session: makeRestoredSession("s-loaded") };
    },
    connect: () => null,
    list: () => [],
    async destroy() {},
  },
  defaults: { model: "fake-model" },
  rootPath: "/ws",
});

await loadClient.connectWith(loadApp, async (cx) => {
  await cx.request(methods.agent.session.load, { sessionId: "sess-old", cwd: "/ws", mcpServers: [] });
  await new Promise((r) => setTimeout(r, 10));
  const agentTexts = loadUpdates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text);
  const userTexts = loadUpdates.filter((u) => u.sessionUpdate === "user_message_chunk").map((u) => u.content.text);
  check(
    "session/load replays the user turn exactly once",
    JSON.stringify(userTexts) === JSON.stringify(["prior question"])
  );
  check(
    "session/load replays the agent turn exactly once (no double)",
    JSON.stringify(agentTexts) === JSON.stringify(["prior answer"])
  );

  loadUpdates.length = 0;
  await cx.request(methods.agent.session.resume, { sessionId: "sess-old", cwd: "/ws", mcpServers: [] });
  await new Promise((r) => setTimeout(r, 10));
  check(
    "session/resume does not replay history",
    loadUpdates.filter((u) => u.sessionUpdate.endsWith("_message_chunk")).length === 0
  );
});

// ===========================================================================
// H. Permission round-trip (approval → request_permission → respondApproval)
// ===========================================================================

const dispatched = [];
function makeApprovalSession(id) {
  const listeners = new Set();
  let snap = baseSnapshot(id);
  const emit = (event) => {
    for (const l of listeners) l({ ...event, ts: Date.now() });
  };
  return {
    id,
    getSnapshot: () => snap,
    getSummaryStreamSnapshot: () => null,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispatch: async (command) => {
      dispatched.push(command);
      if (command.type === "send") {
        snap = baseSnapshot(id, { status: "running" });
        emit({
          channel: "interaction",
          payload: { approvals: [{ approvalId: "ap1", toolName: "edit_file", toolCallId: "tc1" }], askUser: [] },
        });
        await new Promise((r) => setTimeout(r, 20));
        snap = baseSnapshot(id, { status: "completed" });
      }
      return { ok: true };
    },
  };
}

const approvalClient = createClient({ name: "approval-client" }).onRequest(
  methods.client.session.requestPermission,
  () => ({ outcome: { outcome: "selected", optionId: "allow-once" } })
);
const approvalApp = createAcpAgent({
  host: {
    async create() {
      return { session: makeApprovalSession("s-approval") };
    },
    connect: () => null,
    list: () => [],
    async destroy() {},
  },
  defaults: { model: "fake-model" },
  rootPath: "/ws",
});

await approvalClient.connectWith(approvalApp, async (cx) => {
  const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
  await cx.request(methods.agent.session.prompt, {
    sessionId: s.sessionId,
    prompt: [{ type: "text", text: "edit it" }],
  });
  await new Promise((r) => setTimeout(r, 30));
  const approval = dispatched.find((c) => c.type === "respondApproval");
  check(
    "approval round-trip reaches respondApproval with approved=true",
    approval?.approved === true && approval?.approvalId === "ap1"
  );
});

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);

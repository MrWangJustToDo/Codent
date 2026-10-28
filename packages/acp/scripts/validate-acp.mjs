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
import { formatToolInput } from "@codent/core";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildElicitationRequest,
  createAcpAgent,
  mapElicitationResponse,
  mapPermissionOutcome,
  paginateSessions,
  parseSlashCommand,
  permissionOptions,
  promptBlocksToContent,
  toolCallInfo,
  toolDiffFor,
  toolKindFor,
  toolLocationsFor,
  toolStatusFor,
  toolTitleFor,
} from "../dist/index.mjs";

import { createChecker, finish } from "./acp-report.mjs";
import { baseSnapshot } from "./session-fixture.mjs";

const checker = createChecker();
const check = checker.check;

// --- tool-call titles -------------------------------------------------------
//
// The title of a tool call is core's OWN input formatter — the string the app puts at the head of a
// row — not a verb-plus-path composed here. ACP's old composition dropped the key parameter of every
// tool whose parameter is not a path: "Run" (no command), "Search <path>" (no pattern), "Web search"
// (no query). Asserted against `formatToolInput` itself, so the two cannot drift apart again.
for (const [tool, input, expected] of [
  ["grep", { pattern: "TODO", path: "packages/core" }, "TODO"],
  ["websearch", { query: "acp protocol" }, "acp protocol"],
  ["webfetch", { url: "https://example.com/docs" }, "https://example.com/docs"],
  ["task", { prompt: "find the tests", description: "find-tests" }, "find-tests"],
  ["run_command", { command: "pnpm build" }, "pnpm build"],
]) {
  const info = toolCallInfo(tool, input, "/ws");
  check(
    `a ${tool} call names its parameter in the title`,
    info.title.includes(expected) && info.title === formatToolInput(input, tool, { compact: true }),
    `${info.title} (expected to include ${expected})`
  );
  check(
    `…and carries the input itself for any client that renders raw`,
    JSON.stringify(info.rawInput) === JSON.stringify(input)
  );
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
check(
  "tool status: cancelled is a terminal non-success, never completed",
  toolStatusFor("complete", true, true) === "failed"
);
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

// --- session catalog mapping / paging (pure) --------------------------------
{
  const metas = [
    { id: "ses_a", name: "A", version: 1, modelStyle: "openai", model: "m", createdAt: 3, updatedAt: 300 },
    { id: "ses_b", name: "", version: 1, modelStyle: "openai", model: "m", createdAt: 2, updatedAt: 200 },
    { id: "ses_c", name: "C", version: 1, modelStyle: "openai", model: "m", createdAt: 1, updatedAt: 100 },
  ];
  const p1 = paginateSessions(metas, "/ws", { pageSize: 2 });
  check(
    "paging returns the newest page and a cursor",
    JSON.stringify(p1.sessions.map((s) => s.sessionId)) === JSON.stringify(["ses_a", "ses_b"]) &&
      typeof p1.nextCursor === "string"
  );
  const p2 = paginateSessions(metas, "/ws", { pageSize: 2, cursor: p1.nextCursor });
  check(
    "the cursor resumes strictly older and exhausts",
    JSON.stringify(p2.sessions.map((s) => s.sessionId)) === JSON.stringify(["ses_c"]) && p2.nextCursor == null
  );
  check("pages never overlap", !p1.sessions.some((s) => p2.sessions.some((t) => t.sessionId === s.sessionId)));
  check("an empty catalog is an empty page, not an error", paginateSessions([], "/ws").sessions.length === 0);
  check(
    "a malformed cursor degrades to the first page",
    paginateSessions(metas, "/ws", { cursor: "nope" }).sessions.length === 3
  );
  check(
    "a legacy `updatedAt`-only cursor degrades to the first page",
    paginateSessions(metas, "/ws", { cursor: "200", pageSize: 2 }).sessions[0].sessionId === "ses_a"
  );
  check(
    "title is omitted when the session has no name",
    paginateSessions(metas, "/ws").sessions.find((s) => s.sessionId === "ses_b")?.title === undefined
  );
  check("updatedAt is ISO 8601", paginateSessions(metas, "/ws").sessions[0].updatedAt === new Date(300).toISOString());

  // Sessions sharing a millisecond are ordinary (`Date.now()` granularity, and a scripted client
  // creates them back to back). An `updatedAt`-only boundary would DROP whichever of the pair
  // straddled a page cut — so the id is the tie-breaker, and every row must be visited once.
  const tied = [
    { id: "ses_t1", name: "T1", version: 1, modelStyle: "openai", model: "m", createdAt: 1, updatedAt: 500 },
    { id: "ses_t2", name: "T2", version: 1, modelStyle: "openai", model: "m", createdAt: 1, updatedAt: 500 },
    { id: "ses_t3", name: "T3", version: 1, modelStyle: "openai", model: "m", createdAt: 1, updatedAt: 400 },
  ];
  const t1 = paginateSessions(tied, "/ws", { pageSize: 1 });
  const t2 = paginateSessions(tied, "/ws", { pageSize: 1, cursor: t1.nextCursor });
  const t3 = paginateSessions(tied, "/ws", { pageSize: 1, cursor: t2.nextCursor });
  const visited = [...t1.sessions, ...t2.sessions, ...t3.sessions].map((s) => s.sessionId);
  check(
    "a same-millisecond pair is not dropped across a page boundary",
    visited.length === 3 && new Set(visited).size === 3
  );
  check(
    "same-millisecond rows come back in id order, then the older row",
    JSON.stringify(visited) === JSON.stringify(["ses_t1", "ses_t2", "ses_t3"])
  );
}

// ===========================================================================
// B. In-process ACP conformance (SDK client ↔ our agent)
// ===========================================================================

function makeFakeSession(id, diskId = id) {
  const listeners = new Set();
  // `AgentSession.id` is the AGENT id and `activeSessionId` is the DISK id — two different
  // values, exactly as in production (`local-agent-session.ts` sets `id = managed.id`). Keeping
  // them distinct here is what makes the "ACP sessionId is the disk id" assertions meaningful;
  // a mock that collapsed them would hide the bug this section exists to catch.
  let snap = baseSnapshot(id, { activeSessionId: diskId });
  return {
    id,
    getSnapshot: () => snap,
    getAgentStreamSnapshot: () => null,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispatch: async (command) => {
      if (command.type === "send") {
        const message = { id: "m1", role: "assistant", parts: [{ type: "text", content: "Hello from ACP." }] };
        snap = baseSnapshot(id, { status: "running", messages: [message], activeSessionId: diskId });
        for (const l of listeners) l({ channel: "messages", payload: [message], ts: Date.now() });
        snap = baseSnapshot(id, { status: "completed", messages: [message], activeSessionId: diskId });
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
    return { session: makeFakeSession("agent_1", "ses_1") };
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
    "session/new returns the DISK session id, not the agent id",
    news.sessionId === "ses_1" && news.sessionId !== "agent_1"
  );
  check(
    "session/new returns modes with normal active",
    news.modes?.currentModeId === "normal" && news.modes.availableModes.length === 3
  );
  const modeOption = news.configOptions?.find((o) => o.category === "mode");
  check(
    "session/new advertises a mode select whose value matches modes.currentModeId",
    modeOption?.type === "select" && modeOption.currentValue === news.modes?.currentModeId
  );

  // The id from session/new must be directly usable by the other session methods.
  await cx.request(methods.agent.session.resume, { sessionId: news.sessionId, cwd: "/workspace", mcpServers: [] });
  check("session/new's id is accepted by session/resume (one id space)", true);

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
    getAgentStreamSnapshot: () => null,
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
    getAgentStreamSnapshot: () => null,
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
    getAgentStreamSnapshot: () => null,
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

function makeRestoredSession(id, diskId = id) {
  const listeners = new Set();
  const messages = [
    { id: "u1", role: "user", parts: [{ type: "text", content: "prior question" }] },
    // Synthetic per-turn context is persisted for the MODEL, not the reader: a replay must hide it.
    { id: "ctx-1", role: "user", parts: [{ type: "text", content: "<ctx kind=git_status>\nmain\n</ctx>" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", content: "prior answer" },
        // Never approved: the row has to say `pending`, not `completed`.
        {
          id: "tc-pending",
          type: "tool-call",
          name: "run_command",
          arguments: '{"command":"rm -rf build"}',
          state: "approval-requested",
        },
        {
          id: "tc-done",
          type: "tool-call",
          name: "run_command",
          arguments: '{"command":"ls"}',
          state: "complete",
          output: { success: true },
        },
      ],
    },
  ];
  const snap = baseSnapshot(id, { messages, activeSessionId: diskId });
  return {
    id,
    getSnapshot: () => snap,
    getAgentStreamSnapshot: () => null,
    subscribe: (handler) => {
      listeners.add(handler);
      // A real session delivers its retained values to a NEW subscriber. That is what makes the
      // replay-vs-subscribe ORDER observable: subscribing first put the whole stored conversation on
      // the wire as live chunks, and the replay then sent the assistant half again (creating every
      // historical tool call `pending` and correcting it immediately after).
      handler({ channel: "messages", payload: messages, ts: Date.now() });
      return () => listeners.delete(handler);
    },
    dispatch: async () => ({ ok: true }),
  };
}

const loadUpdates = [];
const loadClient = createClient({ name: "load-client" }).onNotification(methods.client.session.update, (ctx) =>
  // Keep the whole params object so the SESSION ID can be asserted, not just the update body.
  loadUpdates.push(ctx.params)
);
const loadApp = createAcpAgent({
  host: {
    // The requested disk id is what the bridge must key on, so the mock adopts it as its
    // `activeSessionId` (the real host restores exactly the id it was handed).
    async create(options) {
      return { session: makeRestoredSession("agent_old", options?.resumeSessionId ?? "ses_old") };
    },
    connect: () => null,
    list: () => [],
    async destroy() {},
  },
  defaults: { model: "fake-model" },
  rootPath: "/ws",
});

await loadClient.connectWith(loadApp, async (cx) => {
  await cx.request(methods.agent.session.load, { sessionId: "ses_old", cwd: "/ws", mcpServers: [] });
  await new Promise((r) => setTimeout(r, 10));
  const agentTexts = loadUpdates
    .map((u) => u.update)
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content.text);
  const userTexts = loadUpdates
    .map((u) => u.update)
    .filter((u) => u.sessionUpdate === "user_message_chunk")
    .map((u) => u.content.text);
  check(
    "session/load replays the user turn exactly once",
    JSON.stringify(userTexts) === JSON.stringify(["prior question"])
  );
  check(
    "session/load replays the agent turn exactly once (no double)",
    JSON.stringify(agentTexts) === JSON.stringify(["prior answer"])
  );
  check(
    "session/load hides the injected <ctx> context from the replay",
    !userTexts.some((text) => text.includes("<ctx kind=")) && userTexts.length === 1
  );

  // A replayed call that never finished must not be advertised as `completed`: the next live tick then
  // downgrades it (a frozen terminal row in the client), which is how an call awaiting approval became
  // invisible and left the session stuck on a prompt nobody could answer.
  const replayedTools = loadUpdates.map((p) => p.update).filter((u) => u.sessionUpdate === "tool_call");
  check(
    "a replayed call reports the status its part actually has",
    replayedTools.every((u) => u.toolCallId !== "tc-pending" || u.status === "pending") &&
      replayedTools.some((u) => u.toolCallId === "tc-pending")
  );
  check(
    "session/load tags every update with the disk id it was given",
    loadUpdates.length > 0 && loadUpdates.every((p) => p.sessionId === "ses_old")
  );

  loadUpdates.length = 0;
  await cx.request(methods.agent.session.resume, { sessionId: "ses_old", cwd: "/ws", mcpServers: [] });
  await new Promise((r) => setTimeout(r, 10));
  check(
    "session/resume does not replay history",
    loadUpdates.filter((p) => p.update.sessionUpdate.endsWith("_message_chunk")).length === 0
  );
});

// ===========================================================================
// H. Permission round-trip (approval → request_permission → respondApproval)
// ===========================================================================

const dispatched = [];
/**
 * The command the approval is about. A real session always has the tool-call part on its channel
 * while the approval is pending, which is where the prompt gets its input from — a mock without it
 * would let an approval prompt that shows NOTHING pass.
 */
const APPROVED_COMMAND = "npm run build --filter @codent/app";
const approvalMessages = [
  {
    id: "m-approval",
    role: "assistant",
    parts: [
      {
        id: "tc1",
        type: "tool-call",
        name: "run_command",
        input: { command: APPROVED_COMMAND },
        state: "input-complete",
      },
    ],
  },
];
function makeApprovalSession(id) {
  const listeners = new Set();
  let snap = baseSnapshot(id, { messages: approvalMessages });
  const emit = (event) => {
    for (const l of listeners) l({ ...event, ts: Date.now() });
  };
  return {
    id,
    getSnapshot: () => snap,
    getAgentStreamSnapshot: () => null,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispatch: async (command) => {
      dispatched.push(command);
      if (command.type === "send") {
        // A turn that SUSPENDS: `send` resolves with the session still ACTIVE (`waiting`), and only the
        // approval answer resumes it — that is why the pump returns, and why the prompt must not resolve
        // here (resolving told the client the turn was over while its continuation still streamed).
        snap = baseSnapshot(id, { status: "waiting", messages: approvalMessages });
        emit({ channel: "messages", payload: approvalMessages, ts: Date.now() });
        emit({
          channel: "interaction",
          payload: { approvals: [{ approvalId: "ap1", toolName: "run_command", toolCallId: "tc1" }], askUser: [] },
        });
        emit({ channel: "state", payload: snap });
      }
      if (command.type === "respondApproval") {
        approvalMessages[0].parts[0].state = "complete";
        approvalMessages[0].parts[0].output = { success: true, stdout: "ok" };
        snap = baseSnapshot(id, { status: "completed", messages: approvalMessages });
        emit({ channel: "messages", payload: approvalMessages, ts: Date.now() });
        emit({ channel: "state", payload: snap });
      }
      return { ok: true };
    },
  };
}

const catalogUpdatesForApproval = [];
let permissionParams = null;
const approvalClient = createClient({ name: "approval-client" })
  .onNotification(methods.client.session.update, (ctx) => catalogUpdatesForApproval.push(ctx.params.update))
  .onRequest(methods.client.session.requestPermission, async (ctx) => {
    permissionParams = ctx.params;
    // Answer LATE: the suspension window has to be observable, or "the prompt stayed pending" cannot
    // be told apart from "the approval round-trip was simply fast" (the flake this check exists for).
    await new Promise((r) => setTimeout(r, 80));
    return { outcome: { outcome: "selected", optionId: "allow-once" } };
  });
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
  let promptSettled = false;
  const prompt = cx
    .request(methods.agent.session.prompt, {
      sessionId: s.sessionId,
      prompt: [{ type: "text", text: "run it" }],
    })
    .then(() => {
      promptSettled = true;
    });
  // The turn is in flight until the approval is answered, so the prompt must still be pending.
  await new Promise((r) => setTimeout(r, 30));
  check("the prompt stays pending while the turn is suspended on an approval", promptSettled === false);
  await prompt;
  check("…and resolves once the turn actually ends", promptSettled === true);
  const approval = dispatched.find((c) => c.type === "respondApproval");
  check(
    "approval round-trip reaches respondApproval with approved=true",
    approval?.approved === true && approval?.approvalId === "ap1"
  );

  // The prompt itself: what the client is asked to approve. It used to carry the tool NAME as the
  // title and nothing else, so a `run_command` arrived as a bare "Run" — the client could not show
  // the command and the user was asked to approve something unreadable.
  const asked = permissionParams?.toolCall;
  check(
    "the approval prompt names the command as its title",
    typeof asked?.title === "string" && asked.title.includes(APPROVED_COMMAND),
    asked?.title
  );
  check("…carries the raw input the command lives in", asked?.rawInput?.command === APPROVED_COMMAND);
  check(
    "…and a content block with the command text",
    (asked?.content ?? []).some((entry) => entry?.type === "content" && entry.content?.text === APPROVED_COMMAND)
  );
  check(
    "…with the kind/status a client renders it by",
    asked?.kind === "execute" && asked?.status === "pending" && asked?.toolCallId === "tc1"
  );
  const completed = catalogUpdatesForApproval.find(
    (u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "tc1"
  );
  check(
    "a tool_call_update carries the title again (a client may replace its row)",
    typeof completed?.title === "string" && completed.title.includes(APPROVED_COMMAND)
  );
});

finish(checker.failures);

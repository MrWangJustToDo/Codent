/**
 * Subagents over ACP — capability gate, announcements, child transcripts, task results.
 *
 * A subagent is a session the CLIENT never created: the parent owns it, and the only way a client can
 * learn an id is the `subagent_update` announcement. That makes three properties worth a gate:
 *
 * 1. **Silence without the capability.** A client that did not advertise `subagents` must receive no
 *    `subagent_update`, no child `session/update`, and no child session must be attached at all.
 * 2. **Announce before child traffic.** The announcement must be the first frame naming the child;
 *    otherwise a client drops the child's prompt (the task) as an unknown session.
 * 3. **A child is not a top-level session.** `load` / `resume` / `fork` / `prompt` must refuse it,
 *    and `delete` must not hand it to `host.deleteSession` — that would destroy a live subagent.
 *
 * The projector-level checks drive the real `AcpProjector` over a mock session (the same harness the
 * projection validator uses); the host-level checks drive `createAcpAgent` over a fake host, so the
 * wiring, not just the mapping, is what is asserted.
 *
 * Run: pnpm --filter @codent/acp run validate:acp:subagents
 */

import { client as createAcpClient, methods } from "@agentclientprotocol/sdk";

import { AcpProjector, createAcpAgent } from "../dist/index.mjs";

import { createChecker, finish } from "./acp-report.mjs";
import { zod } from "./acp-scenario.mjs";
import { baseSnapshot } from "./session-fixture.mjs";

const checker = createChecker();
const check = checker.check;
const schemaFailures = [];

function validateUpdate(update) {
  const parsed = zod.zSessionUpdate.safeParse(update);
  if (parsed.success) return;
  schemaFailures.push(
    `${update.sessionUpdate}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"} ${i.message}`).join("; ")}`
  );
}

// ===========================================================================
// 1. Projector: announcement gate, filtering, state mapping, task results
// ===========================================================================

function projectorScenario({ client = { compaction: true, notices: true, subagents: true }, messages = [] } = {}) {
  const listeners = new Set();
  const emitted = [];
  const attached = [];
  let snapshot = baseSnapshot("parent", { messages });

  const projector = new AcpProjector(
    {
      getSnapshot: () => snapshot,
      subscribe: (handler) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    },
    {
      rootPath: "/ws",
      emit: (update) => {
        emitted.push(update);
        validateUpdate(update);
      },
      commands: () => ({ builtin: [], extension: [] }),
      client,
      onSubagents: (rows) => attached.push({ at: emitted.length, ids: rows.map((row) => row.id) }),
    }
  );
  projector.start({ seedState: false });

  return {
    emitted,
    attached,
    push: (channel, payload) => {
      for (const listener of listeners) listener({ channel, payload, ts: Date.now() });
    },
    subagents: (rows) => {
      snapshot = { ...snapshot, subagents: rows };
      for (const listener of listeners)
        listener({ channel: "subagents", payload: { subagents: rows }, ts: Date.now() });
    },
    setMessages: (next) => {
      snapshot = { ...snapshot, messages: next };
      for (const listener of listeners) listener({ channel: "messages", payload: next, ts: Date.now() });
    },
    stop: () => projector.stop(),
  };
}

const row = (over = {}) => ({
  id: "child-1",
  status: "running",
  name: "explore",
  description: "find the tests",
  parentTaskToolCallId: "tc1",
  ...over,
});

{
  const scenario = projectorScenario({ client: { compaction: true, notices: true } });
  scenario.subagents([row()]);
  check(
    "no `subagents` capability: no announcement",
    scenario.emitted.every((u) => u.sessionUpdate !== "subagent_update")
  );
  check("…and no child is attached", scenario.attached.length === 0);

  const on = projectorScenario();
  on.subagents([row()]);
  const announcements = on.emitted.filter((u) => u.sessionUpdate === "subagent_update");
  check(
    "the announcement names the child and its label",
    announcements.length === 1 &&
      announcements[0].sessionId === "child-1" &&
      announcements[0].title === "find the tests" &&
      announcements[0].description === "find the tests",
    JSON.stringify(announcements[0])
  );
  check(
    "…carries the CURRENT state (no follow-up read needed)",
    announcements[0]?.state?.state === "running",
    JSON.stringify(announcements[0]?.state)
  );
  check(
    "…and the child projector is attached only AFTER the announcement",
    on.attached.length === 1 && on.attached[0].at === on.emitted.length,
    JSON.stringify(on.attached)
  );
  on.stop();
}

{
  const scenario = projectorScenario();
  scenario.subagents([
    row({ id: "worker-1", parentTaskToolCallId: undefined, name: "memory-summarizer" }),
    row({ id: "child-1" }),
  ]);
  check(
    "an internal worker is not announced",
    scenario.emitted.every((u) => u.sessionUpdate !== "subagent_update" || u.sessionId === "child-1")
  );
  check(
    "…and is not handed to the child-attach callback",
    JSON.stringify(scenario.attached[0]?.ids) === JSON.stringify(["child-1"]),
    JSON.stringify(scenario.attached)
  );
  scenario.stop();
}

{
  const matrix = [
    ["running", "running", undefined],
    ["thinking", "running", undefined],
    ["responding", "running", undefined],
    ["compacting", "running", undefined],
    ["waiting", "requires_action", undefined],
    ["awaiting_user", "requires_action", undefined],
    ["completed", "idle", "end_turn"],
    ["aborted", "idle", "cancelled"],
    ["error", "idle", "error"],
    ["idle", "idle", undefined],
  ];
  for (const [status, state, stopReason] of matrix) {
    const scenario = projectorScenario();
    scenario.subagents([row({ status })]);
    const announcement = scenario.emitted.find((u) => u.sessionUpdate === "subagent_update");
    check(
      `status ${status} → ${state}${stopReason ? ` / ${stopReason}` : ""}`,
      announcement?.state?.state === state && announcement?.state?.stopReason === stopReason,
      JSON.stringify(announcement?.state)
    );
    scenario.stop();
  }
}

{
  const scenario = projectorScenario();
  scenario.subagents([row()]);
  const announced = scenario.emitted.length;
  scenario.subagents([row()]);
  check("an unchanged snapshot emits nothing", scenario.emitted.length === announced);

  scenario.subagents([row({ status: "completed" })]);
  const patch = scenario.emitted.at(-1);
  check(
    "a changed row is a patch, not a second announcement",
    patch?.sessionUpdate === "subagent_update" && patch.title === undefined && patch.state?.state === "idle",
    JSON.stringify(patch)
  );
  check("…and does not re-attach the child", scenario.attached.length === 1);

  const beforeRemoval = scenario.emitted.length;
  scenario.subagents([]);
  check(
    "a removed child is forgotten without inventing an idle update",
    scenario.emitted.length === beforeRemoval && JSON.stringify(scenario.attached.at(-1)?.ids) === "[]",
    JSON.stringify({ emitted: scenario.emitted.length, attached: scenario.attached.at(-1) })
  );
  scenario.stop();
}

{
  const scenario = projectorScenario();
  scenario.subagents([row({ status: "completed", taskPhase: "limit" })]);
  const announcement = scenario.emitted.find((u) => u.sessionUpdate === "subagent_update");
  check(
    "taskPhase travels in `_meta`, not in `state`",
    announcement?._meta?.taskPhase === "limit" && announcement?.state?.state === "idle",
    JSON.stringify({ meta: announcement?._meta, state: announcement?.state })
  );
  scenario.stop();
}

{
  // A task row's result is the formatted text (summary + status line), never the raw object.
  const taskCall = (state, over = {}) => ({
    id: "tc1",
    type: "tool-call",
    name: "task",
    input: { prompt: "find the tests", description: "find the tests" },
    arguments: JSON.stringify({ prompt: "find the tests", description: "find the tests" }),
    state,
    ...over,
  });
  const message = (part) => [{ id: "a1", role: "assistant", parts: [part] }];

  const scenario = projectorScenario();
  scenario.setMessages(message(taskCall("input-complete")));
  scenario.setMessages(
    message(taskCall("complete", { output: { summary: "found it in test/demo.test.mjs", iterations: 3 } }))
  );
  const terminal = scenario.emitted.filter((u) => u.toolCallId === "tc1").at(-1);
  const text = (terminal?.content ?? []).map((c) => c?.content?.text ?? "").join("");
  check("a task result is formatted for the reader", text.includes("found it in test/demo.test.mjs"), text);
  check("…and the row is not also given the raw output object", terminal?.rawOutput === undefined);

  // A live summary stream updates the same row; content REPLACES, so every frame re-sends the whole text.
  const stream = projectorScenario();
  stream.setMessages(message(taskCall("input-complete")));
  stream.push("summary", { type: "reset", key: "task:tc1", source: "task", toolCallId: "tc1", seq: 1 });
  stream.push("summary", { type: "append", key: "task:tc1", chunk: "searching the repo", seq: 2 });
  const streamed = stream.emitted.filter((u) => u.toolCallId === "tc1").at(-1);
  check(
    "a task summary chunk updates the task row's content",
    (streamed?.content ?? []).some((c) => c?.content?.text === "searching the repo"),
    JSON.stringify(streamed?.content)
  );

  stream.setMessages(message(taskCall("complete", { output: { summary: "final answer", iterations: 2 } })));
  const final = stream.emitted.filter((u) => u.toolCallId === "tc1").at(-1);
  // Reset first: the append throttle (300ms) would otherwise swallow this chunk for a reason that
  // has nothing to do with the result gate. A reset starts a fresh flush window, so the ONLY reason
  // this chunk may be dropped is that the row already received its final result.
  const beforeLate = stream.emitted.length;
  stream.push("summary", { type: "reset", key: "task:tc1", source: "task", toolCallId: "tc1", seq: 3 });
  stream.push("summary", { type: "append", key: "task:tc1", chunk: "late tail", seq: 4 });
  check(
    "a chunk after the final result is dropped",
    stream.emitted.length === beforeLate &&
      !(final?.content ?? []).some((c) => c?.content?.text?.includes("late tail")),
    JSON.stringify(stream.emitted.at(-1)?.content)
  );
  stream.stop();
  scenario.stop();
}

{
  // The result may arrive as a separate `tool-result` part (the call part then has no output). That
  // is the OTHER writer, and it must produce the same formatted text and dedupe a re-delivery.
  const call = {
    id: "tc2",
    type: "tool-call",
    name: "task",
    input: { prompt: "explore", description: "explore" },
    arguments: JSON.stringify({ prompt: "explore", description: "explore" }),
    state: "complete",
  };
  const result = {
    type: "tool-result",
    toolCallId: "tc2",
    state: "complete",
    output: { summary: "the answer", iterations: 4 },
  };
  const scenario = projectorScenario();
  scenario.setMessages([{ id: "a2", role: "assistant", parts: [call] }]);
  scenario.setMessages([{ id: "a2", role: "assistant", parts: [call, result] }]);
  const update = scenario.emitted.filter((u) => u.toolCallId === "tc2").at(-1);
  const text = (update?.content ?? []).map((c) => c?.content?.text ?? "").join("");
  check("a task result part is formatted too", text.includes("the answer") && update?.rawOutput === undefined, text);

  const beforeRepeat = scenario.emitted.length;
  scenario.setMessages([{ id: "a2", role: "assistant", parts: [call, result] }]);
  check("…and re-delivering the final result emits nothing", scenario.emitted.length === beforeRepeat);
  scenario.stop();
}

{
  // The prompt of a child is inter-session traffic, not a user turn: it must not look like the client
  // typed it. The conversion is by message id, so replay and live agree.
  const prompt = { id: "u1", role: "user", parts: [{ type: "text", content: "explore the repo" }] };
  const emitted = [];
  const session = {
    getSnapshot: () => baseSnapshot("child", { messages: [prompt] }),
    subscribe: () => () => undefined,
  };
  const projector = new AcpProjector(session, {
    rootPath: "/ws",
    emit: (update) => {
      emitted.push(update);
      validateUpdate(update);
    },
    commands: () => ({ builtin: [], extension: [] }),
    client: { compaction: true, notices: true, subagents: false },
    userMessageAsSessionMessage: {
      messageId: "u1",
      senderSessionId: "ses_parent",
      recipientSessionId: "child-1",
      acpMessageId: "task:tc1",
    },
  });
  projector.replayFrom(session.getSnapshot());
  projector.stop();
  const interSession = emitted.find((u) => u.sessionUpdate === "session_message");
  check(
    "a child prompt is `session_message` from the parent",
    interSession?.senderSessionId === "ses_parent" &&
      interSession?.recipientSessionId === "child-1" &&
      interSession?.messageId === "task:tc1" &&
      interSession?.content?.[0]?.text === "explore the repo",
    JSON.stringify(emitted)
  );
  check(
    "…not a `user_message_chunk` in the child session",
    emitted.every((u) => u.sessionUpdate !== "user_message_chunk")
  );
}

// ===========================================================================
// 2. Host: wiring, ownership, cleanup
// ===========================================================================

function makeSession(id, { messages = [] } = {}) {
  const listeners = new Set();
  let snapshot = baseSnapshot(id, { messages });
  let dispatched = [];
  return {
    id,
    getSnapshot: () => snapshot,
    getSummaryStreamSnapshot: () => null,
    setMessages: (next) => {
      snapshot = { ...snapshot, messages: next };
    },
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    listenerCount: () => listeners.size,
    push: (channel, payload) => {
      for (const listener of listeners) listener({ channel, payload, ts: Date.now() });
    },
    dispatch: async (command) => {
      dispatched.push(command);
      return { ok: true };
    },
    take: () => {
      const seen = dispatched;
      dispatched = [];
      return seen;
    },
  };
}

/**
 * Drive one ACP app over a fake host. `capability` decides whether the client is a subagent client.
 *
 * Everything runs INSIDE `connectWith` — once it returns, the connection is closed and no further
 * request/notification can be observed.
 */
async function hostScenario({ subagents }, run) {
  const prompt = { id: "u1", role: "user", parts: [{ type: "text", content: "explore the repo" }] };
  const parent = makeSession("parent");
  const child = makeSession("child-1", { messages: [prompt] });
  const events = [];
  const destroyed = [];
  const deleted = [];
  const connected = [];

  const client = createAcpClient({ name: "subagents-client" }).onNotification(methods.client.session.update, (ctx) => {
    events.push({ sessionId: ctx.params.sessionId, update: ctx.params.update });
    validateUpdate(ctx.params.update);
  });

  const app = createAcpAgent({
    host: {
      async create() {
        return { session: parent };
      },
      connect: (id) => {
        connected.push(id);
        return id === "child-1" ? child : null;
      },
      // Live agents include the child AND an internal worker that is never announced; the disk
      // catalog is separate and holds no child at all.
      list: () => [
        { agentId: "parent", name: "parent", status: "running", createdAt: 1, updatedAt: 2 },
        {
          agentId: "child-1",
          name: "find the tests",
          parentId: "parent",
          status: "running",
          createdAt: 1,
          updatedAt: 2,
        },
        {
          agentId: "worker-1",
          name: "memory-summarizer",
          parentId: "parent",
          status: "running",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      listPersistedSessions: () => [],
      async destroy(id) {
        destroyed.push(id);
      },
      async deleteSession(id) {
        deleted.push(id);
      },
    },
    defaults: { model: "fake-model" },
    rootPath: "/ws",
  });

  await client.connectWith(app, async (cx) => {
    await cx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        // `undefined` = absent, `null` = explicitly unsupported, `{}` = supported — all three are
        // legal protocol values and only the object form may enable the feature.
        ...(subagents === undefined ? {} : { subagents }),
        session: { compaction: true, notices: true },
      },
    });
    const started = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    await run({
      cx,
      started,
      parent,
      child,
      events,
      destroyed,
      deleted,
      connected,
      /** Notifications are sent asynchronously; one macrotask flushes the frames. */
      settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
      rejection: async (method, params) => {
        try {
          await cx.request(method, params);
          return undefined;
        } catch (error) {
          return error;
        }
      },
    });
  });
}

{
  await hostScenario({ subagents: {} }, async (scenario) => {
    const parentId = scenario.started.sessionId;

    scenario.parent.push("subagents", { subagents: [row()] });
    await scenario.settle();
    const announcement = scenario.events.find((e) => e.update.sessionUpdate === "subagent_update");
    check(
      "host: the parent announces the child",
      announcement?.sessionId === parentId &&
        announcement?.update.sessionId === "child-1" &&
        announcement?.update.title === "find the tests",
      JSON.stringify(announcement)
    );
    check("host: the child session is connected for projection", scenario.connected.includes("child-1"));

    const childPrompt = scenario.events.find(
      (e) => e.sessionId === "child-1" && e.update.sessionUpdate === "session_message"
    );
    check(
      "host: the child's prompt is a session_message from the parent",
      childPrompt?.update.senderSessionId === parentId &&
        childPrompt?.update.recipientSessionId === "child-1" &&
        childPrompt?.update.content?.[0]?.text === "explore the repo",
      JSON.stringify(childPrompt)
    );
    check(
      "host: the announcement is the FIRST frame naming the child",
      scenario.events.findIndex((e) => e.update.sessionUpdate === "session_message") >
        scenario.events.findIndex((e) => e.update.sessionUpdate === "subagent_update"),
      JSON.stringify(scenario.events.map((e) => [e.sessionId, e.update.sessionUpdate]))
    );

    scenario.child.setMessages([
      { id: "u1", role: "user", parts: [{ type: "text", content: "explore the repo" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", content: "the tests use node:test" },
          { id: "ct1", type: "tool-call", name: "grep", state: "input-complete", input: { pattern: "node:test" } },
        ],
      },
    ]);
    scenario.child.push("messages", scenario.child.getSnapshot().messages);
    await scenario.settle();
    const childText = scenario.events.find(
      (e) => e.sessionId === "child-1" && e.update.sessionUpdate === "agent_message_chunk"
    );
    check(
      "host: child transcript updates carry the child session id",
      childText?.update.content?.text?.includes("node:test"),
      JSON.stringify(childText)
    );
    check(
      "host: …including the child's tool calls",
      scenario.events.some(
        (e) => e.sessionId === "child-1" && e.update.sessionUpdate === "tool_call" && e.update.toolCallId === "ct1"
      ),
      JSON.stringify(scenario.events.filter((e) => e.sessionId === "child-1").map((e) => e.update.sessionUpdate))
    );
    scenario.child.push("usage", baseSnapshot("child-1").usage);
    await scenario.settle();
    check(
      "host: …and its usage",
      scenario.events.some((e) => e.sessionId === "child-1" && e.update.sessionUpdate === "usage_update"),
      JSON.stringify(scenario.events.filter((e) => e.sessionId === "child-1").map((e) => e.update.sessionUpdate))
    );

    const listed = await scenario.cx.request(methods.agent.session.list, {});
    check(
      "host: session/list never contains the child",
      !(listed.sessions ?? []).some((session) => session.sessionId === "child-1"),
      JSON.stringify(listed.sessions)
    );

    // Ownership: a child is not a root session.
    const workerLoad = await scenario.rejection(methods.agent.session.load, {
      sessionId: "worker-1",
      cwd: "/ws",
      mcpServers: [],
    });
    check(
      "host: a live child that was never announced is still refused",
      workerLoad?.code === -32602,
      String(workerLoad?.code)
    );
    const loads = await scenario.rejection(methods.agent.session.load, {
      sessionId: "child-1",
      cwd: "/ws",
      mcpServers: [],
    });
    check("host: `session/load` on a child is refused", loads?.code === -32602, String(loads?.code));
    const resumes = await scenario.rejection(methods.agent.session.resume, {
      sessionId: "child-1",
      cwd: "/ws",
      mcpServers: [],
    });
    check("host: `session/resume` on a child is refused", resumes?.code === -32602, String(resumes?.code));
    const prompts = await scenario.rejection(methods.agent.session.prompt, {
      sessionId: "child-1",
      prompt: [{ type: "text", text: "hi" }],
    });
    check("host: `session/prompt` on a child is refused", prompts?.code === -32602, String(prompts?.code));
    const forks = await scenario.rejection(methods.agent.session.fork, {
      sessionId: "child-1",
      cwd: "/ws",
      mcpServers: [],
    });
    check("host: `session/fork` from a child is refused", forks?.code === -32602, String(forks?.code));

    const deletion = await scenario.cx.request(methods.agent.session.delete, { sessionId: "child-1" });
    check(
      "host: deleting a child is an idempotent no-op (never `deleteSession`)",
      JSON.stringify(deletion) === "{}" && !scenario.deleted.includes("child-1"),
      JSON.stringify({ deletion, deleted: scenario.deleted })
    );
    const closing = await scenario.cx.request(methods.agent.session.close, { sessionId: "child-1" });
    check(
      "host: closing a child does not destroy it",
      JSON.stringify(closing) === "{}" && !scenario.destroyed.includes("child-1"),
      JSON.stringify({ closing, destroyed: scenario.destroyed })
    );

    // Closing the parent stops child projection; the child itself is not destroyed.
    await scenario.cx.request(methods.agent.session.close, { sessionId: parentId });
    const afterClose = scenario.events.length;
    scenario.child.push("messages", [
      { id: "u1", role: "user", parts: [{ type: "text", content: "explore the repo" }] },
      { id: "a2", role: "assistant", parts: [{ type: "text", content: "late child output" }] },
    ]);
    await scenario.settle();
    check("host: closing the parent stops child updates", scenario.events.length === afterClose);
    check(
      "host: …and unsubscribes the child projector",
      scenario.child.listenerCount() === 0,
      `listeners=${scenario.child.listenerCount()}`
    );
    check(
      "host: …without destroying the child session",
      scenario.destroyed.length > 0 && !scenario.destroyed.includes("child-1"),
      JSON.stringify(scenario.destroyed)
    );
  });
}

{
  await hostScenario({ subagents: null }, async (scenario) => {
    scenario.parent.push("subagents", { subagents: [row()] });
    await scenario.settle();
    check(
      "host: `subagents: null` is not support (no frame, no attach)",
      scenario.events.every((e) => e.update.sessionUpdate !== "subagent_update" && e.sessionId !== "child-1") &&
        !scenario.connected.includes("child-1"),
      JSON.stringify(scenario.events.map((e) => [e.sessionId, e.update.sessionUpdate]))
    );
  });
}

{
  await hostScenario({}, async (scenario) => {
    scenario.parent.push("subagents", { subagents: [row()] });
    await scenario.settle();
    check(
      "host: without the capability no subagent frame is sent",
      scenario.events.every((e) => e.update.sessionUpdate !== "subagent_update" && e.sessionId !== "child-1"),
      JSON.stringify(scenario.events.map((e) => [e.sessionId, e.update.sessionUpdate]))
    );
    check("host: …and the child session is never connected", !scenario.connected.includes("child-1"));
  });
}

for (const failure of schemaFailures) check(`protocol schema: ${failure}`, false);

finish(checker.failures);

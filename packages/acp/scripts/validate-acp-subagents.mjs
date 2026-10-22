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

import { AcpProjector } from "../dist/index.mjs";

import { createChecker, finish } from "./acp-report.mjs";
import { projectorScenario, row, schemaFailures, validateUpdate } from "./acp-subagent-scenario.mjs";
import { baseSnapshot } from "./session-fixture.mjs";

const checker = createChecker();
const check = checker.check;

// ===========================================================================
// 1. Projector: announcement gate, filtering, state mapping, task results
// ===========================================================================

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
    "…advertises no child mutations (`capabilities` omitted)",
    announcements[0]?.capabilities === undefined,
    JSON.stringify(announcements[0]?.capabilities)
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
  check(
    "…and the attach callback still names only the child (host attach is idempotent)",
    scenario.attached.length >= 1 && scenario.attached.every((entry) => JSON.stringify(entry.ids) === '["child-1"]'),
    JSON.stringify(scenario.attached)
  );

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
  scenario.setMessages([
    {
      id: "a9",
      role: "assistant",
      parts: [
        {
          id: "tc1",
          type: "tool-call",
          name: "task",
          input: { prompt: "fallback title from the task call" },
          arguments: '{"prompt":"fallback title from the task call"}',
          state: "input-complete",
        },
      ],
    },
  ]);
  scenario.subagents([row({ description: undefined, name: undefined })]);
  const announcement = scenario.emitted.find((u) => u.sessionUpdate === "subagent_update");
  check(
    "a row with no description/name falls back to the task prompt",
    announcement?.title === "fallback title from the task call" && announcement?.description === undefined,
    JSON.stringify({ title: announcement?.title, description: announcement?.description })
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
  stream.push("summary", {
    type: "reset",
    channel: "text",
    key: "task:tc1",
    source: "task",
    toolCallId: "tc1",
    seq: 1,
  });
  // Two chunks past the 300ms flush window: content REPLACES, so the second must carry BOTH.
  const realNow = Date.now;
  let clockOffset = 0;
  Date.now = () => realNow() + clockOffset;
  try {
    stream.push("summary", { type: "append", channel: "text", key: "task:tc1", chunk: "searching ", seq: 2 });
    clockOffset = 1000;
    stream.push("summary", { type: "append", channel: "text", key: "task:tc1", chunk: "the repo", seq: 3 });
  } finally {
    Date.now = realNow;
  }
  const streamed = stream.emitted.filter((u) => u.toolCallId === "tc1").at(-1);
  check(
    "a task summary update re-sends the ACCUMULATED text",
    (streamed?.content ?? []).some((c) => c?.content?.text === "searching the repo"),
    JSON.stringify(streamed?.content)
  );
  check(
    "…and the summary is not duplicated onto a child/message surface",
    stream.emitted.every(
      (u) =>
        (u.sessionUpdate !== "session_message" && u.sessionUpdate !== "agent_message_chunk") ||
        !JSON.stringify(u).includes("searching")
    ),
    JSON.stringify(stream.emitted.map((u) => u.sessionUpdate))
  );

  stream.setMessages(message(taskCall("complete", { output: { summary: "final answer", iterations: 2 } })));
  const final = stream.emitted.filter((u) => u.toolCallId === "tc1").at(-1);
  // Reset first: the append throttle (300ms) would otherwise swallow this chunk for a reason that
  // has nothing to do with the result gate. A reset starts a fresh flush window, so the ONLY reason
  // this chunk may be dropped is that the row already received its final result.
  const beforeLate = stream.emitted.length;
  stream.push("summary", {
    type: "reset",
    channel: "text",
    key: "task:tc1",
    source: "task",
    toolCallId: "tc1",
    seq: 3,
  });
  stream.push("summary", { type: "append", channel: "text", key: "task:tc1", chunk: "late tail", seq: 4 });
  check(
    "a chunk after the final result is dropped",
    stream.emitted.length === beforeLate &&
      !(final?.content ?? []).some((c) => c?.content?.text?.includes("late tail")),
    JSON.stringify(stream.emitted.at(-1)?.content)
  );

  // `end` should only stop the stream, never re-send the final text.
  const beforeEnd = stream.emitted.length;
  stream.push("summary", { type: "end", key: "task:tc1", seq: 5 });
  check("a summary `end` after the result emits nothing", stream.emitted.length === beforeEnd);

  // The formatted row is capability-independent (the only surface a non-subagent client has).
  const gated = projectorScenario({ client: { compaction: true, notices: true } });
  gated.setMessages(message(taskCall("complete", { output: { summary: "gated result", iterations: 1 } })));
  const gatedUpdate = gated.emitted.filter((u) => u.toolCallId === "tc1").at(-1);
  const gatedText = (gatedUpdate?.content ?? []).map((c) => c?.content?.text ?? "").join("");
  check("without `subagents` the task row is still formatted", gatedText.includes("gated result"), gatedText);
  gated.stop();
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
  // `session/load` replays stored rows. A persisted task result is either on the CALL part (`output`)
  // or only in the result part's raw-JSON `content` — both must render formatted, not as JSON.
  const src = baseSnapshot("parent");
  const call = {
    id: "tc3",
    type: "tool-call",
    name: "task",
    input: { prompt: "p", description: "p" },
    arguments: '{"prompt":"p","description":"p"}',
    state: "complete",
    output: { summary: "replayed result", reachedLimit: true },
  };
  const replay = projectorScenario();
  replay.projector.replayFrom({ ...src, messages: [{ id: "a3", role: "assistant", parts: [call] }] });
  const initial = replay.emitted.find((u) => u.sessionUpdate === "tool_call" && u.toolCallId === "tc3");
  const initialText = (initial?.content ?? []).map((c) => c?.content?.text ?? "").join("");
  check(
    "session/load formats a task output carried on the call part",
    initialText.includes("replayed result") &&
      initialText.includes("limit reached") &&
      initial?.rawOutput === undefined,
    initialText
  );
  replay.stop();

  const persisted = projectorScenario();
  persisted.projector.replayFrom({
    ...src,
    messages: [
      {
        id: "a4",
        role: "assistant",
        parts: [
          {
            id: "tc4",
            type: "tool-call",
            name: "task",
            input: {},
            arguments: "{}",
            state: "complete",
          },
        ],
      },
      {
        id: "t4",
        role: "tool",
        parts: [
          {
            type: "tool-result",
            toolCallId: "tc4",
            state: "complete",
            content: JSON.stringify({ summary: "from persistence", aborted: true }),
          },
        ],
      },
    ],
  });
  const persistedUpdate = persisted.emitted.filter((u) => u.toolCallId === "tc4").at(-1);
  const persistedText = (persistedUpdate?.content ?? []).map((c) => c?.content?.text ?? "").join("");
  check(
    "…and a persisted result part without `output` is parsed, not shown as raw JSON",
    persistedText.includes("from persistence") &&
      persistedText.includes("cancelled") &&
      persistedUpdate?.rawOutput === undefined,
    persistedText
  );
  persisted.stop();
}

{
  // A remote `connect()` returns an unhydrated shell, so the prompt id is unknown at attach. The
  // FIRST user message that arrives must still become a `session_message` (the live path used to
  // drop user messages entirely).
  const listeners = new Set();
  const emitted = [];
  let messages = [];
  const session = {
    getSnapshot: () => baseSnapshot("child", { messages }),
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
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
      senderSessionId: "ses_parent",
      recipientSessionId: "child-1",
      acpMessageId: "task:tc9",
    },
  });
  projector.start({ seedState: false });
  messages = [{ id: "u9", role: "user", parts: [{ type: "text", content: "late prompt" }] }];
  for (const listener of listeners) listener({ channel: "messages", payload: messages, ts: Date.now() });
  const late = emitted.find((u) => u.sessionUpdate === "session_message");
  check(
    "a prompt hydrated after attach is still a `session_message`",
    late?.messageId === "task:tc9" && late?.content?.[0]?.text === "late prompt",
    JSON.stringify(emitted)
  );
  projector.stop();
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

for (const failure of schemaFailures) check(`protocol schema: ${failure}`, false);

finish(checker.failures);

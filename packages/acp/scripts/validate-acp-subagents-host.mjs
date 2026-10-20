/**
 * Subagents over ACP — the HOST half: wiring, ownership, lifecycle.
 *
 * The projector half lives in `validate-acp-subagents.mjs`; this script drives `createAcpAgent` over a
 * fake host so the load/fork/retry/ownership paths are asserted against the real handlers. The two
 * are separate processes because each owns its own `schemaFailures` tally.
 *
 * Run: pnpm --filter @codent/acp run validate:acp:subagents
 */

import { methods } from "@agentclientprotocol/sdk";

import { createChecker, finish } from "./acp-report.mjs";
import { hostScenario, makeSession, row, schemaFailures } from "./acp-subagent-scenario.mjs";
import { baseSnapshot } from "./session-fixture.mjs";

const checker = createChecker();
const check = checker.check;

// ===========================================================================
// 2. Host: wiring, ownership, cleanup
// ===========================================================================

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
    const childChannels = scenario.child.subscriptions().at(-1) ?? [];
    check(
      "host: the child projector does not subscribe to interaction/subagents/extensions",
      ["interaction", "subagents", "extensions"].every((channel) => !childChannels.includes(channel)),
      JSON.stringify(childChannels)
    );
    scenario.child.push("state", { name: "subagent-explore", status: "running" });
    await scenario.settle();
    check(
      "host: a child state tick does not overwrite the roster title",
      scenario.events.every((e) => !(e.sessionId === "child-1" && e.update.sessionUpdate === "session_info_update")),
      JSON.stringify(scenario.events.filter((e) => e.sessionId === "child-1").map((e) => e.update.sessionUpdate))
    );
    check(
      "host: …and advertises no command surface",
      scenario.events.every(
        (e) => !(e.sessionId === "child-1" && e.update.sessionUpdate === "available_commands_update")
      )
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
    const setMode = await scenario.rejection(methods.agent.session.setMode, {
      sessionId: "child-1",
      modeId: "plan",
    });
    check("host: `session/set_mode` on a child is refused", setMode?.code === -32602, String(setMode?.code));
    const setConfig = await scenario.rejection(methods.agent.session.setConfigOption, {
      sessionId: "child-1",
      configId: "mode",
      value: "plan",
    });
    check(
      "host: `session/set_config_option` on a child is refused",
      setConfig?.code === -32602,
      String(setConfig?.code)
    );
    const setModel = await scenario.rejection("session/set_model", {
      sessionId: "child-1",
      modelId: "fake-model",
    });
    check("host: `session/set_model` on a child is refused", setModel?.code === -32602, String(setModel?.code));

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
  // P1: session/load must not leave the one-shot "skip child replay" flag set. The first delegation
  // after a load is NEW and owes the client its prompt.
  let loaded;
  await hostScenario(
    {
      subagents: {},
      create: async (options) => {
        if (options?.resumeSessionId === "ses_loaded") {
          loaded = makeSession("loaded");
          return { session: loaded };
        }
        return undefined;
      },
    },
    async (scenario) => {
      await scenario.cx.request(methods.agent.session.load, {
        sessionId: "ses_loaded",
        cwd: "/ws",
        mcpServers: [],
      });
      loaded.pushSubagents([row()]);
      await scenario.settle();
      check(
        "host: the FIRST child after `session/load` replays its prompt",
        scenario.events.some((e) => e.sessionId === "child-1" && e.update.sessionUpdate === "session_message"),
        JSON.stringify(scenario.events.map((e) => [e.sessionId, e.update.sessionUpdate]))
      );
    }
  );
}

{
  // D2: a `session/load`/`resume` on a LIVE parent re-establishes child associations (the client
  // invalidates cached child state on reconnect). The child projector is kept, so no replay.
  await hostScenario({ subagents: {} }, async (scenario) => {
    scenario.parent.pushSubagents([row()]);
    await scenario.settle();
    const announcements = () =>
      scenario.events.filter((e) => e.update.sessionUpdate === "subagent_update" && e.update.sessionId === "child-1");
    const before = announcements().length;
    const childFrames = scenario.events.filter((e) => e.sessionId === "child-1").length;
    await scenario.cx.request(methods.agent.session.load, {
      sessionId: scenario.started.sessionId,
      cwd: "/ws",
      mcpServers: [],
    });
    await scenario.settle();
    check(
      "host: load on a LIVE parent re-announces its children after the response",
      announcements().length > before,
      `${before} → ${announcements().length}`
    );
    check(
      "host: …without replaying the child transcript",
      scenario.events.filter((e) => e.sessionId === "child-1").length === childFrames,
      String(scenario.events.filter((e) => e.sessionId === "child-1").length - childFrames)
    );
  });
}

{
  // P2: a fork is a new parent. Children must be re-announced under the new id, not keep streaming
  // under an id the client was never told about in that session.
  await hostScenario({ subagents: {} }, async (scenario) => {
    scenario.parent.pushSubagents([row()]);
    await scenario.settle();
    const childFramesBefore = scenario.events.filter((e) => e.sessionId === "child-1").length;
    const forked = await scenario.cx.request(methods.agent.session.fork, {
      sessionId: scenario.started.sessionId,
      cwd: "/ws",
      mcpServers: [],
    });
    await scenario.settle();
    const newId = forked.sessionId;
    check(
      "host: `session/fork` re-announces live children under the NEW parent id",
      scenario.events.some(
        (e) => e.sessionId === newId && e.update.sessionUpdate === "subagent_update" && e.update.sessionId === "child-1"
      ),
      JSON.stringify(scenario.events.map((e) => [e.sessionId, e.update.sessionUpdate]))
    );
    check(
      "host: …and does not replay the child transcript",
      scenario.events.filter((e) => e.sessionId === "child-1").length === childFramesBefore,
      String(scenario.events.filter((e) => e.sessionId === "child-1").length - childFramesBefore)
    );

    scenario.child.push("messages", [
      { id: "u1", role: "user", parts: [{ type: "text", content: "explore the repo" }] },
      { id: "a4", role: "assistant", parts: [{ type: "text", content: "after the fork" }] },
    ]);
    await scenario.settle();
    const announcement = scenario.events.findIndex(
      (e) => e.sessionId === newId && e.update.sessionUpdate === "subagent_update"
    );
    const traffic = scenario.events.findIndex(
      (e) => e.sessionId === "child-1" && e.update.content?.text?.includes("after the fork")
    );
    check("host: child traffic after a fork follows its new announcement", announcement >= 0 && traffic > announcement);
  });
}

{
  // P4: `connect()` can transiently return null (destroyed between snapshot and connect, remote 404).
  // The next snapshot must retry, otherwise the client keeps a child row that never receives a frame.
  let attempts = 0;
  await hostScenario(
    {
      subagents: {},
      connect: (id, ctx) => {
        if (id !== "child-1") return null;
        attempts += 1;
        return attempts === 1 ? null : ctx.child;
      },
    },
    async (scenario) => {
      scenario.parent.pushSubagents([row()]);
      await scenario.settle();
      check(
        "host: a child whose session is not connectable yet has no transcript",
        scenario.events.every((e) => e.sessionId !== "child-1"),
        JSON.stringify(scenario.events.map((e) => [e.sessionId, e.update.sessionUpdate]))
      );
      scenario.parent.pushSubagents([row({ status: "completed" })]);
      await scenario.settle();
      check(
        "host: the next snapshot retries the child attach",
        scenario.events.some((e) => e.sessionId === "child-1" && e.update.sessionUpdate === "session_message"),
        JSON.stringify(scenario.events.map((e) => [e.sessionId, e.update.sessionUpdate]))
      );
    }
  );
}

{
  // ask_user over form elicitation: multi-select + a custom answer, and an empty accept.
  const requests = [];
  await hostScenario(
    {
      subagents: {},
      elicitation: { form: {} },
      onElicitation: async (ctx) => {
        requests.push(ctx.params);
        return ctx.params.toolCallId === "ask1"
          ? { action: "accept", content: { answer: ["a"], custom: "c" } }
          : { action: "accept", content: { answer: [] } };
      },
    },
    async (scenario) => {
      scenario.parent.push("interaction", {
        approvals: [],
        askUser: [
          { toolCallId: "ask1", question: "Pick many", options: ["a", "b"], multiSelect: true },
          { toolCallId: "ask2", question: "Pick one", options: ["x", "y"] },
        ],
      });
      const results = await scenario.waitFor(() => {
        const all = scenario.parent.commands().filter((command) => command.type === "addToolResult");
        return all.length >= 2 ? all : undefined;
      });
      const answer = results?.find((command) => command.toolCallId === "ask1");
      const empty = results?.find((command) => command.toolCallId === "ask2");
      check(
        "host: a form answer resolves the tool with selected + custom + multiSelect",
        answer?.output?.selected?.[0] === "a" &&
          answer?.output?.answer === "a, c" &&
          answer?.output?.multiSelect === true &&
          answer?.output?.draft === "c",
        JSON.stringify(answer)
      );
      check(
        "host: an empty accept is cancelled, not an empty answer",
        empty?.output?.cancelled === true,
        JSON.stringify(empty)
      );
      check(
        "host: both elicitation requests carried the session id",
        requests.length === 2 && requests.every((request) => request.sessionId === scenario.started.sessionId),
        JSON.stringify(requests.map((request) => request.sessionId))
      );
    }
  );
}

{
  // No form elicitation: the question is posted and the NEXT plain prompt becomes its answer — the
  // fallback used to settle cancelled at t=0, so there was nothing to reply to.
  await hostScenario({ subagents: {} }, async (scenario) => {
    scenario.parent.push("interaction", {
      approvals: [],
      askUser: [{ toolCallId: "ask1", question: "Which?", options: ["a", "b"], multiSelect: true }],
    });
    const asked = await scenario.waitFor(() =>
      scenario.events.find(
        (event) =>
          event.update.sessionUpdate === "agent_message_chunk" &&
          event.update.content?.text?.includes("The agent asked")
      )
    );
    check("host: without form elicitation the question is posted for a text answer", Boolean(asked));
    await scenario.cx.request(methods.agent.session.prompt, {
      sessionId: scenario.started.sessionId,
      prompt: [{ type: "text", text: "2" }],
    });
    const answer = await scenario.waitFor(() =>
      scenario.parent.commands().find((command) => command.type === "addToolResult")
    );
    check(
      "host: the next plain prompt answers the parked tool",
      answer?.output?.answer === "b" && answer?.output?.multiSelect === true && answer?.output?.cancelled === undefined,
      JSON.stringify(answer)
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

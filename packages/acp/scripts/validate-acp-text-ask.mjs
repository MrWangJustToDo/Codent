/**
 * `ask_user` on a client that does NOT advertise `elicitation.form`.
 *
 * That path has no client request to answer with, so the question is posted as an agent message and
 * the turn must be handed BACK (`end_turn`) with the tool still pending — the next plain-text prompt
 * is the answer. The prompt queue is what made this a dead end before: a parked `ask_user` keeps the
 * status ACTIVE, so the answering prompt used to queue behind the very turn it answers, and the tool
 * only ever settled through the interaction timeout.
 *
 * The second case is the precedence guard: a client that DOES advertise the capability must get the
 * form, not the text fallback.
 *
 * Run: pnpm --filter @codent/acp run validate:acp:text-ask
 */

import { methods } from "@agentclientprotocol/sdk";

import { createAcpAgent } from "../dist/index.mjs";

import { createChecker, finish } from "./acp-report.mjs";
import { makeHost, makeSession, runClient } from "./acp-session-double.mjs";

const checker = createChecker();
const check = checker.check;

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` is true, or give up after `timeoutMs`. */
async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await tick(20);
  }
  return predicate();
}

const ASK_TOOL_CALL = {
  type: "tool-call",
  id: "ask1",
  name: "ask_user",
  input: { question: "Continue?", options: ["yes", "no"] },
  state: "input-complete",
};

/**
 * A session parked on `ask_user` as soon as the turn starts, and completed once the answer arrives.
 * `onCommand` keeps `dispatched`, so the calls themselves are the assertions.
 */
function parkAskUser(id) {
  let built;
  const host = makeHost(
    () =>
      (built = makeSession({
        id,
        onCommand: async (command, api) => {
          if (command.type === "send") {
            api.setSnapshot({
              status: "awaiting_user",
              messages: [{ id: "m1", role: "assistant", parts: [ASK_TOOL_CALL] }],
            });
            api.emit("messages", api.snapshot.messages);
            api.emit("interaction", {
              approvals: [],
              askUser: [{ toolCallId: "ask1", question: "Continue?", options: ["yes", "no"] }],
            });
            api.emit("state", api.snapshot);
          }
          if (command.type === "addToolResult") {
            api.setSnapshot({ status: "completed", messages: api.snapshot.messages });
            api.emit("state", api.snapshot);
          }
          return { ok: true };
        },
      }))
  );
  return {
    host,
    get api() {
      return built?.api;
    },
    get dispatched() {
      return built?.api.dispatched ?? [];
    },
  };
}

// ===========================================================================
// 1. Without form elicitation: the turn ends and the next prompt answers
// ===========================================================================
{
  const session = parkAskUser("text-ask");
  const app = createAcpAgent({ host: session.host, defaults: { model: "fake-model" }, rootPath: "/ws" });

  let firstPrompt = "pending";

  await runClient(
    app,
    async (cx, updates) => {
      const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
      // The turn suspends on the question, so this request settles at the hand-back — never await it
      // alone before answering, or the case would hang exactly like the bug.
      void cx
        .request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] })
        .then(
          (result) => {
            firstPrompt = result.stopReason;
          },
          () => {
            firstPrompt = "rejected";
          }
        );

      await waitUntil(() => firstPrompt !== "pending");

      const questionText = updates
        .map((u) => u.update)
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => u.content?.text ?? "")
        .join("");
      check("the question is posted as an agent message", questionText.includes("Continue?"));
      check(
        "…with the numbered options the answer may name",
        questionText.includes("1. yes") && questionText.includes("2. no"),
        questionText
      );
      check("the turn is handed back while the tool is still pending (end_turn)", firstPrompt === "end_turn");
      check(
        "no tool result was invented for the parked question",
        session.dispatched.every((command) => command.type !== "addToolResult")
      );

      // The answer the fallback text asks for: a plain prompt naming an option.
      const answer = await cx.request(methods.agent.session.prompt, {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "2" }],
      });
      check("the answer prompt settles the parked tool (not a second turn)", answer.stopReason === "end_turn");

      const settled = session.dispatched.filter((command) => command.type === "addToolResult");
      check("exactly one tool result is dispatched", settled.length === 1, String(settled.length));
      check('the numbered answer maps to its option label ("no")', settled[0]?.output?.answer === "no");
      check("…and is not reported as cancelled", settled[0]?.output?.cancelled !== true);
      check("…and keeps the question's option nature", settled[0]?.output?.hasOptions === true);
    },
    {},
    // The whole point: no `elicitation` capability.
    { session: { notices: {}, compaction: {} } }
  );
}

// ===========================================================================
// 2. With form elicitation: the form is used, the text fallback is not
// ===========================================================================
{
  const session = parkAskUser("form-ask");
  const app = createAcpAgent({ host: session.host, defaults: { model: "fake-model" }, rootPath: "/ws" });

  let elicitationRequests = 0;
  const { updates } = await runClient(
    app,
    async (cx) => {
      const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
      await cx.request(methods.agent.session.prompt, {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "go" }],
      });
    },
    {
      [methods.client.elicitation.create]: async () => {
        elicitationRequests += 1;
        return { action: "accept", content: { answer: "yes" } };
      },
    }
  );

  const questionText = updates
    .map((u) => u.update)
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content?.text ?? "")
    .join("");
  check("a form-capable client gets elicitation/create", elicitationRequests === 1, String(elicitationRequests));
  check("…and no text fallback is posted", !questionText.includes("Reply with an option"));

  const settled = session.dispatched.filter((command) => command.type === "addToolResult");
  check("the form's answer settles the tool", settled[0]?.output?.answer === "yes");
}

finish(checker.failures);

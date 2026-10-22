/**
 * Validates what the LIVE path reports for a turn: the assistant text, and no echo of the prompt.
 *
 * The live path briefly echoed the user's message too (to give the stream a turn boundary). That is
 * the client's own row — `1` came back as `11` after a cancel, once the client stopped deduplicating a
 * row whose turn was gone — so the echo now lives only in the replay, where the client has nothing.
 * Injected `<ctx>` rows must never be reported either. Split out of `validate-acp.mjs`: a different
 * subject from its permission/session suites, and that file is at the line ceiling.
 *
 * Run: node scripts/validate-acp-live-turns.mjs
 */

import { client as createClient, methods } from "@agentclientprotocol/sdk";

import { createAcpAgent } from "../dist/index.mjs";

import { createChecker, finish } from "./acp-report.mjs";
import { baseSnapshot } from "./session-fixture.mjs";

const checker = createChecker();
const check = checker.check;

// ===========================================================================
// G2. A LIVE turn carries its boundary: the user message is reported, once
// ===========================================================================

// The live path used to report assistant text only. Two consecutive replies therefore arrived with
// nothing between them — a client can only render that as one run of text — and a `session/load`
// afterwards added a second copy of the whole conversation. The turn's user message is now part of
// the stream (as it always was in the replay), reported once, with injected context skipped.

let pushLiveMessages = null;
const liveTurnUpdates = [];
const liveTurnClient = createClient({ name: "live-turn-client" }).onNotification(methods.client.session.update, (ctx) =>
  liveTurnUpdates.push(ctx.params)
);
const liveTurnSession = (() => {
  const listeners = new Set();
  let messages = [];
  return {
    id: "agent_live",
    getSnapshot: () => baseSnapshot("agent_live", { messages }),
    getAgentStreamSnapshot: () => null,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispatch: async (command) => {
      if (command.type === "send") {
        messages = [
          { id: "u-live", role: "user", parts: [{ type: "text", content: "what changed?" }] },
          // Injected context: persisted for the model, never shown to a reader.
          { id: "ctx-live", role: "user", parts: [{ type: "text", content: "<ctx kind=mode>\nnormal\n</ctx>" }] },
          { id: "a-live", role: "assistant", parts: [{ type: "text", content: "the diff" }] },
        ];
        pushLiveMessages = () => {
          for (const listener of listeners) listener({ channel: "messages", payload: messages, ts: Date.now() });
        };
        pushLiveMessages();
      }
      return { ok: true };
    },
  };
})();
const liveTurnApp = createAcpAgent({
  host: {
    async create() {
      return { session: liveTurnSession };
    },
    connect: () => null,
    list: () => [],
    async destroy() {},
  },
  defaults: { model: "fake-model" },
  rootPath: "/ws",
});

await liveTurnClient.connectWith(liveTurnApp, async (cx) => {
  await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
  const started = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
  liveTurnUpdates.length = 0;
  await cx.request(methods.agent.session.prompt, {
    sessionId: started.sessionId,
    prompt: [{ type: "text", text: "what changed?" }],
  });
  const chunks = liveTurnUpdates
    .map((p) => p.update)
    .filter((u) => u.sessionUpdate === "user_message_chunk" || u.sessionUpdate === "agent_message_chunk");
  // A client that submits a prompt renders it itself: echoing it live is a duplicate turn (reported
  // as `1` → `11` after a cancel, when the client's own optimistic row stops being deduplicated). The
  // REPLAY is the half that must carry the user side — `validate-acp`'s session/load section covers it.
  check(
    "a live turn does NOT echo the user's prompt (the client authored it)",
    chunks.every((u) => u.sessionUpdate !== "user_message_chunk") && chunks.length > 0
  );
  check(
    "the live stream never reports an injected <ctx> row",
    !chunks.some((u) => (u.content?.text ?? "").includes("<ctx kind="))
  );
});

finish(checker.failures);

/**
 * What an ACP prompt turns into on its way to the session — the inbound content contract.
 *
 * A prompt is a list of `ContentBlock`s, and the one shape that keeps being "obvious" enough to be
 * special-cased into nothing is **an image with no text at all** (paste a screenshot, press enter).
 * There is no text to read, so any helper whose job is "extract the prompt text" naturally produces
 * `""`, and a `""` prompt is what a host refuses. That is the bug this pins: the blocks are mapped
 * positionally into parts, and a media-only prompt stays a media-only prompt all the way to
 * `dispatch` — no text is required for a turn to start.
 *
 * The other half is the form: a prompt that carries no non-text block must stay a **string**
 * (`AgentSessionMessageContent` accepts both, and the string form is smaller on the wire); the array
 * form appears as soon as one block is not text. Both halves are asserted here because a mapper that
 * always returns parts would still pass a "the image arrived" check.
 *
 * Run: pnpm --filter @codent/acp run validate:acp:prompt-content
 */

import { methods } from "@agentclientprotocol/sdk";

import { createAcpAgent, MEDIA_ONLY_INSTRUCTION } from "../dist/index.mjs";

import { createChecker, finish } from "./acp-report.mjs";
import { makeHost, makeSession, runClient } from "./acp-session-double.mjs";

const checker = createChecker();
const check = checker.check;

/** A 1×1 PNG. Any bytes would do; this one is a real image so a decoder in the chain cannot object. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

/**
 * Send one prompt through the real handlers over the real SDK transport and report what the session
 * was asked to do.
 *
 * The double returns `{ ok: true }` and leaves its snapshot at the fixture's `idle`, so the turn is
 * over as soon as it is accepted: `waitForTurnEnd` resolves without a stream, and the prompt result
 * is the hand-back. That is exactly the shape being pinned — acceptance is what matters, not a reply.
 */
async function sendPrompt(prompt, capabilities) {
  const host = makeHost(() => makeSession({ id: "content", onCommand: async () => ({ ok: true }) }));
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  let stopReason;
  let updates = [];
  let failure;
  try {
    const result = await runClient(
      app,
      async (cx, seen) => {
        const session = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
        const reply = await cx.request(methods.agent.session.prompt, { sessionId: session.sessionId, prompt });
        updates = seen;
        return reply.stopReason;
      },
      {},
      capabilities
    );
    stopReason = result.value;
  } catch (error) {
    failure = errorMessageOf(error);
  }
  const dispatched = host.created[0]?.api?.dispatched ?? [];
  return {
    stopReason,
    failure,
    sent: dispatched.filter((command) => command.type === "send"),
    assistantText: updates
      .map((update) => update.update)
      .filter((update) => update.sessionUpdate === "agent_message_chunk")
      .map((update) => update.content?.text ?? "")
      .join(""),
  };
}

function errorMessageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// ===========================================================================
// 1. An image with no text is a prompt, not an empty message
// ===========================================================================
{
  const { stopReason, failure, sent, assistantText } = await sendPrompt([
    { type: "image", data: PNG, mimeType: "image/png" },
  ]);
  const content = sent[0]?.content;

  check("an image-only prompt is accepted (no refusal, no empty-content filter)", failure === undefined, failure);
  check("…and the turn starts", sent.length === 1, JSON.stringify(sent.length));
  check(
    "…with the image as a content part, not as empty text",
    Array.isArray(content) && content[0]?.type === "image",
    JSON.stringify(content)
  );
  check(
    "…carrying the client's bytes and mime type through unchanged",
    content?.[0]?.source?.type === "data" &&
      content?.[0]?.source?.value === PNG &&
      content?.[0]?.source?.mimeType === "image/png",
    JSON.stringify(content?.[0]?.source ?? null)
  );
  // A picture with no words is not a question. Left alone the model has nothing to answer and a run
  // with no assistant text is reported as a turn that ended with no output at all.
  check(
    "…and a media-only prompt picks up the instruction that says so",
    Array.isArray(content) && content.at(-1)?.type === "text" && content.at(-1)?.content === MEDIA_ONLY_INSTRUCTION,
    JSON.stringify(content?.at(-1) ?? null)
  );
  check("…and the turn hands back (end_turn) rather than hanging", stopReason === "end_turn", stopReason);
  // The fake session streams nothing, so there is no agent text — stated so this case is not read as
  // "the agent answered": the assertion above is about the prompt reaching the session at all.
  check("…with no invented assistant text", assistantText === "", assistantText);
}

// ===========================================================================
// 1b. Whitespace is not a message either
// ===========================================================================
{
  const { sent } = await sendPrompt([
    { type: "image", data: PNG, mimeType: "image/png" },
    { type: "text", text: "   \n" },
  ]);
  const content = sent[0]?.content;

  check(
    "a blank text block next to an image still gets the instruction",
    Array.isArray(content) && content.at(-1)?.type === "text" && content.at(-1)?.content === MEDIA_ONLY_INSTRUCTION,
    JSON.stringify(content)
  );
}

// ===========================================================================
// 2. A text+image prompt keeps the client's block order
// ===========================================================================
{
  const { sent } = await sendPrompt([
    { type: "text", text: "what is wrong here?" },
    { type: "image", data: PNG, mimeType: "image/png" },
    { type: "text", text: "and here?" },
  ]);
  const content = sent[0]?.content;

  check(
    "a mixed prompt becomes parts in the client's order",
    Array.isArray(content) &&
      content.map((part) => part.type).join(",") === "text,image,text" &&
      content[0]?.content === "what is wrong here?" &&
      content[2]?.content === "and here?",
    JSON.stringify(content)
  );
  check(
    "…and a prompt that already says something gets no instruction bolted on",
    content.filter((part) => part.content === MEDIA_ONLY_INSTRUCTION).length === 0,
    JSON.stringify(content)
  );
}

// ===========================================================================
// 3. A text-only prompt stays the string form
// ===========================================================================
{
  const { sent } = await sendPrompt([
    { type: "text", text: "first" },
    { type: "text", text: "second" },
  ]);

  check(
    "a text-only prompt keeps the smaller string form",
    sent[0]?.content === "first\n\nsecond",
    JSON.stringify(sent[0]?.content)
  );
}

// ===========================================================================
// 4. `resource_link` is context, not a reason to drop the image
// ===========================================================================
{
  const { sent } = await sendPrompt([
    { type: "image", data: PNG, mimeType: "image/png" },
    { type: "resource_link", uri: "file:///ws/a.ts", name: "a.ts" },
  ]);
  const content = sent[0]?.content;

  check(
    "a link next to an image is kept as text beside it",
    Array.isArray(content) &&
      content.length === 2 &&
      content[0]?.type === "image" &&
      content[1]?.type === "text" &&
      content[1]?.content?.includes("a.ts"),
    JSON.stringify(content)
  );
}

finish(checker.failures);

/**
 * `prompt:submit` is one row per user message.
 *
 * Two paths release queued input themselves and already write one row per released message:
 * the chain pump's first phase and the post-compaction / post-error drain. The pump they start then
 * ran `prepareManagedAgentForRun`, whose message-derived rule wrote a SECOND row for the same text
 * (`source: "queued"` + `source: "user"`). The mark suppresses only that second row — extension
 * prompt hooks must still run, because they select memory / `before_agent_start` context.
 *
 * Run: pnpm --filter @codent/core run validate:prompt-submit-dedupe
 */

import assert from "node:assert/strict";

import { prepareManagedAgentForRun } from "../dist/dev.mjs";

const userMessages = [
  { id: "a0", role: "assistant", parts: [{ type: "text", content: "ready" }] },
  { id: "u1", role: "user", parts: [{ type: "text", content: "explain the build" }] },
];

function fakeHost({ promptRowsAlreadyEmitted }) {
  const events = [];
  let collected = null;
  let markConsumed = false;
  const host = {
    id: "agent-1",
    parentId: undefined,
    run: {
      setupAbortController: () => () => {},
      resetMaxOutputTokensOverride: () => {},
      setPromptlessTurn: () => {},
      consumePromptlessTurn: () => false,
      getCurrentRunId: () => null,
    },
    getStatus: () => "idle",
    setStatus: () => {},
    consumePrepareAsNewTurn: () => false,
    consumePrepareAsContinuation: () => false,
    consumePreparePromptRowsEmitted: () => {
      if (markConsumed) return false;
      markConsumed = true;
      return promptRowsAlreadyEmitted;
    },
    getStreamStartedAt: () => 1,
    setStreamStartedAt: () => {},
    setCurrentRunId: () => {},
    takePendingWakeCause: () => undefined,
    getCompaction: () => ({ resetReactiveCompactRetries: () => {} }),
    getUI: () => ({ getMessages: () => userMessages }),
    collectExtensionPromptHooks: async (prompt) => {
      collected = prompt;
    },
    emitEvent: (type, payload) => events.push({ type, payload }),
  };
  return { host, events, getCollected: () => collected };
}

// 1. A normal turn writes exactly one prompt row, and runs the extension hooks.
{
  const { host, events, getCollected } = fakeHost({ promptRowsAlreadyEmitted: false });
  await prepareManagedAgentForRun(host, { messages: userMessages });

  const prompts = events.filter((event) => event.type === "prompt:submit");
  assert.equal(prompts.length, 1, "a normal turn writes one prompt:submit row");
  assert.equal(prompts[0].payload.source, "user");
  assert.equal(prompts[0].payload.prompt, "explain the build");
  assert.equal(getCollected(), "explain the build", "and the extension prompt hooks still run");
}

// 2. The drain already wrote the queued row(s): the message-derived row is suppressed, the hooks are
//    NOT (they are what selects memory / before_agent_start context).
{
  const { host, events, getCollected } = fakeHost({ promptRowsAlreadyEmitted: true });
  await prepareManagedAgentForRun(host, { messages: userMessages });

  assert.equal(
    events.filter((event) => event.type === "prompt:submit").length,
    0,
    "a drain that already recorded the prompt does not record it twice"
  );
  assert.equal(getCollected(), "explain the build", "but the extension hooks still run for the turn");
}

// 3. The mark is consumed even when the row is suppressed, so the NEXT turn must still report its
//    own prompt (a leaked mark would silently drop every later row).
{
  const { host, events } = fakeHost({ promptRowsAlreadyEmitted: true });
  await prepareManagedAgentForRun(host, { messages: userMessages });
  await prepareManagedAgentForRun(host, { messages: userMessages });
  assert.equal(
    events.filter((event) => event.type === "prompt:submit").length,
    1,
    "the mark is one-shot: the next turn reports its prompt normally"
  );
}

console.log("prompt-submit-dedupe validation passed");

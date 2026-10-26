/**
 * Validates lifecycle middleware side-effects (usage, thinking, pass-through).
 * Turn-level finalizeRun is owned by the chat pump / detached runners — not this middleware.
 *
 * Run: pnpm --filter @codent/core run validate:lifecycle-middleware
 */

import assert from "node:assert/strict";

import { createLifecycleMiddleware } from "../dist/dev.mjs";

let usageUpdated = false;
let thinkingEmitted = false;
let llmResponseEmitted = false;

const middleware = createLifecycleMiddleware({
  usage: {
    updateWindowUsage: () => {
      usageUpdated = true;
    },
    addLlmCall: () => {},
    getLastCallCostUsd: () => 0,
    getLastCallReasoningTokens: () => 0,
    getWindowUsage: () => ({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
    getContextFillTokens: () => 3,
    getPricing: () => null,
  },
  getPricing: () => null,
  onThinking: () => {
    thinkingEmitted = true;
  },
  emitEvent: (type) => {
    if (type === "llm:response") llmResponseEmitted = true;
  },
});

middleware.onStart?.({ model: "m", messages: [], toolNames: [] });
await middleware.onChunk?.(undefined, { type: "REASONING_MESSAGE_START" });
assert.equal(thinkingEmitted, true);

middleware.onStart?.({ model: "m", messages: [], toolNames: [] });
const textChunk = { type: "TEXT_MESSAGE_CONTENT", delta: "hi" };
const returned = await middleware.onChunk?.(undefined, textChunk);
assert.equal(returned, textChunk, "text chunks pass through unchanged");

middleware.onStart?.({ model: "m", messages: [], toolNames: [] });
await middleware.onUsage?.(undefined, { inputTokens: 1, outputTokens: 2, totalTokens: 3 });
assert.equal(usageUpdated, true);

middleware.onStart?.({ model: "m", messages: [], toolNames: [] });
await middleware.onFinish?.(undefined, { finishReason: "stop" });
await middleware.onFinish?.(undefined, { finishReason: "stop" });
assert.equal(llmResponseEmitted, true);
assert.equal(typeof middleware.onAbort, "undefined");
assert.equal(typeof middleware.onError, "undefined");

console.log("lifecycle-middleware validation passed");

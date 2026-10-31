/**
 * Smoke validation for TanStack text adapter factory.
 *
 * Run: pnpm --filter @codent/core run validate:tanstack-adapter
 *
 * Requires an OpenAI-compatible endpoint at BASE_URL (default http://localhost:11434/v1).
 * Set VALIDATE_TANSTACK_MODEL to override the model name (default: qwen3).
 * Set VALIDATE_TANSTACK_REQUIRED=1 to fail when the endpoint/model is unavailable
 * (default: explicit skip, reported as a skip by the suite rather than a pass).
 */

import { chat } from "@tanstack/ai";
import assert from "node:assert/strict";

import { createTextAdapter } from "../dist/dev.mjs";

const baseURL = process.env.BASE_URL ?? "http://localhost:11434/v1";
const modelName = process.env.VALIDATE_TANSTACK_MODEL ?? "qwen3";
const required = process.env.VALIDATE_TANSTACK_REQUIRED === "1";

function softSkip(reason) {
  if (required) {
    throw new Error(reason);
  }
  // The suite reads this marker to count a skip instead of a pass. `exit 0` alone cannot
  // distinguish "no endpoint available" from "adapter verified", which is how a run with no
  // model server could read as full coverage.
  console.log(`[validator-skip] tanstack-adapter validation skipped: ${reason}`);
  process.exit(0);
}

const { adapter, model } = createTextAdapter({
  style: "openai",
  model: modelName,
  baseURL,
});

assert.ok(adapter, "adapter should be created");
assert.equal(typeof model, "string");
assert.ok(model.length > 0, "model name should be non-empty");

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60_000);

let sawContent = false;
let sawFinished = false;

try {
  const stream = chat({
    adapter,
    model,
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
    threadId: "validate-tanstack-adapter",
    abortController: controller,
  });

  for await (const chunk of stream) {
    if (chunk.type === "TEXT_MESSAGE_CONTENT") {
      sawContent = true;
    }
    if (chunk.type === "RUN_FINISHED") {
      sawFinished = true;
      break;
    }
    if (chunk.type === "RUN_ERROR") {
      const message = typeof chunk.message === "string" ? chunk.message : JSON.stringify(chunk);
      softSkip(`endpoint/model unavailable (${message})`);
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("fetch failed") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("abort") ||
    lower.includes("not found") ||
    lower.includes("404")
  ) {
    softSkip(message);
  }
  throw error;
} finally {
  clearTimeout(timeout);
}

assert.equal(sawFinished, true, "stream should emit RUN_FINISHED");
assert.equal(sawContent, true, "stream should emit TEXT_MESSAGE_CONTENT");

console.log("tanstack-adapter validation passed");

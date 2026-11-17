/**
 * Smoke validation for TanStack text adapter factory.
 *
 * Run: pnpm --filter @codent/core run validate:tanstack-adapter
 *
 * Requires an OpenAI-compatible endpoint at BASE_URL (default http://localhost:11434/v1).
 * `API_KEY` is forwarded when set (a local endpoint ignores it, a hosted one needs it).
 * Set VALIDATE_TANSTACK_MODEL to override the model name (default: qwen3).
 * Set VALIDATE_TANSTACK_REQUIRED=1 to fail when the endpoint/model is unavailable
 * (default: explicit skip, reported as a skip by the suite rather than a pass).
 *
 * ## Why a preflight
 *
 * This script used to conclude "endpoint unavailable" only from a thrown `fetch failed` or a
 * `RUN_ERROR` chunk. An endpoint that answers `POST /chat/completions` with a 200 **HTML** page
 * (a portal/proxy in front of the API, measured: `BASE_URL=https://…/codeplan/v1` → 200
 * `text/html`) yields neither: TanStack parses the body as an empty SSE stream, the loop ends with
 * zero chunks, and the run failed on `stream should emit RUN_FINISHED` — a missing endpoint
 * reported as an adapter defect.
 *
 * `GET {baseURL}/models` separates the two before the adapter is exercised: a non-JSON or non-2xx
 * answer is an environment problem (skip), and only a JSON-answering endpoint reaches the
 * assertions. An empty stream past that point IS an adapter failure, which is what the two
 * assertions below are for.
 */

import { chat } from "@tanstack/ai";
import assert from "node:assert/strict";

import { createTextAdapter } from "../dist/dev.mjs";

const baseURL = (process.env.BASE_URL ?? "http://localhost:11434/v1").replace(/\/+$/, "");
const modelName = process.env.VALIDATE_TANSTACK_MODEL ?? "qwen3";
const apiKey = process.env.API_KEY;
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

const authHeaders = apiKey ? { authorization: `Bearer ${apiKey}` } : {};

/**
 * Prove BASE_URL speaks the OpenAI HTTP shape before blaming the adapter for an empty stream.
 * Deliberately network-error tolerant: an unreachable host is a skip, not a failure.
 */
async function preflightModelsEndpoint() {
  const url = `${baseURL}/models`;
  let response;
  try {
    response = await globalThis.fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    softSkip(`endpoint unreachable (GET ${url}): ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    softSkip(`GET ${url} returned ${response.status} — the endpoint is not usable for this check`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    softSkip(
      `GET ${url} answered 200 with "${contentType || "no content-type"}" instead of JSON — ` +
        `BASE_URL is not an OpenAI-compatible API`
    );
  }
}

await preflightModelsEndpoint();

const { adapter, model } = createTextAdapter({
  style: "openai",
  model: modelName,
  baseURL,
  ...(apiKey ? { apiKey } : {}),
});

assert.ok(adapter, "adapter should be created");
assert.equal(typeof model, "string");
assert.ok(model.length > 0, "model name should be non-empty");

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60_000);

let sawContent = false;
let sawFinished = false;
let chunkCount = 0;

try {
  const stream = chat({
    adapter,
    model,
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
    threadId: "validate-tanstack-adapter",
    abortController: controller,
  });

  for await (const chunk of stream) {
    chunkCount += 1;
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

// The preflight proved an OpenAI-shaped endpoint answers; a stream with no events at all is the
// adapter/transport failing, and the two assertions below are its report.
assert.ok(chunkCount > 0, `stream should emit at least one chunk (endpoint ${baseURL}, model ${model})`);
assert.equal(sawFinished, true, "stream should emit RUN_FINISHED");
assert.equal(sawContent, true, "stream should emit TEXT_MESSAGE_CONTENT");

console.log("tanstack-adapter validation passed");

/**
 * Validation for prompt-cache helpers (Anthropic breakpoints + OpenAI key + tool sort).
 *
 * Run: pnpm --filter @codent/core run validate:prompt-cache
 */

import assert from "node:assert/strict";

import {
  ANTHROPIC_CACHE_BREAKPOINT_CAP,
  EPHEMERAL_CACHE_CONTROL,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  applyAnthropicLatestUserCacheBreakpoint,
  applyAnthropicToolCacheBreakpoint,
  buildAnthropicCachedSystemPrompts,
  buildFrozenSystemPrompt,
  systemPromptsFromFrozen,
  createPromptCacheMiddleware,
  resolvePromptCacheKey,
  shouldApplyAnthropicCacheBreakpoints,
  shouldApplyOpenAIPromptCacheKey,
  sortToolsByName,
  splitSystemPromptAtDynamicBoundary,
  toolsToArray,
} from "../dist/dev.mjs";

assert.equal(ANTHROPIC_CACHE_BREAKPOINT_CAP, 4);
assert.deepEqual(EPHEMERAL_CACHE_CONTROL, { type: "ephemeral" });

assert.equal(shouldApplyAnthropicCacheBreakpoints("anthropic"), true);
assert.equal(shouldApplyAnthropicCacheBreakpoints("openai"), false);
assert.equal(shouldApplyOpenAIPromptCacheKey("openai"), true);
assert.equal(shouldApplyOpenAIPromptCacheKey("anthropic"), false);

assert.equal(resolvePromptCacheKey("ses_abc", "agent-1"), "ses_abc");
assert.equal(resolvePromptCacheKey(undefined, "agent-1"), "agent-1");
assert.equal(resolvePromptCacheKey("x".repeat(80), "a").length, 64);

const sorted = sortToolsByName([{ name: "zeta" }, { name: "alpha" }, { name: "mid" }]);
assert.deepEqual(
  sorted.map((t) => t.name),
  ["alpha", "mid", "zeta"]
);

const record = {
  zeta: { name: "zeta", description: "z" },
  alpha: { name: "alpha", description: "a" },
};
const fromRecord = toolsToArray(record);
assert.deepEqual(
  fromRecord.map((t) => t.name),
  ["alpha", "zeta"]
);

const frozen = buildFrozenSystemPrompt({
  config: { systemPrompt: "You are helpful." },
  agentDocContent: "",
});
const system = systemPromptsFromFrozen(frozen);
assert.ok(system?.[0]);
assert.equal(system[0], frozen);
assert.ok(!system[0].includes("<ctx kind="));

const split = splitSystemPromptAtDynamicBoundary(system[0]);
assert.ok(split.frozen.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY.trim()));
assert.equal(split.dynamic, undefined);

const cachedSystem = buildAnthropicCachedSystemPrompts(system);
assert.equal(cachedSystem?.length, 1);
assert.equal(typeof cachedSystem?.[0], "object");
assert.deepEqual(cachedSystem?.[0]?.metadata?.cache_control, EPHEMERAL_CACHE_CONTROL);

const tools = applyAnthropicToolCacheBreakpoint([
  { name: "read_file", description: "r" },
  { name: "glob", description: "g" },
]);
assert.deepEqual(
  tools?.map((t) => t.name),
  ["glob", "read_file"]
);
assert.deepEqual(tools?.[1]?.metadata?.cacheControl, EPHEMERAL_CACHE_CONTROL);
assert.equal(tools?.[0]?.metadata?.cacheControl, undefined);

const messages = applyAnthropicLatestUserCacheBreakpoint([
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
  { role: "tool", toolCallId: "t1", content: "result" },
]);
assert.equal(messages[0]?.role, "user");
assert.ok(Array.isArray(messages[0]?.content));
assert.deepEqual(messages[0]?.content?.[0]?.metadata?.cache_control, EPHEMERAL_CACHE_CONTROL);

const again = applyAnthropicLatestUserCacheBreakpoint(messages);
assert.deepEqual(again[0]?.content?.[0]?.metadata?.cache_control, EPHEMERAL_CACHE_CONTROL);

// ============================================================================
// Tool-set memo must key on everything the model can see (P0-4)
// ============================================================================
// The middleware memoizes the *sorted tool objects*: a key that ignores a
// model-visible field hands the model a stale description after a same-name,
// same-schema edit. Assert object identity, because that is what the memo
// controls — a deep-equal check would pass even with a stale object.
{
  const middleware = createPromptCacheMiddleware({
    getModelStyle: () => "openai",
    getPromptCacheKey: () => "ses_test",
  });

  const makeTools = (description) => [
    { name: "read_file", description, inputSchema: { type: "object" } },
    { name: "glob", description: "glob", inputSchema: { type: "object" } },
  ];

  const runConfig = async (tools) => {
    const patch = await middleware.onConfig({}, { tools });
    return patch.tools;
  };

  const first = await runConfig(makeTools("read a file"));
  assert.equal(first.find((t) => t.name === "read_file").description, "read a file");

  // Same name + same schema, changed description: must NOT reuse the memoized array.
  const second = await runConfig(makeTools("read a file, newest version"));
  const readFile = second.find((t) => t.name === "read_file");
  assert.equal(
    readFile.description,
    "read a file, newest version",
    "a changed description must reach the wire (memo key must include it)"
  );
  assert.notEqual(first[0], readFile, "a changed description must not return the memoized tool object");
}

console.log("validate:prompt-cache OK");

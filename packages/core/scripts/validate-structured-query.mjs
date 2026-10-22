/**
 * Validation for the structured branch of `runSideTextQuery` (no network).
 *
 * The structured overload is driven by a fake adapter that emits the exact event
 * shape a real provider produces — `TEXT_MESSAGE_CONTENT` deltas, a terminal
 * `structured-output.complete` CUSTOM event, and `RUN_FINISHED` carrying usage —
 * so the port's behaviour is asserted without an API key.
 *
 * Run: pnpm --filter @codent/core run validate:structured-query
 */

import assert from "node:assert/strict";
import { z } from "zod";

import {
  runSideTextQuery,
  SIDE_QUERY_MIN_OUTPUT_TOKENS,
  sharedUsageHistory,
  logCategorySchema,
  logEntrySchema,
  maxTokensOption,
} from "../dist/dev.mjs";

// ---------------------------------------------------------------------------
// Fake adapter
// ---------------------------------------------------------------------------

const personSchema = z.object({ name: z.string(), age: z.number() });

const usageChunk = (promptTokens, completionTokens) => ({
  type: "RUN_FINISHED",
  usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
});

const completeChunk = (object, raw) => ({
  type: "CUSTOM",
  name: "structured-output.complete",
  value: { object, raw },
});

const runErrorChunk = (message) => ({ type: "RUN_ERROR", error: new Error(message) });

/**
 * Build a text-adapter config whose underlying adapter yields `chunks`.
 *
 * `runSideTextQuery` passes no tools, so the engine takes its tool-less
 * structured path and consumes `structuredOutputStream` directly; the text path
 * consumes `chatStream`. The structured call records the request options the
 * engine handed the adapter, so the token-cap key can be asserted.
 */
const makeTextAdapterConfig = ({ structured = [], text = [], modelStyle = "openai" } = {}) => {
  const seen = [];
  return {
    seen,
    model: "fake-model",
    modelStyle,
    adapter: {
      kind: "text",
      name: "fake",
      model: "fake-model",
      "~types": {},
      chatStream() {
        return (async function* () {
          for (const chunk of text) yield chunk;
        })();
      },
      async structuredOutput() {
        throw new Error("not implemented");
      },
      structuredOutputStream(options) {
        seen.push(options?.chatOptions?.modelOptions ?? {});
        return (async function* () {
          for (const chunk of structured) yield chunk;
        })();
      },
    },
  };
};

const makeCapturingLog = () => {
  const entries = [];
  return {
    entries,
    warn(category, message, data) {
      entries.push({ category, message, data });
      return null;
    },
    info: () => null,
    debug: () => null,
    error: () => null,
  };
};

// ---------------------------------------------------------------------------
// 2.1 / 2.2 — validated object + usage
// ---------------------------------------------------------------------------

{
  const textAdapter = makeTextAdapterConfig({
    structured: [
      { type: "TEXT_MESSAGE_CONTENT", delta: '{"name":"Ada","age":36}' },
      completeChunk({ name: "Ada", age: 36 }, '{"name":"Ada","age":36}'),
      usageChunk(120, 30),
    ],
  });

  const result = await runSideTextQuery(textAdapter, {
    systemPrompt: "extract a person",
    userPrompt: "Ada is 36",
    schema: personSchema,
  });

  assert.deepEqual(result.data, { name: "Ada", age: 36 }, "the validated object is returned");
  assert.equal(result.raw, '{"name":"Ada","age":36}', "the raw text is returned alongside it");
  assert.equal(typeof result.durationMs, "number");

  // 2.2 — usage must survive. The `Promise<T>` form of `chat({ outputSchema })`
  // drops usage entirely, so this assertion is what pins the `stream: true`
  // choice; the 2.4 mutation removes the capture and expects this to fail.
  assert.ok(result.usage, "usage is reported on the structured path");
  assert.equal(result.usage.inputTokens, 120);
  assert.equal(result.usage.outputTokens, 30);

  console.log("✓ validated object + usage");
}

// ---------------------------------------------------------------------------
// 2.2c — the schema's transforms are applied, not just its checks
// ---------------------------------------------------------------------------
//
// A schema may normalize a value (clamping a range, uppercasing a tag). The
// port must return the *transformed* result: validating via `~standard` and then
// returning the raw object would silently drop every transform the schema
// declares, and memory's importance/expiresAt handling depends on it.

{
  const transformed = z.object({
    name: z.string(),
    tag: z.string().transform((value) => value.toUpperCase()),
  });
  const textAdapter = makeTextAdapterConfig({
    structured: [completeChunk({ name: "Ada", tag: "agent" }, '{"name":"Ada","tag":"agent"}')],
  });

  const result = await runSideTextQuery(textAdapter, { userPrompt: "x", schema: transformed });

  assert.deepEqual(result.data, { name: "Ada", tag: "AGENT" }, "the schema's transform is applied to the result");

  console.log("✓ schema transforms are applied");
}

// ---------------------------------------------------------------------------
// 2.2d — the output-token cap is named the way the adapter reads it
// ---------------------------------------------------------------------------
//
// `modelOptions` is spread verbatim into the provider request body, and the
// adapters deliberately do not read a generic `maxTokens` (the SDK annotates it
// as "no adapter reads it"). A cap sent under the wrong name is silently
// ignored, so the bound this port advertises would not exist. Pinning the key
// here is what keeps that from regressing unnoticed.
//
// The cap goes through the port's thinking-aware floor (`applySideQueryOutputFloor`, see
// `side-query-budget.ts`), so the *value* is intentionally not what the caller passed — a
// below-floor cap is raised so thinking cannot consume the whole budget. What this section
// guards is the **key**, which is the part that silently does nothing when it is wrong; the
// floor's own value is asserted in `validate-side-text-query`.

{
  const openaiAdapter = makeTextAdapterConfig({
    structured: [completeChunk({ name: "Ada", age: 1 }, "{}")],
  });
  await runSideTextQuery(openaiAdapter, { userPrompt: "x", schema: personSchema, maxOutputTokens: 20 });
  assert.deepEqual(
    Object.keys(openaiAdapter.seen[0]),
    ["max_completion_tokens"],
    "an openai-style structured query caps output with `max_completion_tokens`"
  );
  assert.ok(
    openaiAdapter.seen[0].max_completion_tokens >= SIDE_QUERY_MIN_OUTPUT_TOKENS,
    "the openai cap is floored above the thinking budget"
  );

  const anthropicAdapter = makeTextAdapterConfig({
    modelStyle: "anthropic",
    structured: [completeChunk({ name: "Ada", age: 1 }, "{}")],
  });
  await runSideTextQuery(anthropicAdapter, { userPrompt: "x", schema: personSchema, maxOutputTokens: 20 });
  assert.deepEqual(
    Object.keys(anthropicAdapter.seen[0]),
    ["max_tokens"],
    "an anthropic-style structured query caps output with `max_tokens`"
  );
  assert.ok(
    anthropicAdapter.seen[0].max_tokens >= SIDE_QUERY_MIN_OUTPUT_TOKENS,
    "the anthropic cap is floored above the thinking budget"
  );

  // Omitting the cap must not invent one.
  const uncapped = makeTextAdapterConfig({ structured: [completeChunk({ name: "Ada", age: 1 }, "{}")] });
  await runSideTextQuery(uncapped, { userPrompt: "x", schema: personSchema });
  assert.ok(
    !/max_tokens|maxTokens|max_completion_tokens/.test(JSON.stringify(uncapped.seen[0])),
    "no cap is sent when the caller did not ask for one"
  );

  console.log("✓ the output-token cap uses the adapter's native key");
}

// ---------------------------------------------------------------------------
// 2.2e — the shared helper keeps both call sites on the native key
// ---------------------------------------------------------------------------
//
// `AgentRunner` (the conversational run loop) and this port both build their
// `modelOptions` with the same helper. Asserting the helper directly is what
// protects the run loop, whose cap also feeds max-tokens-continue: an escalation
// there is logged as "escalating max_tokens" but does nothing if the key is wrong.

{
  assert.deepEqual(maxTokensOption("openai", 100), { max_completion_tokens: 100 });
  assert.deepEqual(maxTokensOption("anthropic", 100), { max_tokens: 100 });
  assert.deepEqual(maxTokensOption(undefined, 100), { max_completion_tokens: 100 });
  assert.deepEqual(maxTokensOption("openai", undefined), {}, "no cap -> no key");
  assert.ok(
    !("maxTokens" in maxTokensOption("openai", 5)),
    "the generic `maxTokens` spelling is never produced — no adapter reads it"
  );

  console.log("✓ the shared cap helper never emits the unread `maxTokens` key");
}

// ---------------------------------------------------------------------------
// 2.2b — usage is attributed to the shared side-query contributor
// ---------------------------------------------------------------------------
//
// `sharedUsageHistory.record` is fire-and-forget (it appends to a workspace
// JSONL file), so the assertion spies on the call rather than reading the file
// back — reading would require a registered CoreEnv and a real workspace.

{
  const recorded = [];
  const original = sharedUsageHistory.record.bind(sharedUsageHistory);
  sharedUsageHistory.record = (input) => {
    recorded.push(input);
  };

  try {
    const textAdapter = makeTextAdapterConfig({
      structured: [completeChunk({ name: "Ada", age: 3 }, '{"name":"Ada","age":3}'), usageChunk(40, 10)],
    });
    await runSideTextQuery(textAdapter, { userPrompt: "x", schema: personSchema });
  } finally {
    sharedUsageHistory.record = original;
  }

  assert.equal(recorded.length, 1, "the structured query records exactly one usage entry");
  assert.equal(recorded[0].agentId, "side-query", "attributed to the internal side-query contributor");
  assert.equal(recorded[0].model, "fake-model");
  assert.equal(recorded[0].usage.totalTokens, 50);
  assert.equal(typeof recorded[0].costUsd, "number", "cost is computed (0 when the adapter has no pricing)");

  console.log("✓ usage recorded against the side-query contributor");
}

// ---------------------------------------------------------------------------
// 2.3 — schema violation throws, never returns a partial object
// ---------------------------------------------------------------------------

{
  const textAdapter = makeTextAdapterConfig({
    structured: [
      { type: "TEXT_MESSAGE_CONTENT", delta: '{"name":"Ada"}' },
      completeChunk({ name: "Ada" }, '{"name":"Ada"}'),
      usageChunk(10, 5),
    ],
  });

  await assert.rejects(
    () => runSideTextQuery(textAdapter, { userPrompt: "x", schema: personSchema }),
    /schema validation/i,
    "an object that does not satisfy the schema must throw"
  );

  console.log("✓ schema violation throws");
}

// ---------------------------------------------------------------------------
// 2.3b — no completion event at all must throw, not return undefined
// ---------------------------------------------------------------------------

{
  const textAdapter = makeTextAdapterConfig({
    structured: [{ type: "TEXT_MESSAGE_CONTENT", delta: "not json" }, usageChunk(10, 5)],
  });

  await assert.rejects(
    () => runSideTextQuery(textAdapter, { userPrompt: "x", schema: personSchema }),
    // The engine reports a missing structured result as its own ``RUN_ERROR``
    // (0.54.0: "emit only RUN_ERROR if parsing fails"), so the port surfaces the
    // engine's reason rather than its own fallback text. Either way it must
    // throw rather than return undefined.
    (err) => {
      assert.ok(err instanceof Error, "a missing completion event throws an Error");
      assert.ok(err.message.trim().length > 0, "the error carries a reason");
      return true;
    },
    "a missing completion event must throw"
  );

  console.log("✓ missing completion event throws");
}

// ---------------------------------------------------------------------------
// 2.4 — usage must not be droppable (mutation target)
// ---------------------------------------------------------------------------
//
// If the structured branch stopped capturing `RUN_FINISHED.usage`, the assertion
// above would see `undefined`. Kept as its own case so the intent survives a
// refactor of the block above, and so the mutation is unambiguous.

{
  const textAdapter = makeTextAdapterConfig({
    structured: [completeChunk({ name: "Ada", age: 1 }, '{"name":"Ada","age":1}'), usageChunk(9, 1)],
  });
  const result = await runSideTextQuery(textAdapter, { userPrompt: "x", schema: personSchema });
  assert.ok(
    result.usage && result.usage.totalTokens === 10,
    "usage is captured from RUN_FINISHED even when no text deltas were emitted"
  );
  console.log("✓ usage captured without text deltas");
}

// ---------------------------------------------------------------------------
// 2.5 — a transport failure must be logged under the port's own category
// ---------------------------------------------------------------------------

{
  const log = makeCapturingLog();
  const textAdapter = makeTextAdapterConfig({
    structured: [runErrorChunk("provider exploded"), usageChunk(1, 1)],
  });

  await assert.rejects(
    () => runSideTextQuery(textAdapter, { userPrompt: "x", schema: personSchema, log }),
    /provider exploded/,
    "a RUN_ERROR chunk is converted into a throw"
  );

  // Two records, because the structured failure is retried once in text mode and
  // each attempt reports its own outcome. The first must still carry the
  // transport reason, so the fallback does not hide what the provider did.
  assert.equal(log.entries.length, 2, "both attempts are logged");
  assert.equal(log.entries[0].category, "side-query", "logged under the port's dedicated category");
  assert.match(log.entries[0].message, /provider exploded/, "the reason is carried");
  assert.equal(log.entries[0].data.mode, "structured", "the first record names the mode it failed in");
  assert.equal(log.entries[0].data.fallback, "text", "and the mode it is about to retry in");
  assert.equal(log.entries[0].data.model, "fake-model");
  assert.equal(typeof log.entries[0].data.durationMs, "number");

  console.log("✓ transport failure logged under `side-query`");
}

// ---------------------------------------------------------------------------
// 2.5b — a schema failure is logged with the reason and a raw excerpt
// ---------------------------------------------------------------------------

{
  const log = makeCapturingLog();
  const textAdapter = makeTextAdapterConfig({
    structured: [completeChunk({ name: "Ada" }, '{"name":"Ada"}'), usageChunk(3, 2)],
  });

  await assert.rejects(() => runSideTextQuery(textAdapter, { userPrompt: "x", schema: personSchema, log }));

  assert.equal(log.entries.length, 2, "the validation failure is logged for both attempts");
  assert.equal(log.entries[0].category, "side-query");
  assert.equal(log.entries[0].data.mode, "structured");
  assert.match(String(log.entries[0].data.raw), /Ada/, "a raw-response excerpt is attached for diagnosis");

  console.log("✓ schema failure logged with reason + excerpt");
}

// ---------------------------------------------------------------------------
// 2.5c — success stays quiet
// ---------------------------------------------------------------------------

{
  const log = makeCapturingLog();
  const textAdapter = makeTextAdapterConfig({
    structured: [completeChunk({ name: "Ada", age: 2 }, '{"name":"Ada","age":2}'), usageChunk(1, 1)],
  });

  await runSideTextQuery(textAdapter, { userPrompt: "x", schema: personSchema, log });
  assert.equal(log.entries.length, 0, "a successful query writes no log entry");

  console.log("✓ success path is silent");
}

// ---------------------------------------------------------------------------
// 2.6 — the text overload still works (existing callers unaffected)
// ---------------------------------------------------------------------------

{
  const textAdapter = makeTextAdapterConfig({
    text: [
      { type: "TEXT_MESSAGE_CONTENT", delta: "  hello " },
      { type: "TEXT_MESSAGE_CONTENT", delta: "world  " },
      usageChunk(7, 3),
    ],
  });

  const result = await runSideTextQuery(textAdapter, { userPrompt: "hi" });
  assert.equal(result.text, "hello world", "the text branch trims accumulated deltas");
  assert.ok(result.usage, "the text branch still reports usage");
  assert.equal(result.data, undefined, "the text result carries no structured payload");

  console.log("✓ text overload unchanged");
}

// ---------------------------------------------------------------------------
// 2b — the dedicated category survives the persisted log-entry schema
// ---------------------------------------------------------------------------
//
// `LogCategory` is declared twice (a TS union in types.ts and a zod enum in
// schemas.ts). A category missing from the zod list is rejected at write time,
// so the entry silently never lands — this asserts the two agree.

{
  const entry = {
    scope: { profile: "internal" },
    id: "log_probe",
    timestamp: Date.now(),
    level: "warn",
    category: "side-query",
    message: "Side query failed: boom",
    data: { model: "fake-model", durationMs: 1 },
  };

  const accepted = logEntrySchema.safeParse(entry);
  assert.equal(accepted.success, true, "a `side-query` entry passes the persisted log-entry schema");

  // The schema must still be discriminating — otherwise the assertion above
  // would pass for any string and prove nothing.
  const rejected = logEntrySchema.safeParse({ ...entry, category: "not-a-category" });
  assert.equal(rejected.success, false, "an unknown category is still rejected");

  assert.equal(logCategorySchema.safeParse("side-query").success, true);

  console.log("✓ `side-query` category accepted by the log-entry schema");
}

console.log("structured-query validation passed");

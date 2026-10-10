/**
 * Validation for side-text-query: stream accumulation, the structured-root guard,
 * capability-driven mode selection, and the strict JSON extractor (no network).
 *
 * Run: pnpm --filter @codent/core run validate:side-text-query
 */

import { streamToText } from "@tanstack/ai";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  extractJsonDocument,
  renderSchemaContract,
  runSideTextQuery,
  SIDE_QUERY_MIN_OUTPUT_TOKENS,
  applySideQueryOutputFloor,
  maxTokensOption,
} from "../dist/dev.mjs";

const chunks = [
  { type: "TEXT_MESSAGE_CONTENT", delta: "hello " },
  { type: "TEXT_MESSAGE_CONTENT", delta: "world" },
  { type: "RUN_FINISHED", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
];

async function* mockStream() {
  for (const chunk of chunks) {
    yield chunk;
  }
}

// `streamToText()` returns a `ChatResult` (`{ text, chunks }`) as of @tanstack/ai 0.66.
const { text } = await streamToText(mockStream());
assert.equal(text, "hello world");
assert.equal(typeof runSideTextQuery, "function");

// ---------------------------------------------------------------------------
// The structured-root guard
// ---------------------------------------------------------------------------
//
// A top-level non-object `outputSchema` used to be accepted and then fail on
// every single call: the provider builds its structured-output request from the
// schema's `properties`, so an array root is sent as `{ type: "object",
// properties: {} }`, the model invents a wrapper key, and validation can never
// succeed. Memory extraction ran that way for two days — 0 memories, one schema
// warning per turn, and nothing pointing at the request. The guard rejects the
// schema at the call site instead, so the failure is loud and immediate.

const neverCalledAdapter = {
  adapter: {
    kind: "text",
    name: "fake",
    model: "fake-model",
    "~types": {},
    chatStream() {
      throw new Error("the guard must reject before any request is issued");
    },
    async structuredOutput() {
      throw new Error("the guard must reject before any request is issued");
    },
    structuredOutputStream() {
      throw new Error("the guard must reject before any request is issued");
    },
  },
  model: "fake-model",
  modelStyle: "openai",
};

/** A stand-in for a Zod schema, reduced to the part the guard reads. */
const schemaLike = (type) => ({
  "~standard": { version: 1, jsonSchema: { input: () => ({ type }) } },
});

// A bare array is the shape that shipped broken; it must be refused.
for (const type of ["array", "string"]) {
  await assert.rejects(
    () => runSideTextQuery(neverCalledAdapter, { userPrompt: "x", schema: schemaLike(type) }),
    (err) => /requires a top-level object schema/.test(err.message) && err.message.includes(`\`"${type}"\``),
    `a top-level ${type} schema is rejected at the call site`
  );
}

// Both shipped shapes must pass the guard: an object root, and a raw JSON Schema
// with no `~standard` (nothing to introspect, so it is left alone).
for (const [label, schema] of [
  ["object root", schemaLike("object")],
  ["raw JSON Schema", { type: "object", properties: {} }],
]) {
  // It should get past the guard and blow up in the fake adapter instead.
  await assert.rejects(
    () => runSideTextQuery(neverCalledAdapter, { userPrompt: "x", schema }),
    (err) => !/requires a top-level object schema/.test(err.message),
    `a ${label} schema passes the guard`
  );
}

console.log("✓ a non-object structured root is rejected at the call site");

// ---------------------------------------------------------------------------
// Fixtures: an adapter that records which mechanism was asked for
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

const textChunks = (body) => [{ type: "TEXT_MESSAGE_CONTENT", delta: body }, usageChunk(10, 5)];

/**
 * A text-adapter config that counts calls per mechanism.
 *
 * Both mechanisms are driveable in one fixture, which is what makes the mode
 * assertions meaningful: "the structured method was never called" is only a real
 * claim when that method exists and would record the call.
 */
const makeTextAdapterConfig = ({ structured = [], text = [], structuredOutput, modelStyle = "openai" } = {}) => {
  const calls = { structured: 0, text: 0 };
  return {
    calls,
    model: "fake-model",
    modelStyle,
    // Absent by default, matching a hand-built config: the port then treats the
    // capability as unknown and attempts structured output first.
    ...(structuredOutput ? { structuredOutput } : {}),
    adapter: {
      kind: "text",
      name: "fake",
      model: "fake-model",
      "~types": {},
      chatStream() {
        calls.text++;
        return (async function* () {
          for (const chunk of text) yield chunk;
        })();
      },
      async structuredOutput() {
        calls.structured++;
        throw new Error("structuredOutput() is not the path under test");
      },
      structuredOutputStream() {
        calls.structured++;
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
    info(category, message, data) {
      entries.push({ category, message, data, level: "info" });
      return null;
    },
    debug: () => null,
    error: () => null,
  };
};

// The person payload both mechanisms must agree on, and the transform schema used
// to prove they do.
const PERSON_RAW = '{"name":"Ada","age":36}';

// ---------------------------------------------------------------------------
// 5.1 — a declared absence issues zero structured calls, and still returns data
// ---------------------------------------------------------------------------
//
// 14.5% of the models.dev catalog declares `structured_output: false`. For those,
// the structured request is known to be unsupported, and its failure mode varies
// by provider (a 400, or a silent no-event) — so the port must not send it at all.

{
  const textAdapter = makeTextAdapterConfig({
    structuredOutput: "unsupported",
    text: textChunks(PERSON_RAW),
    structured: [completeChunk({ name: "unused", age: 0 }, "{}")],
  });
  const log = makeCapturingLog();

  const result = await runSideTextQuery(textAdapter, { userPrompt: "x", schema: personSchema, log });

  assert.equal(textAdapter.calls.structured, 0, "no structured request is issued for a declared-unsupported model");
  assert.equal(textAdapter.calls.text, 1, "exactly one text request is issued");
  assert.deepEqual(result.data, { name: "Ada", age: 36 }, "the text mode still returns validated data");
  assert.equal(result.raw, PERSON_RAW, "the located document is returned as `raw`");

  // The mode choice must be visible, or a provider that keeps failing looks like a
  // model that returns nothing.
  assert.equal(log.entries.length, 1, "the capability-driven mode choice is recorded");
  assert.equal(log.entries[0].category, "side-query");
  assert.equal(log.entries[0].data.mode, "text", "the record names the chosen mode");
  assert.match(log.entries[0].message, /text mode: .*declare no structured output/i);

  console.log("✓ a declared-unsupported model goes straight to text mode");
}

// ---------------------------------------------------------------------------
// 5.3 — an unknown capability still attempts structured output first
// ---------------------------------------------------------------------------
//
// `undefined` means "nothing was declared", not "declares none". Routing it to
// text mode would silently downgrade every undescribable model — an offline
// launch, a model missing from the catalog — through the weaker mechanism.

{
  const textAdapter = makeTextAdapterConfig({
    // `structuredOutput` omitted entirely — the unknown state.
    structured: [completeChunk({ name: "Ada", age: 36 }, PERSON_RAW)],
    text: textChunks(PERSON_RAW),
  });

  const result = await runSideTextQuery(textAdapter, { userPrompt: "x", schema: personSchema });

  assert.equal(textAdapter.calls.structured, 1, "an unknown capability attempts structured output");
  assert.equal(textAdapter.calls.text, 0, "and does not fall back when that attempt succeeds");
  assert.deepEqual(result.data, { name: "Ada", age: 36 });

  console.log("✓ an unknown capability still attempts structured output");
}

// ---------------------------------------------------------------------------
// 5.2 — a structured failure falls back to exactly one text attempt
// ---------------------------------------------------------------------------

{
  // Structured produces prose the engine cannot parse, so the attempt fails.
  const textAdapter = makeTextAdapterConfig({
    structuredOutput: "supported",
    structured: [{ type: "TEXT_MESSAGE_CONTENT", delta: "I cannot do that" }, usageChunk(5, 5)],
    text: textChunks(PERSON_RAW),
  });
  const log = makeCapturingLog();

  const result = await runSideTextQuery(textAdapter, { userPrompt: "x", schema: personSchema, log });

  assert.equal(textAdapter.calls.structured, 1, "the structured attempt happened once");
  assert.equal(textAdapter.calls.text, 1, "the fallback happened exactly once — never a second structured retry");
  assert.deepEqual(result.data, { name: "Ada", age: 36 }, "the fallback's result is returned");

  // The structured failure is recorded with its mode *and* the retry it led to,
  // so a provider that silently ignores `response_format` stays diagnosable even
  // though the call ultimately succeeded.
  const failed = log.entries.find((entry) => entry.level !== "info");
  assert.ok(failed, "the structured failure is recorded despite the successful fallback");
  assert.equal(failed.data.mode, "structured", "it names the mode it failed in");
  assert.equal(failed.data.fallback, "text", "and the mode it is retrying in");
  assert.equal(log.entries.filter((entry) => entry.level !== "info").length, 1, "one failure record per attempt");

  console.log("✓ a structured failure falls back to text exactly once");
}

// ---------------------------------------------------------------------------
// 5.2b — when both modes fail there is no third attempt, and both reasons surface
// ---------------------------------------------------------------------------

{
  const textAdapter = makeTextAdapterConfig({
    structuredOutput: "supported",
    structured: [{ type: "TEXT_MESSAGE_CONTENT", delta: "nope" }, usageChunk(1, 1)],
    text: textChunks("still not JSON at all"),
  });

  await assert.rejects(
    () => runSideTextQuery(textAdapter, { userPrompt: "x", schema: personSchema }),
    (err) => {
      assert.match(err.message, /structured attempt failed:/, "the structured reason is reported");
      assert.match(err.message, /text fallback also failed:/, "and the text reason alongside it");
      return true;
    },
    "a doubly-failed query reports both reasons"
  );

  assert.equal(textAdapter.calls.structured, 1, "no second structured attempt");
  assert.equal(textAdapter.calls.text, 1, "no second text attempt");

  // A declared-unsupported model is a decision, not a fallback: it must not be
  // retried when its single text attempt fails.
  const declared = makeTextAdapterConfig({
    structuredOutput: "unsupported",
    text: textChunks("not JSON"),
    structured: [completeChunk({ name: "Ada", age: 1 }, "{}")],
  });
  await assert.rejects(() => runSideTextQuery(declared, { userPrompt: "x", schema: personSchema }));
  assert.equal(declared.calls.structured, 0, "a declared-unsupported model never retries structured output");
  assert.equal(declared.calls.text, 1, "its single text attempt is not repeated");

  console.log("✓ failure is reported without extra attempts");
}

// ---------------------------------------------------------------------------
// 5.4 — the same payload validates identically in either mode
// ---------------------------------------------------------------------------
//
// The fallback must not become a laxer contract. One fixture, driven once through
// each mechanism, must produce the same value — transforms included.

{
  const transformed = z.object({
    name: z.string(),
    tag: z.string().transform((value) => value.toUpperCase()),
  });
  const raw = '{"name":"Ada","tag":"agent"}';

  const structuredAdapter = makeTextAdapterConfig({
    structured: [completeChunk({ name: "Ada", tag: "agent" }, raw)],
  });
  const textAdapter = makeTextAdapterConfig({
    structuredOutput: "unsupported",
    text: textChunks(raw),
  });

  const viaStructured = await runSideTextQuery(structuredAdapter, { userPrompt: "x", schema: transformed });
  const viaText = await runSideTextQuery(textAdapter, { userPrompt: "x", schema: transformed });

  assert.deepEqual(viaStructured.data, { name: "Ada", tag: "AGENT" }, "structured applies the schema transform");
  assert.deepEqual(viaText.data, { name: "Ada", tag: "AGENT" }, "text mode applies the same transform");
  assert.deepEqual(viaText.data, viaStructured.data, "both mechanisms produce the identical value");
  assert.equal(viaText.raw, viaStructured.raw, "and the identical raw document");

  // A payload that fails validation must fail in both modes — the fallback is not
  // a place where an invalid reply is accepted.
  const invalidRaw = '{"name":"Ada"}';
  const badStructured = makeTextAdapterConfig({ structured: [completeChunk({ name: "Ada" }, invalidRaw)] });
  const badText = makeTextAdapterConfig({ structuredOutput: "unsupported", text: textChunks(invalidRaw) });

  await assert.rejects(
    () => runSideTextQuery(badStructured, { userPrompt: "x", schema: transformed }),
    /schema validation/i,
    "structured rejects an invalid payload"
  );
  await assert.rejects(
    () => runSideTextQuery(badText, { userPrompt: "x", schema: transformed }),
    /schema validation/i,
    "text mode rejects the same invalid payload"
  );

  console.log("✓ both modes validate identically (accept and reject)");
}

// ---------------------------------------------------------------------------
// Text mode spends the contract in the prompt
// ---------------------------------------------------------------------------
//
// In text mode the prompt is the *only* place the contract exists, so it must
// actually reach the request. `renderSchemaContract` derives it from the schema,
// which is what makes "a required field omitted from the prompt" impossible
// rather than a rule someone has to remember.

{
  const schema = z.object({
    memories: z.array(
      z.object({
        name: z.string().describe("kebab-case identifier"),
        type: z.enum(["user", "project"]).describe("memory category"),
        importance: z.number().optional(),
      })
    ),
  });

  const contract = renderSchemaContract(schema);
  assert.match(contract, /"memories"/, "the root key is named, so the reply cannot invent one");
  assert.match(contract, /"name"/);
  assert.match(contract, /"type"/);
  assert.match(contract, /one of "user", "project"/, "enum values are listed, not just the field name");
  assert.match(contract, /"importance": number, optional/, "optional fields are marked optional");
  assert.match(contract, /kebab-case identifier/, "the field's own description is carried into the prompt");
  assert.match(contract, /no prose, no markdown code fences/, "the output shape is constrained");

  // The contract must reach the request in text mode, not just be computable.
  const captured = [];
  const adapter = makeTextAdapterConfig({
    structuredOutput: "unsupported",
    text: textChunks('{"memories":[]}'),
  });
  const originalChatStream = adapter.adapter.chatStream;
  adapter.adapter.chatStream = function (...args) {
    captured.push(args[0]);
    return originalChatStream.apply(this, args);
  };

  await runSideTextQuery(adapter, { userPrompt: "x", schema, systemPrompt: "You extract memories." });

  const request = captured[0];
  const promptText = JSON.stringify(request);
  assert.match(promptText, /memories/, "the rendered contract is part of the text-mode request");
  assert.match(promptText, /You extract memories/, "and the caller's system prompt is kept alongside it");

  // A Zod union must render, not be refused: Zod expresses it as a type array
  // (`type: ["string","number"]`), which flattens faithfully. Treating it as
  // inexpressible would reject schemas the renderer handles fine.
  const unionContract = renderSchemaContract(z.object({ choice: z.union([z.string(), z.number()]) }));
  assert.match(unionContract, /"choice": string or number/, "a Zod union renders as a type array");

  // A nullable field is optional-shaped in practice — `null` must not be advertised
  // as a value the model should send, because the contract already says to omit.
  const nullable = renderSchemaContract(z.object({ note: z.string().nullable().describe("a note") }));
  assert.match(nullable, /"note": string/, "a nullable field renders as its non-null type");

  // What genuinely cannot be rendered is a raw JSON Schema using a combinator that
  // has no flat equivalent: an approximated contract asks for one shape and
  // validates another, so it must be refused *before* any request.
  const unsupported = makeTextAdapterConfig({ structuredOutput: "unsupported", text: textChunks("{}") });
  await assert.rejects(
    () =>
      runSideTextQuery(unsupported, {
        userPrompt: "x",
        schema: {
          type: "object",
          properties: { choice: { oneOf: [{ type: "string" }, { type: "number" }] } },
          required: ["choice"],
        },
      }),
    (err) => /cannot express/.test(err.message) && /oneOf/.test(err.message) && /choice/.test(err.message),
    "a raw schema using `oneOf` is refused, naming the construct and the field"
  );
  assert.equal(unsupported.calls.text, 0, "and no request is issued for it");
  assert.equal(unsupported.calls.structured, 0, "in either mode");

  console.log("✓ the text-mode contract is derived from the schema and reaches the request");
}

// ---------------------------------------------------------------------------
// 2.4 — the extractor's accept/reject boundary
// ---------------------------------------------------------------------------
//
// Locating a complete document is allowed; repairing one is not. Every reject
// below is a case a repair-style parser would have accepted by mutating the text.

{
  const accepted = [
    ['{"a":1}', "a bare document"],
    ['Here you go:\n{"a":1}\nHope that helps!', "a document wrapped in prose"],
    ['```json\n{"a":1}\n```', "a fenced document"],
    ['```\n{"a":1}\n```', "a fence with no language tag"],
    ['{"a":"}"}', "a brace inside a string literal"],
    ['{"a":"\\"}{"}', "an escaped quote inside a string literal"],
    ['```json\n{"a":1}\n```\nThat is the result.', "a fenced document followed by prose"],
    ['{"a":{"b":[1,2]}}', "a nested document"],
  ];

  for (const [input, label] of accepted) {
    const found = extractJsonDocument(input);
    assert.ok(found, `${label} is accepted`);
    assert.deepEqual(found.value, JSON.parse(found.raw), `${label} yields the parsed document`);
  }

  // The fence and the surrounding text hold the *same* document, so it must not be
  // counted twice — "two documents" would otherwise reject a well-formed reply.
  const fenced = extractJsonDocument('```json\n{"a":1}\n```');
  assert.equal(fenced.raw, '{"a":1}', "a fenced document is returned without its fence");

  // Junk *after* a complete document is prose, by the same rule that allows prose
  // before it — the span is located, never trimmed, so nothing is repaired. What
  // cannot be tolerated is input where the document itself is malformed.
  const proseAround = [
    ['{"a":1}}', "a stray closing brace after the document"],
    ['{"a":1} trailing {garbage', "a complete document plus an unterminated fragment"],
    ['{"a":1} and {"b"', "a complete document plus a truncated second one"],
  ];
  for (const [input, label] of proseAround) {
    const found = extractJsonDocument(input);
    assert.ok(found, `${label} is still located`);
    assert.deepEqual(found.value, { a: 1 }, `${label} yields the complete document`);
    assert.equal(found.raw, '{"a":1}', `${label} yields exactly the located span, unmodified`);
  }

  const rejected = [
    ['```json\n{"a":1}\n```\nand also {"b":2}', "two complete documents — a guess would be required"],
    ['{"a":1', "truncated output (never closes)"],
    ['{"a":1,}', "a trailing comma — repairable, therefore refused"],
    ['{"a":1} {"b":2}', "two complete documents with no prose between them"],
    ["no json here at all", "no document"],
    ['[{"a":1}]', "an array root — the port requires an object"],
    ["", "an empty reply"],
  ];

  for (const [input, label] of rejected) {
    assert.equal(extractJsonDocument(input), null, `${label} is rejected`);
  }

  // Close the loop: a fenced block holding a *truncated* document is still refused,
  // so the fence is a locator and never a licence to repair.
  assert.equal(extractJsonDocument('```json\n{"a":1\n```'), null, "a truncated fenced document is refused");

  console.log("✓ the extractor locates complete documents and refuses to repair");
}

// ---------------------------------------------------------------------------
// The output-token floor: a cap below the thinking length starves the ANSWER
// ---------------------------------------------------------------------------
//
// `max_tokens` bounds thinking AND the answer, and thinking is emitted first and cannot be
// dropped. A caller whose cap matches its job ("a title is ~10 tokens") therefore gets **no**
// text on a reasoning model — measured on `zhipu/glm-5.3-flash` (an endpoint that rejects the
// `thinking` disable, so it always thinks): cap 30/60/128/256 produced zero text on every run,
// and a title-shaped prompt needed 1024 to succeed 4/4 (512 managed 3/4 — close enough to the
// thinking length to fail a quarter of the time).
//
// This is what silently degraded session titles: the caller asked for 30, got a cutoff, and
// `generateSessionTitle`'s catch fell back to a truncated first message that looks normal.
//
// The floor is applied in `createQueryRequest` rather than in `maxTokensOption`, because the
// latter is the pure wire-shape mapping (`validate-structured-query` asserts `20 -> { max_tokens:
// 20 }` exactly). Both are asserted below so the two concerns stay separable.

{
  assert.equal(SIDE_QUERY_MIN_OUTPUT_TOKENS, 1024, "the floor is the Anthropic thinking-budget minimum");
  assert.equal(applySideQueryOutputFloor(30), 1024, "a job-sized cap is raised to the floor");
  assert.equal(applySideQueryOutputFloor(1024), 1024, "a cap already at the floor is unchanged");
  assert.equal(applySideQueryOutputFloor(2000), 2000, "a larger cap is never lowered");
  assert.equal(applySideQueryOutputFloor(undefined), undefined, "no requested cap stays no cap");

  // The pure wire mapping must stay pure — the floor is the port's concern, not its.
  assert.deepEqual(maxTokensOption("anthropic", 20), { max_tokens: 20 });
  assert.deepEqual(maxTokensOption("openai", 20), { max_completion_tokens: 20 });

  /** Records the options the port actually handed to the adapter. */
  const capturing = (modelStyle) => {
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
        chatStream(options) {
          seen.push(options.modelOptions ?? {});
          return (async function* () {
            yield { type: "TEXT_MESSAGE_CONTENT", delta: "ok" };
            yield usageChunk(1, 1);
          })();
        },
      },
    };
  };

  // The exact shape that was broken: title generation's 30 tokens, anthropic style.
  const titleAdapter = capturing("anthropic");
  await runSideTextQuery(titleAdapter, { userPrompt: "x", maxOutputTokens: 30 });
  assert.equal(
    titleAdapter.seen[0].max_tokens,
    1024,
    "the title query no longer sends a cap that thinking can consume entirely"
  );

  // And the openai-style spelling goes through the same floor.
  const openaiTitle = capturing("openai");
  await runSideTextQuery(openaiTitle, { userPrompt: "x", maxOutputTokens: 30 });
  assert.equal(openaiTitle.seen[0].max_completion_tokens, 1024, "the openai spelling is floored too");

  // A call site with no cap must still send none — the floor is not a default cap.
  const uncapped = capturing("anthropic");
  await runSideTextQuery(uncapped, { userPrompt: "x" });
  assert.equal("max_tokens" in uncapped.seen[0], false, "an uncapped query stays uncapped");

  console.log("✓ the output cap is floored above the thinking budget");
}

console.log("side-text-query validation passed");

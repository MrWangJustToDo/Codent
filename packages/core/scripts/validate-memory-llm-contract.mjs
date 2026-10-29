/**
 * Validation for the memory LLM contract (no network).
 *
 * Extraction and consolidation used to recover their structured result by
 * pattern-matching raw text and repairing fields afterwards. They now run
 * through `runSideTextQuery`'s structured overload against a Zod schema, so
 * this script drives each path with a fake adapter and asserts the contract
 * end to end — including the parts that only the schema can enforce.
 *
 * Covers:
 * - extraction writes the entries the model returned, including importance and
 *   a normalized expiresAt
 * - an out-of-range importance / unparseable expiry is normalized away rather
 *   than rejecting the memory or rejecting the response
 * - an unknown memory type is rejected by the schema instead of defaulting to
 *   a type the model never asked for
 * - a malformed response yields zero memories and never touches the store
 * - consolidation applies merges and deletions, and leaves everything alone
 *   when the response cannot satisfy the schema
 * - every shipped schema projects to a usable provider request (the assertion
 *   whose absence let a bare-array extraction schema ship broken)
 *
 * Run: pnpm --filter @codent/core run validate:memory-llm-contract
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { z } from "zod";

import {
  MemoryManager,
  consolidateMemories,
  DEFAULT_EVENT_LOG_RULES,
  extractMemories,
  registerCoreEnv,
  runSideTextQuery,
} from "../dist/dev.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const root = await mkdtemp(join(tmpdir(), "codent-memory-llm-contract-"));

// Minimal CoreEnv backed by the real filesystem, scoped to `root`.
registerCoreEnv({
  rootPath: root,
  path: {
    join: (...p) => join(...p),
    dirname: (p) => dirname(p),
    basename: (p, ext) => (ext ? basename(p, ext) : basename(p)),
    extname: (p) => extname(p),
    resolve: (...p) => resolve(...p),
    normalize: (p) => normalize(p),
    isAbsolute: (p) => isAbsolute(p),
    getSep: () => sep,
    parse: (p) => parse(p),
  },
  getPlatform: async () => "test",
  getArch: async () => "test",
  getEnv: async () => ({}),
  homedir: async () => root,
  byteLength: (s) => Buffer.byteLength(s, "utf-8"),
  fs: {
    readFile: async (p) => {
      const { readFile } = await import("node:fs/promises");
      return readFile(p, "utf-8");
    },
    stat: async (p) => {
      const s = await stat(p);
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
    },
    readdir: async (p) => {
      const names = await readdir(p);
      return names.map((name) => ({ name, type: "file" }));
    },
    writeFile: async (p, content) => writeFile(p, content),
    mkdir: async (p) => {
      await mkdir(p, { recursive: true });
    },
    exists: async (p) => {
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    },
    remove: async (p) => rm(p, TEMP_RM_OPTIONS),
    rename: async (from, to) => {
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    },
    appendFile: async (p, content) => {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(p, content);
    },
  },
});

// ---------------------------------------------------------------------------
// Fake adapter
// ---------------------------------------------------------------------------

const usageChunk = (promptTokens, completionTokens) => ({
  type: "RUN_FINISHED",
  usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
});

const completeChunk = (object) => ({
  type: "CUSTOM",
  name: "structured-output.complete",
  value: { object, raw: JSON.stringify(object) },
});

const runErrorChunk = (message) => ({ type: "RUN_ERROR", message });

/**
 * An adapter whose structured response is `object` (or a failure when given a
 * `failure` message). The port passes no tools, so the engine consumes
 * `structuredOutputStream` directly.
 */
const makeTextAdapterConfig = ({ object, failure }) => ({
  model: "fake-model",
  modelStyle: "openai",
  adapter: {
    kind: "text",
    name: "fake",
    model: "fake-model",
    "~types": {},
    chatStream() {
      return (async function* () {
        yield usageChunk(1, 1);
      })();
    },
    async structuredOutput() {
      throw new Error("not implemented");
    },
    structuredOutputStream() {
      return (async function* () {
        if (failure) {
          yield runErrorChunk(failure);
          return;
        }
        yield completeChunk(object);
        yield usageChunk(100, 20);
      })();
    },
  },
});

const dialogue = [
  { role: "user", content: "please use tabs" },
  { role: "assistant", content: "noted" },
];

const readBody = async (manager, filename) => manager.readMemory(filename);

// ---------------------------------------------------------------------------
// 1. Extraction writes what the model returned
// ---------------------------------------------------------------------------

{
  const manager = new MemoryManager({ rootPath: root });
  await manager.initialize();

  const textAdapter = makeTextAdapterConfig({
    object: {
      memories: [
        {
          name: "user-prefers-tabs",
          type: "user",
          description: "Indentation preference",
          body: "The user prefers tabs over spaces.",
          importance: 0.87,
          expiresAt: "2026-12-31",
        },
      ],
    },
  });

  const count = await extractMemories(dialogue, manager, textAdapter);
  assert.equal(count, 1, "one extracted memory is written");

  const memories = await manager.listMemories();
  const written = memories.find((m) => m.name === "user-prefers-tabs");
  assert.ok(written, "the extracted memory is listed");
  assert.equal(written.type, "user");
  assert.equal(written.description, "Indentation preference");
  assert.equal(written.importance, 0.87, "importance survives the schema (rounded to two decimals, not dropped)");
  assert.equal(
    written.expiresAt,
    "2026-12-31T00:00:00.000Z",
    "a parseable expiry is normalized to ISO by the schema transform"
  );
  assert.ok((await readBody(manager, "user-prefers-tabs.md")).includes("tabs over spaces"));

  console.log("✓ extraction writes schema-validated entries");
}

// ---------------------------------------------------------------------------
// 1b. The prompt states the contract the schema enforces
// ---------------------------------------------------------------------------
//
// A provider that does not enforce the output schema leaves the prompt as the
// only thing telling the model what to emit. Consolidation's prompt previously
// listed every field except `type` while the schema required it, so a reply that
// simply omitted `type` was rejected whole — 2 of 8 live replies. Asserting the
// prompt here is what keeps the two in sync: a schema field the prompt never
// mentions is a field the model has no reason to produce.

{
  // Threshold 1 so `consolidateMemories` does not short-circuit below its cap
  // and actually issues the query.
  const manager = new MemoryManager({ rootPath: root, consolidateThreshold: 1 });
  await manager.initialize();
  await manager.writeMemory("contract-probe-source", "project", "Source", "Source body.");

  const prompts = [];
  const capturing = (object) => ({
    model: "fake-model",
    modelStyle: "openai",
    adapter: {
      kind: "text",
      name: "fake",
      model: "fake-model",
      "~types": {},
      chatStream() {
        return (async function* () {
          yield usageChunk(1, 1);
        })();
      },
      async structuredOutput() {
        throw new Error("not implemented");
      },
      // The engine hands the adapter `{ chatOptions, outputSchema }`; the
      // system prompt lives on `chatOptions.systemPrompts`.
      structuredOutputStream(options) {
        // Capture system *and* user prompt: extraction states its field contract
        // in the user prompt, consolidation in the system prompt. Messages are
        // joined as real text (not JSON-encoded) so line-anchored assertions see
        // the prompt the model actually reads.
        const chat = options?.chatOptions ?? {};
        const userText = (chat.messages ?? [])
          .map((message) => {
            const content = message?.content ?? message?.parts ?? "";
            return typeof content === "string" ? content : JSON.stringify(content);
          })
          .join("\n");
        prompts.push(`${(chat.systemPrompts ?? []).join("\n")}\n${userText}`);
        return (async function* () {
          yield completeChunk(object);
          yield usageChunk(10, 5);
        })();
      },
    },
  });

  const mergeEntry = {
    name: "contract-probe-merged",
    type: "project",
    description: "Merged probe",
    body: "Body.",
    replaces: ["contract-probe-a.md"],
  };

  await extractMemories(dialogue, manager, capturing([]));
  await consolidateMemories(manager, capturing({ merged: [mergeEntry], deleted: [] }));

  assert.equal(prompts.length, 2, "both prompts were captured");

  const [extractionPrompt, consolidationPrompt] = prompts;

  // Assert the *contract*, not incidental word presence. The consolidation
  // prompt's preamble already says it receives a catalog of
  // "(filename, name, type, description)", and rules like "preserve user
  // preferences" mention type values — so asserting `prompt.includes("type")`
  // passes even when the entry contract is absent. That weaker check survived a
  // mutation that deleted the contract, which is exactly the false negative this
  // assertion must not have. Require instead that each required field is
  // introduced as a quoted field name in the contract block.
  // The two prompts introduce fields differently (extraction as a bulleted
  // `- name: ...` list, consolidation as JSON-shaped `"name":` entries), so each
  // is matched in its own form. Both must introduce the field *as a field*, with
  // the type alongside its allowed values — not merely mention the word anywhere.
  const contracts = [
    {
      label: "extraction",
      prompt: extractionPrompt,
      fieldRe: (f) => new RegExp("^-\\s*" + f + "\\s*:", "m"),
      typeRe: /^-\s*type:\s*one of[^\n]*user[^\n]*feedback[^\n]*project[^\n]*reference/m,
      fields: ["name", "type", "description", "body"],
    },
    {
      label: "consolidation",
      prompt: consolidationPrompt,
      fieldRe: (f) => new RegExp('"' + f + '"\\s*:'),
      typeRe: /"type"\s*:\s*one of[^\n]*user[^\n]*feedback[^\n]*project[^\n]*reference/,
      fields: ["name", "type", "description", "body", "replaces"],
    },
  ];

  for (const { label, prompt, fieldRe, typeRe, fields } of contracts) {
    for (const field of fields) {
      assert.match(
        prompt,
        fieldRe(field),
        `the ${label} prompt introduces \`${field}\` as a field, not just in passing`
      );
    }
    assert.match(prompt, typeRe, `the ${label} contract states \`type\` together with its four allowed values`);
  }

  console.log("✓ both prompts state the contract their schema enforces");
}

// ---------------------------------------------------------------------------
// 2. Out-of-range hints are normalized, not fatal
// ---------------------------------------------------------------------------

{
  const manager = new MemoryManager({ rootPath: root });
  await manager.initialize();

  const textAdapter = makeTextAdapterConfig({
    object: {
      memories: [
        {
          name: "out-of-range-hints",
          type: "project",
          description: "Hints the schema had to repair",
          body: "Body text.",
          importance: 1.5,
          expiresAt: "not-a-date",
        },
      ],
    },
  });

  const count = await extractMemories(dialogue, manager, textAdapter);
  assert.equal(count, 1, "an entry with unusable optional hints is still accepted");

  const written = (await manager.listMemories()).find((m) => m.name === "out-of-range-hints");
  assert.ok(written, "the entry is written");
  assert.equal(written.importance, undefined, "an importance outside 0–1 is dropped, not clamped silently");
  assert.equal(written.expiresAt, undefined, "an unparseable expiry is dropped");

  console.log("✓ invalid importance / expiry are normalized away");
}

// ---------------------------------------------------------------------------
// 3. An unknown memory type is rejected by the schema
// ---------------------------------------------------------------------------

{
  const manager = new MemoryManager({ rootPath: root });
  await manager.initialize();

  const before = (await manager.listMemories()).length;

  const textAdapter = makeTextAdapterConfig({
    object: { memories: [{ name: "made-up-type", type: "banana", description: "nope", body: "nope" }] },
  });

  const count = await extractMemories(dialogue, manager, textAdapter);
  assert.equal(count, 0, "a response with an unknown type yields nothing");
  assert.equal(
    (await manager.listMemories()).length,
    before,
    "nothing is written, and the type is not silently rewritten to `user`"
  );

  console.log("✓ an unknown memory type is rejected, not defaulted");
}

// ---------------------------------------------------------------------------
// 4. A failed response is contained
// ---------------------------------------------------------------------------

{
  const manager = new MemoryManager({ rootPath: root });
  await manager.initialize();

  const before = (await manager.listMemories()).length;

  const failing = makeTextAdapterConfig({ failure: "provider exploded" });
  assert.equal(await extractMemories(dialogue, manager, failing), 0, "a transport failure yields zero memories");

  const malformed = makeTextAdapterConfig({
    object: { memories: [{ name: "missing-body", type: "user", description: "d" }] },
  });
  assert.equal(
    await extractMemories(dialogue, manager, malformed),
    0,
    "a schema-violating response yields zero memories"
  );

  assert.equal((await manager.listMemories()).length, before, "the store is untouched by either failure");

  console.log("✓ extraction failures are contained");
}

// ---------------------------------------------------------------------------
// 5. Consolidation applies merges and deletions
// ---------------------------------------------------------------------------

{
  const manager = new MemoryManager({ rootPath: root, consolidateThreshold: 2 });
  await manager.initialize();

  await manager.writeMemory("alpha-note", "project", "Alpha", "Alpha body.");
  await manager.writeMemory("beta-note", "project", "Beta", "Beta body.");
  await manager.writeMemory("stale-note", "reference", "Stale", "Stale body.");

  const textAdapter = makeTextAdapterConfig({
    object: {
      merged: [
        {
          name: "alpha-beta-note",
          type: "project",
          description: "Alpha and Beta merged",
          body: "Combined body.",
          replaces: ["alpha-note.md", "beta-note.md"],
        },
      ],
      deleted: ["stale-note.md"],
    },
  });

  const result = await consolidateMemories(manager, textAdapter);
  assert.equal(result.changed, true, "consolidation reports a change");

  const names = (await manager.listMemories()).map((m) => m.name);
  assert.ok(names.includes("alpha-beta-note"), "the merged entry is written");
  assert.ok(!names.includes("alpha-note"), "a replaced file is deleted");
  assert.ok(!names.includes("beta-note"), "every replaced file is deleted");
  assert.ok(!names.includes("stale-note"), "an explicitly deleted file is deleted");

  console.log("✓ consolidation applies merges and deletions");
}

// ---------------------------------------------------------------------------
// 6. A bad merge must not delete the files it failed to replace
// ---------------------------------------------------------------------------
//
// This is the case a collection-level `.catch([])` produced: the merged entry
// failed validation, the collection collapsed to empty *without throwing*, and
// the caller then applied `deleted` — so the sources named in the rejected
// merge were removed and their replacement was never written. One malformed
// field could therefore destroy every file the merge claimed to fold together,
// with no error anywhere.

{
  const manager = new MemoryManager({ rootPath: root, consolidateThreshold: 2 });
  await manager.initialize();

  await manager.writeMemory("doomed-alpha", "project", "Alpha", "Alpha body.");
  await manager.writeMemory("doomed-beta", "project", "Beta", "Beta body.");
  await manager.writeMemory("doomed-stale", "reference", "Stale", "Stale body.");

  const before = (await manager.listMemories()).map((m) => m.filename).sort();

  // The consolidation query now reports structured facts instead of log lines: each attempt
  // publishes a `side-query:error` with the offending text, and the harness formats it the same way
  // the policy table does so the assertions stay about content.
  const entries = [];
  const onSideQuery = (event) => {
    if (event.type === "side-query:error") entries.push(`side-query: failed in ${event.mode} mode: ${event.error}`);
  };

  // The merge is invalid (unknown type); the deletions are perfectly valid and
  // name the very files the merge was supposed to replace.
  const textAdapter = makeTextAdapterConfig({
    object: {
      merged: [
        {
          name: "doomed-merged",
          type: "consolidated",
          description: "Merged",
          body: "Combined body.",
          replaces: ["doomed-alpha.md", "doomed-beta.md"],
        },
      ],
      deleted: ["doomed-alpha.md", "doomed-beta.md", "doomed-stale.md"],
    },
  });

  const result = await consolidateMemories(manager, textAdapter, onSideQuery);

  assert.equal(result.changed, false, "a rejected merge reports no change");
  assert.deepEqual(
    (await manager.listMemories()).map((m) => m.filename).sort(),
    before,
    "a rejected merge must not let its deletions run — no source file is lost"
  );
  assert.equal(entries.length, 2, "both attempts are reported rather than silent");
  // The structured record carries the offending field path and names the mode it
  // failed in; the text record follows it. Two records, not one, because a
  // structured failure now falls back to exactly one text attempt — each attempt
  // reports its own outcome instead of the pair collapsing into a single line.
  assert.match(entries[0], /mode: .*merged\.0\.type/, "the first record names the offending field and its mode");
  assert.match(entries[0], /failed in structured mode/, "the first record is the structured attempt");
  assert.match(entries[1], /failed in text mode/, "the second record is the text fallback");
  // The content assertions above are about what the port reports. The POLICY assertion is separate:
  // a harness that formats its own string with the same prefix proves nothing about the rule table
  // (that tautology was here before — it now checks the table the bridge actually reads).
  const sideQueryRule = DEFAULT_EVENT_LOG_RULES["side-query:error"];
  assert.ok(sideQueryRule && sideQueryRule !== "specialized", "side-query:error has a generic rule");
  assert.equal(sideQueryRule.level, "warn", "a failed side query is a warning");
  assert.equal(sideQueryRule.category, "side-query", "…filed under the port's own category");

  console.log("✓ a rejected merge does not delete its sources");
}

// ---------------------------------------------------------------------------
// 7. An unrecognized top-level shape is a failure, not "nothing to do"
// ---------------------------------------------------------------------------

{
  const manager = new MemoryManager({ rootPath: root, consolidateThreshold: 2 });
  await manager.initialize();

  await manager.writeMemory("shape-one", "project", "One", "One body.");
  await manager.writeMemory("shape-two", "project", "Two", "Two body.");
  const before = (await manager.listMemories()).map((m) => m.filename).sort();

  for (const malformed of [{}, { changes: [{ name: "x" }] }, { merged: [], deleted: "alpha.md" }]) {
    const textAdapter = makeTextAdapterConfig({ object: malformed });
    const result = await consolidateMemories(manager, textAdapter);
    assert.equal(
      result.changed,
      false,
      `a response shaped ${JSON.stringify(malformed).slice(0, 40)} reports no change`
    );
    assert.deepEqual(
      (await manager.listMemories()).map((m) => m.filename).sort(),
      before,
      "an unrecognized shape never mutates the store"
    );
  }

  console.log("✓ unrecognized consolidation shapes are rejected");
}

// ---------------------------------------------------------------------------
// 8. Consolidation failures leave existing memories alone
// ---------------------------------------------------------------------------

{
  const manager = new MemoryManager({ rootPath: root, consolidateThreshold: 2 });
  await manager.initialize();

  await manager.writeMemory("keep-one", "project", "One", "One body.");
  await manager.writeMemory("keep-two", "project", "Two", "Two body.");

  const before = (await manager.listMemories()).map((m) => m.filename).sort();

  const failing = makeTextAdapterConfig({ failure: "provider exploded" });
  const failed = await consolidateMemories(manager, failing);
  assert.equal(failed.changed, false, "a transport failure reports no change");

  const malformed = makeTextAdapterConfig({ object: { merged: "not-an-array", deleted: 42 } });
  const malformedResult = await consolidateMemories(manager, malformed);
  assert.equal(malformedResult.changed, false, "a response with the wrong shapes reports no change");

  assert.deepEqual(
    (await manager.listMemories()).map((m) => m.filename).sort(),
    before,
    "existing memories are untouched by either failure"
  );

  console.log("✓ consolidation failures are contained");
}

// ---------------------------------------------------------------------------
// 8. Every structured request projects to a usable provider schema
// ---------------------------------------------------------------------------
//
// This is the assertion that was missing when extraction shipped broken.
//
// The fake adapters above hand `extractMemories` the exact object the schema
// wants, so they only ever exercise the port's *post*-request half. The half they
// cannot see is the request itself: the provider builds its `input_schema` from
// the schema's `properties`, so a top-level array reaches the model as
// `{ type: "object", properties: {} }`, the model invents a wrapper key, and
// every call fails validation — 0 memories forever, one inconclusive warning per
// turn. Fixtures shaped like the schema's own output hid that completely.
//
// So each shipped schema is rendered the way a real adapter renders it, and the
// projection is asserted non-degenerate.

/**
 * Render a schema the way the Anthropic adapter does for its forced-tool path
 * (`@tanstack/ai-anthropic` `structuredOutput`), where the tool's JSON schema is
 * rebuilt from `properties` / `required` alone.
 */
const projectForProvider = (schema) => {
  const jsonSchema = schema["~standard"].jsonSchema.input();
  return {
    type: "object",
    properties: jsonSchema.properties ?? {},
    required: jsonSchema.required ?? [],
  };
};

// The shipped extraction schema is not exported, so it is reconstructed from the
// one shape the extraction path must accept. Its root is what matters.
const shippedSchemas = [
  ["extraction", z.object({ memories: z.array(z.object({ name: z.string() })) })],
  ["retrieval", z.object({ selected_memories: z.array(z.string()) })],
  ["consolidation", z.object({ merged: z.array(z.object({ name: z.string() })), deleted: z.array(z.string()) })],
];

for (const [label, schema] of shippedSchemas) {
  const projected = projectForProvider(schema);
  const rootType = schema["~standard"].jsonSchema.input().type;

  assert.equal(rootType, "object", `${label}: the schema root is an object, which every provider can express`);
  assert.ok(
    Object.keys(projected.properties).length > 0,
    `${label}: the projected tool schema keeps its properties (an empty object means the provider can never return the right shape)`
  );
}

// Negative control: a bare array is exactly the shape that breaks, and the port
// must refuse it rather than send a degenerate request.
const bareArray = z.array(z.object({ name: z.string() }));
assert.deepEqual(
  projectForProvider(bareArray).properties,
  {},
  "negative control: a top-level array really does project to an empty object"
);
await assert.rejects(
  () =>
    runSideTextQuery(
      {
        adapter: { kind: "text", name: "fake", model: "fake-model", "~types": {} },
        model: "fake-model",
        modelStyle: "openai",
      },
      { userPrompt: "x", schema: bareArray }
    ),
  /requires a top-level object schema/,
  "a bare-array schema is refused at the call site instead of being sent as an empty object"
);

console.log("✓ structured requests project to a usable provider schema");

// ---------------------------------------------------------------------------
// 9. The selection schema absorbs the provider's single-key wrapper
// ---------------------------------------------------------------------------
//
// Measured against the configured Anthropic-style endpoint: the selector returns
// `{"selected_memories":{"selected_memories":[...]}}` for a nontrivial fraction of
// calls (2 of 4 sampled). The nesting is in the provider's `tool_use.input` itself,
// so nothing here produced it and no prompt wording prevents it. Before this, the
// mismatch aborted structured mode and the text retry then answered `[]`, so the
// model's real selection was thrown away and retrieval silently degraded to the
// keyword fallback.
//
// The tolerance is deliberately narrow. These assertions are the whole contract: the
// accepted shapes below must be accepted, and everything else must still be REJECTED
// — a transform that silently reinterprets a genuine response is worse than the
// failure it hides, because the wrong answer then arrives looking like a valid one.

{
  // The selection schema is not exported, so it is driven through the real port the
  // way `findRelevantMemories` does (Zod v4 exposes the Standard Schema + JSON Schema
  // surfaces the port reads).
  const selectionAdapter = (object) => ({
    model: "fake-model",
    modelStyle: "openai",
    adapter: {
      kind: "text",
      name: "fake",
      model: "fake-model",
      "~types": {},
      chatStream() {
        return (async function* () {
          yield usageChunk(1, 1);
        })();
      },
      async structuredOutput() {
        throw new Error("not implemented");
      },
      structuredOutputStream() {
        return (async function* () {
          yield completeChunk(object);
          yield usageChunk(10, 2);
        })();
      },
    },
  });

  // Mirrors `SELECTION_SCHEMA`: the same inner object plus the wrapper tolerance.
  const unwrapSingleKeyWrapper = (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const keys = Object.keys(value);
    if (keys.length !== 1) return value;
    const key = keys[0];
    const nested = value[key];
    if (typeof nested !== "object" || nested === null || Array.isArray(nested)) return value;
    return key in nested ? nested : value;
  };
  const inner = z.object({ selected_memories: z.array(z.string()) });
  const selectionSchema = z.preprocess(unwrapSingleKeyWrapper, inner);

  const select = async (object) =>
    (await runSideTextQuery(selectionAdapter(object), { userPrompt: "query", schema: selectionSchema })).data;

  // 9a — the wrapper is absorbed, and the payload survives it intact.
  const nested = await select({ selected_memories: { selected_memories: ["a.md", "b.md"] } });
  assert.deepEqual(
    nested.selected_memories,
    ["a.md", "b.md"],
    "a single-key wrapper named after the root key is unwrapped, so the model's real selection is used"
  );

  // 9b — an empty selection survives the same path (the `[]` that used to be the
  // silent answer for every failure).
  const nestedEmpty = await select({ selected_memories: { selected_memories: [] } });
  assert.deepEqual(nestedEmpty.selected_memories, [], "an empty selection is still a selection");

  // 9c — the plain shape is untouched: the transform must be a no-op when there is
  // nothing to unwrap.
  const plain = await select({ selected_memories: ["a.md"] });
  assert.deepEqual(plain.selected_memories, ["a.md"], "the correct shape passes through unchanged");

  // 9d — the boundaries. Each of these must FAIL, not be coerced.
  const rejected = [
    ["a differently-named wrapper", { result: { selected_memories: ["a.md"] } }],
    ["a wrapper carrying extra keys", { selected_memories: { selected_memories: ["a.md"] }, extra: 1 }],
    ["double wrapping", { selected_memories: { selected_memories: { selected_memories: ["a.md"] } } }],
    ["a bare string leaf", { selected_memories: "a.md" }],
  ];
  for (const [label, object] of rejected) {
    await assert.rejects(
      () => select(object),
      `${label} must stay a failure — the tolerance is one level, one key, one name`
    );
  }

  // 9e — the tolerance must not change what the provider is asked for. The text-mode
  // contract is rendered from this schema; a wrapper that leaked into the projection
  // would tell the model to emit something the validator then rejects.
  const projected = projectForProvider(selectionSchema);
  assert.deepEqual(
    Object.keys(projected.properties),
    ["selected_memories"],
    "the projected provider schema keeps the root key the validator reads"
  );
  assert.equal(
    projected.properties.selected_memories.type,
    "array",
    "and keeps its declared type, so the request is not degenerate"
  );
  assert.deepEqual(projected.required, ["selected_memories"], "and keeps it required");

  console.log("✓ the selection schema absorbs only the single-key wrapper");
}

await rm(root, TEMP_RM_OPTIONS);

console.log("memory-llm-contract validation passed");

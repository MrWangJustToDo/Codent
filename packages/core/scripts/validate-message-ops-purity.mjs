/**
 * Converging message operations: writers on the model wire are pure.
 *
 * `compaction` rebuilds the wire from `channel.getMessages()` and
 * `WireProjectionCache` hands the **same array reference** back on every hit within a
 * run. That makes the projected array shared, long-lived state: any middleware that
 * edits its input instead of returning a replacement corrupts every later call of the
 * run, and nothing else in the suite would notice.
 *
 * Three fixes are pinned here:
 *
 *   1. `applyToolCompact` — was write-in-place, and parsed every tool payload *before*
 *      consulting its cache (the parse ran once per model call and its result was
 *      discarded on a hit). Now pure, and cache-first.
 *   2. `injectSyntheticMessages` — pushed into the handed-in wire, so an admitted
 *      `<ctx kind=...>` replayed on the next channel projection (double-injected).
 *      Now returns the wire to use.
 *   3. One projection implementation — `projectWireFromChannel` is shared by the
 *      compaction middleware and `ManagedAgent.getMessagesForLLM`, so a reader can
 *      never disagree with the window the model gets.
 *
 * Run: pnpm --filter @codent/core run validate-message-ops-purity
 */

"use strict";

import assert from "node:assert/strict";

import {
  ToolCompactCache,
  applyToolCompact,
  defineServerTool,
  getToolMetadata,
  injectSyntheticMessages,
} from "../dist/dev.mjs";

const noop = () => {};

function makeChannel(ids) {
  return {
    messages: ids.map((id) => ({ id, role: "user", parts: [{ type: "text", content: id }] })),
    getMessages() {
      return this.messages;
    },
    setMessages(next) {
      this.messages = next;
    },
  };
}

// ============================================================================
// 1. applyToolCompact is pure — the input survives byte-identical
// ============================================================================

const purityProbe = defineServerTool({
  name: "purity_probe",
  description: "purity probe",
  execute: async () => ({ value: "A" }),
  toModelOutput: ({ output }) => `shaped:${output.value}`,
});
const registry = { get: (name) => (name === "purity_probe" ? getToolMetadata(purityProbe)?.toModelOutput : undefined) };

{
  const messages = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "p1", type: "function", function: { name: "purity_probe", arguments: "{}" } }],
    },
    { role: "tool", toolCallId: "p1", content: JSON.stringify({ value: "A" }) },
  ];
  const cache = new ToolCompactCache();
  const before = JSON.stringify(messages);

  const out = await applyToolCompact(messages, { registry, cache });

  assert.notEqual(out, messages, "a transformed wire must be a NEW array");
  assert.equal(
    JSON.stringify(messages),
    before,
    "applyToolCompact must not edit the array it was handed (it may be the cached projection)"
  );
  assert.equal(out[1].content, "shaped:A", "the returned wire carries the transformed content");
}

// ============================================================================
// 2. Cache-first: a hit must not re-parse the payload
// ============================================================================

{
  const payload = JSON.stringify({ value: "A", pad: "x".repeat(5000) });
  const messages = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "p2", type: "function", function: { name: "purity_probe", arguments: "{}" } }],
    },
    { role: "tool", toolCallId: "p2", content: payload },
  ];
  const cache = new ToolCompactCache();
  await applyToolCompact(messages, { registry, cache }); // warm the cache
  assert.equal(cache.has("p2"), true, "first pass must populate the cache");

  // Count BYTES decoded, not call count: `buildToolCallInputMap` legitimately parses the
  // (tiny) tool-call arguments every call. The expensive thing is the tool payload.
  const realParse = JSON.parse;
  let bytes = 0;
  JSON.parse = (text, ...rest) => {
    if (typeof text === "string") bytes += text.length;
    return realParse(text, ...rest);
  };
  try {
    const out = await applyToolCompact(messages, { registry, cache });
    assert.equal(out[1].content, "shaped:A", "the cached content is applied");
    assert.ok(
      bytes < payload.length / 10,
      `a cache hit must not re-decode the tool payload: ${bytes} bytes parsed, payload is ${payload.length}. ` +
        `The cache must be consulted BEFORE parseToolMessageOutput.`
    );
  } finally {
    JSON.parse = realParse;
  }
}

// ============================================================================
// 3. injectSyntheticMessages is pure — no replay via the shared wire
// ============================================================================

{
  const channel = makeChannel(["u1"]);
  const wire = [{ role: "user", content: "u1" }];
  const before = JSON.stringify(wire);

  const entry = { kind: "probe", content: "<ctx kind=probe>\nhello\n</ctx>" };
  const first = injectSyntheticMessages(wire, [entry], { ui: channel, persist: noop });

  assert.equal(JSON.stringify(wire), before, "the handed-in wire must not be mutated");
  assert.equal(first.injected.length, 1);
  assert.equal(first.messages.length, 2, "the returned wire carries the injected message");
  assert.ok(first.messages[1].content.includes("hello"));
  assert.equal(channel.messages.length, 2, "the channel got the durable copy");

  // Second call on the SAME (unmutated) wire: id dedupe makes it a no-op, so the ctx
  // cannot be injected twice even though the caller re-projectes from the channel.
  const second = injectSyntheticMessages(wire, [entry], { ui: channel, persist: noop });
  assert.equal(second.injected.length, 0, "re-injecting the same entry is a no-op");
  assert.equal(second.messages, wire, "a no-op returns the input array unchanged");
  assert.equal(channel.messages.length, 2, "no duplicate channel message");
}

// ============================================================================
// 4. One projection implementation
// ============================================================================

{
  // `projectWireFromChannel` must exist as a shared export rather than living inline
  // in the middleware — that inline copy is what silently forked from
  // `getMessagesForLLM` before.
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/managers/middleware/compaction-middleware.ts", import.meta.url), "utf8")
  );
  assert.ok(
    !/^function projectWireFromChannel/m.test(source),
    "the projection must not be re-declared inside compaction-middleware — import it from wire-projection.js"
  );
  assert.match(
    source,
    /from "\.\.\/\.\.\/agent\/compaction\/wire-projection\.js"/,
    "compaction-middleware must take the projection from the shared module"
  );
}

console.log("message-ops purity validation passed");

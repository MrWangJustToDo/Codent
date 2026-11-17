/**
 * Validation for Chat Completions tool-media lifting.
 *
 * Run: pnpm --filter @codent/core run validate:lift-tool-media
 */

import assert from "node:assert/strict";

import { liftToolMediaForChatCompletions } from "../dist/dev.mjs";

const imagePart = {
  type: "image",
  source: { type: "data", value: "abc123", mimeType: "image/png" },
};

const rewritten = liftToolMediaForChatCompletions([
  { role: "user", content: "read the screenshot" },
  {
    role: "assistant",
    content: null,
    toolCalls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }],
  },
  {
    role: "tool",
    toolCallId: "call_1",
    content: [{ type: "text", content: "Image read: shot.png (12KB)" }, imagePart],
  },
]);

assert.equal(rewritten.length, 4);
assert.equal(rewritten[2].role, "tool");
assert.equal(rewritten[2].content, "Image read: shot.png (12KB)");
assert.equal(rewritten[3].role, "user");
assert.ok(Array.isArray(rewritten[3].content));
const userParts = rewritten[3].content;
assert.equal(userParts[0].type, "text");
assert.equal(userParts[1].type, "image");
assert.equal(userParts[1].source.value, "abc123");

// Consecutive tools batch into one synthetic user message
const batched = liftToolMediaForChatCompletions([
  {
    role: "tool",
    toolCallId: "a",
    content: [{ type: "text", content: "A" }, imagePart],
  },
  {
    role: "tool",
    toolCallId: "b",
    content: [
      { type: "text", content: "B" },
      { type: "image", source: { type: "data", value: "def456", mimeType: "image/png" } },
    ],
  },
  { role: "assistant", content: "done" },
]);

assert.equal(batched.length, 4);
assert.equal(batched[0].content, "A");
assert.equal(batched[1].content, "B");
assert.equal(batched[2].role, "user");
assert.equal(batched[2].content.filter((p) => p.type === "image").length, 2);
assert.equal(batched[3].role, "assistant");

// Document-only with caption text: keep text, drop binary (no noisy omit line)
const withDoc = liftToolMediaForChatCompletions([
  {
    role: "tool",
    toolCallId: "pdf",
    content: [
      { type: "text", content: "PDF read: x.pdf\n\nHello from PDF" },
      { type: "document", source: { type: "data", value: "pdfbytes", mimeType: "application/pdf" } },
    ],
  },
]);

assert.equal(withDoc.length, 1);
assert.equal(withDoc[0].role, "tool");
assert.equal(withDoc[0].content, "PDF read: x.pdf\n\nHello from PDF");
assert.ok(!String(withDoc[0].content).includes("pdfbytes"));
assert.ok(!String(withDoc[0].content).includes("Omitted media"));

// Document with no text → omit notice
const docOnly = liftToolMediaForChatCompletions([
  {
    role: "tool",
    toolCallId: "pdf2",
    content: [{ type: "document", source: { type: "data", value: "pdfbytes", mimeType: "application/pdf" } }],
  },
]);
assert.match(String(docOnly[0].content), /Omitted media: Chat Completions cannot embed/);

// Stringified tool content (the wire chunk / an older session) takes the same path: the shared
// `parseStringifiedContentParts` reads it, then the strict `isContentPartArray` check decides.
const stringified = liftToolMediaForChatCompletions([
  {
    role: "tool",
    toolCallId: "s1",
    content: JSON.stringify([{ type: "text", content: "shot.png" }, imagePart]),
  },
]);
assert.equal(stringified[0].content, "shot.png", "a stringified parts array is revived, not sent as JSON text");
assert.equal(stringified[1].role, "user");
assert.equal(stringified[1].content[1].type, "image");

// …and the strictness difference from the strip path is deliberate: a part the provider would reject
// (a `data` source with no `mimeType`) must stay text instead of being lifted onto the wire.
const unstrict = JSON.stringify([{ type: "image", source: { type: "data", value: "abc" } }]);
const notLifted = liftToolMediaForChatCompletions([{ role: "tool", toolCallId: "s2", content: unstrict }]);
assert.equal(notLifted.length, 1, "an unvalidatable array is not lifted");
assert.equal(notLifted[0].content, unstrict, "…it stays the text it arrived as");

// Plain string tool content unchanged
const plain = liftToolMediaForChatCompletions([{ role: "tool", toolCallId: "t", content: "ok" }]);
assert.deepEqual(plain, [{ role: "tool", toolCallId: "t", content: "ok" }]);

console.log("lift-tool-media validation passed");

/**
 * Validates repair of TanStack MESSAGES_SNAPSHOT stringified multimodal content.
 *
 * Run: pnpm --filter @codent/core run validate:repair-stringified-multimodal
 */

import assert from "node:assert/strict";

import {
  repairMessagesSnapshotChunk,
  repairStringifiedMultimodalUIMessages,
  parseStringifiedMultimodalContent,
  isStringifiedMultimodalContentParts,
} from "../dist/dev.mjs";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

const multimodalParts = [
  { type: "text", content: "[Image #1: clipboard-70f63a7d.png] tell me about this" },
  {
    type: "image",
    source: { type: "url", value: TINY_PNG_DATA_URL },
    metadata: { mediaType: "image/png", filename: "clipboard-70f63a7d.png", imageIndex: 1 },
  },
];

function testParse() {
  assert.equal(parseStringifiedMultimodalContent("hello"), null);
  assert.equal(parseStringifiedMultimodalContent('[{"type":"text","content":"only"}]'), null);
  // Loose, but not shapeless: a text part whose payload is not a string, and a binary part with no
  // `source` object, are not parts — admitting them would have the repair rewrite a message whose
  // "text" is a number and drop an image it cannot classify.
  assert.equal(parseStringifiedMultimodalContent('[{"type":"text","content":123},{"type":"image","source":{}}]'), null);
  assert.equal(parseStringifiedMultimodalContent('[{"type":"text","content":"x"},{"type":"image"}]'), null);
  assert.equal(parseStringifiedMultimodalContent('{"type":"text","content":"x"}'), null, "an object is not an array");
  assert.ok(isStringifiedMultimodalContentParts(multimodalParts));
  const parsed = parseStringifiedMultimodalContent(JSON.stringify(multimodalParts));
  assert.ok(parsed);
  assert.equal(parsed.length, 2);
  console.log("  ✓ parseStringifiedMultimodalContent");
}

function testRepairUIMessages() {
  const messages = [
    {
      id: "snapshot_chat-1_3",
      role: "user",
      parts: [{ type: "text", content: JSON.stringify(multimodalParts) }],
    },
    {
      id: "ok",
      role: "user",
      parts: [{ type: "text", content: "plain" }],
    },
  ];

  const repaired = repairStringifiedMultimodalUIMessages(messages);
  assert.notEqual(repaired, messages);
  assert.equal(repaired[0].parts.length, 2);
  assert.equal(repaired[0].parts[0].type, "text");
  assert.equal(repaired[0].parts[0].content, multimodalParts[0].content);
  assert.equal(repaired[1].parts[0].content, "plain");
  assert.equal(repairStringifiedMultimodalUIMessages(repaired), repaired, "idempotent");
  console.log("  ✓ repairStringifiedMultimodalUIMessages");
}

function testRepairSnapshotChunk() {
  const chunk = {
    type: "MESSAGES_SNAPSHOT",
    timestamp: Date.now(),
    messages: [
      { id: "snapshot_0", role: "user", content: "hi" },
      { id: "snapshot_1", role: "user", content: JSON.stringify(multimodalParts) },
    ],
  };

  const repaired = repairMessagesSnapshotChunk(chunk);
  assert.notEqual(repaired, chunk);
  assert.equal(typeof repaired.messages[0].content, "string");
  assert.ok(Array.isArray(repaired.messages[1].content));
  assert.equal(repaired.messages[1].content[0].type, "text");
  assert.equal(repaired.messages[1].content[0].text, multimodalParts[0].content);
  assert.equal(repaired.messages[1].content[1].type, "image");

  const again = repairMessagesSnapshotChunk(repaired);
  assert.equal(again, repaired, "already-array content is left alone");
  console.log("  ✓ repairMessagesSnapshotChunk");
}

console.log("Repair stringified multimodal validation...\n");
testParse();
testRepairUIMessages();
testRepairSnapshotChunk();
console.log("\n✓ All repair-stringified-multimodal validation tests passed");

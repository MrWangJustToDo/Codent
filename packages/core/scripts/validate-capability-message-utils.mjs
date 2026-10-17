/**
 * Validates capability-gated multimodal message sanitization.
 *
 * Run: pnpm --filter @codent/core run validate:capability-message-utils
 */

import assert from "node:assert/strict";

import {
  MULTIMODAL_OMITTED_PLACEHOLDER,
  chatMessagesHaveMultimodal,
  isMultimodalUnsupportedError,
  sanitizeMessagesForCapabilities,
  stripMultimodalFromChatMessages,
  trySanitizeForMultimodalRetry,
  unsupportedMultimodalPartTypes,
} from "../dist/dev.mjs";

assert.equal(
  isMultimodalUnsupportedError(
    new Error(
      "400 Failed to deserialize the JSON body into the target type: messages[1]: unknown variant `image_url`, expected `text`"
    )
  ),
  true
);
assert.equal(isMultimodalUnsupportedError(new Error("unsupported content part type for adapter: audio")), true);
assert.equal(isMultimodalUnsupportedError(new Error("network timeout")), false);

const withMedia = [
  {
    id: "u1",
    role: "user",
    parts: [
      { type: "text", content: "see this?" },
      {
        type: "image",
        source: { type: "url", value: "data:image/png;base64,abc" },
      },
      {
        type: "document",
        source: { type: "data", value: "JVBERi0x", mimeType: "application/pdf" },
      },
    ],
  },
];

assert.equal(chatMessagesHaveMultimodal(withMedia, new Set(["image"])), true);
assert.equal(chatMessagesHaveMultimodal(withMedia), true);

const textOnly = {
  hasCapability: (cap) => !["vision", "audio", "video", "document"].includes(cap),
};
assert.deepEqual([...unsupportedMultimodalPartTypes(textOnly)].sort(), ["audio", "document", "image", "video"]);

const sanitized = sanitizeMessagesForCapabilities(withMedia, textOnly);
assert.equal(chatMessagesHaveMultimodal(sanitized), false);
assert.equal(
  sanitized[0].parts.some((p) => p.type === "text" && p.content === MULTIMODAL_OMITTED_PLACEHOLDER),
  true
);
assert.equal(
  sanitized[0].parts.some((p) => p.type === "text" && p.content === "see this?"),
  true
);
// Original UI message must stay intact.
assert.equal(chatMessagesHaveMultimodal(withMedia), true);

const visionOnly = {
  hasCapability: (cap) => cap === "vision" || cap === "streaming",
};
const keepImageDropDoc = sanitizeMessagesForCapabilities(withMedia, visionOnly);
assert.equal(chatMessagesHaveMultimodal(keepImageDropDoc, new Set(["image"])), true);
assert.equal(chatMessagesHaveMultimodal(keepImageDropDoc, new Set(["document"])), false);

const retry = trySanitizeForMultimodalRetry(new Error("unknown variant `image_url`, expected `text`"), withMedia);
assert.ok(retry);
assert.equal(chatMessagesHaveMultimodal(retry), false);

assert.equal(
  trySanitizeForMultimodalRetry(
    new Error("unknown variant `image_url`"),
    stripMultimodalFromChatMessages(withMedia, new Set(["image", "audio", "video", "document"]))
  ),
  null
);

// ============================================================================
// Ordering: each dropped attachment keeps its own identity and position
// ============================================================================
// The placeholder exists so a model on a non-vision model can still tell WHICH of the
// session's attachments was omitted. A single trailing constant destroyed both the count and
// the position, so a message with two attachments (one carrying app-level identity, one not)
// and text between them must come out as: text, placeholder(#1), text, placeholder(#2).
const ordered = [
  {
    id: "u2",
    role: "user",
    parts: [
      { type: "text", content: "[Image #1: a.png] first" },
      {
        type: "image",
        source: { type: "url", value: "data:image/png;base64,aaa" },
        metadata: { imageIndex: 1, filename: "a.png" },
      },
      { type: "text", content: "then" },
      {
        type: "image",
        source: { type: "url", value: "data:image/png;base64,bbb" },
        metadata: { imageIndex: 2, filename: "b.png" },
      },
      { type: "document", source: { type: "data", value: "JVBERi0x", mimeType: "application/pdf" } },
    ],
  },
];
const orderedStripped = stripMultimodalFromChatMessages(ordered, new Set(["image", "document"]));
const orderedParts = orderedStripped[0].parts;
assert.deepEqual(
  orderedParts.map((p) => p.type),
  ["text", "text", "text", "text", "text"],
  "every dropped part becomes a text part in place"
);
assert.equal(orderedParts[1].content, "[Image #1: a.png omitted — current model has no vision input.]");
assert.equal(orderedParts[3].content, "[Image #2: b.png omitted — current model has no vision input.]");
// A part with no identity cannot invent an index — it keeps the generic placeholder.
assert.equal(orderedParts[4].content, MULTIMODAL_OMITTED_PLACEHOLDER);
// Position is preserved: the text between the two images stays between them.
assert.equal(orderedParts[2].content, "then");
// Ordering information must not leak into the runtime messages.
assert.equal(ordered[0].parts[1].type, "image");
assert.equal(ordered[0].parts[1].metadata.filename, "a.png");

// A filename without an index still identifies the part, and vice versa.
const partialIdentity = stripMultimodalFromChatMessages(
  [
    {
      id: "u3",
      role: "user",
      parts: [
        {
          type: "image",
          source: { type: "url", value: "data:image/png;base64,x" },
          metadata: { filename: "only-name.png" },
        },
      ],
    },
  ],
  new Set(["image"])
);
assert.equal(
  partialIdentity[0].parts[0].content,
  "[Image: only-name.png omitted — current model has no vision input.]"
);

// Optimistic probe (empty capabilities semantics via always-true) → no preemptive strip.
const optimistic = { hasCapability: () => true };
assert.equal(sanitizeMessagesForCapabilities(withMedia, optimistic), withMedia);

console.log("capability-message-utils validation passed");

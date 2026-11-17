/**
 * Validates the capability-gated multimodal strip **rules** and the primitives the real send path
 * uses.
 *
 * The strip itself does not run here — it runs in `wire-recovery-middleware` from the per-run drop
 * set `armCapabilityStrip` / `tryCapabilitySanitizeRetry` put on the run; those are covered by
 * `validate-run-stream-recovery.mjs` and `validate-wire-override-reaches-adapter.mjs`. This script
 * covers what those paths are built out of: the gate/table agreement, the multimodal scan, the
 * error classifier, the in-place replacement (identity + ordering + malformed-entry tolerance), and
 * the string tool-result form.
 *
 * Run: pnpm --filter @codent/core run validate:capability-message-utils
 */

import assert from "node:assert/strict";

import {
  MODALITY_CAPABILITY,
  MULTIMODAL_OMITTED_PLACEHOLDER,
  MULTIMODAL_PART_CAPABILITY,
  MULTIMODAL_PART_TYPES,
  chatMessagesHaveMultimodal,
  isMultimodalUnsupportedError,
  stripMultimodalContentParts,
  stripMultimodalFromChatMessages,
  unsupportedMultimodalPartTypes,
} from "../dist/dev.mjs";

// ============================================================================
// The gate names capabilities the metadata can actually grant
// ============================================================================
// One relation, two tables with different vocabularies: `MULTIMODAL_PART_CAPABILITY` (part type →
// capability, the strip's gate) and models.dev's `MODALITY_CAPABILITY` (input modality → capability,
// the parse step). A gate naming a capability the metadata never produces cannot open — that part
// type would be stripped for EVERY model, including one that accepts it, and no type error would say
// so. (Key coverage over the part-type tuple is not asserted here: the record is
// `Record<MultimodalPartType, ModelCapability>`, so a missing key fails `tsc` before any script runs.)
const grantableCapabilities = new Set(Object.values(MODALITY_CAPABILITY));
for (const [partType, capability] of Object.entries(MULTIMODAL_PART_CAPABILITY)) {
  assert.ok(
    grantableCapabilities.has(capability),
    `"${partType}" is gated on "${capability}", which no models.dev modality grants — the gate could never open`
  );
}
// …and the reverse, for the part types the strip can drop: a capability granted by metadata but
// naming no part type is dead plumbing (it would widen the retry for nothing).
assert.deepEqual(
  [...new Set(Object.values(MULTIMODAL_PART_CAPABILITY))].sort(),
  [...new Set(Object.values(MODALITY_CAPABILITY))].sort(),
  "the metadata's grantable capabilities and the strip's gates must be the same set"
);
assert.deepEqual(
  [...Object.keys(MULTIMODAL_PART_CAPABILITY)].sort(),
  [...MULTIMODAL_PART_TYPES].sort(),
  "the dev surface must publish the same part-type tuple the gates are keyed by"
);

// ============================================================================
// Error classification
// ============================================================================

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

// ============================================================================
// Probe → drop set
// ============================================================================
// `unsupportedMultimodalPartTypes` is the single place a capability answer becomes a drop set.
// `armCapabilityStrip` stores exactly this set on the run, and `wire-recovery` applies it.

const textOnlyProbe = {
  hasCapability: (cap) => !["vision", "audio", "video", "document"].includes(cap),
};
const allDropped = unsupportedMultimodalPartTypes(textOnlyProbe);
assert.deepEqual([...allDropped].sort(), ["audio", "document", "image", "video"]);

const visionOnlyProbe = { hasCapability: (cap) => cap === "vision" };
assert.deepEqual([...unsupportedMultimodalPartTypes(visionOnlyProbe)].sort(), ["audio", "document", "video"]);

// Unknown capabilities are permissive: `UsageTracker.hasCapability` returns true for every cap when
// nothing was resolved, and a null probe (no usage) must not drop anything either.
assert.equal(unsupportedMultimodalPartTypes({ hasCapability: () => true }).size, 0);
assert.equal(unsupportedMultimodalPartTypes(null).size, 0);
assert.equal(unsupportedMultimodalPartTypes(undefined).size, 0);

// ============================================================================
// Multimodal scan, both message shapes
// ============================================================================

const withMedia = [
  {
    id: "u1",
    role: "user",
    parts: [
      { type: "text", content: "see this?" },
      { type: "image", source: { type: "url", value: "data:image/png;base64,abc" } },
      { type: "document", source: { type: "data", value: "JVBERi0x", mimeType: "application/pdf" } },
    ],
  },
];

assert.equal(chatMessagesHaveMultimodal(withMedia, new Set(["image"])), true);
assert.equal(chatMessagesHaveMultimodal(withMedia), true);
assert.equal(chatMessagesHaveMultimodal(withMedia, new Set(["audio", "video"])), false);
assert.equal(chatMessagesHaveMultimodal([{ role: "user", content: "plain string" }]), false);
// A wire message carries its parts in `content` instead of `parts` — same scan, and a malformed
// entry must be skipped rather than thrown out of the send path.
assert.equal(
  chatMessagesHaveMultimodal([
    {
      role: "tool",
      content: [{ type: "image", source: { type: "data", value: "x", mimeType: "image/png" } }],
    },
  ]),
  true
);
assert.equal(chatMessagesHaveMultimodal([{ role: "tool", content: [null, { type: "text", content: "ok" }] }]), false);

// ============================================================================
// Strip: every drop becomes a placeholder, originals stay untouched
// ============================================================================

const strippedAll = stripMultimodalFromChatMessages(withMedia, unsupportedMultimodalPartTypes(textOnlyProbe));
assert.notEqual(strippedAll, withMedia, "a strip that dropped something returns a new array");
assert.equal(chatMessagesHaveMultimodal(strippedAll), false);
assert.equal(
  strippedAll[0].parts.some((part) => part.type === "text" && part.content === MULTIMODAL_OMITTED_PLACEHOLDER),
  true
);
assert.equal(
  strippedAll[0].parts.some((part) => part.type === "text" && part.content === "see this?"),
  true
);
// UI history keeps its media — the strip is wire-only.
assert.equal(chatMessagesHaveMultimodal(withMedia), true);

// A model that takes images but not documents keeps the image and replaces only the document.
const keepImageDropDoc = stripMultimodalFromChatMessages(withMedia, unsupportedMultimodalPartTypes(visionOnlyProbe));
assert.equal(chatMessagesHaveMultimodal(keepImageDropDoc, new Set(["image"])), true);
assert.equal(chatMessagesHaveMultimodal(keepImageDropDoc, new Set(["document"])), false);

// Nothing to drop → the message objects come back unchanged, and the SAME array: `drop.size === 0`
// short-circuits before the map, which is what lets a caller treat the result as a no-op. (A
// non-empty drop set that matches nothing still allocates a new array — `unrelatedDrop` below —
// because deciding that would cost the same walk as copying.)
const noDropSet = new Set();
const untouched = stripMultimodalFromChatMessages(withMedia, noDropSet);
assert.equal(untouched, withMedia, "an empty drop set must return the input array itself");
const unrelatedDrop = stripMultimodalFromChatMessages(withMedia, new Set(["audio"]));
assert.equal(unrelatedDrop[0], withMedia[0], "an unrelated drop set must not copy the message");

// A wire `content` array that crossed JSON can hold a hole/`null`; the scan tolerates it, so the
// strip must too — otherwise the repair path throws on the array it was armed to repair.
const withHole = [{ type: "text", content: "ok" }, null, { type: "image", source: { type: "data", value: "x" } }];
const strippedHole = stripMultimodalContentParts(withHole, new Set(["image"]));
assert.equal(strippedHole.length, 3, "a malformed entry is kept, not dropped");
assert.equal(strippedHole[1], null);
assert.equal(strippedHole[2].type, "text");

// ============================================================================
// Strip: a widened post-rejection retry drops every type
// ============================================================================
// What `tryCapabilitySanitizeRetry` arms after `isMultimodalUnsupportedError`: the full part-type
// tuple, applied by the wire projection. Composed here from the same two primitives.

const rejection = new Error("unknown variant `image_url`, expected `text`");
assert.equal(isMultimodalUnsupportedError(rejection), true, "the retry is only warranted for this error class");
const widened = stripMultimodalFromChatMessages(withMedia, new Set(MULTIMODAL_PART_TYPES));
assert.equal(chatMessagesHaveMultimodal(widened), false, "the widened retry drops every multimodal type");

// A transcript that is already clean strips to the same message objects (nothing to widen further).
const alreadyClean = stripMultimodalFromChatMessages(withMedia, new Set(MULTIMODAL_PART_TYPES));
const widenedAgain = stripMultimodalFromChatMessages(alreadyClean, new Set(MULTIMODAL_PART_TYPES));
assert.deepEqual(widenedAgain, alreadyClean);

// ============================================================================
// The exported primitive is what the tool-result seam calls (`wire-recovery-middleware`)
// ============================================================================

const toolContent = [
  { type: "text", content: "tool said" },
  { type: "image", source: { type: "data", value: "abc", mimeType: "image/png" } },
];
const toolStripped = stripMultimodalContentParts(toolContent, new Set(["image"]));
assert.deepEqual(
  toolStripped.map((part) => part.type),
  ["text", "text"]
);
assert.equal(toolStripped[1].content, MULTIMODAL_OMITTED_PLACEHOLDER);
assert.equal(toolContent[1].type, "image", "the input array is not mutated");
assert.equal(
  stripMultimodalContentParts(toolContent, new Set(["audio"])),
  toolContent,
  "no drop → same array identity"
);

// ============================================================================
// Ordering: each dropped attachment keeps its own identity and position
// ============================================================================
// The placeholder exists so a model without vision can still tell WHICH of the session's
// attachments was omitted. A single trailing constant destroyed both the count and the position,
// so a message with two attachments (one carrying app-level identity, one not) and text between
// them must come out as: text, placeholder(#1), text, placeholder(#2).
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
  orderedParts.map((part) => part.type),
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

console.log("capability-message-utils validation passed");

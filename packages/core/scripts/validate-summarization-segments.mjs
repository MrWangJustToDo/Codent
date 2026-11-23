/**
 * Validates segmented summarization prompt construction (labels + cut index).
 *
 * Run: pnpm --filter @codent/core run validate:summarization-segments
 */

import assert from "node:assert/strict";

import {
  buildCompactionPrompt,
  buildSegmentedConversationText,
  buildSummarizationUserPrompt,
  STILL_IN_CONTEXT_RULES,
  TEXT_BLOCK_MAX_CHARS,
  serializeConversation,
} from "../dist/dev.mjs";

const messages = [
  { role: "user", content: "First request about auth" },
  { role: "assistant", content: "Working on auth" },
  { role: "user", content: "Second request about tests" },
  { role: "assistant", content: "Writing tests" },
  { role: "user", content: "Third request about docs" },
  { role: "assistant", content: "Updating docs" },
];

// Cut math (pairing-safe token-budget walk) is validated separately in
// validate-compaction-keep-policy / validate-message-chain-projection. Here we
// pick a fixed cut index to exercise segmentation prompt construction.
const llmCutIndex = 2;

const toCompress = messages.slice(0, llmCutIndex);
const stillInContext = messages.slice(llmCutIndex);

assert.equal(toCompress.length, 2);
assert.equal(stillInContext[0].content, "Second request about tests");

const segmented = buildSegmentedConversationText(toCompress, stillInContext);
assert.match(segmented, /<to_compress>/);
assert.match(segmented, /<\/to_compress>/);
assert.match(segmented, /<still_in_context>/);
assert.match(segmented, /<\/still_in_context>/);
assert.match(segmented, /First request about auth/);
assert.match(segmented, /Second request about tests/);
assert.doesNotMatch(segmented, /<conversation>/);

const prompt = buildSummarizationUserPrompt(toCompress, { stillInContext });
assert.match(prompt, /<to_compress>/);
assert.match(prompt, /<still_in_context>/);
assert.match(prompt, /Segment rules/);
assert.ok(prompt.includes(STILL_IN_CONTEXT_RULES));

const withoutStill = buildSummarizationUserPrompt(toCompress);
assert.match(withoutStill, /<to_compress>/);
assert.doesNotMatch(withoutStill, /<still_in_context>/);
assert.doesNotMatch(withoutStill, /Segment rules/);

const instruction = buildCompactionPrompt({ hasStillInContext: true });
assert.match(instruction, /Do NOT restate/);

// A legacy ## Compact archives section (written before the archive removal) must still be kept
// out of <previous-summary>, so an incremental update never restates a stale path list.
const withArchives = buildCompactionPrompt({
  existingSummary: `## Goal\n\nShip it\n\n## Compact archives\n\n- \`.agents/transcripts/ses/compact-1.md\``,
});
assert.match(withArchives, /<previous-summary>/);
const prevBlock = withArchives.match(/<previous-summary>\n([\s\S]*?)\n<\/previous-summary>/)?.[1] ?? "";
assert.match(prevBlock, /## Goal/);
assert.doesNotMatch(prevBlock, /## Compact archives/);
assert.doesNotMatch(prevBlock, /compact-1\.md/);

// Cut index must stay relative to input messages for applyCompactionResult.
const cutIndex = llmCutIndex; // no previous summary offset
assert.equal(cutIndex, 2);

// --- long prose is bounded, not just tool results -------------------------------------------
//
// Tool results were capped while user/assistant text was not, and `splitMessagesByTokenBudget` never
// splits a single message. One 300 KB paste therefore became a batch of its own: the summarizer
// request itself hit `prompt_too_long`, compaction could not compact exactly when it was needed, and
// the reactive retry spent its only attempt on the same request.
{
  const huge = "x".repeat(300_000);
  const serialized = serializeConversation([
    { role: "user", content: huge },
    { role: "assistant", content: huge },
    { role: "tool", toolCallId: "tc1", content: huge },
  ]);
  assert.ok(
    serialized.length < TEXT_BLOCK_MAX_CHARS * 3 + 2_000,
    `every block is bounded (got ${serialized.length} chars)`
  );
  assert.match(serialized, /chars truncated/, "…and says so");
  assert.ok(serialized.includes("[User]:"), "the labels survive the cut");

  // A normal message is untouched, so nothing was tightened for the common case.
  const normal = serializeConversation([{ role: "user", content: "short request" }]);
  assert.equal(normal, "[User]: short request");
}

console.log("summarization-segments validation passed");

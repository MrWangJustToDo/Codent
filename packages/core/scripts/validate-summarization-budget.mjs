import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_SUMMARIZATION_CONTEXT_WINDOW,
  boundedMergeInput,
  buildSummarizationUserPrompt,
  SUMMARY_OUTPUT_CAP,
  measureSerializedConversationChars,
  measureSerializedTokens,
  resolveSummarizationBudget,
  resolveSummarizationInputBudget,
  resolveAutoCompactTrigger,
  splitMessagesByTokenBudget,
  truncateMergeInput,
} from "../dist/dev.mjs";

// ============================================================================
// Model-metadata-driven budget
// ============================================================================

// Real model output cap drives the reserve → single-pass for typical models.
{
  const b = resolveSummarizationBudget({ contextWindow: 128_000, defaultMaxTokens: 16_000 });
  assert.equal(b.maxOutputTokens, 16_000, "maxOutputTokens should use the model's real cap");
  assert.equal(b.inputBudget, 128_000 - 16_000 - 8_000, "inputBudget reserves output + overhead");
}
{
  const b = resolveSummarizationBudget({ contextWindow: 400_000, defaultMaxTokens: 16_000 });
  assert.equal(b.maxOutputTokens, 16_000);
  assert.equal(b.inputBudget, 400_000 - 16_000 - 8_000);
}
{
  const b = resolveSummarizationBudget({ contextWindow: 1_000_000, defaultMaxTokens: 32_000 });
  assert.equal(b.maxOutputTokens, 32_000);
  assert.equal(b.inputBudget, 1_000_000 - 32_000 - 8_000);
}

// A model's declared max output is capped so it cannot starve the input budget.
{
  const b = resolveSummarizationBudget({ contextWindow: 1_000_000, defaultMaxTokens: 384_000 });
  assert.equal(b.maxOutputTokens, SUMMARY_OUTPUT_CAP, "output reserve is capped");
  assert.equal(
    b.inputBudget,
    1_000_000 - SUMMARY_OUTPUT_CAP - 8_000,
    "inputBudget keeps the window minus the capped reserve"
  );
}

// Fallback when the model reports no output cap: derive a window-based reserve.
{
  const b = resolveSummarizationBudget({ contextWindow: 128_000 });
  assert.equal(b.maxOutputTokens, Math.floor(128_000 * 0.12), "fallback reserve derived from window");
  assert.equal(b.inputBudget, 128_000 - b.maxOutputTokens - 8_000);
}

// Unknown model: default context window + fallback reserve.
{
  const b = resolveSummarizationBudget(undefined);
  assert.equal(
    b.inputBudget,
    Math.max(
      16_000,
      DEFAULT_SUMMARIZATION_CONTEXT_WINDOW - Math.floor(DEFAULT_SUMMARIZATION_CONTEXT_WINDOW * 0.12) - 8_000
    )
  );
  assert.equal(b.maxOutputTokens, Math.floor(DEFAULT_SUMMARIZATION_CONTEXT_WINDOW * 0.12));
}

// resolveSummarizationInputBudget (manager-backed) matches the model path.
{
  const inputBudget = resolveSummarizationInputBudget(
    { getAgent: () => ({ getModelInfo: () => ({ contextWindow: 128_000, defaultMaxTokens: 16_000 }) }) },
    "agent-1"
  );
  assert.equal(inputBudget, 128_000 - 16_000 - 8_000, "inputBudget from model metadata");
}

// ============================================================================
// Single-pass default: budget covers the trigger slice (default config 80%)
// ============================================================================
function triggerFor(window, tokenThreshold) {
  return resolveAutoCompactTrigger({ tokenThreshold, compactAtPercent: 80 }, window).triggerAt;
}

for (const [label, window, tokenThreshold, defaultMaxTokens] of [
  ["128k", 128_000, 128_000, 16_000],
  ["400k", 400_000, 400_000, 16_000],
  ["1M (cap 400k)", 1_000_000, 400_000, 32_000],
]) {
  const b = resolveSummarizationBudget({ contextWindow: window, defaultMaxTokens });
  const trigger = triggerFor(window, tokenThreshold);
  assert.ok(
    b.inputBudget >= trigger,
    `${label}: budget ${b.inputBudget} should cover trigger ${trigger} (single-pass)`
  );
}

// ============================================================================
// splitMessagesByTokenBudget — single-pass default + genuine overflow fallback
// ============================================================================

// A small slice stays one batch under the model-derived budget.
{
  const { inputBudget } = resolveSummarizationBudget({ contextWindow: 128_000, defaultMaxTokens: 16_000 });
  const slice = [
    { role: "user", content: "short message" },
    { role: "assistant", content: "ok" },
  ];
  const batches = splitMessagesByTokenBudget(slice, inputBudget);
  assert.equal(batches.length, 1, "a slice within budget should stay a single batch");
  assert.equal(batches.flat().length, slice.length);
}

// A ~2× budget slice splits (fallback preserved).
{
  const { inputBudget } = resolveSummarizationBudget({ contextWindow: 128_000, defaultMaxTokens: 16_000 });
  // Sized AFTER serialization: one 40 KB message is now cut to `TEXT_BLOCK_MAX_CHARS` by the
  // serializer, so "21 × 40 000 chars" stopped being oversized (the fixture, not the splitter, was
  // what shrank). Many messages still exceed the budget by ~2×, which is the property under test.
  const huge = Array.from({ length: 200 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: "x".repeat(40_000),
  }));
  const batches = splitMessagesByTokenBudget(huge, inputBudget);
  assert.ok(batches.length > 1, "an oversized (2× budget) slice should split");
  assert.equal(batches.flat().length, huge.length, "…without dropping a message");
}

// ============================================================================
// The merge pass sends summary text VERBATIM (rawText)
// ============================================================================
//
// `buildSummarizationUserPrompt` serializes conversation history and caps a text block at
// `TEXT_BLOCK_MAX_CHARS`. Applying that to the MERGE input was silent data loss: the request was one
// user message built from every segment summary, so the cap kept only the first 8000 characters — and
// the split decision measured the same truncated string, so it always "fit" and never split. The
// partials were paid for and discarded. `rawText` is the seam that says "this is already a summary".
{
  const longSummary = `${"S".repeat(9_000)}TAIL-MARKER`;
  const raw = buildSummarizationUserPrompt([{ role: "user", content: longSummary }], { rawText: true });
  assert.ok(raw.includes("TAIL-MARKER"), "raw mode sends the whole summary text");
  assert.ok(!raw.includes("chars truncated"), "raw mode does not apply the per-block cap");

  const asHistory = buildSummarizationUserPrompt([{ role: "user", content: longSummary }]);
  assert.ok(!asHistory.includes("TAIL-MARKER"), "history mode still caps a text block");
  assert.match(asHistory, /chars truncated/, "…and says so");

  // The bound itself: everything within the budget survives; only what cannot be subdivided is cut,
  // and it says so. This is the seam the merge pass uses, so a truncated marker here is the only
  // permitted loss.
  const parts = Array.from({ length: 6 }, (_, i) => `segment-${i}-TAIL`);
  const joined = parts.map((p, i) => `## Segment ${i + 1}\n\n${p}`).join("\n\n");
  assert.equal(truncateMergeInput(joined, 10_000), joined, "a request inside the bound is sent verbatim");
  const over = truncateMergeInput(joined, 60);
  assert.ok(!over.includes("segment-5-TAIL"), "a request past the bound is cut");
  assert.match(over, /chars truncated/, "…and names the loss");

  // A cut exactly between the halves of an astral character leaves a lone surrogate, which is
  // invalid UTF-8 on the wire. `slice` was the only thing standing between the two, and the cap is
  // reached at an arbitrary byte position.
  const boundary = `${"a".repeat(7_999)}😀TAIL`;
  const cut = buildSummarizationUserPrompt([{ role: "user", content: boundary }]);
  assert.ok(
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut),
    "truncation must not split a surrogate pair (a lone high surrogate is invalid text)"
  );

  // The bounded merge keeps EVERY summary: cutting the joined text kept only the head, so with two
  // summaries the second one (which starts past the bound) vanished from the request entirely.
  {
    const one = `FIRST-${"a".repeat(600)}`;
    const two = `SECOND-${"b".repeat(600)}`;
    const bounded = boundedMergeInput([one, two], 400);
    assert.ok(bounded.includes("FIRST-"), "the first summary survives the bound");
    assert.ok(bounded.includes("SECOND-"), "…and so does the second (a head-only cut dropped it)");
    assert.ok(bounded.length <= 400 + 80, `the bound holds (got ${bounded.length})`);
  }

  // The recursion must not split a two-way merge: there is no smaller split, so re-entering with
  // [left, right] looped forever (two paid completions per pass). Only >2 summaries can shrink.
  {
    const autoCompactSrc = readFileSync(new URL("../src/agent/compaction/auto-compact.ts", import.meta.url), "utf8");
    assert.match(
      autoCompactSrc,
      /summaries\.length > 2 && mergeInputText\(summaries\)\.length > mergeMaxChars/,
      "the merge split requires at least three summaries, so every pass makes progress"
    );
  }

  // …and the merge pass actually ASKS for verbatim text. Without this, the two seams above hold while
  // the wiring silently serializes (and truncates) again.
  const autoCompactSrc = readFileSync(new URL("../src/agent/compaction/auto-compact.ts", import.meta.url), "utf8");
  assert.match(autoCompactSrc, /rawText: true/, "the merge pass sends summaries verbatim");
}

// ============================================================================
// splitMessagesByTokenBudget — sizes the *serialized* prompt, not the raw wire
// ============================================================================

// A huge (untruncated) tool result fits one batch because the serializer only
// keeps TOOL_RESULT_MAX_CHARS of it. This is the regression that forced
// needless multi-segment compaction (raw estimate >> actual prompt).
{
  const toolCallId = "call_huge";
  const slice = [
    {
      role: "assistant",
      content: "read the file",
      toolCalls: [{ id: toolCallId, type: "function", function: { name: "read_file", arguments: "{}" } }],
    },
    { role: "tool", toolCallId, content: "x".repeat(200_000) },
  ];

  const measured = measureSerializedConversationChars(slice);
  assert.ok(measured < 10_000, `serialized measure should truncate tool output (got ${measured})`);

  const batches = splitMessagesByTokenBudget(slice, 5_000);
  assert.equal(batches.length, 1, "truncated tool output must not force a split");
}

// A genuinely oversized serialized slice still splits (fallback preserved).
//
// The budget is sized to the SERIALIZED prompt, so the fixture has to be oversized there too: one
// 40 KB message is cut to `TEXT_BLOCK_MAX_CHARS` (≈2k tokens) before it is measured, and 6 × 2k is
// well under 50k. Dropping the budget keeps the property under test ("too big to fit one request
// still splits") while reflecting what actually gets sent.
{
  const huge = Array.from({ length: 6 }, () => ({ role: "user", content: "y".repeat(40_000) }));
  const batches = splitMessagesByTokenBudget(huge, 5_000);
  assert.ok(batches.length > 1, "an oversized serialized slice should still split");
  assert.equal(batches.flat().length, huge.length);
}

// ============================================================================
// measureSerializedTokens — observability measure mirrors the splitter
// ============================================================================

// Same truncation-driven sizing as splitMessagesByTokenBudget, in tokens, so the
// `serializedTokens` we log at compact time reflects the split decision.
{
  const toolCallId = "call_obs";
  const slice = [
    {
      role: "assistant",
      content: "read the file",
      toolCalls: [{ id: toolCallId, type: "function", function: { name: "read_file", arguments: "{}" } }],
    },
    { role: "tool", toolCallId, content: "x".repeat(200_000) },
  ];

  const tokens = measureSerializedTokens(slice);
  // 200k chars truncate to TOOL_RESULT_MAX_CHARS (2k) → a handful of tokens.
  assert.ok(tokens < 5_000, `serialized token measure should truncate tool output (got ${tokens})`);
  // Parity with the char measure used by the splitter (ceil(chars / 4)).
  assert.equal(tokens, Math.ceil(measureSerializedConversationChars(slice) / 4));
  // The logged measure agrees with the split decision (within rounding slack).
  assert.equal(splitMessagesByTokenBudget(slice, tokens * 2).length, 1, "logged measure fits one batch");
  assert.ok(
    splitMessagesByTokenBudget(slice, Math.floor(tokens / 2)).length > 1,
    "budget below the logged measure → split"
  );
}

console.log("summarization-budget validation passed");

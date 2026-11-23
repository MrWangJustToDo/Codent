/**
 * Validation for vision token estimates + PNG dimension parsing.
 *
 * Run: pnpm --filter @codent/core run validate:estimate-image-tokens
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import {
  estimateImageInputTokens,
  estimateImageTokensFromDimensions,
  estimateMessageTokens,
  tryReadImageDimensions,
} from "../dist/dev.mjs";

assert.equal(estimateImageTokensFromDimensions(512, 512), 85 + 170);
assert.equal(estimateImageTokensFromDimensions(1024, 1024), 85 + 4 * 170);
assert.ok(estimateImageInputTokens(40_000) < estimateImageInputTokens(600_000));

// Minimal 1x1 PNG
const png1x1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  )
);
assert.deepEqual(tryReadImageDimensions(png1x1), { width: 1, height: 1 });
assert.equal(estimateImageInputTokens(png1x1.length, tryReadImageDimensions(png1x1)), 85 + 170);

// --- a malformed stringified part must not throw ---------------------------------------------
//
// These come from `JSON.parse` of persisted content, and the loose check that admits them
// (`isContentPartLike`) requires only that `source` be an object — `source.value` is optional by
// contract. The estimator read `.value.length` unconditionally, so one hand-edited part threw a
// TypeError from inside the wire projection and failed the entire model call.
const malformedMedia = JSON.stringify([{ type: "image", source: { type: "data" } }]);
assert.doesNotThrow(
  () => estimateMessageTokens({ role: "tool", toolCallId: "c1", content: malformedMedia }),
  "a data source without `value` must be estimated, not crash"
);
assert.ok(
  estimateMessageTokens({ role: "tool", toolCallId: "c1", content: malformedMedia }) > 0,
  "and it still costs the coarse placeholder"
);

// --- a text part spelled `text:` is not free ------------------------------------------------
//
// `isContentPartLike` accepts `content` OR `text`; the estimator read only `content`, so a large text
// part using the other spelling contributed 0 and the kept window was under-estimated.
const hugeText = "x".repeat(100_000);
const viaText = estimateMessageTokens({
  role: "tool",
  toolCallId: "c2",
  content: JSON.stringify([
    { type: "text", text: hugeText },
    { type: "image", source: { type: "data", value: "A".repeat(4_000) } },
  ]),
});
assert.ok(viaText > 20_000, `a text part spelled \`text\` must be counted (got ${viaText})`);

// A tool result that still carries media as JSON text is estimated as MEDIA, not as base64 prose.
//
// Compaction projects BEFORE `tool-compact`, so this is the shape it reads. Counting the base64 at
// chars/4 turned one 300 KB screenshot into ~100k tokens: the keep budget was consumed by that single
// message, everything older was summarized, and `stillTokens` ballooned the summary into dozens of
// paid calls.
{
  const base64 = "A".repeat(400_000);
  const stringified = JSON.stringify([
    { type: "image", source: { type: "data", mimeType: "image/png", value: base64 } },
  ]);
  const imageTokens = estimateMessageTokens({ role: "tool", toolCallId: "tc-image", content: stringified });
  assert.ok(imageTokens < 10_000, `a 300 KB image must not read as text (got ${imageTokens})`);
  assert.ok(
    imageTokens < Math.ceil(stringified.length / 20),
    "…and must be dramatically smaller than the base64 text it is stored as"
  );

  // Prose is unaffected: the parser rejects it on a `"[{"` prefix test before any JSON.parse.
  const prose = estimateMessageTokens({ role: "tool", toolCallId: "tc-prose", content: "hello world ".repeat(400) });
  // 4 800 chars ≈ 1 200 tokens, plus the per-message overhead — i.e. still counted as text.
  assert.ok(prose > 1_150 && prose < 1_300, `prose still estimates as text (got ${prose})`);
}

console.log("estimate-image-tokens validation passed");

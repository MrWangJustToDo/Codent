/**
 * `ask_user` is a CLIENT tool: every host assembles its result. The merge rules are the tool's
 * contract, so they live in core (`buildAskUserOutput`) instead of in each host — the hosts had
 * drifted (the ACP host hard-coded `durationMs: 0`; one host dropped typed text on multi-select).
 *
 * Run: pnpm --filter @codent/core run validate:ask-user-output
 */

import assert from "node:assert/strict";

import { askUserOutputSchema, buildAskUserOutput } from "../dist/index.mjs";

function valid(output) {
  const parsed = askUserOutputSchema.safeParse(output);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  return parsed.data;
}

// --- free-form answer --------------------------------------------------------------------------
const freeText = valid(buildAskUserOutput({ question: "Name it", answer: "parser" }));
assert.equal(freeText.answer, "parser");
assert.equal(freeText.hasOptions, false);
assert.equal(freeText.multiSelect, undefined);
assert.equal(freeText.draft, undefined, "a plain answer is not a `draft`");
assert.equal(freeText.durationMs, 0);
assert.equal(freeText.cachedOutputPath, null);

// --- single choice -----------------------------------------------------------------------------
const single = valid(buildAskUserOutput({ question: "Which?", hasOptions: true, answer: "High" }));
assert.equal(single.answer, "High");
assert.equal(single.hasOptions, true);
assert.equal(single.multiSelect, undefined);
assert.equal(single.selected, undefined);

// --- multi-select plus the free-text field: BOTH are answers ------------------------------------
const multi = valid(buildAskUserOutput({ question: "Pick", hasOptions: true, selected: ["A", "B"], draft: "  C  " }));
assert.equal(multi.answer, "A, B, C", "the typed text is one more answer, not a replacement");
assert.deepEqual(multi.selected, ["A", "B"]);
assert.equal(multi.draft, "C", "draft is trimmed");
assert.equal(multi.multiSelect, true);

// --- single choice overridden by typed text ----------------------------------------------------
const override = valid(buildAskUserOutput({ question: "Which?", hasOptions: true, answer: "A", draft: "custom" }));
assert.equal(override.answer, "custom", "typing overrides the radio choice");
assert.equal(override.draft, "custom");

// --- cancelled / declined ----------------------------------------------------------------------
const cancelled = valid(buildAskUserOutput({ question: "Which?", hasOptions: true, cancelled: true, durationMs: 42 }));
assert.equal(cancelled.answer, "");
assert.equal(cancelled.cancelled, true);
assert.equal(cancelled.durationMs, 42, "the host-reported duration survives");

// --- duration / cache passthrough -------------------------------------------------------------
const measured = valid(
  buildAskUserOutput({ question: "Which?", answer: "x", durationMs: 7, cachedOutputPath: "/tmp/a.txt" })
);
assert.equal(measured.durationMs, 7);
assert.equal(measured.cachedOutputPath, "/tmp/a.txt");

console.log("ask_user output validation passed");

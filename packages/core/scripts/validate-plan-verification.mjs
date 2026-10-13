/**
 * Validates plan verification parse + complete_plan gate helpers.
 *
 * Run: pnpm --filter @codent/core run validate:plan-verification
 */

import assert from "node:assert/strict";

import {
  gateCompletePlanVerification,
  isUsableVerification,
  parseVerificationItemsFromPlanMarkdown,
  parseVerificationItemsFromText,
} from "../dist/dev.mjs";

const items = parseVerificationItemsFromText(`- resume shows images
- pnpm --filter @codent/core run validate:media-store
1. session JSON has no inline base64`);
assert.deepEqual(items, [
  "resume shows images",
  "pnpm --filter @codent/core run validate:media-store",
  "session JSON has no inline base64",
]);

assert.equal(isUsableVerification(""), false);
assert.equal(isUsableVerification("   "), false);
assert.equal(isUsableVerification("- ok check"), true);
assert.equal(isUsableVerification("pnpm lint"), true);

const md = `## Plan

**Goal:** demo

**Steps:**
1. Do thing

**Verification:**
- resume shows images
- run validate:media-store

**Risks / trade-offs:**
none
`;

assert.deepEqual(parseVerificationItemsFromPlanMarkdown(md), ["resume shows images", "run validate:media-store"]);

assert.equal(gateCompletePlanVerification(md, undefined).ok, false);
assert.equal(gateCompletePlanVerification(md, []).ok, false);

const failGate = gateCompletePlanVerification(md, [
  { item: "resume shows images", passed: false, evidence: "broke" },
  { item: "run validate:media-store", passed: true, evidence: "ok" },
]);
assert.equal(failGate.ok, false);

const missGate = gateCompletePlanVerification(md, [{ item: "resume shows images", passed: true, evidence: "ui ok" }]);
assert.equal(missGate.ok, false);

const okGate = gateCompletePlanVerification(md, [
  { item: "resume shows images", passed: true, evidence: "ui ok after /resume" },
  { item: "run validate:media-store", passed: true, evidence: "validate:media-store passed" },
]);
assert.equal(okGate.ok, true);

// ---------------------------------------------------------------------------
// Blank / too-short items cannot satisfy the checklist
// ---------------------------------------------------------------------------
//
// `normalizeVerificationItem(" ")` is `""` and `String.prototype.includes("")` is always
// true, so a single `{ item: " " }` used to satisfy the whole checklist — the only
// enforced gate in the plan lifecycle.

const blankItem = gateCompletePlanVerification(md, [{ item: " ", passed: true, evidence: "x" }]);
assert.equal(blankItem.ok, false, 'a blank item (" ") must not satisfy a real checklist');
assert.match(blankItem.error, /item/i, "the blank-item error names the offending field");

const shortItem = gateCompletePlanVerification(md, [{ item: "a", passed: true, evidence: "x" }]);
assert.equal(shortItem.ok, false, "a one-character item must not satisfy a real checklist");

// A too-short EXPECTED line is never matched: a plan whose only Verification line is
// unusable yields no checklist (and the caller falls back to the legacy N/A path).
assert.deepEqual(
  parseVerificationItemsFromPlanMarkdown("## Plan\n\n**Verification:**\n- a\n"),
  [],
  "a sub-3-character checklist line is not an expected item"
);
assert.deepEqual(parseVerificationItemsFromText("-  \n- b\n"), [], "blank/short lines parse to nothing");

// A genuine result still passes.
const genuine = gateCompletePlanVerification(md, [
  { item: "resume shows images", passed: true, evidence: "ui ok" },
  { item: "run validate:media-store", passed: true, evidence: "passed" },
]);
assert.equal(genuine.ok, true, "genuine results still pass");

// Slight wording drift is still tolerated (bounded token overlap, not substring).
const drift = gateCompletePlanVerification(md, [
  { item: "resume shows images correctly", passed: true, evidence: "ui ok" },
  { item: "run validate:media-store", passed: true, evidence: "passed" },
]);
assert.equal(drift.ok, true, "a reworded result that overlaps the checklist item still matches");

// A single overlapping token is not enough to satisfy a multi-token checklist item.
const weak = gateCompletePlanVerification(md, [
  { item: "images", passed: true, evidence: "x" },
  { item: "run validate:media-store", passed: true, evidence: "passed" },
]);
assert.equal(weak.ok, false, "one shared token must not satisfy a multi-token checklist item");

const legacy = gateCompletePlanVerification("## Plan\n\n**Goal:** old\n", [
  { item: "N/A — smoke validate", passed: true, evidence: "pnpm build:core" },
]);
assert.equal(legacy.ok, true);

const legacyBad = gateCompletePlanVerification("## Plan\n\n**Goal:** old\n", [
  { item: "a", passed: true, evidence: "x" },
  { item: "b", passed: true, evidence: "y" },
]);
assert.equal(legacyBad.ok, false);

console.log("plan-verification validation passed");

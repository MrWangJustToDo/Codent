/**
 * Validates auto-compaction no-op guards under the token-budget keep policy:
 *
 * - Budget-not-exceeded: when the whole conversation fits within the keep
 *   budget, there is nothing to summarize — must bail WITHOUT calling the
 *   summarizer (compacted:false, no summary).
 * - toSummarize-only-previous-SUMMARY: a summary-first wire whose toCompress is
 *   only a previous SUMMARY checkpoint must no-op (stacked compact).
 * - Split-turn (oversized turn) under a token budget must NOT no-op — it cuts
 *   inside the turn and reaches the summarizer, so a few-but-large-turn
 *   conversation can never get stuck.
 *
 * Run: pnpm --filter @codent/core run validate:auto-compact-noop
 */
import assert from "node:assert/strict";

import {
  autoCompact,
  createCompactionSummaryUIMessage,
  formatCompactionSummaryContent,
  formatContextSectionUserContent,
  isLatestDurableMessageCompactionSummary,
} from "../dist/dev.mjs";

/** Manager whose methods throw — proves a no-op never touches it. */
const throwingManager = {
  getAgent: () => {
    throw new Error("manager.getAgent must not be called for a no-op compact");
  },
};

function summaryMessage(summary) {
  return { role: "user", content: formatCompactionSummaryContent(summary) };
}
function userMessage(text) {
  return { role: "user", content: text };
}
function assistantMessage(text) {
  return { role: "assistant", content: text };
}

// ============================================================================
// Scenario A: the whole conversation fits within the keep budget → cutIndex 0
// → the guard short-circuits as compacted:false without touching the manager.
// ============================================================================
const scenarioA = [
  summaryMessage("Prior conversation summarized here."),
  userMessage("First instruction."),
  assistantMessage("First reply."),
  userMessage("Second instruction."),
  assistantMessage("Second reply."),
];

const resultA = await autoCompact(scenarioA, { keepRecentTokens: 1_000_000 }, "agent-a", throwingManager);
assert.equal(resultA.compacted, false, "A: whole input fits budget → no cut must not compact");
assert.equal(resultA.summary, undefined, "A: no summary should be produced");
assert.equal(resultA.cutIndex, undefined, "A: no cutIndex for a no-op");
assert.equal(resultA.tokensAfter, resultA.tokensBefore, "A: tokens must be unchanged");
console.log("scenario A (under budget) -> no-op OK");

// ============================================================================
// Scenario B: empty input → no-op.
// ============================================================================
const resultB = await autoCompact([], { keepRecentTokens: 8_000 }, "agent-b", throwingManager);
assert.equal(resultB.compacted, false, "B: empty input must not compact");
console.log("scenario B (empty input) -> no-op OK");

// ============================================================================
// Scenario F: summary-first wire whose toCompress is only a previous SUMMARY
// (stacked compact). Must no-op without calling the summarizer.
// ============================================================================
const scenarioF = [
  summaryMessage("checkpoint 5"),
  summaryMessage("checkpoint 5 almost identical"),
  userMessage("都提交并推送"),
  assistantMessage("ok"),
  userMessage("继续"),
  assistantMessage("working"),
];

const resultF = await autoCompact(scenarioF, { keepRecentTokens: 24_000 }, "agent-f", throwingManager);
assert.equal(resultF.compacted, false, "F: summary-only toSummarize must not compact");
assert.equal(resultF.summary, undefined, "F: no summary should be produced");
console.log("scenario F (toCompress is previous SUMMARY) -> no-op OK");

// ============================================================================
// Scenario G (core fix): a few-but-large-turn conversation. The token budget
// cuts INSIDE the turn (split-turn), so the empty-toSummarize guard must NOT
// trip — compaction proceeds to the summarizer (which fails on the throwing
// manager, proving it was reached) instead of silently no-oping forever.
// ============================================================================
const scenarioG = [
  summaryMessage("Prior summary."),
  userMessage("Only turn — but a huge one."),
  ...Array.from({ length: 4 }, (_, i) => assistantMessage(`step ${i}: ${"s".repeat(20_000)}`)),
];

const resultG = await autoCompact(scenarioG, { keepRecentTokens: 8_000 }, "agent-g", throwingManager);
assert.equal(resultG.error !== undefined, true, "G: must reach the summarizer, not short-circuit as a no-op");
assert.equal(resultG.compacted, false, "G: summarizer failure still reports compacted:false");
assert.match(resultG.error ?? "", /Compaction failed/, "G: error comes from the attempted summary call");
console.log("scenario G (split-turn via token budget reaches summarizer, never stuck) OK");

// ============================================================================
// Scenario E: channel tail already a SUMMARY (with optional trailing synthetic
// <ctx kind=...>). Trigger must be skipped — the stacked-compact failure mode.
// ============================================================================
const uiUser = (text) => ({ id: "u", role: "user", parts: [{ type: "text", content: text }] });
const uiTurnContext = () => ({
  id: "tc",
  role: "user",
  parts: [
    {
      type: "text",
      content: formatContextSectionUserContent({
        key: "current_date",
        content: "<current_date>\nnow\n</current_date>",
      }),
    },
  ],
});
assert.equal(
  isLatestDurableMessageCompactionSummary([uiUser("继续"), createCompactionSummaryUIMessage("checkpoint 5")]),
  true,
  "E: last durable message is SUMMARY"
);
assert.equal(
  isLatestDurableMessageCompactionSummary([createCompactionSummaryUIMessage("checkpoint 5"), uiTurnContext()]),
  true,
  "E: trailing synthetic ctx message is ignored"
);
assert.equal(
  isLatestDurableMessageCompactionSummary([
    createCompactionSummaryUIMessage("checkpoint 5"),
    uiUser("继续"),
    uiTurnContext(),
  ]),
  false,
  "E: a new user turn after SUMMARY must allow compact"
);
console.log("scenario E (latest durable is SUMMARY) -> skip-trigger OK");

// ============================================================================
// Scenario H (regression): a user cancel is reported as `aborted`, not as a
// failure and not as a silent no-op. The middleware treats those differently:
// `skipped`/`failed` arm the 8k-token retry backoff, a cancel must not.
// ============================================================================
const benignManager = { getAgent: () => null };
const resultH = await autoCompact(scenarioG, { keepRecentTokens: 8_000 }, "agent-h", benignManager, {
  abortSignal: AbortSignal.abort(),
});
assert.equal(resultH.compacted, false, "H: an aborted summarizer must not compact");
assert.equal(resultH.aborted, true, "H: a cancel is distinguishable from failure and from no-op");
assert.equal(resultH.error, undefined, "H: a cancel carries no failure text");
console.log("scenario H (aborted summarizer reports aborted) OK");

console.log("\nvalidate:auto-compact-noop passed");

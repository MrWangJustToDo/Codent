/**
 * Validates that a FAILED subagent reports a structured terminal verdict instead of throwing.
 *
 * The gap: a subagent whose run died (context overflow, provider fault) rethrew out of
 * `executeSubagentRun`, which skipped the shared finalization — so the parent's `task` call came
 * back as a bare tool error with no `incomplete` flag and no summary of what the run had found.
 * The SAME subagent hitting its iteration budget came back structured (`incomplete` +
 * `reachedLimit` + a progress report). Two ways of not finishing, handled inconsistently.
 *
 * Run: pnpm --filter @codent/core run validate:subagent-failure-outcome
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  applySubagentFailureNotice,
  applySubagentStopNotice,
  deriveSubagentRunStats,
  SUBAGENT_FAILURE_NOTICE_PREFIX,
  SUBAGENT_STOP_NOTICES,
} from "../dist/dev.mjs";

// ============================================================================
// The mechanism the fix leans on: an errored run derives `incomplete`
// ============================================================================
//
// `executeSubagentRun` now applies `kind: "error"` and THEN derives the stats, so this branch is
// what turns "the run died" into the flag the parent judges the summary by. Remove it and a failed
// task reports as complete.

const errored = deriveSubagentRunStats({
  messages: [],
  maxIterations: 50,
  finishReason: null,
  output: "partial narration",
  aborted: false,
  status: "error",
});
assert.equal(errored.incomplete, true, "an errored run reports incomplete");
assert.equal(errored.reachedLimit, false, "…without claiming the step budget was the cause");

// The discriminator: identical output on a run that FINISHED is not incomplete — the status
// decides, not the text.
const finished = deriveSubagentRunStats({
  messages: [],
  maxIterations: 50,
  finishReason: "stop",
  output: "partial narration",
  aborted: false,
  status: "completed",
});
assert.equal(finished.incomplete, false, "the status is what decides, not the output text");

// ============================================================================
// The failure notice: partial narration must not read as a conclusion
// ============================================================================

assert.equal(
  applySubagentFailureNotice("(no summary)", "context length exceeded"),
  `${SUBAGENT_FAILURE_NOTICE_PREFIX} context length exceeded`
);
const withPartial = applySubagentFailureNotice("Let me check the config…", "fetch failed");
assert.ok(withPartial.startsWith(SUBAGENT_FAILURE_NOTICE_PREFIX), "the fault leads");
assert.ok(withPartial.includes("Let me check the config…"), "the partial work survives");

// A failure notice must never be one of the STOP notices: `isProgressSummaryEligible` treats an
// output that is only a stop notice as "nothing usable", so overlapping the two vocabularies would
// silently change whether the progress-summary fallback fires.
assert.ok(
  !SUBAGENT_STOP_NOTICES.some((notice) => applySubagentFailureNotice("(no summary)", "boom").includes(notice)),
  "the failure vocabulary stays disjoint from the stop vocabulary"
);
assert.notEqual(
  applySubagentFailureNotice("(no summary)", "boom"),
  applySubagentStopNotice("(no summary)", "user"),
  "a failure is not worded as a cancel"
);

// ============================================================================
// The control-flow property: the failure path reaches the shared finalization
// ============================================================================
//
// Source-level on purpose: `runSubagent` has no runtime harness (it needs a full manager + a model
// adapter), and the property at stake IS control flow — "the failure branch does not rethrow".
// The markers are the catch's own shape and the comment that immediately follows it; the
// `failed = true` assertion doubles as a check that the slice really is the catch body.

const SRC = readFileSync(fileURLToPath(new URL("../src/agent/subagent/run-subagent.ts", import.meta.url)), "utf8");
const catchStart = SRC.indexOf("} catch (err) {");
const catchEnd = SRC.indexOf("// Esc → managed.abort() sets status during consume");
assert.ok(catchStart > 0 && catchEnd > catchStart, "the abort/failure catch is where the guard expects it");
const catchBody = SRC.slice(catchStart, catchEnd);

assert.ok(catchBody.includes("failed = true"), "the non-abort branch marks the run failed");
assert.ok(!/\bthrow err\b/.test(catchBody), "the catch must not rethrow: that is what skipped the shared finalization");
assert.ok(catchBody.includes("channel?.getMessages()"), "and reads the work the attempt produced");

// Terminal honesty, in both reports of it: a failed run is not a completed one.
assert.ok(
  SRC.includes('aborted || failed ? "subagent:error" : "subagent:completed"'),
  "a failed run emits subagent:error, not subagent:completed"
);
assert.ok(SRC.includes("if (aborted || failed) {"), "the parent-log mirror does not record a failed run as completed");
assert.ok(
  SRC.includes("aborted ? { stopReason } : {}"),
  "the mirror names an abort reason only for an abort — a failure has none"
);

console.log("subagent-failure-outcome validation passed");

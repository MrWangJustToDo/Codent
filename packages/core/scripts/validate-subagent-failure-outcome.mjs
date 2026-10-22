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
import { join } from "node:path";
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

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const read = (rel) => readFileSync(join(SRC, rel), "utf8");

// The managed span owns the catch/abort classification; the task projection still keeps the produced
// work and applies the terminal verdict. Neither layer rethrows.
const span = read("agent/run/managed-span.ts");
assert.match(span, /catch \(err\)/, "the managed span owns the stream catch");
assert.match(span, /onError\?\.\(message, error\)/, "a non-abort failure is normalized to the host");
assert.match(span, /managed\.isAbortError\(err\)/, "abort classification is shared");

const resultSrc = read("agent/subagent/task-result.ts");
const runSrc = read("agent/subagent/run-subagent.ts");
assert.match(runSrc, /onError: \(message\) => \{\s*failed = true;/, "the task adapter marks the run failed");
assert.match(
  runSrc,
  /aborted = aborted \|\| result\.aborted(?:\s*\|\|\s*abortSignal\?\.aborted === true)?;[\s\S]{0,200}if \(aborted\) \{\s*failed = false;/,
  "an abort outranks a captured fault"
);
assert.ok(!/\bthrow err\b/.test(resultSrc), "the task result must not rethrow");
assert.match(resultSrc, /channel\.failRun\(errorMessage\)/, "panel cleanup is applied after precedence");
assert.match(resultSrc, /aborted \|\| failed \? "subagent:error" : "subagent:completed"/);
assert.match(
  resultSrc,
  /if \(aborted \|\| failed\) \{/,
  "the parent-log mirror does not record a failed run as completed"
);
assert.match(resultSrc, /aborted \? \{ stopReason \} : \{\}/, "the mirror names an abort reason only for an abort");

console.log("subagent-failure-outcome validation passed");

/**
 * Validates that a `task` run cut off by the step budget renders as a warning
 * rather than a clean finish.
 *
 * Run: node packages/app/test/task-limit-status.test.mjs
 */
import assert from "node:assert/strict";

import { getToolStatusGlyph, isBudgetCutoffTaskPhase, resolveSubagentRowDisplay } from "../dist/index.mjs";

// --- phase -> cutoff decision ---

// Only `limit` means the budget ended the run. `summary` is the subagent's own
// report, and `running` has not ended at all.
assert.equal(isBudgetCutoffTaskPhase("limit"), true);
assert.equal(isBudgetCutoffTaskPhase("summary"), false);
assert.equal(isBudgetCutoffTaskPhase("running"), false);
// `taskPhase` is optional: an absent value must degrade to the old behaviour
// (no cutoff styling) instead of assuming one.
assert.equal(isBudgetCutoffTaskPhase(undefined), false);

// --- glyph ---

// The regression this guards: a cut-off task's part still settles as
// `output-available`, so reading the tool state alone painted the clean-finish
// check on a truncated run.
assert.equal(getToolStatusGlyph("output-available"), "✓", "a settled part reads as success by default");
assert.equal(getToolStatusGlyph("output-available", true), "⚠", "a cutoff outranks the settled state");
assert.equal(getToolStatusGlyph("output-error"), "✗");
assert.equal(getToolStatusGlyph("output-error", true), "⚠", "cutoff styling is not limited to the success state");
assert.equal(getToolStatusGlyph("output-denied"), "✗");
assert.equal(getToolStatusGlyph("approval-requested"), "?", "lifecycle states carry their own glyph");
assert.equal(getToolStatusGlyph("input-streaming"), "", "streaming renders a spinner, not a glyph");

// ============================================================================
// panel rows: a phase may only describe the subagent it belongs to
// ============================================================================
//
// The phase is keyed by TASK CALL while a row is a SUBAGENT, and one call can own more than one:
// a pre-fork discarded at a run boundary (or by a stream restart) is respawned under the same call
// id, and both keep their catalog entry on purpose (Ctrl+T is how a discard is observable). Reading
// the phase unconditionally made the discarded generation render "limit reached" — the outcome of
// the generation that replaced it — while the detail view, which reads that subagent's own snapshot,
// still said "aborted".

{
  const cutoff = resolveSubagentRowDisplay("completed", "limit");
  assert.equal(cutoff.label, "limit reached", "a clean finish under a limit phase is a cutoff");
  assert.equal(cutoff.icon, "⚠");
  assert.equal(cutoff.stoppedByLimit, true);

  const aborted = resolveSubagentRowDisplay("aborted", "limit");
  assert.equal(aborted.label, "aborted", "an aborted subagent keeps its own verdict, not the call's phase");
  assert.equal(aborted.icon, "⊘");
  assert.equal(aborted.stoppedByLimit, false);

  const errored = resolveSubagentRowDisplay("error", "limit");
  assert.equal(errored.label, "error", "…and so does a failed one");
  assert.equal(errored.stoppedByLimit, false);

  const live = resolveSubagentRowDisplay("running", "limit");
  assert.equal(live.label, "running", "a still-running row is not a cutoff");
  assert.equal(live.stoppedByLimit, false);

  for (const phase of ["summary", "running", undefined]) {
    assert.equal(
      resolveSubagentRowDisplay("completed", phase).label,
      "completed",
      `only the limit phase restyles a finish (phase=${phase})`
    );
  }
}

console.log("task-limit-status validation passed");

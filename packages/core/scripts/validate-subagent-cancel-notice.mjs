/**
 * Validation for subagent stop notices appended into task summaries.
 *
 * Run: pnpm --filter @codent/core run validate:subagent-cancel-notice
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applySubagentStopNotice,
  resolveSubagentStopReason,
  subagentStopNotice,
  SUBAGENT_ABORTED_NOTICE,
  SUBAGENT_ABORT_REASONS,
  SUBAGENT_RUN_RESTART_REASONS,
  SUBAGENT_CANCELLED_NOTICE,
  SUBAGENT_PARENT_RUN_NOTICE,
  SUBAGENT_PARENT_STOP_NOTICE,
  SUBAGENT_STOP_NOTICES,
} from "../dist/dev.mjs";

// Source root — the producer-drift guard below reads call sites, which no value assertion can.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// --- the notice is only for a run that actually stopped ---
//
// `applySubagentStopNotice` is called by the caller ONLY when `aborted` is true. It has no
// "is this aborted" parameter by design — passing the flag in is what let a finished run
// reach the notice path and come back carrying `[Task cancelled.]`. A finished run's summary
// is its output, verbatim; that gate is asserted at the call site below.

// `unknown` is "aborted, nothing recorded why" — so it still lands a notice, and it is
// appended to whatever partial work exists rather than replacing it.
assert.equal(applySubagentStopNotice("(no summary)", "unknown"), SUBAGENT_ABORTED_NOTICE);
assert.ok(
  applySubagentStopNotice("half a finding", "unknown").startsWith("half a finding"),
  "a bare abort keeps the partial summary"
);

const withPartial = applySubagentStopNotice("Now let me explore…", "user");
assert.ok(withPartial.startsWith("Now let me explore…"), "partial work survives");
assert.ok(withPartial.includes(SUBAGENT_CANCELLED_NOTICE));
assert.equal(applySubagentStopNotice("(no summary)", "user"), SUBAGENT_CANCELLED_NOTICE);
assert.equal(applySubagentStopNotice("   ", "user"), SUBAGENT_CANCELLED_NOTICE);

const already = `${SUBAGENT_CANCELLED_NOTICE}`;
assert.equal(applySubagentStopNotice(already, "user"), already);

// --- the reason classifier, pinned to the strings the producers ACTUALLY emit ---
//
// The first version tested the literal `"agent-destroyed"`, which no producer emits — the
// destroy path passes `"Agent destroyed"` — so the most common real abort silently fell
// through. These assertions go through `SUBAGENT_ABORT_REASONS` so the classifier and the
// producers (`agent-manager.ts` destroy path, `managed-agent.ts` cascade) share one spelling.

assert.equal(resolveSubagentStopReason({ aborted: false, reason: "user-cancelled" }), "unknown", "no abort → no claim");
assert.equal(resolveSubagentStopReason({ aborted: true, reason: SUBAGENT_ABORT_REASONS.userCancelled }), "user", "Esc");
assert.equal(resolveSubagentStopReason({ aborted: true, reason: SUBAGENT_ABORT_REASONS.parentAborted }), "parent-stop");

// The real destroy label — the dominant abort in the logs (171 vs 29).
assert.equal(
  resolveSubagentStopReason({ aborted: true, reason: SUBAGENT_ABORT_REASONS.agentDestroyed }),
  "parent-stop",
  "the destroy path is classified as a parent stop, not a parent-run restart"
);
assert.equal(SUBAGENT_ABORT_REASONS.agentDestroyed, "Agent destroyed", "the label the producer passes");
// …and its spelling cannot drift back out of sync (case/separator tolerant).
for (const spelling of ["Agent destroyed", "agent-destroyed", "agent destroyed", "AGENT_DESTROYED"]) {
  assert.equal(resolveSubagentStopReason({ aborted: true, reason: spelling }), "parent-stop", spelling);
}

// The orphan case: `resetRunState` calls `abort()` with no reason — a bare abort is the run
// moving on, NOT a user cancel. This is the misattribution the reason exists to fix.
assert.equal(resolveSubagentStopReason({ aborted: true, reason: undefined }), "parent-run");
assert.equal(resolveSubagentStopReason({ aborted: true, reason: "(no reason)" }), "parent-run");
// An unrecognized caller label is not strong enough to claim the user did it either.
assert.equal(resolveSubagentStopReason({ aborted: true, reason: "some-other" }), "parent-run");

// --- every producer's abort reason must be classifiable ---
//
// This is the guard that was missing. The classifier and the producers agreed on nothing:
// the destroy path passed `"Agent destroyed"` while the classifier matched `"agent-destroyed"`,
// so the dominant abort in the logs fell through to `parent-run`. No value assertion could
// have caught it — the two spellings only meet at a call site, so the call sites are read and
// each literal is fed back through the classifier.
{
  const producerFiles = [
    "managers/agent-manager.ts",
    "managers/managed-agent.ts",
    "agent-session/local-session-dispatch.ts",
    "managers/controllers/agent-chat-controller.ts",
  ];
  const callSite = /(\.abort|interruptCurrentRun)\(\s*"([^"]+)"/g;
  let checked = 0;
  for (const file of producerFiles) {
    const src = readFileSync(join(SRC, file), "utf8");
    for (const [, , value] of src.matchAll(callSite)) {
      checked += 1;
      const classified = resolveSubagentStopReason({ aborted: true, reason: value });
      assert.ok(
        classified !== "parent-run" || SUBAGENT_RUN_RESTART_REASONS.includes(value),
        `${file} aborts with "${value}", which the classifier does not name — it falls through to parent-run, the same bucket as a bare restart abort. Either classify it (add to SUBAGENT_ABORT_REASONS / resolveSubagentStopReason) or state that parent-run is the intended verdict (add to SUBAGENT_RUN_RESTART_REASONS). Adding it to NEITHER is exactly how "Agent destroyed" was lost.`
      );
    }
  }
  assert.ok(checked >= 3, `expected to read several abort call sites, found ${checked}`);

  // Each restart reason is DOCUMENTED (it is a key of the table, so a reader can see what the
  // string means) and resolves to `parent-run` — the fallback is its stated verdict, not an
  // accident of matching. That two-part property is what `force-submit` had to be given.
  for (const reason of SUBAGENT_RUN_RESTART_REASONS) {
    assert.ok(
      Object.values(SUBAGENT_ABORT_REASONS).includes(reason),
      `${reason} falls through to parent-run, so it must at least be documented in SUBAGENT_ABORT_REASONS`
    );
    assert.equal(resolveSubagentStopReason({ aborted: true, reason }), "parent-run", `${reason} is a restart`);
  }

  // The destroy label is additionally pinned to the shared constant, because it is the one
  // whose spelling is not discoverable from the code (it is prose, in title case) and it is
  // the dominant abort in real logs.
  const lifecycleSrc = readFileSync(join(SRC, "managers/lifecycle-coordinator.ts"), "utf8");
  assert.ok(
    /managedAgent\.abort\(SUBAGENT_ABORT_REASONS\.agentDestroyed\)/.test(lifecycleSrc),
    "the destroy path aborts through the shared constant"
  );
  assert.equal(SUBAGENT_ABORT_REASONS.agentDestroyed, "Agent destroyed", "…whose value is the observed one");

  // The reason must LEAVE the run, or classifying it is bookkeeping nobody reads. Three hops
  // carry it — the classifier's result into `SubagentResult`, through the `task` schema, into
  // the tool output — and the first of those was silently missing (the field went onto the
  // payload but never into the returned result), leaving the other two dead.
  const resultSrc = readFileSync(join(SRC, "agent/subagent/task-result.ts"), "utf8");
  assert.ok(
    /\.\.\.\(aborted \? \{ stopReason \} : \{\}\)/.test(resultSrc),
    "an aborted SubagentResult carries its stop reason"
  );
  const toolSrc = readFileSync(join(SRC, "agent/subagent/task-tool.ts"), "utf8");
  assert.ok(/stopReason: z\s*\.enum/.test(toolSrc), "the task output schema accepts it");
  assert.ok(
    /result\.stopReason \? \{ stopReason: result\.stopReason \}/.test(toolSrc),
    "…and the tool passes it through"
  );
}

// --- notices are distinct and all recognized as "already noticed" ---

assert.equal(subagentStopNotice("user"), SUBAGENT_CANCELLED_NOTICE);
assert.equal(subagentStopNotice("parent-run"), SUBAGENT_PARENT_RUN_NOTICE);
assert.equal(subagentStopNotice("parent-stop"), SUBAGENT_PARENT_STOP_NOTICE);
assert.equal(subagentStopNotice("unknown"), SUBAGENT_ABORTED_NOTICE);
assert.equal(new Set(SUBAGENT_STOP_NOTICES).size, 4, "every reason has its own notice");

// --- the notice follows the reason, and still stacks onto partial output ---

assert.equal(applySubagentStopNotice("(no summary)", "parent-run"), SUBAGENT_PARENT_RUN_NOTICE);
assert.equal(applySubagentStopNotice("", "parent-stop"), SUBAGENT_PARENT_STOP_NOTICE);

const partialRun = applySubagentStopNotice("Found three of the eight gaps…", "parent-run");
assert.ok(partialRun.startsWith("Found three of the eight gaps…"), "partial work is preserved");
assert.ok(partialRun.includes(SUBAGENT_PARENT_RUN_NOTICE));
assert.ok(!partialRun.includes("cancelled by user"), "a discarded run does not claim the user did it");

// A second application must not stack a notice (any spelling counts as already noticed).
for (const notice of SUBAGENT_STOP_NOTICES) {
  assert.equal(applySubagentStopNotice(`text\n\n${notice}`, "parent-run"), `text\n\n${notice}`);
}

console.log("subagent-cancel-notice validation passed");

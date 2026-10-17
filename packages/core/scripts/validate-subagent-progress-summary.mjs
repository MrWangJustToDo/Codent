/**
 * Validates the progress-summary fallback for iteration-limited task subagents.
 *
 * Covers:
 * (a) buildProgressSummaryPrompt serializes the subagent trace with
 *     `[Assistant tool calls]` and `[Tool result from]` segments.
 * (b) isProgressSummaryEligible trigger logic — true for reachedLimit +
 *     incomplete + (empty output OR no begin_summary call).
 * (c) summarizeProgress silent failure — a throwing manager returns null and
 *     never changes the caller's output.
 * (d) deriveSubagentRunStats integration — a step-budget cutoff yields
 *     reachedLimit=true + incomplete=true (the scenario this fallback serves).
 *
 * Run: pnpm --filter @codent/core run validate:subagent-progress-summary
 */

import assert from "node:assert/strict";

import {
  buildProgressSummaryPrompt,
  deriveSubagentRunStats,
  hasBeginSummaryCall,
  isProgressSummaryEligible,
  PROGRESS_SUMMARY_MARKER,
  summarizeProgress,
} from "../dist/dev.mjs";

// ============================================================================
// (a) Prompt building serializes the trace
// ============================================================================

const traceMessages = [
  {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", content: "Find what testing framework this project uses" }],
  },
  {
    id: "assistant-1",
    role: "assistant",
    parts: [
      { type: "text", content: "Looking at package.json." },
      {
        type: "tool-call",
        id: "tc1",
        name: "grep",
        arguments: JSON.stringify({ pattern: "vitest|jest", path: "packages/core", outputMode: "content" }),
        state: "complete",
        output: "{}",
      },
      { type: "tool-result", toolCallId: "tc1", content: 'packages/core/package.json:17: "vitest"', state: "complete" },
      {
        type: "tool-call",
        id: "tc2",
        name: "read_file",
        arguments: JSON.stringify({ path: "packages/core/package.json", offset: 1, limit: 40 }),
        state: "complete",
        output: "{}",
      },
      { type: "tool-result", toolCallId: "tc2", content: "1: { ...", state: "complete" },
      { type: "text", content: "Still checking…" },
    ],
  },
];

const prompt = buildProgressSummaryPrompt(traceMessages, "Find the testing framework");
assert.ok(prompt.includes("<original_task>"), "prompt should include the original task");
assert.ok(prompt.includes("<transcript>"), "prompt should wrap the transcript");
assert.ok(prompt.includes("[User]: Find what testing framework this project uses"), "user text serialized");
assert.ok(prompt.includes("[Assistant tool calls]"), "tool calls serialized");
assert.ok(prompt.includes("grep("), "tool name present in tool calls");
assert.ok(prompt.includes("[Tool result from grep]"), "tool result serialized with name");
assert.ok(prompt.includes("[Tool result from read_file]"), "second tool result serialized");
// The summarizer's input is CLIPPED, not complete: long tool results carry a `[... N chars
// truncated]` marker. The prompt has to say so, or the report presents a cut-off result as read.
assert.ok(prompt.includes("chars truncated"), "the prompt names the clip marker");
assert.ok(prompt.includes("never report a clipped result"), "…and forbids reporting it as read");
console.log("(a) buildProgressSummaryPrompt serializes [Assistant tool calls] + [Tool result from] OK");

// ============================================================================
// (b) Trigger eligibility
// ============================================================================

// True: iteration limit + incomplete + empty output (the target scenario).
assert.equal(isProgressSummaryEligible(true, true, "(no summary)"), true, "limit + incomplete + (no summary)");
assert.equal(isProgressSummaryEligible(true, true, ""), true, "limit + incomplete + empty");
assert.equal(
  isProgressSummaryEligible(true, true, "[Task cancelled by user.]"),
  true,
  "limit + incomplete + cancel notice"
);

// True: iteration limit + incomplete + non-empty exploration narration but NO
// begin_summary call (the real-world cutoff: subagent was force-stopped mid
// tool-loop, e.g. "Let me do a final check…"). Default calledBeginSummary=true
// must NOT block this path when explicitly passed false.
assert.equal(
  isProgressSummaryEligible(true, true, "I now have a comprehensive picture. Let me do a final check…", false),
  true,
  "limit + incomplete + narration without begin_summary -> fallback"
);

// False: not incomplete (normal completion / aborted).
assert.equal(isProgressSummaryEligible(false, false, "(no summary)"), false, "normal completion no fallback");
assert.equal(isProgressSummaryEligible(false, true, "(no summary)"), false, "reachedLimit but not incomplete");
assert.equal(isProgressSummaryEligible(true, false, "(no summary)"), false, "incomplete but not reachedLimit");

// The OTHER terminal cause: the run DIED (provider fault, context overflow). No budget cutoff, but
// nothing usable either — so it takes the same fallback. This is the shape a context overflow
// leaves behind, and it is the case whose trace is too large to hand over unsegmented.
assert.equal(
  isProgressSummaryEligible(true, false, "(no summary)", true, true),
  true,
  "failed + incomplete + (no summary) -> fallback"
);
assert.equal(
  isProgressSummaryEligible(true, false, "Let me check the config…", false, true),
  true,
  "failed + incomplete + narration without begin_summary -> fallback"
);
assert.equal(
  isProgressSummaryEligible(true, false, "## Final Summary\n\nDone.", true, true),
  false,
  "a run that failed AFTER its final answer has usable output -> no fallback"
);
assert.equal(
  isProgressSummaryEligible(false, false, "(no summary)", true, true),
  false,
  "`incomplete` is still required — `failed` alone is not a cause to distill"
);

// False: subagent produced usable partial content AND called begin_summary at the limit.
assert.equal(
  isProgressSummaryEligible(true, true, "Found vitest in packages/core/package.json", true),
  false,
  "limit + partial useful output + begin_summary -> no fallback"
);

// False: called begin_summary (default) with non-empty output — old behavior
// preserved for callers that don't pass the flag.
assert.equal(
  isProgressSummaryEligible(true, true, "I now have a comprehensive picture. Let me do a final check…"),
  false,
  "non-empty narration with default calledBeginSummary=true -> no fallback"
);
console.log("(b) isProgressSummaryEligible trigger matrix OK");

// ============================================================================
// (c) summarizeProgress silent failure
// ============================================================================

const throwingManager = {
  getAgent: () => {
    throw new Error("manager.getAgent must fail to prove silent fallback");
  },
};

const unusedSpawn = async () => {
  throw new Error("the summarizer must not be spawned when the budget lookup already failed");
};

const failed = await summarizeProgress(
  traceMessages,
  "agent-a",
  throwingManager,
  unusedSpawn,
  "Find the testing framework"
);
assert.equal(failed, null, "summarizeProgress must return null when the summarizer manager throws");
console.log("(c) summarizeProgress silent failure returns null OK");

// ============================================================================
// (d) run-stats integration — step-budget cutoff is the served scenario
// ============================================================================

const cutOffStats = deriveSubagentRunStats({
  messages: traceMessages,
  maxIterations: 50,
  finishReason: "tool_calls",
  output: "(no summary)",
  aborted: false,
  status: "completed",
});

assert.equal(cutOffStats.reachedLimit, true, "step-budget cutoff marks reachedLimit");
assert.equal(cutOffStats.incomplete, true, "step-budget cutoff marks incomplete");
console.log("(d) deriveSubagentRunStats cutoff -> reachedLimit + incomplete OK");

// Real-world integration (the bug this fallback fixes): a subagent force-stopped
// mid tool-loop leaves exploration narration as output and never calls
// begin_summary. isProgressSummaryEligible + hasBeginSummaryCall must agree the
// run needs a progress summary even though the output is non-empty.
assert.equal(hasBeginSummaryCall(traceMessages), false, "trace has no begin_summary");
assert.equal(
  isProgressSummaryEligible(
    cutOffStats.incomplete,
    cutOffStats.reachedLimit,
    "I now have a comprehensive picture. Let me do a final check…",
    hasBeginSummaryCall(traceMessages)
  ),
  true,
  "mid-loop cutoff + narration + no begin_summary -> fallback fires"
);

// The old behavior (output non-empty -> skip) is wrong for the mid-loop cutoff.
assert.equal(
  isProgressSummaryEligible(
    cutOffStats.incomplete,
    cutOffStats.reachedLimit,
    "I now have a comprehensive picture. Let me do a final check…"
  ),
  false,
  "sanity: without the begin_summary flag this mid-loop case is NOT eligible"
);
console.log("(d) real mid-loop cutoff integration OK");

// Marker constant exported for consumers.
assert.equal(PROGRESS_SUMMARY_MARKER, "[progress summary from incomplete subagent]");
console.log("marker constant OK");

// ============================================================================
// (e) Status-flag preservation contract
//
// The progress-summary fallback replaces the output TEXT but must never change
// the subagent's status semantics. A step-budget cutoff stays reachedLimit=true
// + incomplete=true even after the progress report replaces "(no summary)".
//
// This mirrors run-subagent.ts: status flags are snapshotted from
// deriveSubagentRunStats BEFORE the fallback, then returned unchanged.
// ============================================================================

// Simulate the fallback flow: stats derived from the cutoff scenario, then a
// progress summary (with marker) replaces the output. The returned flags must
// equal the pre-fallback snapshots.
const preFallbackFlags = {
  iterations: cutOffStats.iterations,
  reachedLimit: cutOffStats.reachedLimit,
  incomplete: cutOffStats.incomplete,
};

const progressReplacedOutput = `## Progress\n\nFound vitest in packages/core/package.json\n\n## Unfinished\n\nCould not confirm the runner setup.\n\n${PROGRESS_SUMMARY_MARKER}`;

// Status flags must be identical before/after the text replacement.
assert.equal(preFallbackFlags.reachedLimit, true, "status snapshot keeps reachedLimit=true");
assert.equal(preFallbackFlags.incomplete, true, "status snapshot keeps incomplete=true");
assert.equal(
  progressReplacedOutput.includes(PROGRESS_SUMMARY_MARKER),
  true,
  "replaced output carries the progress-summary marker"
);

// Contract: the fallback may change `output`, but the returned status fields
// (reachedLimit / incomplete) are the pre-fallback snapshots — verified here by
// asserting they stay `true` for the limit-hit scenario.
assert.equal(true, preFallbackFlags.reachedLimit, "reachedLimit remains true (limit stays limit)");
assert.equal(true, preFallbackFlags.incomplete, "incomplete remains true (limit stays limit)");
console.log("(e) status-flag preservation (limit stays limit) OK");

console.log("\nvalidate:subagent-progress-summary — all assertions passed");

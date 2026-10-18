/**
 * Validates subagent iteration counting and run-stat derivation.
 *
 * Run: pnpm --filter @codent/core run validate:subagent-run-stats
 */

import assert from "node:assert/strict";

import {
  countSubagentIterations,
  createTaskTool,
  deriveSubagentRunStats,
  hasBeginSummaryCall,
  toModelOutputRegistry,
} from "../dist/dev.mjs";

const exploreDone = [
  {
    id: "assistant-1",
    role: "assistant",
    parts: [
      { type: "text", content: "Exploring." },
      { type: "tool-call", id: "tc1", name: "read_file", arguments: "{}", state: "complete", output: "{}" },
      { type: "tool-result", toolCallId: "tc1", content: "{}", state: "complete" },
      { type: "tool-call", id: "tc2", name: "grep", arguments: "{}", state: "complete", output: "{}" },
      { type: "tool-result", toolCallId: "tc2", content: "[]", state: "complete" },
      { type: "tool-call", id: "tc3", name: "begin_summary", arguments: "{}", state: "complete", output: "{}" },
      { type: "tool-result", toolCallId: "tc3", content: '{"ready":true}', state: "complete" },
      { type: "text", content: "## Final Summary\n\nDone." },
    ],
  },
];

assert.equal(countSubagentIterations(exploreDone), 3);
assert.equal(hasBeginSummaryCall(exploreDone), true);

const stats = deriveSubagentRunStats({
  messages: exploreDone,
  maxIterations: 50,
  finishReason: "stop",
  output: "## Final Summary\n\nDone.",
  aborted: false,
  status: "completed",
});

assert.equal(stats.iterations, 3);
assert.equal(stats.reachedLimit, false);
assert.equal(stats.incomplete, false);

// TanStack step-budget cutoff leaves finishReason tool_calls (no special max-steps reason).
const cutOffMessages = [
  {
    id: "assistant-1",
    role: "assistant",
    parts: [
      { type: "text", content: "Exploring." },
      { type: "tool-call", id: "tc1", name: "read_file", arguments: "{}", state: "complete", output: "{}" },
      { type: "tool-result", toolCallId: "tc1", content: "{}", state: "complete" },
    ],
  },
];

const limited = deriveSubagentRunStats({
  messages: cutOffMessages,
  maxIterations: 50,
  finishReason: "tool_calls",
  output: "Exploring.",
  aborted: false,
  status: "completed",
});

assert.equal(limited.reachedLimit, true);
assert.equal(limited.incomplete, true);

// Partial explore text without begin_summary must not look "complete".
const noBegin = [
  {
    id: "assistant-1",
    role: "assistant",
    parts: [
      { type: "text", content: "Found middleware." },
      { type: "tool-call", id: "tc1", name: "grep", arguments: "{}", state: "complete", output: "{}" },
      { type: "tool-result", toolCallId: "tc1", content: "[]", state: "complete" },
      { type: "text", content: "Still looking…" },
    ],
  },
];

const missingBegin = deriveSubagentRunStats({
  messages: noBegin,
  maxIterations: 50,
  finishReason: "stop",
  output: "Still looking…",
  aborted: false,
  status: "completed",
});

assert.equal(missingBegin.reachedLimit, false);
assert.equal(missingBegin.incomplete, true);

const singleIteration = deriveSubagentRunStats({
  messages: [{ id: "assistant-1", role: "assistant", parts: [{ type: "text", content: "Summary." }] }],
  maxIterations: 1,
  finishReason: "stop",
  output: "Summary.",
  aborted: false,
  status: "completed",
});

assert.equal(singleIteration.reachedLimit, false);
assert.equal(singleIteration.incomplete, false);

const emptyError = deriveSubagentRunStats({
  messages: exploreDone,
  maxIterations: 50,
  finishReason: "stop",
  output: "(no summary)",
  aborted: false,
  status: "error",
});

assert.equal(emptyError.incomplete, true);

const lengthCut = deriveSubagentRunStats({
  messages: [{ id: "assistant-1", role: "assistant", parts: [{ type: "text", content: "Partial…" }] }],
  maxIterations: 1,
  finishReason: "length",
  output: "Partial…",
  aborted: false,
  status: "completed",
});

assert.equal(lengthCut.reachedLimit, false);
assert.equal(lengthCut.incomplete, true);

// Step-budget cutoff that ends on a TEXT narration step (finishReason "stop"):
// at/over maxIterations without begin_summary must still count as reachedLimit
// so the progress-summary fallback triggers (regression: deepseek-harness task
// ran 50 rounds, ended on "Let me read descriptor.ts briefly.", and the
// fallback was skipped because reachedLimit stayed false).
{
  const narration = [];
  for (let i = 1; i <= 50; i++) {
    narration.push({
      id: `assistant-${i}`,
      role: "assistant",
      parts: [
        { type: "text", content: `Step ${i} note.` },
        { type: "tool-call", id: `tc${i}`, name: "grep", arguments: "{}", state: "complete", output: "{}" },
        { type: "tool-result", toolCallId: `tc${i}`, content: "[]" },
      ],
    });
  }
  // Final cut step: text-only narration, no tool calls, finishReason "stop".
  narration.push({
    id: "assistant-final",
    role: "assistant",
    parts: [{ type: "text", content: "Let me read descriptor.ts briefly." }],
  });

  const stats = deriveSubagentRunStats({
    messages: narration,
    maxIterations: 50,
    finishReason: "stop",
    output: "Let me read descriptor.ts briefly.",
    aborted: false,
  });
  assert.equal(stats.iterations, 50);
  assert.equal(stats.reachedLimit, true, "budget exhausted + no begin_summary = limit reached");
  assert.equal(stats.incomplete, true);
}

// Control: same shape but begin_summary WAS called and budget not reached — natural end.
{
  const done = [
    {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "text", content: "Working." },
        { type: "tool-call", id: "tc1", name: "begin_summary", arguments: "{}", state: "complete", output: "{}" },
        { type: "tool-result", toolCallId: "tc1", content: '{"ready":true}' },
        { type: "text", content: "## Summary\nDone." },
      ],
    },
  ];
  const stats = deriveSubagentRunStats({
    messages: done,
    maxIterations: 50,
    finishReason: "stop",
    output: "## Summary\nDone.",
    aborted: false,
  });
  assert.equal(stats.reachedLimit, false);
  assert.equal(stats.incomplete, false);
}

// Parallel tool calls in one model turn = 1 iteration round.
const parallel = [
  {
    id: "assistant-1",
    role: "assistant",
    parts: [
      { type: "tool-call", id: "a", name: "read_file", arguments: "{}", state: "complete", output: "{}" },
      { type: "tool-call", id: "b", name: "grep", arguments: "{}", state: "complete", output: "{}" },
      { type: "tool-result", toolCallId: "a", content: "{}", state: "complete" },
      { type: "tool-result", toolCallId: "b", content: "[]", state: "complete" },
    ],
  },
];
assert.equal(countSubagentIterations(parallel), 1);

// ============================================================================
// The engine's count wins over the message-derived one
//
// `iterations` feeds the step-budget comparison behind `reachedLimit`, and TanStack's
// budget is expressed in model turns (`maxIterations(max) => ({iterationCount}) =>
// iterationCount < max`). The message-derived count is a different quantity: it only
// counts tool-call batches, so it cannot see a model turn that starts none.
//
// The fixture below is that shape — two tool rounds plus a closing text turn. The engine
// spent 3 model turns; the message-derived count sees 2. Passing the observed value must
// override it, or a cutoff on such a turn is missed.
// ============================================================================

const closingTurn = [
  {
    id: "assistant-1",
    role: "assistant",
    parts: [
      { type: "tool-call", id: "a", name: "read_file", arguments: "{}", state: "complete", output: "{}" },
      { type: "tool-result", toolCallId: "a", content: "{}", state: "complete" },
    ],
  },
  {
    id: "assistant-2",
    role: "assistant",
    parts: [
      { type: "tool-call", id: "b", name: "grep", arguments: "{}", state: "complete", output: "{}" },
      { type: "tool-result", toolCallId: "b", content: "[]", state: "complete" },
    ],
  },
  // The closing answer: a real model turn that spends budget, and starts no tool batch.
  { id: "assistant-3", role: "assistant", parts: [{ type: "text", content: "Done." }] },
];

assert.equal(
  countSubagentIterations(closingTurn),
  2,
  "the message-derived count cannot see the closing text turn (2 of the engine's 3)"
);

// Without the observed value, the derived count is used (the fallback path).
const derivedOnly = deriveSubagentRunStats({
  messages: closingTurn,
  maxIterations: 50,
  finishReason: "stop",
  output: "Done.",
  aborted: false,
});
assert.equal(derivedOnly.iterations, 2, "no observed state — falls back to the derived count");

// With it, the engine's count wins — 2 vs 3 is the whole point of the parameter.
const observed = deriveSubagentRunStats({
  messages: closingTurn,
  maxIterations: 50,
  finishReason: "stop",
  output: "Done.",
  aborted: false,
  observedIterations: { current: 3, max: 50 },
});
assert.equal(observed.iterations, 3, "the engine's own count overrides the message-derived one");

// And it changes the budget decision, which is why the override matters at all: at a
// budget of 3 the engine is spent (3 >= 3), while the derived count reports 2 and would
// have missed the cutoff.
const cutoffMissed = deriveSubagentRunStats({
  messages: closingTurn,
  maxIterations: 3,
  finishReason: "stop",
  output: "",
  aborted: false,
  observedIterations: { current: 3, max: 3 },
});
assert.equal(cutoffMissed.reachedLimit, true, "a real cutoff at the budget must be reported");
const derivedWouldMiss = deriveSubagentRunStats({
  messages: closingTurn,
  maxIterations: 3,
  finishReason: "stop",
  output: "",
  aborted: false,
});
assert.equal(derivedWouldMiss.reachedLimit, false, "…and the derived count misses it — the guard is non-vacuous");

// Zero observed state (a caller that never saw an iteration) must not override the
// fallback with a meaningless 0.
const zeroObserved = deriveSubagentRunStats({
  messages: closingTurn,
  maxIterations: 50,
  finishReason: "stop",
  output: "Done.",
  aborted: false,
  observedIterations: { current: 0, max: 0 },
});
assert.equal(zeroObserved.iterations, 2, "an idle iteration state falls back to the derived count");

// ============================================================================
// The budget travels with the count, and neither one reaches the model
//
// A restored task row shows `used/budget`, and a child session does not exist after a
// restore — so the budget has to be persisted next to the count, and it must be the budget
// the count was compared against (the caller's), not whatever the observed state carried.
//
// The model-facing projection deliberately drops both: `reachedLimit` already IS the budget
// verdict and needs no ceiling, a bare count says nothing without one, and the tool
// description never explained the field. This pins the removal so it cannot drift back.
// ============================================================================

const budgetStats = deriveSubagentRunStats({
  messages: closingTurn,
  maxIterations: 40,
  finishReason: "stop",
  output: "Done.",
  aborted: false,
  observedIterations: { current: 3, max: 50 },
});
assert.equal(budgetStats.iterations, 3);
assert.equal(
  budgetStats.maxIterations,
  40,
  "the budget reported must be the one the count was compared against, not the observed state's own"
);

const noBudget = deriveSubagentRunStats({
  messages: closingTurn,
  maxIterations: 0,
  finishReason: "stop",
  output: "Done.",
  aborted: false,
});
assert.equal(noBudget.maxIterations, 0, "an unknown budget stays 0 so the readout drops the `/0`");

{
  // `defineServerTool` does not carry `toModelOutput` on the tool object — it registers it in
  // `toModelOutputRegistry`, which is how the production path reads it (`applyToolCompact`). So
  // the projection is asserted through the registry, not through a method on the tool. The tool
  // needs no live manager for this: `toModelOutput` is a pure projection of the output.
  const taskTool = createTaskTool({ parentAgentId: "parent", manager: {} });
  const project = toModelOutputRegistry.get("task");
  assert.ok(project, "the task tool must register a model-output projection");

  // The description is the other model-facing surface: a field the model is never handed must
  // not be listed there either, or it would look like something it can rely on.
  assert.ok(
    !/\bmaxIterations\b/.test(taskTool.description),
    "the description must not advertise `maxIterations` either"
  );
  assert.ok(
    /status flags \(reachedLimit, incomplete, aborted; stopReason when aborted\)/.test(taskTool.description),
    "and it must still name the status flags the model does receive"
  );
  assert.ok(
    !/truncated=false preferred/.test(taskTool.description),
    "the description must not present the always-false `truncated` flag as a trust signal"
  );
  assert.ok(
    /Full output saved to:/.test(taskTool.description),
    "a cached summary is a preview — the description must say to read the saved file"
  );
  assert.ok(
    /Keep each task narrow/.test(taskTool.description) && /step\s+budget/.test(taskTool.description),
    "the description must warn that a broad task can exhaust the subagent's step budget"
  );

  const projected = project({
    toolCallId: "t1",
    input: {},
    output: {
      subagentId: "s1",
      summary: "findings",
      truncated: false,
      iterations: 7,
      maxIterations: 50,
      durationMs: 12,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, billedInputTokens: 3 },
      reachedLimit: false,
      incomplete: false,
      aborted: false,
      success: true,
    },
  });
  const text = JSON.stringify(projected);
  assert.ok(
    !text.includes("iterations=") && !text.includes("maxIterations"),
    "the model must not receive either iteration number — reachedLimit is the budget verdict"
  );
  assert.ok(text.includes("reachedLimit=false"), "but the verdict itself must still reach the model");
  assert.ok(text.includes("incomplete=false"), "along with the other completion flags");
  assert.ok(
    !text.includes("truncated="),
    "`truncated` must not reach the model: the task tool never truncates by length, so the flag is dead"
  );

  // An aborted run names WHO stopped it — the schema documents the three reasons as the whole
  // point of `stopReason`, so the projection must carry it when present.
  const abortedText = JSON.stringify(
    project({
      toolCallId: "t2",
      input: {},
      output: {
        subagentId: "s2",
        summary: "partial work\n\n[Task cancelled by user.]",
        truncated: false,
        iterations: 4,
        maxIterations: 50,
        durationMs: 12,
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        reachedLimit: false,
        incomplete: false,
        aborted: true,
        stopReason: "user",
        success: true,
      },
    })
  );
  assert.ok(abortedText.includes("aborted=true"), "an aborted run is flagged");
  assert.ok(abortedText.includes("stopReason=user"), "…and says who stopped it");
}

console.log("subagent-run-stats validation passed");

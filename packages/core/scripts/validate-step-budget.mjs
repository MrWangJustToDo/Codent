/**
 * Validates the subagent step-budget notice.
 *
 * A `task` child runs under a fixed iteration budget and is stopped mid-exploration when it runs
 * out. The notice is a gentle reminder that the budget is running low (not an instruction to stop):
 * it fires once, only for subagents, and its block must be persisted so a retry does not stack a
 * second copy.
 *
 * Run: pnpm --filter @codent/core run validate:step-budget
 */

import assert from "node:assert/strict";

import {
  STEP_BUDGET_MIN_NOTICE,
  TURN_CONTEXT_KINDS,
  buildStepBudgetNotice,
  createStepBudgetMiddleware,
  stepBudgetThreshold,
  syntheticKindFromId,
} from "../dist/dev.mjs";

// ---------------------------------------------------------------------------
// 1. Threshold + wording
// ---------------------------------------------------------------------------
assert.equal(stepBudgetThreshold(50), 40, "80% of a 50-step budget is step 40");
assert.equal(stepBudgetThreshold(10), 8);
assert.equal(stepBudgetThreshold(1), 1, "a tiny budget still has a due step");

{
  const notice = buildStepBudgetNotice(40, 50);
  assert.match(notice, /40 of 50 steps/);
  assert.match(notice, /80%/);
  assert.match(notice, /about 10 remain/);
  assert.match(notice, /begin_summary/, "the reminder names the way to report what it has");
  assert.match(notice, /progress note/, "and why a summary before the cap carries more");
  // A reminder, not an order: the child may decide the remaining work matters more.
  assert.match(notice, /only a reminder/);
  assert.match(notice, /may be a good time to wrap up/);
  assert.ok(!/Start converging now/i.test(notice), "no imperative 'do this now' framing");
  assert.ok(!/^- Stop/m.test(notice), "no command list");
}

// ---------------------------------------------------------------------------
// 2. Middleware: once, at the threshold, subagents only
// ---------------------------------------------------------------------------

/** Fake channel + deps; the engine's 0-based iteration is passed per call. */
function harness(options) {
  let messages = options.initialMessages ?? [];
  const persisted = [];
  const channel = {
    getMessages: () => messages,
    setMessages: (next) => {
      messages = next;
    },
  };
  const middleware = createStepBudgetMiddleware({
    isSubagent: () => options.isSubagent ?? true,
    getMaxIterations: () => options.max,
    getUIChannel: () => channel,
    persistMessages: (next) => persisted.push(next),
    ...(options.getIteration ? { getIteration: options.getIteration } : {}),
  });
  return {
    run: (iteration) => middleware.onConfig({ iteration }, { messages: [] }),
    messages: () => messages,
    persisted: () => persisted,
  };
}

{
  const h = harness({ max: 50 });
  assert.equal(await h.run(38), undefined, "39/50 is below the threshold");
  assert.equal(h.messages().length, 0);

  // 0-based iteration 39 = the 40th step = 80% of 50.
  const injected = await h.run(39);
  assert.equal(injected?.messages?.length, 1, "at 40/50 the notice is injected");
  const content = injected.messages[0].content;
  assert.match(content, /^<step_budget>/);
  assert.match(content, /40 of 50 steps/);
  assert.equal(h.messages().length, 1, "the block is persisted on the channel");
  assert.equal(h.persisted().length, 1, "…and handed to the persistence seam");
  assert.equal(syntheticKindFromId(h.messages()[0].id), TURN_CONTEXT_KINDS.stepBudget, "the id carries its kind");

  const again = await h.run(45);
  assert.equal(again, undefined, "a later step does not stack a second notice");
  assert.equal(h.messages().length, 1);
}

{
  const h = harness({ max: 50, isSubagent: false });
  assert.equal(await h.run(49), undefined, "the root agent has no forced-summary semantics");
  assert.equal(h.messages().length, 0);
}

{
  const h = harness({ max: STEP_BUDGET_MIN_NOTICE - 1 });
  assert.equal(
    await h.run(STEP_BUDGET_MIN_NOTICE - 1),
    undefined,
    "an internal one-shot worker has no budget to warn about"
  );
}

{
  const h = harness({ max: 50 });
  assert.equal(await h.run(undefined), undefined, "no iteration on the context ⇒ no decision (never a guess)");
}

console.log("step-budget validation passed");

/**
 * Step-budget notice for subagent runs.
 *
 * A `task` subagent runs under a fixed iteration budget (`maxIterations`, 50 by default). When the
 * budget runs out the run stops mid-exploration and only a progress note comes back, so the last
 * few steps are worth more than the first: a reminder that the budget is running low gives the
 * child a chance to wrap up on its own terms. It is deliberately only a reminder — the child may
 * know the remaining question matters more than finishing early, and nothing here gates its tools.
 *
 * This middleware injects one notice at 80% of the budget (the threshold opencode derives from a
 * step cap too). It is deliberately:
 *
 * - **subagent-only** — the root turn has its own loop and no forced-summary semantics;
 * - **once per run** — the block is persisted on the channel and identified by its kind, so a
 *   retry that re-runs `onConfig` (and a later call that would recompute different numbers) does
 *   not stack a second copy;
 * - **after `turn-context`** — both append to the wire tail; the notice must be the newest block,
 *   and it must survive the channel projection (`compaction` runs before this phase and rebuilds
 *   the wire, discarding anything injected ahead of it).
 *
 * The notice is a synthetic `<ctx>` user message whose kind is the catalog's `stepBudget` entry,
 * like every other injected section: hidden in the transcript UI, persisted with the session, and
 * read back by the wire on the next call.
 */

import { injectSyntheticMessages } from "../../agent/turn-context/synthetic-injection.js";
import {
  TURN_CONTEXT_KINDS,
  formatSectionTag,
  syntheticKindFromId,
} from "../../agent/turn-context/turn-context-message.js";

import { defineMiddleware } from "./phase.js";

import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { AgentUIChannel } from "../../runtime-types";
import type { ChatMiddleware, ModelMessage } from "@tanstack/ai";

/** Fraction of the budget after which the notice is due. */
export const STEP_BUDGET_NOTICE_RATIO = 0.8;

/**
 * Budgets below this are not warned about.
 *
 * The notice only pays off when a few more steps are actually available; an internal one-shot
 * worker (`maxIterations: 1`) has nothing to converge from, and "80% of 1" is not a warning.
 */
export const STEP_BUDGET_MIN_NOTICE = 5;

export interface StepBudgetMiddlewareDeps {
  /** True for a spawned child (`parentId`), false for the root agent. */
  isSubagent: () => boolean;
  /** The iteration budget this run's engine was created with. */
  getMaxIterations: () => number | undefined;
  getUIChannel: () => AgentUIChannel | undefined;
  /** Persist the updated transcript (no-op for hosts without a session store). */
  persistMessages: (next: Parameters<AgentUIChannel["setMessages"]>[0]) => void;
  /** Test seam; defaults to the engine's 0-based iteration on the hook context. */
  getIteration?: (ctx: unknown) => number | undefined;
}

/** The engine's 0-based model-iteration counter, read off the middleware context. */
function engineIteration(ctx: unknown): number | undefined {
  const value = (ctx as { iteration?: unknown } | null | undefined)?.iteration;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The notice body for `used` of `max` steps.
 *
 * Split out (and exported) so the wording and its numbers are testable without driving a
 * middleware pipeline: the message is the whole product of this module.
 */
export function buildStepBudgetNotice(used: number, max: number): string {
  const remaining = Math.max(0, max - used);
  const percent = max > 0 ? Math.round((used / max) * 100) : 0;
  return [
    "Heads-up: the step budget for this task is getting low.",
    `Used ${used} of ${max} steps (${percent}%); about ${remaining} remain.`,
    "",
    "If you already have enough to answer, it may be a good time to wrap up — consider stopping new",
    "exploration and writing your findings with `begin_summary`, noting anything still unknown.",
    "This is only a reminder: keep working if the remaining questions matter more than finishing early.",
    "If the cap is reached, the run returns just a progress note, so a summary written before that",
    "usually carries more of what you found.",
  ].join("\n");
}

/** The engine's step budget is due for the notice at this 1-based step. */
export function stepBudgetThreshold(max: number): number {
  return Math.max(1, Math.ceil(max * STEP_BUDGET_NOTICE_RATIO));
}

export function createStepBudgetMiddleware(deps: StepBudgetMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  const readIteration = deps.getIteration ?? engineIteration;

  return defineMiddleware("context-transform", {
    name: "step-budget",
    onConfig: async (ctx, config) => {
      if (!deps.isSubagent()) return;
      const max = deps.getMaxIterations() ?? 0;
      if (max < STEP_BUDGET_MIN_NOTICE) return;

      const iteration = readIteration(ctx);
      if (iteration === undefined) return;
      // `iteration` is 0-based; the step about to run is 1-based.
      const used = iteration + 1;
      if (used < stepBudgetThreshold(max)) return;

      const channel = deps.getUIChannel();
      if (!channel) return;
      // Once per run: the block is persisted on the channel, so a retry/re-projection that re-runs
      // this hook (with a different `used`) must not append a second copy.
      if (channel.getMessages().some((message) => syntheticKindFromId(message.id) === TURN_CONTEXT_KINDS.stepBudget)) {
        return;
      }

      const { messages } = injectSyntheticMessages(
        config.messages as ModelMessage[],
        [
          {
            kind: TURN_CONTEXT_KINDS.stepBudget,
            content: formatSectionTag(TURN_CONTEXT_KINDS.stepBudget, [buildStepBudgetNotice(used, max)]),
          },
        ],
        { ui: channel, persist: deps.persistMessages }
      );
      return { messages };
    },
  });
}

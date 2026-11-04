/**
 * The policy snapshot an authorization decision is made from.
 *
 * Today it carries the mode facts (`ModeState`); the authorization pipeline adds the subagent
 * profile, rules, environment and capabilities to the same snapshot rather than re-deriving them
 * from ad-hoc flags. Keeping it pure data lets a decision be replayed and asserted.
 */

import type { ModeState, ModeToolAvailability } from "./mode-state.js";
import type { PlanModePhase } from "../plan/plan-mode-controller.js";

export interface AgentPolicyFacts {
  readonly planPhase: PlanModePhase;
  readonly auto: boolean;
  /** Plan steps were written to the todo list (`PLAN_TODO_TITLE`). */
  readonly todosSeeded: boolean;
  /**
   * The only plan-execution auto-approval condition: `executing`/`retro` AND a seeded todo list.
   *
   * Computed from the two raw facts, never read back from `shouldAutoApproveTools()`, so a phase
   * stuck without the seeded list stays "ask" and a review (`ready`) phase never inherits an
   * earlier execution's approval.
   */
  readonly planExecutionAutoApprove: boolean;
  readonly toolAvailability: ModeToolAvailability;
}

/** One consistent snapshot of the mode policy. */
export function resolveAgentPolicyFacts(mode: ModeState): AgentPolicyFacts {
  const snapshot = mode.snapshot();
  return {
    planPhase: snapshot.planPhase,
    auto: snapshot.auto,
    todosSeeded: snapshot.todosSeeded,
    planExecutionAutoApprove:
      (snapshot.planPhase === "executing" || snapshot.planPhase === "retro") && snapshot.todosSeeded,
    toolAvailability: mode.toolAvailability(),
  };
}

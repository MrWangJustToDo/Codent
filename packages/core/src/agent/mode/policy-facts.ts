/**
 * The policy snapshot an authorization decision is made from.
 *
 * Today it carries the mode facts (`ModeState`); the authorization pipeline adds the subagent
 * profile, rules, environment and capabilities to the same snapshot rather than re-deriving them
 * from ad-hoc flags. Keeping it pure data lets a decision be replayed and asserted.
 */

import { planExecutionAutoApproves } from "../plan/plan-mode-controller.js";

import type { ModeState, ModeToolAvailability } from "./mode-state.js";
import type { ModelCapability } from "../../models/types.js";
import type { AgentProfileId } from "../../runtime-types/agent-profile.js";
import type { PlanModePhase } from "../plan/plan-mode-controller.js";

/**
 * The profile this decision runs under.
 *
 * Deliberately the shared id union, not a second literal: this value feeds `authorizeToolCall`, so
 * a profile added to the authoritative table must not leave the authorization layer on a stale set.
 */
export type AgentProfile = AgentProfileId;

export interface AgentPolicyFactsInput {
  /** Toolset profile the agent runs under; `explore` is the read-only subagent profile. */
  profile?: AgentProfile;
  /** True for a delegated child (the parent task id exists). */
  isSubagent?: boolean;
  /** Model capabilities; `null` means unknown (permissive). */
  capabilities?: readonly ModelCapability[] | null;
  /** Names the profile/mode withholds, independent of the declarative approval requirement. */
  unavailableTools?: ReadonlySet<string>;
  /** Host environment facts a rule may inspect (never the process environment). */
  env?: Readonly<Record<string, string | undefined>>;
}

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
  readonly profile: AgentProfile;
  readonly isSubagent: boolean;
  readonly capabilities: readonly ModelCapability[] | null;
  /** Tools unavailable in this profile/mode: the pipeline denies them before approval. */
  readonly unavailableTools: ReadonlySet<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** One consistent snapshot of the mode policy. */
export function resolveAgentPolicyFacts(mode: ModeState, input: AgentPolicyFactsInput = {}): AgentPolicyFacts {
  const snapshot = mode.snapshot();
  const availability = mode.toolAvailability();
  const unavailableTools = new Set(availability.hiddenTools);
  for (const name of input.unavailableTools ?? []) unavailableTools.add(name);
  return {
    planPhase: snapshot.planPhase,
    auto: snapshot.auto,
    todosSeeded: snapshot.todosSeeded,
    // One definition (`planExecutionAutoApproves`), so the snapshot and the tool-set/approval
    // readers below cannot disagree about when plan execution is pre-approved.
    planExecutionAutoApprove: planExecutionAutoApproves(snapshot.planPhase, snapshot.todosSeeded),
    toolAvailability: availability,
    profile: input.profile ?? "root",
    isSubagent: input.isSubagent ?? false,
    capabilities: input.capabilities ?? null,
    unavailableTools,
    env: input.env ?? {},
  };
}

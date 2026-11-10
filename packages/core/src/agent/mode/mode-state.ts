/**
 * The one read API for plan and auto mode.
 *
 * The controllers remain the owners (they hold the mutable state and emit its transitions); this
 * module is a live, side-effect-free projection over them so consumers stop inspecting the
 * controllers directly. `todosSeeded` is deliberately part of the snapshot: plan-execution auto
 * approval is `phase ∈ {executing, retro} && todosSeeded`, and reading the controller's combined
 * `shouldAutoApproveTools()` hides which half is missing.
 */

import { planExecutionAutoApproves } from "../plan/plan-mode-controller.js";
import { PLAN_AUTHORING_TOOL_NAMES, PLAN_COMPLETION_TOOL_NAMES } from "../plan/plan-tools.js";

import type { AutoModeController } from "../approval/auto-mode-controller.js";
import type { PlanModeController, PlanModePhase, PlanModeState } from "../plan/plan-mode-controller.js";

export type ModeApproval = "auto" | "ask";

export interface ModeToolAvailability {
  readonly phase: PlanModePhase;
  /** Planning/ready: mutating, MCP and completion tools must be withheld. */
  readonly restrictsMutations: boolean;
  /** Phase-specific names withheld regardless of the tool registry. */
  readonly hiddenTools: ReadonlySet<string>;
}

export interface ModeSnapshot {
  /** Full plan artifact (phase, markdown, steps); persistence needs the whole record. */
  readonly plan: PlanModeState;
  readonly planPhase: PlanModePhase;
  readonly auto: boolean;
  readonly todosSeeded: boolean;
}

export interface ModeState {
  /** One consistent read of every mode fact; take it once per decision. */
  snapshot(): ModeSnapshot;
  /**
   * Whether the current mode bypasses the approval prompt for `toolName`.
   *
   * This answers the mode-policy half only: availability, command safety, extension hooks and the
   * persisted decision remain separate stages. A tool the mode withholds is never auto-approved
   * (availability decides deny, not approval), so it reads as "ask" here.
   */
  approvalPolicy(toolName: string): ModeApproval;
  toolAvailability(): ModeToolAvailability;
}

export interface ModeStateDeps {
  planMode: PlanModeController;
  autoMode: AutoModeController;
}

/** Tools offered while planning/ready: authoring, never completion. */
const PLANNING_HIDDEN = PLAN_COMPLETION_TOOL_NAMES;
/** Tools offered in retro: completion, never authoring. */
const RETRO_HIDDEN = PLAN_AUTHORING_TOOL_NAMES;
/** Off / executing: neither authoring nor completion. */
const IDLE_HIDDEN: ReadonlySet<string> = new Set([...PLAN_AUTHORING_TOOL_NAMES, ...PLAN_COMPLETION_TOOL_NAMES]);

export class ModeStateReader implements ModeState {
  constructor(private readonly deps: ModeStateDeps) {}

  snapshot(): ModeSnapshot {
    const plan = this.deps.planMode.getState();
    return {
      plan,
      planPhase: plan.phase,
      auto: this.deps.autoMode.isEnabled(),
      todosSeeded: plan.todosSeeded,
    };
  }

  approvalPolicy(toolName: string): ModeApproval {
    const snapshot = this.snapshot();
    const availability = this.availabilityFor(snapshot.planPhase);
    // A withheld tool is denied by availability; it must not borrow auto approval.
    if (availability.hiddenTools.has(toolName)) return "ask";
    if (snapshot.auto) return "auto";
    // Plan execution and its forced retro are one approved plan; the seeded todo list is the
    // second, independent condition (a phase stuck without it must not bypass approval).
    // Derived from the single rule, not a second copy of it.
    return planExecutionAutoApproves(snapshot.planPhase, snapshot.todosSeeded) ? "auto" : "ask";
  }

  toolAvailability(): ModeToolAvailability {
    return this.availabilityFor(this.deps.planMode.getPhase());
  }

  private availabilityFor(phase: PlanModePhase): ModeToolAvailability {
    if (phase === "planning" || phase === "ready") {
      return { phase, restrictsMutations: true, hiddenTools: PLANNING_HIDDEN };
    }
    if (phase === "retro") {
      return { phase, restrictsMutations: false, hiddenTools: RETRO_HIDDEN };
    }
    return { phase, restrictsMutations: false, hiddenTools: IDLE_HIDDEN };
  }
}

export function createModeState(deps: ModeStateDeps): ModeState {
  return new ModeStateReader(deps);
}

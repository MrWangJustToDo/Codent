/**
 * Plan/auto arbitration: the mutually-exclusive mode invariant, mode persistence and the
 * restore precedence (a restored plan phase wins over a persisted auto flag).
 *
 * The rules used to be copied across `setAutoModeEnabled`, `setAgentMode`, `enablePlanMode`,
 * `restoreManagedSession` and `getSessionPersistInput`. Keeping them here makes the invariant
 * inspectable and gives the auto-mode switch a single ordering: disable plan FIRST, then let the
 * AutoModeController change fire its persist, so the write cannot capture `plan on + auto on`.
 */

import { createModeState, type ModeState } from "./mode-state.js";
import { resolveAgentPolicyFacts, type AgentPolicyFacts, type AgentPolicyFactsInput } from "./policy-facts.js";

import type { AgentMode } from "../../runtime-types/session-payloads.js";
import type { AutoModeController } from "../approval/auto-mode-controller.js";
import type { PlanModeController, PlanModeState } from "../plan/plan-mode-controller.js";

export interface ModeCoordinatorDeps {
  planMode: PlanModeController;
  autoMode: AutoModeController;
  /** Persist the current session after a mode write that does not fire an auto-mode change. */
  persist: () => void;
}

export class ModeCoordinator {
  /** Live read model over the two controllers (see `agent/mode/mode-state.ts`). */
  private readonly state: ModeState;

  constructor(private readonly deps: ModeCoordinatorDeps) {
    this.state = createModeState({ planMode: deps.planMode, autoMode: deps.autoMode });
  }

  /** The single read surface consumers use instead of inspecting the controllers. */
  getState(): ModeState {
    return this.state;
  }

  /** One authorization-policy snapshot (mode facts today; the pipeline adds the rest). */
  getPolicyFacts(input: AgentPolicyFactsInput = {}): AgentPolicyFacts {
    return resolveAgentPolicyFacts(this.state, input);
  }

  isAutoEnabled(): boolean {
    return this.state.snapshot().auto;
  }

  /** Plan wins over auto; normal is the fallback. */
  getMode(): AgentMode {
    const snapshot = this.state.snapshot();
    if (snapshot.planPhase !== "off") return "plan";
    if (snapshot.auto) return "auto";
    return "normal";
  }

  /** True when auto mode or plan execution should bypass per-tool approvals. */
  shouldAutoApprove(): boolean {
    const facts = this.getPolicyFacts();
    return facts.auto || facts.planExecutionAutoApprove;
  }

  setAuto(enabled: boolean): void {
    const snapshot = this.state.snapshot();
    const planWasOn = snapshot.planPhase !== "off";
    const autoChanged = snapshot.auto !== enabled;
    // Mutually exclusive: leave plan before auto turns on, so the auto-mode change (and its
    // persist callback) observes the final state rather than `plan on + auto on`.
    if (enabled && planWasOn) this.deps.planMode.disable();
    this.deps.autoMode.setEnabled(enabled);
    // If auto was already on there was no onChange persist; a plan-only transition still needs one.
    if (planWasOn && !autoChanged) this.deps.persist();
  }

  enablePlan(): void {
    this.deps.planMode.enable();
    // Plan wins: an auto switch cannot remain on while plan mode is active.
    this.deps.autoMode.setEnabled(false);
    // Always persist: plan enable is session state, and the auto callback is a no-op when auto
    // was already off.
    this.deps.persist();
  }

  disablePlan(): void {
    this.deps.planMode.disable();
    this.deps.persist();
  }

  /**
   * Finish plan mode (`/mode done`, `complete_plan`).
   *
   * The phase transition belongs to the controller (it emits `plan:complete` and resets every
   * artifact), but the persist does not: a plan-off write fires no auto-mode change callback, so
   * the session would keep reporting the old phase until the next unrelated write. This is the
   * coordinator's counterpart to {@link enablePlan}, and it is what keeps `/mode done` from
   * skipping the same arbitration `/mode plan` goes through.
   */
  completePlan(): { ok: boolean; error?: string } {
    const result = this.deps.planMode.complete();
    if (result.ok) this.deps.persist();
    return result;
  }

  setMode(mode: AgentMode): AgentMode {
    if (mode === "plan") {
      this.enablePlan();
    } else if (mode === "auto") {
      this.setAuto(true);
    } else {
      if (this.state.snapshot().planPhase !== "off") this.disablePlan();
      this.setAuto(false);
    }
    return this.getMode();
  }

  cycle(): AgentMode {
    const current = this.getMode();
    return this.setMode(current === "normal" ? "auto" : current === "auto" ? "plan" : "normal");
  }

  /** `/new` / reset: exit both modes (an actual auto change still fires its onChange persist). */
  reset(): void {
    this.deps.planMode.disable();
    this.deps.autoMode.setEnabled(false);
  }

  /** The auto flag as it must be persisted: never true while a plan phase is active. */
  getPersistedAutoMode(): boolean {
    const snapshot = this.state.snapshot();
    return snapshot.planPhase === "off" && snapshot.auto;
  }

  /** Restore both modes; a restored plan phase wins over the persisted auto flag. */
  restore(plan: PlanModeState | null | undefined, auto: boolean): void {
    this.deps.planMode.restoreState(plan);
    // `restore`, not `setEnabled`: the load is not a user mode switch. Firing the live callback
    // here wrote `mode:change` into the TARGET's log while its envelope still named the departure
    // (the sink is re-bound before the load, adoption happens after), and attempted a persist the
    // service rejects — the target's own `session:restore` is the record.
    this.deps.autoMode.restore(this.state.snapshot().planPhase === "off" && auto);
  }
}

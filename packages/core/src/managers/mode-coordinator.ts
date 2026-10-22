/**
 * Plan/auto arbitration: the mutually-exclusive mode invariant, mode persistence and the
 * restore precedence (a restored plan phase wins over a persisted auto flag).
 *
 * The rules used to be copied across `setAutoModeEnabled`, `setAgentMode`, `enablePlanMode`,
 * `restoreManagedSession` and `getSessionPersistInput`. Keeping them here makes the invariant
 * inspectable and gives the auto-mode switch a single ordering: disable plan FIRST, then let the
 * AutoModeController change fire its persist, so the write cannot capture `plan on + auto on`.
 */

import type { AutoModeController } from "../agent/approval/auto-mode-controller.js";
import type { PlanModeController, PlanModeState } from "../agent/plan/plan-mode-controller.js";
import type { AgentMode } from "../runtime-types/session-payloads.js";

export interface ModeCoordinatorDeps {
  planMode: PlanModeController;
  autoMode: AutoModeController;
  /** Persist the current session after a mode write that does not fire an auto-mode change. */
  persist: () => void;
}

export class ModeCoordinator {
  constructor(private readonly deps: ModeCoordinatorDeps) {}

  isAutoEnabled(): boolean {
    return this.deps.autoMode.isEnabled();
  }

  /** Plan wins over auto; normal is the fallback. */
  getMode(): AgentMode {
    if (this.deps.planMode.getPhase() !== "off") return "plan";
    if (this.deps.autoMode.isEnabled()) return "auto";
    return "normal";
  }

  /** True when auto mode or plan execution should bypass per-tool approvals. */
  shouldAutoApprove(): boolean {
    return this.deps.autoMode.isEnabled() || this.deps.planMode.shouldAutoApproveTools();
  }

  setAuto(enabled: boolean): void {
    const planWasOn = this.deps.planMode.getPhase() !== "off";
    const autoChanged = this.deps.autoMode.isEnabled() !== enabled;
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

  setMode(mode: AgentMode): AgentMode {
    if (mode === "plan") {
      this.enablePlan();
    } else if (mode === "auto") {
      this.setAuto(true);
    } else {
      if (this.deps.planMode.getPhase() !== "off") this.disablePlan();
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
    return this.deps.planMode.getPhase() === "off" && this.deps.autoMode.isEnabled();
  }

  /** Restore both modes; a restored plan phase wins over the persisted auto flag. */
  restore(plan: PlanModeState | null | undefined, auto: boolean): void {
    this.deps.planMode.restoreState(plan);
    this.deps.autoMode.setEnabled(this.deps.planMode.getPhase() === "off" && auto);
  }
}

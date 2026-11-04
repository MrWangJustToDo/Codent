/**
 * Mode facet: plan/auto arbitration and the approval-policy view.
 *
 * `ModeCoordinator` owns the mutual-exclusion writes; this facet is the agent-facing read/write
 * surface (`normal` / `auto` / `plan`, auto flag, should-auto-approve) so `ManagedAgent` does not
 * grow another cluster of mode methods.
 */

import type { ModeCoordinator } from "./mode-coordinator.js";
import type { ModeState } from "./mode-state.js";
import type { AgentMode } from "../../runtime-types/session-payloads.js";

export interface ModeFacetHost {
  getMode(): ModeCoordinator;
  getModeState(): ModeState;
}

export class ModeFacet {
  constructor(private readonly host: ModeFacetHost) {}

  /** Plan wins over auto; normal is the fallback. */
  getMode(): AgentMode {
    return this.host.getMode().getMode();
  }

  setMode(mode: AgentMode): AgentMode {
    return this.host.getMode().setMode(mode);
  }

  cycle(): AgentMode {
    return this.host.getMode().cycle();
  }

  autoEnabled(): boolean {
    // Read through the mode surface: the coordinator is the writer, not a second read path.
    return this.host.getModeState().snapshot().auto;
  }

  setAuto(enabled: boolean): void {
    this.host.getMode().setAuto(enabled);
  }

  shouldAutoApprove(): boolean {
    return this.host.getMode().shouldAutoApprove();
  }
}

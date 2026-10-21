/**
 * Type-only host / orchestration ports for domain modules.
 *
 * Domain code (`agent/**`) imports these instead of reaching into `managers/`, so the
 * `agent → managers` edge does not exist in the source at all.
 *
 * These are re-exports rather than locally declared interfaces, and that is a
 * deliberate, recorded compromise rather than an oversight: `ManagedAgent` (129
 * members) and `AgentManager` are still the ownership point of the state these ports
 * describe, and hand-copying their shape here would create a second declaration that
 * silently drifts. The two cases are different in kind:
 *
 * - **Capability ports** (`UsageTracker`, `AgentUIChannel`) are genuinely small
 *   interfaces with one implementation, and a domain module consumes a handful of
 *   members. Those are real ports and should be declared where they are consumed.
 * - **Composition-root ports** (`ManagedAgent`, `AgentManager`) are whole objects. A
 *   structural port for them is only worth writing once `ManagedAgent` itself is split
 *   (see `openspec/changes/archive/2026-10-10-core-structure-convergence/architecture-debt-tracker.md`,
 *   P1-15) — until then a copied interface is a second source of truth for the exact
 *   surface the split is meant to shrink.
 *
 * So this module is the one place in `runtime-types/` allowed to name `managers/`,
 * and `validate-layer-boundaries` enforces that: the edge is registered `type-only`
 * and restricted to this file. Any other module here that reaches upward fails the
 * gate. Extracting these two ports outright is tracked as architecture debt.
 */

export type { ManagedAgent } from "../managers/managed-agent.js";
export type { AgentManager } from "../managers/agent-manager.js";
export type { UsageTracker } from "../managers/telemetry/usage-tracker.js";
export type { AgentStatusController } from "../managers/controllers/agent-status-controller.js";
// The agent-side counterpart: a real port (small interface, one implementation).
export type { AgentUIChannel } from "../agent/ui/ui-channel.js";

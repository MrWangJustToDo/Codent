/**
 * Release the process-level resources every agent owns.
 *
 * Two teardown paths existed: the registered one (`LifecycleCoordinator.destroy`, after the agent
 * is in the manager) and the bootstrap-failure one (`ManagedAgent.disposeBuiltResources`, before
 * registration). They released the same resources by hand, and had already drifted (the todo
 * manager's auto-clear timer was disposed in one and leaked in the other). Each path still decides
 * WHEN — the registered path also releases ownership/scopes, the failure path has nothing else —
 * but the LIST lives here once.
 *
 * Best-effort: one failing hook must not strand the rest of the teardown. Callers order these
 * before `markDestroyed` (which publishes state) and before extension teardown.
 */

import type { ManagedAgent } from "./managed-agent.js";

export function releaseAgentResources(managed: ManagedAgent): void {
  const attempt = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // Best-effort teardown: continue with the remaining resources.
    }
  };

  // Force-kill MCP child processes synchronously to prevent orphans on exit.
  attempt(() => managed.getMcpManager()?.forceKill());
  // A debounced memory-index refresh can outlive the agent and write after teardown.
  attempt(() => managed.getMemoryManager()?.dispose());
  // A completed list schedules a 3s auto-clear that notifies listeners; after destroy that would
  // publish `session:todos` from a removed agent.
  attempt(() => managed.getTodoManager?.()?.dispose());
}

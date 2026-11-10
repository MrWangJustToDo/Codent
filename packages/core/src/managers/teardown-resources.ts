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
 * Best-effort: one failing hook must not strand the rest of the teardown. The registered path
 * splits the list by timing: `forceKillMcpChildren` runs at the top of `destroy` (synchronous, so a
 * host that exits without settling teardowns does not orphan children), while the memory/todo
 * disposals run AFTER the extensions, so a `session:shutdown` hook never observes a disposed
 * manager. `markDestroyed` publishes state either way.
 */

import type { ManagedAgent } from "./managed-agent.js";

export function forceKillMcpChildren(managed: ManagedAgent): void {
  // Force-kill MCP child processes synchronously to prevent orphans on exit.
  //
  // Kept separate from the rest of the list because the two paths need it at DIFFERENT times: the
  // registered path kills at `destroy` (synchronous, so a host that exits without settling teardowns
  // does not orphan children — `validate:lifecycle-coordinator` asserts this), while the memory/todo
  // teardown must wait until the extensions have had their `session:shutdown` / `deactivate`. A
  // disposed memory manager inside a shutdown hook silently loses that hook's index write.
  try {
    managed.getMcpManager()?.forceKill();
  } catch {
    // Best-effort teardown: continue with the remaining resources.
  }
}

export function releaseAgentResources(managed: ManagedAgent): void {
  const attempt = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // Best-effort teardown: continue with the remaining resources.
    }
  };

  attempt(() => forceKillMcpChildren(managed));
  // A debounced memory-index refresh can outlive the agent and write after teardown.
  attempt(() => managed.getMemoryManager()?.dispose());
  // A completed list schedules a 3s auto-clear that notifies listeners; after destroy that would
  // publish `session:todos` from a removed agent.
  attempt(() => managed.getTodoManager?.()?.dispose());
}

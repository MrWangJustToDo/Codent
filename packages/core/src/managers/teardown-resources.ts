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
 * splits the list by timing: `forceKillChildProcesses` runs at the top of `destroy` (synchronous, so a
 * host that exits without settling teardowns does not orphan children), while the memory/todo
 * disposals run AFTER the extensions, so a `session:shutdown` hook never observes a disposed
 * manager. `markDestroyed` publishes state either way.
 */

import type { ManagedAgent } from "./managed-agent.js";

/**
 * Kill every child process this agent owns, synchronously.
 *
 * Split out because the two teardown paths need it at DIFFERENT times: the registered path kills at
 * the top of `destroy` (a host that exits without settling the async teardown must not orphan
 * children), while memory/todo disposal must wait until the extensions have had their
 * `session:shutdown` / `deactivate` (a disposed memory manager inside a shutdown hook silently loses
 * that hook's index write).
 *
 * Covered: MCP stdio children and LSP language servers, both of which expose a synchronous kill.
 * Background shell jobs are NOT covered — their `StartCommandHandle.kill` is async by contract, so
 * they only die through the awaited teardown; a host must settle it (or call `destroyAll`).
 */
export function forceKillChildProcesses(managed: ManagedAgent): void {
  // Force-kill MCP child processes synchronously to prevent orphans on exit.
  try {
    managed.getMcpManager()?.forceKill();
  } catch {
    // Best-effort teardown: continue with the remaining resources.
  }
  // Same rule for language servers: `shutdownAll` is the graceful (awaited) path.
  try {
    managed.getLspManager()?.forceKillAll();
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

  attempt(() => forceKillChildProcesses(managed));
  // A debounced memory-index refresh can outlive the agent and write after teardown.
  attempt(() => managed.getMemoryManager()?.dispose());
  // A completed list schedules a 3s auto-clear that notifies listeners; after destroy that would
  // publish `session:todos` from a removed agent.
  attempt(() => managed.getTodoManager?.()?.dispose());
}

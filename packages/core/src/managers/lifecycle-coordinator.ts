/**
 * Live-agent teardown: recursive child destruction, ownership release, and the async extension /
 * background-work / log-flush chain.
 *
 * `destroyAgent` must stay synchronous for its subagent/dispose callers, so the awaited teardown is
 * tracked here and exposed through `settleTeardowns()` for an ordered shutdown. The log sink stays
 * bound across the whole chain: `session:shutdown` is how an extension lands final work, so the
 * flush is the last step, never the first.
 */

import { clearTaskRuns } from "../agent/subagent/subagent-runs.js";
import { SUBAGENT_ABORT_REASONS } from "../agent/subagent/subagent-stop-reason.js";

import type { AgentRegistry } from "./agent-registry.js";
import type { SessionOwnership } from "./session-ownership.js";

export interface LifecycleCoordinatorDeps {
  registry: AgentRegistry;
  ownership: SessionOwnership;
  /** Drop the per-agent event-bus scope. */
  clearAgentScope: (id: string) => void;
}

export class LifecycleCoordinator {
  private pendingTeardowns = new Set<Promise<void>>();

  constructor(private readonly deps: LifecycleCoordinatorDeps) {}

  /** Destroy an agent and its subagents. Synchronous; teardown is tracked for settle. */
  destroy(id: string): void {
    const managedAgent = this.deps.registry.get(id);
    if (!managedAgent) return;

    this.deps.clearAgentScope(id);

    // Force-kill MCP child processes synchronously to prevent orphans on exit.
    managedAgent.getMcpManager()?.forceKill();
    // A debounced memory-index refresh can outlive the agent and write after teardown.
    managedAgent.getMemoryManager?.()?.dispose();

    managedAgent.abort(SUBAGENT_ABORT_REASONS.agentDestroyed);

    // Destroy all subagents first.
    for (const childId of [...managedAgent.childIds]) {
      this.destroy(childId);
    }

    // Remove from the tree before deleting the registry entry.
    if (managedAgent.parentId) {
      this.deps.registry.unlinkChild(managedAgent.parentId, id);
      // The row is gone from the parent's task list (the emit below), so its phase record has no
      // reader. Children are NOT destroyed at task end by default (`autoDestroy: false`, the preview
      // stays), which is why the phase usually lives until the session switch — but a host that does
      // destroy one must not leave the record behind.
      if (managedAgent.parentTaskId) {
        const parent = this.deps.registry.get(managedAgent.parentId);
        if (parent) clearTaskRuns(parent, managedAgent.parentTaskId);
      }
      managedAgent.emitEvent(
        "subagent:destroyed",
        { subagentId: id, parentTaskToolCallId: managedAgent.parentTaskId },
        { parentId: managedAgent.parentId }
      );
    }

    // Emit the interceptable session:shutdown first, then deactivate/destroy all extensions. The
    // flush is chained after teardown: landing the sink while a deactivate() flush could still be
    // pending loses the final batch. Releasing earlier also sends final extension work into a
    // retained buffer nothing can drain.
    const runner = managedAgent.getExtensionRunner();
    const teardown = (async () => {
      try {
        // A switch can still be between its awaits. Let it finish before closing persistence,
        // flushing the sink, and releasing the disk-session claim; otherwise it can adopt a new
        // session and re-bind writers after teardown has already run.
        await managedAgent.sessionLifecycle?.settle?.();
      } catch {
        // Best-effort: teardown still has to close and flush what exists.
      }

      try {
        if (runner) {
          // Awaited: the shutdown hook is how an extension lands final work, and the teardown
          // below unregisters its interceptor — so it must not still be running.
          await runner.emitSessionShutdown(id);
          await runner.destroyAll();
        }
      } catch {
        // Teardown failures are reported per phase on the bus; continue to cleanup.
      }

      try {
        // Kill this agent's background jobs so a disposed runtime does not leak child processes.
        await managedAgent.destroyCommandService();
      } catch {
        // A failed job teardown must not skip the log flush below.
      }

      try {
        // Close first: it waits both the serialized queue and direct pendingSaves
        // (e.g. the async title write) and refuses new writes. awaitPersistIdle alone
        // only covers the queue.
        await managedAgent.session?.close?.();
      } catch {
        // Best effort; the fallback drain/log flush below still runs.
      }
      try {
        // The abort/finalize path may have queued a final session write. Drain it as a
        // fallback before releasing the disk-session claim: otherwise another agent can
        // resume the id and receive this agent's late `pump-complete`.
        await managedAgent.session?.awaitPersistIdle?.();
      } catch {
        // Best effort; the log flush below still runs.
      }

      try {
        // Land buffered teardown/abort entries before the sink is dropped.
        managedAgent.flushLogOnDestroy();
      } catch {
        // The process is going away; a failed flush cannot be retried here.
      } finally {
        // Release ownership only after producers stopped, writes drained, and the log
        // flushed. Releasing at the top let a new resume claim the id while this
        // teardown was still writing to it.
        this.deps.ownership.releaseAllFor(id);
      }
    })();
    this.trackTeardown(teardown);

    this.deps.registry.delete(id);
  }

  /** Destroy all root agents (and therefore their subagents). */
  reset(): void {
    for (const agent of this.deps.registry.roots()) {
      this.destroy(agent.id);
    }
  }

  /** Wait for every in-flight teardown; cascades can enqueue more while these settle. */
  async settleTeardowns(): Promise<void> {
    while (this.pendingTeardowns.size > 0) {
      await Promise.allSettled([...this.pendingTeardowns]);
    }
  }

  /** Track a teardown promise so {@link settleTeardowns} can await it. @internal */
  trackTeardown(promise: Promise<void>): void {
    this.pendingTeardowns.add(promise);
    void promise.finally(() => this.pendingTeardowns.delete(promise));
  }
}

/**
 * Live-agent teardown: recursive child destruction, ownership release, and the async extension /
 * background-work / log-flush chain.
 *
 * `destroyAgent` must stay synchronous for its subagent/dispose callers, so the awaited teardown is
 * tracked here and exposed through `settleTeardowns()` for an ordered shutdown. The log sink stays
 * bound across the whole chain: `session:shutdown` is how an extension lands final work, so the
 * flush is the last step, never the first.
 */

import { isCallbackTimeoutError, withCallbackTimeout } from "../agent/extension/callback-timeout.js";
import { clearTaskRuns } from "../agent/subagent/subagent-runs.js";
import { SUBAGENT_ABORT_REASONS } from "../agent/subagent/subagent-stop-reason.js";
import { errorMessage } from "../utils/errors.js";

import { releaseAgentResources } from "./teardown-resources.js";

import type { AgentRegistry } from "./agent-registry.js";
import type { AgentLog } from "../agent/agent-log/agent-log.js";
import type { SessionOwnership } from "../agent/session/session-ownership.js";

/** Upper bound on one external await in the async teardown chain. */
const TEARDOWN_STEP_TIMEOUT_MS = 60_000;

export interface LifecycleCoordinatorDeps {
  registry: AgentRegistry;
  /**
   * Drop every claim held by an agent (the teardown backstop for a claim a failed release left
   * behind).
   *
   * A live delegating object, not the table itself: the owner may replace its table (a manager
   * bound to a runtime after construction), and a captured reference would release into the old
   * one — leaving a claim in the table the agents actually use.
   */
  ownership: Pick<SessionOwnership, "releaseAllFor">;
  /** Drop the per-agent event-bus scope. */
  clearAgentScope: (id: string) => void;
  /**
   * Keep this agent's log resolvable for the whole teardown. The registry entry is removed
   * synchronously (callers rely on `destroyAgent` being immediate), but teardown is async and
   * emits `agent:extension-error` / `session:save-error` producers that must still reach a sink —
   * otherwise the failures that explain a bad shutdown are the ones dropped.
   */
  retainLog?: (id: string, log: AgentLog, meta?: { runId?: string; sessionId?: string }) => void;
  /** Release a retained log once its teardown has flushed and settled. */
  releaseLog?: (id: string) => void;
}

export class LifecycleCoordinator {
  private pendingTeardowns = new Set<Promise<void>>();

  constructor(private readonly deps: LifecycleCoordinatorDeps) {}

  /** Destroy an agent and its subagents. Synchronous; teardown is tracked for settle. */
  destroy(id: string): void {
    const managedAgent = this.deps.registry.get(id);
    if (!managedAgent) return;

    // Every synchronous step is best-effort. A throwing teardown hook used to abort this method
    // before `registry.delete`, leaving a half-destroyed agent still registered (a retry hit the
    // same failure) AND skipping the async teardown that releases extensions, background work,
    // persistence and the log sink. Failure detail is already reported per phase on the bus.
    const attempt = (fn: () => void): void => {
      try {
        fn();
      } catch {
        // continue: one failed hook must not strand the rest of the teardown
      }
    };

    attempt(() => this.deps.clearAgentScope(id));
    // Release the UI channel's subscriptions (approval-request, retained providers) while the graph
    // is still alive. A host that keeps the `AgentSession` around used to pin the whole object graph
    // (transcript, runner, tool registry, log sink) until the next connect, because nothing ever
    // passed `undefined` to `setUIChannel`.
    attempt(() => managedAgent.setUIChannel(undefined));
    // The process-level resources (MCP children, memory index debounce, todo auto-clear) — the same
    // list the bootstrap-failure path releases. Best-effort inside.
    releaseAgentResources(managedAgent);

    // Before the abort: the compaction `finally` and any queued pump unwind asynchronously and must
    // see "destroyed", not "stopped", or they resume a run on an agent that is being removed.
    attempt(() => managedAgent.markDestroyed());
    attempt(() => managedAgent.sessionLease.beginDrain());
    attempt(() => managedAgent.abort(SUBAGENT_ABORT_REASONS.agentDestroyed));

    // Destroy all subagents first.
    const childIds = [...managedAgent.childIds];
    for (const childId of childIds) {
      attempt(() => this.destroy(childId));
    }

    // Remove from the tree before deleting the registry entry.
    const parentId = managedAgent.parentId;
    if (parentId) {
      attempt(() => this.deps.registry.unlinkChild(parentId, id));
      // The row is gone from the parent's task list (the emit below), so its phase record has no
      // reader. Children are NOT destroyed at task end by default (`autoDestroy: false`, the preview
      // stays), which is why the phase usually lives until the session switch — but a host that does
      // destroy one must not leave the record behind.
      attempt(() => {
        if (managedAgent.parentTaskId) {
          const parent = this.deps.registry.get(parentId);
          if (parent) clearTaskRuns(parent, managedAgent.parentTaskId);
        }
        managedAgent.emitEvent(
          "subagent:destroyed",
          { subagentId: id, parentTaskToolCallId: managedAgent.parentTaskId },
          { parentId }
        );
      });
    }

    // Emit the interceptable session:shutdown first, then deactivate/destroy all extensions. The
    // flush is chained after teardown: landing the sink while a deactivate() flush could still be
    // pending loses the final batch. Releasing earlier also sends final extension work into a
    // retained buffer nothing can drain.
    let runner: ReturnType<typeof managedAgent.getExtensionRunner>;
    try {
      runner = managedAgent.getExtensionRunner();
    } catch {
      runner = null;
    }
    // The async half awaits external work (a switch, a pump, a remote save). None of it has a
    // timeout of its own, so one hung step made `settleTeardowns()` / `dispose()` never resolve —
    // the same "quit does not quit" failure the extension callbacks were bounded against, one layer
    // down. A timeout means "stop waiting", never "cancel": cleanup below still runs.
    const settleStep = async (label: string, step: () => Promise<unknown> | undefined): Promise<void> => {
      try {
        const pending = step();
        if (!pending) return;
        await withCallbackTimeout(pending, label, TEARDOWN_STEP_TIMEOUT_MS);
      } catch (error) {
        // A timeout means "stop waiting" (warn); any other throw is a real teardown failure and is
        // reported as an error, so a broken step cannot hide behind the timeout wording.
        const message = errorMessage(error);
        // Typed, not regex-parsed: the classification must survive a wording change.
        const timedOut = isCallbackTimeoutError(error);
        try {
          managedAgent.emitEvent("session:diagnostic", {
            area: "session",
            message: timedOut ? `${label} did not settle; teardown continued` : `${label} failed; teardown continued`,
            level: timedOut ? "warn" : "error",
            error: message,
          });
        } catch {
          // Reporting must not break teardown either.
        }
      }
    };

    const teardown = (async () => {
      // A switch can still be between its awaits. Let it finish before closing persistence,
      // flushing the sink, and releasing the disk-session claim; otherwise it can adopt a new
      // session and re-bind writers after teardown has already run.
      await settleStep("session switch settlement", () => managedAgent.sessionLifecycle?.settle?.());

      // ORDER MATTERS: let the aborted run finish BEFORE removing what it writes through. The
      // pump's final tool results/usage land through registrations, and doing extension teardown
      // first revoked the lease under a run that was still unwinding (tail results were refused and
      // the last assistant message could be lost). Background jobs stay after the extensions on
      // purpose: their delivery goes through the extension middleware, so tearing that down first
      // stops new work from being pushed into a session that is closing.
      // Let the pump write its final tool results/usage before persistence closes. The abort above
      // should end it; a parked approval has no live pump and resolves immediately.
      await settleStep("chat pump settlement", () => managedAgent.getChatController?.()?.settleRun?.());

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
        // Kill this agent's background work so a disposed runtime does not leak child processes.
        await managedAgent.destroyBackgroundWork();
      } catch {
        // A failed job teardown must not skip the log flush below.
      }

      // Close first: it waits both the serialized queue and direct pendingSaves (e.g. the async
      // title write) and refuses new writes. `awaitPersistIdle` alone only covers the queue.
      await settleStep("session close", () => managedAgent.session?.close?.());
      // The abort/finalize path may have queued a final session write. Drain it as a fallback
      // before releasing the disk-session claim: otherwise another agent can resume the id and
      // receive this agent's late `pump-complete`.
      await settleStep("session persist drain", () => managedAgent.session?.awaitPersistIdle?.());

      try {
        // Land buffered teardown/abort entries before the sink is dropped. Awaited: on a
        // remote CoreEnv the final batch can only be written asynchronously.
        await managedAgent.flushLogOnDestroy();
      } catch {
        // The process is going away; a failed flush cannot be retried here.
      } finally {
        // Release ownership only after producers stopped, writes drained, and the log
        // flushed. Releasing at the top let a new resume claim the id while this
        // teardown was still writing to it. The lease is the owner (and releases the
        // empty-session reservation it created); `releaseAllFor` stays as the stale-claim backstop.
        try {
          await managedAgent.releaseSessionLease();
        } catch {
          // Best-effort; the storage releases below still run.
        }
        this.deps.ownership.releaseAllFor(id);
        this.deps.releaseLog?.(id);
      }
    })();
    this.trackTeardown(teardown);

    // Snapshot the envelope identity while the agent still knows it: the registry entry is about to
    // be removed, and `resolveMeta` cannot answer for a retained log afterwards.
    // Optional-call: structural hosts (validators, embedded harnesses) drive this coordinator with
    // a fake that has no envelope accessor; attribution is an improvement, not a requirement.
    try {
      this.deps.retainLog?.(id, managedAgent.log, managedAgent.getEventContext?.());
    } finally {
      // The registry entry must go even if the log snapshot throws: keeping it means a retry runs
      // this same teardown against an already-destroyed agent.
      this.deps.registry.delete(id);
    }
  }

  /** Destroy all root agents (and therefore their subagents). */
  reset(): void {
    for (const agent of this.deps.registry.roots()) {
      // One root's failure must not prevent the remaining roots from being destroyed; `destroy`
      // already contains its own steps, but `roots()` itself can hand back a half-removed tree.
      try {
        this.destroy(agent.id);
      } catch {
        // continue with the next root
      }
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
    // `.then` on both arms, not `.finally`: `finally` re-throws into a derived promise nobody
    // observes, so any future unguarded await inside a teardown would surface as an
    // `unhandledRejection` — and a host running `installAgentLogProcessGuards()` exits the process
    // on one. `settleTeardowns` still sees the rejection through `allSettled`.
    void promise.then(
      () => this.pendingTeardowns.delete(promise),
      () => this.pendingTeardowns.delete(promise)
    );
  }
}

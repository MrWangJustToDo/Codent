/**
 * Unified event-bus root plus the per-agent scope cache.
 *
 * The root bus owns interceptor error isolation: a throwing interceptor is reported to the log of
 * the scope it was registered on, falling back to any agent log for root-scoped hooks. Scopes are
 * cached by agent id so `manager.of(id)` is stable, and a destroyed agent drops its scope here.
 */

import { createAgentEventBus } from "../agent/agent-event-bus";
import { handlerFailureKey } from "../utils/contained-report.js";
import { errorMessage } from "../utils/errors.js";

import type { AgentEventListener, AgentEventBus, AgentEventType } from "../agent/agent-event-bus";

export interface AgentEventBusScopeDeps {
  /**
   * Id of the agent whose log should receive a handler failure for `scopeId`.
   *
   * The id (not the `AgentLog`) because the failure is reported as an event: the bridge resolves
   * the log by `event.agentId`, so the scope only has to name the owner. `undefined` means "no log
   * anywhere" — the old fallback that picked any agent with a log.
   */
  resolveLogOwner: (scopeId: string) => string | undefined;
  /**
   * Envelope fields the bus stamps when an emitter supplied none.
   *
   * `runId`/`sessionId` are properties of the agent, not of a call site. Resolving them here (rather
   * than only in `ManagedAgent.dispatchEvent`) is what makes a domain object that emits straight on
   * its scoped bus — plan, ui, stream-hub, the extension runner — produce the same envelope as one
   * that goes through the telemetry funnel.
   */
  resolveMeta?: (agentId: string) => { runId?: string; sessionId?: string } | undefined;
  /**
   * Per-chain interceptor budget override (a host with a longer teardown contract, and validators
   * that cannot wait the default). Omitted ⇒ `EXTENSION_CALLBACK_TIMEOUT_MS`.
   */
  interceptorTimeoutMs?: number;
}

export class AgentEventBusScope {
  readonly root: AgentEventBus;
  private readonly scopes = new Map<string, AgentEventBus>();
  private readonly parents = new Map<string, string | undefined>();
  /** Set by {@link dispose}: a disposed manager must not mint durable subscriptions/scopes. */
  private disposed = false;
  /**
   * Re-entrancy guard for handler-failure reporting.
   *
   * The report is an event, and the log bridge is itself a wildcard listener. If the bridge throws
   * while writing the report, the bus calls this sink again — unbounded recursion. One frame is
   * dropped instead, which is the same trade-off `extension:log` makes for its own observer loop.
   */
  private reportingHandlerError = false;
  /**
   * Root-scope failures are reported once per (event, pattern) on STDERR.
   *
   * The bus's own default reporter (dedupe + stderr) is bypassed whenever a host sink is supplied,
   * and `AgentEventBusScope` always supplies one. A failure on a root-scoped listener (`agentManager
   * .on`, the log bridge itself) has no owning `AgentLog`, so the event that reports it has no
   * `agentId` the bridge can resolve — it was dropped in silence. This is the fallback that used to
   * exist on the default reporter. The EVENT is still emitted every time (a fact; observers count
   * it); row volume for owned scopes is the log policy's decision (`event-log-rules.ts` throttles
   * `agent:event-handler-error`).
   */
  private readonly reportedRootFailures = new Set<string>();

  constructor(private readonly deps: AgentEventBusScopeDeps) {
    this.root = createAgentEventBus("root", (info) => this.reportHandlerError(info), {
      resolveMeta: (agentId) => this.deps.resolveMeta?.(agentId),
      ...(this.deps.interceptorTimeoutMs !== undefined ? { interceptorTimeoutMs: this.deps.interceptorTimeoutMs } : {}),
    });
  }

  /**
   * Publish one `agent:event-handler-error` for a contained observer/interceptor failure.
   *
   * Previously a direct `AgentLog` write, which made this the one diagnostic that bypassed the
   * policy table (and could land on an arbitrary agent's file). The event carries the owning agent
   * id, so the bridge resolves the same log the direct write used to pick.
   */
  private reportHandlerError(info: {
    pattern: string;
    event: string;
    scopeId: string;
    error: unknown;
    kind?: "interceptor" | "observer";
  }): void {
    if (this.reportingHandlerError) return;
    const ownerId = this.deps.resolveLogOwner(info.scopeId);
    const parentId = ownerId ? this.parents.get(info.scopeId) : undefined;
    if (ownerId === undefined) {
      // Nothing owns an `AgentLog` here, so the emitted report cannot reach disk. Say it on stderr
      // instead of dropping the only evidence that a root listener is broken.
      // `kind` is part of the identity: one handler name can be registered as BOTH an observer and
      // an interceptor (legal). Without it the first failure claimed the key and the second mode's
      // failure never reached stderr — the diagnostic swallowed by the diagnostic mechanism.
      const key = handlerFailureKey(info);
      if (!this.reportedRootFailures.has(key)) {
        if (this.reportedRootFailures.size >= 100) this.reportedRootFailures.clear();
        this.reportedRootFailures.add(key);
        console.error(
          `[agent:event] ${info.kind ?? "interceptor"} handler failed for "${info.event}" (no owning log, scope ${info.scopeId}):`,
          info.error
        );
      }
    }
    this.reportingHandlerError = true;
    try {
      // Emit on the OWNING agent's bus, not the root. `emit` travels self → ancestors, so a root
      // frame could never reach the agent's own scope: the event is declared `observable`, yet
      // `ctx.events.observe("agent:event-handler-error")` (registered on the agent bus) never saw
      // it. Emitting on the owner also up-flows to the root, so wildcard/global listeners keep the
      // frame. A scope already dropped by teardown falls back to the root and still carries
      // `agentId` for the log bridge. (There is no `channel` in the meta, so this does NOT publish
      // on an `AgentSession` channel — the typed/extension observer surface is the gain.)
      // A root-scoped listener (`agentManager.on("*", …)`) has no owning agent; it is still a
      // subscriber that must hear about a contained failure instead of the report vanishing.
      const target = ownerId ? (this.scopes.get(ownerId) ?? this.root) : this.root;
      target.emit(
        "agent:event-handler-error",
        {
          pattern: info.pattern,
          event: info.event,
          kind: info.kind ?? "interceptor",
          error: errorMessage(info.error),
        },
        // Identity has two halves: `agentId` comes from the meta override and the PARENT from the
        // scope tree. Emitting on the root node (a root-scoped failure) means `buildEventAt`
        // cannot derive an agent, and stamping one would be a lie.
        ownerId !== undefined ? { agentId: ownerId, ...(parentId !== undefined ? { parentId } : {}) } : undefined
      );
    } catch {
      // A failure while REPORTING a failure is contained: the bus already lost the frame, and the
      // process must not lose the run over it.
    } finally {
      this.reportingHandlerError = false;
    }
  }

  on(type: AgentEventType | "*", listener: AgentEventListener): () => void {
    // The manager this bus belongs to is gone; a subscription would outlive every emitter and pin
    // the listener for the rest of the process.
    if (this.disposed) return () => {};
    return this.root.on(type, listener);
  }

  /** Scoped bus for one agent; subagents are scoped under their parent and up-flow. */
  of(agentId: string, parentId?: string): AgentEventBus {
    // Teardown paths may still ask for a scope (a late producer unwinding). Hand back a detached
    // bus instead of caching a new scope nobody will ever delete.
    if (this.disposed) return createAgentEventBus(`disposed:${agentId}`);
    const cached = this.scopes.get(agentId);
    if (cached) {
      const existingParent = this.parents.get(agentId);
      // Asking again without a parent is not a conflict: the existing (possibly parented) scope is
      // still the right answer. A DIFFERENT parent is: re-parenting would hand back a new bus while
      // the subscribers that took the old one silently stop seeing this agent's events, so the
      // first call still wins and the mistake stays visible.
      if (existingParent === parentId || parentId === undefined) return cached;
      throw new Error(
        `Agent event bus scope "${agentId}" was already created with parent "${String(existingParent)}" and ` +
          `cannot be re-parented to "${parentId}". Create the scope with its parent on the first call.`
      );
    }
    // Recursive parent creation must not re-validate the parent's own relation: callers only pass
    // one level, and the parent may already have been created under its own parent.
    const parent = parentId ? this.ensureScope(parentId) : this.root;
    const bus = parent.scope(agentId);
    this.scopes.set(agentId, bus);
    this.parents.set(agentId, parentId);
    return bus;
  }

  private ensureScope(agentId: string): AgentEventBus {
    const cached = this.scopes.get(agentId);
    if (cached) return cached;
    const bus = this.root.scope(agentId);
    this.scopes.set(agentId, bus);
    this.parents.set(agentId, undefined);
    return bus;
  }

  /** Drop a destroyed agent's scope. */
  delete(agentId: string): void {
    this.scopes.delete(agentId);
    this.parents.delete(agentId);
  }

  /**
   * Retire the scope registry with its manager.
   *
   * The root bus itself is owned by the manager, so listeners/retained values are collected with
   * it; what must not survive is the scope cache (a late `of()` used to recreate an orphan scope
   * that no teardown would ever reach).
   */
  dispose(): void {
    this.disposed = true;
    this.scopes.clear();
    this.parents.clear();
  }
}

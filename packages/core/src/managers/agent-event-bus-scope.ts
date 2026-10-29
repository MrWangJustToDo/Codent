/**
 * Unified event-bus root plus the per-agent scope cache.
 *
 * The root bus owns interceptor error isolation: a throwing interceptor is reported to the log of
 * the scope it was registered on, falling back to any agent log for root-scoped hooks. Scopes are
 * cached by agent id so `manager.of(id)` is stable, and a destroyed agent drops its scope here.
 */

import { createAgentEventBus } from "../agent/agent-event-bus";
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
}

export class AgentEventBusScope {
  readonly root: AgentEventBus;
  private readonly scopes = new Map<string, AgentEventBus>();
  private readonly parents = new Map<string, string | undefined>();
  /**
   * Re-entrancy guard for handler-failure reporting.
   *
   * The report is an event, and the log bridge is itself a wildcard listener. If the bridge throws
   * while writing the report, the bus calls this sink again — unbounded recursion. One frame is
   * dropped instead, which is the same trade-off `extension:log` makes for its own observer loop.
   */
  private reportingHandlerError = false;

  constructor(private readonly deps: AgentEventBusScopeDeps) {
    this.root = createAgentEventBus("root", (info) => this.reportHandlerError(info), {
      resolveMeta: (agentId) => this.deps.resolveMeta?.(agentId),
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
    if (!ownerId) return;
    this.reportingHandlerError = true;
    try {
      this.root.emit(
        "agent:event-handler-error",
        {
          pattern: info.pattern,
          event: info.event,
          kind: info.kind ?? "interceptor",
          error: errorMessage(info.error),
        },
        { agentId: ownerId }
      );
    } catch {
      // A failure while REPORTING a failure is contained: the bus already lost the frame, and the
      // process must not lose the run over it.
    } finally {
      this.reportingHandlerError = false;
    }
  }

  on(type: AgentEventType | "*", listener: AgentEventListener): () => void {
    return this.root.on(type, listener);
  }

  /** Scoped bus for one agent; subagents are scoped under their parent and up-flow. */
  of(agentId: string, parentId?: string): AgentEventBus {
    const cached = this.scopes.get(agentId);
    if (cached) {
      if (this.parents.get(agentId) !== parentId) {
        throw new Error(
          `Agent event bus scope "${agentId}" was already created with a different parent; ` +
            `the first call wins (got ${String(this.parents.get(agentId))}, requested ${String(parentId)}).`
        );
      }
      return cached;
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
}

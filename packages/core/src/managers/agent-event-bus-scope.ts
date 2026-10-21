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
import type { AgentLog } from "../agent/agent-log";

export interface AgentEventBusScopeDeps {
  /** Resolve the log for the scope that registered a failing interceptor. */
  resolveLog: (scopeId: string) => AgentLog | undefined;
}

export class AgentEventBusScope {
  readonly root: AgentEventBus;
  private readonly scopes = new Map<string, AgentEventBus>();
  private readonly parents = new Map<string, string | undefined>();

  constructor(private readonly deps: AgentEventBusScopeDeps) {
    this.root = createAgentEventBus("root", ({ pattern, event, scopeId, error }) => {
      this.deps.resolveLog(scopeId)?.warn("hooks", "interceptor threw; continuing without it", {
        pattern,
        event,
        error: errorMessage(error),
      });
    });
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

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
    if (cached) return cached;
    const parent = parentId ? this.of(parentId) : this.root;
    const bus = parent.scope(agentId);
    this.scopes.set(agentId, bus);
    return bus;
  }

  /** Drop a destroyed agent's scope. */
  delete(agentId: string): void {
    this.scopes.delete(agentId);
  }
}

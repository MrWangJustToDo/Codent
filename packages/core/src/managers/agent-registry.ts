/**
 * Live-agent registry and the subagent tree queries built on it.
 *
 * The map is the only source for "which agents exist"; the tree methods keep the parent/child
 * bookkeeping in one place so `AgentManager` does not hand-roll `childIds` mutations. (The
 * `ManagedAgent.childIds` field is still the compatibility surface used by the abort cascade;
 * moving that ownership out is a follow-up, not a second map.)
 */

import { ACTIVE_STATUSES } from "../runtime-types/agent-status.js";

import type { ManagedAgent } from "./managed-agent.js";

export class AgentRegistry {
  private readonly agents = new Map<string, ManagedAgent>();

  /** Register a freshly built agent; duplicate ids are a programming error, not a replace. */
  register(agent: ManagedAgent): void {
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent id already registered: ${agent.id}`);
    }
    this.agents.set(agent.id, agent);
  }

  get(id: string): ManagedAgent | undefined {
    return this.agents.get(id);
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  delete(id: string): void {
    this.agents.delete(id);
  }

  values(): IterableIterator<ManagedAgent> {
    return this.agents.values();
  }

  all(): ManagedAgent[] {
    return Array.from(this.agents.values());
  }

  roots(): ManagedAgent[] {
    return this.all().filter((agent) => !agent.parentId);
  }

  /** Attach a child id to its parent (the parent may be missing only in a malformed setup). */
  linkChild(parentId: string, childId: string): void {
    const parent = this.agents.get(parentId);
    if (!parent) return;
    parent.childIds.push(childId);
    parent.updatedAt = Date.now();
  }

  /** Detach a child id from its parent. */
  unlinkChild(parentId: string, childId: string): void {
    const parent = this.agents.get(parentId);
    if (!parent) return;
    parent.childIds = parent.childIds.filter((id) => id !== childId);
    parent.updatedAt = Date.now();
  }

  subagents(parentId: string): ManagedAgent[] {
    const parent = this.agents.get(parentId);
    if (!parent) return [];
    return parent.childIds
      .map((id) => this.agents.get(id))
      .filter((agent): agent is ManagedAgent => agent !== undefined);
  }

  /** Active descendants, deepest-first (the abort cascade's LIFO order). */
  activeSubagents(rootAgentId: string): ManagedAgent[] {
    return this.collectSubagents(
      rootAgentId,
      (agent) => agent.parentId != null && ACTIVE_STATUSES.has(agent.getStatus())
    );
  }

  /** All descendants, deepest-first (the task panel's history order). */
  allSubagents(rootAgentId: string): ManagedAgent[] {
    return this.collectSubagents(rootAgentId, (agent) => agent.parentId != null);
  }

  private collectSubagents(rootAgentId: string, filter: (agent: ManagedAgent) => boolean): ManagedAgent[] {
    const result: ManagedAgent[] = [];
    const seen = new Set<string>();

    const walk = (agentId: string): void => {
      const managed = this.agents.get(agentId);
      if (!managed) return;
      // Recurse into children first (deepest-first ordering).
      for (const childId of [...managed.childIds].reverse()) walk(childId);
      if (filter(managed) && !seen.has(managed.id)) {
        seen.add(managed.id);
        result.push(managed);
      }
    };

    walk(rootAgentId);
    return result;
  }
}

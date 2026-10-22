/**
 * Per-agent tool registry — ownership, dispatch rank, live resolution, and the tools record.
 *
 * This is pure state: it does not create tools, read the environment, or know about extensions.
 * `AgentToolService` is the orchestration layer that registers and unregisters entries.
 */

import { INCUMBENT_RANK, compareDispatchRank } from "../../extension/dispatch-order.js";

import { getToolMetadata } from "./define-tool.js";

import type { ToModelOutputFn } from "./contract.js";
import type { DispatchRank } from "../../extension/dispatch-order.js";
import type { ToolsRecord } from "../catalog/tool-set.js";
import type { ToolPresentation } from "../presentation/types.js";

export interface AgentToolEntry {
  name: string;
  tool: unknown;
  ownerId: string;
  rank: DispatchRank;
}

export interface ResolvedAgentTool extends AgentToolEntry {
  present?: ToolPresentation;
  toModelOutput?: ToModelOutputFn;
}

/** Who owns the entry that was already in the record before any extension registered. */
const INCUMBENT_TOOL_OWNER = "(incumbent)";

export class AgentToolRegistry {
  private readonly stacks = new Map<string, AgentToolEntry[]>();
  private registrationSeq = 0;

  constructor(private readonly tools: ToolsRecord = {}) {}

  /** The stable live record consumed by the runner and extension callbacks. */
  getToolsRecord(): ToolsRecord {
    return this.tools;
  }

  /** Whether any non-incumbent owner has claimed a tool. */
  hasOwnerClaims(): boolean {
    for (const stack of this.stacks.values()) {
      if (stack.some((entry) => entry.ownerId !== INCUMBENT_TOOL_OWNER)) return true;
    }
    return false;
  }

  /** Seed a built-in/existing tool without claiming extension ownership. */
  seed(name: string, tool: unknown): void {
    if (this.stacks.has(name)) return;
    this.stacks.set(name, [{ name, tool, ownerId: INCUMBENT_TOOL_OWNER, rank: INCUMBENT_RANK }]);
    this.materialize(name);
  }

  /** Register a tool under an owner. Re-registering the same owner replaces its entry. */
  register(name: string, tool: unknown, ownerId: string, rank?: DispatchRank): void {
    let stack = this.stacks.get(name);
    const existing = (this.tools as Record<string, unknown>)[name];
    if (!stack) {
      stack = [{ name, tool: existing, ownerId: INCUMBENT_TOOL_OWNER, rank: INCUMBENT_RANK }];
      this.stacks.set(name, stack);
    }

    const resolvedRank = rank ?? { order: 0, seq: ++this.registrationSeq };
    const own = stack.findIndex((entry) => entry.ownerId === ownerId);
    if (own === -1) stack.push({ name, tool, ownerId, rank: resolvedRank });
    else stack[own] = { name, tool, ownerId, rank: resolvedRank };
    this.materialize(name);
  }

  /** Remove every entry owned by `ownerId`; returns whether this name changed. */
  unregisterOwner(name: string, ownerId: string): boolean {
    const stack = this.stacks.get(name);
    if (!stack) return false;
    const remaining = stack.filter((entry) => entry.ownerId !== ownerId);
    if (remaining.length === stack.length) return false;
    if (remaining.length === 0) {
      this.stacks.delete(name);
      delete (this.tools as Record<string, unknown>)[name];
      return true;
    }
    this.stacks.set(name, remaining);
    this.materialize(name);
    return true;
  }

  /** The live entry for a name: the highest dispatch rank, with the incumbent at the bottom. */
  resolve(name: string): ResolvedAgentTool | undefined {
    const stack = this.stacks.get(name);
    if (!stack || stack.length === 0) return undefined;
    const top = stack.reduce((best, entry) => (compareDispatchRank(entry.rank, best.rank) > 0 ? entry : best));
    if (top.tool === undefined) return undefined;
    // Metadata belongs to the live tool. A shadowing tool does not inherit the shadowed
    // entry's `present`/`toModelOutput`: its output shape may differ, and presentation/catalog
    // fallback belongs at the consumer boundary (built-in table), not on the stack.
    const metadata = getToolMetadata(top.tool);
    return {
      ...top,
      ...(metadata?.present ? { present: metadata.present } : {}),
      ...(metadata?.toModelOutput ? { toModelOutput: metadata.toModelOutput } : {}),
    };
  }

  /** Every live tool, in name order. */
  list(): ResolvedAgentTool[] {
    return [...this.stacks.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => this.resolve(name))
      .filter((entry): entry is ResolvedAgentTool => entry !== undefined);
  }

  /** Keep the stable tools record in sync with the live stack top. */
  private materialize(name: string): void {
    const live = this.resolve(name);
    if (!live) delete (this.tools as Record<string, unknown>)[name];
    else (this.tools as Record<string, unknown>)[name] = live.tool;
  }
}

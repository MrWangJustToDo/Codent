/**
 * The session-level frames that are NOT transcript: `plan`, `current_mode_update`, `usage_update`,
 * `session_info_update` (title) and `available_commands_update`.
 *
 * Each carries a snapshot of the whole value rather than a delta, and every channel here re-delivers
 * its retained value when a projector (re)subscribes — so the mirrors in this class are what keeps
 * "one retained delivery plus one seed" from becoming two identical frames, while still letting a
 * genuine change through.
 */

import { findBuiltinCommand } from "@codent/core";

import type { SessionUpdate, AcpCommands, PlanEntry } from "../wire/types.js";
import type { AgentSessionSnapshot } from "@codent/core";

export interface SessionStateProjectionDeps {
  publish: (update: SessionUpdate) => void;
  /** Command catalog to advertise; recomputed on the `extensions` channel. */
  commands: () => AcpCommands;
  /** A child's own conversation title is the parent's roster label; do not overwrite it with `name`. */
  suppressTitle?: boolean;
}

export class SessionStateProjection {
  private priorTitle: string | undefined;
  private priorMode: string | undefined;
  /** Last advertised command list, so a retained `extensions` delivery plus a seed is one update. */
  private priorCommands: string | undefined;
  /** Last emitted plan/usage, so a retained delivery plus a seed does not duplicate them. */
  private priorPlan: string | undefined;
  private priorUsage: string | undefined;

  constructor(private readonly deps: SessionStateProjectionDeps) {}

  /**
   * Forget the mirrors for a (re)attachment.
   *
   * Dedupe state must not suppress the seed because the SOURCE conversation happened to have the
   * same plan/commands (a fork reuses this projector).
   */
  reset(): void {
    this.priorPlan = undefined;
    this.priorUsage = undefined;
    this.priorCommands = undefined;
    this.priorMode = undefined;
    this.priorTitle = undefined;
  }

  /** The non-transcript seed a session-creating response owes the client. */
  seed(snapshot: AgentSessionSnapshot): void {
    this.emitPlan(snapshot.todos);
    this.emitMode(snapshot.mode);
    this.emitUsage(snapshot.usage);
    this.emitTitle(snapshot.name);
    this.emitCommands();
  }

  emitPlan(items: AgentSessionSnapshot["todos"]): void {
    const entries: PlanEntry[] = items.map((todo) => ({
      content: todo.content,
      priority: todo.priority,
      status: todo.status,
    }));
    const signature = JSON.stringify(entries);
    if (signature === this.priorPlan) return;
    this.priorPlan = signature;
    this.deps.publish({ sessionUpdate: "plan", entries });
  }

  emitMode(mode: string): void {
    if (mode === this.priorMode) return;
    this.priorMode = mode;
    this.deps.publish({ sessionUpdate: "current_mode_update", currentModeId: mode });
  }

  emitUsage(usage: { contextFillTokens?: number; tokenLimit?: number; cost?: number } | undefined): void {
    if (!usage) return;
    const used = usage.contextFillTokens ?? 0;
    const size = usage.tokenLimit ?? 0;
    if (size <= 0) return;
    const signature = JSON.stringify([used, size, usage.cost ?? 0]);
    if (signature === this.priorUsage) return;
    this.priorUsage = signature;
    this.deps.publish({
      sessionUpdate: "usage_update",
      used,
      size,
      ...(usage.cost && usage.cost > 0 ? { cost: { amount: usage.cost, currency: "USD" } } : {}),
    });
  }

  emitTitle(name: string): void {
    if (this.deps.suppressTitle) return;
    if (!name || name === this.priorTitle) return;
    this.priorTitle = name;
    this.deps.publish({ sessionUpdate: "session_info_update", title: name });
  }

  emitCommands(): void {
    const { builtin, extension } = this.deps.commands();
    const seen = new Set<string>();
    const availableCommands: Array<{ name: string; description: string; input?: { hint: string } }> = [];
    for (const command of [...builtin, ...extension]) {
      if (seen.has(command.name)) continue;
      seen.add(command.name);
      // The catalog's `usage` IS the argument hint (`/compact [focus]` → `[focus]`): the protocol shows it
      // until the user types input, and core already declares it.
      const hint = findBuiltinCommand(command.name)
        ?.usage?.replace(/^\/[\w-]+/, "")
        .trim();
      availableCommands.push({
        name: command.name,
        description: command.description,
        ...(hint ? { input: { hint } } : {}),
      });
    }
    const signature = JSON.stringify(availableCommands);
    // A retained `extensions` delivery and the seed that follows it describe the same catalog;
    // sending it twice makes a client reset its command list for no reason.
    if (signature === this.priorCommands) return;
    this.priorCommands = signature;
    this.deps.publish({ sessionUpdate: "available_commands_update", availableCommands });
  }
}

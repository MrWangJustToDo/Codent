/**
 * The two per-name stacks of extension registrations (tools and commands).
 *
 * One rule decides who is live: **the highest dispatch rank owns the name**. Removing an owner
 * therefore never deletes a name another owner still holds — it re-reads the top, which is what
 * makes "disable one extension, restore what it shadowed" the same operation whether that owner was
 * on top or buried.
 *
 * Extracted from `ExtensionRunner` so the instance lifecycle (load / activate / toggle / destroy)
 * and this bookkeeping can be read independently. These classes are pure: they never notify the
 * host — the caller does, from the result (that is why `removeCommand` reports the new top).
 */

import { pickTopByRank } from "../dispatch-order.js";

import type { DispatchRank } from "../dispatch-order.js";
import type { ExtensionCommand, ExtensionToolDefinition } from "./types.js";

export interface ToolRegistration {
  ownerId: string;
  def: ExtensionToolDefinition;
  rank: DispatchRank;
}

export interface CommandRegistration {
  ownerId: string;
  cmd: ExtensionCommand;
  rank: DispatchRank;
}

export class ExtensionRegistrationStacks {
  private readonly tools = new Map<string, ToolRegistration[]>();
  private readonly commands = new Map<string, CommandRegistration[]>();

  // ==========================================================================
  // Tools
  // ==========================================================================

  /** Register (or replace this owner's entry for) a tool name. */
  registerTool(ownerId: string, def: ExtensionToolDefinition, rank: DispatchRank): void {
    const stack = this.tools.get(def.name);
    if (!stack) {
      this.tools.set(def.name, [{ ownerId, def, rank }]);
      return;
    }
    const own = stack.findIndex((entry) => entry.ownerId === ownerId);
    if (own === -1) stack.push({ ownerId, def, rank });
    else stack[own] = { ownerId, def, rank };
  }

  /** Drop one owner's entry for a name; the name disappears only when nobody else holds it. */
  removeTool(name: string, ownerId: string): void {
    const stack = this.tools.get(name);
    if (!stack) return;
    const remaining = stack.filter((entry) => entry.ownerId !== ownerId);
    if (remaining.length === 0) this.tools.delete(name);
    else this.tools.set(name, remaining);
  }

  /** The live definition for a name (highest rank), if any. */
  tool(name: string): ExtensionToolDefinition | undefined {
    const stack = this.tools.get(name);
    return stack && stack.length > 0 ? pickTopByRank(stack).def : undefined;
  }

  /** Every name's live definition — a mirror of what the host holds. */
  allTools(): ExtensionToolDefinition[] {
    return Array.from(this.tools.values(), (stack) => pickTopByRank(stack).def);
  }

  // ==========================================================================
  // Commands
  // ==========================================================================

  /**
   * Register (or replace this owner's entry for) a command name.
   *
   * Returns the owner that was live before this registration when it belongs to someone else — the
   * caller logs the shadowing warning (these classes never log).
   */
  registerCommand(ownerId: string, cmd: ExtensionCommand, rank: DispatchRank): string | undefined {
    const stack = this.commands.get(cmd.name);
    if (!stack) {
      this.commands.set(cmd.name, [{ ownerId, cmd, rank }]);
      return undefined;
    }
    const live = pickTopByRank(stack);
    const own = stack.findIndex((entry) => entry.ownerId === ownerId);
    if (own === -1) stack.push({ ownerId, cmd, rank });
    else stack[own] = { ownerId, cmd, rank };
    return live.ownerId === ownerId ? undefined : live.ownerId;
  }

  /**
   * Drop one owner's entry for a command name.
   *
   * `existed` is false when the name has no stack at all (nothing to report). `live` is the new top
   * after the removal — the caller notifies the host with it (undefined = the name is gone).
   */
  removeCommand(name: string, ownerId: string): { existed: boolean; live?: ExtensionCommand } {
    const stack = this.commands.get(name);
    if (!stack) return { existed: false };
    const remaining = stack.filter((entry) => entry.ownerId !== ownerId);
    if (remaining.length === 0) {
      this.commands.delete(name);
      return { existed: true };
    }
    this.commands.set(name, remaining);
    return { existed: true, live: pickTopByRank(remaining).cmd };
  }

  /** The live command for a name (highest rank). */
  liveCommand(name: string): ExtensionCommand | undefined {
    const stack = this.commands.get(name);
    return stack && stack.length > 0 ? pickTopByRank(stack).cmd : undefined;
  }

  /** The live owner of a name, or undefined when nobody holds it. */
  commandOwner(name: string): string | undefined {
    const stack = this.commands.get(name);
    return stack && stack.length > 0 ? pickTopByRank(stack).ownerId : undefined;
  }

  /** This owner's own definition for a name (not the live one) — `/extensions` describes claims. */
  ownerCommand(name: string, ownerId: string): ExtensionCommand | undefined {
    return this.commands.get(name)?.find((entry) => entry.ownerId === ownerId)?.cmd;
  }

  /** Every name's live command. */
  allCommands(): ExtensionCommand[] {
    return Array.from(this.commands.values(), (stack) => pickTopByRank(stack).cmd);
  }

  /** Drop every registration (full teardown). */
  clear(): void {
    this.tools.clear();
    this.commands.clear();
  }
}

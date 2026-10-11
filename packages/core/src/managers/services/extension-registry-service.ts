/**
 * ExtensionRegistryService — the agent's extension / tool / integration
 * registration domain, extracted from ManagedAgent's "Tools / registries /
 * extensions" block.
 *
 * Owns: set-once integration managers (todo / MCP / skills), the extension
 * runner + loader pair, the in-memory extension command map, and the dynamic
 * tools provider used for approval checks. Tool registration mutates the
 * agent's live `tools` record in place (runners cache its identity), so the
 * caller passes the record plus invalidation callbacks per call.
 */

import { compareDispatchRank, DEFAULT_EXTENSION_ORDER, INCUMBENT_RANK } from "../../agent/extension/dispatch-order.js";
import { forgetToolPresentationOwner } from "../../agent/tools/presentation/registry.js";
import { defineServerTool } from "../../agent/tools/runtime/define-tool.js";
import { toModelOutputRegistry } from "../../agent/tools/runtime/to-model-output-registry.js";
import { withTimeoutAbort } from "../../agent/tools/util/abort-timeout.js";

import type {
  ExtensionCommand,
  ExtensionLoader,
  ExtensionRunner,
  ExtensionToolDefinition,
} from "../../agent/extension";
import type { DispatchRank } from "../../agent/extension/dispatch-order.js";
import type { McpManager } from "../../agent/mcp/manager.js";
import type { SkillRegistry } from "../../agent/skills";
import type { TodoManager } from "../../agent/todo";
import type { ToolsRecord } from "../../agent/tools/runtime/tools-record.js";

/** Callbacks the caller (ManagedAgent) supplies for tool registration. */
export interface ExtensionToolRegistrationContext {
  /** The agent's live tools record — mutated in place, identity is stable. */
  tools: ToolsRecord;
  /**
   * Id of the extension registering the tool — the ledger key.
   *
   * Enables last-in-first-out restoration: when an extension is disabled, only the
   * entry IT displaced is popped, so an earlier extension that was overwritten by it
   * survives (and a built-in underneath both comes back once the last one goes).
   */
  ownerId: string;
  /** Structured warn sink (agent log). */
  warn: (message: string) => void;
  /**
   * The registering extension's dispatch rank. When a tool name is shadowed the stack's live
   * entry is the **highest** rank (the resolution reading of dispatch order), so an extension's
   * declared `order` decides which definition wins rather than load order.
   *
   * Optional: a direct (non-runner) registration gets a fresh default position (order 0, a
   * monotonic sequence), so it beats the seeded incumbent and a later one still wins.
   */
  rank?: DispatchRank;
  /** Called after the tools record changes so cached runners re-resolve. */
  onToolsChanged: () => void;
  /**
   * Owning agent id, used as a fallback when the run context supplies none.
   *
   * `ToolExecuteCtx.agentId` (from `ToolRunContext`) is the preferred source: it is set per
   * run by the runner, so it describes the run actually executing — which is what a tool
   * keying per-agent resources must use, since the same tool set serves the root and its
   * subagents. This field only covers hosts that register tools without a run context.
   */
  agentId?: string;
}

/** Who owns the entry that was already in the record before any extension registered. */
const INCUMBENT_TOOL_OWNER = "(incumbent)";

/** A stack of tool entries per name — bottom is what was there before, top is live. */
type ToolStack = Map<string, Array<{ ownerId: string; tool: unknown; rank: DispatchRank }>>;

export class ExtensionRegistryService {
  // Set-once integration managers
  private todo: TodoManager | null = null;
  private mcp: McpManager | null = null;
  private skills: SkillRegistry | null = null;

  // Extension runtime
  private runner: ExtensionRunner | null = null;
  private loader: ExtensionLoader | null = null;
  /** Commands registered via ExtensionContext (merged with runner commands on read). */
  private readonly commands = new Map<string, ExtensionCommand>();

  /** Dynamic tools provider (defaults to the agent's tools record). */
  private managedToolsProvider?: () => ToolsRecord;

  /**
   * Per-tool stacks of live registrations (see {@link ToolStack}).
   *
   * An entry stores its OWN tool, never a pointer to what it covered, so removing one owner's
   * entries and re-reading the top is all that "restore" ever needs.
   */
  private readonly toolStacks: ToolStack = new Map();
  /**
   * Monotonic sequence for a registration that carries no rank (a direct, non-runner call).
   * Gives each such registration a distinct position so a later one still supersedes an earlier
   * one — the insertion-order behaviour that existed before ranks, preserved for callers that
   * declare nothing.
   */
  private registrationSeq = 0;

  // ---------------------------------------------------------------------------
  // Integration managers (set-once)
  // ---------------------------------------------------------------------------

  setTodoManager(t: TodoManager): void {
    if (this.todo) return;
    this.todo = t;
  }

  getTodoManager(): TodoManager | null {
    return this.todo;
  }

  setMcpManager(m: McpManager): void {
    if (this.mcp) return;
    this.mcp = m;
  }

  getMcpManager(): McpManager | null {
    return this.mcp;
  }

  setSkillRegistry(t: SkillRegistry): void {
    if (this.skills) return;
    this.skills = t;
  }

  getSkillRegistry(): SkillRegistry | null {
    return this.skills;
  }

  // ---------------------------------------------------------------------------
  // Extension runner / loader
  // ---------------------------------------------------------------------------

  setExtensionRunner(runner: ExtensionRunner): void {
    this.runner = runner;
  }

  getExtensionRunner(): ExtensionRunner | null {
    return this.runner;
  }

  setExtensionLoader(loader: ExtensionLoader): void {
    this.loader = loader;
  }

  getExtensionLoader(): ExtensionLoader | null {
    return this.loader;
  }

  // ---------------------------------------------------------------------------
  // Extension commands
  // ---------------------------------------------------------------------------

  registerCommand(cmd: ExtensionCommand, warn: (message: string) => void): void {
    if (this.commands.has(cmd.name)) {
      warn(`Command "/${cmd.name}" already registered, overwriting`);
    }
    this.commands.set(cmd.name, cmd);
  }

  /** Unregister a command previously added by an extension (used when disabling). */
  unregisterExtensionCommand(name: string): void {
    this.commands.delete(name);
  }

  /** Runner-registered commands win; in-memory commands are the fallback. */
  getExtensionCommands(): ExtensionCommand[] {
    if (this.runner) {
      return this.runner.getCommands();
    }
    return Array.from(this.commands.values());
  }

  // ---------------------------------------------------------------------------
  // Extension tools
  // ---------------------------------------------------------------------------
  registerTool(def: ExtensionToolDefinition, ctx: ExtensionToolRegistrationContext): void {
    const existing = (ctx.tools as Record<string, unknown>)[def.name];
    if (existing) {
      ctx.warn(`Tool "${def.name}" already registered, overwriting`);
    }
    // The incumbent becomes the bottom of the stack the first time an extension shadows this
    // name. It has to be captured HERE and only here: the tools record is the only holder of
    // the previous tool (nothing keeps a built-in base copy), so a stack that starts empty
    // would have nothing to fall back to when the last extension is disabled.
    if (!this.toolStacks.has(def.name)) {
      // The incumbent loses to every extension; `INCUMBENT_RANK` is -Infinity so even an
      // extreme negative `order` overrides a base tool rather than being buried by it.
      this.toolStacks.set(def.name, [{ ownerId: INCUMBENT_TOOL_OWNER, tool: existing, rank: INCUMBENT_RANK }]);
    }

    const serverTool = defineServerTool({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      outputSchema: def.outputSchema,
      lazy: def.lazy,
      needsApproval: def.needsApproval,
      execute: async (args, toolCtx) => {
        const run = (deadlineSignal: AbortSignal | undefined) =>
          def.execute(args, {
            toolCallId: toolCtx.toolCallId,
            // `abortSignal` stays the RUN signal for classification; the deadline-linked signal is
            // handed over separately so a timeout is never misread as a user cancel.
            abortSignal: toolCtx.abortSignal,
            deadlineSignal,
            // Fallback ONLY. `defineServerTool` already resolves the id from the run context
            // (`ToolRunContext.agentId`, set per run by the runner), and that value describes
            // the run actually executing while this one merely records which agent the tool was
            // registered on. Keep the run's value when present.
            agentId: toolCtx.agentId ?? ctx.agentId,
          });
        if (def.timeoutMs === undefined) return run(undefined);
        // One deadline implementation across tool sources (see `withTimeoutAbort`): a timeout is a
        // typed `ExecutionError("timeout")`, not a plain `Error`, and a run abort still wins.
        return withTimeoutAbort((signal) => run(signal), {
          timeoutMs: def.timeoutMs,
          signal: toolCtx.abortSignal,
          timeoutMessage: `Tool "${def.name}" timed out after ${def.timeoutMs}ms`,
        });
      },
      present: def.present,
      toModelOutput: def.toModelOutput,
      // The handler belongs to the registering extension, not to the tool name, so disabling
      // the extension can drop it and expose the shadowed tool's own shaping again.
      ownerId: ctx.ownerId,
    });

    // The stack entry carries the tool itself and its rank, so nothing has to remember what it
    // covered and the live entry is derivable from the ranks alone. A caller that supplies no rank
    // (a direct registration, not through the runner) gets a fresh default position, which both
    // out-ranks the seeded incumbent and keeps "later registration wins" for the unranked case.
    const rank = ctx.rank ?? { order: DEFAULT_EXTENSION_ORDER, seq: ++this.registrationSeq };
    this.stackOf(def.name).push({ ownerId: ctx.ownerId, tool: serverTool, rank });
    (ctx.tools as Record<string, unknown>)[def.name] = this.liveTool(def.name);
    ctx.onToolsChanged();
  }

  /**
   * The live tool for a name: the entry with the highest dispatch rank.
   * Reading the top of the sorted sequence rather than the last push is what makes a declared
   * `order` authoritative over load order — a later-loaded extension with a *lower* order is
   * overridden by an earlier one, and vice versa.
   */
  private liveTool(name: string): unknown {
    const stack = this.toolStacks.get(name);
    if (!stack || stack.length === 0) return undefined;
    return stack.reduce((top, entry) => (compareDispatchRank(entry.rank, top.rank) > 0 ? entry : top)).tool;
  }

  /**
   * Drop one owner's registrations for a tool, and re-derive what is live.
   *
   * One operation for every case, because a stack has no ownership bookkeeping to get wrong:
   * remove this owner's entries and the top of what remains is live. That is the same whether
   * the owner was on top (an extension being disabled with the name to itself) or buried under
   * a newer extension (a handover, where the top is untouched and only this claim goes away).
   *
   * Both the tool stack and the model-output stack are filtered by the same owner, so a tool and
   * its result shaping can never be restored to different owners — the mismatch a
   * displacement-record design produced when an entry was removed out of order.
   */
  removeToolOwner(name: string, ownerId: string, ctx: ExtensionToolRegistrationContext): void {
    const stack = this.toolStacks.get(name);
    if (!stack) return;

    const remaining = stack.filter((entry) => entry.ownerId !== ownerId);
    // The runner calls this once per registration, so an owner that registered the name twice
    // reaches here a second time with nothing left to drop. Bail out instead of re-writing the
    // same tool and re-emitting — a no-op must stay a no-op.
    if (remaining.length === stack.length) return;

    // Re-derive from the ranks, not from the last entry: removing a middle owner can promote
    // whichever entry now has the highest rank, which is not necessarily the tail.
    const sorted = [...remaining].sort((a, b) => compareDispatchRank(a.rank, b.rank));
    const top = sorted[sorted.length - 1];

    if (!top || top.tool === undefined) {
      // Nothing left to fall back to: the name goes away.
      delete (ctx.tools as Record<string, unknown>)[name];
      this.toolStacks.delete(name);
    } else {
      (ctx.tools as Record<string, unknown>)[name] = top.tool;
      this.toolStacks.set(name, remaining);
    }

    // Drop only THIS owner's descriptor. Clearing the whole entry would take a still-live
    // owner's descriptor with it — a handover (an older extension released while a newer one
    // holds the name) left the surviving tool described by the fallback table, or by nothing at
    // all when it is not a built-in, which drops its rows out of the compact view.
    forgetToolPresentationOwner(name, ownerId);
    toModelOutputRegistry.removeOwner(name, ownerId);
    ctx.onToolsChanged();
  }

  private stackOf(name: string): Array<{ ownerId: string; tool: unknown; rank: DispatchRank }> {
    const stack = this.toolStacks.get(name);
    if (!stack) throw new Error(`tool stack for "${name}" must be seeded before pushing`);
    return stack;
  }

  /**
   * Unregister a tool previously added by an extension (used when disabling).
   *
   * Delegates to {@link removeToolOwner}, which is the one operation for every case: drop this
   * owner's entries for the name and re-read the top. Whether the owner was on top (an extension
   * with the name to itself) or buried under a newer one (a handover, where the top is untouched
   * and only this claim goes away) is not a distinction the caller has to make or can get wrong.
   *
   * Both the tool stack and the two per-owner artifacts are filtered by the same owner, so a tool
   * and its descriptor / result shaping can never be restored to different owners — the mismatch a
   * displacement-record design produced when an entry was removed out of order.
   */
  unregisterExtensionTool(name: string, ctx: ExtensionToolRegistrationContext): void {
    this.removeToolOwner(name, ctx.ownerId, ctx);
  }

  // ---------------------------------------------------------------------------
  // Dynamic tools provider
  // ---------------------------------------------------------------------------

  setManagedToolsProvider(provider: () => ToolsRecord): void {
    this.managedToolsProvider = provider;
  }

  getManagedToolsProvider(): (() => ToolsRecord) | undefined {
    return this.managedToolsProvider;
  }
}

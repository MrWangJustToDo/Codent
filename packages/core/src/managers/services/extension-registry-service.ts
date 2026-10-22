/**
 * ExtensionRegistryService — extension lifecycle plus the agent's registration domain.
 *
 * Extension tools are delegated to {@link AgentToolService}; this service owns extension
 * runner/loader, commands, and registration lifecycle. Integration managers (todo, MCP, skills)
 * belong to the owning agent.
 */

import { AgentToolService } from "./agent-tool-service.js";

import type {
  ExtensionCommand,
  ExtensionLoader,
  ExtensionRunner,
  ExtensionToolDefinition,
} from "../../agent/extension";
import type { DispatchRank } from "../../agent/extension/dispatch-order.js";
import type { ToolsRecord } from "../../agent/tools/catalog/tool-set.js";

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
   */
  rank?: DispatchRank;
  /** Called after the tools record changes so cached runners re-resolve. */
  onToolsChanged: () => void;
  /** Owning agent id, used as a fallback when the run context supplies none. */
  agentId?: string;
}

export class ExtensionRegistryService {
  // Extension runtime
  private runner: ExtensionRunner | null = null;
  private loader: ExtensionLoader | null = null;
  /** Commands registered via ExtensionContext (merged with runner commands on read). */
  private readonly commands = new Map<string, ExtensionCommand>();
  /** Tool ownership/resolution lives here; this service only carries extension lifecycle. */
  private readonly tools: AgentToolService;

  constructor(tools: AgentToolService | ToolsRecord = {}) {
    this.tools = tools instanceof AgentToolService ? tools : new AgentToolService(tools);
  }

  /** The unified tool service owned by this agent. */
  getToolService(): AgentToolService {
    return this.tools;
  }

  /** Dynamic tools provider (defaults to the agent's tools record). */
  private managedToolsProvider?: () => ToolsRecord;

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

  /** Register an extension tool through the agent's unified tool service. */
  registerTool(def: ExtensionToolDefinition, ctx: ExtensionToolRegistrationContext): void {
    this.tools.useTools(ctx.tools);
    this.tools.register(def, {
      ownerId: ctx.ownerId,
      ...(ctx.rank ? { rank: ctx.rank } : {}),
      warn: ctx.warn,
      onToolsChanged: ctx.onToolsChanged,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    });
  }

  /** Remove one owner's tool claims; the tool service restores the next ranked entry. */
  removeToolOwner(name: string, ownerId: string, ctx: ExtensionToolRegistrationContext): void {
    this.tools.useTools(ctx.tools);
    this.tools.unregisterOwner(name, ownerId, { ownerId, onToolsChanged: ctx.onToolsChanged });
  }

  /** Unregister a tool previously added by an extension (used when disabling). */
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

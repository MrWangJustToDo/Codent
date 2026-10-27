/**
 * Per-agent tool service — creation/registration lifecycle on top of {@link AgentToolRegistry}.
 *
 * The registry is the only owner of the live tool record and dispatch stacks. This service
 * creates extension tools, wires owner/rank, and publishes the catalog; it deliberately holds no
 * environment, runner, or UI state.
 */

import { normalizeModelToolContent } from "../../agent/compaction/tool-compact/parse-tool-message.js";
import { getBuiltinToolPresentation } from "../../agent/tools/presentation/builtin.js";
import { describeToolPresentations } from "../../agent/tools/presentation/describe.js";
import { defineServerTool } from "../../agent/tools/runtime/define-tool.js";
import { AgentToolRegistry, type ResolvedAgentTool } from "../../agent/tools/runtime/tool-registry.js";
import { withTimeoutAbort } from "../../agent/tools/shared/abort-timeout.js";

import type { DispatchRank } from "../../agent/dispatch-order.js";
import type { ExtensionToolDefinition } from "../../agent/extension";
import type { ExtensionContext } from "../../agent/extension/types.js";
import type { ToolsRecord } from "../../agent/tools/catalog/tool-set.js";
import type { ToolPresentationInfo } from "../../agent/tools/presentation/types.js";
import type { ToModelOutputDecorator, ToModelOutputFn } from "../../agent/tools/runtime/contract.js";

export interface AgentToolRegistrationContext {
  /** Owner of this registration (extension id or agent-scoped id). */
  ownerId: string;
  rank?: DispatchRank;
  /** Structured warn sink; supplied by the owning agent. */
  warn?: (message: string) => void;
  /** Called after the live tools record changes. */
  onToolsChanged?: () => void;
  /** Fallback agent id for tools that register outside a run context. */
  agentId?: string;
  /**
   * The registering extension's live context, resolved per call. Extension tools receive it as their
   * third `execute` argument so they can reach `ctx.llm`, the run signal and the conversation.
   */
  getExtensionContext?: () => ExtensionContext | undefined;
}

export class AgentToolService {
  private registry: AgentToolRegistry;
  private readonly decorators = new Map<string, Array<{ ownerId: string; fn: ToModelOutputDecorator }>>();

  constructor(tools: ToolsRecord = {}) {
    this.registry = new AgentToolRegistry(tools);
    this.seed(tools);
  }

  /**
   * Bind the live record. Its identity is stable for the lifetime of an agent; replacing it after
   * tools have been registered would discard extension stacks and owner/rank information.
   */
  useTools(tools: ToolsRecord): ToolsRecord {
    if (this.registry.getToolsRecord() !== tools) {
      if (this.registry.hasOwnerClaims()) {
        throw new Error("AgentToolService tools record cannot be replaced after extension tools register");
      }
      this.registry = new AgentToolRegistry(tools);
    }
    this.seed(tools);
    return this.registry.getToolsRecord();
  }

  getToolsRecord(): ToolsRecord {
    return this.registry.getToolsRecord();
  }

  resolve(name: string): ResolvedAgentTool | undefined {
    const entry = this.registry.resolve(name);
    if (!entry) return undefined;
    const decorators = this.decorators.get(name);
    if (!decorators || decorators.length === 0) return entry;
    // A tool with no handler of its own still runs the decorator chain: the base is the identity
    // (the same JSON normalization the framework applies), not "skip the decorator". Without this,
    // `registerToolOutputDecorator` silently did nothing for client tools and third-party tools.
    let chain: ToModelOutputFn = entry.toModelOutput ?? ((ctx) => normalizeModelToolContent(ctx.output));
    for (const decorator of decorators) {
      const prev = chain;
      chain = async (ctx) => decorator.fn(ctx, prev);
    }
    return { ...entry, toModelOutput: chain };
  }

  /** Register an agent-scoped model-output decorator; the returned disposer removes only it. */
  registerDecorator(toolName: string, fn: ToModelOutputDecorator, ownerId: string): () => void {
    const entry = { ownerId, fn };
    const list = this.decorators.get(toolName) ?? [];
    list.push(entry);
    this.decorators.set(toolName, list);
    return () => {
      const current = this.decorators.get(toolName);
      if (!current) return;
      const index = current.indexOf(entry);
      if (index < 0) return;
      current.splice(index, 1);
      if (current.length === 0) this.decorators.delete(toolName);
    };
  }

  /** Remove every decorator registered by an owner. */
  removeDecoratorOwner(ownerId: string): void {
    for (const [toolName, entries] of this.decorators) {
      const remaining = entries.filter((entry) => entry.ownerId !== ownerId);
      if (remaining.length === 0) this.decorators.delete(toolName);
      else this.decorators.set(toolName, remaining);
    }
  }

  list(): ResolvedAgentTool[] {
    return this.registry.list();
  }

  catalog(): ToolPresentationInfo[] {
    return describeToolPresentations(
      this.registry.list().map((entry) => entry.name),
      (name) => this.resolve(name)?.present ?? getBuiltinToolPresentation(name)
    );
  }

  /** Create and register an extension tool under its owner. */
  register(def: ExtensionToolDefinition, ctx: AgentToolRegistrationContext): void {
    const existing = (this.getToolsRecord() as Record<string, unknown>)[def.name];
    if (existing) ctx.warn?.(`Tool "${def.name}" already registered, overwriting`);

    const serverTool = defineServerTool({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      outputSchema: def.outputSchema,
      lazy: def.lazy,
      needsApproval: def.needsApproval,
      execute: async (args, toolCtx) => {
        const run = (deadlineSignal: AbortSignal | undefined) =>
          def.execute(
            args,
            {
              toolCallId: toolCtx.toolCallId,
              abortSignal: toolCtx.abortSignal,
              deadlineSignal,
              agentId: toolCtx.agentId ?? ctx.agentId,
            },
            ctx.getExtensionContext?.()
          );
        if (def.timeoutMs === undefined) return run(undefined);
        return withTimeoutAbort((signal) => run(signal), {
          timeoutMs: def.timeoutMs,
          signal: toolCtx.abortSignal,
          timeoutMessage: `Tool "${def.name}" timed out after ${def.timeoutMs}ms`,
        });
      },
      present: def.present,
      toModelOutput: def.toModelOutput,
    });

    this.registry.register(def.name, serverTool, ctx.ownerId, ctx.rank);
    ctx.onToolsChanged?.();
  }

  /** Remove one owner's claim over a tool and restore the next ranked entry. */
  unregisterOwner(
    name: string,
    ownerId: string,
    ctx: Omit<AgentToolRegistrationContext, "rank"> = { ownerId }
  ): boolean {
    if (!this.registry.unregisterOwner(name, ownerId)) return false;
    ctx.onToolsChanged?.();
    return true;
  }

  private seed(tools: ToolsRecord): void {
    for (const [name, tool] of Object.entries(tools)) this.registry.seed(name, tool);
  }
}

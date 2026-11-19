/**
 * Tool facet: registry reads, presentation, model-output shaping and owner-scoped decorators.
 *
 * `AgentToolService` owns the registry; this facet is the agent-facing view so `ManagedAgent` does
 * not carry the resolution rules (which entry wins, when the built-in fallback applies, when a
 * decorator invalidates the compact cache).
 */

import { resolveApprovalRequirement } from "../agent/approval/approval-requirement.js";
import { CLIENT_TOOL_NAMES } from "../agent/tools/catalog/tool-names.js";
import { getToolMetadata } from "../agent/tools/runtime/define-tool.js";

import type { AgentToolService } from "./services/agent-tool-service.js";
import type { ApprovalRequirement } from "../agent/approval/approval-requirement.js";
import type { ToolCompactCache } from "../agent/compaction/tool-compact/tool-compact-cache.js";
import type { ToolsRecord } from "../agent/tools/catalog/tool-set.js";
import type { ToolPresentation } from "../agent/tools/presentation/types.js";
import type { ToModelOutputFn } from "../agent/tools/runtime/contract.js";

export interface ToolFacetHost {
  getToolService(): AgentToolService;
  getTools(): ToolsRecord;
  getToolCompactCache(): ToolCompactCache;
  /** The live record can be filled before the service sees it (host fallback). */
  getManagedTools(): ToolsRecord;
}

export class ToolFacet {
  constructor(private readonly host: ToolFacetHost) {}

  getApprovalRequirement(toolName: string): ApprovalRequirement | undefined {
    return this.host.getToolService().getApprovalRequirement(toolName);
  }

  isToolNeedsApproval(toolName: string): boolean {
    const requirement = this.host.getToolService().getApprovalRequirement(toolName);
    if (requirement) return requirement.requiresApproval;
    const tool = this.host.getManagedTools()[toolName];
    return tool != null && resolveApprovalRequirement(tool).requiresApproval;
  }

  getToolModelOutput(toolName: string): ToModelOutputFn | undefined {
    const service = this.host.getToolService();
    const tools = this.host.getTools();
    service.useTools(tools);
    // The registry is authoritative: it already returns the LIVE entry's `toModelOutput`. A record
    // fallback here could only fire when the registry resolved a DIFFERENT object than the record,
    // which is exactly the divergence that applying a foreign tool's handler would mask.
    return service.resolve(toolName)?.toModelOutput;
  }

  /**
   * Exact identity check: is the LIVE implementation under this name the seeded built-in?
   *
   * This is the predicate policy decisions must use (task pre-fork, plan-mode `run_command`,
   * `modifiedArgs` refusal after an approval was decided on the original input). Unlike
   * {@link isBuiltinTool} it does NOT answer `true` for an unregistered name — a shadowing extension
   * tool must read as "not the built-in" even while the built-in's historical row is still rendered.
   */
  isIncumbentTool(toolName: string): boolean {
    const service = this.host.getToolService();
    service.useTools(this.host.getTools());
    return service.isIncumbent(toolName);
  }

  isBuiltinTool(toolName: string): boolean {
    const service = this.host.getToolService();
    service.useTools(this.host.getTools());
    // Two questions, and this one is the RENDERING contract: "may a built-in-only renderer handle
    // this row?". A name nothing is registered under must answer `true` — the app's
    // `isBuiltinTool` documents "true when we cannot tell", and the remote publisher's
    // `origin !== "extension"` says the same. Answering `false` for a historical row whose tool was
    // unregistered (an extension disabled, a code-mode tool on a restored session) made the local
    // and remote renderings disagree.
    //
    // Identity checks that must be exact (task pre-fork, plan-mode `run_command`) deliberately do
    // NOT use this predicate; they ask the registry's `isIncumbent` through the run deps.
    return service.isIncumbent(toolName) || !service.resolve(toolName);
  }

  /**
   * Whether a HOST answers this tool (a client tool) rather than the server.
   *
   * Inside the client-tool name gate, the live descriptor's `clientSide` is the answer — so an
   * extension's SERVER tool that shadows `ask_user` is not driven as a host-answered call (the pump
   * would otherwise park on a question nobody asked, and `addToolResult` would accept a host result
   * for a server call). A name nothing is registered under answers from the static table, which is
   * the embedder-injected client tool boundary.
   */
  isClientTool(toolName: string): boolean {
    // Only a name in the static client set can be a host-answered call. Returning early for every
    // other name keeps this predicate cheap — it runs per tool part on every status/interaction scan.
    if (!CLIENT_TOOL_NAMES.has(toolName)) return false;
    const service = this.host.getToolService();
    service.useTools(this.host.getTools());
    // A name NOTHING is registered under is the embedder boundary: the static table answers.
    // A registered tool answers by identity — its own `clientSide`, plus the built-in table only
    // when it IS the incumbent — so an extension's server tool that shadows `ask_user` (and declares
    // no `present`) is NOT read as a host-answered call.
    if (!service.resolve(toolName)) return true;
    return service.resolvePresentation(toolName)?.clientSide === true;
  }

  getToolPresentation(toolName: string): ToolPresentation | undefined {
    const service = this.host.getToolService();
    const tools = this.host.getTools();
    service.useTools(tools);
    // One rule lives in the service; the metadata fallback covers a host record the registry has
    // not seeded yet.
    return service.resolvePresentation(toolName) ?? getToolMetadata(tools[toolName])?.present;
  }

  registerToolOutputDecorator(
    toolName: string,
    fn: Parameters<AgentToolService["registerDecorator"]>[1],
    ownerId: string,
    options?: { followIncumbent?: boolean }
  ): () => void {
    const dispose = this.host.getToolService().registerDecorator(toolName, fn, ownerId, options);
    this.host.getToolCompactCache().clear();
    return () => {
      dispose();
      this.host.getToolCompactCache().clear();
    };
  }

  removeToolOutputDecoratorOwner(ownerId: string): void {
    this.host.getToolService().removeDecoratorOwner(ownerId);
    this.host.getToolCompactCache().clear();
  }

  getToolPresentationCatalog() {
    const service = this.host.getToolService();
    service.useTools(this.host.getTools());
    return service.catalog();
  }
}

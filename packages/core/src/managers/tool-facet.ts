/**
 * Tool facet: registry reads, presentation, model-output shaping and owner-scoped decorators.
 *
 * `AgentToolService` owns the registry; this facet is the agent-facing view so `ManagedAgent` does
 * not carry the resolution rules (which entry wins, when the built-in fallback applies, when a
 * decorator invalidates the compact cache).
 */

import { resolveApprovalRequirement } from "../agent/approval/approval-requirement.js";
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
    return service.resolve(toolName)?.toModelOutput ?? getToolMetadata(tools[toolName])?.toModelOutput;
  }

  isBuiltinTool(toolName: string): boolean {
    const service = this.host.getToolService();
    service.useTools(this.host.getTools());
    return service.isIncumbent(toolName) || !service.resolve(toolName);
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
    ownerId: string
  ): () => void {
    const dispose = this.host.getToolService().registerDecorator(toolName, fn, ownerId);
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

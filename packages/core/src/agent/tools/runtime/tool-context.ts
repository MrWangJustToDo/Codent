/**
 * Runtime bindings a tool factory needs from its owning agent.
 *
 * Keeping this narrow is what lets tools be created against an agent instance without passing the
 * whole `ManagedAgent` (or its manager) into every factory.
 */

import type { ResolvedCoreEnv } from "../../../env";
import type { PlanModeController } from "../../plan/plan-mode-controller.js";
import type { TodoManager } from "../../todo";
import type { AgentToolConfig } from "../tool-config.js";
import type { CommandJobRegistry } from "../util/command-job-registry.js";

export interface AgentToolContext {
  agentId: string;
  parentId?: string;
  getSessionId(): string | undefined;
  getCommandJobRegistry(): CommandJobRegistry;
  getCoreEnv(): ResolvedCoreEnv;
  addPendingAbortController(controller: AbortController): void;
  removePendingAbortController(controller: AbortController): void;
  getWebsearchConfig(): AgentToolConfig["websearch"] | undefined;
  getPlanMode(): PlanModeController;
  getTodoManager(): TodoManager | null;
}

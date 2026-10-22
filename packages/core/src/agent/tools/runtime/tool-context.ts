/**
 * Runtime bindings a tool factory needs from its owning agent.
 *
 * Keeping this narrow is what lets tools be created against an agent instance without passing the
 * whole `ManagedAgent` (or its manager) into every factory.
 */

import type { AgentCommandPort } from "./command-service.js";
import type { ResolvedCoreEnv } from "../../../env";
import type { PlanModeController } from "../../plan/plan-mode-controller.js";
import type { TodoManager } from "../../todo";
import type { AgentToolConfig } from "../tool-config.js";

export interface AgentStreamSink {
  commandStdout(toolCallId: string, chunk: string): void;
  commandStderr(toolCallId: string, chunk: string): void;
  clearCommand(toolCallId: string): void;
  endCommand(toolCallId: string): void;
}

export interface AgentToolContext {
  agentId: string;
  parentId?: string;
  getSessionId(): string | undefined;
  getCommandService(): AgentCommandPort;
  getStreamSink(): AgentStreamSink;
  getCoreEnv(): ResolvedCoreEnv;
  addPendingAbortController(controller: AbortController): void;
  removePendingAbortController(controller: AbortController): void;
  getWebsearchConfig(): AgentToolConfig["websearch"] | undefined;
  getPlanMode(): PlanModeController;
  getTodoManager(): TodoManager | null;
}

import { buildSubagentSummaries } from "../agent/subagent/subagent-summaries.js";
import { describeToolPresentations } from "../agent/tools/presentation/describe.js";
/**
 * Project ManagedAgent → AgentSessionSnapshot (serializable, no live handles).
 */

import type { AgentSessionSnapshot } from "./types.js";
import type { ManagedAgent } from "../managers/managed-agent.js";

interface SubagentCatalog {
  getSubagents(parentId: string): ManagedAgent[];
}
export function readLocalAgentSessionSnapshot(
  managed: ManagedAgent,
  manager: SubagentCatalog | null | undefined
): AgentSessionSnapshot {
  const chat = managed.getChatController();
  const todos = managed.getTodoManager();
  return {
    agentId: managed.id,
    ...(managed.parentId ? { parentId: managed.parentId } : {}),
    name: managed.name,
    status: managed.getStatus(),
    ...(managed.getSessionData()?.id ? { activeSessionId: managed.getSessionData()!.id } : {}),
    error: managed.getError(),
    pendingApprovalCount: managed.getPendingApprovalCount(),
    ...(managed.getRetry() ? { retry: managed.getRetry() } : {}),
    mode: managed.getAgentMode(),
    lastStreamDurationMs: managed.getLastStreamDurationMs(),
    ...(managed.config?.model ? { model: managed.config.model } : {}),
    ...(managed.modelInfo ? { modelInfo: managed.modelInfo } : {}),
    ...(typeof managed.getReasoningEffort === "function" && managed.getReasoningEffort()
      ? { reasoningEffort: managed.getReasoningEffort() }
      : {}),
    messages: chat?.getMessages() ?? managed.getUI()?.getMessages() ?? [],
    queues: chat?.getQueuedMessages() ?? { steer: [], followUp: [] },
    usage: managed.usage.getChangeSnapshot(),
    todos: todos?.getItems() ?? [],
    todosTitle: todos?.getTitle() ?? null,
    plan: managed.getPlanModeState(),
    autoMode: managed.isAutoModeEnabled(),
    mcp: { servers: managed.getMcpManager()?.getServerStatuses() ?? [] },
    extensions: { extensions: managed.getExtensionRunner()?.getExtensionInfos() ?? [] },
    toolDescriptors:
      typeof managed.getToolPresentationCatalog === "function"
        ? managed.getToolPresentationCatalog()
        : describeToolPresentations(),
    interactions: managed.readInteractions(),
    iteration: managed.readIteration(),
    jobs: managed.readJobs(),
    subagents: buildSubagentSummaries(managed, manager),
  };
}

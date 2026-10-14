import { readTaskRunPhase } from "../agent/subagent/task-run-state.js";
import { describeToolPresentations } from "../agent/tools/presentation/registry.js";
/**
 * Project ManagedAgent → AgentSessionSnapshot (serializable, no live handles).
 */

import type { AgentSessionSnapshot, AgentSessionSubagentSummary } from "./types.js";
import type { ManagedAgent } from "../managers/managed-agent.js";

function subagentDescription(name: string | undefined): string | undefined {
  if (!name) return undefined;
  if (name.startsWith("subagent-")) {
    const rest = name.slice("subagent-".length).trim();
    return rest || undefined;
  }
  return name;
}

interface SubagentCatalog {
  getSubagents(parentId: string): ManagedAgent[];
}

export function buildSubagentSummaries(
  managed: ManagedAgent,
  manager: SubagentCatalog | null | undefined
): AgentSessionSubagentSummary[] {
  if (!manager) return [];
  // Includes internal workers (compaction / memory summarizers): the task
  // panel doubles as an observability surface for hidden agents.
  return manager.getSubagents(managed.id).map((child) => ({
    id: child.id,
    status: child.getStatus(),
    name: child.name,
    taskPhase: readTaskRunPhase(managed, child.parentTaskId),
    ...(subagentDescription(child.name) ? { description: subagentDescription(child.name) } : {}),
    ...(child.parentTaskId ? { parentTaskToolCallId: child.parentTaskId } : {}),
    usage: child.usage.getChangeSnapshot(),
  }));
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
    toolDescriptors: describeToolPresentations(),
    interactions: managed.readInteractions(),
    iteration: managed.readIteration(),
    subagents: buildSubagentSummaries(managed, manager),
  };
}

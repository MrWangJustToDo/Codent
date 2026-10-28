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
  // L1 is the retained `agent:state` projection of the same facts. Spreading it here means a new
  // L1 field reaches snapshot consumers without a second hand-maintained list; only the renames
  // and the session-specific extras are mapped below (L1 uses `null` where the snapshot uses
  // absence, and `sessionId` is `activeSessionId` here).
  const l1 = managed.getL1State();
  return {
    agentId: managed.id,
    ...(managed.parentId ? { parentId: managed.parentId } : {}),
    name: l1.name,
    status: l1.status,
    ...(l1.sessionId ? { activeSessionId: l1.sessionId } : {}),
    error: l1.error,
    pendingApprovalCount: l1.pendingApprovalCount,
    ...(l1.retry ? { retry: l1.retry } : {}),
    mode: managed.getAgentMode(),
    lastStreamDurationMs: l1.lastStreamDurationMs,
    lastFinishReason: l1.lastFinishReason,
    lastIteration: l1.lastIteration,
    ...(l1.model ? { model: l1.model } : {}),
    ...(l1.modelInfo ? { modelInfo: l1.modelInfo } : {}),
    ...(l1.reasoningEffort ? { reasoningEffort: l1.reasoningEffort } : {}),
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

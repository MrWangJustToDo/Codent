import type { AgentToolContext } from "../agent/tools/runtime/tool-context.js";
import type { ManagedAgent } from "../runtime-types/hosts.js";

/** Bind the tool runtime interface to one live agent. This is the manager-side adapter. */
export function createAgentToolContext(managed: ManagedAgent): AgentToolContext {
  return {
    agentId: managed.id,
    ...(managed.parentId ? { parentId: managed.parentId } : {}),
    getSessionId: () => managed.getSessionData()?.id,
    getCommandJobRegistry: () => managed.getCommandJobRegistry(),
    getStreamHub: () => managed.streamHub,
    getCoreEnv: () => managed.getCoreEnv(),
    addPendingAbortController: (controller) => managed.addPendingAbortController(controller),
    removePendingAbortController: (controller) => managed.removePendingAbortController(controller),
    getWebsearchConfig: () => managed.config?.toolConfig?.websearch,
    getPlanMode: () => managed.planMode,
    getTodoManager: () => managed.getTodoManager(),
  };
}

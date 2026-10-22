import type { AgentStreamSink, AgentToolContext } from "../agent/tools/runtime/tool-context.js";
import type { ManagedAgent } from "../runtime-types/hosts.js";

/** Bind the tool runtime interface to one live agent. This is the manager-side adapter. */
export function createAgentToolContext(managed: ManagedAgent): AgentToolContext {
  return {
    agentId: managed.id,
    ...(managed.parentId ? { parentId: managed.parentId } : {}),
    getSessionId: () => managed.getSessionData()?.id,
    getCommandService: () => managed.getCommandService(),
    getStreamSink: () =>
      ({
        commandStdout: (toolCallId, chunk) => managed.getStreamHub().appendCommand(toolCallId, "stdout", chunk),
        commandStderr: (toolCallId, chunk) => managed.getStreamHub().appendCommand(toolCallId, "stderr", chunk),
        clearCommand: (toolCallId) => managed.getStreamHub().clearCommand(toolCallId),
        endCommand: (toolCallId) => managed.getStreamHub().endCommand(toolCallId),
      }) satisfies AgentStreamSink,
    getCoreEnv: () => managed.getCoreEnv(),
    addPendingAbortController: (controller) => managed.addPendingAbortController(controller),
    removePendingAbortController: (controller) => managed.removePendingAbortController(controller),
    getWebsearchConfig: () => managed.config?.toolConfig?.websearch,
    getPlanMode: () => managed.planMode,
    getTodoManager: () => managed.getTodoManager(),
  };
}

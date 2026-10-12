import { formatAgentDocResult } from "../agent/prompt/agent-doc-loader.js";

import { emitAgentTelemetry } from "./telemetry/emit-agent-telemetry.js";

import type { ManagedAgent } from "./managed-agent.js";

export interface SessionBootstrapContext {
  cwd: string;
}

/**
 * Emit session bootstrap events after the agent is registered on {@link AgentManager}.
 * Reads loaded resources from the managed agent rather than duplicating bootstrap state.
 */
export async function emitSessionBootstrapEvents(
  managed: ManagedAgent,
  context: SessionBootstrapContext
): Promise<void> {
  const docContent = managed.getAgentDocContent();
  const docSource = managed.agentDocSource;

  if (docContent) {
    emitAgentTelemetry(managed, "session:doc", {
      source: docSource,
      length: docContent.length,
      message: formatAgentDocResult(
        {
          content: docContent,
          source: docSource || undefined,
          importNotices: [],
        },
        managed.getCoreEnv()
      ),
    });
  }

  const skillRegistry = managed.getSkillRegistry();
  if (skillRegistry) {
    emitAgentTelemetry(managed, "session:skill", {
      count: skillRegistry.size,
      names: skillRegistry.names(),
    });
  }

  const mcpManager = managed.getMcpManager();
  if (mcpManager) {
    const servers = mcpManager.getServerStatuses() ?? [];
    emitAgentTelemetry(managed, "session:mcp", {
      configPath: mcpManager.configPath,
      configLoadedFrom: mcpManager.configLoadedFrom,
      servers,
      toolCount: servers.reduce((sum, server) => sum + server.toolCount, 0),
    });
  }

  const memoryManager = managed.memory.getManager();
  if (memoryManager) {
    const memories = await memoryManager.listMemories();
    emitAgentTelemetry(managed, "session:memory", {
      memoryCount: memories.length,
      indexLength: memoryManager.getIndexContent().length,
    });
  }

  emitAgentTelemetry(managed, "session:start", { cwd: context.cwd });

  // Fire the interceptable per-agent session:start on the ExtensionEventBus.
  // Distinct from the unified-bus telemetry above (fire-and-forget, not interceptable).
  managed.getExtensionRunner()?.emitSessionStart(context.cwd, managed.id);
}

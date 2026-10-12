/**
 * Server-owned agent runtime.
 *
 * The server constructs one {@link CodentAgent} over its CoreEnv at bootstrap and
 * serves the whole `/api/agent/*` plane from that runtime's manager, instead of the
 * process-wide `agentManager` singleton. `CodentAgent` is imported dynamically so the
 * server's CoreEnv-only entry does not pull the agent runtime (and its TanStack types)
 * into the published bundle.
 */

import type { AgentManager, CoreEnv, ModelProvider } from "@codent/core";

let manager: AgentManager | null = null;

/** Build (or rebuild) the server runtime over its CoreEnv. */
export async function initServerRuntime(env: CoreEnv, provider?: ModelProvider): Promise<void> {
  const { CodentAgent } = await import("@codent/core");
  const agent = await CodentAgent.create({ env, ...(provider ? { provider } : {}), name: "server" });
  manager = agent.getManager() ?? null;
}

/** The server runtime's manager. Throws when `initServerRuntime` has not run. */
export function getServerManager(): AgentManager {
  if (!manager) throw new Error("Server runtime not initialized — call initServerRuntime() at bootstrap.");
  return manager;
}

/** Whether the server runtime has been initialized. */
export function hasServerRuntime(): boolean {
  return manager !== null;
}

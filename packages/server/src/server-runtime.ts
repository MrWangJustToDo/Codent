/**
 * Server-owned agent runtime.
 *
 * The server constructs one {@link CodentAgent} over its CoreEnv at bootstrap and
 * serves the whole `/api/agent/*` plane from that runtime's manager, instead of the
 * process-wide `agentManager` singleton. `CodentAgent` is imported dynamically so the
 * server's CoreEnv-only entry does not pull the agent runtime (and its TanStack types)
 * into the published bundle.
 *
 * The CoreEnv plane (`/api/env|fs|command|fetch`) reads `getServerEnv()` — the runtime's
 * resolved env — so both planes provably serve the SAME workspace. Reading the ambient
 * `getEnv()` instead would only *happen* to match (the server registers the same env at
 * bootstrap); sourcing from the runtime makes the single-env invariant a code fact.
 */

import type { AgentManager, CoreEnv, ModelProvider, ResolvedCoreEnv } from "@codent/core";

let manager: AgentManager | null = null;
let serverEnv: ResolvedCoreEnv | null = null;

/** Build (or rebuild) the server runtime over its CoreEnv. */
export async function initServerRuntime(env: CoreEnv, provider?: ModelProvider): Promise<void> {
  const { CodentAgent } = await import("@codent/core");
  const agent = await CodentAgent.create({ env, ...(provider ? { provider } : {}), name: "server" });
  manager = agent.getManager() ?? null;
  serverEnv = agent.getEnv();
}

/** The server runtime's manager. Throws when `initServerRuntime` has not run. */
export function getServerManager(): AgentManager {
  if (!manager) throw new Error("Server runtime not initialized — call initServerRuntime() at bootstrap.");
  return manager;
}

/** The server's effective workspace env (the one its agents run on). Throws before bootstrap. */
export function getServerEnv(): ResolvedCoreEnv {
  if (!serverEnv) throw new Error("Server runtime not initialized — call initServerRuntime() at bootstrap.");
  return serverEnv;
}

/** Whether the server runtime has been initialized. */
export function hasServerRuntime(): boolean {
  return manager !== null;
}

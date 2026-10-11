import type { CoreEnv } from "../../env";

// ============================================================================
// Tool run context (passed to chat({ context }) and tool execute functions)
// ============================================================================

/**
 * Runtime context for TanStack tool execution and middleware.
 * Forwarded via `chat({ context })` — tools receive it on {@link import("@tanstack/ai").ToolExecutionContext}.context`.
 */
export interface ToolRunContext {
  /** Managed agent id for this run */
  agentId: string;
  /** Workspace CoreEnv (filesystem, shell, fetch) of the runtime that owns this run */
  coreEnv: CoreEnv;
}

export function createToolRunContext(agentId: string, coreEnv: CoreEnv): ToolRunContext {
  return { agentId, coreEnv };
}

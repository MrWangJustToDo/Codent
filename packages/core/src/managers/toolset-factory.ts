/**
 * Base toolset assembly by agent profile.
 *
 * The factory used to build the full root toolset before checking `parentId`, then replace the
 * whole record in `spawnSubagent` — a subagent paid for every root tool only to discard it. This
 * is the one place the profile decides what gets built; caller-specific tools (the `task` tool
 * after skills bootstrap, a caller-supplied `subagentTools` override) are layered on afterwards.
 */

import { createCompletePlanTool, createCreatePlanTool, createUpdatePlanTool } from "../agent/plan/create-plan-tool.js";
import { createSubagentTools } from "../agent/subagent/subagent-tools.js";
import { createTodoTool } from "../agent/todo/todo-tool.js";
import { createTools, createWebfetchTool, createWebsearchTool } from "../agent/tools";
import { createAskUserTool } from "../agent/tools/ask-user-tool.js";

import { createAgentToolContext } from "./agent-tool-context.js";

import type { ToolsRecord } from "../agent/tools/runtime/tools-record.js";
import type { AgentToolsetProfile } from "../runtime-types/agent-profile.js";
import type { ManagedAgent } from "../runtime-types/hosts.js";

export type ToolsetProfile = AgentToolsetProfile;

export interface BuildToolsetOptions {
  profile: ToolsetProfile;
  managed: ManagedAgent;
}

export async function buildToolset({ profile, managed }: BuildToolsetOptions): Promise<ToolsRecord> {
  if (profile === "explore") {
    return createSubagentTools({ context: createAgentToolContext(managed), usage: managed.usage });
  }
  if (profile === "internal") {
    // Internal one-shot workers are caller-supplied (often `{}`); never pay for a root tool
    // build only to replace it in spawnSubagent.
    return {};
  }
  if (profile !== "root" && profile !== "general") {
    // Runtime guard for host-supplied ids: the union protects TypeScript callers, but a JS host
    // must never fall through to the root (writable) toolset.
    throw new Error(`Unsupported toolset profile: "${String(profile)}"`);
  }

  const context = createAgentToolContext(managed);
  const tools: ToolsRecord = { ...(await createTools({ usage: managed.usage, context })) };
  const todoManager = context.getTodoManager();
  if (profile !== "general" && todoManager) tools.todo = createTodoTool({ todoManager });
  tools.webfetch = createWebfetchTool({ context });
  tools.websearch = createWebsearchTool({ context });

  if (profile === "general") {
    // General is a writable child profile, but interactive/headless-incompatible tools stay out:
    // ask_user, plan/todo, and task (no unbounded recursion by default).
    return tools;
  }

  tools.ask_user = createAskUserTool();
  tools.create_plan = createCreatePlanTool({ getPlanMode: () => context.getPlanMode() });
  tools.update_plan = createUpdatePlanTool({ getPlanMode: () => context.getPlanMode() });
  tools.complete_plan = createCompletePlanTool({ getPlanMode: () => context.getPlanMode() });
  return tools;
}

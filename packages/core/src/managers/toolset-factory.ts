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

import type { ToolsRecord } from "../agent/tools/runtime/tools-record.js";
import type { ManagedAgent } from "../runtime-types/hosts.js";

export type ToolsetProfile = "root" | "subagent";

export interface BuildToolsetOptions {
  profile: ToolsetProfile;
  managed: ManagedAgent;
}

export async function buildToolset({ profile, managed }: BuildToolsetOptions): Promise<ToolsRecord> {
  if (profile === "subagent") {
    return createSubagentTools(managed);
  }

  const tools: ToolsRecord = { ...(await createTools({ usage: managed.usage, managed })) };
  const todoManager = managed.getTodoManager();
  if (todoManager) {
    tools.todo = createTodoTool({ todoManager });
    tools.webfetch = createWebfetchTool({ managed });
    tools.websearch = createWebsearchTool({ managed });
  }
  tools.ask_user = createAskUserTool();
  tools.create_plan = createCreatePlanTool({ getPlanMode: () => managed.planMode });
  tools.update_plan = createUpdatePlanTool({ getPlanMode: () => managed.planMode });
  tools.complete_plan = createCompletePlanTool({ getPlanMode: () => managed.planMode });
  return tools;
}

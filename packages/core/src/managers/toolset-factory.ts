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
import { BUILTIN_TOOL_NAMES, createTools, createWebfetchTool, createWebsearchTool } from "../agent/tools";
import { createAskUserTool } from "../agent/tools/builtin/interaction/ask-user-tool.js";

import { createAgentToolContext } from "./agent-tool-context.js";

import type { ToolsRecord } from "../agent/tools/catalog/tool-set.js";
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
  // Keys come from `BUILTIN_TOOL_NAMES`, never literals: the record key IS the wire name the
  // registry looks up for `present` / `toModelOutput`, and `create-base-tools` documents exactly
  // why a second literal lets a rename de-register a tool's descriptors silently. These are the
  // root-profile additions layered on top of the base table.
  const todoManager = context.getTodoManager();
  if (profile !== "general" && todoManager) {
    tools[BUILTIN_TOOL_NAMES.todo] = createTodoTool({ todoManager });
  }
  tools[BUILTIN_TOOL_NAMES.webfetch] = createWebfetchTool({ context });
  tools[BUILTIN_TOOL_NAMES.websearch] = createWebsearchTool({ context });

  if (profile === "general") {
    // General is a writable child profile, but interactive/headless-incompatible tools stay out:
    // ask_user, plan/todo, and task (no unbounded recursion by default).
    return tools;
  }

  tools[BUILTIN_TOOL_NAMES.askUser] = createAskUserTool();
  tools[BUILTIN_TOOL_NAMES.createPlan] = createCreatePlanTool({ getPlanMode: () => context.getPlanMode() });
  tools[BUILTIN_TOOL_NAMES.updatePlan] = createUpdatePlanTool({ getPlanMode: () => context.getPlanMode() });
  tools[BUILTIN_TOOL_NAMES.completePlan] = createCompletePlanTool({
    getPlanMode: () => context.getPlanMode(),
    // Through the coordinator so the phase-off transition is persisted, like `/mode done`.
    completePlan: () => managed.completePlan(),
  });
  return tools;
}

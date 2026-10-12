/**
 * Plan-mode helpers for {@link ManagedAgent} (workspace save/load + execution steer).
 */

import { listPlanFiles, loadPlanFile, savePlanFile } from "../agent/plan/plan-store.js";
import { isActiveStatus } from "../runtime-types/agent-status.js";

import type { ResolvedCoreEnv } from "../env";
import type { AgentStatus } from "./agent-types.js";
import type { AgentChatController } from "./controllers/agent-chat-controller.js";
import type {
  BeginPlanExecutionResult,
  PlanModeController,
  PlanModeState,
} from "../agent/plan/plan-mode-controller.js";

export interface PlanApiHost {
  planMode: PlanModeController;
  getStatus: () => AgentStatus;
  getChatController: () => AgentChatController | undefined;
  /** Owning runtime's env, so plan files land under the runtime root. */
  getCoreEnv: () => ResolvedCoreEnv;
}

export function enablePlanMode(host: PlanApiHost): void {
  host.planMode.enable();
}

export function disablePlanMode(host: PlanApiHost): void {
  host.planMode.disable();
}

export function getPlanModeState(host: PlanApiHost): PlanModeState {
  return host.planMode.getState();
}

export function beginPlanExecution(host: PlanApiHost, options: { sendSteer?: boolean } = {}): BeginPlanExecutionResult {
  const result = host.planMode.beginExecution();
  if (!result.ok || !result.steerMessage) return result;

  const queued = options.sendSteer !== false && host.getChatController() != null && isActiveStatus(host.getStatus());

  if (options.sendSteer !== false && host.getChatController()) {
    void host.getChatController()!.sendMessage(result.steerMessage);
  }

  return { ...result, queued };
}

export function cancelPlanExecution(host: PlanApiHost): boolean {
  return host.planMode.cancelExecution();
}

export async function savePlanToWorkspace(
  host: PlanApiHost,
  nameHint?: string
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const { planMarkdown, phase, planFilePath } = host.planMode.getState();
  if (!planMarkdown?.trim()) {
    return { ok: false, error: "No plan markdown to save — create a plan first" };
  }
  if (phase !== "ready" && phase !== "executing" && phase !== "planning" && phase !== "retro") {
    return { ok: false, error: `Cannot save plan from phase "${phase}"` };
  }
  try {
    const { path } = await savePlanFile(
      planMarkdown,
      nameHint,
      {
        existingRelativePath: nameHint?.trim() ? undefined : (planFilePath ?? undefined),
      },
      host.getCoreEnv()
    );
    host.planMode.setPlanFilePath(path);
    return { ok: true, path };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return { ok: false, error: err.message };
  }
}

export async function loadPlanFromWorkspace(
  host: PlanApiHost,
  name: string
): Promise<{ ok: boolean; path?: string; error?: string; stepCount?: number }> {
  try {
    const { path, markdown } = await loadPlanFile(name, host.getCoreEnv());
    const result = await host.planMode.loadPlanMarkdown(markdown, { relativePath: path });
    if (!result.ok) return { ok: false, error: result.error, path };
    return { ok: true, path, stepCount: result.stepCount };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return { ok: false, error: err.message };
  }
}

export function completePlan(host: PlanApiHost): { ok: boolean; error?: string } {
  return host.planMode.complete();
}

export async function listWorkspacePlans(host: PlanApiHost): Promise<string[]> {
  return listPlanFiles(host.getCoreEnv());
}

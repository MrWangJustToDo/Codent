/**
 * Plan-mode helpers for {@link ManagedAgent} (workspace save/load + execution steer).
 */

import { extractPlan } from "../agent/plan/extract-plan.js";
import { listPlanFiles, loadPlanFile, savePlanFile } from "../agent/plan/plan-store.js";
import { isActiveStatus } from "../runtime-types/agent-status.js";
import { toError } from "../utils/errors.js";

import type { ResolvedCoreEnv } from "../env";
import type { AgentStatus } from "./agent-types.js";
import type { AgentChatController } from "./controllers/agent-chat-controller.js";
import type { ModeCoordinator } from "./mode-coordinator.js";
import type {
  BeginPlanExecutionResult,
  PlanModeController,
  PlanModeState,
} from "../agent/plan/plan-mode-controller.js";

export interface PlanApiHost {
  planMode: PlanModeController;
  /** Plan/auto arbitration: the only writer that may leave `off` (auto must go off with it). */
  mode: ModeCoordinator;
  getStatus: () => AgentStatus;
  getChatController: () => AgentChatController | undefined;
  /** Owning runtime's env, so plan files land under the runtime root. */
  getCoreEnv: () => ResolvedCoreEnv;
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
    const err = toError(error);
    return { ok: false, error: err.message };
  }
}

export async function loadPlanFromWorkspace(
  host: PlanApiHost,
  name: string
): Promise<{ ok: boolean; path?: string; error?: string; stepCount?: number }> {
  try {
    const { path, markdown } = await loadPlanFile(name, host.getCoreEnv());
    // Validate BEFORE entering plan mode: a typo'd name or a file without a plan must leave the
    // session exactly as it was, not flip plan on and then back off (which would also drop auto).
    if (!extractPlan(markdown)) {
      return { ok: false, error: "File does not contain a ## Plan section with numbered steps", path };
    }
    // `/mode load` is an entry point as much as `/mode plan` is. Going through the coordinator is
    // what turns auto mode off, so the two can never be on at once (auto would bypass every
    // approval prompt during the read-only planning/review phases).
    const entering = host.planMode.getPhase() === "off";
    if (entering) host.mode.enablePlan();
    const result = await host.planMode.loadPlanMarkdown(markdown, { relativePath: path });
    if (!result.ok) {
      if (entering) host.mode.disablePlan();
      return { ok: false, error: result.error, path };
    }
    return { ok: true, path, stepCount: result.stepCount };
  } catch (error) {
    const err = toError(error);
    return { ok: false, error: err.message };
  }
}

export function completePlan(host: PlanApiHost): { ok: boolean; error?: string } {
  // Through the coordinator, not the controller: `planMode.complete()` exits the phase but cannot
  // persist it, so `/mode done` used to leave the stored phase stale (and, when entered by the old
  // bypass, left auto on afterwards).
  return host.mode.completePlan();
}

export async function listWorkspacePlans(host: PlanApiHost): Promise<string[]> {
  return listPlanFiles(host.getCoreEnv());
}

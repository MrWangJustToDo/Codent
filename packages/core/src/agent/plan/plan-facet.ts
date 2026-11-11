/**
 * Plan-mode helpers for {@link ManagedAgent} (workspace save/load + execution steer).
 */

import { isActiveStatus } from "../../runtime-types/agent-status.js";
import { toError } from "../../utils/errors.js";

import { extractPlan } from "./extract-plan.js";
import { listPlanFiles, loadPlanFile, savePlanFile } from "./plan-store.js";

import type { BeginPlanExecutionResult, PlanModeController, PlanModeState } from "./plan-mode-controller.js";
import type { ResolvedCoreEnv } from "../../env";
import type { AgentStatus } from "../../runtime-types/agent-status.js";
import type { ModeCoordinator } from "../mode/mode-coordinator.js";
import type { ModeState } from "../mode/mode-state.js";

export interface PlanApiHost {
  planMode: PlanModeController;
  /** Single mode read surface; this facade only ever READS the phase/artifact through it. */
  getModeState: () => ModeState;
  /** Plan/auto arbitration: the only writer that may leave `off` (auto must go off with it). */
  mode: ModeCoordinator;
  getStatus: () => AgentStatus;
  /** Narrow chat port: plan execution only sends a steer message. */
  getChatController: () => { sendMessage(content: string): Promise<unknown> } | undefined;
  /** Owning runtime's env, so plan files land under the runtime root. */
  getCoreEnv: () => ResolvedCoreEnv;
  /** Capture a staleness guard before a disk read that may outlive its session. */
  captureStaleness?: () => () => boolean;
}

export function getPlanModeState(host: PlanApiHost): PlanModeState {
  return host.getModeState().snapshot().plan;
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
  const { planMarkdown, phase, planFilePath } = host.getModeState().snapshot().plan;
  if (!planMarkdown?.trim()) {
    return { ok: false, error: "No plan markdown to save — create a plan first" };
  }
  if (phase !== "ready" && phase !== "executing" && phase !== "planning" && phase !== "retro") {
    return { ok: false, error: `Cannot save plan from phase "${phase}"` };
  }
  // `recordPlanFilePath` now publishes + persists, so the write must be verified against the session
  // it was started in: a `/resume` during the save would otherwise stamp the departure's plan path
  // onto the target and write it to disk.
  const isStale = host.captureStaleness?.();
  try {
    const { path } = await savePlanFile(
      planMarkdown,
      nameHint,
      {
        existingRelativePath: nameHint?.trim() ? undefined : (planFilePath ?? undefined),
      },
      host.getCoreEnv()
    );
    if (isStale?.() === true) {
      return { ok: false, error: "Session changed before the plan was saved" };
    }
    host.planMode.recordPlanFilePath(path);
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
    // The read is an await (an HTTP round-trip on a remote env); a switch inside it means the
    // entry below belongs to a session the user already left.
    const isStale = host.captureStaleness?.();
    const { path, markdown } = await loadPlanFile(name, host.getCoreEnv());
    if (isStale?.() === true) {
      return { ok: false, error: "Session changed before the plan was loaded" };
    }
    // Validate BEFORE entering plan mode: a typo'd name or a file without a plan must leave the
    // session exactly as it was, not flip plan on and then back off (which would also drop auto).
    if (!extractPlan(markdown)) {
      return { ok: false, error: "File does not contain a ## Plan section with numbered steps", path };
    }
    // `/mode load` is an entry point as much as `/mode plan` is. Going through the coordinator is
    // what turns auto mode off, so the two can never be on at once (auto would bypass every
    // approval prompt during the read-only planning/review phases).
    const entering = host.getModeState().snapshot().planPhase === "off";
    // Entering disables auto (the two are mutually exclusive). A failed load must put BOTH back:
    // the previous rollback only undid the phase, so a user in Auto who mistyped a plan name ended
    // in Normal mode with no message saying so.
    const wasAuto = host.getModeState().snapshot().auto;
    const rollbackEntry = (): void => {
      if (!entering) return;
      host.mode.disablePlan();
      if (wasAuto) host.mode.setAuto(true);
    };
    if (entering) host.mode.enablePlan();
    let result: Awaited<ReturnType<typeof host.planMode.loadPlanMarkdown>>;
    try {
      result = await host.planMode.loadPlanMarkdown(markdown, { relativePath: path });
    } catch (error) {
      rollbackEntry();
      throw error;
    }
    if (!result.ok) {
      rollbackEntry();
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

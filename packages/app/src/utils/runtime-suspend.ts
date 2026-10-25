/**
 * Host-initiated runtime suspend: the one state that separates "the UI is going away" from
 * "the session is going away".
 *
 * A host sometimes has to take the terminal from the UI without ending the conversation — today the
 * workspace browser's external-editor handoff, where the editor needs the raw terminal for as long as
 * the user is typing in it. `useAgentChat`'s mount effect builds a runtime and its unmount effect
 * disposes it, which is right for process exit and catastrophic for a handoff: the session (and any
 * run streaming through it) would die, and the mount that follows would build a second one.
 *
 * So the host says so explicitly. The flag is a single bit that survives the unmount because the
 * decision is made *during* React teardown, when nothing else is reachable:
 *
 *   beginRuntimeSuspend()   → host is about to unmount the UI for a handoff
 *   unmount cleanup         → resolveUnmountAction() says `preserve` (no unbind, no destroy)
 *   mount effect            → resolveMountAction() says `resume` (no destroy, no initialize)
 *   consumeRuntimeSuspend() → the bit is spent; every later mount/unmount behaves normally
 *
 * Consumption (rather than a plain clear in the cleanup) is what keeps a stale bit from ever
 * suppressing a real teardown: the mount that resumes is the only consumer, and any fresh
 * initialization spends the bit as well.
 */

let suspended = false;

/** Announce that the next UI unmount is a handoff: the runtime and its session must outlive it. */
export function beginRuntimeSuspend(): void {
  suspended = true;
}

/** Whether a host suspend is in flight (a handoff whose UI has not resumed yet). */
export function isRuntimeSuspended(): boolean {
  return suspended;
}

/**
 * Spend the suspend bit.
 *
 * @returns `true` when a suspend was in flight, i.e. this mount is the resume.
 */
export function consumeRuntimeSuspend(): boolean {
  const wasSuspended = suspended;
  suspended = false;
  return wasSuspended;
}

/** What the unmount cleanup has to do with the runtime. */
export type RuntimeUnmountAction = "release" | "preserve";

/**
 * `preserve` for a handoff, `release` otherwise. Named rather than inlined at the call site so the
 * rule can be asserted without mounting React — this is the seam that a mistake here would break
 * silently, and the only symptom would be a dead session after an editor session.
 */
export function resolveUnmountAction(state: { suspended: boolean }): RuntimeUnmountAction {
  return state.suspended ? "preserve" : "release";
}

/** What the mount effect has to do. */
export type RuntimeMountAction = "initialize" | "resume";

/**
 * `resume` only when a suspend is in flight *and* the session it preserved is still bound. A suspend
 * without a bound session has nothing to resume, so it initializes: keeping the UI dead would be a
 * worse failure than rebuilding the runtime.
 */
export function resolveMountAction(state: { suspended: boolean; hasSession: boolean }): RuntimeMountAction {
  return state.suspended && state.hasSession ? "resume" : "initialize";
}

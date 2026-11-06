/**
 * Agent state as explicit axes, with `AgentStatus` as a pure projection.
 *
 * The wire enum conflates four questions (is the agent alive? is a run in progress? is it waiting
 * on a human? how did the last run end?). These axes separate them so a paused run is not also
 * "terminal", and compaction is a run phase rather than a competing status.
 *
 * `AgentStatus` remains the host-facing value set; this module is the read model. The writers are
 * inverted onto `transition()` in the P4 wave.
 */

import type { AgentStatus } from "./agent-status.js";

export type LifecyclePhase = "created" | "bootstrapping" | "ready" | "busy" | "draining" | "destroyed";
export type RunPhase = "idle" | "preparing" | "streaming" | "tooling" | "compacting" | "finalizing";
export type WaitKind = "none" | "approval" | "question";
/** How the last run ended. `none` = no result yet (a fresh run clears it). */
export type RunOutcome = "none" | "completed" | "error" | "aborted";
/** Streaming detail inside `RunPhase.streaming` (the two host statuses that are not phases). */
export type StreamPhase = "none" | "thinking" | "responding";

export interface AgentState {
  lifecycle: LifecyclePhase;
  run: RunPhase;
  wait: WaitKind;
  outcome: RunOutcome;
  stream: StreamPhase;
  errorMessage?: string;
  /** Run phase to restore when a compaction lease ends. */
  resumeRun?: RunPhase;
  /**
   * Run outcome to restore when a compaction lease ends.
   *
   * The compaction owns `run`, so it must also own `outcome`: leaving a terminal `error`/`aborted`
   * in place made the projection report the fault instead of `compacting`, which silently disabled
   * the manual-compaction interlock (`shouldDeferMidRunQueue`) and made the lease's restore guard
   * (`getStatus() === "compacting"`) unreachable.
   */
  resumeOutcome?: RunOutcome;
  /** Streaming phase to restore when a compaction lease ends (thinking/responding/none). */
  resumeStream?: StreamPhase;
}

export type AgentTransitionEvent =
  | { type: "prepare" }
  | { type: "stream-chunk"; stream: "thinking" | "responding" | "tooling" }
  | { type: "stream-end"; result: "completed" | "error" | "aborted"; error?: string }
  /** Settle a turn from a state that has no live stream (client-tool resume, reconcile). */
  | { type: "settle"; result: "completed" | "error" | "aborted"; error?: string; clearWait?: boolean }
  /** A failure that did not come from a normal stream end (external error, apply-outcome). */
  | { type: "fail"; error: string }
  | { type: "pause"; wait: "approval" | "question" }
  | { type: "resume" }
  | { type: "interrupt"; error?: string }
  | { type: "compaction-start" }
  | { type: "compaction-end" }
  | { type: "reset" }
  | { type: "teardown" };

export type AgentStateEventType = AgentTransitionEvent["type"];

export const INITIAL_AGENT_STATE: AgentState = {
  lifecycle: "created",
  run: "idle",
  wait: "none",
  outcome: "none",
  stream: "none",
};

// ============================================================================
// Projection
// ============================================================================

/**
 * Project the axes onto the host-facing status.
 *
 * A pending question wins over a failed turn (the session still owns an unanswered prompt), while
 * an approval wait only wins over a *live* run: after an abort the run is over, not parked.
 */
export function projectAgentStatus(state: AgentState): AgentStatus {
  if (state.wait === "question") return "awaiting_user";

  if (state.outcome === "error") return "error";
  if (state.outcome === "aborted") return "aborted";

  if (state.wait === "approval") return "waiting";
  if (state.run === "compacting") return "compacting";

  if (state.run === "streaming") {
    if (state.stream === "thinking") return "thinking";
    if (state.stream === "responding") return "responding";
    return "running";
  }

  if (state.run === "preparing" || state.run === "tooling" || state.run === "finalizing") {
    return state.outcome === "completed" ? "completed" : "running";
  }

  if (state.outcome === "completed") return "completed";
  if (state.lifecycle === "busy") return "running";
  return "idle";
}

/** Terminal = the last run failed or was aborted. `completed` is a settled result, not a fault. */
export function isTerminalState(state: AgentState): boolean {
  return state.outcome === "error" || state.outcome === "aborted";
}

/** Active = a run is in flight or the session is parked on a human. */
export function isActiveState(state: AgentState): boolean {
  return state.wait !== "none" || (state.lifecycle === "busy" && state.outcome === "none");
}

// ============================================================================
// Transition table
// ============================================================================

export interface TransitionOptions {
  /** Throw on an illegal event (default). Production passes `false` + `onReject`. */
  strict?: boolean;
  /** Record a rejected event without changing state. */
  onReject?: (reason: string, event: AgentTransitionEvent) => void;
}

class IllegalTransition extends Error {}

function reject(reason: string, event: AgentTransitionEvent, options: TransitionOptions): never {
  if (options.strict !== false) throw new IllegalTransition(`${reason} (event: ${event.type})`);
  options.onReject?.(reason, event);
  throw new IllegalTransition(reason);
}

/**
 * Apply one closed-set event. Returns the next state, or the same state when rejected in
 * non-strict mode (the rejection is reported through `onReject`, never by corrupting state).
 */
export function transition(
  state: AgentState,
  event: AgentTransitionEvent,
  options: TransitionOptions = {}
): AgentState {
  try {
    return applyTransition(state, event, options);
  } catch (error) {
    if (error instanceof IllegalTransition && options.strict === false) return state;
    throw error;
  }
}

function applyTransition(state: AgentState, event: AgentTransitionEvent, options: TransitionOptions): AgentState {
  if (state.lifecycle === "destroyed" && event.type !== "teardown") {
    reject("destroyed agent cannot transition", event, options);
  }

  switch (event.type) {
    case "prepare":
      // A compaction owns the run phase; starting a chat/pump beside it would silently discard
      // the lease's resume phase.
      if (state.run === "compacting") reject("prepare requires no active compaction", event, options);
      return {
        lifecycle: "busy",
        run: "preparing",
        wait: "none",
        outcome: "none",
        stream: "none",
      };

    case "stream-chunk":
      // A chunk is the only stream signal: it promotes from `preparing` (or `idle`, for a retry
      // that resumes mid-stream) instead of rejecting. `stream-start` used to exist for this and
      // was never dispatched, so it was removed rather than left as a misleading edge.
      if (event.stream === "tooling") {
        return { ...state, lifecycle: "busy", run: "tooling", stream: "none" };
      }
      return { ...state, lifecycle: "busy", run: "streaming", stream: event.stream };

    case "stream-end":
      if (state.lifecycle !== "busy" || state.run === "idle") {
        reject(`stream-end requires a busy run, got ${state.lifecycle}/${state.run}`, event, options);
      }
      // A finish during a compaction does not steal the phase: the lease restores it in its own
      // `finally`, and the result is applied when the run phase comes back.
      if (state.run === "compacting") {
        return {
          ...state,
          outcome: event.result,
          stream: "none",
          ...(event.error !== undefined ? { errorMessage: event.error } : {}),
        };
      }
      return {
        ...state,
        run: "finalizing",
        outcome: event.result,
        stream: "none",
        ...(event.error !== undefined ? { errorMessage: event.error } : {}),
      };

    case "settle":
      // A settle during compaction records the result without stealing the phase (the lease
      // applies it on `compaction-end`).
      if (state.run === "compacting") {
        return {
          ...state,
          outcome: event.result,
          stream: "none",
          ...(event.clearWait ? { wait: "none" } : {}),
          ...(event.error !== undefined ? { errorMessage: event.error } : {}),
        };
      }
      return {
        ...state,
        run: "finalizing",
        outcome: event.result,
        stream: "none",
        ...(event.clearWait ? { wait: "none" } : {}),
        ...(event.error !== undefined ? { errorMessage: event.error } : {}),
      };

    case "fail":
      // A compaction lease owns `run`; a failure from inside it must record the outcome and let
      // `compaction-end` apply it, exactly like `settle`/`stream-end`. Stealing the phase here made
      // the lease's restore guard unreachable (`run !== "compacting"`), while the lease could still
      // apply its checkpoint.
      if (state.run === "compacting") {
        return {
          ...state,
          outcome: "error",
          stream: "none",
          errorMessage: event.error,
          ...(state.wait === "approval" ? { wait: "none" as const } : {}),
        };
      }
      return {
        ...state,
        lifecycle: "ready",
        run: "finalizing",
        // An approval gate belongs to the run that asked for it; the run is over. A pending
        // `ask_user` question is kept — the session still owns the unanswered prompt.
        ...(state.wait === "approval" ? { wait: "none" as const } : {}),
        outcome: "error",
        stream: "none",
        errorMessage: event.error,
        resumeRun: undefined,
        resumeOutcome: undefined,
      };

    case "pause":
      // A wait cannot be established while compaction owns the run: the restore guard is the
      // compaction lease, and a wait would change the projection out from under it.
      if (state.run === "compacting") reject("pause requires no active compaction", event, options);
      if (state.lifecycle !== "busy" && state.lifecycle !== "ready") {
        reject(`pause requires a live agent, got ${state.lifecycle}`, event, options);
      }
      // An APPROVAL wait belongs to the run that asked for it. A late `onToolPhaseComplete` (a retry,
      // a pump unwinding after an abort) used to pause a turn that had already settled: the
      // projection kept reporting error/aborted while `isActiveState` became true forever. A QUESTION
      // is deliberately exempt — an unanswered `ask_user` outlives a failed run and must keep the
      // session parked on the user (`syncPendingQuestionWait`).
      if (event.wait === "approval" && (state.outcome === "error" || state.outcome === "aborted")) {
        reject(`pause requires a live run, got outcome ${state.outcome}`, event, options);
      }
      return { ...state, lifecycle: "busy", wait: event.wait };

    case "resume":
      if (state.wait === "none") reject("resume requires a pending wait", event, options);
      return { ...state, wait: "none" };

    case "interrupt":
      return {
        ...state,
        run: "finalizing",
        // Same rule as `fail`: an approval wait dies with the run it gated; a question is still
        // the user's to answer, and the projection keeps reporting `awaiting_user` for it.
        ...(state.wait === "approval" ? { wait: "none" as const } : {}),
        outcome: "aborted",
        stream: "none",
        ...(event.error !== undefined ? { errorMessage: event.error } : {}),
        resumeRun: undefined,
        resumeOutcome: undefined,
      };

    case "compaction-start":
      if (state.run === "compacting") reject("compaction already owns the run", event, options);
      if (state.wait !== "none") reject("compaction requires no pending wait", event, options);
      return {
        ...state,
        lifecycle: "busy",
        resumeRun: state.run === "idle" ? undefined : state.run,
        resumeOutcome: state.outcome,
        // The phase is not only `run`: a compaction started mid-stream used to come back as
        // plain `running`, losing "thinking"/"responding" until the next chunk (and forever if the
        // model finished right after the summary).
        resumeStream: state.run === "streaming" ? state.stream : undefined,
        run: "compacting",
        // The lease owns the run, so it also owns the outcome: a compaction started from `error` /
        // `aborted` must project `compacting` (the interlock and the lease's restore guard both read
        // the status). The previous outcome comes back in `compaction-end`.
        outcome: "none",
        stream: "none",
      };

    case "compaction-end": {
      if (state.run !== "compacting") reject(`compaction-end requires compacting, got ${state.run}`, event, options);
      // A finish that landed while the compaction owned the phase is applied now; otherwise the
      // phase and outcome the compaction interrupted resume.
      if (state.outcome !== "none") {
        return {
          ...state,
          run: "finalizing",
          stream: "none",
          resumeRun: undefined,
          resumeOutcome: undefined,
          resumeStream: undefined,
        };
      }
      const run = state.resumeRun ?? "idle";
      return {
        ...state,
        // `idle` is only reachable with `lifecycle: "ready"` — leaving the compaction's `busy` here
        // projected an idle axis set as `running` (no run exists to clear it).
        lifecycle: run === "idle" ? "ready" : "busy",
        run,
        outcome: state.resumeOutcome ?? "none",
        stream: run === "streaming" ? (state.resumeStream ?? "none") : "none",
        resumeRun: undefined,
        resumeOutcome: undefined,
        resumeStream: undefined,
      };
    }

    case "reset":
      return { lifecycle: "ready", run: "idle", wait: "none", outcome: "none", stream: "none" };

    case "teardown":
      return { lifecycle: "destroyed", run: "idle", wait: "none", outcome: "none", stream: "none" };
  }
}

// ============================================================================
// Adapter: current AgentStatus → axes
// ============================================================================

/**
 * Read the axes for an agent whose writers still own `AgentStatus`.
 *
 * This is the P4 adapter: the projection (`projectAgentStatus`) round-trips every existing status,
 * so the snapshot can expose the axes before the writer inversion. Delete it when `setStatus`
 * becomes `transition()`.
 */
export function deriveAgentState(status: AgentStatus, errorMessage = ""): AgentState {
  const base = { lifecycle: "ready" as LifecyclePhase, run: "idle" as RunPhase, wait: "none" as WaitKind };
  switch (status) {
    case "running":
      return { ...base, lifecycle: "busy", run: "streaming", outcome: "none", stream: "none" };
    case "thinking":
      return { ...base, lifecycle: "busy", run: "streaming", outcome: "none", stream: "thinking" };
    case "responding":
      return { ...base, lifecycle: "busy", run: "streaming", outcome: "none", stream: "responding" };
    case "waiting":
      return { ...base, lifecycle: "busy", run: "streaming", outcome: "none", stream: "none", wait: "approval" };
    case "awaiting_user":
      return { ...base, lifecycle: "busy", run: "idle", outcome: "none", stream: "none", wait: "question" };
    case "compacting":
      return { ...base, lifecycle: "busy", run: "compacting", outcome: "none", stream: "none" };
    case "completed":
      return { ...base, outcome: "completed", stream: "none" };
    case "error":
      return { ...base, outcome: "error", stream: "none", ...(errorMessage ? { errorMessage } : {}) };
    case "aborted":
      return { ...base, outcome: "aborted", stream: "none" };
    case "idle":
      return { ...base, outcome: "none", stream: "none" };
  }
}

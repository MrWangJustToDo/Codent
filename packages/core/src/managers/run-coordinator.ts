import { isAbortError as matchesAbortError } from "../runtime-types/abort.js";

import type { MultimodalPartType } from "../models/adapter/capability-message-utils.js";

export interface AbortControllerSetup {
  onAborted: () => void;
}

/**
 * Currency marker for the active pump/run. Captured at pump entry; invalidated
 * when the run is interrupted or superseded. Replaces numeric generation
 * counters: "am I still current?" is an object identity check, so a forgotten
 * check site is a visible API omission rather than a comment-only invariant.
 */
export interface RunToken {
  readonly id: number;
  get isCurrent(): boolean;
}

interface RunTokenState {
  readonly id: number;
  valid: boolean;
}

/**
 * Run-scoped state: abort controllers + run-lifecycle flags/timing (continuation
 * mark, turn-finalize guard, stream timing, run id). The reactive-compact retry
 * budget lives on {@link CompactionService}; cross-service orchestration belongs
 * on {@link ManagedAgent}.
 */
export class RunCoordinator {
  currentAbortController: AbortController | null = null;
  cancelAbortController: () => void = () => {};
  pendingAbortControllers: AbortController[] = [];
  private externalAbortListener: ((event: Event) => void) | null = null;
  private externalAbortSignal: AbortSignal | null = null;

  setupAbortController(abortSignal: AbortSignal | undefined, setup: AbortControllerSetup): void {
    this.cancelAbortController();
    this.currentAbortController = new AbortController();

    const abortListener = () => setup.onAborted();
    this.currentAbortController.signal.addEventListener("abort", abortListener, { once: true });
    this.cancelAbortController = () => {
      this.currentAbortController?.signal.removeEventListener("abort", abortListener);
      if (this.externalAbortSignal && this.externalAbortListener) {
        this.externalAbortSignal.removeEventListener("abort", this.externalAbortListener);
      }
      this.externalAbortSignal = null;
      this.externalAbortListener = null;
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        let item = this.pendingAbortControllers.pop();
        while (item) {
          item.abort(abortSignal.reason);
          item = this.pendingAbortControllers.pop();
        }
        setTimeout(() => this.currentAbortController?.abort(abortSignal.reason));
      } else {
        // The listener's argument is the abort **Event**, not the reason — forwarding it as
        // one (the old signature read `(reason: Event)`) put an Event object on the internal
        // signals' `signal.reason`, so every downstream consumer that classifies a string
        // reason (`resolveSubagentStopReason`) saw a non-string and lost the cause. Read the
        // reason off the signal instead, which is where `abort(reason)` actually puts it.
        const listener = () => {
          const reason = abortSignal.reason;
          let item = this.pendingAbortControllers.pop();
          while (item) {
            item.abort(reason);
            item = this.pendingAbortControllers.pop();
          }
          setTimeout(() => this.currentAbortController?.abort(reason));
        };
        abortSignal.addEventListener("abort", listener);
        this.externalAbortSignal = abortSignal;
        this.externalAbortListener = listener;
      }
    }
  }

  addPendingAbortController(abortController: AbortController): void {
    this.pendingAbortControllers.push(abortController);
  }

  removePendingAbortController(abortController: AbortController): void {
    this.pendingAbortControllers = this.pendingAbortControllers.filter((ac) => ac !== abortController);
  }

  /**
   * Abort the active controller and any pending tool controllers, carrying the reason.
   *
   * Passing a string reason through matters beyond bookkeeping: it lands on
   * `signal.reason`, which is how a child subagent tells a user cancel (`"user-cancelled"`)
   * apart from its parent's run being reset (`"(no reason)"` / undefined). A bare
   * `AbortController.abort()` produces an `AbortError` with no reason, and that used to be
   * reported downstream as a user cancellation.
   */
  abort(reason?: unknown): void {
    const effective = typeof reason === "string" && reason.length > 0 ? reason : undefined;
    let pending = this.pendingAbortControllers.pop();
    while (pending) {
      pending.abort(effective);
      pending = this.pendingAbortControllers.pop();
    }
    this.currentAbortController?.abort(effective);
  }

  isAbortError(err: unknown): boolean {
    return matchesAbortError(err, this.currentAbortController?.signal);
  }

  // ==========================================================================
  // Run token (currency of the active pump/run)
  // ==========================================================================

  private currentRunToken: RunTokenState | null = null;
  private runTokenSeq = 0;

  /**
   * Begin a new run/pump: invalidates any previous token (supersede) and
   * returns the token the pump must check via `token.isCurrent` before
   * touching outcome/finalize state.
   */
  beginRun(): RunToken {
    if (this.currentRunToken) this.currentRunToken.valid = false;
    const state: RunTokenState = { id: ++this.runTokenSeq, valid: true };
    this.currentRunToken = state;
    return {
      id: state.id,
      get isCurrent() {
        return state.valid;
      },
    };
  }

  /** Invalidate the current run token (interrupt / force-submit / abort path). */
  invalidateCurrentRun(): void {
    if (this.currentRunToken) this.currentRunToken.valid = false;
  }

  /** Whether the latest begun run is still current (no interrupt/supersede since). */
  isCurrentRunValid(): boolean {
    return this.currentRunToken?.valid ?? false;
  }

  // ==========================================================================
  // Run lifecycle flags + timing (moved from ManagedAgent — run-scoped state)
  // ==========================================================================

  /** When true, next prepareForRun skips memory prefetch / prompt:submit (steer / tool continue). */
  private prepareAsContinuation = false;
  /** Guards turn-level finalizeRun so stop() + pump outcome do not double-fire. */
  private turnLifecycleFinalized = false;
  private streamStartedAt = 0;
  private lastStreamDurationMs = 0;
  private currentRunId: string | null = null;

  markNextPrepareAsContinuation(): void {
    this.prepareAsContinuation = true;
  }

  /** Clear a leftover continuation mark (e.g. on turn finalize). */
  clearPrepareAsContinuation(): void {
    this.prepareAsContinuation = false;
  }

  /** Consume and clear the continuation flag for prepareForRun. */
  consumePrepareAsContinuation(): boolean {
    const value = this.prepareAsContinuation;
    this.prepareAsContinuation = false;
    return value;
  }

  /** Call at the start of a chat pump or detached run so finalize can run once for that turn. */
  resetTurnLifecycle(): void {
    this.turnLifecycleFinalized = false;
  }

  /** Claim turn finalization. @returns false when already finalized for this turn. */
  beginTurnFinalize(): boolean {
    if (this.turnLifecycleFinalized) return false;
    this.turnLifecycleFinalized = true;
    return true;
  }

  getStreamStartedAt(): number {
    return this.streamStartedAt;
  }

  setStreamStartedAt(value: number): void {
    this.streamStartedAt = value;
  }

  getLastStreamDurationMs(): number {
    return this.lastStreamDurationMs;
  }

  /** Snapshot wall-clock duration for the current turn into lastStreamDurationMs. */
  recordStreamDuration(): void {
    if (this.streamStartedAt <= 0) return;
    this.lastStreamDurationMs = Math.max(0, Date.now() - this.streamStartedAt);
  }

  /** Clear the previous session's completed-run duration before adopting a new transcript. */
  resetLastStreamDuration(): void {
    this.lastStreamDurationMs = 0;
    this.streamStartedAt = 0;
  }

  /** Track the active run id for log run-scoping (see RunLifecycleHost). */
  setCurrentRunId(runId: string | null): void {
    this.currentRunId = runId;
  }

  getCurrentRunId(): string | null {
    return this.currentRunId;
  }

  resetRunState(): void {
    this.abort();
    this.pendingAbortControllers = [];
    this.cancelAbortController();
    this.currentAbortController = null;
    this.maxOutputTokensOverride = undefined;
  }

  /**
   * Per-run output-token ceiling. A `max_tokens` truncation raises it for the recovery
   * streams of THAT run only; writing it onto the cached `AgentRunner` (whose config outlives
   * the run) raised the cap for every later turn in the process, which an endpoint with a
   * lower real ceiling rejects. Cleared when the next run is prepared.
   */
  private maxOutputTokensOverride?: number;

  getMaxOutputTokensOverride(): number | undefined {
    return this.maxOutputTokensOverride;
  }

  setMaxOutputTokensOverride(max: number | undefined): void {
    this.maxOutputTokensOverride = max;
  }

  resetMaxOutputTokensOverride(): void {
    this.maxOutputTokensOverride = undefined;
  }

  // ==========================================================================
  // Per-run wire override (content the model must see that is NOT in the channel)
  // ==========================================================================

  /**
   * Two pieces of per-run wire state that must survive the channel projection:
   *
   * - `wireDropPartTypes` — multimodal part types this model cannot accept (the
   *   pre-send capability strip, or the wider strip of a post-rejection retry).
   * - `wireContinuationArmed` — append the `max_tokens` continuation prompt as a
   *   synthetic user turn.
   *
   * Why this lives on the run instead of on the messages handed to the engine:
   * `compaction` rebuilds every wire call from `channel.getMessages()` and discards
   * the incoming `config.messages`, so a strip or an appended prompt applied there
   * reaches the first call only and is silently overwritten on every later one. The
   * `wire-recovery` middleware runs after that projection and applies this state.
   *
   * Both fields are wire-only: the channel (and therefore the persisted session and
   * the UI) keeps the original media parts.
   */
  private wireDropPartTypes: Set<MultimodalPartType> | null = null;
  private wireContinuationArmed = false;

  getWireDropPartTypes(): Set<MultimodalPartType> | null {
    return this.wireDropPartTypes;
  }

  setWireDropPartTypes(drop: Set<MultimodalPartType> | null): void {
    this.wireDropPartTypes = drop;
  }

  isWireContinuationArmed(): boolean {
    return this.wireContinuationArmed;
  }

  setWireContinuationArmed(armed: boolean): void {
    this.wireContinuationArmed = armed;
  }

  /**
   * Clear both overrides. Called once per run, before the first wire build, so
   * recovery state from a previous turn can never leak into the next one.
   */
  resetWireOverride(): void {
    this.wireDropPartTypes = null;
    this.wireContinuationArmed = false;
  }
}

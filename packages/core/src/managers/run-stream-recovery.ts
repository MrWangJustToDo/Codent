import { assertAsyncIterable } from "../agent/stream/assert-async-iterable.js";
import { readRetryAfterMs, runErrorFromChunk } from "../agent/stream/stream-errors.js";
import { discardRegisteredPrefork } from "../agent/subagent/task-prefork.js";
import { toError } from "../utils/errors.js";

import { armCapabilityStrip, tryCapabilitySanitizeRetry } from "./stream-recovery/capability-sanitize.js";
import {
  createTruncationState,
  handleMaxTokensTruncation,
  readTruncationProgress,
} from "./stream-recovery/max-tokens-continue.js";
import { tryReactiveCompactRetry } from "./stream-recovery/reactive-compact-retry.js";
import { extractRetryAfterSeconds, isTransientRetryableError } from "./stream-recovery/transient-retry.js";

import type { AgentManager } from "./agent-manager.js";
import type { ManagedAgent } from "./managed-agent.js";
import type { AgentRunner } from "../agent/runner/agent-runner.js";
import type { AgentRetryStrategy, AgentRetryState } from "../runtime-types/agent-retry.js";
import type { ModelMessage, StreamChunk, UIMessage } from "@tanstack/ai";

export { armCapabilityStrip, tryCapabilitySanitizeRetry } from "./stream-recovery/capability-sanitize.js";
export { tryReactiveCompactRetry } from "./stream-recovery/reactive-compact-retry.js";
export {
  extractRetryAfterSeconds,
  extractRetryAfterMs,
  isTransientRetryableError,
} from "./stream-recovery/transient-retry.js";
export {
  CONTINUATION_PROMPT,
  ESCALATED_MAX_TOKENS,
  MAX_TRUNCATION_CONTINUATIONS,
  handleMaxTokensTruncation,
  readTruncationProgress,
} from "./stream-recovery/max-tokens-continue.js";

// ============================================================================
// Constants
// ============================================================================

/** Max bytes for backoff delay calculation. */
const MAX_RETRY_BACKOFF_MS = 32000;
/** Base delay for exponential backoff (kept high enough that attempt gaps are perceptible). */
const BASE_RETRY_DELAY_MS = 2000;
/**
 * Max number of *error* recovery attempts (reactive compact, multimodal strip,
 * transient backoff). Output-truncation continuations keep their own budget
 * (`MAX_TRUNCATION_CONTINUATIONS` + 1) and do not consume this one — see
 * `handleMaxTokensTruncation().countsAsRecoveryAttempt`.
 */
const MAX_RECOVERY_ATTEMPTS = 3;

// ============================================================================
// Helpers
// ============================================================================

function errorFromUnknown(error: unknown): Error {
  return toError(error);
}

/**
 * Exponential backoff with jitter.
 *
 * delay = min(BASE_RETRY_DELAY_MS × 2^attempt, MAX_RETRY_BACKOFF_MS) + random(0~25%)
 * If a `retryAfter` value is provided (from Retry-After header), use it directly.
 */
export function retryDelayMs(attempt: number, retryAfter?: number): number {
  if (retryAfter != null && retryAfter > 0) return retryAfter * 1000;
  const base = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_BACKOFF_MS);
  return base + Math.random() * base * 0.25;
}

// ============================================================================
// Recovery helpers
// ============================================================================

interface RecoveryResult {
  multimodalStripAttempted: boolean;
  /** Which recovery strategy matched — drives UI retry visibility. */
  strategy: AgentRetryStrategy;
  /** Prefer provider Retry-After when present (seconds). */
  retryAfterSeconds?: number;
}

interface AttemptRecoveryOptions {
  managed: ManagedAgent;
  manager: AgentManager;
  getMessages: () => Array<UIMessage | ModelMessage>;
  signal?: AbortSignal;
}

async function attemptErrorRecovery(
  options: AttemptRecoveryOptions,
  error: unknown,
  multimodalStripAttempted: boolean,
  recoveryAttempts: number
): Promise<RecoveryResult | null> {
  // Never start a new recovery strategy for an already-cancelled run.
  if (options.signal?.aborted) return null;
  if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
    options.managed.log?.error(
      "agent",
      `Max recovery attempts (${MAX_RECOVERY_ATTEMPTS}) exceeded`,
      errorFromUnknown(error)
    );
    return null;
  }

  const compactHandled = await tryReactiveCompactRetry(options.managed, options.manager, error);
  if (compactHandled) {
    // The reactive compact wrote a SUMMARY onto the channel; re-arm the capability
    // strip so the retry still drops parts this model cannot take.
    armCapabilityStrip(options.managed);
    return { multimodalStripAttempted, strategy: "reactive_compact" };
  }

  if (tryCapabilitySanitizeRetry(options.managed, error, multimodalStripAttempted)) {
    return { multimodalStripAttempted: true, strategy: "capability" };
  }

  // Same messages + backoff (429 / gateway / network). Applies to root and subagents.
  if (isTransientRetryableError(error)) {
    // Read from the error, which `runErrorFromChunk` already populated from the chunk (SDK
    // `retryAfterMs` / `metadata.tanstack.retryAfterMs`). A thrown error that never became a
    // RUN_ERROR falls back to header/message scraping.
    const errorRetryAfterMs = readRetryAfterMs(error);
    const retryAfterSeconds = errorRetryAfterMs != null ? errorRetryAfterMs / 1000 : extractRetryAfterSeconds(error);
    options.managed.log?.debug("agent", "Transient provider error — retrying with backoff", {
      attempt: recoveryAttempts + 1,
      maxAttempts: MAX_RECOVERY_ATTEMPTS,
      retryAfterSeconds,
      error: errorFromUnknown(error).message,
    });
    options.managed.setError("");
    return {
      multimodalStripAttempted,
      strategy: "transient",
      ...(retryAfterSeconds != null ? { retryAfterSeconds } : {}),
    };
  }

  return null;
}

/**
 * Surface a pending retry to hosts: L1 `retry` state (state channel / snapshot)
 * plus an `agent:retry` telemetry event (lifecycle channel + log bridge).
 */
function recordRetry(managed: ManagedAgent, retry: AgentRetryState): void {
  managed.setRetry?.(retry);
  managed.emitEvent?.("agent:retry", {
    attempt: retry.attempt,
    maxAttempts: retry.maxAttempts,
    strategy: retry.strategy,
    ...(retry.error ? { error: retry.error } : {}),
    ...(retry.delayMs != null ? { delayMs: retry.delayMs } : {}),
    ...(retry.retryAfterSeconds != null ? { retryAfterSeconds: retry.retryAfterSeconds } : {}),
  });
}

// ============================================================================
// Stream wrapper
// ============================================================================

export interface RecoveryOptions {
  managed: ManagedAgent;
  manager: AgentManager;
  getMessages: () => Array<UIMessage | ModelMessage>;
  run: (messages: Array<UIMessage | ModelMessage>) => AsyncIterable<StreamChunk>;
  /** Optional — needed for max_tokens escalation on truncation */
  runner?: AgentRunner;
  /** Run abort signal — cancels the retry/backoff loop so Esc is not delayed. */
  signal?: AbortSignal;
}

/**
 * Sleep that resolves early when the run is aborted, so a cancel during a retry
 * backoff (up to {@link MAX_RETRY_BACKOFF_MS}) does not block the run teardown.
 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal!.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function* runStreamWithRecovery(options: RecoveryOptions): AsyncIterable<StreamChunk> {
  // Strip the capability state of any previous turn before the first wire build, so
  // a strip armed by an earlier run cannot leak into this one.
  options.managed.run.resetWireOverride();
  // Arm the pre-send capability strip for this run. The drop set is applied by the
  // `wire-recovery` middleware on every wire build — see `armCapabilityStrip`.
  // The messages are passed so the strip is only *reported* when this run actually carries a
  // droppable part; with none it is a no-op and the per-run line would be pure noise.
  armCapabilityStrip(options.managed, options.getMessages());

  const messages = options.getMessages();
  let multimodalStripAttempted = false;
  let recoveryAttempts = 0;
  let clearRetryOnNextChunk = false;
  const truncation = createTruncationState();

  /**
   * Two points check the run signal (between attempts, and during a backoff). Both must clear the
   * surfaced retry state, because neither path reaches a terminal status change that would.
   */
  const cancelled = (): boolean => {
    if (!options.signal?.aborted) return false;
    options.managed.setRetry?.(null);
    return true;
  };

  while (true) {
    // Cancelled between attempts — stop before starting another stream. Clear the
    // retry visibility first: this path returns without a terminal status change,
    // so nothing else unwinds the state recorded for the attempt that just ended.
    if (cancelled()) return;
    let shouldRetry = false;
    let truncationDetected = false;
    /** Whether this retry consumes `MAX_RECOVERY_ATTEMPTS` (truncation owns its own budget). */
    let countsAsRecoveryAttempt = true;
    let retryAfterSeconds: number | undefined;
    let lastErrorMessage = "";
    let retryStrategy: AgentRetryStrategy | undefined;
    /**
     * A `RUN_ERROR` chunk the ladder evaluated and declined. It is carried out of the loop and
     * thrown AFTER the `try` instead of inside it: throwing from the loop lands in this attempt's
     * own `catch`, which would run the same ladder a second time (and consume reactive-compaction
     * budget for an error that never retried). The old flag existed only to detect that shape.
     */
    let terminalError: Error | null = null;

    /** The one place a recovery decision becomes this attempt's retry state. */
    const applyRecovery = (result: RecoveryResult): void => {
      shouldRetry = true;
      multimodalStripAttempted = result.multimodalStripAttempted;
      retryAfterSeconds = result.retryAfterSeconds;
      retryStrategy = result.strategy;
    };

    const stream = options.run(messages);
    assertAsyncIterable<StreamChunk>(stream, "AgentRunner.run");

    try {
      for await (const chunk of stream) {
        if (clearRetryOnNextChunk && chunk.type !== "RUN_ERROR") {
          // Stream recovered after a retry — hide retry visibility again.
          clearRetryOnNextChunk = false;
          options.managed.setRetry?.(null);
        }

        if (chunk.type === "RUN_ERROR") {
          const runError = runErrorFromChunk(chunk);
          lastErrorMessage = runError.message;
          const result = await attemptErrorRecovery(options, runError, multimodalStripAttempted, recoveryAttempts);
          if (result) {
            applyRecovery(result);
            break;
          }
          terminalError = runError;
          break;
        }

        // Detect output token limit before yielding RUN_FINISHED
        if (chunk.type === "RUN_FINISHED") {
          const finishReason = (chunk as { finishReason?: string }).finishReason;
          if (finishReason === "length") {
            truncationDetected = true;
            break;
          }
        }

        yield chunk;
      }
    } catch (error) {
      if (!shouldRetry) {
        lastErrorMessage = errorFromUnknown(error).message;
        const result = await attemptErrorRecovery(options, error, multimodalStripAttempted, recoveryAttempts);
        if (result) applyRecovery(result);
        else throw error;
      }
    }

    if (terminalError) throw terminalError;

    if (truncationDetected) {
      const truncationResult = handleMaxTokensTruncation({
        managed: options.managed,
        runner: options.runner,
        truncation,
      });
      if (truncationResult.shouldRetry) {
        shouldRetry = true;
        countsAsRecoveryAttempt = truncationResult.countsAsRecoveryAttempt;
        lastErrorMessage = "";
        retryStrategy = "max_tokens";
      } else {
        // Truncation budget exhausted. The original RUN_FINISHED was swallowed by
        // the `break` above, so without this the stream ends with no terminal chunk
        // at all — consumers that read the finish reason (subagent run stats) then
        // see a clean stop and report a cut-off run as a complete one. Re-emit the
        // truncation as the terminal chunk so "we stopped because the output hit the
        // limit" survives, which is exactly what `reachedLimit`/`incomplete` need.
        truncationDetected = false;
        yield { type: "RUN_FINISHED", finishReason: "length" } as StreamChunk;
        return;
      }
    }

    if (!shouldRetry) return;

    // Restart-style recovery (transient / capability / reactive): clear subagent
    // preview so the task panel does not keep stale tools/summary across retries.
    // Max-tokens continuation appends to the same turn — do not reset UI.
    if (!truncationDetected) {
      prepareRestartStyleRetry(options);
    }

    const delay = retryDelayMs(recoveryAttempts, retryAfterSeconds);

    // Truncation labels itself from its own state: the shared `recoveryAttempts`
    // counter is not advanced by that branch, so reading it here reported
    // "attempt 1" for the escalation and the first continuations, then
    // "attempt 4/3" on the last one.
    const progress = truncationDetected
      ? readTruncationProgress(truncation)
      : { attempt: recoveryAttempts + 1, maxAttempts: MAX_RECOVERY_ATTEMPTS };

    // Surface retry progress to the UI + telemetry (attempt is 1-based).
    recordRetry(options.managed, {
      attempt: progress.attempt,
      maxAttempts: progress.maxAttempts,
      strategy: retryStrategy!,
      ...(lastErrorMessage ? { error: lastErrorMessage } : {}),
      delayMs: Math.round(delay),
      ...(retryAfterSeconds != null ? { retryAfterSeconds } : {}),
      startedAt: Date.now(),
    });
    clearRetryOnNextChunk = !truncationDetected;

    options.managed.log?.debug("agent", "Backoff before retry", {
      attempt: recoveryAttempts,
      delayMs: Math.round(delay),
      retryAfterSeconds,
    });
    await abortableDelay(delay, options.signal);
    // Cancelled during backoff — do not issue the (doomed) retry stream, and do
    // not leave the recorded retry surfaced: this return skips both the recovery
    // clear and the terminal-status clear in `ManagedAgent.setStatus`, so hosts
    // that keep rendering a live snapshot would keep showing "Retrying …".
    if (cancelled()) return;

    if (countsAsRecoveryAttempt) recoveryAttempts++;
  }
}

/**
 * Before a full stream restart: clear the attempt-scoped UI state + error status, and throw away
 * any pre-forked `task` runs the dead attempt started.
 *
 * The UI reset is display-only ({@link AgentUIChannel.resetRetryUiState} — the retry re-streams the
 * summary banner). It deliberately does NOT touch the message history, for either profile: that
 * history IS the wire (see `getModelVisibleMessages` / the compaction middleware), so discarding it
 * would delete the very progress the retry exists to resume. The root never discarded it; making
 * the subagent discard it is what turned a network blip into a full re-exploration.
 *
 * The discard belongs HERE rather than on `RUN_STARTED` (where it used to be): that event fires
 * once per model *iteration*, so it aborted a pre-fork the tool phase was about to join on
 * every multi-iteration turn. Only a restart actually invalidates the runs of the attempt
 * that ended; the next iteration's tool phase still joins them.
 *
 * Wire `messages` stay as set by the recovery strategy (may be capability-stripped).
 */
function prepareRestartStyleRetry(options: RecoveryOptions): void {
  // Optional-chained like the `log` / `setRetry` / `statusController` reads below: this helper is
  // driven by hosts whose only guarantee is that a run reached the recovery loop.
  options.managed.getUI?.()?.resetRetryUiState();
  // Report the orphans the same way the run boundaries do — this is the restart case, and it
  // is the one that makes an eager run look abandoned. `run-start` names it: the attempt is
  // being replaced by a fresh stream whose tool calls carry new ids.
  discardRegisteredPrefork(options.managed, "run-start", (discard) => {
    options.managed.emitEvent?.("subagent:prefork-discarded", {
      toolCallId: discard.toolCallId,
      cause: discard.cause,
      subagentIds: discard.subagentIds,
    });
  });
  options.managed.setError("");
  options.managed.statusController?.onRecoveryRetry?.();
}

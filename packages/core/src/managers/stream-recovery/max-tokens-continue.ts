import type { AgentRunner } from "../../agent/runner/agent-runner.js";
import type { ManagedAgent } from "../managed-agent.js";

/** Max number of truncation continuation retries after max_tokens escalation. */
export const MAX_TRUNCATION_CONTINUATIONS = 3;
/** Escalated max output tokens for the first truncation retry. */
export const ESCALATED_MAX_TOKENS = 64000;

/**
 * Continuation prompt injected when the model hits max_tokens.
 * Tells the model to resume directly without apology or recap.
 */
export const CONTINUATION_PROMPT =
  "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";

export interface TruncationState {
  maxTokensEscalated: boolean;
  continuationCount: number;
}

export function createTruncationState(): TruncationState {
  return {
    maxTokensEscalated: false,
    continuationCount: 0,
  };
}

/**
 * Attempt numbering for the truncation path, owned here so it can never report
 * `attempt > maxAttempts`.
 *
 * The shared `recoveryAttempts` counter in `run-stream-recovery` is a *different*
 * budget (it bounds error recovery) and must not be used to label a truncation:
 * it was never advanced by the truncation branch, so the escalation and the first
 * continuations all reported `attempt: 1` and the last one reported `attempt: 4`
 * against `maxAttempts: 3`.
 *
 * The escalation is retry 1 and each continuation is the next one, so the most
 * this path ever arms is `MAX_TRUNCATION_CONTINUATIONS + 1` recovery streams.
 */
export function readTruncationProgress(truncation: TruncationState): { attempt: number; maxAttempts: number } {
  return {
    attempt: truncation.continuationCount + 1,
    maxAttempts: MAX_TRUNCATION_CONTINUATIONS + 1,
  };
}

export interface TruncationRecoveryResult {
  /** True when the run should be retried (escalation or continuation armed). */
  shouldRetry: boolean;
  /**
   * Whether this continuation consumes the shared recovery budget
   * (`MAX_RECOVERY_ATTEMPTS` in `run-stream-recovery`).
   *
   * The escalation is a config change, not a retry attempt — it burns no budget.
   * Each continuation does take a real model call at an escalated `max_tokens`,
   * so it must consume one; otherwise a run that truncated a few times loses its
   * only transient-error backoff right when an upstream 429 is most likely.
   */
  countsAsRecoveryAttempt: boolean;
}

/**
 * Handle finishReason === "length": escalate max_tokens once, then inject continuation prompts.
 *
 * The attempt surfaced to hosts is `continuationCount + 1`: one call to this
 * function arms exactly one more stream, so the reported attempt can never
 * exceed {@link MAX_TRUNCATION_CONTINUATIONS}.
 */
export function handleMaxTokensTruncation(options: {
  managed: ManagedAgent;
  runner?: AgentRunner;
  truncation: TruncationState;
}): TruncationRecoveryResult {
  const { managed, runner, truncation } = options;

  if (!truncation.maxTokensEscalated && runner) {
    // Run-scoped: the runner is cached across turns (see `runnerConfigKey`), so mutating it
    // made one truncated turn raise the cap forever.
    managed.run.setMaxOutputTokensOverride(ESCALATED_MAX_TOKENS);
    truncation.maxTokensEscalated = true;
    managed.log?.debug("agent", "Output truncated — escalating max_tokens", {
      escalatedTokens: ESCALATED_MAX_TOKENS,
    });
    return { shouldRetry: true, countsAsRecoveryAttempt: false };
  }

  if (truncation.continuationCount < MAX_TRUNCATION_CONTINUATIONS) {
    truncation.continuationCount++;
    managed.log?.debug("agent", "Output truncated — injecting continuation prompt", {
      continuationCount: truncation.continuationCount,
    });
    // NOTE: wire-only recovery, and the reason this is a flag on the run rather than an
    // extra message appended to the array handed to the engine: `compaction` rebuilds
    // every wire call from `channel.getMessages()` and discards the incoming
    // `config.messages`. Appending here reaches the first call only, then the next
    // projection overwrites it — the prompt never reached the model. The flag is
    // applied by the `wire-recovery` middleware, which runs after that projection.
    //
    // The prompt is still not durable: it is NOT written to the UI channel and NOT
    // persisted to session, so the channel stays cache-stable and the transcript keeps
    // only what the user actually said.
    managed.run.setWireContinuationArmed(true);
    return { shouldRetry: true, countsAsRecoveryAttempt: true };
  }

  managed.log?.warn("agent", "Output truncated — max continuations reached, returning partial result");
  return { shouldRetry: false, countsAsRecoveryAttempt: false };
}

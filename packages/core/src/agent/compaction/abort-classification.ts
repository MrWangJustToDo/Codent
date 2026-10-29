/**
 * Abort classification at the compaction boundary.
 *
 * Compaction needs a stricter rule than {@link isAbortError}: its summarizer's failure text can
 * contain the word "aborted" (the no-summary diagnostic names its own flag), and the network stack
 * raises `AbortError` for its own body/operation timeouts. Treating either as a user cancel
 * released the lease without arming the retry backoff, so every later model call started another
 * full summarizer over the same prefix — the exact amplification the backoff exists to prevent.
 *
 * A cancel is therefore only: the compaction's own signal being aborted, or the tagged error the
 * summarizer boundary raises (which it does when the subagent reports `aborted`).
 */

const COMPACTION_CANCEL_CODE = "compaction_cancel";

/** Build the tagged cancel error raised by the summarizer boundary. */
export function compactionAbortError(): Error {
  const error = new Error("Compaction summarization aborted");
  error.name = "AbortError";
  (error as { code?: string }).code = COMPACTION_CANCEL_CODE;
  return error;
}

/** Whether a compaction throw is a user/session cancel rather than a failure. */
export function isCompactionCancel(error: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return true;
  return (error as { code?: unknown } | null | undefined)?.code === COMPACTION_CANCEL_CODE;
}

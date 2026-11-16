/**
 * Observes one model response as it is consumed, and bounds a response that stops advancing.
 *
 * Two facts are needed at the stream boundary and neither is available from the UI snapshot alone:
 *
 * - did the attempt receive its terminal event (`RUN_FINISHED` / `RUN_ERROR`)? A response that
 *   returns without one is not a completed model call, even though the async generator's `done`
 *   looks the same;
 * - is a tool call still waiting for its arguments? That is the ONLY window the idle guard may
 *   cover. "A tool call started at some point" is not enough: TanStack runs tool execution inside
 *   the same async iterable, and that period is legitimately silent — a `run_command` may take
 *   minutes, a blocking `task` even longer. The guard therefore counts OPEN tool calls
 *   (`TOOL_CALL_START` minus `TOOL_CALL_END`) and is disarmed the moment the last one closes.
 *
 * The observer is a pass-through generator deliberately: it sits where the stream is consumed, so it
 * sees exactly the chunks the engine and the UI channel see.
 */

import { ExecutionError } from "../../env/types.js";

import type { StreamChunk } from "@tanstack/ai";

/** Error text for a response that stopped sending chunks while a tool call still had no arguments. */
export const MODEL_STREAM_STALL_MESSAGE =
  "Model stream stalled while a tool call was waiting for its arguments. The response was interrupted.";

/** Error text for a response that ended without its terminal event while a tool call was incomplete. */
export const TRUNCATED_MODEL_STREAM_MESSAGE =
  "Model response ended before its tool calls were complete. The incomplete tool calls were not run.";

/**
 * Default idle budget while a tool call is open (announced but not finished).
 *
 * The guard is armed only while at least one call is between `TOOL_CALL_START` and
 * `TOOL_CALL_END`, so neither a slow first token nor tool execution is timed out. A provider that
 * legitimately pauses for a long time between a tool-call start and its arguments would be cut
 * off; the value is configurable (`streamStallTimeoutMs`) and `0` disables it.
 */
export const DEFAULT_MODEL_STREAM_STALL_MS = 120_000;

/** Live state of one observed response. */
export interface ModelStreamObservation {
  /**
   * The CURRENT attempt reached `RUN_FINISHED` (or `RUN_ERROR`).
   *
   * Reset at every `RUN_STARTED`: a restart-style retry (429 / gateway / capability / reactive
   * compact) re-enters `chat()` from a fresh engine and emits a second `RUN_STARTED`, so a failed
   * attempt's terminal event must not answer the boundary question for the attempt that replaced it.
   */
  sawTerminal: boolean;
  /** Number of `TOOL_CALL_START` chunks seen (accumulated across attempts). */
  toolStarts: number;
  /**
   * Calls announced but not finished (`TOOL_CALL_START` minus `TOOL_CALL_END`) in the CURRENT
   * attempt.
   *
   * Reset at `RUN_STARTED` for the same reason `sawTerminal` is: a call the dead attempt announced
   * can never receive its arguments, and letting it stay open keeps the idle guard armed through
   * the retry's tool execution — where a legitimate long `run_command` / `task` is silent.
   */
  openToolCalls: number;
  /** The idle guard fired. */
  stalled: boolean;
}

export interface ObserveModelStreamOptions {
  /** Idle budget while a tool call is open; `0` / undefined disables the guard. */
  stallTimeoutMs?: number;
}

async function nextWithStall(
  iterator: AsyncIterator<StreamChunk>,
  observation: ModelStreamObservation,
  stallTimeoutMs: number
): Promise<IteratorResult<StreamChunk>> {
  // Only bound a response that is currently waiting on a tool call's arguments. Before the first
  // start the model may still be thinking, and after `TOOL_CALL_END` the engine is executing the
  // tool — both are legitimate silence.
  if (stallTimeoutMs <= 0 || observation.openToolCalls === 0) return iterator.next();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      observation.stalled = true;
      reject(new ExecutionError("timeout", MODEL_STREAM_STALL_MESSAGE));
    }, stallTimeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([iterator.next(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Pass chunks through while recording terminal / tool-call facts and enforcing the idle guard. */
export async function* observeModelStream(
  stream: AsyncIterable<StreamChunk>,
  observation: ModelStreamObservation,
  options: ObserveModelStreamOptions = {}
): AsyncIterable<StreamChunk> {
  const stallTimeoutMs = options.stallTimeoutMs ?? 0;
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextWithStall(iterator, observation, stallTimeoutMs);
      if (next.done) return;
      const chunk = next.value;
      if (chunk.type === "RUN_STARTED") {
        // A restart-style retry re-enters `chat()` from a fresh engine and emits another
        // `RUN_STARTED`. Calls announced by the failed attempt can never receive their arguments,
        // so their open count must not survive into the retry: keeping them open armed the idle
        // guard through the retry's tool execution, where a long `run_command` / `task` is
        // legitimately silent. The terminal flag resets too — the boundary question is about the
        // attempt that produced the final messages, not an earlier one the engine abandoned.
        observation.sawTerminal = false;
        observation.openToolCalls = 0;
      } else if (chunk.type === "TOOL_CALL_START") {
        observation.toolStarts += 1;
        observation.openToolCalls += 1;
      } else if (chunk.type === "TOOL_CALL_END") {
        observation.openToolCalls = Math.max(0, observation.openToolCalls - 1);
      } else if (chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR") {
        observation.sawTerminal = true;
        observation.openToolCalls = 0;
      }
      yield chunk;
    }
  } finally {
    // Do not await: after a stall the source's pending `next()` may never settle, and blocking here
    // would keep the consumer's `finally` (and therefore the pump) from finishing. Closing is best
    // effort; the run is already finalizing as a failure. A synchronous throw from a custom
    // iterable's `return()` must not replace the stall error, hence the inner try.
    try {
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    } catch {
      // A best-effort close failure is not this run's failure.
    }
  }
}

/**
 * Whether a returned attempt is a truncated tool-call response.
 *
 * Only called when the attempt has already returned (a stalled attempt is surfaced as an error by
 * {@link observeModelStream}). A pending interaction is a legitimate park, not a broken response.
 */
export function isTruncatedModelStream(input: {
  sawTerminal: boolean;
  toolStarts: number;
  /** There is still at least one call whose arguments never completed. */
  hasTruncatedToolCalls: boolean;
  hasPendingInteraction: boolean;
}): boolean {
  if (input.sawTerminal || input.toolStarts === 0 || input.hasPendingInteraction) return false;
  return input.hasTruncatedToolCalls;
}

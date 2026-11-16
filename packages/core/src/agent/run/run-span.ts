/**
 * One managed stream span shared by the root chat pump and the child task adapter.
 *
 * This is deliberately a helper, not a layer: it owns only the stream call plus the shared
 * abort/error/empty-stream normalization. Queueing, approvals, task phases and result projection
 * stay with their actual owners (AgentChatController and runSubagent).
 */

import { toError } from "../../utils/errors.js";
import { formatAgentStreamError } from "../stream/assert-async-iterable.js";
import { EMPTY_MODEL_STREAM_MESSAGE, shouldFlagEmptyModelStream } from "../stream/empty-model-stream.js";
import { hasTruncatedToolCalls, toolSchemaRequiresArguments } from "../stream/incomplete-tool-calls.js";
import { hasPendingInteraction } from "../stream/tool-phase-utils.js";

import {
  DEFAULT_MODEL_STREAM_STALL_MS,
  TRUNCATED_MODEL_STREAM_MESSAGE,
  isTruncatedModelStream,
  observeModelStream,
  type ModelStreamObservation,
} from "./model-stream-observer.js";
import { ensureUIChannel, runAgentOnce } from "./run-agent-skeleton.js";

import type { RunAgentOnceOptions, RunAgentOnceResult } from "./run-agent-skeleton.js";
import type { UIMessage } from "@tanstack/ai";

export interface RunManagedSpanOptions extends RunAgentOnceOptions {
  /** Root-only: treat a stream that produced no model output as a failure. */
  flagEmptyStream?: boolean;
  /** Treat an abort-shaped error as a cancellation (child worker behavior). */
  abortErrorAsCancel?: boolean;
  /**
   * Treat a returned attempt that never reached its terminal event while a tool call was still
   * incomplete as a stream failure (default true). A stalled attempt is always surfaced as an
   * error by the observer, independently of this flag.
   */
  flagTruncatedStream?: boolean;
  /** Override the idle budget after the first tool-call start; `0` disables it. */
  stallTimeoutMs?: number;
  /** Called when the run ends because of an abort. */
  onAbort?: (messages: UIMessage[]) => void;
  /** Called for a non-abort stream failure. The helper still returns the normalized message. */
  onError?: (message: string, error: Error) => void;
  /** Called for an abort-shaped error when `abortErrorAsCancel` is false (root keeps it an error). */
  onAbortError?: (message: string, error: Error) => void;
  /** Called when `flagEmptyStream` detects no output. */
  onEmpty?: (message: string) => void;
}

export interface ManagedSpanResult {
  messages: UIMessage[];
  aborted: boolean;
  /** A stream failure normalized for the host. */
  errorMessage?: string;
  /** The failure is a truncated/stalled tool-call response; the caller settles the rows. */
  truncated?: boolean;
  /** The failure was the idle guard firing while a tool call waited for its arguments. */
  stalled?: boolean;
}

export async function runManagedSpan(
  options: RunManagedSpanOptions
): Promise<ManagedSpanResult & Pick<RunAgentOnceResult, "channel">> {
  const {
    parentTaskToolCallId,
    flagEmptyStream,
    flagTruncatedStream = true,
    stallTimeoutMs,
    abortErrorAsCancel = false,
    onAbort,
    onError,
    onAbortError,
    onEmpty,
    transformStream: callerTransform,
    ...runOptions
  } = options;
  const managed = runOptions.manager.getAgent(runOptions.agentId);
  if (!managed) throw new Error(`Agent not found: ${runOptions.agentId}`);

  const channel = runOptions.channel ?? managed.getUI() ?? ensureUIChannel(managed, runOptions.uiAttach);

  // One answer to "did this run get cancelled", shared by the success and throw paths: two copies
  // of the same expression is how one of them keeps checking a stale signal after the other moves.
  const isAbortedNow = (): boolean => managed.getStatus() === "aborted" || Boolean(managed.getAbortSignal()?.aborted);
  const abortedSpan = (messages: UIMessage[]): ManagedSpanResult & Pick<RunAgentOnceResult, "channel"> => {
    onAbort?.(messages);
    return { messages, aborted: true, channel };
  };

  // The schema fact comes from the registered tool's input schema; an unknown schema stays "not
  // truncated". Optional call: a host double may expose no tool service at all.
  const requiresArguments = (toolName: string): boolean | undefined =>
    toolSchemaRequiresArguments(managed.getToolInputSchema?.(toolName));
  const observation: ModelStreamObservation = {
    sawTerminal: false,
    toolStarts: 0,
    openToolCalls: 0,
    stalled: false,
  };
  const stallMs = stallTimeoutMs ?? managed.config?.streamStallTimeoutMs ?? DEFAULT_MODEL_STREAM_STALL_MS;
  const truncated = (messages: UIMessage[]): boolean =>
    flagTruncatedStream &&
    isTruncatedModelStream({
      sawTerminal: observation.sawTerminal,
      toolStarts: observation.toolStarts,
      hasTruncatedToolCalls: hasTruncatedToolCalls(messages, requiresArguments),
      hasPendingInteraction: hasPendingInteraction(messages),
    });

  try {
    const result = await runAgentOnce({
      ...runOptions,
      channel,
      parentTaskToolCallId,
      transformStream: (stream) =>
        observeModelStream(callerTransform ? callerTransform(stream) : stream, observation, {
          stallTimeoutMs: stallMs,
        }),
    });

    if (isAbortedNow()) return abortedSpan(result.messages);

    if (flagEmptyStream) {
      const before = (runOptions.messages ?? []) as UIMessage[];
      if (shouldFlagEmptyModelStream(before, result.messages)) {
        onEmpty?.(EMPTY_MODEL_STREAM_MESSAGE);
        return {
          messages: result.messages,
          aborted: false,
          errorMessage: EMPTY_MODEL_STREAM_MESSAGE,
          channel: result.channel,
        };
      }
    }

    if (truncated(result.messages)) {
      onError?.(TRUNCATED_MODEL_STREAM_MESSAGE, new Error(TRUNCATED_MODEL_STREAM_MESSAGE));
      return {
        messages: result.messages,
        aborted: false,
        errorMessage: TRUNCATED_MODEL_STREAM_MESSAGE,
        truncated: true,
        channel: result.channel,
      };
    }

    return { messages: result.messages, aborted: false, channel: result.channel };
  } catch (err) {
    const messages = channel.getMessages();
    if (isAbortedNow()) return abortedSpan(messages);

    const error = toError(err);
    const message = formatAgentStreamError(error).message;
    if (managed.isAbortError(err)) {
      // The run is not marked aborted (status/signal), but the failure is abort-SHAPED: a child
      // worker treats it as a cancellation; the root keeps it a failed turn (status error + text).
      if (abortErrorAsCancel) return abortedSpan(messages);
      onAbortError?.(message, error);
      return { messages, aborted: false, errorMessage: message, channel };
    }
    // A stall / terminal-less failure that left a tool call without arguments is the same class as
    // the returned shape above: the caller must settle those rows as truncated, not cancelled.
    const isTruncated = truncated(messages);
    onError?.(message, error);
    if (observation.stalled) {
      // The stalled read is still open on the network; aborting the run's controller closes it.
      // Detach the abort listener FIRST: it rewrites an active run's status to `aborted`, which
      // would turn a stall into a user cancellation (and, for a subagent, report `aborted` instead
      // of `failed`). The status was already decided by `onError`; this only closes the transport.
      // Optional: a host double may carry no RunCoordinator.
      managed.run?.cancelAbortController();
      managed.run?.currentAbortController?.abort(error);
    }
    return {
      messages,
      aborted: false,
      errorMessage: message,
      ...(isTruncated ? { truncated: true } : {}),
      ...(observation.stalled ? { stalled: true } : {}),
      channel,
    };
  }
}

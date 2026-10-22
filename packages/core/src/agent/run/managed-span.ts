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

import { ensureUIChannel, runAgentOnce } from "./run-agent-skeleton.js";

import type { RunAgentOnceOptions, RunAgentOnceResult } from "./run-agent-skeleton.js";
import type { UIMessage } from "@tanstack/ai";

export interface RunManagedSpanOptions extends RunAgentOnceOptions {
  /** Root-only: treat a stream that produced no model output as a failure. */
  flagEmptyStream?: boolean;
  /** Treat an abort-shaped error as a cancellation (child worker behavior). */
  abortErrorAsCancel?: boolean;
  /** Called when the run ends because of an abort. */
  onAbort?: (messages: UIMessage[]) => void;
  /** Called for a non-abort stream failure. The helper still returns the normalized message. */
  onError?: (message: string, error: Error) => void;
  /** Called for an abort-shaped error when `abortErrorAsCancel` is false (root keeps error text). */
  onAbortError?: (message: string, error: Error) => void;
  /** Called when `flagEmptyStream` detects no output. */
  onEmpty?: (message: string) => void;
}

export interface ManagedSpanResult {
  messages: UIMessage[];
  aborted: boolean;
  /** A stream failure normalized for the host. */
  errorMessage?: string;
  /** Set when the run produced no model output (root-only guard). */
  emptyStream?: boolean;
}

export async function runManagedSpan(
  options: RunManagedSpanOptions
): Promise<ManagedSpanResult & Pick<RunAgentOnceResult, "channel">> {
  const {
    parentTaskToolCallId,
    flagEmptyStream,
    abortErrorAsCancel = false,
    onAbort,
    onError,
    onAbortError,
    onEmpty,
    ...runOptions
  } = options;
  const managed = runOptions.manager.getAgent(runOptions.agentId);
  if (!managed) throw new Error(`Agent not found: ${runOptions.agentId}`);

  const channel = runOptions.channel ?? managed.getUI() ?? ensureUIChannel(managed, runOptions.uiAttach);

  try {
    const result = await runAgentOnce({
      ...runOptions,
      channel,
      parentTaskToolCallId,
    });

    const aborted = managed.getStatus() === "aborted" || Boolean(managed.getAbortSignal()?.aborted);
    if (aborted) {
      onAbort?.(result.messages);
      return { messages: result.messages, aborted: true, channel: result.channel };
    }

    if (flagEmptyStream) {
      const before = (runOptions.messages ?? []) as UIMessage[];
      if (shouldFlagEmptyModelStream(before, result.messages)) {
        onEmpty?.(EMPTY_MODEL_STREAM_MESSAGE);
        return {
          messages: result.messages,
          aborted: false,
          errorMessage: EMPTY_MODEL_STREAM_MESSAGE,
          emptyStream: true,
          channel: result.channel,
        };
      }
    }

    return { messages: result.messages, aborted: false, channel: result.channel };
  } catch (err) {
    const messages = channel.getMessages();
    const actuallyAborted = managed.getStatus() === "aborted" || Boolean(managed.getAbortSignal()?.aborted);
    if (actuallyAborted) {
      onAbort?.(messages);
      return { messages, aborted: true, channel };
    }

    const error = toError(err);
    const message = formatAgentStreamError(error).message;
    if (managed.isAbortError(err)) {
      if (abortErrorAsCancel) {
        onAbort?.(messages);
        return { messages, aborted: true, channel };
      }
      onAbortError?.(message, error);
      return { messages, aborted: false, errorMessage: message, channel };
    }
    onError?.(message, error);
    return { messages, aborted: false, errorMessage: message, channel };
  }
}

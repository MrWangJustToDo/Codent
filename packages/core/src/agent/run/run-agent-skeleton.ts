/**
 * Shared single-run skeleton for InteractiveChat phases and Worker/subagent runs.
 *
 * Profiles own outer loops (chat pump vs one-shot worker). This module owns
 * UI attach, stream consume, and optional outcome application.
 *
 * Every LLM run requires an {@link AgentUIChannel} (durable message SoT).
 * Parent-panel streaming is selected by the presence of a task id on the run.
 *
 * Lives under `agent/run/` so Worker code can import it without crossing the
 * agent→managers boundary. Managers may import this module.
 */

import { AgentUIChannel } from "../ui/ui-channel.js";

import type { AgentManager, ManagedAgent } from "../../runtime-types/hosts.js";
import type { AgentStreamHub } from "../stream-hub";
import type { ModelMessage, StreamChunk, UIMessage } from "@tanstack/ai";

export interface EnsureUIChannelOptions {
  /** Used only when creating a new channel (no existing `managed.getUI()`). */
  initialMessages?: UIMessage[];
}

/**
 * Attach or reuse {@link AgentUIChannel} on a managed agent.
 * Sole UI attach helper for skeleton / UI runs.
 */
export function ensureUIChannel(managed: ManagedAgent, options?: EnsureUIChannelOptions): AgentUIChannel {
  const existing = managed.getUI();
  if (existing) return existing;
  const channel = new AgentUIChannel({ initialMessages: options?.initialMessages });
  managed.setUIChannel(channel);
  return channel;
}

export interface ConsumeAgentStreamOptions {
  stream: AsyncIterable<StreamChunk>;
  channel: AgentUIChannel;
  parentTaskToolCallId?: string;
  summaryHub?: AgentStreamHub;
  compactId?: string;
  compactLabel?: string;
  compactEpoch?: string;
  summaryGeneration?: number;
  onUpdate?: (messages: UIMessage[]) => void;
}

/**
 * Consume one agent stream into UIMessage snapshots via the UI channel.
 */
export async function consumeAgentStream(options: ConsumeAgentStreamOptions): Promise<UIMessage[]> {
  const {
    stream,
    channel,
    parentTaskToolCallId,
    summaryHub,
    compactId,
    compactLabel,
    compactEpoch,
    summaryGeneration,
    onUpdate,
  } = options;

  if (!channel) {
    throw new Error("AgentUIChannel is required to consume an agent stream");
  }

  return (await channel.consumeRun({
    stream,
    parentTaskToolCallId,
    summaryHub,
    compactId,
    compactLabel,
    compactEpoch,
    summaryGeneration,
    onUpdate,
  })) as UIMessage[];
}

export interface RunAgentOnceOutcome {
  path: "chat" | "detached";
  kind: "finished" | "aborted" | "error" | "waiting";
  errorMessage?: string;
  /** Override messages passed to applyRunOutcome (defaults to consumed messages). */
  messages?: UIMessage[];
}

export interface RunAgentOnceOptions {
  manager: AgentManager;
  agentId: string;
  messages?: Array<UIMessage | ModelMessage>;
  abortSignal?: AbortSignal;
  threadId?: string;
  runId?: string;
  /** Pre-attached channel; otherwise {@link ensureUIChannel} is used. */
  channel?: AgentUIChannel;
  uiAttach?: EnsureUIChannelOptions;
  parentTaskToolCallId?: string;
  summaryHub?: AgentStreamHub;
  compactId?: string;
  compactLabel?: string;
  compactEpoch?: string;
  summaryGeneration?: number;
  onUpdate?: (messages: UIMessage[]) => void;
  /** Optional wrapper (e.g. finish-reason capture). Applied before consume. */
  transformStream?: (stream: AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>;
  /**
   * When set, apply run outcome after consume.
   * InteractiveChat pump omits this and finalizes after the full tool-phase loop.
   */
  outcome?: RunAgentOnceOutcome;
}

export interface RunAgentOnceResult {
  messages: UIMessage[];
  channel: AgentUIChannel;
}

/**
 * One LLM/tool stream: start → consume → optional outcome.
 * Does not own chat queues, approvals, or session persistence.
 */
export async function runAgentOnce(options: RunAgentOnceOptions): Promise<RunAgentOnceResult> {
  const {
    manager,
    agentId,
    messages: inputMessages,
    abortSignal,
    threadId,
    runId,
    uiAttach,
    parentTaskToolCallId,
    summaryHub,
    compactId,
    compactLabel,
    compactEpoch,
    summaryGeneration,
    onUpdate,
    transformStream,
    outcome,
  } = options;

  const managed = manager.getAgent(agentId);
  if (!managed) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const channel = options.channel ?? ensureUIChannel(managed, uiAttach);

  let stream: AsyncIterable<StreamChunk> = manager.runAgentStream(agentId, {
    messages: inputMessages,
    abortSignal,
    threadId,
    runId,
  });
  if (transformStream) {
    stream = transformStream(stream);
  }

  const messages = await consumeAgentStream({
    stream,
    channel,
    parentTaskToolCallId,
    summaryHub,
    compactId,
    compactLabel,
    compactEpoch,
    summaryGeneration,
    onUpdate,
  });

  if (outcome) {
    managed.runFinalizer.applyOutcome({
      kind: outcome.kind,
      messages: outcome.messages ?? messages,
      path: outcome.path,
      errorMessage: outcome.errorMessage,
    });
  }

  return { messages, channel };
}

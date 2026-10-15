import { EventType } from "@tanstack/ai";

import { ReasoningContentCache } from "../cache/reasoning-content-cache.js";

import { ChatCompletionsTextAdapter, type ChatCompletionsTextAdapterConfig } from "./chat-completions-text-adapter.js";
import { extractReasoningContentFromStreamChunk } from "./reasoning-echo.js";
import { resolveReasoningContentForAssistant } from "./resolve-reasoning-content.js";

import type { ModelMessage, StreamChunk, TextOptions } from "@tanstack/ai";
import type { ChatCompletionChunk, ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";

export type ReasoningChatCompletionsConfig = ChatCompletionsTextAdapterConfig;

/**
 * Chat Completions adapter that round-trips DeepSeek thinking mode `reasoning_content`.
 *
 * Fixes stay in the adapter (no chat/compaction/UI pipeline changes):
 * 1. Buffer stream reasoning and emit `STEP_FINISHED.delta` so TanStack’s engine
 *    keeps `message.thinking` on the in-run tool-call assistant.
 * 2. Cache reasoning by `toolCallId` so `convertMessage` can echo `reasoning_content`
 *    even when UI→model conversion dropped `thinking` parts.
 *
 * Inherits tool-result image lifting from {@link ChatCompletionsTextAdapter}.
 */
export class ReasoningChatCompletionsTextAdapter extends ChatCompletionsTextAdapter {
  private readonly reasoningCache = new ReasoningContentCache();

  constructor(config: ReasoningChatCompletionsConfig, model: string) {
    super(config, model);
  }

  /** Test / debug helper. */
  getReasoningCache(): ReasoningContentCache {
    return this.reasoningCache;
  }

  protected override extractReasoning(chunk: unknown): { text: string } | undefined {
    const reasoning = extractReasoningContentFromStreamChunk(chunk);
    return reasoning ? { text: reasoning } : undefined;
  }

  protected override async *processStreamChunks(
    stream: AsyncIterable<ChatCompletionChunk>,
    options: TextOptions,
    aguiState: {
      runId: string;
      threadId: string;
      messageId: string;
      hasEmittedRunStarted: boolean;
    }
  ): AsyncIterable<StreamChunk> {
    let reasoningBuffer = "";
    let sawStepFinishedWithDelta = false;
    const toolCallIds: string[] = [];

    for await (const chunk of super.processStreamChunks(stream, options, aguiState)) {
      if (chunk.type === EventType.REASONING_MESSAGE_CONTENT) {
        const delta =
          typeof (chunk as { delta?: unknown }).delta === "string" ? (chunk as { delta: string }).delta : "";
        if (delta) reasoningBuffer += delta;
        yield chunk;
        continue;
      }

      if (chunk.type === EventType.TOOL_CALL_START) {
        const id =
          typeof (chunk as { toolCallId?: unknown }).toolCallId === "string"
            ? (chunk as { toolCallId: string }).toolCallId
            : "";
        if (id) toolCallIds.push(id);
        yield chunk;
        continue;
      }

      if (chunk.type === EventType.STEP_FINISHED) {
        const existingDelta =
          typeof (chunk as { delta?: unknown }).delta === "string" ? (chunk as { delta: string }).delta : "";
        const content =
          typeof (chunk as { content?: unknown }).content === "string" ? (chunk as { content: string }).content : "";
        const delta = existingDelta || content || reasoningBuffer;
        if (delta) {
          // Necessary cast: `delta` / `content` are runtime extras TanStack reads off a
          // STEP_FINISHED event, but neither AG-UI's `StepFinishedEvent` nor TanStack's
          // extension of it declares them — there is no precise type to spell this with.
          yield {
            ...(chunk as object),
            type: EventType.STEP_FINISHED,
            delta,
            content: delta,
          } as unknown as StreamChunk;
          sawStepFinishedWithDelta = true;
          reasoningBuffer = reasoningBuffer || delta;
        } else {
          yield chunk;
        }
        continue;
      }

      if (chunk.type === EventType.RUN_FINISHED) {
        if (reasoningBuffer) {
          if (!sawStepFinishedWithDelta) {
            // Same reason as above: `stepId` / `model` / `delta` are not in the protocol's
            // StepFinishedEvent. This one is synthesized from scratch, so it also has to carry
            // the `stepName` the protocol does require.
            yield {
              type: EventType.STEP_FINISHED,
              stepName: "thinking",
              stepId: "thinking",
              delta: reasoningBuffer,
              content: reasoningBuffer,
              model: (chunk as { model?: string }).model,
              timestamp: Date.now(),
            } as unknown as StreamChunk;
          }
          this.reasoningCache.remember(reasoningBuffer, toolCallIds);
        }
      }

      yield chunk;
    }
  }

  protected override convertMessage(message: ModelMessage): ChatCompletionMessageParam {
    const converted = super.convertMessage(message);

    if (message.role !== "assistant") {
      return converted;
    }

    const reasoningContent = resolveReasoningContentForAssistant(message, this.reasoningCache);
    if (!reasoningContent) {
      return converted;
    }

    // `reasoning_content` is a non-standard field (DeepSeek and friends) that OpenAI's
    // `ChatCompletionMessageParam` does not declare. Spelling the extension as an intersection
    // keeps the assignment checked — `as unknown as` here asserted a shape nothing could verify,
    // which is how a drifting field name would have gone unnoticed.
    const withReasoning: ChatCompletionMessageParam & { reasoning_content?: string } = {
      ...converted,
      reasoning_content: reasoningContent,
    };
    return withReasoning;
  }
}

export function createReasoningChatCompletions(
  model: string,
  apiKey: string,
  config?: Omit<ReasoningChatCompletionsConfig, "apiKey">
): ReasoningChatCompletionsTextAdapter {
  return new ReasoningChatCompletionsTextAdapter({ apiKey, ...config }, model);
}

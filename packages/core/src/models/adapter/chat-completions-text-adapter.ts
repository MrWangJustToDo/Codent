import { OpenAIBaseChatCompletionsTextAdapter } from "@tanstack/openai-base";
import OpenAI from "openai";

import { stripDataUrlPrefix } from "../../utils/data-url.js";

import { liftToolMediaForChatCompletions } from "./lift-tool-media-for-chat-completions.js";

import type { ContentPart, TextOptions } from "@tanstack/ai";
import type {
  ChatCompletionContentPart,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";

export interface ChatCompletionsTextAdapterConfig {
  apiKey: string;
  baseURL?: string;
  maxRetries?: number;
  dangerouslyAllowBrowser?: boolean;
}

/**
 * OpenAI-compatible Chat Completions adapter with tool-result image lifting.
 *
 * Base TanStack behavior JSON.stringifies multimodal tool content; this subclass
 * rewrites messages first so images/audio become user `image_url` / `input_audio`
 * parts. Audio parts would otherwise throw "Unsupported content part type" in the
 * upstream {@link OpenAIBaseChatCompletionsTextAdapter.convertContentPart}.
 */
export class ChatCompletionsTextAdapter extends OpenAIBaseChatCompletionsTextAdapter<string, Record<string, unknown>> {
  constructor(config: ChatCompletionsTextAdapterConfig, model: string) {
    super(
      model,
      "chat-completions",
      new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        maxRetries: config.maxRetries,
        dangerouslyAllowBrowser: config.dangerouslyAllowBrowser ?? true,
      })
    );
  }

  protected override mapOptionsToRequest(options: TextOptions): ChatCompletionCreateParamsStreaming {
    return super.mapOptionsToRequest({
      ...options,
      messages: liftToolMediaForChatCompletions(options.messages),
    });
  }

  protected override convertContentPart(part: ContentPart): ChatCompletionContentPart | null {
    if (part.type === "audio") {
      const data = stripDataUrlPrefix(part.source.value);
      return {
        type: "input_audio",
        input_audio: { data, format: audioFormatForMime(part.source.mimeType) },
      };
    }
    return super.convertContentPart(part);
  }
}

/** Map a MIME type to the OpenAI `input_audio` format enum (wav | mp3). */
function audioFormatForMime(mimeType: string | undefined): "wav" | "mp3" {
  if (typeof mimeType === "string" && mimeType.toLowerCase().includes("wav")) return "wav";
  return "mp3";
}

export function createChatCompletions(
  model: string,
  apiKey: string,
  config?: Omit<ChatCompletionsTextAdapterConfig, "apiKey">
): ChatCompletionsTextAdapter {
  return new ChatCompletionsTextAdapter({ apiKey, ...config }, model);
}

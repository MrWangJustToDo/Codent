/**
 * Provider-native spelling for the output-token cap.
 *
 * `modelOptions` is spread verbatim into the provider request body, and no
 * adapter reads a generic `maxTokens`:
 *
 * - chat-completions (`@tanstack/openai-base`) spreads `modelOptions` straight
 *   into the body; the SDK's own sampling-keys list annotates `maxTokens` as
 *   "generic / migration leftover (no adapter reads it)", and the adapter notes
 *   the root `temperature`/`topP`/`maxTokens` fields are "intentionally NOT
 *   read".
 * - the Anthropic adapter copies a curated key set and reads `max_tokens`
 *   through its own default path.
 *
 * A cap sent under the wrong name is silently ignored, so the bound is only real
 * if the key matches the adapter. Both call sites — the conversational run loop
 * (`AgentRunner`) and the one-shot structured port — share this so they cannot
 * drift apart again.
 */

import type { ModelStyle } from "./types.js";

/**
 * Build the `modelOptions` slice carrying the output-token cap.
 *
 * Returns an empty object when no cap is requested, so callers can spread it
 * unconditionally.
 */
export function maxTokensOption(
  modelStyle: ModelStyle | undefined,
  maxOutputTokens: number | undefined
): Record<string, number> {
  // A non-positive cap is not a cap: OpenAI/Anthropic reject `max_tokens: 0`, and sending it turns a
  // metadata gap into an unusable model. Treat it like "not requested".
  if (maxOutputTokens == null || !(maxOutputTokens > 0)) return {};
  return modelStyle === "anthropic" ? { max_tokens: maxOutputTokens } : { max_completion_tokens: maxOutputTokens };
}

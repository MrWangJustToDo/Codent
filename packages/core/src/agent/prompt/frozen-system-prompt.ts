/**
 * The FROZEN system prompt: the part that must stay byte-stable across turns.
 *
 * Lives in `agent/prompt/` with the rest of the prompt domain (`default-prompt`, agent doc,
 * instruction files), not in `turn-context/`: the dynamic `<ctx kind=…>` sections are assembled
 * there, and having one half of the prompt in each directory made "where is the system prompt
 * built?" a two-file answer.
 */

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "../../models/cache/prompt-cache.js";
import { TURN_CONTEXT_KINDS, formatSectionTag } from "../turn-context/turn-context-message.js";

export { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "../../models/cache/prompt-cache.js";

export interface SystemPromptInput {
  /** Only `systemPrompt` is read; callers may pass the full agent config structurally. */
  config: { systemPrompt?: string };
  agentDocContent: string;
}

export function buildFrozenSystemPrompt(input: SystemPromptInput): string | undefined {
  const parts: string[] = [];

  if (input.config.systemPrompt) {
    parts.push(input.config.systemPrompt);
  }

  if (input.agentDocContent) {
    parts.push(
      formatSectionTag(TURN_CONTEXT_KINDS.projectInstructions, [
        "Below are the project-specific instructions loaded from the repository.",
        "Follow these conventions, rules, and guidelines when working in this codebase.",
        "",
        input.agentDocContent,
      ])
    );
  }

  // NOTE: the memory index (<memory_index>) is no longer frozen here — it is
  // injected per-turn by the built-in Memory extension via `registerContextProvider`
  // so freshly extracted memories surface without waiting for compaction.

  const joined = parts.length > 0 ? parts.join("\n\n") : undefined;
  if (joined) {
    return joined + SYSTEM_PROMPT_DYNAMIC_BOUNDARY;
  }
  return undefined;
}

/**
 * The frozen system prompt as the runner's `systemPrompts` array — the only system text there is.
 *
 * Dynamic context is injected as synthetic user messages by the turn-context middleware, so this is
 * deliberately NOT an assembly step. The middleware re-publishes the value on every `onConfig`
 * because the runner is built with a build-time snapshot (`buildAgentRunner` reads it once): this is
 * the live read, so a `resetSystemPrompt()` / rebuilt instruction file reaches the next model call
 * even when the cached runner is reused. In the steady state the value is byte-identical, which is
 * what keeps the prompt-cache prefix stable. It used to be named
 * `buildSystemPromptWithTurnContext`, which claimed an assembly that no longer exists.
 */
export function systemPromptsFromFrozen(frozen: string | undefined): string[] | undefined {
  return frozen ? [frozen] : undefined;
}

import {
  applyAnthropicLatestUserCacheBreakpoint,
  applyAnthropicToolCacheBreakpoint,
  buildAnthropicCachedSystemPrompts,
  shouldApplyAnthropicCacheBreakpoints,
  shouldApplyOpenAIPromptCacheKey,
  sortToolsByName,
} from "../../models/cache/prompt-cache.js";
import { defineMiddleware } from "../../runtime-types/middleware-phase.js";

import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { ModelStyle } from "../../models/types.js";
import type { ChatMiddleware, ModelMessage, ServerTool, SystemPrompt } from "@tanstack/ai";

export interface PromptCacheMiddlewareDeps {
  getModelStyle: () => ModelStyle | undefined;
  /** Stable session-scoped key for OpenAI `prompt_cache_key`. */
  getPromptCacheKey: () => string;
}

/**
 * Stable fingerprint for a tool set so the sorted array can be memoized.
 *
 * The sort only depends on names, but the memo hands back the *tool objects* — so
 * everything the model can see has to be in the key. Schema-only was not enough:
 * swapping a tool's `description` (or `title`) while keeping its name and schema
 * returned the stale object, and the model kept receiving the old description.
 * Falls back to a marker when a field is not JSON-serializable.
 */
function toolSetFingerprint(tools: ServerTool[]): string {
  return tools
    .map((t) => {
      let schema = "";
      let description = "";
      try {
        schema = JSON.stringify(t.inputSchema ?? null);
      } catch {
        schema = "(non-serializable)";
      }
      try {
        description = JSON.stringify(t.description ?? null);
      } catch {
        description = "(non-serializable)";
      }
      return `${t.name}:${(t as { title?: string }).title ?? ""}:${description}:${schema}`;
    })
    .join("\u0001");
}

/**
 * Provider prompt-cache wiring (P0):
 * - Anthropic: `cache_control` on frozen system, last tool, latest user
 * - OpenAI-compatible: `prompt_cache_key` (session affinity)
 * - All styles: stable tool name order
 */
export function createPromptCacheMiddleware(deps: PromptCacheMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  // Memoized sorted tool list: reuse the same array reference whenever the tool
  // set is unchanged, avoiding a re-sort + fresh allocation on every request.
  let cachedToolFingerprint = "";
  let cachedSortedTools: ServerTool[] | null = null;

  return defineMiddleware("wire-annotate", {
    name: "prompt-cache",
    onConfig: async (_ctx, config) => {
      const style = deps.getModelStyle();
      const patch: {
        systemPrompts?: SystemPrompt[];
        tools?: ServerTool[];
        messages?: ModelMessage[];
        modelOptions?: Record<string, unknown>;
      } = {};

      const tools = config.tools as ServerTool[] | undefined;
      if (shouldApplyAnthropicCacheBreakpoints(style)) {
        patch.systemPrompts = buildAnthropicCachedSystemPrompts(config.systemPrompts as SystemPrompt[] | undefined);
        patch.tools = applyAnthropicToolCacheBreakpoint(tools);
        patch.messages = applyAnthropicLatestUserCacheBreakpoint(config.messages as ModelMessage[]);
      } else if (tools?.length) {
        const fingerprint = toolSetFingerprint(tools);
        if (cachedToolFingerprint !== fingerprint) {
          cachedSortedTools = sortToolsByName(tools);
          cachedToolFingerprint = fingerprint;
        }
        patch.tools = cachedSortedTools ?? sortToolsByName(tools);
      }

      if (shouldApplyOpenAIPromptCacheKey(style)) {
        const existing =
          config.modelOptions && typeof config.modelOptions === "object"
            ? (config.modelOptions as Record<string, unknown>)
            : {};
        patch.modelOptions = {
          ...existing,
          prompt_cache_key: deps.getPromptCacheKey(),
        };
      }

      return patch;
    },
  });
}

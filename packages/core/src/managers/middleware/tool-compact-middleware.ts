import { applyToolCompact } from "../../agent/compaction/tool-compact/apply-tool-compact.js";

import { defineMiddleware } from "./phase.js";

import type { ToolCompactCache } from "../../agent/compaction/tool-compact/tool-compact-cache.js";
import type { ToModelOutputRegistry } from "../../agent/compaction/tool-compact/types.js";
import type { CompactionConfig } from "../../agent/compaction/types.js";
import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { ManagedAgent } from "../../runtime-types";
import type { ChatMiddleware, ModelMessage } from "@tanstack/ai";

export interface ToolCompactMiddlewareDeps {
  getCompactionConfig: () => CompactionConfig | null;
  getToolCompactCache: () => ToolCompactCache;
  getManagedAgent: () => ManagedAgent;
  registry?: ToModelOutputRegistry;
}

/**
 * Per-tool LLM shaping via `toModelOutput` and recent-window placeholders.
 *
 * Placement: this runs BEFORE `wire-recovery`, because it is what turns a tool result
 * into real content parts — see the placement contract on that middleware. A capability
 * strip placed earlier cannot see a tool's media at all.
 */
export function createToolCompactMiddleware(deps: ToolCompactMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  const registry =
    deps.registry ??
    ({
      get: (toolName: string) => deps.getManagedAgent().getToolModelOutput?.(toolName),
    } satisfies Pick<ToModelOutputRegistry, "get">);

  return defineMiddleware("context-transform", {
    name: "tool-compact",
    onConfig: async (_ctx, config) => {
      const messages = config.messages as ModelMessage[];

      const parentId = deps.getManagedAgent().parentId;

      if (!parentId) {
        // `applyToolCompact` is pure — it returns replacements instead of editing the
        // array it is handed, which may be the one `WireProjectionCache` retains.
        return {
          messages: await applyToolCompact(messages, {
            config: deps.getCompactionConfig() ?? undefined,
            registry,
            cache: deps.getToolCompactCache(),
          }),
        };
      }

      return { messages };
    },
  });
}

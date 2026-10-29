import { applyToolCompact } from "../../agent/compaction/tool-compact/apply-tool-compact.js";
import { errorMessage } from "../../utils/errors.js";

import { defineMiddleware } from "./phase.js";

import type { ToolCompactCache } from "../../agent/compaction/tool-compact/tool-compact-cache.js";
import type { ToModelOutputRegistry } from "../../agent/compaction/tool-compact/types.js";
import type { CompactionConfig } from "../../agent/compaction/types.js";
import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { ManagedAgent } from "../../runtime-types";
import type { EmitAgentTelemetryFn } from "../../runtime-types/agent-events.js";
import type { ChatMiddleware, ModelMessage } from "@tanstack/ai";

export interface ToolCompactMiddlewareDeps {
  getCompactionConfig: () => CompactionConfig | null;
  getToolCompactCache: () => ToolCompactCache;
  getManagedAgent: () => ManagedAgent;
  /** Publishes projection failures (`tool:projection-error`) — the policy decides the row. */
  emitEvent: EmitAgentTelemetryFn;
  registry?: ToModelOutputRegistry;
}

/**
 * Per-tool LLM shaping via `toModelOutput` (tool-compact).
 *
 * Applies to ROOT and CHILD runs alike. `toModelOutput` is the only projection that turns a stored
 * tool result into model-facing content — media parts, error text, a `run_command` summary — so a
 * child that returned its wire untouched sent `read_file` images as base64 JSON text, repeated
 * `grep`/`glob` content alongside the matches, and dropped the cancellation notice.
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
      // `applyToolCompact` is pure — it returns replacements instead of editing the
      // array it is handed, which may be the one `WireProjectionCache` retains.
      return {
        messages: await applyToolCompact(messages, {
          config: deps.getCompactionConfig() ?? undefined,
          registry,
          cache: deps.getToolCompactCache(),
          onProjectionError: (toolName, error) =>
            deps.emitEvent("tool:projection-error", { tool_name: toolName, error: errorMessage(error) }),
        }),
      };
    },
  });
}

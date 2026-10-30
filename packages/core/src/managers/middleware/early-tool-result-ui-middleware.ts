/**
 * Apply each server tool result to the UI as soon as that tool finishes.
 *
 * TanStack `chat()` runs tools sequentially but only emits batched
 * TOOL_CALL_END/RESULT chunks after the entire tool phase completes. Without
 * this middleware, earlier tools stay spinner/`input-complete` until siblings
 * finish — especially visible for long-running `task` tools.
 */

import { getBuiltinToolPresentation } from "../../agent/tools/presentation/builtin.js";
import { computeToolDisplay } from "../../agent/tools/presentation/compute-display.js";
import { errorMessage } from "../../utils/errors.js";

import { defineMiddleware } from "./phase.js";

import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { AgentUIChannel } from "../../runtime-types";
import type { ChatMiddleware } from "@tanstack/ai";

export interface EarlyToolResultUiMiddlewareDeps {
  getUIChannel: () => AgentUIChannel | null | undefined;
}

export function createEarlyToolResultUiMiddleware(
  deps: EarlyToolResultUiMiddlewareDeps
): ChatMiddleware<ToolRunContext> {
  return defineMiddleware("tools", {
    name: "early-tool-result-ui",
    onAfterToolCall: async (_ctx, info) => {
      const toolCallId = info.toolCallId;
      if (!toolCallId) return;

      const channel = deps.getUIChannel();
      if (!channel) return;

      if (info.ok) {
        const output = info.result ?? null;
        channel.addToolResult(toolCallId, output);
        attachToolDisplay(channel, info, toolCallId, output);
        return;
      }

      const message = errorMessage(info.error ?? "Tool execution failed");
      const failure = { error: message };
      channel.addToolResult(toolCallId, failure, message);
      attachToolDisplay(channel, info, toolCallId, failure);
    },
  });
}

/**
 * Core owns presentation: render the tool's display payload once here and hang it on
 * the part, so every host (local, remote session, extension host) reads the same text
 * without needing the tool registry in its own process.
 */
function attachToolDisplay(
  channel: AgentUIChannel,
  info: { toolName?: string; input?: unknown },
  toolCallId: string,
  output: unknown
): void {
  if (!info.toolName) return;
  const display = computeToolDisplay(
    info.toolName,
    output,
    info.input,
    // The channel's resolver already falls back to the built-in table for incumbent tools. Adding
    // a second fallback here would re-introduce the built-in descriptor for a shadowing tool that
    // declared none (see `ManagedAgent.getToolPresentation`).
    (name) =>
      channel.resolveToolPresentation ? channel.resolveToolPresentation(name) : getBuiltinToolPresentation(name)
  );
  if (display) channel.attachToolDisplay(toolCallId, display);
}

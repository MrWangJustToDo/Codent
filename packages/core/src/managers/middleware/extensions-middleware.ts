import { isAbortError, isCancelledOutputMarker } from "../../runtime-types/abort.js";

import { defineMiddleware } from "./phase.js";

import type { ExtensionRunner } from "../../agent/extension/runner.js";
import type { ToolAfterEvent, ToolBeforeEvent } from "../../agent/extension/types.js";
import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { TodoManager } from "../../agent/todo";
import type { EmitAgentTelemetryFn } from "../telemetry/emit-agent-telemetry.js";
import type { ChatMiddleware } from "@tanstack/ai";

export interface ExtensionsMiddlewareDeps {
  getExtensionRunner: () => ExtensionRunner | null;
  getSessionId: () => string;
  getTodoManager?: () => TodoManager | null;
  emitEvent?: EmitAgentTelemetryFn;
  /**
   * The in-flight run's abort signal, so a tool throw can be classified as the user's abort
   * instead of a tool fault. Same accessor shape as the other middlewares' `getAbortSignal`.
   */
  getAbortSignal?: () => AbortSignal | undefined;
  /**
   * Whether an eager `agent:tool-start` is deferred for this call because the task
   * pre-fork already owns it (it emits the start when the run acquires a concurrency
   * slot). Without this, the eager start fires at the top of the tool phase — TanStack
   * runs tools in parallel — and the row times while a queued subagent merely waits.
   */
  isTaskToolStartDeferred?: (toolCallId: string) => boolean;
}

export function createExtensionsMiddleware(deps: ExtensionsMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  // Collect modified results per toolCallId from tool:after interceptors during this run.
  // Applied to the model-facing results in onToolPhaseComplete (which runs before TanStack
  // builds the tool-result messages), because onAfterToolCall returns void and cannot
  // rewrite the result back to the model (TanStack 0.43.1 API constraint).
  const modifiedResults = new Map<string, unknown>();

  return defineMiddleware("tools", {
    name: "extensions",
    onBeforeToolCall: async (_ctx, hookCtx) => {
      // A pre-forked `task` emits its own start when it is admitted (see task-prefork);
      // emitting here too would start the row's clock while a queued run still waits.
      const deferStart = hookCtx.toolName === "task" && deps.isTaskToolStartDeferred?.(hookCtx.toolCallId) === true;
      if (!deferStart) {
        deps.emitEvent?.("agent:tool-start", {
          tool_name: hookCtx.toolName,
          tool_call_id: hookCtx.toolCallId,
          tool_input: hookCtx.args,
          timestamp: Date.now(),
        });
      }

      const runner = deps.getExtensionRunner();
      if (!runner) return;

      const eventBus = runner.getEventBus();
      const event: ToolBeforeEvent = {
        type: `tool:before:${hookCtx.toolName}`,
        payload: {
          toolName: hookCtx.toolName,
          args: hookCtx.args,
          sessionId: deps.getSessionId(),
        },
        defaultReturn: undefined,
      };

      await eventBus.emit(event);

      if (event.skip) {
        return {
          type: "skip",
          result: { error: event.reason ?? "Tool denied by extension" },
        };
      }

      if (event.modifiedArgs !== undefined) {
        return {
          type: "transformArgs",
          args: event.modifiedArgs,
        };
      }

      return;
    },
    onAfterToolCall: async (_ctx, info) => {
      if (info.ok && info.toolName === "todo") {
        deps.getTodoManager?.()?.resetRoundCounter();
      }

      // Lifecycle bus always fires; ExtensionEventBus interception is optional.
      if (info.ok) {
        deps.emitEvent?.("agent:tool-end", {
          tool_name: info.toolName,
          tool_call_id: info.toolCallId,
          duration_ms: info.duration,
          tool_output: info.result,
          // `info.ok` only means the tool RETURNED — a tool that catches its own abort
          // returns normally (`run_command` settles with `cancelled: true` + partial
          // stdout, `task` with `aborted: true`), so the return alone cannot tell a
          // cancel from a success. Read the verdict off the output, the same marker
          // the render layer uses, so one semantic does not get two readers.
          cancelled: isCancelledOutputMarker(info.result),
          timestamp: Date.now(),
        });
      } else {
        deps.emitEvent?.("agent:tool-error", {
          tool_name: info.toolName,
          tool_call_id: info.toolCallId,
          error: info.error instanceof Error ? info.error.message : String(info.error),
          // A user abort reaches here as a throw, indistinguishable from a fault unless we
          // ask the run's signal. Consumers counting failures must not count cancels, and
          // the log bridge must not report one as an error.
          cancelled: isAbortError(info.error, deps.getAbortSignal?.()),
          timestamp: Date.now(),
        });
      }

      const runner = deps.getExtensionRunner();
      if (!runner) return;

      const eventBus = runner.getEventBus();

      if (info.ok) {
        const event: ToolAfterEvent = {
          type: `tool:after:${info.toolName}`,
          payload: {
            toolName: info.toolName,
            args: info.toolCall.function.arguments,
            result: info.result,
            durationMs: info.duration,
          },
          defaultReturn: undefined,
        };
        await eventBus.emit(event);

        // If an interceptor set modifiedResult, stash it for onToolPhaseComplete (we cannot
        // return it from onAfterToolCall — that hook returns void in TanStack 0.43.1).
        if (event.payload.modifiedResult !== undefined) {
          modifiedResults.set(info.toolCallId, event.payload.modifiedResult);
        }
      } else {
        await eventBus.emit({
          type: `tool:error:${info.toolName}`,
          payload: {
            toolName: info.toolName,
            args: info.toolCall.function.arguments,
            error: info.error instanceof Error ? info.error.message : String(info.error),
          },
          defaultReturn: undefined,
        });
      }
    },
    // Runs before TanStack builds the tool-result messages for the model's next turn
    // (buildToolResultChunks). Mutating info.results[].result here rewrites what the
    // model sees. Clear the per-run stash afterwards.
    onToolPhaseComplete: async (_ctx, info) => {
      if (modifiedResults.size === 0) return;
      for (const result of info.results) {
        const modified = modifiedResults.get(result.toolCallId);
        if (modified !== undefined) {
          result.result = modified;
        }
      }
      modifiedResults.clear();
    },
  });
}

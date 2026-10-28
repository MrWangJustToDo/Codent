import { BUILTIN_TOOL_NAMES } from "../../agent/tools/catalog/tool-names.js";
import { isAbortError, isCancelledOutputMarker } from "../../runtime-types/abort.js";
import { errorMessage } from "../../utils/errors.js";

import { defineMiddleware } from "./phase.js";

import type { ExtensionRunner } from "../../agent/extension/runner.js";
import type { ToolAfterEvent, ToolBeforeEvent } from "../../agent/extension/types.js";
import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { EmitAgentTelemetryFn } from "../telemetry/emit-agent-telemetry.js";
import type { ChatMiddleware } from "@tanstack/ai";

export interface ExtensionsMiddlewareDeps {
  getExtensionRunner: () => ExtensionRunner | null;
  getSessionId: () => string;
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
  /** Called when a `run_command` settles, so its live command preview can be marked ended. */
  onToolSettled?: (toolCallId: string) => void;
  /**
   * Whether this tool's calls are approval-gated (the engine decided on the ORIGINAL input before
   * this hook ever ran). Paired with the pre-forked `task` rule below, it is what makes an
   * argument rewrite safe to apply: a gated call cannot honour one, because "approved A, ran B"
   * would be indistinguishable from a legitimate call.
   */
  isApprovalGated?: (toolName: string) => boolean;
  /** Report a refused rewrite, so a policy rejection is not silent. */
  onArgRewriteRefused?: (toolName: string) => void;
}

/**
 * Whether an interceptor's `modifiedArgs` may replace this call's arguments.
 *
 * Two shapes refuse it, for different reasons and with the same verdict (run the original args):
 * an approval-gated tool had its approval + command-safety decision computed from the original
 * input, and a pre-forked `task` started its subagent on the original args at `TOOL_CALL_END` — a
 * rewrite would be silently ignored by the run while the model believes it took effect.
 */
function canRewriteArgs(deps: ExtensionsMiddlewareDeps, toolName: string): boolean {
  if (toolName === BUILTIN_TOOL_NAMES.task) return false;
  return deps.isApprovalGated?.(toolName) !== true;
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
      const deferStart =
        hookCtx.toolName === BUILTIN_TOOL_NAMES.task && deps.isTaskToolStartDeferred?.(hookCtx.toolCallId) === true;
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
        // A marker, not `{ error }`: the row is rendered by `formatToolOutput`, which must be able
        // to tell "an extension refused this" from "the tool failed" without reading a schema the
        // refusal does not have. `cancelled: false` keeps it out of the cancel rendering.
        return {
          type: "skip",
          result: {
            success: false,
            cancelled: false,
            denied: true,
            error: event.reason ?? "Tool denied by extension",
          },
        };
      }

      if (event.modifiedArgs !== undefined) {
        // An approval-gated call was already decided on `hookCtx.args`; a preforked `task` already
        // started on them. Rewriting now cannot be honoured honestly, so keep the original args.
        if (!canRewriteArgs(deps, hookCtx.toolName)) {
          deps.onArgRewriteRefused?.(hookCtx.toolName);
          return;
        }
        return {
          type: "transformArgs",
          args: event.modifiedArgs,
        };
      }

      return;
    },
    onAfterToolCall: async (_ctx, info) => {
      // Only run_command owns command stream snapshots. Calling this for every tool would grow the
      // hub's closed-id tombstone set with read_file/grep/task ids that can never have a stream.
      if (info.toolName === BUILTIN_TOOL_NAMES.runCommand) deps.onToolSettled?.(info.toolCallId);

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
          error: errorMessage(info.error),
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
        const eventType = `tool:after:${info.toolName}` as const;
        const event: ToolAfterEvent = {
          type: eventType,
          payload: {
            toolName: info.toolName,
            args: info.toolCall.function.arguments,
            // Interceptors observe a DETACHED copy when one is listening: a tool result is stored
            // on the channel (and persisted to the session log) immediately afterwards, so an
            // in-place edit of the "shared mutable" payload used to rewrite durable history. The
            // supported way to change what the model sees is `modifiedResult`.
            result: eventBus.hasInterceptors(eventType) ? cloneForInterceptors(info.result) : info.result,
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
            error: errorMessage(info.error),
          },
          defaultReturn: undefined,
        });
      }
    },
    // Runs before TanStack builds the tool-result messages for the model's next turn
    // (buildToolResultChunks). Mutating info.results[].result here rewrites what the
    // model sees. Clear the per-run stash afterwards.
    // A run that aborts/errors inside the tool phase never reaches onToolPhaseComplete, so its
    // interceptor-modified results (potentially large payloads) would stay in the per-agent map
    // for the life of the process — and their ids can never match a later result.
    onAbort: () => {
      modifiedResults.clear();
    },
    onError: () => {
      modifiedResults.clear();
    },
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

/**
 * Detach a tool result before handing it to interceptors.
 *
 * `structuredClone` is the cheap, correct guard for the shapes tool results actually have (plain
 * JSON data). A non-cloneable payload (a host object a tool attached) falls back to the original:
 * that restores the old behaviour for that tool rather than dropping the interceptor's view.
 */
function cloneForInterceptors(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

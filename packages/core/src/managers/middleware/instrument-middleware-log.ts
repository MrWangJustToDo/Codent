import { hookEchoesEnabled } from "../../agent/log/hooks-echo.js";

import type { EmitAgentTelemetryFn } from "../../runtime-types/agent-events.js";
import type { ChatMiddleware, ChatMiddlewareContext } from "@tanstack/ai";

/**
 * Instrumentation for the middleware pipeline — not a middleware factory, but it stays in
 * `managers/middleware/` deliberately. Unlike `synthetic-injection.ts` (whose dependencies all
 * live under `agent/`, so it belongs there), this module is *about* the pipeline the manager
 * layer assembles: it wraps an already-built `ChatMiddleware[]` and its sole consumer is
 * `buildAgentRunner` (`managers/run-agent.ts`), the same function that owns the phase sort. Its
 * one import is type-only from `runtime-types` (the emit port), so moving it to `agent/` would
 * place pipeline-assembly knowledge in the domain layer to satisfy a filename convention.
 *
 * `phase.ts` and `wire-projection-cache.ts` sit here for the same reason: the name of the file
 * states what it does, and what it does is a manager-layer concern.
 */

/**
 * Middleware hooks recorded by {@link instrumentMiddlewareLog}. High-frequency
 * `onChunk` (every streamed chunk) and the nested `sandbox` file hooks are
 * intentionally excluded to avoid log noise.
 */
const LOGGED_HOOK_KEYS = [
  "setup",
  "onConfig",
  "onStructuredOutputConfig",
  "onStart",
  "onIteration",
  "onShouldContinue",
  "onBeforeToolCall",
  "onAfterToolCall",
  "onToolPhaseComplete",
  "onUsage",
  "onFinish",
  "onAbort",
  "onError",
  "onInterruptBoundary",
  "onInterruptResolution",
] as const;

/**
 * Wrap every middleware hook so each invocation publishes a `hooks:echo` event. Return
 * values are passed through untouched (including async/promise hooks and transformed
 * configs/chunks). Middleware names are preserved via `ChatMiddleware.name` (falls back
 * to `anonymous`).
 *
 * The echoes are opt-in (`MY_AGENT_LOG_HOOKS`). The emitter asks the policy predicate before it
 * builds anything (`agent/log/hooks-echo.ts`): the event is observable, so an unconditional emit
 * reached every `observeAny` subscriber with the flag off, and the decision still has one owner.
 */
export function instrumentMiddlewareLog<TContext>(
  middleware: ChatMiddleware<TContext>[],
  emitEvent: EmitAgentTelemetryFn
): ChatMiddleware<TContext>[] {
  return middleware.map((mw) => {
    const name = mw.name ?? "anonymous";
    const wrapped: ChatMiddleware<TContext> = { ...mw };

    for (const hook of LOGGED_HOOK_KEYS) {
      const fn = (mw as Record<string, unknown>)[hook];
      if (typeof fn !== "function") continue;

      (wrapped as Record<string, unknown>)[hook] = (
        ctx: ChatMiddlewareContext<TContext>,
        ...rest: unknown[]
      ): unknown => {
        // Ask the policy before building anything: the echo is observable, so an unconditional emit
        // delivered every hook to `observeAny` subscribers even with `MY_AGENT_LOG_HOOKS` unset.
        if (hookEchoesEnabled()) {
          emitEvent("hooks:echo", {
            middleware: name,
            hook,
            ...(ctx.phase !== undefined ? { phase: String(ctx.phase) } : {}),
            ...(ctx.iteration !== undefined ? { iteration: ctx.iteration } : {}),
          });
        }
        return (fn as (...args: unknown[]) => unknown).call(mw, ctx, ...rest);
      };
    }

    return wrapped;
  });
}

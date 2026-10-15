import type { AgentLog } from "../../agent/agent-log";
import type { ChatMiddleware, ChatMiddlewareContext } from "@tanstack/ai";

/**
 * Instrumentation for the middleware pipeline — not a middleware factory, but it stays in
 * `managers/middleware/` deliberately. Unlike `synthetic-injection.ts` (whose dependencies all
 * live under `agent/`, so it belongs there), this module is *about* the pipeline the manager
 * layer assembles: it wraps an already-built `ChatMiddleware[]` and its sole consumer is
 * `buildAgentRunner` (`managers/run-agent.ts`), the same function that owns the phase sort. Its
 * one import is type-only from `agent/agent-log` (the emission seam), so moving it to `agent/`
 * would place pipeline-assembly knowledge in the domain layer to satisfy a filename convention.
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
 * Whether hook-call echo logging is enabled. Opt-in via `MY_AGENT_LOG_HOOKS` —
 * evaluated lazily so tests and hosts can toggle it at runtime. Hook echoes are
 * pure structural noise by default; lifecycle logging does not depend on them.
 */
function hookEchoesEnabled(): boolean {
  const raw =
    typeof process !== "undefined" && typeof process.env !== "undefined" ? process.env.MY_AGENT_LOG_HOOKS : undefined;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Wrap every middleware hook so each invocation is recorded to the agent log
 * (category `hooks`, debug level) when `MY_AGENT_LOG_HOOKS` is set. Return
 * values are passed through untouched (including async/promise hooks and
 * transformed configs/chunks). Middleware names are preserved via
 * `ChatMiddleware.name` (falls back to `anonymous`).
 */
export function instrumentMiddlewareLog<TContext>(
  middleware: ChatMiddleware<TContext>[],
  log: AgentLog
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
        if (hookEchoesEnabled()) {
          log.debug("hooks", `middleware:${name}:${hook}`, {
            phase: ctx.phase,
            iteration: ctx.iteration,
          });
        }
        return (fn as (...args: unknown[]) => unknown).call(mw, ctx, ...rest);
      };
    }

    return wrapped;
  });
}

/**
 * Link an optional external AbortSignal + timeout to a single AbortController.
 * Always pass {@link AbortController.signal} to fetch.
 *
 * The timeout aborts with an `ExecutionError("timeout")` REASON rather than a bare
 * `controller.abort()`. Without a reason, `fetch` rejects with the platform default
 * (`DOMException` named `AbortError`), and `isAbortError` accepts that by `name` alone —
 * so a pure timeout settled as "cancelled by user" and the model was told
 * `[Search cancelled by user.] <query>` for a search nobody stopped. A reason makes the
 * local producer say what actually happened, matching the shape CoreEnv's exec contract
 * already uses for `run_command` timeouts.
 */

import { ExecutionError } from "../../../env/types";

export function createTimeoutAbort(options: { timeoutMs: number; signal?: AbortSignal }): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new ExecutionError("timeout", `Request timed out after ${options.timeoutMs}ms`)),
    options.timeoutMs
  );

  const onAbort = () => controller.abort(options.signal?.reason);
  const external = options.signal;
  if (external) {
    if (external.aborted) {
      controller.abort(external.reason);
    } else {
      external.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    controller,
    cleanup: () => {
      clearTimeout(timeoutId);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Enforce a declared deadline around a tool body and hand it a signal that aborts when the
 * deadline elapses.
 *
 * This is the one implementation behind both registration paths
 * (`defineServerTool`'s `timeoutMs` and `ExtensionToolDefinition.timeoutMs`), so a timeout
 * always settles the same way:
 *
 * - **A timeout is a failure, not a cancel.** The deadline aborts via
 *   {@link createTimeoutAbort}, so the reason is `ExecutionError("timeout", …)` and
 *   `isAbortError` does not read it as a user stop.
 * - **The run signal outranks the deadline.** The run signal is consulted before the deadline
 *   verdict: once `options.signal` is aborted the call rejects as a cancel even if the timer
 *   also fired (classification is signal-first, mirroring `isAbortError`).
 * - **Race, not just a signal.** A body that ignores its signal is still bounded, because the
 *   operation races the deadline rather than relying on the tool to observe it.
 *
 * `timeoutMessage` lets a caller name the budget in the failure (an extension tool names
 * itself); otherwise the shared `Request timed out after Nms` wording is used.
 */
export async function withTimeoutAbort<T>(
  operation: (signal: AbortSignal) => Promise<T> | T,
  options: { timeoutMs: number; signal?: AbortSignal; timeoutMessage?: string }
): Promise<T> {
  const { controller, cleanup } = createTimeoutAbort(options);
  const runSignal = options.signal;

  // Rejections must be `Error`s (typed across boundaries); production cancels carry a
  // bare string reason (`managed.abort("user-cancelled")`), which must not leak as one.
  const asError = (reason: unknown, fallback: string): Error =>
    reason instanceof Error ? reason : new Error(typeof reason === "string" && reason ? reason : fallback);

  const reasonFor = (): Error => {
    // A run abort (whichever fired first) is always a cancel — never the deadline error.
    if (runSignal?.aborted) return asError(runSignal.reason, "aborted");
    const reason = controller.signal.reason;
    if (options.timeoutMessage && reason instanceof ExecutionError && reason.code === "timeout") {
      return new ExecutionError("timeout", options.timeoutMessage);
    }
    return asError(reason, "aborted");
  };

  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const claim = (): boolean => {
        if (settled) return false;
        settled = true;
        controller.signal.removeEventListener("abort", onAbort);
        return true;
      };
      function onAbort(): void {
        // Defer the rejection one microtask. A body that observes the same abort and settles
        // in its own listener (e.g. resolves its partial output with `cancelled: true`) has
        // already queued that resolution when the abort dispatched, so it wins here.
        // Rejecting synchronously would preempt that graceful-cancel result and turn a
        // tool-caught cancel back into a thrown one.
        queueMicrotask(() => {
          if (claim()) reject(reasonFor());
        });
      }
      // Start the operation first so any abort listener it registers is dispatched before ours.
      const operationPromise = Promise.resolve(operation(controller.signal));
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
      operationPromise.then(
        (value) => {
          if (claim()) resolve(value);
        },
        (error) => {
          if (claim()) reject(error);
        }
      );
    });
  } finally {
    cleanup();
  }
}

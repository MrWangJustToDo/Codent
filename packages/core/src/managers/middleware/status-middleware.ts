/**
 * Agent status middleware — status transitions only.
 *
 * Usage tracking, memory commit, run finalization, and stream events live in
 * {@link createLifecycleMiddleware}. Compaction calls {@link AgentStatusController}
 * directly via {@link createCompactionMiddleware}.
 */

import { errorMessage } from "../../utils/errors.js";

import { defineMiddleware } from "./phase.js";

import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { AgentStatusController } from "../../runtime-types";
import type { RunToken } from "../run-coordinator.js";
import type { ChatMiddleware } from "@tanstack/ai";

// ============================================================================
// Status middleware
// ============================================================================

export interface StatusMiddlewareDeps {
  status: AgentStatusController;
  onApprovalRequested?: (approvalId: string, toolCallId: string) => void;
  /**
   * Currency of the run that is current when a stream starts.
   *
   * The runner (and therefore this middleware) is cached across runs, so a hook carries no run
   * identity of its own. Capturing the token at `onStart` — keyed by the per-`chat()` context
   * object, which is stable for one stream — is what lets a superseded stream's late
   * `onAbort`/`onError`/`onChunk` be ignored instead of rewriting the status of the run that
   * replaced it (`aborted` is sticky: every later chunk is dropped and the turn is reported as a
   * user cancel).
   */
  getRunToken?: () => RunToken | null;
}

export function createStatusMiddleware(deps: StatusMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  /**
   * The run each stream belongs to, keyed by the run context TanStack hands every hook.
   *
   * Weak so a finished stream's entry disappears with its context. `undefined` (no entry) means
   * "no token was available when this stream started" — the guard is opt-in, so hosts and
   * subagent paths that never begin a run keep their current behavior.
   */
  const streamRuns = new WeakMap<object, RunToken>();
  const isSuperseded = (ctx: unknown): boolean => {
    if (typeof ctx !== "object" || ctx === null) return false;
    const token = streamRuns.get(ctx);
    return token !== undefined && !token.isCurrent;
  };

  return defineMiddleware("observe", {
    name: "status",
    onStart: (ctx) => {
      const token = deps.getRunToken?.() ?? null;
      // Record BEFORE the staleness check: a stream that starts after its run was superseded must
      // not claim the new one, and it must also have its LATER hooks skipped — an entry is what
      // `isSuperseded` reads, so returning without one would let its `onAbort` through.
      if (token && typeof ctx === "object" && ctx !== null) streamRuns.set(ctx, token);
      if (token && !token.isCurrent) return;
      deps.status.onRunStart();
    },
    onChunk: (ctx, chunk) => {
      if (isSuperseded(ctx)) return chunk;
      return deps.status.onStreamChunk(chunk);
    },
    onFinish: (ctx, info) => {
      if (isSuperseded(ctx)) return;
      deps.status.onRunFinish(info.finishReason);
    },
    onAbort: (ctx) => {
      if (isSuperseded(ctx)) return;
      deps.status.onRunAbort();
    },
    onError: (ctx, info) => {
      if (isSuperseded(ctx)) return;
      const message = errorMessage(info.error);
      deps.status.onRunError(message);
    },
    onToolPhaseComplete: async (ctx, info) => {
      if (isSuperseded(ctx)) return;
      deps.status.syncApprovals(info.needsApproval);
      for (const approval of info.needsApproval) {
        if (!approval.approvalId || !approval.toolCallId) continue;
        deps.onApprovalRequested?.(approval.approvalId, approval.toolCallId);
      }
    },
    onBeforeToolCall: async (ctx) => {
      if (isSuperseded(ctx)) return;
      deps.status.onBeforeToolCall();
      return;
    },
  });
}

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
import type { ChatMiddleware } from "@tanstack/ai";

// ============================================================================
// Status middleware
// ============================================================================

export interface StatusMiddlewareDeps {
  status: AgentStatusController;
  onApprovalRequested?: (approvalId: string, toolCallId: string) => void;
}

export function createStatusMiddleware(deps: StatusMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  return defineMiddleware("observe", {
    name: "status",
    onStart: () => {
      deps.status.onRunStart();
    },
    onChunk: (_ctx, chunk) => deps.status.onStreamChunk(chunk),
    onFinish: (_ctx, info) => {
      deps.status.onRunFinish(info.finishReason);
    },
    onAbort: () => {
      deps.status.onRunAbort();
    },
    onError: (_ctx, info) => {
      const message = errorMessage(info.error);
      deps.status.onRunError(message);
    },
    onToolPhaseComplete: async (_ctx, info) => {
      deps.status.syncApprovals(info.needsApproval);
      for (const approval of info.needsApproval) {
        if (!approval.approvalId || !approval.toolCallId) continue;
        deps.onApprovalRequested?.(approval.approvalId, approval.toolCallId);
      }
    },
    onBeforeToolCall: async () => {
      deps.status.onBeforeToolCall();
      return;
    },
  });
}

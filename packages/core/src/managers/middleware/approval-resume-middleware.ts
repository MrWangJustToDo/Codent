/**
 * Rebuild TanStack `resumeToolState.approvals` from the session approval table.
 *
 * `onConfig` is shallow-merged, so this composes with compaction `{ messages }`.
 *
 * Only ANSWERED rows become resolutions. `pending` rows deliberately stay out: the engine must still
 * interrupt on them, and the mode-level auto-approval path writes its decision through
 * `ApprovalDecisionCoordinator` (channel + table) before the pump resumes — the engine-side map is
 * not a second place to invent one.
 */

import { approvalsToResumeMap } from "../../agent/approval/tool-approval-table.js";
import { defineMiddleware } from "../../runtime-types/middleware-phase.js";

import type { ToolApprovalRecord } from "../../agent/persistence/types.js";
import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { ChatMiddleware } from "@tanstack/ai";

export interface ApprovalResumeMiddlewareDeps {
  getApprovals: () => readonly ToolApprovalRecord[];
}

export function createApprovalResumeMiddleware(deps: ApprovalResumeMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  return defineMiddleware("observe", {
    name: "approval-resume",
    onConfig: async (_ctx, config) => {
      const approvals = approvalsToResumeMap(deps.getApprovals());
      if (approvals.size === 0) return;

      return {
        resumeToolState: {
          ...config.resumeToolState,
          approvals,
        },
      };
    },
  });
}

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
import { hasValidToolArguments } from "../../agent/stream/incomplete-tool-calls.js";
import { isSettledToolCallPart, isToolCallPart } from "../../agent/stream/message-parts.js";
import { CLIENT_TOOL_NAMES } from "../../agent/tools/catalog/tool-names.js";
import { defineMiddleware } from "../../runtime-types/middleware-phase.js";

import type { ToolApprovalRecord } from "../../agent/persistence/types.js";
import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { EmitAgentTelemetryFn } from "../telemetry/emit-agent-telemetry.js";
import type { ChatMiddleware, ToolApprovalResolution, UIMessage } from "@tanstack/ai";

export interface ApprovalResumeMiddlewareDeps {
  getApprovals: () => readonly ToolApprovalRecord[];
  /**
   * The live transcript (the UI channel), used to scope each answered row to the call it decided.
   *
   * A provider can reuse a tool-call id in a later request, so the id alone cannot say whether
   * the decision belongs to the call currently being resumed. See `approvalsToResumeMap`.
   */
  getMessages: () => readonly UIMessage[];
  /**
   * Timeline sink for the diagnostic `tool:resume` row (held siblings re-added to the batch).
   * Optional so a standalone harness (validator) can construct the middleware without a bus.
   */
  emitEvent?: EmitAgentTelemetryFn;
}

export function createApprovalResumeMiddleware(deps: ApprovalResumeMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  return defineMiddleware("observe", {
    name: "approval-resume",
    onConfig: async (_ctx, config) => {
      const approvals = approvalsToResumeMap(deps.getApprovals(), deps.getMessages());
      if (approvals.size === 0) return;

      // TanStack resumes a parked batch through this map, and its pending-call scan keeps a call
      // "active" only until the next non-tool message. A synthetic `<ctx kind=…>` user block
      // injected after the assistant (turn context, reminder, background pointer) therefore hides
      // every plain sibling in the batch; only entries present in the map are still resumed. Add
      // the held siblings so answering the gate releases the WHOLE batch, as the engine contract
      // promises — otherwise the plain call is never run and its row spins until turn end.
      const resumed = addHeldSiblings(approvals, deps.getMessages());
      if (resumed.length > 0) deps.emitEvent?.("tool:resume", { calls: resumed, count: resumed.length });

      return {
        resumeToolState: {
          ...config.resumeToolState,
          approvals,
        },
      };
    },
  });
}

/**
 * Calls that the parked batch held next to the answered gate.
 *
 * Shape: a server tool in the same assistant message as a live answered approval, with complete
 * arguments and no result. Approval-gated calls are already in the table map; client tools
 * (`ask_user`) resume through their own channel, so both are excluded. The value is irrelevant for
 * them (`executeToolCalls` only reads it for `needsApproval` tools); its presence is what makes the
 * engine treat the call as explicitly resumed.
 */
function addHeldSiblings(
  approvals: Map<string, ToolApprovalResolution>,
  messages: readonly UIMessage[]
): Array<{ id: string; name?: string }> {
  const resumed: Array<{ id: string; name?: string }> = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const hasLiveAnsweredApproval = message.parts.some(
      (part) =>
        isToolCallPart(part) &&
        part.approval?.approved !== undefined &&
        !isSettledToolCallPart(part) &&
        // Only a gate the table actually resumed may release siblings: an answered part with a
        // reused/stale approval id (not in the map) is about to be settled, not executed.
        approvals.has(part.id)
    );
    if (!hasLiveAnsweredApproval) continue;
    for (const part of message.parts) {
      if (!isToolCallPart(part)) continue;
      if (part.approval?.needsApproval === true) continue;
      if (part.output !== undefined || isSettledToolCallPart(part)) continue;
      if (part.state !== "input-complete" || !hasValidToolArguments(part)) continue;
      if (CLIENT_TOOL_NAMES.has(part.name)) continue;
      if (approvals.has(part.id)) continue;
      approvals.set(part.id, true);
      resumed.push(part.name ? { id: part.id, name: part.name } : { id: part.id });
    }
  }
  return resumed;
}

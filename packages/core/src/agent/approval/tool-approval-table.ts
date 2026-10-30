/**
 * In-memory session approval table and resume-map helpers.
 *
 * SoT for interrupt decisions across `chat()` / process restart. Channel
 * tool-call parts remain the transcript; this table feeds `resumeToolState`.
 */

import { isToolCallPart } from "../stream/message-parts.js";

import type { ToolApprovalSource } from "../../runtime-types/agent-event-payloads.js";
import type { ToolApprovalRecord, ToolApprovalStatus } from "../persistence/types.js";
import type { ToolApprovalResolution, ToolCallPart, UIMessage } from "@tanstack/ai";

export interface UpsertToolApprovalInput {
  id: string;
  toolCallId: string;
  status: ToolApprovalStatus;
  reason?: string;
  updatedAt?: number;
  /** Tool name when the caller knows it — forwarded to the resolved callback. */
  toolName?: string;
  /**
   * Who decided. Carried to the resolved callback only — it is NOT persisted with the record, so the
   * session schema and the restore path are unchanged.
   */
  source?: ToolApprovalSource;
  /**
   * Narrow override: `"deny"` may replace an existing `approved` row with a denial.
   *
   * The table is first-decision-wins so a late client answer cannot undo a decision that was
   * already acted on. A command-safety denial is the exception: it can resolve AFTER the request
   * was published (the analyzer awaits CoreEnv), and it is strictly stricter than the approval it
   * replaces. Literal `"deny"` — there is no way to express "override a denial with an approval".
   */
  overwrite?: "deny";
}

/** One real pending → approved/denied transition, as reported to `onResolved`. */
export interface ToolApprovalDecisionEvent {
  approvalId: string;
  toolCallId: string;
  decision: "approved" | "denied";
  reason?: string;
  toolName?: string;
  /** Who decided; in-memory only (never persisted with the record). */
  source?: ToolApprovalSource;
}

function statusRank(status: ToolApprovalStatus): number {
  if (status === "pending") return 0;
  return 1;
}

/** In-memory approval rows keyed by toolCallId (latest decision wins). */
export class ToolApprovalTable {
  private readonly byToolCallId = new Map<string, ToolApprovalRecord>();

  /** Invoked once per actual resolution (pending → approved/denied); not on restore. */
  private readonly onResolved?: (resolution: ToolApprovalDecisionEvent) => void;

  constructor(options?: { onResolved?: (resolution: ToolApprovalDecisionEvent) => void }) {
    this.onResolved = options?.onResolved;
  }

  restore(records: readonly ToolApprovalRecord[]): void {
    this.byToolCallId.clear();
    for (const record of records) {
      this.byToolCallId.set(record.toolCallId, { ...record });
    }
  }

  clear(): void {
    this.byToolCallId.clear();
  }

  toArray(): ToolApprovalRecord[] {
    return [...this.byToolCallId.values()].map((record) => ({ ...record }));
  }

  upsert(input: UpsertToolApprovalInput): ToolApprovalRecord {
    const existing = this.byToolCallId.get(input.toolCallId);
    // A command-safety denial may replace an approval that raced it (see `overwrite`). Only
    // approved → denied, and only when the caller asks for it explicitly.
    const forcedDeny = input.overwrite === "deny" && existing?.status === "approved" && input.status === "denied";
    // First decision wins. An answered row is final: a second answer (late client response, or a
    // deny racing an auto-approval batch) used to overwrite it because approved and denied have
    // the same rank, which let a late `allow` contradict a denial already written to the channel.
    if (existing && existing.status !== "pending" && !forcedDeny) {
      return { ...existing };
    }
    // Do not downgrade an answered decision back to pending.
    if (existing && statusRank(input.status) < statusRank(existing.status)) {
      return { ...existing };
    }

    const record: ToolApprovalRecord = {
      id: input.id,
      toolCallId: input.toolCallId,
      status: input.status,
      updatedAt: input.updatedAt ?? Date.now(),
      ...(input.status === "denied" && input.reason ? { reason: input.reason } : {}),
    };
    this.byToolCallId.set(input.toolCallId, record);

    // Resolution event: only on a real pending → approved/denied transition (or the forced
    // approval → denial above, which is a real change of verdict and must be visible).
    const resolves = input.status !== "pending" && (!existing || existing.status === "pending" || forcedDeny);
    if (resolves && this.onResolved) {
      this.onResolved({
        approvalId: input.id,
        toolCallId: input.toolCallId,
        decision: input.status === "denied" ? "denied" : "approved",
        reason: input.reason,
        toolName: input.toolName,
        ...(input.source ? { source: input.source } : {}),
      });
    }

    return { ...record };
  }
}

/**
 * Derive the approval table from UIMessage approval parts.
 *
 * Approval state is not stored separately: the message log is the source of
 * truth and this reconstructs the table on load. `approvalTimes` (toolCallId →
 * epoch ms) carries the real decision time recorded in the log; when absent,
 * `now` is used.
 */
export function normalizeSessionApprovals(
  session: { uiMessages?: UIMessage[]; approvalTimes?: Record<string, number> },
  now = Date.now()
): ToolApprovalRecord[] {
  return backfillApprovalsFromUIMessages(session.uiMessages ?? [], now, session.approvalTimes);
}

export function backfillApprovalsFromUIMessages(
  messages: UIMessage[],
  now = Date.now(),
  approvalTimes?: Record<string, number>
): ToolApprovalRecord[] {
  const table = new ToolApprovalTable();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!isToolCallPart(part) || !part.approval?.id) continue;
      const record = recordFromToolCallPart(part, approvalTimes?.[part.approval.id] ?? now);
      if (record) table.upsert(record);
    }
  }
  return table.toArray();
}

export function recordFromToolCallPart(part: ToolCallPart, now = Date.now()): UpsertToolApprovalInput | null {
  const approval = part.approval;
  if (!approval?.id) return null;

  if (approval.needsApproval === true && approval.approved === undefined) {
    return { id: approval.id, toolCallId: part.id, status: "pending", updatedAt: now };
  }
  if (approval.approved === true) {
    return { id: approval.id, toolCallId: part.id, status: "approved", updatedAt: now };
  }
  if (approval.approved === false) {
    const extra = approval as { reason?: unknown };
    const reason = typeof extra.reason === "string" ? extra.reason : undefined;
    return { id: approval.id, toolCallId: part.id, status: "denied", reason, updatedAt: now };
  }
  return null;
}

/**
 * Translate answered rows into TanStack `resumeToolState.approvals`.
 * Pending rows are omitted so `executeToolCalls` still interrupts.
 */
export function approvalsToResumeMap(records: readonly ToolApprovalRecord[]): Map<string, ToolApprovalResolution> {
  const approvals = new Map<string, ToolApprovalResolution>();

  for (const record of records) {
    if (record.status === "pending") continue;

    const resolution: ToolApprovalResolution =
      record.status === "approved"
        ? true
        : {
            approved: false,
            ...(record.reason ? { payload: { reason: record.reason } } : {}),
          };

    setResumeKeys(approvals, record, resolution);
  }

  return approvals;
}

function setResumeKeys(
  approvals: Map<string, ToolApprovalResolution>,
  record: ToolApprovalRecord,
  resolution: ToolApprovalResolution
): void {
  approvals.set(record.id, resolution);
  approvals.set(record.toolCallId, resolution);
  const prefixed = `approval_${record.toolCallId}`;
  if (prefixed !== record.id) {
    approvals.set(prefixed, resolution);
  }
}

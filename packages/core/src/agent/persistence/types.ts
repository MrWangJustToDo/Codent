/**
 * Session Types - Type definitions for session persistence and resume.
 *
 * Each session is one append-only JSONL message log
 * `.agents/sessions/{id}.session.jsonl`. Every line is one message plus a full
 * snapshot of the non-message session state at that point; `load()` folds the
 * lines by message id (later line wins). There is no separate snapshot file.
 *
 * Timestamps on a message live ON the message: `message.createdAt` (creation)
 * and `message.updatedAt` (last content change / decision). v6 kept the line's
 * write time and the approval decision times as line-level fields
 * (`messageUpdatedAt` / `approvalAt`) — still read for legacy logs, never
 * written.
 */

import { z } from "zod";

import type { ModelStyle, ReasoningEffort } from "../../models/types.js";
import type { TokenUsage } from "../../runtime-types/token-usage.js";
import type { PlanModeState } from "../plan/plan-mode-controller.js";
import type { TodoItem } from "../todo";
import type { UIMessage as TanStackUIMessage } from "@tanstack/ai";

// ============================================================================
// Constants
// ============================================================================

/** v6: one append-only message log per session; no snapshot file. v7: message timestamps. */
export const SESSION_VERSION = 7;
export const SESSION_DIR = ".agents/sessions";
/** Append-only message log suffix; the single source of truth per session. */
export const SESSION_LOG_SUFFIX = ".session.jsonl";
/** Log line kind: one message + the full non-message state snapshot at that point. */
export const SESSION_LOG_MESSAGE = "message";

/** Directory for per-session AgentLog JSONL files: `.agents/logs/{sessionId}/`. */
export const AGENT_LOG_DIR = ".agents/logs";

/**
 * Whether this reader understands a log written with `version`.
 *
 * Only *newer* formats are rejected: their line/state shape may differ, so folding
 * them would silently produce a wrong session. Older versions are accepted (their
 * extra fields are optional, and a fold only reads what it knows). A missing or
 * malformed version is rejected too — it is not trustworthy enough to fold. Logs
 * written by a newer version are skipped by `list()` and `load()` — like the
 * legacy `.session.json` files, they are not migrated.
 */
export function isSupportedSessionVersion(version: unknown): boolean {
  return typeof version === "number" && Number.isInteger(version) && version > 0 && version <= SESSION_VERSION;
}

// ============================================================================
// Session Data Schema
// ============================================================================

export const sessionMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  modelStyle: z.enum(["openai", "anthropic"]),
  model: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type SessionMeta = z.infer<typeof sessionMetaSchema>;

export const toolApprovalStatusSchema = z.enum(["pending", "approved", "denied"]);

export const toolApprovalRecordSchema = z.object({
  id: z.string(),
  toolCallId: z.string(),
  status: toolApprovalStatusSchema,
  reason: z.string().optional(),
  updatedAt: z.number(),
});

export type ToolApprovalStatus = z.infer<typeof toolApprovalStatusSchema>;
export type ToolApprovalRecord = z.infer<typeof toolApprovalRecordSchema>;

/** Everything in {@link SessionData} except the message history and derived metadata. */
export type SessionStateFields = Omit<SessionData, "uiMessages" | "approvalTimes">;

/**
 * A `UIMessage` as written to the log: the TanStack message plus the two
 * agent-owned timestamps.
 *
 * `createdAt` is TanStack's own field (ISO string on the wire/disk). `updatedAt`
 * is our epoch-ms stamp of the last meaningful change to this message. Both are
 * plain data, so they round-trip through JSON like every other UIMessage field
 * and survive the TanStack wire conversion (`uiMessageToModelMessages` copies a
 * fixed field set; the engine never sees these extras).
 *
 * `state` is typed as `string` only so a v6 log (no `updatedAt`) still parses
 * into this shape; every v7 message written by us carries a number.
 */
export type PersistedUIMessage = Omit<TanStackUIMessage, "createdAt"> & {
  createdAt?: TanStackUIMessage["createdAt"];
  updatedAt?: number | string;
};

/** A tool-call part whose `approval` may carry our decision timestamp (see {@link PersistedUIMessage}). */
export type PersistedToolCallPart = {
  type?: string;
  approval?: { id?: string; approved?: boolean; updatedAt?: number | string } & Record<string, unknown>;
} & Record<string, unknown>;

/**
 * One line of the append-only session log (`{id}.session.jsonl`): one message
 * plus the full non-message state snapshot at that point.
 *
 * The message MAY be `null` on the very first line only (initial / empty-session
 * state such as `reservedAt`); every other line carries a message.
 *
 * v7 carries the timestamps ON the message (`message.updatedAt`, and
 * `part.approval.updatedAt` for a decided approval). `messageUpdatedAt` and
 * `approvalAt` are the v6 line-level forms: read for legacy logs only, never
 * written.
 */
export interface SessionLogLine {
  t: typeof SESSION_LOG_MESSAGE;
  message: PersistedUIMessage | null;
  state: SessionStateFields;
  /** v6 only: the line's write time. Superseded by `message.updatedAt`. */
  messageUpdatedAt?: number;
  /** v6 only: toolCallId → time its approval first became decided. Superseded by `part.approval.updatedAt`. */
  approvalAt?: Record<string, number>;
}

export interface SessionData {
  /** Unique session identifier */
  id: string;
  /** Human-readable session name (auto-generated from first message) */
  name: string;
  /** Schema version for future migrations */
  version: number;
  /**
   * Provider style these messages were produced with.
   *
   * A *record* of the state at the time the messages were generated, not a settings holder
   * the session owns: on resume it is adopted so the conversation continues on the same plane
   * (see `ManagedAgent.applyPersistedModel`), while changing the provider lives in the config
   * flow. Together with {@link model} it says what this transcript was made with.
   */
  modelStyle: ModelStyle;
  /**
   * Model these messages were produced with — same "record of the producing state" contract as
   * {@link modelStyle}. Adopted on resume so a continued turn targets the same model; switching
   * models is a config-flow concern, not a session-owned setting.
   */
  model: string;
  /** Full conversation as UIMessages (for client display on resume; includes in-chain summaries) */
  uiMessages: TanStackUIMessage[];
  /** Token usage statistics */
  usage: TokenUsage;
  /** Session cost in USD */
  cost?: number;
  /** Last SDK-reported input tokens (actual context window fill for percentage display) */
  contextTokens?: number;
  /** Active todos */
  todos: TodoItem[];
  /** Todo set title (optional; older sessions omit this). */
  todoTitle?: string | null;
  /** Whether todos are bound to plan building (optional; older sessions omit this). */
  todoPlanBound?: boolean;
  /**
   * Reasoning effort recorded with this transcript (OpenAI `reasoning_effort` / Anthropic
   * `effort`).
   *
   * Same contract as {@link model}: a record of the state a message was produced under, not a
   * session-owned toggle. `/effort` is expected to move into the config flow; this field then
   * only reflects how a given transcript's turns were generated.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Plan-mode lifecycle snapshot (phase, markdown, path, seeded flags).
   * Omitted or null when plan mode is off. Older sessions omit this field.
   */
  planMode?: PlanModeState | null;
  /** When true, skip all tool approvals (auto / YOLO mode). Older sessions omit this. */
  autoMode?: boolean;
  /**
   * Source session id when this session was created by `/clone` or `/fork`.
   * Lineage pointer only; it does not participate in model context.
   */
  forkedFrom?: string;
  /**
   * Derived, non-persisted approval decision timestamps (toolCallId → epoch ms),
   * reconstructed on load by folding the message timestamps. Never serialized
   * into the log's `state` snapshot (see {@link SessionStateFields}).
   */
  approvalTimes?: Record<string, number>;
  /**
   * Epoch ms when a live agent last *reserved* this (still-empty) session for
   * startup reuse. Lets a second process/agent skip a concurrently reused
   * session whose live owner is not visible to it (cross-process ownership is
   * intentionally not shared). The window expires on its own if the reserving
   * process crashed, keeping "live-exclusive" semantics. Not surfaced to hosts.
   */
  reservedAt?: number;
  /**
   * @deprecated Legacy field renamed to `autoMode`. Kept for backward compatibility
   * with sessions persisted before the rename. New sessions use `autoMode`.
   */
  autoApprove?: boolean;
  /** Timestamp when session was created */
  createdAt: number;
  /** Timestamp when session was last updated */
  updatedAt: number;
}

// ============================================================================
// Resume Result
// ============================================================================

export interface ResumeResult {
  /** UIMessages for client to display */
  uiMessages: TanStackUIMessage[];
  /** Session metadata */
  session: SessionMeta;
}

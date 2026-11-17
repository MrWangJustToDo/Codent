/**
 * Cancel incomplete / never-executed tool calls left behind after an abort.
 *
 * Esc mid tool-arg stream often leaves `input-streaming` (or TanStack finalize
 * promotes truncated JSON to `input-complete` with no output). Those rows stay
 * "executing" in the UI and the next `chat()` retries them via
 * `executeToolCalls` → JSON.parse failure.
 *
 * Must NOT cancel:
 * - pending approval prompts (user still deciding)
 * - `approval-responded` tools (user just pressed `y`)
 * - valid `input-complete` tools waiting for a normal tool-phase pump
 */

import { TOOL_CANCELLED_MESSAGE } from "../../runtime-types/abort.js";
import { TRUNCATED_TOOL_CALL_MESSAGE } from "../../runtime-types/tool-truncation.js";
import { tryParseToolArguments } from "../../utils/parse-tool-arguments.js";
import { BUILTIN_TOOL_NAMES } from "../tools/catalog/tool-names.js";

import { isSettledToolCallPart, isToolCallPart } from "./message-parts.js";

import type { ToolCallPart, ToolResultPart, UIMessage } from "@tanstack/ai";

/**
 * Why an approval was denied when the run ended for a reason the user did not choose.
 *
 * A pending approval belongs to the turn that asked for it; a stream failure or an internal error
 * ends that turn, but "Cancelled by user." would attribute it to an operator action that never
 * happened. Kept beside the cancel text because both are decisions about the same row.
 */
export const TOOL_APPROVAL_ABANDONED_MESSAGE = "The run ended before this approval was answered.";

/**
 * Why a call that may have been running was settled when the RUN failed (stream error / stall).
 *
 * Not the operator's action and not a tool fault: the response never completed, so the work could
 * not be reported. Same rule as {@link TOOL_APPROVAL_ABANDONED_MESSAGE} one layer down.
 */
export const TOOL_RUN_ENDED_MESSAGE = "The run ended before this tool call completed.";

/** Whether a tool's input schema rejects `{}`; `undefined` when the schema cannot be asked. */
export type ToolRequiresArguments = (toolName: string) => boolean | undefined;

/**
 * Whether a tool schema requires at least one input property.
 *
 * The check is "does this schema accept an empty object", which is the exact question the
 * truncation rule needs. It works for Zod (`safeParse`) and Standard Schema (`~standard.validate`),
 * and returns `undefined` for anything else — "we cannot tell" must never turn `{}` into truncation,
 * because a schema-less tool is called with no arguments every day.
 */
export function toolSchemaRequiresArguments(schema: unknown): boolean | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const candidate = schema as {
    safeParse?: (value: unknown) => { success?: unknown };
    "~standard"?: { validate?: (value: unknown) => unknown };
  };
  try {
    if (typeof candidate.safeParse === "function") {
      const parsed = candidate.safeParse({});
      return typeof parsed?.success === "boolean" ? !parsed.success : undefined;
    }
    const validate = candidate["~standard"]?.validate;
    if (typeof validate === "function") {
      const result = validate({}) as { issues?: unknown } | undefined;
      if (!result || typeof result !== "object") return undefined;
      // Standard Schema success is `{ value }` (no `issues` key): the schema accepts `{}`.
      // Keeping that as "unknown" made a required-args tool look schema-less, so `{}` was never
      // classified as truncated for non-Zod tools.
      if (!("issues" in result)) return false;
      return Array.isArray(result.issues) ? result.issues.length > 0 : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Whether a tool call's arguments never arrived (or stopped mid-payload).
 *
 * `""`/whitespace is always truncated. `{}` is truncated only when the tool's schema requires a
 * property: `{}` is a legitimate call for a tool whose inputs are all optional, and an unknown
 * schema is treated as "not truncated" (no false positives). A payload that opened as JSON and
 * never parsed is the same failure one chunk later — the stream stopped inside the arguments —
 * and treating it as valid is what left a partial call to be settled as a user cancellation.
 * A fully parsed `input: {}` is the same fact one layer later, for adapters that deliver the whole
 * input without a streamed string.
 */
export function hasTruncatedToolArguments(part: ToolCallPart, requiresArguments?: ToolRequiresArguments): boolean {
  const raw = typeof part.arguments === "string" ? part.arguments.trim() : undefined;
  if (raw === undefined) {
    const input = (part as { input?: unknown }).input;
    if (input === undefined) {
      // No raw text and no parsed input at all: a call that only announced itself. During a live
      // stream this is legitimate (`awaiting-input` before the first delta), so the CALLER decides
      // when the boundary is; at that boundary it is zero bytes of arguments.
      return part.state === "awaiting-input" || part.state === "input-streaming";
    }
    if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
    if (Object.keys(input).length > 0) return false;
    return part.name ? requiresArguments?.(part.name) === true : false;
  }
  if (raw.length === 0) return true;
  if (raw !== "{}") {
    // An opened-but-unclosed JSON object: the argument stream ended inside the payload. A complete
    // (even if semantically wrong) object parses and is left to the tool's own validation.
    return raw.startsWith("{") && !tryParseToolArguments(raw).ok;
  }
  return part.name ? requiresArguments?.(part.name) === true : false;
}

/**
 * A call that never received its arguments, at a settlement boundary.
 *
 * A call still streaming during a LIVE response is legitimate work in progress; this predicate is
 * only consulted when the attempt that was filling it is over (abort, stream end, turn end,
 * restore). Pending approvals, answered approvals and settled calls are never truncated — they
 * have their own owners. The answered-approval exclusion is load-bearing: a `{}` call the user
 * just approved must reach its tool phase (where the schema error is reported to the model), not
 * be settled as "arguments never arrived" by the next pump's truncated pass.
 */
export function isTruncatedToolCall(part: ToolCallPart, requiresArguments?: ToolRequiresArguments): boolean {
  if (part.output !== undefined) return false;
  if (isSettledToolCallPart(part)) return false;
  if (part.approval?.needsApproval === true && part.approval.approved === undefined) return false;
  if (part.state === "approval-responded" || part.approval?.approved === true) return false;
  return hasTruncatedToolArguments(part, requiresArguments);
}

/** Whether any assistant message still holds a truncated call. */
export function hasTruncatedToolCalls(messages: UIMessage[], requiresArguments?: ToolRequiresArguments): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (isToolCallPart(part) && isTruncatedToolCall(part, requiresArguments)) return true;
    }
  }
  return false;
}

/** Whether tool arguments are non-empty, parseable JSON (safe for TanStack executeToolCalls). */
export function hasValidToolArguments(part: ToolCallPart): boolean {
  if (typeof part.arguments !== "string") return false;
  return tryParseToolArguments(part.arguments).ok;
}

/**
 * Tool call that is stuck from an aborted stream and must not be resumed.
 * Live approval / tool-phase queues and truncated calls are left alone.
 */
export function isCancellableIncompleteToolCall(
  part: ToolCallPart,
  requiresArguments?: ToolRequiresArguments
): boolean {
  if (part.output !== undefined) return false;
  if (isSettledToolCallPart(part)) return false;

  // User still deciding — approval UI owns this.
  if (part.approval?.needsApproval === true && part.approval.approved === undefined) {
    return false;
  }

  // User approved (`y`) — next pump must execute, not cancel.
  if (part.state === "approval-responded") return false;

  // A call whose arguments never arrived is TRUNCATED, not cancelled. It gets its own settlement
  // text/pass; folding it in here is what produced 143 "Cancelled by user." rows for one broken
  // upstream response.
  if (hasTruncatedToolArguments(part, requiresArguments)) return false;

  // Truncated / never-finished arg streams.
  if (part.state === "awaiting-input" || part.state === "input-streaming") return true;

  // Finalize after abort can promote truncated args to input-complete — only cancel bad JSON.
  if (part.state === "input-complete") {
    return !hasValidToolArguments(part);
  }

  return false;
}

/** Whether any message still has a cancellable incomplete tool call. */
export function hasCancellableIncompleteToolCalls(
  messages: UIMessage[],
  requiresArguments?: ToolRequiresArguments
): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (isToolCallPart(part) && isCancellableIncompleteToolCall(part, requiresArguments)) return true;
    }
  }
  return false;
}

interface CancelToolCallOptions {
  /** TanStack tool-call part state written on cancel. */
  state: "error" | "complete";
  /** Whether to include `cancelled: true` in the synthetic result. */
  cancelled?: boolean;
  /**
   * Build the settled result for one call instead of the shared cancel marker.
   *
   * A tool with a REAL output schema (a background `task` handle) cannot take the marker: its own
   * `toModelOutput` would read fields the marker does not have and put `undefined` on the wire. Such a
   * tool supplies a shape it can render, and the paired tool-result carries the same value.
   */
  outputFor?: (part: ToolCallPart, message: string) => unknown;
  /** Drop the host-facing display payload, which describes the output being replaced. */
  clearDisplay?: boolean;
  /**
   * Called once per call this pass settles, with the part as it was found.
   *
   * A caller that must REPORT the settle (the `tool:settle` timeline row) cannot re-derive its
   * candidate set from a second predicate copy: that copy decides against the pre-mutation
   * snapshot and drifts the moment a pass is added or narrowed. The apply loop is the only place
   * that knows exactly which parts it changed.
   */
  onSettled?: (part: ToolCallPart) => void;
}

const DEFAULT_CANCEL_OPTIONS: CancelToolCallOptions = { state: "error", cancelled: true };

function applyToolCallCancellation(
  messages: UIMessage[],
  isCancellable: (part: ToolCallPart) => boolean,
  reason: string,
  options: CancelToolCallOptions
): UIMessage[] {
  const message = reason.trim() || TOOL_CANCELLED_MESSAGE;
  let changed = false;

  const next = messages.map((uiMessage) => {
    if (uiMessage.role !== "assistant") return uiMessage;

    let partsChanged = false;
    const parts = [...uiMessage.parts];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!isToolCallPart(part) || !isCancellable(part)) continue;

      partsChanged = true;
      options.onSettled?.(part);
      const synthetic = options.outputFor
        ? options.outputFor(part, message)
        : // `reason` preserves the attribution (user cancel vs crash recovery) for BOTH the UI and
          // the model wire: `error` is shared shape and the formatters deliberately do not read it.
          { success: false, error: message, cancelled: options.cancelled === true, reason: message };
      // Carry the `cancelled` marker on the PART's output too, not only on the appended
      // `tool-result`: the part output is what the UI renders (and what a host reads),
      // while the tool-result content is consumed by the model wire. Without it here, a
      // cancelled call was indistinguishable from a tool that failed mid-flight, so
      // `getInlineSummary` could not tell the user the run was cut short.
      parts[i] = {
        ...part,
        state: options.state,
        output: synthetic,
        ...(options.clearDisplay ? { display: undefined } : {}),
      };

      // The MODEL wire is built from the paired `tool-result`'s content, not from the call part's
      // output (TanStack copies it verbatim into the `role: "tool"` message). A background command /
      // task wrote its `running` handle through `addToolResult`, so that result already exists — and
      // rewriting only the call part left the resumed session telling the model the job is still
      // running forever. Replace the content when it is there, insert it when it is not.
      const resultIndex = parts.findIndex((p) => p.type === "tool-result" && p.toolCallId === part.id);
      if (resultIndex >= 0) {
        const existing = parts[resultIndex] as ToolResultPart;
        parts[resultIndex] = {
          type: "tool-result",
          toolCallId: part.id,
          content: JSON.stringify(synthetic),
          state: "complete",
          // `outcome` / `error` described the result being replaced — keeping either would make the
          // wire read "cancelled" while carrying a settled content, or vice versa.
          ...(existing.name !== undefined ? { name: existing.name } : {}),
          ...(existing.id !== undefined ? { id: existing.id } : {}),
        };
      } else {
        const result: ToolResultPart = {
          type: "tool-result",
          toolCallId: part.id,
          content: JSON.stringify(synthetic),
          state: "complete",
        };
        parts.splice(i + 1, 0, result);
        i += 1;
      }
    }

    if (!partsChanged) return uiMessage;
    changed = true;
    return { ...uiMessage, parts };
  });

  return changed ? next : messages;
}

/**
 * Mark incomplete tool calls as cancelled (`error` + synthetic tool-result) so:
 * - UI stops showing a loading spinner
 * - TanStack `checkForPendingToolCalls` will not try to execute truncated args
 */
export function cancelIncompleteToolCalls(
  messages: UIMessage[],
  reason: string = TOOL_CANCELLED_MESSAGE,
  onSettled?: (part: ToolCallPart) => void,
  requiresArguments?: ToolRequiresArguments
): UIMessage[] {
  return applyToolCallCancellation(
    messages,
    (part) => isCancellableIncompleteToolCall(part, requiresArguments),
    reason,
    {
      ...DEFAULT_CANCEL_OPTIONS,
      ...(onSettled ? { onSettled } : {}),
    }
  );
}

/** Reason written for a tool call recovered after a crash/interruption. */
export const INTERRUPTED_RUN_MESSAGE = "Session restored after an interrupted run.";

/** Options for the shared lifecycle settlement path. */
export interface SettleToolCallsOptions {
  /** Result text written into the synthetic tool output. */
  reason?: string;
  /** Include valid `input-complete` / approved calls that were executing (default true). */
  includeInFlight?: boolean;
  /** Keep a fully-asked `ask_user` interaction answerable (restore only). */
  preservePendingAskUser?: boolean;
  /**
   * Settle EVERY remaining unsettled call with the interruption marker (`interrupted: true`, no
   * `cancelled`) instead of the cancel passes. Used when the run ended because the model stream
   * failed/stalled: whatever was in flight was not cancelled by anyone. Pending approvals keep
   * their own owner. Reported in the `truncated` group (`did not run`).
   */
  interrupted?: boolean;
  /** Whether a tool's schema rejects `{}` (so an empty object is a truncated payload). */
  requiresArguments?: ToolRequiresArguments;
  /**
   * Called once per call this settle pass actually settles, in pass order, with the part as it was
   * found. This is the ONLY correct way to report what was settled — see
   * {@link CancelToolCallOptions.onSettled}.
   */
  onSettled?: (part: ToolCallPart) => void;
}

/**
 * The shared truncation marker: not a user cancel, and not any tool's output schema.
 *
 * The keys are exclusive on purpose. Several built-ins return a legitimate `truncated: true` field
 * describing a clipped RESULT (`read_file`, `tree`, `webfetch`, `session_search`); keying the marker
 * on that word alone made a large successful read render as "did not run".
 */
function truncatedToolOutput(_part: ToolCallPart, message: string): unknown {
  return { success: false, error: message, reason: message, interrupted: true, argumentsIncomplete: true };
}

/**
 * The run-level interruption marker: a call that may have started running but whose run failed.
 *
 * Deliberately NOT the cancel marker: nothing was cancelled, and the UI must not say it was.
 */
function interruptedToolOutput(_part: ToolCallPart, message: string): unknown {
  return { success: false, error: message, reason: message, interrupted: true };
}

/** A call with no outcome that no approval prompt is holding (the settle-all candidate). */
function isUnsettledToolCall(part: ToolCallPart): boolean {
  if (part.output !== undefined) return false;
  if (isSettledToolCallPart(part)) return false;
  if (part.approval?.needsApproval === true && part.approval.approved === undefined) return false;
  return true;
}

/**
 * Settle every remaining unsettled call with the interruption marker.
 *
 * The run ended because the response failed (stall / terminal-less return); a call that was
 * executing when that happened has no result and was not cancelled by the user.
 */
export function settleInterruptedRunToolCalls(
  messages: UIMessage[],
  message: string = TOOL_RUN_ENDED_MESSAGE,
  onSettled?: (part: ToolCallPart) => void,
  preservePendingAskUser = true
): UIMessage[] {
  return settleToolCallsAs(
    messages,
    (part) =>
      isUnsettledToolCall(part) &&
      !(preservePendingAskUser && part.name === BUILTIN_TOOL_NAMES.askUser && hasValidToolArguments(part)),
    message,
    interruptedToolOutput,
    onSettled
  );
}

/**
 * Settle complete results for calls whose arguments never arrived.
 *
 * Runs FIRST, because both later passes skip a part that already carries an output. Settling these
 * as truncated is what keeps a broken upstream response from being reported as a user cancellation.
 */
export function settleTruncatedToolCalls(
  messages: UIMessage[],
  options: {
    requiresArguments?: ToolRequiresArguments;
    message?: string;
    onSettled?: (part: ToolCallPart) => void;
  } = {}
): UIMessage[] {
  const message = options.message ?? TRUNCATED_TOOL_CALL_MESSAGE;
  return settleToolCallsAs(
    messages,
    (part) => isTruncatedToolCall(part, options.requiresArguments),
    message,
    truncatedToolOutput,
    options.onSettled
  );
}

/** Which settlement pass produced a row. */
export type SettledToolCallGroup = "truncated" | "cancelled";

function settlePasses(
  messages: UIMessage[],
  options: SettleToolCallsOptions,
  onSettled: ((part: ToolCallPart, group: SettledToolCallGroup) => void) | undefined
): UIMessage[] {
  const reason = options.reason ?? TOOL_CANCELLED_MESSAGE;
  // Pass identity is the group. Re-deriving it from a predicate on the settled part is exactly the
  // "second predicate copy" drift `onSettled` exists to avoid.
  let next = settleTruncatedToolCalls(messages, {
    ...(options.requiresArguments ? { requiresArguments: options.requiresArguments } : {}),
    ...(onSettled ? { onSettled: (part) => onSettled(part, "truncated") } : {}),
  });
  if (options.interrupted) {
    // The run failed: everything still unsettled shares one verdict, and it is not a cancel.
    return settleInterruptedRunToolCalls(
      next,
      options.reason ?? TOOL_RUN_ENDED_MESSAGE,
      onSettled ? (part) => onSettled(part, "truncated") : undefined,
      options.preservePendingAskUser !== false
    );
  }
  const reportCancelled = onSettled ? (part: ToolCallPart) => onSettled(part, "cancelled") : undefined;
  next = cancelIncompleteToolCalls(next, reason, reportCancelled, options.requiresArguments);
  if (options.includeInFlight !== false) {
    next = cancelInFlightToolCalls(
      next,
      reason,
      options.preservePendingAskUser
        ? (part) =>
            isInFlightToolCall(part, options.requiresArguments) &&
            !(part.name === BUILTIN_TOOL_NAMES.askUser && hasValidToolArguments(part))
        : (part) => isInFlightToolCall(part, options.requiresArguments),
      reportCancelled
    );
  }
  return next;
}

/**
 * Settle incomplete and (optionally) in-flight tool calls in one ordered pass.
 *
 * Shared by the abort/chat-controller path and session restore; callers differ in the reason,
 * whether in-flight calls are included, and whether a pending client question is preserved.
 * Truncated calls are settled first with their own text, regardless of `reason` — they were never
 * work the user could have cancelled.
 */
export function settleToolCalls(messages: UIMessage[], options: SettleToolCallsOptions = {}): UIMessage[] {
  return settlePasses(messages, options, options.onSettled ? (part) => options.onSettled!(part) : undefined);
}

/** The two groups a chat settlement produces, for `tool:settle` attribution. */
export interface SettledChatToolCalls {
  messages: UIMessage[];
  /** Incomplete / in-flight calls settled as a user cancellation. */
  cancelled: ToolCallPart[];
  /** Calls whose arguments never arrived, settled with the truncation notice. */
  truncated: ToolCallPart[];
}

/**
 * Chat-path settlement: truncated first, then cancelled incomplete + in-flight.
 *
 * Returns the groups so the caller can report them separately — merging them is how the timeline
 * claimed 143 user cancellations for one truncated response.
 */
export function settleChatToolCalls(messages: UIMessage[], options: SettleToolCallsOptions = {}): SettledChatToolCalls {
  const cancelled: ToolCallPart[] = [];
  const truncated: ToolCallPart[] = [];
  const next = settlePasses(messages, options, (part, group) => {
    if (group === "truncated") truncated.push(part);
    else cancelled.push(part);
    options.onSettled?.(part);
  });
  return { messages: next, cancelled, truncated };
}

/** Shape of one model response's tool-call batch, for the malformed-batch diagnostic. */
export interface ToolCallBatchShape {
  /** Assistant message the batch belongs to (the diagnostic's dedupe key). */
  messageId?: string;
  toolCalls: number;
  /** Unsettled calls that carry no complete argument payload. */
  emptyArgs: number;
  /** A tool name repeated more than {@link TOOL_BATCH_REPEAT_THRESHOLD} times. */
  repeated: boolean;
  /** Unique tool names in first-seen order. */
  names: string[];
  /**
   * At least two calls AND (an unsettled call with no arguments OR a degenerate repetition in a
   * batch large enough that repetition is not ordinary parallelism).
   */
  malformed: boolean;
}

/** A single turn needing more than this many calls of ONE tool is a malformed batch, not work. */
export const TOOL_BATCH_REPEAT_THRESHOLD = 8;

/**
 * A repeat count is only evidence when the batch is too large for ordinary parallel work.
 *
 * A model reading 9 files in one response is normal; treating every >8 repeat as malformed wrote a
 * warn row on healthy turns. Zero-byte arguments remain the primary signal (`emptyArgs`).
 */
const TOOL_BATCH_DEGENERATE_SIZE = 40;

/**
 * Describe the LAST assistant message's tool-call batch (counts/names only, never arguments).
 *
 * Only UNSETTLED calls are counted: a batch that was already settled stays in the transcript, and
 * re-describing it on every later turn would re-report the same degeneracy forever.
 */
export function describeToolCallBatch(
  messages: UIMessage[],
  requiresArguments?: ToolRequiresArguments
): ToolCallBatchShape {
  let assistant: UIMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.parts.some(isToolCallPart)) {
      assistant = message;
      break;
    }
  }
  if (!assistant) return { toolCalls: 0, emptyArgs: 0, repeated: false, names: [], malformed: false };

  const counts = new Map<string, number>();
  const names: string[] = [];
  let toolCalls = 0;
  let emptyArgs = 0;
  for (const part of assistant.parts) {
    if (!isToolCallPart(part)) continue;
    if (part.output !== undefined || isSettledToolCallPart(part)) continue;
    toolCalls += 1;
    const name = part.name ?? "unknown";
    const seen = counts.get(name) ?? 0;
    counts.set(name, seen + 1);
    if (seen === 0) names.push(name);
    if (isTruncatedToolCall(part, requiresArguments)) emptyArgs += 1;
  }
  const repeated = [...counts.values()].some((count) => count > TOOL_BATCH_REPEAT_THRESHOLD);
  const degenerate = repeated && toolCalls > TOOL_BATCH_DEGENERATE_SIZE;
  return {
    ...(assistant.id !== undefined ? { messageId: assistant.id } : {}),
    toolCalls,
    emptyArgs,
    repeated,
    names,
    malformed: toolCalls > 1 && (emptyArgs > 0 || degenerate),
  };
}

/**
 * Settle every tool call that cannot still be running after a session restore.
 *
 * This is deliberately not the user-cancel path: no operator pressed Esc, so the synthetic
 * result must not say "Cancelled by user". Truncated/incomplete calls and valid in-flight calls
 * are both covered; pending approvals and unfinished `ask_user` interactions are left alone
 * because they are legitimate resume states.
 */
export function settleInterruptedToolCalls(
  messages: UIMessage[],
  reason: string = INTERRUPTED_RUN_MESSAGE,
  requiresArguments?: ToolRequiresArguments
): UIMessage[] {
  return settleToolCalls(messages, {
    reason,
    includeInFlight: true,
    preservePendingAskUser: true,
    ...(requiresArguments ? { requiresArguments } : {}),
  });
}

/**
 * Tool call that is currently executing (or queued to execute) when the run is
 * aborted — valid args, no tool-result yet, but not a live approval prompt.
 *
 * These are separate from {@link isCancellableIncompleteToolCall}: a normal
 * tool-phase pump must let valid `input-complete` tools run, so they are only
 * cancelled on the abort path via {@link cancelInFlightToolCalls}.
 */
export function isInFlightToolCall(part: ToolCallPart, requiresArguments?: ToolRequiresArguments): boolean {
  if (part.output !== undefined) return false;
  if (isSettledToolCallPart(part)) return false;
  // User still deciding — approval UI owns this.
  if (part.approval?.needsApproval === true && part.approval.approved === undefined) return false;
  // A call whose arguments never arrived is not work that could be running; it is truncated.
  if (hasTruncatedToolArguments(part, requiresArguments)) return false;
  // Truncated arg streams are handled by cancelIncompleteToolCalls, not here.
  if (part.state === "awaiting-input" || part.state === "input-streaming") return false;
  // Valid args that would run in the next tool-phase (or are running now).
  if (part.state === "input-complete" && hasValidToolArguments(part)) return true;
  // Approved (`y`) and queued to execute — aborted before a result arrived.
  if (part.state === "approval-responded" && part.approval?.approved === true) return true;
  return false;
}

/** Whether any message still has an in-flight (executing) tool call. */
export function hasInFlightToolCalls(messages: UIMessage[], requiresArguments?: ToolRequiresArguments): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (isToolCallPart(part) && isInFlightToolCall(part, requiresArguments)) return true;
    }
  }
  return false;
}

/**
 * Mark currently-executing (in-flight) tool calls as `complete` with a
 * user-cancel result on abort. This is the framework fallback that also covers
 * extension/MCP tools whose execute never resolved before the run was torn down.
 */
export function cancelInFlightToolCalls(
  messages: UIMessage[],
  reason: string = TOOL_CANCELLED_MESSAGE,
  shouldCancel: (part: ToolCallPart) => boolean = isInFlightToolCall,
  onSettled?: (part: ToolCallPart) => void,
  /** Schema lookup used when the default `isInFlightToolCall` predicate is in effect. */
  requiresArguments?: ToolRequiresArguments
): UIMessage[] {
  // The default predicate has to see the same schema fact as `settleToolCalls`, or a `{}` call for a
  // required-args tool reads as in flight through this entry point alone.
  const predicate =
    shouldCancel === isInFlightToolCall && requiresArguments
      ? (part: ToolCallPart) => isInFlightToolCall(part, requiresArguments)
      : shouldCancel;
  return applyToolCallCancellation(messages, predicate, reason, {
    state: "complete",
    cancelled: true,
    ...(onSettled ? { onSettled } : {}),
  });
}

/**
 * Settle calls with a result their own tool can render, instead of the shared cancel marker.
 *
 * The marker (`{ success, error, cancelled }`) is not any tool's output schema, so a tool whose
 * `toModelOutput` reads its own fields would put `undefined` on the wire. A caller that knows the
 * shape (a background `task` handle) supplies it, and the display payload is dropped because it
 * described the output being replaced.
 */
export function settleToolCallsAs(
  messages: UIMessage[],
  shouldSettle: (part: ToolCallPart) => boolean,
  reason: string,
  outputFor: (part: ToolCallPart, message: string) => unknown,
  onSettled?: (part: ToolCallPart) => void
): UIMessage[] {
  return applyToolCallCancellation(messages, shouldSettle, reason, {
    state: "complete",
    clearDisplay: true,
    outputFor,
    ...(onSettled ? { onSettled } : {}),
  });
}

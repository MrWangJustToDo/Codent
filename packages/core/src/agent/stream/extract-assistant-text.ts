/**
 * Extract assistant text and task-summary stream helpers from UIMessage snapshots.
 */

import { BEGIN_SUMMARY_TOOL_NAME } from "../subagent/begin-summary-tool.js";

import type { UIMessage } from "@tanstack/ai";

/** Minimum chars before streaming summary text to the parent task tool UI. */
export const SUMMARY_STREAM_MIN_CHARS = 80;

type MessagePart = UIMessage["parts"][number];

function isToolPart(part: MessagePart): boolean {
  return part.type === "tool-call" || part.type === "tool-result";
}

/**
 * Text/thinking readers in one parameterized pair.
 *
 * `raw` exists for streaming length tracking: trim drops trailing newlines mid-stream and makes
 * lengths non-monotonic, which previously cleared the parent task stdout window and flickered the
 * "… N lines hidden above" indicator. Four near-identical getters plus two joiners used to encode
 * that one distinction.
 */
function partText(part: MessagePart, raw: boolean): string {
  if (part.type !== "text") return "";
  const content = part.content ?? "";
  return raw ? content : content.trim();
}

function partThinking(part: MessagePart, raw: boolean): string {
  if (part.type !== "thinking") return "";
  const content = part.content ?? "";
  return raw ? content : content.trim();
}

function joinParts(parts: MessagePart[], pick: (part: MessagePart, raw: boolean) => string, raw: boolean): string {
  const values: string[] = [];
  for (const part of parts) {
    const value = pick(part, raw);
    if (value.length > 0) values.push(value);
  }
  return values.join("\n");
}

/** Join a segment's text, falling back to its thinking; `raw` keeps lengths monotonic. */
function joinSegment(parts: MessagePart[], options: { raw?: boolean } = {}): string {
  const raw = options.raw === true;
  const text = joinParts(parts, partText, raw);
  if (text.length > 0) return raw ? text : text.trim();

  const thinking = joinParts(parts, partThinking, raw);
  return raw ? thinking : thinking.trim();
}

function splitByToolBoundaries(parts: MessagePart[]): MessagePart[][] {
  const segments: MessagePart[][] = [];
  let current: MessagePart[] = [];

  for (const part of parts) {
    if (isToolPart(part)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      segments.push([part]);
      continue;
    }
    current.push(part);
  }

  if (current.length > 0) segments.push(current);
  return segments;
}

/** Split assistant parts into per-step segments at tool-call / tool-result boundaries. */
export function splitStepSegments(parts: MessagePart[]): MessagePart[][] {
  return splitByToolBoundaries(parts);
}

function segmentHasTool(parts: MessagePart[]): boolean {
  return parts.some((part) => isToolPart(part));
}

function getLastAssistantMessage(messages: UIMessage[]): UIMessage | undefined {
  return [...messages].reverse().find((message) => message.role === "assistant");
}

const TERMINAL_TOOL_CALL_STATES = new Set(["complete", "error"]);

/** Whether any subagent tool-call is still in progress. */
export function hasIncompleteToolCalls(messages: UIMessage[]): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "tool-call") continue;
      const state = part.state ?? "input-complete";
      if (!TERMINAL_TOOL_CALL_STATES.has(state)) return true;
    }
  }
  return false;
}

export type TaskSummaryPhase = "tools" | "summary";

/** Tracks whether {@link begin_summary} has unlocked summary streaming. */
export interface TaskSummaryStreamState {
  summaryPhaseUnlocked: boolean;
}

export const DEFAULT_TASK_SUMMARY_STREAM_STATE: TaskSummaryStreamState = {
  summaryPhaseUnlocked: false,
};

/**
 * Resolve whether the subagent is in the tool phase or summary phase.
 * Summary phase begins after the model calls {@link BEGIN_SUMMARY_TOOL_NAME}.
 */
export function resolveTaskRunPhase(
  messages: UIMessage[],
  streamState: TaskSummaryStreamState = DEFAULT_TASK_SUMMARY_STREAM_STATE
): TaskSummaryPhase {
  if (hasIncompleteToolCalls(messages)) return "tools";
  return streamState.summaryPhaseUnlocked ? "summary" : "tools";
}

/** Whether summary text should be streamed to the parent task tool UI. */
export function shouldStreamTaskSummary(
  parts: MessagePart[],
  streamState: TaskSummaryStreamState = DEFAULT_TASK_SUMMARY_STREAM_STATE
): boolean {
  return getSummaryStreamText(parts, streamState) !== null;
}

/**
 * Text from the last text-only step (final summary), excluding exploration narration
 * from earlier steps that also had leading text before tool calls.
 *
 * When {@link BEGIN_SUMMARY_TOOL_NAME} was called, only text **after** that tool is used
 * (matches the explore subagent contract).
 */
export function extractAssistantText(messages: UIMessage[]): string {
  const lastAssistant = getLastAssistantMessage(messages);
  if (!lastAssistant) return "";

  const beginSummaryIndex = lastAssistant.parts.findIndex(
    (part) => part.type === "tool-call" && "name" in part && part.name === BEGIN_SUMMARY_TOOL_NAME
  );
  const scopedParts = beginSummaryIndex >= 0 ? lastAssistant.parts.slice(beginSummaryIndex + 1) : lastAssistant.parts;

  const segments = splitStepSegments(scopedParts);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!;
    if (segmentHasTool(segment)) continue;
    const text = joinSegment(segment);
    if (text) return text;
  }

  const lastText = [...scopedParts].reverse().find((part) => part.type === "text");
  if (lastText) return partText(lastText, false);

  const lastThinking = [...scopedParts].reverse().find((part) => part.type === "thinking");
  return lastThinking ? partThinking(lastThinking, false) : "";
}

/**
 * Current-turn summary text for streaming to the parent task tool.
 *
 * Pass only the **current agent-loop turn** assistant parts (Vercel `readUIMessageStream`
 * semantics). Returns null until {@link TaskSummaryStreamState.summaryPhaseUnlocked} is set
 * by {@link BEGIN_SUMMARY_TOOL_NAME} and the last segment of this turn is text-only.
 */
export function getSummaryStreamText(
  parts: MessagePart[],
  streamState: TaskSummaryStreamState = DEFAULT_TASK_SUMMARY_STREAM_STATE
): string | null {
  if (!streamState.summaryPhaseUnlocked) return null;

  const segments = splitStepSegments(parts);
  if (segments.length === 0) return null;

  const lastSegment = segments[segments.length - 1]!;
  if (segmentHasTool(lastSegment)) return null;

  // Use raw (untrimmed) text so streamed lengths stay monotonic as deltas arrive.
  const text = joinSegment(lastSegment, { raw: true });
  if (text.length < SUMMARY_STREAM_MIN_CHARS) return null;

  return text;
}

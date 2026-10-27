/**
 * Extract assistant text and task-summary stream helpers from UIMessage snapshots.
 */

import { BEGIN_SUMMARY_TOOL_NAME } from "../subagent/begin-summary-tool.js";

import type { UIMessage } from "@tanstack/ai";

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

/** Tracks whether {@link BEGIN_SUMMARY_TOOL_NAME} has unlocked summary streaming. */
export interface TaskSummaryStreamState {
  summaryPhaseUnlocked: boolean;
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

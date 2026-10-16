import { digestString } from "./string-digest.js";

import type { ImagePart, TextPart, ToolCallPart, UIMessage } from "@tanstack/ai";

const SKIPPED_FLATTEN_PART_TYPES = new Set(["thinking", "tool-result"]);

function parseToolResultContent(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

/**
 * Fold standalone `tool-result` parts into their matching `tool-call` and drop the result row.
 * TanStack often emits both; UI only renders tool-call rows.
 */
// TanStack keeps `tool-result` parts in raw messages, so the `hasToolResult` fast
// path misses on every stream tick and the map below would clone every assistant
// part ~16×/s (allocation churn → GC pauses). StreamProcessor updates messages
// immutably, so completed messages keep object identity — memoize by reference.
//
// Keyed by object identity in a WeakMap: a rebuilt message is a new object (so a hit is
// always sound) and a message dropped by the input window becomes collectable instead of
// being retained by a size-capped FIFO. That removes the old failure mode where the cap
// (600) sat below the working set (693 messages) and every entry was recomputed each tick.
const normalizeMemo = new WeakMap<UIMessage, UIMessage>();

function normalizeMessage(message: UIMessage): UIMessage {
  const parts = message.parts.map((part) => ({ ...part }));
  const callIndexById = new Map<string, number>();

  for (let i = 0; i < parts.length; i++) {
    if (parts[i].type === "tool-call") {
      callIndexById.set((parts[i] as ToolCallPart).id, i);
    }
  }

  const remove = new Set<number>();
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.type !== "tool-result") continue;

    const callIdx = callIndexById.get(part.toolCallId);
    if (callIdx === undefined) continue;

    const callPart = parts[callIdx] as ToolCallPart;
    if (callPart.output === undefined) {
      parts[callIdx] = {
        ...callPart,
        state: part.state === "error" ? "error" : "complete",
        output: parseToolResultContent(part.content as any),
      };
    }
    remove.add(i);
  }

  if (remove.size === 0) return message;
  return { ...message, parts: parts.filter((_, idx) => !remove.has(idx)) };
}

export function normalizeToolPartsInMessages(messages: UIMessage[]): UIMessage[] {
  let hasToolResult = false;
  for (const message of messages) {
    if (message.parts.some((part) => part.type === "tool-result")) {
      hasToolResult = true;
      break;
    }
  }
  if (!hasToolResult) return messages;

  const result = messages.map((message) => {
    if (message.role !== "assistant") return message;

    const cached = normalizeMemo.get(message);
    if (cached) return cached;

    const normalized = normalizeMessage(message);
    normalizeMemo.set(message, normalized);
    return normalized;
  });

  return result.filter((message) => message.parts.length > 0);
}

export function shouldFlattenPart(part: { type?: string }): boolean {
  return !SKIPPED_FLATTEN_PART_TYPES.has(part?.type ?? "");
}

const TOOL_STATE_RANK: Record<ToolCallPart["state"], number> = {
  "awaiting-input": 0,
  "input-streaming": 1,
  "input-complete": 2,
  "approval-requested": 3,
  "approval-responded": 4,
  complete: 5,
  error: 5,
};

function getToolStateRank(part: ToolCallPart): number {
  return TOOL_STATE_RANK[part?.state] ?? 0;
}

function isLikelyCompleteJson(value: string): boolean {
  if (!value) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

function pickArguments(primary: string, duplicate: string): string {
  const primaryValid = isLikelyCompleteJson(primary);
  const duplicateValid = isLikelyCompleteJson(duplicate);
  if (primaryValid && !duplicateValid) return primary;
  if (duplicateValid && !primaryValid) return duplicate;
  return primary.length >= duplicate.length ? primary : duplicate;
}

/** Merge a later duplicate tool-call into the first occurrence (display anchor). TODO(cleanup): remove with dedupeToolCallsInMessages. */
export function mergeToolCallPart(primary: ToolCallPart, duplicate: ToolCallPart): ToolCallPart {
  const winner = getToolStateRank(duplicate) >= getToolStateRank(primary) ? duplicate : primary;

  return {
    ...primary,
    state: winner?.state,
    output: winner?.output ?? primary?.output,
    arguments: pickArguments(primary?.arguments, duplicate?.arguments),
    approval: primary?.approval ?? duplicate?.approval,
    metadata: primary?.metadata ?? duplicate?.metadata,
    // Core attaches the rendered display payload to the part; a duplicate-only payload
    // must survive the field-by-field rebuild.
    display: (primary as { display?: unknown })?.display ?? (duplicate as { display?: unknown })?.display,
  } as ToolCallPart;
}

type ToolLocation = { messageIdx: number; partIdx: number };

/**
 * Dedupe assistant tool-call parts by `id` across messages.
 * The first occurrence is kept for display; later duplicates merge state into it.
 *
 * TODO(cleanup): Remove once we no longer need to resume pre-suppress-replay sessions.
 * Core `suppress-replayed-tool-chunks` now prevents duplicate toolCallIds at ingest;
 * new sessions (e.g. ses_mscmazgx) have zero duplicates. Keep only while old dirty
 * sessions may still be opened. Do not remove {@link normalizeToolPartsInMessages}.
 *
 * Re-measured 2026-10-16 over every session on the authoring machine — 14327 distinct tool calls,
 * **0** appearing in more than one message — so nothing here is load-bearing for them, and the
 * window-splitting caveat in `get-messages.ts` is theoretical rather than observed. (What a session
 * log DOES contain repeatedly is the same message re-emitted as its parts change: `SessionStore`
 * folds that by message id on load, so it is not a duplicate call.)
 */
export function dedupeToolCallsInMessages(messages: UIMessage[]): UIMessage[] {
  if (messages.length === 0) return messages;

  const seen = new Set<string>();
  let hasDuplicate = false;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part?.type !== "tool-call") continue;
      const toolPart = part as ToolCallPart;
      if (seen.has(toolPart.id)) {
        hasDuplicate = true;
        break;
      }
      seen.add(toolPart.id);
    }
    if (hasDuplicate) break;
  }
  if (!hasDuplicate) return messages;

  const firstByToolId = new Map<string, ToolLocation>();
  const result = messages.map((msg) => ({
    ...msg,
    parts: [...msg.parts],
  }));

  for (let messageIdx = 0; messageIdx < result.length; messageIdx++) {
    const message = result[messageIdx];
    if (message.role !== "assistant") continue;

    const partsToRemove: number[] = [];

    for (let partIdx = 0; partIdx < message.parts.length; partIdx++) {
      const part = message.parts[partIdx];
      if (part?.type !== "tool-call") continue;

      const toolPart = part as ToolCallPart;
      const existing = firstByToolId.get(toolPart.id);

      if (!existing) {
        firstByToolId.set(toolPart.id, { messageIdx, partIdx });
        continue;
      }

      const anchor = result[existing.messageIdx].parts[existing.partIdx] as ToolCallPart;
      result[existing.messageIdx].parts[existing.partIdx] = mergeToolCallPart(anchor, toolPart);
      partsToRemove.push(partIdx);
    }

    if (partsToRemove.length > 0) {
      message.parts = message.parts.filter((_, idx) => !partsToRemove.includes(idx));
    }
  }

  return result.filter((msg) => msg.parts.length > 0);
}

/** Encode one tool-call's render-relevant state for signature comparisons. */
export function encodeToolCallState(tool: {
  id?: string;
  state?: string;
  output?: unknown;
  approval?: { approved?: boolean };
  display?: unknown;
}): string {
  const hasOutput = tool.output !== undefined ? "1" : "0";
  const approval =
    tool.approval?.approved === true ? "a" : tool.approval?.approved === false ? "d" : tool.approval ? "p" : "-";
  // The display payload is rendered by core *after* the part first appears, so it must
  // be part of the fingerprint — otherwise a row keeps showing its previous text
  // (same failure class as the flat-cache staleness fixed in 73d5d95).
  const display = tool.display === undefined ? "-" : `d${digestString(safeStringify(tool.display))}`;
  return `${tool.id ?? ""}:${tool.state ?? ""}:${hasOutput}:${approval}:${display}`;
}

/** Fingerprint tool-call state for static list invalidation when merges update earlier rows. */
export function computeToolCallsRenderSignature(messages: UIMessage[]): string {
  return messages
    .flatMap((message) => message.parts)
    .filter((part) => part?.type === "tool-call")
    .map((part) => encodeToolCallState(part as ToolCallPart))
    .join("|");
}

/**
 * Fingerprint everything a message's flattened display rows are derived from: the
 * role (user rows stay whole, assistant rows split per part) plus, for every part
 * that yields a row, its content.
 *
 * Tool state is encoded cheaply ({@link encodeToolCallState}). Text and image parts
 * — the ones rewritten *under a stable id* (compact activity summaries, streamed
 * compaction summaries, replaced images) — are content-digested, so the
 * flat-message cache invalidates instead of pinning the first render forever.
 */
export function computeMessageRenderSignature(message: UIMessage): string {
  const parts = message.parts.filter((part) => shouldFlattenPart(part)).map(encodePartRenderSignature);
  return `${message.role}|${parts.join("|")}`;
}

function encodePartRenderSignature(part: UIMessage["parts"][number]): string {
  if (part.type === "text") return `t${digestString((part as TextPart).content ?? "")}`;
  if (part.type === "image") return `i${digestString(imageSourceValue(part as ImagePart))}`;
  if (part.type === "tool-call") return `c${encodeToolCallState(part as ToolCallPart)}`;
  // Unknown row types (thinking / tool-result never produce rows): a full
  // fingerprint is the only safe option, and they are rare enough to be free.
  return `x${digestString(safeStringify(part))}`;
}

function imageSourceValue(part: ImagePart): string {
  const source = part.source as { value?: unknown } | undefined;
  return typeof source?.value === "string" ? source.value : "";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

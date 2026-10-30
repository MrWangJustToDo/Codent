import { formatExploredActivitySummary, shouldFoldToolRow } from "./tool-activity-summary.js";
import { isToolCallPart } from "./tool-part.js";
import { isBuiltinToolForRow, resolveToolPresentation } from "./tool-presentation.js";

import type { ToolPresentation } from "@codent/core";
import type { TextPart, ToolCallPart, UIMessage } from "@tanstack/ai";

export type TranscriptDisplayMode = "compact" | "full";

/** Synthetic display-only message id prefix (not persisted to session). */
export const ACTIVITY_SUMMARY_ID_PREFIX = "display-activity:";

export function isActivitySummaryMessage(message: { id?: string }): boolean {
  return typeof message.id === "string" && message.id.startsWith(ACTIVITY_SUMMARY_ID_PREFIX);
}

/**
 * Source messages folded into an activity summary row (display-only; not persisted).
 *
 * The row replaces N source messages with ONE line, so any consumer that counts "messages
 * represented by these rows" must expand it. Without this the compact transcript reported the
 * fold itself as a truncation: the marker is `staticSourceTotal - countSourceMessages(visibleRows)`,
 * and a row that counted 1 for 3 folded messages made the difference look like hidden history —
 * the phantom "... N older messages hidden" line.
 */
export function foldedSourceIdsOf(row: unknown): readonly string[] | undefined {
  const ids = (row as { sourceMessageIds?: unknown } | null)?.sourceMessageIds;
  return Array.isArray(ids) && ids.length > 0 ? (ids as string[]) : undefined;
}

type Turn = {
  userMessageId: string | null;
  messages: UIMessage[];
};

type PendingFoldable = {
  part: ToolCallPart;
  source: UIMessage;
  partIndex: number;
};

function groupTurns(messages: UIMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      if (current) turns.push(current);
      current = { userMessageId: message.id, messages: [message] };
      continue;
    }
    if (!current) {
      current = { userMessageId: null, messages: [message] };
    } else {
      current.messages.push(message);
    }
  }

  if (current) turns.push(current);
  return turns;
}

function getTextContent(part: TextPart): string {
  return part.content?.trim() ?? "";
}

function emitPartMessage(source: UIMessage, part: UIMessage["parts"][number], partIndex: number): UIMessage {
  return {
    ...source,
    id: `${source.id}-d${partIndex}`,
    parts: [part],
  } as UIMessage;
}

/**
 * Density-first compact projection:
 * - Keep tools as rows by default (render layer hides bulky outputs / shortens headers)
 * - Fold contiguous completed tools into path-aware activity summaries (even a single tool)
 * - Errored tool rows fold into the summary too, counted as errors (aggregation stays contiguous)
 * - Folded segments use path-aware activity summaries
 */
type ResolvePresentation = (name: string) => ToolPresentation | undefined;

function collapseTurn(turn: Turn, resolve: ResolvePresentation): UIMessage[] {
  const out: UIMessage[] = [];
  let pendingFoldable: PendingFoldable[] = [];
  let summarySeq = 0;
  let didFold = false;

  const flushSummary = () => {
    if (pendingFoldable.length === 0) return;

    const folded = pendingFoldable;
    pendingFoldable = [];

    // Fold: every completed tool (incl. errored ones, counted as errors) folds
    // into a single activity summary (no count threshold).
    const summary = formatExploredActivitySummary(
      folded.map((f) => f.part),
      resolve
    );
    if (!summary) {
      for (const item of folded) {
        out.push(emitPartMessage(item.source, item.part, item.partIndex));
      }
      return;
    }

    didFold = true;
    out.push({
      id: `${ACTIVITY_SUMMARY_ID_PREFIX}${turn.userMessageId ?? "orphan"}:${summarySeq++}`,
      role: "assistant",
      parts: [{ type: "text", content: summary } as TextPart],
      // What this row stands in for. `flattenMessage` spreads the row, so the field survives into
      // the static rows the marker counts.
      sourceMessageIds: [...new Set(folded.map((item) => item.source.id))],
    } as UIMessage & { sourceMessageIds: string[] });
  };

  for (const message of turn.messages) {
    if (message.role === "user") {
      flushSummary();
      out.push(message);
      continue;
    }

    if (message.role !== "assistant") {
      flushSummary();
      out.push(message);
      continue;
    }

    const parts = message.parts ?? [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      if (part.type === "text") {
        if (!getTextContent(part as TextPart)) continue;
        flushSummary();
        out.push(emitPartMessage(message, part, i));
        continue;
      }

      if (part.type === "image") {
        flushSummary();
        out.push(emitPartMessage(message, part, i));
        continue;
      }

      if (!isToolCallPart(part)) {
        continue;
      }

      // Errored tool rows fold into the pending run like completed ones;
      // they surface in the summary as an error count instead of vanishing.
      if (shouldFoldToolRow(part, resolve, isBuiltinToolForRow)) {
        pendingFoldable.push({ part, source: message, partIndex: i });
        continue;
      }

      flushSummary();
      out.push(emitPartMessage(message, part, i));
    }
  }

  flushSummary();

  // Nothing folded — keep original messages (stable ids).
  if (!didFold) {
    return turn.messages;
  }

  return out;
}

/**
 * Project transcript for compact display.
 *
 * Density-first: most tools stay as one-line rows. Only long runs of completed
 * exploration tools collapse into path-aware activity summaries; errored tool
 * rows fold into those summaries as an error count.
 */
// Memo storage for {@link projectTranscriptForDisplay} — one entry per display
// mode (bounded set of modes), compared by message reference identity.
const PROJECTION_MEMO_LIMIT = 4;
const projectionMemo = new Map<string, { refs: UIMessage[]; projected: UIMessage[]; resolve: ResolvePresentation }>();

export function projectTranscriptForDisplay(
  messages: UIMessage[],
  options: {
    mode: TranscriptDisplayMode;
    resolvePresentation?: ResolvePresentation;
    /** Cache namespace for a session switch; message refs normally cover this too. */
    sessionId?: string;
  }
): UIMessage[] {
  if (options.mode !== "compact" || messages.length === 0) return messages;

  // Memoize by element reference identity: the input is the static (non-streaming)
  // portion, whose message objects keep identity across stream ticks. Falls back
  // to recompute whenever any message is rebuilt (covers tool-state changes in
  // the static portion too, since those arrive as new message objects).
  // Explicit FIFO eviction (insertion-order delete of the oldest key).
  const resolve = options.resolvePresentation ?? resolveToolPresentation;
  const memoKey = `${options.mode}:${options.sessionId ?? ""}`;
  const cached = projectionMemo.get(memoKey);
  if (
    cached &&
    cached.resolve === resolve &&
    cached.refs.length === messages.length &&
    cached.refs.every((ref, i) => ref === messages[i])
  ) {
    return cached.projected;
  }

  const turns = groupTurns(messages);
  const result: UIMessage[] = [];

  for (const turn of turns) {
    result.push(...collapseTurn(turn, resolve));
  }

  projectionMemo.set(memoKey, { refs: messages.slice(), projected: result, resolve });
  if (projectionMemo.size > PROJECTION_MEMO_LIMIT) {
    const oldest = projectionMemo.keys().next().value;
    if (oldest !== undefined) projectionMemo.delete(oldest);
  }

  return result;
}

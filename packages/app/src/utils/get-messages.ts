import {
  computeMessageRenderSignature,
  dedupeToolCallsInMessages,
  normalizeToolPartsInMessages,
  shouldFlattenPart,
} from "./dedupe-tool-calls.js";
import {
  getFlatMessage,
  getFlatByRef,
  getStaticFlattenSnapshot,
  setFlatMessage,
  setFlatByRef,
  setStaticFlattenSnapshot,
} from "./message-flat-cache.js";
import { projectTranscriptForDisplay, type TranscriptDisplayMode } from "./project-transcript.js";

import type { ImagePart, TextPart, UIMessage } from "@tanstack/ai";

export type GetMessagesOptions = {
  mode?: TranscriptDisplayMode;
  /**
   * Static-input cap in messages. When set, the static portion is derived from the
   * last `window` messages instead of the whole transcript, and the truncation marker
   * must account for the dropped prefix. Omitted (the default) keeps the full-history
   * path — the subagent preview panel relies on seeing every message to locate its
   * prompt, so windowing is opt-in per caller.
   */
  window?: number;
  /**
   * Cache namespace for the flatten snapshot. Callers that pass the same `mode` must
   * pass distinct namespaces, otherwise they evict each other's snapshots.
   */
  namespace?: string;
};

/** Default cache namespace for callers that only need one slot. */
const DEFAULT_NAMESPACE = "transcript";

/**
 * Synthetic per-turn context rows (`<ctx kind=…>`) are persisted for the model but hidden
 * in the transcript. They must be excluded both from rendering and from window-boundary
 * selection: treating one as a turn boundary would leave the real user message outside
 * the window (see {@link resolveWindowStart}).
 */
export const isSyntheticContextMessage = (message: UIMessage): boolean => {
  if (message.role !== "user") return false;
  if (message.parts.length !== 1) return false;
  const part = message.parts[0];
  if (part.type !== "text") return false;
  return (part.content ?? "").trimStart().startsWith("<ctx kind=");
};

const filterValidMessage = (message: UIMessage) => {
  if (message.role === "assistant") {
    const onlyPart = message.parts.length === 1 ? message.parts[0] : null;
    // thinking-only rows are display-hidden (MessageView also skips thinking parts).
    if (onlyPart?.type === "thinking" || onlyPart?.type === "tool-result" || !onlyPart?.type) return false;
  }
  if (message.role === "user" || message.role === "assistant") {
    if (message.parts.length === 1 && message.parts[0].type === "text") {
      const content = message.parts[0].content?.trim() ?? "";
      if (content.length === 0) return false;
      // Synthetic context messages (<ctx kind=...>) are persisted for the model but hidden in the transcript.
      if (message.role === "user" && content.startsWith("<ctx kind=")) return false;
    }
  }
  return true;
};

function flattenMessage(message: UIMessage): UIMessage[] {
  // Keep user text + image parts together so UserMessageView can compose inline refs.
  if (message.role === "user") {
    return [message];
  }
  return message.parts.reduce<UIMessage[]>((parts, part, index) => {
    if (!shouldFlattenPart(part)) return parts;
    parts.push({ ...message, id: message.id + "-" + index, parts: [part] });
    return parts;
  }, []);
}

function resolveStaticRows(message: UIMessage): UIMessage[] {
  // Pure function of the message, so object identity is the cache key: a rebuilt message
  // is a new object (stream updates are immutable), which makes a stale hit impossible —
  // strictly safer than the content digest this replaces, and free when nothing changed.
  const byRef = getFlatByRef(message);
  if (byRef) return byRef;

  // Level 2: keyed by message id. Still needed — `resolveStaticRows` is called on
  // projection output, whose rows are rebuilt while the underlying message id is stable.
  // Keying on the digest is what keeps those rebuilds honest.
  const signature = computeMessageRenderSignature(message);
  const cached = getFlatMessage(message.id);
  if (cached && cached.signature === signature) {
    return cached.flat;
  }

  const flatMessage = flattenMessage(message);
  setFlatMessage(message.id, { signature, flat: flatMessage });
  setFlatByRef(message, flatMessage);
  return flatMessage;
}

/**
 * Pick the static-input window start, backing up to the nearest user message.
 *
 * The start MUST land on a user message: `projectTranscriptForDisplay` groups by turn and
 * derives each activity summary's id from `turn.userMessageId` (`display-activity:<uid>:<seq>`).
 * Starting mid-turn leaves that turn's user message outside the window, so the group is
 * built with `userMessageId: null` and the summary id degrades to
 * `display-activity:orphan:0` — every summary row's key changes, the flat cache misses and
 * React remounts the rows. Backing up one message is not enough either: a turn's user
 * message can be preceded by synthetic `<ctx kind=…>` rows, which are stripped before
 * windowing, so we scan for the nearest surviving user message.
 *
 * Returns 0 (no windowing) when no user message is in range — never mid-turn.
 */
function resolveWindowStart(messages: UIMessage[], windowSize: number): number {
  // Count only messages that will survive the synthetic-context filter, so the window
  // holds `windowSize` *visible* messages regardless of how many context rows ride along.
  let remaining = windowSize;
  let boundary = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isSyntheticContextMessage(messages[i])) continue;
    if (--remaining === 0) {
      boundary = i;
      break;
    }
  }
  if (boundary < 0) return 0;

  for (let i = boundary; i >= 0; i--) {
    if (messages[i]?.role === "user" && !isSyntheticContextMessage(messages[i])) return i;
  }
  return 0;
}

/**
 * Split messages into static (completed) and dynamic (streaming) portions.
 * Compact mode selectively folds exploration tools before flatten/split.
 *
 * `options.window` caps how much history enters the static derivation; the truncation
 * marker then accounts for both the dropped prefix and the rendered-row cap.
 *
 * TODO(cleanup): Drop `dedupeToolCallsInMessages` once legacy duplicate-id sessions
 * are out of scope — core suppress-replayed already keeps new transcripts clean.
 */
export const getMessages = (messages: UIMessage[], options: GetMessagesOptions = {}) => {
  const mode = options.mode ?? "full";
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;

  // Windowing happens FIRST, so every downstream pass (normalize, dedupe, projection,
  // flatten, fingerprint) sees only the window instead of the whole session — that is
  // where the per-render cost was going. The boundary is resolved on the raw array but
  // skips synthetic context rows, because those are stripped below and must not be
  // mistaken for a turn boundary.
  //
  // Legacy-session caveat: a message dropped by the window no longer contributes a
  // dedupe anchor, so a duplicate toolCallId whose first occurrence fell outside the
  // window stays visible. Only affects pre-`suppress-replayed` sessions (see the
  // TODO(cleanup) on `dedupeToolCallsInMessages`).
  const windowStart = options.window ? resolveWindowStart(messages, options.window) : 0;
  const windowedMessages = windowStart > 0 ? messages.slice(windowStart) : messages;

  const normalizedMessages = normalizeToolPartsInMessages(windowedMessages);
  // Temporary display-only safety net for old sessions with cloned toolCallIds.
  const dedupedMessages = dedupeToolCallsInMessages(normalizedMessages);
  const withoutTurnContext = dedupedMessages.filter((message) => !isSyntheticContextMessage(message));
  // Windowing already ran above; these are the surviving messages.
  const lastMessage = withoutTurnContext.length > 0 ? withoutTurnContext[withoutTurnContext.length - 1] : null;
  // Messages that entered the static derivation and produced no rendered row survive as
  // a count, so the truncation marker stays in ONE unit (messages) instead of mixing the
  // window's message count with the row cap's row count.
  //
  // `lastMessage` is resolved against the ctx-filtered array but `staticSource` must slice
  // the SAME array: slicing the pre-filter `windowedMessages` drops whichever message
  // happens to sit last there, so whenever a synthetic `<ctx kind=…>` row trails the turn
  // the real last message is sliced away *and* also emitted as the dynamic row — it renders
  // twice (statically and dynamically) until the next append. Only the trailing row can be
  // affected, which is why the duplication appears and then heals on its own.
  const staticSource = lastMessage ? withoutTurnContext.slice(0, -1) : withoutTurnContext;
  const projectedStatic = projectTranscriptForDisplay(staticSource, { mode });

  const staticMessages = resolveStaticRowsForStaticSource(projectedStatic, namespace, mode);
  // One invalidation signature per rendered static row, derived from that row's own
  // content. `staticMessages` is already flattened to one row per message for the static
  // region, so the signature is computed over the same rows the renderer will cache.
  // Deliberately excludes `mode`/window/id components: those are cross-row (a projection
  // change must not silently reuse a cached row), so callers keep them as separate deps.
  const staticSignatures = staticMessages.map(computeMessageRenderSignature);
  const dynamicMessages: UIMessage[] = [];
  if (lastMessage) {
    if (lastMessage.role === "user") {
      dynamicMessages.push(lastMessage);
    } else {
      for (let idx = 0; idx < lastMessage.parts.length; idx++) {
        const part = lastMessage.parts[idx];
        if (!shouldFlattenPart(part)) continue;
        dynamicMessages.push({ ...lastMessage, id: lastMessage.id + "-" + idx, parts: [part] });
      }
    }
  }
  const validDynamicMessages = dynamicMessages.filter(filterValidMessage);

  return {
    staticMessages,
    staticSignatures,
    dynamicMessages: validDynamicMessages,
    /**
     * Messages not represented in the transcript at all: the window prefix plus every
     * static source message that produced no row (thinking-only, tool-result-only, …).
     * `MessageList` subtracts the messages visible in the rendered cap to get the marker
     * total. Kept in MESSAGES so the marker never mixes units.
     */
    hiddenSourceMessages: windowStart + Math.max(0, staticSource.length - countSourceMessages(staticMessages)),
  };
};

/**
 * Flatten the static portion, reusing the previous frame's rows where identity holds.
 *
 * The static source's messages keep object identity across ticks (only the streaming
 * tail is rebuilt), so a full pointer comparison usually matches and we return the prior
 * arrays untouched — skipping both the digest and the row predicate for every message.
 * When one message is rebuilt, only its own rows are recomputed; the rest are carried
 * over by identity, which also keeps the downstream `MessageView` memo intact.
 */
function resolveStaticRowsForStaticSource(
  projectedStatic: UIMessage[],
  namespace: string,
  mode: TranscriptDisplayMode
): UIMessage[] {
  const snapshot = getStaticFlattenSnapshot(namespace, mode);
  const canReuse = snapshot !== undefined && snapshot.srcRefs.length === projectedStatic.length;

  // Fully unchanged frame: hand back the previous arrays outright, so neither the digest
  // nor the row predicate runs at all. This is the common case — the static source keeps
  // object identity while only the streaming tail is rebuilt.
  if (canReuse && snapshot.srcRefs.every((ref, i) => ref === projectedStatic[i])) {
    return snapshot.validRows;
  }

  // Partially changed frame: recompute only the messages whose identity moved. A window
  // slide replaces one message at the head, so this is typically a single recompute while
  // every other message keeps its previous row arrays (and thus its `MessageView` memo).
  const perMessage = projectedStatic.map((message, i) => {
    if (canReuse && snapshot.srcRefs[i] === message) return snapshot.perMessage[i];
    return resolveStaticRows(message);
  });

  const validRows = perMessage.flat().filter(filterValidMessage);
  setStaticFlattenSnapshot(namespace, mode, {
    srcRefs: projectedStatic.slice(),
    perMessage,
    validRows,
  });
  return validRows;
}

export function getTextContent(part: TextPart): string {
  return part.content?.trim() ?? "";
}

/**
 * Strip the part index from a flattened row id.
 *
 * Assistant rows are named `<sourceMessageId>-d<partIndex>` by `projectTranscriptForDisplay`
 * and `<sourceMessageId>-<partIndex>` by the dynamic path in `getMessages`, so the trailing
 * index is always the last `-<digits>` group.
 */
const ROW_ID_SUFFIXES = [/-d\d+$/, /-\d+$/];

function sourceIdOf(rowId: string): string {
  for (const suffix of ROW_ID_SUFFIXES) {
    const match = suffix.exec(rowId);
    if (match) return rowId.slice(0, match.index);
  }
  return rowId;
}

/**
 * Distinct source messages represented by a set of flattened rows.
 *
 * The split is driven by `role`, not by guessing at the id: `flattenMessage` returns user
 * messages unchanged, so a user row's id IS its source id and must never be split, while
 * every assistant row carries a part index appended by the projection.
 *
 * Suffix-stripping every row instead (the previous behaviour) silently merged messages
 * whose own ids end in digits — `msg-user-0` / `msg-user-1`, or the
 * `ctx-<kind>-<hash>-<nonce>` form core mints — which under-reported the hidden count.
 */
export function countSourceMessages(rows: UIMessage[]): number {
  const seen = new Set<string>();
  for (const row of rows) seen.add(row.role === "user" ? row.id : sourceIdOf(row.id));
  return seen.size;
}

export function getImageUrl(part: ImagePart): string {
  if (part.source.type === "url") return part.source.value;
  if (part.source.type === "data") return part.source.value;
  return "";
}

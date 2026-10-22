/**
 * Session history reader — the shared core behind the `session_search` / `session_read` tools.
 *
 * Past conversation lives in ONE authoritative shape: `.agents/sessions/<id>.session.jsonl`, the
 * append-only log, one message per line. Compaction only APPENDS a summary checkpoint to the
 * channel — it never removes the pre-cut messages — and the session is persisted from that
 * channel, so the log is the complete conversation. (The `.agents/transcripts/<id>/compact-<N>.md`
 * archives are a derived, lower-fidelity serialization of messages that still exist in the log;
 * they are deliberately NOT searched here.) Message text is nested in JSON, so a raw line match is
 * not readable; folding is delegated to the persistence module (`readLog` + `foldLog`).
 *
 * Everything is read through `CoreEnv.fs` (relative workspace paths, like `SessionStore`), so the
 * tools work unchanged against a remote workspace. Scans are bounded by session count, collected
 * matches and rendered content; logs are streamed line by line, so file size is not a search bound.
 */

import { truncateText } from "../../../../utils/text-truncation.js";
import { isCompactionSummaryUIMessage } from "../../../compaction/compaction-summary.js";
import {
  foldLog,
  getJournalPath,
  iterateLogLines,
  mergeFoldedMessage,
  readLog,
} from "../../../persistence/session-journal.js";
import { SESSION_DIR, SESSION_LOG_SUFFIX } from "../../../persistence/types.js";
import { isToolCallPart, partTextContent } from "../../../stream/message-parts.js";
import { OUTPUT_LIMITS } from "../../shared/output-limits.js";

import type { ResolvedCoreEnv } from "../../../../env";
import type { PersistedUIMessage } from "../../../persistence/types.js";
import type { UIMessage } from "@tanstack/ai";

// ============================================================================
// Limits
// ============================================================================

/** Maximum session logs scanned per call (newest first). */
export const MAX_SESSIONS_SCANNED = 200;
/** Hard ceiling on collected matches (before the tool's own limit is applied). */
export const MAX_MATCHES_COLLECTED = 500;
/** Maximum length of a match snippet (kept within the shared per-line limit). */
export const MAX_SNIPPET_CHARS = Math.min(300, OUTPUT_LIMITS.MAX_LINE_CHARS);
/** Characters of context shown before the match in a snippet. */
const SNIPPET_LEAD = 80;

/** Roles searched when the caller does not name one. */
export const DEFAULT_SEARCH_ROLES = ["user", "assistant"] as const;

// ============================================================================
// Shapes
// ============================================================================

/**
 * A message's position relative to its session's latest compaction summary:
 * `current` = at/after the summary (still in that session's model context);
 * `shadowed` = before it (compacted out of context, present only in the log).
 */
export type EventSurface = "current" | "shadowed";

/** One message of a session, rendered for retrieval. */
export interface SessionMessage {
  sessionId: string;
  /** 0-based position in the folded conversation. */
  index: number;
  role: string;
  /** Epoch ms when known. */
  timestamp?: number;
  /** Whether the message is still in context or compacted out. */
  surface: EventSurface;
  /** Extracted text of the message (text parts joined). */
  text: string;
  /** One-line summary of the message's tool calls, or null. */
  toolSummary: string | null;
}

/** One search hit — a matching message in a session log. */
export interface HistoryMatch {
  sessionId: string;
  role?: string;
  timestamp?: number;
  snippet: string;
  /** Whether the message is still in context or compacted out. */
  surface: EventSurface;
  /** 0-based message index within the session — pass to `session_read` to read the context. */
  messageIndex?: number;
}

export interface SearchHistoryOptions {
  query: string;
  /** Restrict to one session (also disables the default current-session exclusion). */
  sessionId?: string;
  /** Restrict to one role. */
  role?: string;
  /** Inclusive lower bound on message time (epoch ms). */
  since?: number;
  /** Inclusive upper bound on message time (epoch ms). */
  until?: number;
  /** Maximum matches returned. */
  limit: number;
  /** Session to exclude unless `sessionId` explicitly names it. */
  excludeSessionId?: string;
}

export interface SearchHistoryResult {
  matches: HistoryMatch[];
  /** Total matches found within the scanned scope, before `limit`. */
  total: number;
  /** Whether the result was cut short (session cap, match/content cap, or a skipped unreadable log). */
  truncated: boolean;
}

// ============================================================================
// Message extraction
// ============================================================================

/** A persisted UI message part, viewed loosely (parts vary by type). */
interface PartLike {
  type?: string;
  content?: unknown;
  name?: unknown;
  arguments?: unknown;
}

function partsOf(message: PersistedUIMessage): PartLike[] {
  return Array.isArray(message.parts) ? (message.parts as PartLike[]) : [];
}

/** Text of a message: its text parts joined; media/other parts contribute nothing. */
export function messageText(message: PersistedUIMessage): string {
  const parts: string[] = [];
  for (const part of partsOf(message)) {
    const text = partTextContent(part);
    if (text) parts.push(text);
  }
  return parts.join("\n").trim();
}

/** One-line summary of the message's tool calls, or null when it has none. */
export function messageToolSummary(message: PersistedUIMessage): string | null {
  const calls: string[] = [];
  for (const part of partsOf(message)) {
    if (!isToolCallPart(part)) continue;
    const name = typeof part.name === "string" ? part.name : "tool";
    const rawArgs = typeof part.arguments === "string" ? part.arguments : "";
    const args = truncateText(rawArgs, 100);
    calls.push(args ? `${name}(${args})` : `${name}()`);
  }
  return calls.length > 0 ? calls.join(" ") : null;
}

/** Epoch ms of a message: our write stamp, else the (ISO) creation time. */
function messageTimestamp(message: PersistedUIMessage): number | undefined {
  const updated = message.updatedAt;
  if (typeof updated === "number" && Number.isFinite(updated)) return updated;
  if (typeof updated === "string") {
    const parsed = Number(updated);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof message.createdAt === "string") {
    const parsed = Date.parse(message.createdAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toSessionMessage(
  sessionId: string,
  index: number,
  message: PersistedUIMessage,
  surface: EventSurface
): SessionMessage {
  return {
    sessionId,
    index,
    role: typeof message.role === "string" ? message.role : "unknown",
    timestamp: messageTimestamp(message),
    surface,
    text: messageText(message),
    toolSummary: messageToolSummary(message),
  };
}

/**
 * Index of a session's latest compaction summary — the boundary between `shadowed` (before it,
 * compacted out of that session's context) and `current` (at/after it). `0` when the session never
 * compacted, so every message is `current`.
 */
function latestSummaryIndex(messages: PersistedUIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactionSummaryUIMessage(messages[i]!)) return i;
  }
  return 0;
}

// ============================================================================
// Session enumeration
// ============================================================================

/** Session ids present on disk, newest-modified first. */
export async function listSessionIds(env: ResolvedCoreEnv): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof env.fs.readdir>>;
  try {
    if (!(await env.fs.exists(SESSION_DIR))) return [];
    entries = await env.fs.readdir(SESSION_DIR);
  } catch {
    return [];
  }

  const ids = entries
    .filter((entry) => entry.name.endsWith(SESSION_LOG_SUFFIX))
    .map((entry) => entry.name.slice(0, -SESSION_LOG_SUFFIX.length));

  const stamped = await Promise.all(
    ids.map(async (id) => {
      try {
        const stat = await env.fs.stat(getJournalPath(id));
        return { id, mtime: stat.mtime.getTime() };
      } catch {
        return { id, mtime: 0 };
      }
    })
  );
  return stamped.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.id);
}

/**
 * One contiguous window of a session's messages, folded without materializing the whole log.
 *
 * `offset` is a 0-based MESSAGE index (the same value `session_search` reports), not a file line.
 * The scan still walks the log once — updates for an earlier message can be appended later — but
 * it keeps only the unique-id order and the messages inside the requested window, so memory is
 * bounded by the number of messages plus `limit`, not by the file's rendered content.
 */
export async function readSessionMessageWindow(
  env: ResolvedCoreEnv,
  sessionId: string,
  offset: number,
  limit: number
): Promise<{ messages: SessionMessage[]; total: number }> {
  const path = getJournalPath(sessionId);
  try {
    if (!(await env.fs.exists(path))) return { messages: [], total: 0 };
  } catch {
    return { messages: [], total: 0 };
  }

  const indexById = new Map<string, number>();
  const windowMessages = new Map<number, PersistedUIMessage>();
  let nextIndex = 0;
  let summaryBoundaryIndex = 0;
  const end = offset + limit;

  try {
    for await (const line of iterateLogLines(env.fs, path)) {
      const message = line.message;
      if (!message) continue;
      let index = indexById.get(message.id);
      if (index === undefined) {
        index = nextIndex++;
        indexById.set(message.id, index);
      }
      if (isCompactionSummaryUIMessage(message as unknown as UIMessage)) {
        summaryBoundaryIndex = Math.max(summaryBoundaryIndex, index);
      }
      if (index >= offset && index < end) {
        const previous = windowMessages.get(index);
        windowMessages.set(index, mergeFoldedMessage(previous, message, line.messageUpdatedAt));
      }
    }
  } catch {
    // A log that vanished or became unreadable is an empty window rather than a raw IO error.
    return { messages: [], total: 0 };
  }

  const messages: SessionMessage[] = [];
  for (let index = offset; index < end && index < indexById.size; index++) {
    const message = windowMessages.get(index);
    if (!message) continue;
    messages.push(toSessionMessage(sessionId, index, message, index >= summaryBoundaryIndex ? "current" : "shadowed"));
  }
  return { messages, total: indexById.size };
}

/**
 * All messages of one session, folded and in order. Empty when the log is missing.
 *
 * A legacy whole-log helper used by validators and ad-hoc callers; the tools themselves use the
 * streaming window/search paths. It folds the whole log, so its memory is O(messages), not O(file).
 */
export async function readSessionMessages(env: ResolvedCoreEnv, sessionId: string): Promise<SessionMessage[]> {
  const path = getJournalPath(sessionId);
  try {
    if (!(await env.fs.exists(path))) return [];
    const lines = await readLog(env.fs, path);
    const { uiMessages } = foldLog(lines);
    const summaryIndex = latestSummaryIndex(uiMessages as PersistedUIMessage[]);
    return uiMessages.map((message, index) =>
      toSessionMessage(sessionId, index, message as PersistedUIMessage, index >= summaryIndex ? "current" : "shadowed")
    );
  } catch {
    return [];
  }
}

/** Whether a session log exists on disk. */
export async function sessionExists(env: ResolvedCoreEnv, sessionId: string): Promise<boolean> {
  try {
    return await env.fs.exists(getJournalPath(sessionId));
  } catch {
    return false;
  }
}

// ============================================================================
// Snippets
// ============================================================================

/** Build a match snippet, centered on the first occurrence when there is one. */
export function makeSnippet(text: string, query: string, max = MAX_SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;

  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return truncateText(flat, max);

  const start = Math.max(0, at - SNIPPET_LEAD);
  const end = Math.min(flat.length, start + max);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

// ============================================================================
// Search
// ============================================================================

/** Whether a message timestamp is inside the inclusive window (no window = always in). */
function inTimeWindow(ts: number | undefined, since?: number, until?: number): boolean {
  if (since === undefined && until === undefined) return true;
  if (ts === undefined) return false;
  if (since !== undefined && ts < since) return false;
  if (until !== undefined && ts > until) return false;
  return true;
}

/** Collect literal, case-insensitive matches from one session's log, without folding it. */
async function searchSessionStream(
  env: ResolvedCoreEnv,
  sessionId: string,
  query: string,
  roles: readonly string[],
  timeWindow: { since?: number; until?: number },
  collect: (match: HistoryMatch) => boolean
): Promise<{ total: number; collected: number }> {
  const path = getJournalPath(sessionId);
  if (!(await env.fs.exists(path))) return { total: 0, collected: 0 };

  const indexById = new Map<string, number>();
  const matchedIds = new Set<string>();
  // Only the first bounded candidates need a body; `matchedIds` keeps the exact total. Messages
  // are visited in first-seen order, so a later update to a candidate replaces its body.
  const candidates = new Map<number, PersistedUIMessage>();
  let nextIndex = 0;
  let summaryBoundaryIndex = 0;

  for await (const line of iterateLogLines(env.fs, path)) {
    const message = line.message;
    if (!message) continue;
    let index = indexById.get(message.id);
    if (index === undefined) {
      index = nextIndex++;
      indexById.set(message.id, index);
    }
    if (isCompactionSummaryUIMessage(message as unknown as UIMessage)) {
      summaryBoundaryIndex = Math.max(summaryBoundaryIndex, index);
    }

    const text = messageText(message);
    const role = typeof message.role === "string" ? message.role : "unknown";
    const timestamp = messageTimestamp(message);
    const matches =
      text.length > 0 &&
      roles.includes(role) &&
      inTimeWindow(timestamp, timeWindow.since, timeWindow.until) &&
      text.toLowerCase().includes(query);

    if (matches) {
      matchedIds.add(message.id);
      // Keep updating an existing candidate even after the cap; only a NEW candidate is refused.
      if (candidates.has(index) || candidates.size < MAX_MATCHES_COLLECTED) {
        candidates.set(index, mergeFoldedMessage(candidates.get(index), message, line.messageUpdatedAt));
      }
    } else if (matchedIds.delete(message.id)) {
      // A later line can change a previously matching message (approval state, rewritten text).
      candidates.delete(index);
    }
  }

  for (const [index, message] of [...candidates.entries()].sort(([a], [b]) => a - b)) {
    const text = messageText(message);
    if (!text) continue;
    collect({
      sessionId,
      role: typeof message.role === "string" ? message.role : "unknown",
      timestamp: messageTimestamp(message),
      surface: index >= summaryBoundaryIndex ? "current" : "shadowed",
      messageIndex: index,
      snippet: makeSnippet(text, query),
    });
  }
  return { total: matchedIds.size, collected: candidates.size };
}

/**
 * Search past conversation.
 *
 * Matches come from the session logs — the complete conversation — newest session first, then
 * message order. The scan is bounded by {@link MAX_SESSIONS_SCANNED} and
 * {@link MAX_MATCHES_COLLECTED}/the content ceiling; when a bound is hit `truncated` is true so the
 * caller can say so. File size is not a search bound: the log is streamed line by line.
 */
export async function searchHistory(env: ResolvedCoreEnv, options: SearchHistoryOptions): Promise<SearchHistoryResult> {
  const query = options.query.toLowerCase();
  const roles = options.role ? [options.role] : DEFAULT_SEARCH_ROLES;

  let sessionIds: string[];
  if (options.sessionId) {
    sessionIds = [options.sessionId];
  } else {
    sessionIds = (await listSessionIds(env)).filter((id) => id !== options.excludeSessionId);
  }

  const matches: HistoryMatch[] = [];
  let total = 0;
  let truncated = false;
  let contentChars = 0;
  const collect = (match: HistoryMatch): boolean => {
    // Bound the result by count AND accumulated size, so a query matching many long messages
    // cannot overflow the model context even if the caller raises `limit`.
    if (
      matches.length >= MAX_MATCHES_COLLECTED ||
      contentChars + match.snippet.length > OUTPUT_LIMITS.MAX_CONTENT_CHARS
    ) {
      truncated = true;
      return false;
    }
    contentChars += match.snippet.length;
    matches.push(match);
    return true;
  };

  const scanned = sessionIds.slice(0, MAX_SESSIONS_SCANNED);
  if (sessionIds.length > scanned.length) truncated = true;

  for (const id of scanned) {
    try {
      const found = await searchSessionStream(
        env,
        id,
        query,
        roles,
        { since: options.since, until: options.until },
        collect
      );
      total += found.total;
      // A session with more matches than the candidate cap means the result list is incomplete,
      // even when the caller's own `limit` is smaller than the cap.
      if (found.total > found.collected) truncated = true;
    } catch {
      // A log can vanish or become unreadable between enumeration and read (remote/HTTP, delete
      // race). Skip that session rather than failing the whole search.
      truncated = true;
    }
  }

  return {
    matches: matches.slice(0, options.limit),
    total,
    truncated,
  };
}

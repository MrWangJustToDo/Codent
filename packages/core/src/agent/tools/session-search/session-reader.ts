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
 * tools work unchanged against a remote workspace. Every scan is bounded — per-file size, file
 * count, and collected matches — so a large history cannot blow the model context or the turn.
 */

import { getEnv } from "../../../env";
import { isCompactionSummaryUIMessage } from "../../compaction/compaction-summary.js";
import { foldLog, getJournalPath, readLog } from "../../persistence/session-journal.js";
import { SESSION_DIR, SESSION_LOG_SUFFIX } from "../../persistence/types.js";
import { isToolCallPart, partTextContent } from "../../stream/message-parts.js";
import { OUTPUT_LIMITS } from "../util/output-limits.js";

import type { PersistedUIMessage } from "../../persistence/types.js";

// ============================================================================
// Limits
// ============================================================================

/** Maximum session logs scanned per call (newest first). */
export const MAX_SESSIONS_SCANNED = 200;
/** Maximum size of one session log before it is skipped as too large to read. */
export const MAX_SESSION_FILE_BYTES = 8 * 1024 * 1024;
/** Cumulative bytes read across the whole search, so many large logs cannot blow up a turn. */
export const MAX_SCAN_BYTES = 32 * 1024 * 1024;
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
  /** Whether the scan itself was cut short (session/file cap or an oversized file). */
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
  return Array.isArray(message.parts) ? (message.parts as unknown as PartLike[]) : [];
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
    const args = rawArgs.length > 100 ? `${rawArgs.slice(0, 100)}…` : rawArgs;
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
export async function listSessionIds(): Promise<string[]> {
  const env = getEnv();
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
 * All messages of one session, folded and in order. Empty when the log is missing.
 *
 * Reads the whole log: `searchHistory` bounds *scanning* by per-file size, but a direct
 * `session_read` folds whatever the file holds — bounding the model-visible result is the
 * tool's job (message-count + rendered-size caps, then the output cache/preview spill).
 */
export async function readSessionMessages(sessionId: string): Promise<SessionMessage[]> {
  const env = getEnv();
  const path = getJournalPath(sessionId);
  try {
    if (!(await env.fs.exists(path))) return [];
    const lines = await readLog(env.fs, path);
    const { uiMessages } = foldLog(lines);
    const summaryIndex = latestSummaryIndex(uiMessages as unknown as PersistedUIMessage[]);
    return uiMessages.map((message, index) =>
      toSessionMessage(
        sessionId,
        index,
        message as unknown as PersistedUIMessage,
        index >= summaryIndex ? "current" : "shadowed"
      )
    );
  } catch {
    return [];
  }
}

/** Whether a session log exists on disk. */
export async function sessionExists(sessionId: string): Promise<boolean> {
  try {
    return await getEnv().fs.exists(getJournalPath(sessionId));
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
  if (at < 0) return `${flat.slice(0, max)}…`;

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

/** Collect literal, case-insensitive matches from one session's messages. */
function searchSession(
  sessionId: string,
  messages: SessionMessage[],
  query: string,
  roles: readonly string[],
  window: { since?: number; until?: number },
  collect: (match: HistoryMatch) => boolean
): number {
  let found = 0;
  for (const message of messages) {
    if (!roles.includes(message.role)) continue;
    if (!message.text) continue;
    if (!inTimeWindow(message.timestamp, window.since, window.until)) continue;
    if (!message.text.toLowerCase().includes(query)) continue;
    found += 1;
    collect({
      sessionId,
      role: message.role,
      timestamp: message.timestamp,
      surface: message.surface,
      messageIndex: message.index,
      snippet: makeSnippet(message.text, query),
    });
  }
  return found;
}

/**
 * Search past conversation.
 *
 * Matches come from the session logs — the complete conversation — newest session first, then
 * message order. The scan is bounded by {@link MAX_SESSIONS_SCANNED}, {@link MAX_SCAN_BYTES} and
 * {@link MAX_MATCHES_COLLECTED}; when a bound is hit `truncated` is true so the caller can say so.
 */
export async function searchHistory(options: SearchHistoryOptions): Promise<SearchHistoryResult> {
  const env = getEnv();
  const query = options.query.toLowerCase();
  const roles = options.role ? [options.role] : DEFAULT_SEARCH_ROLES;

  let sessionIds: string[];
  if (options.sessionId) {
    sessionIds = [options.sessionId];
  } else {
    sessionIds = (await listSessionIds()).filter((id) => id !== options.excludeSessionId);
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

  let scannedBytes = 0;
  for (const id of scanned) {
    const path = getJournalPath(id);
    try {
      const stat = await env.fs.stat(path);
      if (stat.size > MAX_SESSION_FILE_BYTES) {
        truncated = true;
        continue;
      }
      // Stop before reading past the cumulative budget: a history of many large logs would
      // otherwise be read in full on every search.
      if (scannedBytes + stat.size > MAX_SCAN_BYTES) {
        truncated = true;
        break;
      }
      scannedBytes += stat.size;
    } catch {
      continue;
    }
    const messages = await readSessionMessages(id);
    total += searchSession(id, messages, query, roles, { since: options.since, until: options.until }, collect);
  }

  return {
    matches: matches.slice(0, options.limit),
    total,
    truncated,
  };
}

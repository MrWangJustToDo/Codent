/**
 * session-journal.ts - Append-only session message log.
 *
 * A session is one JSONL file `.agents/sessions/{id}.session.jsonl`. Every save
 * appends only what changed: one `message` line per new/changed UIMessage, each
 * carrying the full non-message state snapshot at that point. {@link foldLog}
 * reconstructs the session: `state` = the newest line's snapshot, `uiMessages` =
 * message lines folded by id (later line wins, first-seen position).
 *
 * A torn trailing line (crash mid-append) is skipped on read.
 */

import { isToolCallPart } from "../stream/message-parts.js";

import { SESSION_DIR, SESSION_LOG_MESSAGE, SESSION_LOG_SUFFIX } from "./types.js";

import type { PersistedToolCallPart, PersistedUIMessage, SessionLogLine, SessionStateFields } from "./types.js";
import type { CoreEnvFs } from "../../env";
import type { UIMessage } from "@tanstack/ai";

export function getJournalPath(id: string): string {
  return `${SESSION_DIR}/${id}${SESSION_LOG_SUFFIX}`;
}

/**
 * Append `lines` to the log as JSONL. Returns false (no-op) when the env fs does
 * not implement `appendFile`. Saves are serialized per session by
 * {@link SessionStore}, so this cannot race another append.
 */
export async function appendLogLines(fs: CoreEnvFs, path: string, lines: SessionLogLine[]): Promise<boolean> {
  if (lines.length === 0) return true;
  if (!fs.appendFile) return false;
  // Ensure the file exists before appending (some fs impls create it on append).
  if (!(await fs.exists(path))) {
    await fs.writeFile(path, "");
  }
  await fs.appendFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return true;
}

function parseLine(raw: string): SessionLogLine | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as SessionLogLine;
    return parsed && typeof parsed.t === "string" ? parsed : null;
  } catch {
    // Skip torn/corrupt line.
    return null;
  }
}

/** Read all valid log lines in file order. Torn/corrupt lines are skipped. */
export async function readLog(fs: CoreEnvFs, path: string): Promise<SessionLogLine[]> {
  if (!(await fs.exists(path))) return [];
  const content = await fs.readFile(path);
  const lines: SessionLogLine[] = [];
  for (const raw of content.split("\n")) {
    const parsed = parseLine(raw);
    if (parsed) lines.push(parsed);
  }
  return lines;
}

/**
 * Read only the newest line's `state` snapshot.
 *
 * The file has to be read in full (the env fs has no seek/partial read) and the
 * lines split, but only the newest line is JSON-parsed: the scan walks backwards
 * and returns at the first parseable line, skipping a torn trailing line. Used by
 * `list()` so listing long sessions never folds (or parses) their message bodies.
 */
export async function readLastState(fs: CoreEnvFs, path: string): Promise<SessionStateFields | null> {
  if (!(await fs.exists(path))) return null;
  const content = await fs.readFile(path);
  const rawLines = content.split("\n");
  for (let i = rawLines.length - 1; i >= 0; i--) {
    const parsed = parseLine(rawLines[i]!);
    if (parsed?.state) return parsed.state;
  }
  return null;
}

/**
 * Replace the whole log with a compacted form (one line per message).
 *
 * When the env fs implements `rename`, the new body is written to a sibling temp
 * file and renamed into place: a crash mid-rewrite then leaves either the old log
 * or the new one, never a truncated file that silently drops the saved history
 * (an in-place `writeFile` truncates first). Without `rename` this degrades to a
 * direct overwrite — the append path's torn-trailing-line protection does not
 * apply to a rewrite, so that host's save is best-effort.
 */
export async function writeLog(fs: CoreEnvFs, path: string, lines: SessionLogLine[]): Promise<void> {
  const body = lines.map((line) => JSON.stringify(line)).join("\n");
  const content = body ? body + "\n" : "";
  if (fs.rename) {
    const tmpPath = `${path}.tmp`;
    try {
      await fs.writeFile(tmpPath, content);
      await fs.rename(tmpPath, path);
      return;
    } catch {
      // Best-effort cleanup, then fall back to an in-place write rather than
      // dropping the save; a host whose `rename` fails simply stays non-atomic.
      try {
        await fs.remove(tmpPath);
      } catch {
        // The temp file may not exist if the initial write failed.
      }
    }
  }
  await fs.writeFile(path, content);
}

export interface FoldedSessionLog {
  /** Newest non-message state snapshot, or null when absent. */
  state: SessionStateFields | null;
  /** Messages folded by id, in first-seen order. */
  uiMessages: UIMessage[];
  /** toolCallId → time the approval first appeared decided (from the earliest line). */
  approvalAt: Record<string, number>;
}

/**
 * Whether the log contains any user message, parsed from the START and stopping at
 * the first hit: the messages are appended in order, so the first user message is
 * near the top and the common (non-empty) case parses a single line. A session with
 * no user message must have its (short) log walked entirely. Used by
 * `getLatestEmpty()` so it does not fold every message of every candidate.
 *
 * Returns `null` when the log is missing or holds no parseable line.
 */
export async function hasUserMessage(fs: CoreEnvFs, path: string): Promise<boolean | null> {
  if (!(await fs.exists(path))) return null;
  const content = await fs.readFile(path);
  let sawLine = false;
  for (const raw of content.split("\n")) {
    const parsed = parseLine(raw);
    if (!parsed) continue;
    sawLine = true;
    if (parsed.message?.role === "user") return true;
  }
  return sawLine ? false : null;
}

/** Coerce a persisted stamp (v7 number, JSON string, or absent) to epoch ms. */
function toStamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Our write-time stamp carried by a persisted message (`undefined` on a v6 line). */
export function readMessageUpdatedAt(message: PersistedUIMessage): number | undefined {
  return toStamp(message.updatedAt);
}

/** Our decision-time stamp carried by a persisted tool-call part (`undefined` on a v6 line). */
export function readApprovalUpdatedAt(part: PersistedToolCallPart): number | undefined {
  return toStamp(part.approval?.updatedAt);
}

/**
 * Fold log lines into the session they describe.
 *
 * Message lines are keyed by `UIMessage.id`: a later line for the same id
 * replaces the body without moving its position.
 *
 * `approvalAt` records the real decision time of each tool call. On a v7 line the
 * tool-call part itself carries it (`approval.updatedAt`). On a v6 line it is
 * either the line's explicit `approvalAt` entry or — failing that — the earliest
 * line stamp in which that approval appears decided (the line's own
 * `messageUpdatedAt`, else the message stamp that replaced it). Both legacy paths
 * only fill a missing entry, so the EARLIEST line carrying the approval decides
 * its timestamp and a later re-emit or whole-log rewrite cannot overwrite it.
 */
export function foldLog(lines: SessionLogLine[]): FoldedSessionLog {
  let state: SessionStateFields | null = null;
  const byId = new Map<string, PersistedUIMessage>();
  const order: string[] = [];
  const approvalAt: Record<string, number> = {};

  for (const line of lines) {
    if (line.state) state = line.state;

    // Applied BEFORE deriving from the message: an explicit legacy entry is the
    // real decision time and must not be shadowed by a restamped line time.
    if (line.approvalAt) {
      for (const [id, at] of Object.entries(line.approvalAt)) {
        if (approvalAt[id] === undefined) approvalAt[id] = at;
      }
    }

    // A first-line `message: null` carries initial state only.
    const message = line.message;
    if (message) {
      if (!byId.has(message.id)) order.push(message.id);
      const updatedAt = readMessageUpdatedAt(message);
      const lineTime = toStamp(line.messageUpdatedAt);
      const prev = byId.get(message.id);
      // A resumed process holds the first line's body — it may lack `updatedAt`
      // (the seeding write did not stamp) — and rewrites the whole message on its
      // next save, so that later line is the authority for the body.
      const fold: PersistedUIMessage =
        prev && readMessageUpdatedAt(prev) === undefined && lineTime !== undefined && updatedAt !== undefined
          ? { ...prev, ...message }
          : message;
      byId.set(message.id, fold);

      if (fold.role !== "assistant") continue;
      for (const part of fold.parts) {
        if (!isToolCallPart(part)) continue;
        const approval = part.approval;
        if (!approval?.id || approval.approved === undefined) continue;
        if (approvalAt[approval.id] !== undefined) continue;
        const stamp = readApprovalUpdatedAt(part as unknown as PersistedToolCallPart) ?? updatedAt ?? lineTime;
        if (stamp !== undefined) approvalAt[approval.id] = stamp;
      }
    }
  }

  const uiMessages: UIMessage[] = [];
  for (const id of order) {
    const message = byId.get(id);
    if (message) uiMessages.push(message as UIMessage);
  }
  return { state, uiMessages, approvalAt };
}

/** Whether a line's kind is understood by this reader. */
export function isMessageLogLine(line: SessionLogLine): boolean {
  return line.t === SESSION_LOG_MESSAGE;
}

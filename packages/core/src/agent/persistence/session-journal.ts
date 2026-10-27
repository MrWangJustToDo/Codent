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

import { writeFileAtomic } from "../../utils/atomic-write.js";
import { readTextPieces } from "../../utils/read-text-pieces.js";
import { isToolCallPart } from "../stream/message-parts.js";

import { SESSION_DIR, SESSION_LOG_SUFFIX, isSafeSessionId } from "./types.js";

import type { PersistedToolCallPart, PersistedUIMessage, SessionLogLine, SessionStateFields } from "./types.js";
import type { CoreEnvFs } from "../../env";
import type { UIMessage } from "@tanstack/ai";

export function getJournalPath(id: string): string {
  if (!isSafeSessionId(id)) throw new Error(`Invalid session id: ${id}`);
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
 * Session logs are much larger than source files and every `readFileRange` may be one HTTP
 * round-trip on a remote host; 1 MiB keeps the window buffer small while cutting the request count
 * 16x compared with the generic 64 KiB text chunk.
 */
const SESSION_LOG_CHUNK_BYTES = 1024 * 1024;

/**
 * Yield valid log lines one at a time, without materializing the whole file.
 *
 * Uses the shared line-aligned `readTextPieces` chunker, so the session reader and `read_file`
 * cannot disagree about newline alignment, multi-byte boundaries or EOF. Hosts without the range
 * primitive fall back to one `readFile`; the caller still never keeps all parsed messages.
 */
export async function* iterateLogLines(fs: CoreEnvFs, path: string): AsyncGenerator<SessionLogLine> {
  if (!(await fs.exists(path))) return;

  if (fs.readFileRange) {
    let pending = "";
    for await (const piece of readTextPieces(fs, path, SESSION_LOG_CHUNK_BYTES)) {
      let start = 0;
      for (;;) {
        const newline = piece.indexOf("\n", start);
        if (newline === -1) break;
        const parsed = parseLine(pending + piece.slice(start, newline));
        pending = "";
        if (parsed) yield parsed;
        start = newline + 1;
      }
      if (start < piece.length) pending += piece.slice(start);
    }
    if (pending) {
      const parsed = parseLine(pending);
      if (parsed) yield parsed;
    }
    return;
  }

  const content = await fs.readFile(path);
  for (const raw of content.split("\n")) {
    const parsed = parseLine(raw);
    if (parsed) yield parsed;
  }
}

/**
 * How far back from the end to look for the newest `state` line when a range read is available.
 *
 * A log line carries one message plus a full state snapshot, so the newest line is large but
 * bounded — this window covers it with a wide margin (the largest observed line here is well
 * under 1 MB). Failing to find a state line inside it is not an error: {@link readLastState} falls
 * back to the full read, so the cost of a too-small window is one wasted read, never a wrong
 * answer.
 */
const STATE_TAIL_WINDOW_BYTES = 512 * 1024;

/**
 * Read only the newest line's `state` snapshot.
 *
 * Only the newest line is JSON-parsed: the scan walks backwards and returns at the first parseable
 * line, so a torn trailing line (crash mid-append) is skipped rather than aborting the read.
 *
 * Two paths, and the fast one exists because the slow one is on `list()`'s hot path:
 *
 *   - RANGE READ (when the env fs provides `readFileRange`): read a window off the END of the file
 *     and scan it backwards. Two questions decide whether the window is authoritative:
 *       (a) is the window free of fragments? Either it reaches byte 0 (nothing before it), or its
 *           first line is complete (a newline is present). A window with NO newline may be a
 *           fragment of one huge line, so the full read covers it.
 *       (b) did the window actually contain a state line? A whole first line proves (a), NOT this
 *           — a log can carry message lines after its last state line. A window that yields no
 *           state falls through to the full read. Returning null there is the wrong answer that
 *           matters: `list()` would silently drop that session.
 *   - FULL READ (fallback): the original behaviour. Always correct, and the only option for hosts
 *     without `readFileRange` (WebContainer, remote), and the recovery path whenever (a) or (b)
 *     fails above.
 *
 * The fallback is load-bearing, not decorative: `list()`'s contract is "every session", so a tail
 * read that missed a state line would silently DROP a session from the picker. Correctness is
 * carried by `scanBackwardsForState` being the single interpretation of both paths — the fast path
 * and the slow path cannot disagree about what the last state is, because they run the same
 * scanner. Validator case 5 proves the fallback is reachable and necessary: dropping it (returning
 * the window's verdict regardless) makes the read report ZERO sessions.
 */
export async function readLastState(fs: CoreEnvFs, path: string): Promise<SessionStateFields | null> {
  if (!(await fs.exists(path))) return null;

  if (fs.readFileRange) {
    try {
      const stat = await fs.stat(path);
      const size = stat?.size ?? 0;
      if (size > 0) {
        const start = Math.max(0, size - STATE_TAIL_WINDOW_BYTES);
        const tail = await fs.readFileRange(path, start, size);
        // `start === 0` means the window IS the whole file, so its verdict is final.
        if (start === 0) return scanBackwardsForState(tail);
        // Otherwise the window is usable only when its first line is whole (there is a newline in
        // it). The state line is normally the newest one, so a hit here is the common case.
        if (tail.includes("\n")) {
          const found = scanBackwardsForState(tail);
          if (found) return found;
          // Nothing in the window. A whole first line proves the window is not a fragment, but it
          // does NOT prove the state line is inside it — logs whose last state line is followed by
          // more message lines exist. Returning null here would silently DROP the session from
          // `list()`, so fall through to the full read instead.
        }
      }
    } catch {
      // A range read can fail for reasons that say nothing about the file (a host that advertises
      // the primitive but not for this path, a partial window). The full read below is the answer.
    }
  }

  const content = await fs.readFile(path);
  return scanBackwardsForState(content);
}

/**
 * Walk lines backwards, newest first, returning the first line that yields a `state` snapshot.
 *
 * A leading partial line is harmless: the walk starts at the END, so the only line it can return
 * is one it fully sees (the final line's terminator is the end of the input). Shared by both paths
 * in {@link readLastState} so the fast and slow reads cannot drift.
 */
function scanBackwardsForState(content: string): SessionStateFields | null {
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
  await writeFileAtomic(fs, path, content);
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
 * How far from the START to read when hunting the first user message.
 *
 * The opposite anchor from {@link readLastState}'s tail window, for the opposite reason: messages
 * are appended in order, so the first user message is near the TOP. Task logs get huge (44 MB here)
 * while the answer almost always lands in the opening lines, so the whole-file read was paying tens
 * of MB for a few KB of relevance.
 *
 * Hitting the window's end without a verdict is NOT "no user message" — it only means the answer is
 * further in — so that case falls back to the full read. The bias is deliberate: a false "empty"
 * would let `getLatestEmpty()` reuse a session that has history.
 */
const USER_MESSAGE_HEAD_WINDOW_BYTES = 256 * 1024;

/**
 * Whether the log contains any user message, parsed from the START and stopping at
 * the first hit: the messages are appended in order, so the first user message is
 * near the top and the common (non-empty) case parses a single line. A session with
 * no user message must have its (short) log walked entirely. Used by
 * `getLatestEmpty()` so it does not fold every message of every candidate.
 *
 * A head window keeps that promise on a large log: with `readFileRange` available the opening
 * chunk is read instead of the whole file, and only a window that reaches the end of the file
 * without a verdict is trusted. Everything else — no range primitive, the file larger than the
 * window, a window ending mid-line — falls back to the full read rather than guessing.
 *
 * Returns `null` when the log is missing or holds no parseable line.
 */
export async function hasUserMessage(fs: CoreEnvFs, path: string): Promise<boolean | null> {
  if (!(await fs.exists(path))) return null;

  if (fs.readFileRange) {
    try {
      const stat = await fs.stat(path);
      const size = stat?.size ?? 0;
      if (size > 0) {
        const end = Math.min(size, USER_MESSAGE_HEAD_WINDOW_BYTES);
        const head = await fs.readFileRange(path, 0, end);
        // A hit is final. A window that reaches EOF and shows no user message is ALSO final
        // (there is no more file to look at), which is what keeps a short empty session cheap.
        const verdict = scanForwardForUserMessage(head, { complete: end >= size });
        if (verdict !== null) return verdict;
      }
    } catch {
      // Range read unavailable for this path; the full read below is the answer.
    }
  }

  const content = await fs.readFile(path);
  return scanForwardForUserMessage(content, { complete: true });
}

/**
 * Walk lines from the START for a user message, returning as soon as one is found.
 *
 * @param opts.complete Whether `content` reaches the end of the file. When it does not, the final
 *   entry may be a truncated line, so it is not parsed — and reaching the end without a hit is
 *   `null` ("not determinable here") rather than `false` ("no user message"), which is what sends
 *   the caller to the full read instead of reporting a false empty.
 */
function scanForwardForUserMessage(content: string, { complete }: { complete: boolean }): boolean | null {
  const rawLines = content.split("\n");
  const limit = complete ? rawLines.length : rawLines.length - 1;
  let sawLine = false;
  for (let i = 0; i < limit; i++) {
    const parsed = parseLine(rawLines[i]!);
    if (!parsed) continue;
    sawLine = true;
    if (parsed.message?.role === "user") return true;
  }
  // An incomplete tail that has not produced a verdict yet is inconclusive.
  if (!complete) return null;
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

/**
 * Fold one later line of an already-seen message, the ONE replacement rule.
 *
 * A resumed process holds the first line's body, which may lack `updatedAt`; its later whole-message
 * rewrite is authoritative, so merge it over the partial first line. Every other update replaces
 * the body. Search/window streaming and `foldLog` all call this, so they cannot disagree.
 */
export function mergeFoldedMessage(
  previous: PersistedUIMessage | undefined,
  message: PersistedUIMessage,
  legacyLineTime?: unknown
): PersistedUIMessage {
  if (!previous) return message;
  const lineTime = toStamp(legacyLineTime);
  const updatedAt = readMessageUpdatedAt(message);
  return readMessageUpdatedAt(previous) === undefined && lineTime !== undefined && updatedAt !== undefined
    ? { ...previous, ...message }
    : message;
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
      const fold = mergeFoldedMessage(prev, message, line.messageUpdatedAt);
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

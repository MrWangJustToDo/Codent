/**
 * Disk-session catalog → ACP `SessionInfo` mapping, plus cursor paging.
 *
 * `session/list` enumerates the workspace's PERSISTED sessions (not the live agents a host
 * happens to own), which is what a client's session picker needs. The disk id is the ACP
 * session id throughout (see `diskSessionId` in `agent.ts`), so an id taken from a list row can
 * be handed straight back to `session/load` / `session/resume` / `session/delete`.
 *
 * Cursor semantics: the cursor is a row's `(updatedAt, id)` and a page resumes STRICTLY AFTER
 * it. `updatedAt` alone is not enough: two sessions can share a millisecond (`Date.now()`
 * granularity, and a scripted client creates them back to back), and a strictly-older filter
 * would then DROP whichever of the pair fell on the far side of a page boundary — a silently
 * missing session, not the tolerated repeat of a concurrent-write cursor. `id` is therefore the
 * tie-breaker, giving a total order and an unambiguous boundary.
 *
 * The token stays opaque to the client (a JSON pair it has no reason to interpret).
 */

import type { SessionInfo } from "@agentclientprotocol/sdk";
import type { SessionMeta } from "@codent/core";

/** Rows per page when the client does not ask for more. */
export const DEFAULT_SESSION_PAGE_SIZE = 50;

/** A page boundary: the last row of the previous page. */
export interface SessionCursor {
  updatedAt: number;
  id: string;
}

/** The catalog's total order: newest first, ties broken by id so the order is deterministic. */
function compareSessions(a: SessionCursor, b: SessionCursor): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Encode a row's `(updatedAt, id)` as the opaque page cursor. */
export function encodeCursor(updatedAt: number, id: string): string {
  return JSON.stringify({ updatedAt, id });
}

/**
 * Decode a cursor into its boundary, or `undefined` for "first page".
 *
 * Anything malformed — not JSON, wrong field types, a leftover token from the older
 * `updatedAt`-only format — degrades to the first page rather than throwing: the client cannot
 * fix an opaque token it did not author, so erroring would deadlock its paging loop.
 */
export function decodeCursor(cursor: string | null | undefined): SessionCursor | undefined {
  if (cursor === null || cursor === undefined || cursor === "") return undefined;
  try {
    const parsed = JSON.parse(cursor) as { updatedAt?: unknown; id?: unknown } | null;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt)) return undefined;
    if (typeof parsed.id !== "string") return undefined;
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    return undefined;
  }
}

/** Map one persisted session to ACP's `SessionInfo` shape. */
export function toSessionInfo(meta: SessionMeta, rootPath: string): SessionInfo {
  return {
    sessionId: meta.id,
    cwd: rootPath,
    ...(meta.name ? { title: meta.name } : {}),
    updatedAt: new Date(meta.updatedAt).toISOString(),
  };
}

/**
 * Slice one page out of the catalog and map it.
 *
 * Returns the page plus the cursor for the next one (absent on the last page, which is how the
 * client learns to stop).
 */
export function paginateSessions(
  metas: SessionMeta[],
  rootPath: string,
  options: { cursor?: string | null; pageSize?: number } = {}
): { sessions: SessionInfo[]; nextCursor?: string } {
  const pageSize = options.pageSize ?? DEFAULT_SESSION_PAGE_SIZE;
  const boundary = decodeCursor(options.cursor);
  // `SessionStore.list()` already returns `updatedAt` desc, but a host is not bound to that and
  // the cursor's correctness depends on the ordering, so it is re-established here.
  const ordered = [...metas].sort(compareSessions);
  // Resume strictly after the boundary row, which also skips its same-`updatedAt` siblings
  // (they sort before it or after it by id — never on both sides of the cut).
  const remaining = boundary ? ordered.filter((meta) => compareSessions(meta, boundary) > 0) : ordered;
  const page = remaining.slice(0, pageSize);
  const last = page[page.length - 1];

  return {
    sessions: page.map((meta) => toSessionInfo(meta, rootPath)),
    // Only advertise a next page when something was actually left over.
    ...(last && remaining.length > page.length ? { nextCursor: encodeCursor(last.updatedAt, last.id) } : {}),
  };
}

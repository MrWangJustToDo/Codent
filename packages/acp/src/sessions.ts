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

import { RequestError } from "@agentclientprotocol/sdk";
import { defaultPath } from "@codent/core";

import type { DeleteSessionRequest, ListSessionsRequest, SessionInfo } from "@agentclientprotocol/sdk";
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
  // the cursor's correctness depends on the ordering, so it is re-established here. A row with a
  // malformed timestamp is skipped rather than allowed to throw `RangeError` and fail the whole
  // page: one corrupt session file must not hide every other session in the picker.
  const ordered = metas
    .filter((meta) => Number.isFinite(meta.updatedAt) && Number.isFinite(new Date(meta.updatedAt).getTime()))
    .sort(compareSessions);
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

/**
 * The catalog plane's request handlers — `session/list` and `session/delete`.
 *
 * They live here, next to the paging and mapping they answer with, and away from `agent.ts`'s handler
 * table (that file is at its line ceiling). Both are "sessions that are not the prompt loop": the
 * dependency they need from the running app is one callback (`closeLive`), which keeps the extraction
 * honest — a module that needs seven closures is a module that has not found its subject yet.
 */
export interface SessionCatalogDeps {
  /** `undefined` when the host cannot enumerate (then `session/list` is not advertised either). */
  listPersistedSessions?: () => Promise<SessionMeta[]>;
  /**
   * Enumerate a workspace root other than the process default.
   *
   * `cwd` is the session's workspace root in ACP, so a list request for another root is a real
   * filter, not a hint. A host that can build a runtime for that root supplies this; without it a
   * foreign `cwd` returns no rows rather than rows from the wrong workspace.
   */
  listPersistedSessionsAt?: (rootPath: string) => Promise<SessionMeta[]>;
  /** `undefined` when the host cannot delete. */
  deleteSession?: (sessionId: string) => Promise<boolean>;
  /**
   * The live bridge behind an id, when there is one.
   *
   * `session/delete` addresses DISK ids. A stable ACP handle may equal a *former* disk id after a
   * rebind; resolving it blindly would close the live conversation and delete the current file
   * instead of the listed one. Only an id that IS the live disk id may be closed.
   */
  lookupLive?: (sessionId: string) => { handle: string; diskId: string } | undefined;
  /** The workspace root used when the request omits `cwd`. */
  rootPath: string;
  /** Stop a live session before its log is removed — deleting under a running agent would leave an
   *  append stream writing to a removed file. Returns whether one was closed: a session that was live
   *  counts as deleted even when it has no file yet. */
  closeLive: (sessionId: string) => Promise<boolean>;
  /** Diagnostics sink (stderr in a host). */
  note: (text: string) => void;
}

export function createSessionCatalog(deps: SessionCatalogDeps) {
  return {
    async list(params: ListSessionsRequest): Promise<{ sessions: SessionInfo[]; nextCursor?: string }> {
      if (!deps.listPersistedSessions && !deps.listPersistedSessionsAt) {
        // Not advertised in initialize for such a host — but a client may call anyway.
        throw new Error("This host cannot enumerate persisted sessions (no listPersistedSessions capability)");
      }
      const requested = params.cwd
        ? defaultPath.isAbsolute(params.cwd)
          ? defaultPath.resolve(params.cwd)
          : (() => {
              throw RequestError.invalidParams(undefined, `session/list cwd must be absolute: ${params.cwd}`);
            })()
        : deps.rootPath;
      let listed: SessionMeta[];
      if (requested === deps.rootPath) {
        listed = (await deps.listPersistedSessions?.()) ?? [];
      } else if (deps.listPersistedSessionsAt) {
        listed = await deps.listPersistedSessionsAt(requested);
      } else {
        // A foreign root is a real filter, not a hint. Returning the default root's rows while
        // stamping them with the requested `cwd` would hand the client sessions from the wrong
        // workspace; empty is the honest answer for a host that cannot reach that root.
        deps.note(`[codent-acp] note: session/list cwd ${requested} is not reachable by this host\n`);
        listed = [];
      }
      const page = paginateSessions(listed, requested, { cursor: params.cursor });
      return {
        sessions: page.sessions,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },

    async remove(params: DeleteSessionRequest): Promise<Record<string, never>> {
      if (!deps.deleteSession) {
        throw new Error("This host cannot delete persisted sessions (no deleteSession capability)");
      }
      // `DeleteSessionRequest` carries only `sessionId`.
      const sessionId = params.sessionId;
      const live = deps.lookupLive?.(sessionId);
      if (live && live.diskId === sessionId) {
        // The requested id IS the live conversation: stop it before removing its log.
        await deps.closeLive(sessionId);
        await deps.deleteSession(sessionId);
        return {};
      }
      // A stable handle may equal a FORMER disk id (after `/clear`/`/clone`/`/resume`). It is not a
      // disk id now: delete that persisted conversation if it exists, but never close the live one.
      await deps.deleteSession(sessionId);
      return {};
    },
  };
}

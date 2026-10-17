/**
 * Resolve a persisted-session QUERY to a session — one rule for every host.
 *
 * `/resume` advertises `<session-id or name>`, but only the TUI resolved a name: the ACP slash command
 * passed the raw text through as a `sessionId`, so the documented usage failed there. The matching rule
 * (`id` → exact name → name contains, in list order) belongs to core because the command's contract
 * does; a host owns how it presents the result, not what the query accepts.
 */

/** The minimum a candidate needs to be addressable by a `/resume` query. */
export interface SessionRefCandidate {
  id: string;
  name?: string;
}

/**
 * Resolve `query` against `sessions`.
 *
 * @returns the first match, or `undefined` when nothing matches (the host reports its own not-found
 *   message, since the wording belongs to the surface).
 */
export function resolveSessionRef<T extends SessionRefCandidate>(sessions: readonly T[], query: string): T | undefined {
  const trimmed = query.trim();
  if (!trimmed) return undefined;

  return (
    sessions.find((session) => session.id === trimmed) ??
    sessions.find((session) => session.name === trimmed) ??
    sessions.find((session) => typeof session.name === "string" && session.name.includes(trimmed))
  );
}

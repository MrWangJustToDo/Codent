import { createState, markRaw } from "reactivity-store";

import type { AgentSession, AgentSessionHost } from "@codent/core";

/**
 * Active Session + Host for the UI. No ManagedAgent.
 *
 * One runtime holds exactly one live root session — multiple sessions are
 * separate runtimes, not extra entries in this store. `session` is that
 * session; `host` is its runtime host.
 *
 * Session/Host are live handles (`subscribe` / `dispatch`). Store them with
 * {@link markRaw} so selectors do not wrap them as readonly proxies.
 */
export const useAgent = createState(
  () => ({
    host: null as AgentSessionHost | null,
    session: null as AgentSession | null,
    /**
     * Lines for the exit summary, captured while the session is still live.
     *
     * The exit path destroys the session before `process.exit` lands, so the summary cannot be
     * read from the snapshot at paint time — `ctx.exit()` builds it first and stashes it here.
     * `null` when there is nothing worth printing (no model traffic, or no session at all), which
     * is also what keeps `ExitSummary` from rendering an empty frame.
     */
    exitSummaryLines: null as string[] | null,
  }),
  {
    withActions: (s) => ({
      setHost: (host: AgentSessionHost | null) => {
        s.host = host ? markRaw(host) : null;
      },
      /** Set the active root session (the only live session of this runtime). */
      setSession: (session: AgentSession | null) => {
        s.session = session ? markRaw(session) : null;
      },
      /**
       * Announce that the host is about to exit, carrying the summary lines to paint.
       * Idempotent: `/quit` and Ctrl+C both call it, and a user can hit Ctrl+C twice.
       */
      beginExit: (lines: string[] | null) => {
        s.exitSummaryLines = lines;
      },
    }),

    withDeepSelector: false,

    withStableSelector: true,
  }
);

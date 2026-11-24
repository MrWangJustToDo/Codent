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
    /**
     * Set by `ExitSummary` once those lines are in the committed tree.
     *
     * The summary is a frame row, and a store write is a React render away from the tree, so a host
     * that released the renderer on `exit()` alone unmounted the app before the block it was asked
     * to show existed — the exit looked like it had nothing to report. The component writes this
     * from an effect (which React runs after the commit) and the host waits for the frame after it;
     * see `bootstrapCliHost`'s exit path.
     */
    exitSummaryCommitted: false,
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
       * Idempotent: `/quit` and Ctrl+C both call it, and a user can hit Ctrl+C twice. The commit
       * flag is deliberately NOT reset here — it records that the frame already carried these lines,
       * and clearing it on a second chord would make the host wait for a paint that never comes and
       * print a second copy of a summary the user can already see.
       */
      beginExit: (lines: string[] | null) => {
        s.exitSummaryLines = lines;
      },
      /** Commit-time handshake for the host's exit path — written by `ExitSummary`. */
      markExitSummaryCommitted: () => {
        s.exitSummaryCommitted = true;
      },
    }),

    withDeepSelector: false,

    withStableSelector: true,
  }
);

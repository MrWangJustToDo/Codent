/**
 * `AGENT_LOG_LEVEL` — the one volume knob for the persisted timeline.
 *
 * It lives beside the seam rather than in the log extension because **both** binders need it: the
 * extension's `attachSink` and the seam's own `AgentLog.attachFileSink`, which is the documented
 * fallback for embedded hosts that have no agent manager. Reading it in only one of them made the
 * knob silently ineffective on the fallback (debug rows kept landing), so the parser is shared
 * instead of duplicated.
 *
 * `process` is reached through `globalThis`: browser hosts have no `process` at all, and this runs
 * from `createManagedAgent` — a `ReferenceError` here would fail the whole agent creation over
 * logging configuration.
 */

import type { LogLevel } from "./types.js";

const LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

let cachedLevel: LogLevel | undefined;
/** Last invalid raw value already warned about, so a typo does not warn per sink. */
let warnedInvalid: string | null = null;

/** Parse `AGENT_LOG_LEVEL`; `undefined` when unset or invalid (the seam default then applies). */
export function configuredLogLevel(): LogLevel | undefined {
  if (cachedLevel) return cachedLevel;
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const raw = proc?.env?.AGENT_LOG_LEVEL?.trim().toLowerCase();
  // Unset is not cached: a library host may load `.env` after the runtime was built, and the first
  // subagent's `attachSink` happens before that. Re-reading `process.env` per sink is cheap.
  if (!raw) return undefined;
  if (LEVELS.has(raw)) {
    cachedLevel = raw as LogLevel;
    return cachedLevel;
  }
  // A typo used to fall through to the seam default (the noisiest level) with no signal at all,
  // so a user trying to quieten a workspace got the opposite. Say it once per bad value.
  if (warnedInvalid !== raw) {
    console.warn(`[agent] ignoring AGENT_LOG_LEVEL="${raw}" (expected debug | info | warn | error; using the default)`);
    warnedInvalid = raw;
  }
  return undefined;
}
